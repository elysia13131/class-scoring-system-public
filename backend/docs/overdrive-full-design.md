# 超限模式（Overdrive）完整设计

> 阶段蓝图文档：目标、已落地、分阶段实施设计与验收。
> 关联代码实现见各 Phase 标注的文件。

## 0. 背景与目标

班级管家微信 AI（灵枢）基于 dsh（DeepSeek Harness）嵌入式底座运行。演进目标：

1. **搜索与网页能力升级**（已落地）：文本搜索从免费 Bing/DDG HTML 爬虫升级为 DeepSeek 官方联网（质量实测碾压），失败自动降级；新增读链接正文（fetch_url）、浏览器自动化（headless chromium）。
2. **超限模式**：为需要的会话开放 dsh **完整原生能力**（终端/文件读写/装依赖/浏览器/子任务…），普通会话只保留班级能力；开放需口令授权；不同超限会话**工作区隔离**并持久化在卷。
3. **文件与残留治理**：截图/生成文件"要么发要么不发、用后即清"，解决共享工作区"清不掉"的残留问题。
4. **防模型输出复读**：模型连续回复相似文本时自动打破。
5. **消息时序正确性**：AI 忙时用户消息进 FIFO 队列，下一轮迭代带回模型输入；不插队、不丢。

## 1. 开放矩阵（超限授权）

| 场景 | 授权方式 |
|---|---|
| 管理员私聊 | 直接说「超限」自动开放 |
| 管理员在群 | 群内 `@Anaxis 超限` 开放（管理员自动开） |
| 其他成员私聊 | `超限 + 管理员密码`（如 `超限 123456`） |
| 平台群聊 / 其他成员 | 群内 `@Anaxis 超限 + 管理员密码` |
| 关闭 | 任意形式 `关闭超限`（开启者或管理员） |
| 误伤防护 | 日常对话含"超限"字样（"这个超限了吧"）不触发；必须指令形态 |

口令校验由 steward 层执行（复用现有 `verifyAdminPwd`）；`utils/overdriveState.js` 只做纯解析与状态持久化。

## 2. 会话模型与消息时序（已确认）

- **会话 key**：私聊 = `memberId`；群 = 群 `chatroomId`（复合 `g:群id:学号` 归一到群 id）。
- **普通消息队列**：每成员 FIFO（`_pendingInjections`）。AI 上轮处理期间用户新消息**入队不插队**；上轮结束（drain）取积压消息作为下一轮输入 → **下一轮迭代天然把用户消息带回模型**，模型据此自主决定暂停/插话（不设硬性"停止指令"）。
- **媒体（图片/文件）**：等本轮结束（最多 60s，超时先告知）。
- 超限长任务要求：开始前 AI 告知"要点时间，有话先讲"；超限 runtime 单轮设长超时上限防霸占。

## 3. 已落地（代码现状）

### 3.1 搜索升级
- `backend/utils/dsSearch.js`：DeepSeek 官方联网（`api.deepseek.com/anthropic/v1/messages` + `web_search_20250305`）。`web_search` action：官方优先 → 失败降级 Bing/DDG；图片仍 Bing→DDG（官方无图）；返回 `answer/results/images/engine`。
- `class_web_search` 描述更新：含"images 不够 → fetch results 中页面挖图"引导。

### 3.2 读链接
- `backend/utils/fetchUrl.js`：复用 dsh 官方 `HttpFetchProvider`（SSRF 防护/同源/100k 体上限）+ turndown→markdown + 抽页面图片直链（og:image 优先、滤 svg/追踪像素、15k md cap）。`class_fetch_url`。

### 3.3 浏览器自动化（超限能力之一）
- `dsh-plugin-playwright` 注入（peer `*` 兼容；`dsh-plugin-browser-use` 因 peer 锁 rc 被排除）；`DshAgentEngine._ensureProfilePlugin`：`DSH_BROWSER=1` 才注入（deps+cordis.patch.yml insert+install），浏览器解析 `DSH_BROWSER_EXECUTABLE`→`DSH_BROWSER_CHANNEL`→playwright chromium，headless 默认 true。
- **修复**：profile npm install 加 `--legacy-peer-deps`（防 npm 按 peer `*` 自动装 rc 版 dsh-tools 与主运行时分裂 → `cannot create effect on inactive context`）。
- **guard 收口**：`browser_upload_file/browser_evaluate/browser_init_script/browser_storage_state` 一律拒绝（文件外泄/任意脚本/凭据风险）。
- live 验证：模型真实 navigate/截图/跨轮 reload 同页面（进程级浏览器单例）。截图落 `workspace/.dsh/playwright/*.png`。

### 3.4 发图/发文件到微信（新桥）
- `send_local_image`（`class_shot_send`）：浏览器截图 → 校验在截图目录 → `steward.sendToMemberImage` → 成功即删 + 目录 30min TTL 清理。
- `send_workspace_file`（`class_send_workspace_file`）：工作区（默认 `agent/dsh/workspace` 与未来超限 `data/overdrive/workspaces`）内任意文件 → `steward.sendToMemberFile` 发出。→ **AI 可以把工作区文件发到微信**（报告/脚本/产物）。
- 均做路径白名单（防穿越/读敏感文件）+ caller 校验 + 群路由。

### 3.5 超限状态（Phase 1 完成）
- `backend/utils/overdriveState.js`：`parseOverdriveCommand`（13 用例全 PASS：@超限/超限+密码/关闭/误伤防护）、`enable/disable/isEnabled/markActive/listEnabled/sweepIdle`、持久化 `data/overdrive-state.json`（卷内）、群 id 归一、空闲 30min 判定。

## 4. 分阶段实施设计

### Phase 2：超限 runtime 管理器（已落地 ✅）
- 决策：**单 runtime 无法按会话切 fs/pwsh 根**（sandbox workspaceRoot 启动级单值，guard 无路径参数）→ 采用 **R1：每超限会话独立 runtime**（用户已接受：超限并发少；浏览器会话也因此天然隔离）。
- 结构（代码现状：`agent/dsh/overdriveManager.js` + `overdriveWorker.js`）：
  - OverdriveManager 按 scopeKey 拉起**独立 worker 子进程**（非主进程内多实例）：
    - 隔离载体：worker 进程级 env 注入 `DSH_ENGINE_WORKSPACE/HOME_DIR` → `agent/dsh/DshAgentEngine.js`
      模块级常量按进程读取 → 独立工作区 / dsh home / 会话日志 / 浏览器；`DSH_ENGINE_FULL_NATIVE=1`（全量原生工具）、`DSH_BROWSER=1`。
    - 依赖共享：`npm_config_cache / PLAYWRIGHT_BROWSERS_PATH / PIP_CACHE_DIR / UV_CACHE_DIR` → `{dataDir}/overdrive/shared-cache/*`（只下载一份）。
    - NDJSON 帧协议：`ping/process/inject(user|event)/shutdown`；模型输出按行发 `text` 帧 → steward 逐句入微信出站队列（亚秒首条不丢）。
    - 单 scope 串行：忙时新消息经 worker 引擎 `injectUserMessage` → 引擎 drain 本轮结束后作为下一轮输入消化（与主引擎队列语义一致、不丢消息）；防并发竞态在 manager 层做 busy 闸。
    - `pushContext(scopeKey, text)`：切换摘要/防复读打破等"引擎事件"随下一条 process 帧注入（冷启动缓解通道）。
     - 回收（模式保持语义）：每 5 分钟扫描一次；**仍开启超限的会话** 30 分钟无新消息（用户消息或 AI 输出都会刷新闲置计时，manager 在收到用户消息与每个 AI 输出帧时 touch）→ 只停 worker 进程、状态保持开启、下一条消息自动再拉起；**已明确"关闭超限"的会话** 残留 worker 5 分钟快速回收。状态文件不再被闲置自动置为关闭。
  - 并发上限 `DSH_OVERDRIVE_MAX`（默认 3）；超限单轮 watchdog `DSH_OVERDRIVE_TURN_TIMEOUT_MS`（默认 10min）。
  - 全新 per-会话 home 首启会自动补全 `profiles/sdk/package.json`（引擎自举修复）并把初始化时限放宽到 5min（`DSH_INIT_TIMEOUT_MS`）。
- 验收：开 2 个不同成员超限 → 两个 worker、两个独立工作区目录；浏览器/终端互不可见；关闭+闲置回收释放。

### Phase 3：普通会话隐藏原生工具（restrict）【已落地 ✅】
- 普通（默认）runtime：profile 补丁按行 `disabled: true` 禁用 `dsh-base` 原生工具行（fs 系/str_replace_editor/pwsh/bash/skill/subagent*/job_*/workflow/tool-web/plan-mode 等名单见 `DshAgentEngine.NATIVE_TOOL_IDS`），仅保留 `class_*` 桥 —— 普通会话模型工具面不含终端/文件。
- 超限 runtime（`DSH_ENGINE_FULL_NATIVE=1`）：不写 disable 行 → 全量原生 + 浏览器（`DSH_BROWSER=1`） + bridge。
- 浏览器高危工具（`browser_upload_file/browser_evaluate/browser_init_script/browser_storage_state`）由 steward-bridge guard 无条件拒绝。
- 验收：普通会话模型自报工具面不再含 fs/pwsh；超限会话含。

### Phase 4：超限工作区 + 依赖统一路径（已落地 ✅）
- 工作区目录：`{dataDir}/overdrive/workspaces/{scopeKey}/`（卷内、重部署不丢）；worker cwd 即该目录 → fs/pwsh 沙箱根天然落在其中。
- home（会话日志/credentials）独立：`{dataDir}/overdrive/homes/{scopeKey}/`；DshAgentEngine 卷重定向守卫（home 已在卷内时跳过，避免挪进共享 dsh-home）。
- **依赖统一路径**：全部 runtime（普通+超限）共享 `{dataDir}/overdrive/shared-cache/{npm,ms-playwright,pip,uv}`。
- 收文件落盘：`ov_save_attachment`（超限环境注册，后端 `save_attachment` action）→ mediaId → `工作区/inbox/{原名}`；发回走 `send_workspace_file`（路径白名单 = 主共享工作区 ∪ 本超限会话工作区）。
- 截图：`send_local_image` 白名单扩展为"普通共享截图目录 ∪ 本超限会话 `.dsh/playwright`"，发出即删 + 30min TTL 残留清理（worker 回收时再兜底一轮）。
- 清理：超限关闭/回收保留工作区（可重开续用）；未启用会话的工作区不自动删除（预留 7 天策略）。
- 验收：两个超限会话各自目录、文件互不可见；npm/浏览器只下载一份。

### Phase 5：超限人设 + 收文件落盘 + TTL（已落地 ✅）
- `personas/AGENTS.overdrive.md`：超限 worker 人设尾部附加（原生能力清单 + 工作区边界 + 长任务先告知 + 协作规范）。
- 上下文模式隔离：普通/超限会话的记忆文件按模式分文件（`conversation_memory/{member}_dsh.json` vs `_dsh_overdrive.json`）——两种模式上下文互不串味。
- 切换交接：`utils/overdriveHandoff.js` 在模式切换时对源模式"上次切换以来新增"的轮次做一次 **AI 摘要**（游标增量去重，每次最多 HANDOFF_CAP=40 轮；总结失败不推进游标），注入目标模式会话（普通→超限走 manager pendingContext，超限→普通走主引擎 injectSystemEvent）。注入的摘要在目标会话下一条消息时进入其上下文，随 dsh 会话日志保留，不重复注入。
- 微信附件落盘工作区：见 Phase 4（`ov_save_attachment`）。
- 普通会话维持现有人设与 `class_read_file` 语义不变。
- 验收：超限中她发文件 → AI 可落盘到其工作区并用终端/fs 处理 → `class_send_workspace_file` 发回。

### Phase 6：模型输出防复读（已落地 ✅，范围仅输出侧）
- 目标：模型对同一会话连续输出相同文本（行级、规范化后完全一致）→ 打破复读，不刷屏。
- 实现（`utils/antirepeat.js` + steward 出站 AI 行收口）：
  - 记录 per 会话（私聊 memberId / 群 group-xxx）最近文本行；行规范化 = 去首尾空白/标点/语气词尾巴。
  - 同一文本第 2 次出现 → 丢弃（dup）；第 3 次 → 转向（tripped）：不再重复发出原句，改发固定话术「（我好像卡住重复了…）」，并向该会话注入打破事件（普通引擎 `injectSystemEvent` / 超限 worker `injectEvent`），使下一轮模型输入携带事件自主脱离。
  - 转向后 60s 冷却：期间相同文本只静默丢弃，不反复转向刷屏。
  - 仅作用于模型主动回复（`_runAgentTurn`/`_runOverdriveTurn` 的行流）；推送/模板/工具文案不去重。
- 验收：构造连续相同回复 → 第 3 条被拦截并转向；不误伤正常重复。

### Phase 7：steward 集成（已落地 ✅）
- 私聊文本入口 `parseOverdriveCommand`：**免密范围 = 管理员（系统/管理员上下文）+ 普通模式用户（guest-*）私聊**——直接「超限」开、「关闭超限」关；其他普通班级成员开启需管理员密码（`超限 管理员密码`），关闭时开启者可免密。
- 群聊入口（@Anaxis 超限 / @Anaxis 关闭超限）：
  - **普通模式群**（已脱离班级平台）：任意已绑定成员免密开/关（超限中仍沿用普通模式身份，只开放原生能力+陪伴工具，不碰班级数据）；
  - **平台群**：管理员免密开、其他成员带管理员密码；关闭权限=管理员或开启者。
- **模式上下文独立**：超限 runtime 用独立 dsh home/会话日志/记忆文件/工作区 —— 普通与超限互相不可见。
- **切换 AI 摘要冷启动缓解（游标增量）**：切换时对源模式"上次切换以来新增"的对话做 AI 摘要并注入目标会话；成功才推进游标，来回切换不重复注入（详见 Phase 5）。
- **消息带回**：超限 runtime 忙时用户消息经 worker 引擎注入 → drain 在下一轮自动带回模型（与普通队列语义一致）；群消息注入带发言者标注。
- 图片/文件：超限会话图片走 base64 透传（>1.5MB 提示落盘处理）；文件提示用 `class_read_file` / `ov_save_attachment`。
- 超限中的主动消息（每日一问/日程提醒/定时任务）路由进超限 runtime，模式内语义连续。
- 指令不出现在模型对话上下文（系统路由剥离）。
- 验收：管理员/guest 私聊 @超限 → 会话切入超限；普通成员无口令 → 拒绝并提示；关闭后切回普通；切换前后 AI 记得对方聊到哪。

## 5. 安全边界汇总

- 口令：复用现有管理员口令校验，不落日志明文。
- 路径：所有"读本地/发文件"桥 action 强制白名单根（截图目录/工作区/超限工作区），`path.resolve` 后前缀校验，杜绝穿越。
- 原生工具：普通会话 restrict 不可见；超限会话范围天然被独立 runtime 的 cwd/sandbox 根锁在其工作区。
- 浏览器高危工具（上传本地文件/任意脚本/凭据导出）guard 全局拒绝。
- 依赖共享缓存为只读共享的 cache（非工作区内容），不构成跨工作区读写通道。

## 6. 验收路径（端到端）

1. 普通私聊问"你能用终端吗" → 回答不能/不给工具；`超限 口令` → 切入超限，能 pwsh/建文件/浏览器。
2. 两个成员同时超限 → 各自工作区目录，A 建的文件 B 看不到。
3. 超限中她发新消息 → FIFO 排队，长任务结束下一轮自动接上，不丢不插队。
4. AI 截图 → `class_shot_send` 发出且文件即删；生成报告 → `class_send_workspace_file` 发出。
5. 模型连发 3 条相同回复 → 第 3 条被拦截转向，下一轮注入打破事件。
6. `关闭超限` → 恢复普通；闲置 30min → runtime 回收，状态保留可重开。

## 7. 风险与备注

- restrict 需在 agent scope 上验证（Phase 3 首个 spike）；若 scope 限制不可行，退路=普通 runtime 不注入原生扩展 bundle（改为仅 bridge+必要服务的最小 profile），超限 runtime 才用完整 base。
- 超限 runtime 并发内存：每实例约 300-500MB；上限 3 + 空闲回收，避免常驻。
- 消息带回依赖 drain 语义，超限长轮结束前新消息最长等待 = 该轮时长（Phase 5 人设约束 + Phase 2 单轮 watchdog 控制）。
