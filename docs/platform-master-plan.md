# 平台进化总蓝图 v1

> 统一规划：数据立体化 · 信用账本 · 微信共同管家 · 游戏激励引擎
> 游戏层细节见 [growth-base-game-design.md](./growth-base-game-design.md)（v0.2，激励引擎层）

---

## 1. 诊断：三个问题是同一个飞轮的三站

平台当前困境不是三个孤立问题，而是**一个断裂的飞轮**：

```
数据薄（只有锚点无过程） → AI 没料可分析 → 功能沦为情感陪聊
        ↑                                        ↓
   无人依赖平台 ← 功能无特色 ← 通用 AI 也能聊天
```

逐个修是治标。让飞轮任何一站先转起来，其余两站被拉着转。三个战略对应三站：

| 战略 | 飞轮站点 | 一句话 |
|---|---|---|
| **数据立体化** | 记录层 | AI 把随手发生的东西变成结构化记录（拍照/对话/系统事件） |
| **信用账本** | 验证层 | 每条数据带溯源凭证，AI 交叉核验，无公正账本则无护城河 |
| **微信共同管家** | 行动层 | AI 独立微信号 = 全班共用管家：聊天即办事，办事即记录 |
| **游戏激励引擎** | 反哺层 | 星辉山谷：数据变资源，资源换权益（游戏文档 v0.2） |

护城河总纲：微信拿不走的是——**真实班级组织 + 全员成长账本 + 公正结算 + 每周评价节奏**。管家越用，账本越厚；账本越厚，管家越能干。通用 AI 和微信都没有这四样。

---

## 2. 战略一：数据立体化（记录层）

**问题不是数据少，是只有锚点没有过程**。体测（月）、成绩（学期）、评分（周）全是"结论型"数据。立体感来自过程纹理。

三条采集通道（零新增负担）：

| 通道 | 学员侧 | 管理员侧 |
|---|---|---|
| **拍照录入** | 训练日志/证书/书面材料 | 通报照片、成绩单、值日表 → 杀死 Excel 工作流 |
| **对话录入** | "今天3000米12分50" → 自动成记录 | "下周值日排除伤病号" → AI 理解为约束 |
| **系统事件** | 日程完成时间戳、评价提交 | 导入 diff（新进步科目 → 自动事件，解决游戏 F5） |

由此每维度获得**双层结构**：过程层（日频、AI 采集、小额）+ 锚点层（官方、低频、大额凭证）。过程层给立体感，锚点层给可信度，AI 互证两层。

技术要点：端侧 ML Kit OCR 优先（离线、照片不出设备、符合涉密要求）；vision API 仅处理一般性照片。

---

## 3. 战略二：信用账本（验证层）

1. **溯源**：每条记录带 provenance —— 来源（photo_ocr / dialog_extract / system_event / admin_import）+ 时间 + AI 置信度 + 原始凭证引用。
2. **交叉验证**：AI 审计员常态化——自称"排名第一"但 rank_scores 无记录 → 标记；通报扣分与值日记录矛盾 → 标记。AI 审核没有人情分。
3. **共同利益**：星辉能买真实权益后，假数据 = 偷全班的钱——数据诚信从"平台要求"变成"集体利益"（与游戏层 F3 修正合流）。

---

## 4. 战略三：微信共同管家（行动层）★ 本轮核心

### 4.1 架构总览

```
微信用户（全员好友）
   │  私聊（文本/图片/文件）+ 好友申请自动通过
   ▼
管家号（独立微信个人号，iPad 协议登录，手机可同步在线）
   │  Wechaty + PuppetPadlocal
   ▼
DeepSeek Harness runtime（独立子进程）
   │  模型: deepseek-v4-flash-vision-exp（settings.yaml 可切）
   │  每成员独立 session（harness.session(memberId)）
   │  三闸插件：tools/pre-execute + tools.guard + post-execute
   ▼
受限 CLI / 现有 22 工具 / 新增管家工具
   │  （后端强制权限校验，不可绕过）
   ▼
/backend/data（含 game_ledger 审计）
```

**单号 vs 现有多号**：现有每成员一 Bot（iLink/ClawBot 虚拟身份）做不了"跨用户协调"，且绑定体验差。独立个人号 = 管家人格 + 协调中枢。App 推送（push 通道）保留为通知兜底。

### 4.1.0 消息通道选型（调研结论：iPad 协议双实现，PadLocal 托管 / GeweChat 自部署）

需求：**一个真实的独立微信号**，所有人正常加好友聊天，程序是它的"脑子"。2026 年通道格局（已联网核实 + iLink 协议文档逆向确认）：

| 通道 | 本质 | 加好友体验 | 图片收发 | 合规 | 成本 | 判定 |
|---|---|---|---|---|---|---|
| **Wechaty + PadLocal（iPad 协议托管）** | 号本体登录协议服务 | **正常微信好友**，`friendship` 事件自动通过申请 | 全支持 | 协议灰区，托管 token 成熟稳定 | ~$50/月（≈350 元/月） | ✅ 首选（省运维） |
| **GeweChat（iPad 协议自部署）** | Docker 自部署协议网关，REST API | **正常微信好友**，回调 `FriendMsg` 自动通过 | 全支持（含好友回调） | 协议灰区，需自运维 | 0 元 + 一台 VPS | ✅ 首选（零成本，班级低频场景够用） |
| ClawBot/iLink（现有 @agentlink/wechat） | 腾讯 OpenClaw Bot 通道（`ilinkai.weixin.qq.com`） | **协议本质 = 每用户扫码绑定自己的会话**，Bot 非微信好友、不可搜索添加——"每人一 bot"不是实现缺陷，是 iLink 的架构模型（已读协议文档确认：扫码返回 `ilink_user_id` 即扫码者本人） | 支持 | 官方合法 | 免费 | 降级备选通道（per-member 模式保留） |
| 企微智能机器人（长连接 API） | 企微应用机器人 | 需成员"关注企业"，微信内有专门入口 | 受 API 限制 | 官方合规 | 需企业注册 | 学校保密场景认证受限，观察 |
| Web 协议 / Hook / 托管平台 | — | — | — | Web 已死（免费 puppet 全失效）；微信 4.0 Qt Quick 重构导致 wxauto 等 UI 自动化全面失效；Hook 封号率 >80% | — | ✗ 排除 |

**两条 iPad 协议路线的取舍**：

| 维度 | PadLocal（托管） | GeweChat（自部署） |
|---|---|---|
| 成本 | ~350 元/月 | VPS ~30-60 元/月（可与现有后端同机） |
| 运维 | 零（token 服务商维护协议适配） | 自维护（镜像升级、掉线重连） |
| 风控 | 服务商专注协议稳定性，相对最好 | **要求 VPS IP 与微信号归属地同省**；消息 ≤5 条/分钟 |
| 代码 | Wechaty 生态（Contact/Message/FileBox 完整抽象） | 原生 REST（需自己薄封装一层） |
| 契合度 | 追求稳定省心 | 班级场景消息量极低（<200 条/日），风控余量大 |

**决策**：v1 用 **GeweChat 自部署**验证全链路（零成本、API 直接、班级低频场景风险可控）；若后续掉线/封控频发，平移到 **PadLocal 托管**（通道抽象层下切换，见 §4.1.2b）。两者都是"号本体登录"，登录态、好友关系、聊天体验完全一致。

**选 iPad 协议的决定性理由**（相对 iLink）：
1. **体验完全原生**——管家号就是一个普通微信号，成员搜索/扫码即加，聊天界面零差异；
2. **`friendship` / 好友回调原生支持自动通过好友申请**——"所有人都可以加"无需任何额外机制；
3. **iPad 协议可与手机同时在线**——管家小号同时登录在管理员手机上：运维可见（随时人工接管）、协议行为更接近真人多端用户（风控友好）；
4. **主动发消息无前置条件**——iLink 必须等对方先说话拿到 `context_token` 才能回（现有 `sendToMember` 因此有 "Bot还未收到消息" 的报错）；加好友即可发，公差通知这类主动触达不再受限。

### 4.1.1 微信 AI 管家账号：创建与登录（实操步骤）

**第一步：注册小号（AI 账号的载体）**

| 途径 | 操作 | 要点 |
|---|---|---|
| **A. 官方辅助账号（推荐）** | 主号（注册满 1 年 + 实名 + 绑卡 + 近 1 年无违规）→ 我 → 设置 → 切换账号 → 添加账号 → 注册新账号 → 「通过当前微信手机号辅助注册」 | 官方功能、注册合规；小号不占手机号、仅微信号+密码登录；新号 1-2 周有加好友/朋友圈频次轻限，之后自动解除 |
| B. 新实体手机号注册 | 用实名实体号（非虚拟段）正常注册 | 一号一微信；成本高 |
| ✗ 禁止 | 虚拟号（170/171 接码） | 封号率极高 |

注册后规范：**3 天内不改资料**；之后设置管家人设（昵称「小智」/ 头像 / 好记微信号）；**1-2 周养号**：正常加几个好友聊天、发 1-2 条生活朋友圈、用基础功能——模拟真人行为模式过风控评分。

**防封硬指标**（联网核实的 2026 风控阈值，写入出站节流器）：

| 指标 | 阈值 | 实现 |
|---|---|---|
| 消息间隔 | ≥5 秒（更严建议 3 条/分钟） | 出站队列 per-contact 随机延迟 5-15s |
| 日发送总量 | ≤200 条 | 全局计数器，超限静默排队到次日 |
| 固定间隔检测 | 机械式等间隔会被识别 | 延迟加随机抖动；夜间（23-7 点）活跃度系数 ×2 延迟 |
| 服务器 IP | **与微信号归属地同省**（GeweChat 硬要求） | 选号时注册地 = 服务器所在地，或反之选 VPS 区域 |
| 行为多样性 | 纯文本收发特征单一 | 穿插点赞/表情回复类 API（GeweChat 支持），每周几条朋友圈 |

班级场景天然风控友好：几十好友、1:1 私聊、无群发、真实社交关系——远低于营销号阈值。

**第二步：服务器扫码登录**

v1（GeweChat 自部署）——Docker 起 API 网关，后端薄封装：

```powershell
# 与后端同机部署（IP 同省是硬约束）
docker pull registry.cn-hangzhou.aliyuncs.com/gewe/gewe:latest
docker run -itd -v gewe-data:/root/temp -p 2531:2531 -p 2532:2532 --privileged=true --name gewe registry.cn-hangzhou.aliyuncs.com/gewe/gewe:latest /usr/sbin/init
# 实际部署命令与后端环境变量见下方「微信托管落地 runbook」（2026-09-01 已核对真实 API）
```

```js
// backend/wechat/geweChannel.js —— GeweChat REST 通道（真实 API 已核对源码，2026-09-01 重写）
// 所有接口 POST {GEWE_API}/v2/api/... + X-GEWE-TOKEN 头（/tools/getTokenId 获取）
// 登录：/login/getLoginQrCode {appId} → 管理员手机小号扫码（qrUrl=http://weixin.qq.com/x/{uuid}）
//      → /login/checkLogin 轮询（data.status=2 成功）→ appId 持久化复用
// 免验证重登：后续启动 POST /v2/api/login/checkOnline {appId}，登录态存 data/wechat/gewe-session.json
```

v2（PadLocal 托管平移路径）：

```js
import { WechatyBuilder } from 'wechaty'
import { PuppetPadlocal } from 'wechaty-puppet-padlocal'

const steward = WechatyBuilder.build({
  puppet: new PuppetPadlocal({ token: process.env.PADLOCAL_TOKEN }),
})
steward.on('scan', qrcode => /* 终端渲染二维码 */)
steward.on('login', user => console.log(`管家 ${user.name()} 已登录`))
// 用管家小号的手机微信扫码 → 登录态持久化（puppet 自动）
// iPad 协议：同一小号保持管理员手机端在线（多端共存）
```

**第三步：全员加好友（自动通过）+ 首次绑定**

```js
steward.on('friendship', async f => {
  if (f.type() === Friendship.Type.Confirm) return
  await f.accept()                    // 自动通过所有好友申请
  await f.contact().say('你好，我是班级管家小智。回复「绑定 学号 密码」开始使用')
})
```

GeweChat 侧等价物（2026-09-01 核对真实 API 后修正）：注册回调 `POST /v2/api/tools/setCallback {token, callbackUrl}`（全局、公网可达，GeweChat 先发 testMsg 验证）；好友申请是 **AddMsg + MsgType 37**（Content 为 XML，含申请人 wxid/v3/v4/scene），`POST /v2/api/contacts/addContacts {option:3}` 通过并回发欢迎语——语义与 Wechaty friendship 一一对应。

成员首次发消息 → 查 `wechat_bindings.json`（wxid → memberId）→ 未绑定则提示绑定话术 → 校验 members.json 密码后绑定。

### 4.1.2 单号管家模式：消息路由核心

```js
steward.on('message', async msg => {
  if (msg.self() || msg.room()) return        // 忽略自发/群聊（v1 仅私聊）
  const contact = msg.talker()                // 发送者（好友）
  const memberId = bindings[contact.id]
  if (!memberId) return msg.say(BINDING_HINT)

  // 图片/文件 → 落盘 → vision 多模态录入
  if (msg.type() === Message.Type.Image || msg.type() === Message.Type.Attachment) {
    const fileBox = await msg.toFileBox()
    const path = await saveToUploads(fileBox)   // dataDir/uploads/
    return handleVisionInput(memberId, path, steward, contact)
  }

  // 文本 → 路由到该成员的 agent session（现有 isProcessing 注入逻辑保留）
  return handleAgentMessage(memberId, msg.text(), {
    reply: text => contact.say(text),          // 流式分段发送
    isAdmin: isAdminMember(memberId),
  })
})
```

GeweChat 侧等价物：消息同样走回调推送（`Data.MsgType` 区分文本 1/图片 3/语音 34/文件 49，自消息判断 `FromUserName.string === Wxid`），`POST /v2/api/message/postText` 回复、`postImage {imgUrl}` 发图（imgUrl 须公网可下载）——路由逻辑零改动，只是把 `msg.say` 换成 REST 调用。

**主动通知（跨用户事务）**：

```js
async function notifyMember(memberId, text) {
  const wxid = reverseBindings[memberId]
  const contact = await steward.Contact.find({ id: wxid })
  await contact.say(text)                      // 无 contextToken 前置要求
}
```

与 iLink 不同，Wechaty 主动发消息不依赖"对方先说过话"——加好友即可发。App push 仍作为未加好友成员的兜底通道。

**并发与节流**：Wechaty 消息事件天然异步；上层每成员独立 session（dsh）可并行，单成员 `isProcessing` 队列逻辑复用现有实现；全局出站节流（分钟级上限）防风控。

### 4.1.2b 通道抽象层与现有代码迁移映射

两条 iPad 路线共用一个通道接口，避免路线切换牵动业务层：

```js
// backend/wechat/steward.js —— StewardManager（单号管家，新实现）
class StewardManager {
  constructor({ engine, channel }) { /* channel: GeweChannel | WechatyChannel */ }
  async start() { await this.channel.start() }            // 扫码/免验证重登
  onMessage(handler) { /* channel 回调 → { wxid, type, text, mediaPath } */ }
  async sendToMember(memberId, text) { ... }              // 反查绑定表 → channel.sendText
  async sendToMemberImage(memberId, imagePath) { ... }    // channel.sendImage
  getStatus() { ... }                                     // 同现有签名
}
// GeweChannel / WechatyChannel 实现同一组方法：start/sendText/sendImage/acceptFriend/on*
```

**迁移映射**（现有 [backend/wechat/index.js](file:///e:/新建文件夹 (3)/backend/wechat/index.js) 的 `WeChatBotManager` 保留为 iLink 降级通道，不删除）：

| 现有资产 | 迁移动作 | 说明 |
|---|---|---|
| `WeChatBotManager._onMessage` 的 engine 集成（isProcessing / injectUserMessage / processMessageStreamWithCallback / typing / 图表 sendImage） | **整体搬入 StewardManager** | 这套"流式分段 + 图表转图"逻辑与通道无关，原样复用 |
| `wechat_bindings.json`（wxid → memberId） | 直接复用 | 现有文件已在备份/恢复清单（index.js 的 backup 逻辑含 wechat 目录） |
| `dailyReport.generateReport(..., wechatBot, ...)` 5 处调用 | **签名不变** | StewardManager 实现同名 `sendToMember/sendToMemberImage`，调用点零改动 |
| `/api/wechat/*` 路由（status/create-bot/stop-bot/send） | 新增 `/api/wechat/steward/*`；旧路由保留 | create-bot 语义变为"管理员触管家扫码"，返回二维码给前端渲染 |
| 管理员每日一问直答（`hasAnsweredToday` 分支） | 搬入并按"管理员绑定身份"判断 | 现在按 isAdmin bot 实例判断，改为按绑定表 memberId 权限判断 |
| 备份/恢复（wechat 目录打包 + `reloadFromBackup`） | StewardManager 加 `reloadFromBackup` 同签名 | gewe-session.json 与绑定表一起进持久卷 |

### 4.1.3 dsh 集成：SDK 子进程架构（源码已 clone 至 research/deepseek-harness，调查确认）

**源码调查结论**（已下载仓库逐包核实）：

- **`@deepseek-ai/dsh-sdk-client` 的 `DeepSeekHarness` 类**（packages/sdk/client/src/api.ts）：构造即解析 `provider/model/reasoningEffort/maxTokens/cwd`；`start()` 懒启动 runtime 子进程并做 initialize 握手；一个实例跨多 session 复用同一子进程；`AsyncDisposable`（`await using` 或显式 `close()`）。文档中的集成形态与源码语义一致。
- **webhook 子系统不适用于微信通道**：webhook runtime 是 fire-and-forget——分发规则后立即返回、不保留交付/完成状态、不支持"回复到来源"语义。微信是双向会话（回复必须路由回发起人），因此走 **SDK 嵌入**而非 webhook 挂载。
- **工具契约**：`defineTool`（name/description/parameters/output.schema/output.render/execute(args, exec)），`exec.signal` 支持协作取消——与下文插件示例一致；自定义工具经 dsh 插件（`inject: ['tools']`）注入。
- **agents/skills 目录约定**：仓库自带 `.agents/`、skills 机制——管家行为规范可以直接用 skill 文件沉淀，随 dsh 版本升级零成本。
- **风险确认**：开发者预览、破坏性变更预期——SDK 侧锁死版本（`"@deepseek-ai/dsh-sdk-client": "0.x.y"` 精确版本），子进程隔离使升级影响面可控。

**集成形态**：现有后端是 CJS，dsh 是 ESM/TS monorepo 且处于开发者预览（API 有破坏性变更）——**不做进程内嵌入，用官方 `@deepseek-ai/dsh-sdk-client` 子进程隔离**（`DeepSeekHarness` 类拥有一个 runtime 子进程，跨多 session；JSON-RPC 通信；CJS 侧用 `await import()` 动态加载）：

```js
const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client/api');
const harness = new DeepSeekHarness({
  provider: 'deepseek-official',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-vision-exp',
});
await harness.start();          // 懒启动 runtime 子进程
const sessions = new Map();     // memberId → HarnessSession
const getSession = (mid) => sessions.get(mid) ?? harness.session(`member-${mid}`);
// 微信消息到达：await getSession(memberId).run(text) —— agent 空闲时 settle
```

**模型配置**（`$DSH_HOME/settings.yaml`，vision 支持就是一行 `input`）：

```yaml
llm-pi-ai:
  providers:
    deepseek-official:
      apiKeyEnv: DEEPSEEK_API_KEY
      api: openai-completions
      baseURL: https://api.deepseek.com/v1
      models:
        - id: deepseek-v4-flash-vision-exp
          input: [text, image]     # 声明多模态（声明而非探测，网关不服务时由 provider 拒绝）
        - id: deepseek-chat         # 回退路由：改 DEEPSEEK_MODEL 即切换
```

dsh 默认 provider 就是 `deepseek-official`、默认模型 `deepseek-v4-flash`——DeepSeek 官方适配是内置一等公民，`DEEPSEEK_API_KEY` 环境变量直接生效。

**自定义管家工具**（dsh 插件形态，跑在 runtime 进程内）：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
export const name = 'steward-tools'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'duty_roster_generate',
    description: '读取值日历史与伤病名单，生成下周公差/值日排班建议',
    parameters: {
      week: { type: 'number', required: true, description: '目标周次' },
      count: { type: 'number', required: true, description: '出人数量' },
    },
    output: {
      schema: { type: 'object' },   // { roster: [...], reasons: [...] }
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {     // exec.signal 协作取消；HTTP 调回主后端受限 API
      return fetchBackend('/internal/duty/roster', { ... })
    },
  }))
}
```

现有 22 工具（BaseTool 系）以同形态逐个包装为 dsh 插件（参数 schema 从 `this.parameters` 机械转换），或通过一个通用 `platform_api` 工具转发（先快后全：v1 用通用转发，v2 逐个原生化）。

**三闸的 dsh 落点**（与 §4.4 对应，钩子已验证存在）：

```ts
export const name = 'steward-policy'
export const inject = ['tools']
export function apply(ctx) {
  // 闸②：前置策略 waterfall —— allow / deny / ask
  ctx.on('tools/pre-execute', async (exec, next) => {
    const mid = agentToMember(exec.agent)               // session 名即 member-N
    if (isSensitiveWrite(exec.name, exec.arguments) && !adminWindowOpen(mid)) {
      return { kind: 'deny', reason: 'NEED_PASSWORD' }  // 微信无审批 UI，deny+反馈即"补要密码"
    }
    return next()
  })
  // 闸②b：单调 guard —— pre-execute 全放行也拦得住（防注入绕过）
  ctx.tools.guard(exec =>
    violatesMatrix(agentToMember(exec.agent), exec.name, exec.arguments) ? '权限不足' : undefined)
}
```

`deny(NEED_PASSWORD)` 的错误文本回到模型上下文 → 模型按系统提示向用户索要密码 → 密码经验证后写 5 分钟窗口（主后端内存 + 传给 dsh 的 session 上下文）→ 重试放行。闸③（后端强制校验）不变：工具 execute 内部调主后端 API 时校验 `adminVerified` 窗口凭证——**即使 dsh 层被完全绕过，数据写入口仍守得住**。

**dsh 适配工作量评估（诚实版）**：

| 项 | 成本 | 说明 |
|---|---|---|
| 模型接入 | 低 | settings.yaml + 环境变量，v4-flash 是内置默认，vision 一行声明 |
| 每用户 session | 低 | `harness.session(id)` 原生支持，Map 维护即可 |
| 三闸 | 低 | pre-execute/guard/post-execute 钩子全部现成 |
| 自定义工具 | 中 | defineTool 契约清晰；22 工具可先通用转发后逐个原生化 |
| CJS/ESM 桥 | 中 | dynamic import + 子进程隔离可解；需 lock dsh 版本（预览期破坏性变更） |
| ask→密码流改造 | 中 | 微信无按钮审批，deny+补问模式需定制交互提示词 |
| 流式回复 | 中 | SDK 的 notification 观察者 → 微信分段发送（现有 sendRound 逻辑复用） |

**降级路径**：若 dsh 预览期 API 漂移造成维护负担，三闸设计已同构移植回自研 Engine（`processMessageStreamWithCallback` 前置校验层）——设计文档先行验证，底座可替换。

### 4.1.5 代码落地记录（已完成 ✅）

**已实现文件**（全部通过语法检查 + 本地服务器集成测试）：

| 文件 | 职责 | 验证结果 |
|---|---|---|
| [backend/wechat/geweChannel.js](file:///e:/新建文件夹 (3)/backend/wechat/geweChannel.js) | GeweChat REST 通道（iPad 协议，2026-09-01 对齐真实 API 重写）：token 管理/扫码登录/appId 持久化复用/免验证重登/回调收消息（AddMsg+MsgType37 好友申请 XML 解析、去重）/发文本图片（媒体端点）/通过好友 | mock 全链路 19/19（`test-gewe-channel.js`）✓ |
| [backend/wechat/steward.js](file:///e:/新建文件夹 (3)/backend/wechat/steward.js) | 单号管家核心：wxid↔memberId 绑定表、消息路由、出站节流（≥5s+抖动+日限200）、兼容 WeChatBotManager 接口 | status/bindings 路由 200 ✓ |
| [backend/agent/dsh/DshAgentEngine.js](file:///e:/新建文件夹 (3)/backend/agent/dsh/DshAgentEngine.js) | dsh 底座引擎：SDK 子进程、bootId 会话管理、profile 插件注入、流式事件解析、降级链路 | 全链路 live 测试 ✓（真实模型对话） |
| [backend/agent/dsh/plugins/steward-bridge/](file:///e:/新建文件夹 (3)/backend/agent/dsh/plugins/steward-bridge/index.mjs) | dsh 工具桥插件（out-of-tree 包）：25 工具 HTTP 回环（14 查询 + 6 写入/通信 + 3 管理员审批 + 1 日程删除 + 1 CLI 兜底网关）+ DSL→JSON Schema 转换 | 模型真实调用 + 回环数据 ✓ |
| [backend/index.js](file:///e:/新建文件夹 (3)/backend/index.js) | 集成：STEWARD_ENABLED/DSH_ENGINE 环境开关、`/api/wechat/steward/*` 路由、`/api/internal/agent-tool` 工具桥端点（三闸闸3） | 7 项端点测试全过 ✓ |

**dsh 全链路联调结论**（2026-08-30，本地实测）：
- **版本**：`@deepseek-ai/dsh@0.1.2-alpha.2` + `dsh-sdk-client@0.1.2-alpha.2`（npm 0.0.1-rc.1 依赖树不完整——`dsh-agent-tool-mode` 等内部包从未发布，404；0.1.2-alpha.2 依赖树完整可装）
- **模型对话**：deepseek-v4-flash 真实调用 ✓（`node backend/scripts/test-dsh-live.js`）
- **工具桥**：模型调用 `class_query_members` → HTTP 回环 → 129 人名册返回 ✓（`node backend/scripts/test-dsh-tools.js`）
- **多轮上下文**：同 session 跨轮次记忆（记住 129）✓
- **密码闸（闸1）**：查他人评分时模型主动索要管理员密码 ✓
- **vision 多模态**：deepseek-v4-flash-vision-exp 图片输入实测通过 ✓（`node backend/scripts/test-dsh-vision.js` + `test-dsh-vision-engine.js`）
- **集成**：`STEWARD_ENABLED=1 DSH_ENGINE=1` 启动 → dsh 底座挂管家 → status API 正常 ✓
- **CLI 兜底网关**：`cli_gateway` 路径分级权限矩阵（30 项）+ 模型真实调用 write→read 一字不差 ✓（`node backend/scripts/test-dsh-cli-gateway.js --model`，2026-08-31）
- **dsh 能力用量**（2026-08-31 核实）：SDK profile = `dsh-base` + `dsh-sdk-app` **全量 bundle**，非仅引擎——系统提示层（system-prompt persona + agent-instructions + 各工具 prompt sections）、上下文压缩全套（compaction-basic 自动压缩 / tool-result-pruner 8K 阈值截断 / spill 50KB 落盘 / token-meter）、append-only 会话日志、请求前 checkpoint 全部原生生效。dsh 缓存设计（bundle 注释原文）：工具目录跨模式恒定 "for request-cache stability"、fork 不换模型保 "KV Cache reuse"。**前缀缓存实测**（`node backend/scripts/test-dsh-cache-hit.js`，DeepSeek API usage.prompt_cache_hit_tokens 直测）：固定 system + append-only 追加形状第 2/3 轮命中率 76.2%/69.6%；每轮重复拼提示的反例 52.2%/38.9%（且 miss token 绝对值随轮次增长）。
- **compaction-basic 压缩规则**（2026-08-31 源码核实，`dsh-compaction-basic/lib/index.js`）：**只压最早的消息、不整体压缩**。① 触发：`agent/pre-step` 每步检查，总 token ≥ 窗口 × thresholdRatio（默认 0.8）时启动；② 选区：从最新消息向回累计 token 至 retainTokens（= 窗口 × retainRatio，默认 0.16）为止，该点**之前**的头部消息全部进入压缩区（尾部 16% 原文保留 verbatim）；③ 边界：绝不拆开 tool-call/result 配对（`toolPairingBalancedBefore`）；④ 替换：压缩区经一次 LLM 调用生成 `<compacted-summary>` 包裹的结构化 checkpoint（Primary Request / Key Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context 八段式），作为单条 user 消息以 `surfaceOp: replace` 原位替换整段；⑤ 收敛保证：摘要 token 必须 < 被遮蔽 token 否则报错，压后仍超阈值重试（compactionRetries=1）；⑥ 兜底：API 直接报 context window exceeded 时无视 80% 阈值强制压缩（retainTokens=0）；⑦ 复压：已有 checkpoint 时新摘要合并旧摘要而非逐字复制；⑧ KV cache 优化：摘要调用复用对话自身 system+tools+消息前缀、压缩指令作为末条 user 消息追加——辅助调用是真前缀，缓存不失效。system prompt 与 tools schema 永不进压缩区（前缀恒定）。
- **prompt 注入策略**（2026-08-31 重构，对齐官方机制）：静态人设/权限规则 → [workspace/AGENTS.md](file:///e:/新建文件夹 (3)/backend/agent/dsh/workspace/AGENTS.md)（dsh 原生 agent-instructions baseline 通道：每新 session 首请求前注入 durable context，文件热更新自动重注入；删除散落遗留 `.agents/steward-bridge.mjs`）；动态成员身份 → 首条用户消息（SDK 协议仅 `session/prompt` 发 user contentBlocks，无 per-session system prompt API，per-member 身份只能走消息通道）；后续轮次纯消息本体（append-only 前缀稳定，人设不膨胀历史）。回归验证：多轮上下文 ✓ 密码闸 ✓（规则只在 AGENTS.md 时模型仍主动索要管理员密码 → 原生加载生效）。`initializeTimeoutMs` 提至 60s（依赖重装后冷启动可超默认 10s）。

**vision 实测详情**（差分验证法，图片真实到达模型而非文本幻觉）：
- **原始 SDK 层**：两张主题迥异图分别描述——星辉资源图→"切割面五角星、金黄渐变、发光宝石"；训练场图→"哑铃架、沙袋、塑胶跑道"——描述与主题精确吻合且相互可区分 ✓
- **引擎真实路径**（DshAgentEngine + 管家人设）：study_tower 图→"圆顶图书馆塔楼、猫头鹰、飞书" ✓；vision 模型下工具桥回环正常（查到 12 名成员含 612）✓；多模态上下文跨轮保持（凭记忆答出图片主色调粉紫渐变）✓
- **API**：`processMessageStreamWithCallback(memberId, message, sessionId, { images: [{ data: Buffer, mimeType: 'image/jpeg' }] }, callbacks)`——引擎自动组装 image content blocks（SDK 侧转内容寻址附件引用）；启用需 `DSH_MODEL=deepseek-v4-flash-vision-exp`（vision 变体文本图片通吃）
- **安全行为**（顺带发现）：工具回环 401 时模型如实告知权限不足，不编造数据 ✓

**cli_gateway 兜底网关**（2026-08-31，本地实测；回答"固定工具 vs 全套 CLI"的选型）：

设计结论——**固定工具为主 + CLI 兜底**：纯全套 CLI 每步 list→read→write 都是一次模型往返且无业务校验（效率低）；纯固定工具覆盖不了长尾（灵活性差）。组合方案：固定工具一次往返直达业务 API（高频零损耗），`cli_gateway` 一个工具带 4 个子命令（list/read/write/delete）接长尾场景，权限隔离五层：

| 层 | 机制 |
|---|---|
| 路径白名单 | `safeDataPath` 仅 `data/`，`../` 穿越 → 400 |
| 路径分级 + 权限矩阵 | 见下表；`.bak` 后缀剥离后按原文件分级（`config.json.bak` 同样禁读，防绕过） |
| 防损坏闸 | JSON 文件内容必须合法 JSON；`mode=merge` 深合并复用 `mergeJSON`；写/删前自动 `.bak` 备份 |
| 防上下文爆炸 | JSON >512KB 自动截断（数组返回 count+前 20 条）；文本 256KB 截断；二进制拒绝（图片走 vision 通道） |
| 审计 | 全部操作（含被拒）追加 `data/agent_cli_audit.jsonl`（1000 行裁剪至 500；agent 自身禁读写） |

权限矩阵（0=免密 / 1=管理员密码 / 9=永久拒绝）：

| 级别 | 路径示例 | list | read | write | delete |
|---|---|---|---|---|---|
| own 本人 | `checkin_records/612.json`、`temp/` | 0 | 0 | 0 | 0 |
| public 班级公开 | `members.json`、`notices.json`、`duties.json`、`injury_status.json` | 0 | 0 | 1 | 1 |
| shared 共享敏感 | `scores/`、`experiences.json`、`checkin_records/601.json`（他人） | 0 | 1 | 1 | 1 |
| code 代码文件 | `scheduleStore.js` 等 data 内 `*.js` | 0 | 1 | 9 | 9 |
| writeOnly | `config.json`（密码散列） | 0 | 9 | 1 | 9 |
| blocked 系统 | `wechat/`、`apk/`、`notification_inbox.json`、`devices.json`、审计日志 | 9 | 9 | 9 | 9 |

- 个人目录（checkin_records/conversation_memory/agent_memories/agent_profiles）按"文件名以学号开头"判归属：本人免密、他人按 shared 需密码
- 模型真实调用实测：`write "hello from model"` → `read` 一字不差 ✓；30 项权限矩阵全过（含身份闸、.bak 绕过、路径穿越、非法 JSON、审计含拒绝记录）✓
- 测试：`CLI_API_KEY=dsh-test-internal-key-2026 node index.js` 后运行 `node backend/scripts/test-dsh-cli-gateway.js [--model]`

**成员互发消息 + 管理员审批流 + 全数据域工具补齐**（2026-08-31，本地实测 25/25 全过）：

数据域工具补齐——新增 `class_query_rank`（学业排名）/`class_query_duties`（值日）/`class_query_notices`（公告）/`class_query_makeup`（补测）/`class_query_checkin`（打卡）/`class_query_pending_approvals`（待批请求），至此 24 个桥接工具覆盖全部数据域（14 查询 + 5 写入/通信 + 3 审批 + 1 日程删除 + 1 CLI 兜底）。

| 功能 | 机制 |
|---|---|
| **成员互发消息（全量开放）** | `class_send_message`：A 让管家转告 B，消息自动带署名「【A 的名字（学号）托我转达】」防伪造；无需密码、不能给自己发、目标必须存在。区别于 `class_notify_member`（管理员密码，系统通知口吻） |
| **管理员身份直通** | `ADMIN_MEMBER_IDS` 环境变量（默认 `612` = 周祎宸）：`verifyAdmin(password, callerId)` = 密码 ∨ 管理员身份，命中即免密码闸；全部人设（anaxis/base/A/B）已标注管理员权限规则 |
| **审批流（请求转发到管理员的 AI）** | 普通成员 `class_request_admin`（summary + 可选白名单 pendingAction）→ 微信转发给周祎宸（无管家时存档）→ 管理员对自己的 AI 说「批准/拒绝 xxx」→ `class_approve_request`/`class_reject_request`（仅管理员 callerId 可调）→ 白名单 action（submit_schedule/notify_all/submit_notice）以管理员身份自动执行（`_dispatchAgentTool` HTTP 回环复用全部闸逻辑）→ 请求者收到结果通知 |
| **可见范围隔离** | `query_pending_approvals`：管理员看全部，普通成员只看自己发起的 |
| **日程删除** | `class_delete_schedule`：本人创建或只涉及自己免密；他人创建且涉及他人需管理员 |

踩坑：`request_admin` 的白名单参数最初叫 `action`——与请求体顶层 `action` JSON key 冲突（重复 key 后者覆盖前者），导致绑定 `submit_schedule` 的审批请求被直接当作 submit_schedule 执行（403）。改名为 `pendingAction` 修复；白名单三个 action 的自身参数均无 `action` 键，内部 dispatch 安全。
- 测试：`CLI_API_KEY=dsh-test-internal-key-2026 node index.js` 后运行 `node backend/scripts/test-dsh-member-tools.js`（25 项：身份校验/自发拒绝/白名单校验/自动执行链/管理员直通/拒绝通知）

**微信托管：初始身份认证 + AI 主动消息（每日一问/日程通知迁移到 dsh）**（2026-09-01，本地实测 26/26 全过 + 回归 25/25）：

微信账号已就绪后的完整接入层。核心机制——**AI 主动消息（proactive message）**：系统事件作为指令消息送入成员的 dsh session，AI 以人设口吻生成转达内容发到微信；**事件指令与 AI 回复都写入 session 历史（拼接入上下文）**，成员回复时 AI 记得自己主动说过什么，对话自然衔接、无上下文断裂。

| 能力 | 机制 |
|---|---|
| **初始身份认证（绑定流程，姓名制）** | `绑定 姓名 密码`（bcrypt 校验 members.json，与 App 登录同源；姓名解析全名→名字，**重名由密码区分**；学号是内部编码不外用）；**防爆破**：连续 5 次错误锁 30 分钟；绑定成功 → **AI 欢迎语**（`bind_welcome` 主动消息，绑定即成为会话第一条消息，身份注入自然完成；非 dsh 引擎降级静态文案）；`解绑 姓名 密码`（密码确认，换号/退出清理）；同账号旧 wxid 顶替（换号重绑，旧设备绑定移除）。管理员走独立入口「管理员登录 名称 管理员密码」（见下节） |
| **AI 主动消息管线** | `DshAgentEngine.processProactiveMessage(memberId, kind, payload)`：三类指令（`bind_welcome`/`daily_question`/`schedule_notify`）→ session.run（框架标签「系统事件（非成员发言，按其中指令行动）」区分用户消息）→ 流式回调。`StewardManager.sendProactiveMessage`：会话处理中先等待（≤90s，防同 session 并发 run）→ 复用 `_runAgentTurn` 流式分条管线（与用户消息共用：跳句即发 + 出站限流 + 图表转图） |
| **每日一问（迁移）** | 12:00/22:00 窗口：steward 在线时对已绑定成员发 **AI 每日一问**（学员问题经 `/api/checkin/student-question` 回环生成、当天缓存；管理员问题走凌晨生成缓存；班长/指导员只收管理员版问题避免重复）→ AI 口吻转述进上下文；JPush（App 通道）保留；steward 离线回退原 JPush+静态文本流程。**回答闭环**：成员回复自然进 dsh 会话 → AI 调 `class_submit_checkin` 落库（原语 + mood + tags，格式与 /api/checkin/feedback 一致）→ 轻量异常信号（伤病词/人际风险词/连续情绪低迷）自动微信通知周祎宸。旧引擎模式保留管理员直答拦截（API 落库 100% 可靠），dsh 模式移除拦截走会话内回答 |
| **日程通知（迁移）** | 到点日程（getDueSchedules 一分钟窗口）：steward 在线 → `schedule_notify` AI 消息（人设口吻提醒，保留标题/说明/时间关键事实）+ JPush；未绑定/失败回退 per-member 静态文本。全员日程 → 逐成员 AI 消息（出站队列限流自动交错，129 人约 6 分钟） |
| **静默系统事件（上下文同步）** | `DshAgentEngine.injectSystemEvent(memberId, text)`：不触发 AI 回复、不发送；暂存后拼在该成员下一条消息的 prompt 前缀（`【系统事件】`，**一次性消费**）。已接线：App 打卡落库（/api/checkin/feedback）→ 注入「已在 App 完成每日一问，今天不需要再发」——微信 AI 不重复问、能自然衔接聊 |
| **人设同步机制** | `DshAgentEngine._syncPersona()`（幂等）：`personas/AGENTS.{DSH_PERSONA}.md` → `workspace/AGENTS.md`，内容有差异才覆盖（dsh agent-instructions 热更新通道自动重注入）。`DSH_PERSONA` 环境变量选人设（默认 anaxis）。personas/ 是唯一真源，修复了 workspace 人设落后 personas 的问题（管理员规则此前未生效于实际加载文件）；全部 4 个人设补充「每日一问与系统事件」硬规则 |
| **pushScheduler 第四参数** | `start(pushManager, getWechatManager, getEngine, getSteward)`：stewardReady() 在线检测；管理员/学员推送双分支（steward AI 优先 + 原逻辑兜底）；`app.set('dshEngine')` 暴露给 routes 做静默注入 |

- 测试：`CLI_API_KEY=dsh-test-internal-key-2026 node index.js` 后运行 `node backend/scripts/test-dsh-proactive.js`（26 项：指令构建/静默注入一次性/系统事件框架/流式分条落微信/防爆破锁定/人设同步/submit_checkin 权限与落库/异常信号）+ `test-dsh-member-tools.js` 回归 25/25
- 部署形态：`STEWARD_ENABLED=1 DSH_ENGINE=1 [DSH_PERSONA=anaxis]`；微信侧待办——GeWeAPI 云托管注册 + GEWE_TOKEN + 扫码登录 + 真实好友链路验证（通道已默认云托管）

**主动消息功能开关 + 友好绑定/管理员登录 + 上下文跨进程恢复**（2026-09-01；登录体系改姓名制后 `test-dsh-login-flow.js` 39/39 + `test-dsh-prefs-persist.js` 48/48 回归全过，`--persist-model` 含真实跨进程模型验证）：

| 能力 | 机制 |
|---|---|
| **功能开关（对话式）** | `class_set_prefs` 工具（免密、只影响自己）：不传 prefs 查询状态；`daily_question`/`schedule_notify` 独立开关，`{"all": false/true}` 批量。存储 `data/proactive_prefs.json`（proactivePrefs.js，缺省全开）；`StewardManager.sendProactiveMessage` 发送前检查（`bind_welcome` 不受控）。绑定欢迎语一并告知功能清单与开关话术（「关闭每日一问」等） |
| **友好绑定/登录（姓名制，兜底）** | 「绑定/登录/绑定账号/登录账号」同义；**学号不再作为登录凭据**（系统内部编码不外用）：姓名解析（全名 → 名字不带姓/复姓），**重名由密码区分**（密码在候选中 bcrypt 匹配，唯一命中即通过）；只发「绑定」→ 分步引导（含管理员入口）；密码错提示剩余次数（5 次锁 30 分钟，成员密码与管理员密码共用计数）；解绑按当前绑定走对应凭证。换绑顶替：同账号只保留最新 wxid，旧设备绑定移除 |
| **管理员登录（名称+管理员密码）** | 独立入口「管理员登录/登录管理员 名称 管理员密码」：名称可自由注册（首次登录即注册，`data/admin_contexts.json`），**名称只是上下文键**（决定对话历史归属，换设备同名登录即续），身份凭证是管理员密码（`config.adminPasswords`，与后端 verifyAdminPwd 同源，登录时校验一次）。绑定 `admin-{名称}` 上下文 → 后端 `isAdminCaller` 直接识别（敏感操作免密、审批直达）；AI 欢迎语走管理员变体指令（说明能力与独立上下文）。管理员上下文**接收管理员版每日一问与全员日程提醒**（与旧引擎对齐），同样可用 `class_set_prefs` 自行开关（与成员同机制、独立生效） |
| **上下文持久化恢复** | 每轮对话导出 `data/conversation_memory/{memberId}_dsh.json`（滚动 200 轮，含主动消息标注 `[你主动发的 daily_question]`）；新会话首条 prompt 注入【历史对话摘要】作为兜底通道 |
| **跨进程完整恢复（server fork resume，2026-09-01 生效）** | dsh JSON-RPC 协议本身无 resume 通道（服务端 `createSession` 走 `AgentRegistry.create`，永远新建不读磁盘日志）→ **fork `@deepseek-ai/dsh-sdk-jsonrpc-server` 为 `steward-jsonrpc-server` 插件**（`generateServerFork.js` 从已安装原包锚点替换 `createSession`：有持久化日志 → `agents.resume` 完整恢复历史；无日志 → create；语义复刻 dsh-agent-loop 的 restoreOrCreateConfigured）。挂载方式：bundle 原 `sdk-jsonrpc-server` 行 disable + fork 独立 insert 行（**cordis 行覆盖不能改 name**——patch 的 name 与目标行不一致时整行被静默跳过，`applyEntryPatches` 的 name-mismatch 守卫；曾因此踩坑 fork 未加载、症状是仍走摘要+空转降级）。引擎侧配合：`_hasStoredSessionLog` 检测磁盘日志（编码路径段与 dsh 同款）→ 预期 resume 时跳过摘要注入；实测进程2 续写同一日志文件、无降级隔离目录、暗号完整恢复（`--persist-model` F 组机制断言） |
| **空转检测降级（保底层）** | 跨进程复用磁盘已有日志的稳定 id 时曾现：`agents.create` 与持久化日志冲突、错误被 dsh 内部 `live.init.catch(()=>{})` 吞掉 → turn 正常结束但**零模型调用零输出**。引擎检测 run 正常返回但零内容 → 标记冲突 → 降级隔离 id（`{logicalId}-{bootId}`）重跑一轮，摘要已在 prompt，连续性不受损；重试仍空则显式抛错。resume fork 生效后主流程不再触发，保留为 fork 失败/未加载时的兜底 |

**关键技术决策**（联调中踩坑记录）：
1. **沙箱重定向**：`DSH_HOME` → `backend/agent/dsh/home`（默认 `~/.dsh`）、`NARB_NATIVE_CACHE_DIR` → 项目内（默认 `%LOCALAPPDATA%`）——本地开发与部署目录一致
2. **session id 策略（2026-09-01 修订）**：默认稳定 id（`member-612`，同进程多轮连续 + 前缀缓存友好）；跨进程复用时 server fork 优先 `agents.resume` 完整恢复磁盘日志（续写同一会话），空转降级 `{id}-{bootId}` 隔离重试仅在 fork 未生效时兜底。`DSH_SESSION_PERSIST=0` 可全程隔离（本地双开调试）
3. **插件机制**：dsh 插件 = profile 的 out-of-tree npm 包（`$DSH_HOME/profiles/sdk/` 的 `package.json` dependencies + `cordis.patch.yml` insert 条目），不是散落 `.agents/` 文件；`file:` 安装是复制快照，引擎每次初始化同步源码覆盖
4. **schema 转换**：裸注册工具时 dsh 不做隐式 DSL → JSON Schema 转换（`defineTool` 才做），发 DeepSeek API 报 `type: null` 400 → 插件内自实现 `implicitToJsonSchema`（属性级 `required` 提升顶层）
5. **stdout 归属**：SDK profile 的 stdout 专属 JSON-RPC，插件日志必须走 stderr
6. **Windows 附件 chmod bug（上游）**：`dsh-attachment-local` 持久化顺序 link→unlink→chmod(0o400)，NTFS 上"删除 hard link 名后 chmod 另一名"必然 EPERM（实测：不 unlink 则正常、加延迟无效）→ 所有图片附件写入失败 → 引擎初始化时幂等 patch（Windows 跳过 chmod，0o400 只读是防篡改加固非功能依赖；上游修复后 patch 点消失自动跳过并提示）

**端点测试结果**（本地）：
- `POST /api/wechat/steward/callback` 转发 → 200（AddMsg 正确分发）
- `/api/internal/agent-tool` 无鉴权 → 401（闸2 生效）
- `query_members 丁丕硕班` → 200 count=12
- `query_scores 612` → 200 week=1
- `submit_score` 无密码 → 403「管理员密码错误」（闸3 生效）
- `query_schedule/query_bmi 612` → 200
- DSH_ENGINE=1 + dsh 缺失 → 管家自动降级现有 Engine，服务正常

**微信托管落地：GeweChat 通道对齐真实 API + VPS 部署 runbook**（2026-09-01，mock 全链路 19/19）：

早期通道代码按臆测的 API 写（`/v2/login/...`、`sendText`、独立 `FriendMsg` 类型、回调 `127.0.0.1`），与真实自部署 GeweChat（github.com/Devo919/Gewechat）全部对不上。已逐接口核对 GeweChat Java 源码 + dify-on-wechat 参照实现后重写 [geweChannel.js](file:///e:/新建文件夹 (3)/backend/wechat/geweChannel.js)：

| 环节 | 真实 API（已核对源码） | 通道实现要点 |
|---|---|---|
| 鉴权 | `POST /v2/api/tools/getTokenId` → data 即 token 字符串 | 所有请求带 `X-GEWE-TOKEN` 头；token 失效自动重取重试；token/appId 持久化 `data/wechat/gewe-session.json` |
| 登录 | `/login/getLoginQrCode {appId}` → `{appId,uuid}`；`/login/checkLogin` 轮询 5s（**data.status=2 成功**，expiredTime≤5 换码）；`/login/checkOnline {appId}` 免验证重登 | **appId 必须持久化复用**（新 appId 次日掉线，原 appId 稳定后可长期在线）；二维码内容 = `http://weixin.qq.com/x/{uuid}`（后端 qrcode 包生成 data URL） |
| 回调注册 | `/tools/setCallback {token, callbackUrl}`（**全局配置**，callbackUrl 必须公网可达；GeweChat 先发 `{testMsg}` 验证，3s 内须响应） | `GEWE_CALLBACK_URL` 环境变量（生产必配）；媒体图同源暴露 |
| 回调消息 | `{TypeName:'AddMsg', Appid, Wxid, Data:{FromUserName:{string},MsgType,Content:{string},NewMsgId,...}}` | 自消息 = `FromUserName.string === Wxid`（**不是 appId**）；去重 = `Appid+NewMsgId`（重试/同步会重复推送）；MsgType 51 状态同步忽略 |
| 好友申请 | **AddMsg + MsgType 37**（Content 为 XML：`fromusername`/`encryptusername`=v3/`<ticket v4>`/`scene`；FromUserName 为系统账号 fmessage） | XML 正则解析 → `/contacts/addContacts {scene, option:3 同意, v3, v4}` |
| 发消息 | `/message/postText {appId,toWxid,content,ats}`；`/message/postImage {appId,toWxid,imgUrl}` | **imgUrl 必须是 GeweChat 可下载的公网 URL** → 新增 `/api/wechat/steward/media/:file` 端点服务 `data/chart_images/`（basename 防穿越），`_toMediaUrl` 自动构造（origin 同回调） |

**VPS 部署 runbook（自部署备选方案；首选已切 GeWeAPI 云托管，需与微信号注册地同省）**：
```bash
# 1. Docker 起 GeweChat（2531 API + 2532 文件下载，--privileged + /usr/sbin/init 是官方要求）
docker pull registry.cn-hangzhou.aliyuncs.com/gewe/gewe:latest
docker run -itd -v gewe-data:/root/temp -p 2531:2531 -p 2532:2532 \
  --privileged=true --name gewe registry.cn-hangzhou.aliyuncs.com/gewe/gewe:latest /usr/sbin/init
docker update --restart=always gewe
# 2. 防火墙放行 2531（仅限后端服务器 IP 更稳）
# 3. 验证：curl http://VPS_IP:2531/v2/api/tools/getTokenId -X POST → {"ret":200,"data":"..."}
```

**后端上线步骤**（云托管首选，代码侧零改动）：
1. GeWeAPI 控制台（manager.geweapi.com）注册 → 「Token中心」生成 Token；控制台「在线登录」（可配 AID）扫码登录成功后，把返回的 appId 填 `GEWE_APP_ID`——后端启动即 checkOnline 直接上线，无需走接口扫码
2. 环境变量：`STEWARD_ENABLED=1 DSH_ENGINE=1 GEWE_TOKEN=控制台Token GEWE_CALLBACK_URL=https://后端域名/api/wechat/steward/callback`（GEWE_API 不配即默认云 https://api.geweapi.com）
3. 重启后端 → 管家自动启动（无登录态则等待扫码）
4. 管理员打开 `GET /api/wechat/steward/qrcode`（浏览器直接渲染 data URL）→ 管家小号微信扫码 → 手机确认
5. `GET /api/wechat/steward/status` 确认 `online:true`；日志确认「回调已注册」
6. 成员加管家好友 → 自动通过 + 欢迎语 →「绑定 姓名 密码」→ AI 对话
7. 重启后端验证免验证重登（日志「免验证重登成功（appId 复用）」，无需再扫码）

- 测试：`node backend/scripts/test-gewe-channel.js`（26 项：mock GeweChat 服务端复刻真实 API 行为含 X-GEWE-TOKEN 校验/testMsg 推送/imgUrl 下载，起临时后端实例验证登录→回调→AI 回复→出站全链路；I 段子进程验证云托管模式——/gewe/v2/api 前缀、GEWE_TOKEN、/login/setCallback；`test-steward-outbound.js` 回归通过）
- 注意：新设备首次登录后 **24 小时内可能掉线一次**，属 GeweChat/微信正常现象，掉线回调触发自动重登（复用原 appId 重新取码扫码一次，之后长期稳定）

**部署开关**（环境变量）：
```
STEWARD_ENABLED=1    # 启用单号管家（默认关，与 per-member 模式并存）
DSH_ENGINE=1         # 管家运行在 dsh 底座（缺失时自动降级现有 Engine）
GEWE_TOKEN=控制台Token   # 云托管（默认）：GeWeAPI 控制台「Token中心」生成；设置后不再调 getTokenId
GEWE_APP_ID=wx_xxx      # 可选：控制台「在线登录」拿到的 appId（控制台配 AID 扫码后填这里；后端直接 checkOnline 上线，优先级高于磁盘 state，避免另生成新 appId 互挤）
GEWE_API=https://api.geweapi.com    # 不配即默认云托管（前缀 /gewe/v2/api）；自部署填 http://VPS_IP:2531（前缀 /v2/api）
GEWE_MODE=cloud      # 可选显式声明云模式（GEWE_API 自定义代理地址时用）；自部署不配
GEWE_CALLBACK_URL=https://后端域名/api/wechat/steward/callback   # 公网回调（生产必配；发图媒体 URL 同源）
GEWE_CALLBACK_TOKEN=xxx                  # 可选回调鉴权（配置后带 token 字段的推送严格校验，无字段宽容放行）
GEWE_LOGIN_TYPE=mac                      # 登录设备类型 mac|ipad（默认 mac：支持 autoSliding 自动滑块验证）
GEWE_REGION_ID=610000                    # 登录线路地区（默认陕西，与微信号注册地同省）
GEWE_AID=123456                          # AID 本地代理 6 位编号（本机运行 gewe-AidNet 客户端；解决同网络设备验证，主动加好友必用）
GEWE_AUTO_SLIDING=1                      # mac 自动滑块验证（默认开，置 0 走 App 手动验证）
DSH_MODEL=deepseek-v4-flash-vision-exp   # 可换 vision 模型
```

**登录设备验证（"需验证此设备和平板/PC 连接至相同网络"）**：登录链路走 GeWeAPI 机房线路时微信会要求新设备与手机同网络，手机端选择 WLAN/热点无法通过。解法 = **AID 本地代理**（GeWeAPI 官方方案，登录流量走自己设备的网络出口）：
1. 在与手机同一 WiFi 的设备上运行 Aid 客户端：Windows（`gewe-AidNet-win64.exe`）或 Android（「AID+Mac 滑块验证 APP 二合一版」，pgyer.com/aidnet）；出站放行 `aid.nodemsg.com` 443/1080
2. 复制 6 位 Aid 编号 → 后端环境变量 `GEWE_AID` → 重启重新取码扫码，同网络验证即可通过
3. 实例在线期间保持 Aid 客户端常开；掉线重连若 Aid 节点未变可继续用原编号
4. 备选：`GEWE_REGION_ID` 选同省线路缓解异地风控；验证不过且反复掉线 = 账号临时风控，次日早 8 点后再试；重登务必复用原 appId（新 appId 次日掉线 + 越登越风控）

**待办**：
- [x] dsh 主包安装（0.1.2-alpha.2）→ 子进程全链路 → steward-bridge 插件联调 ✅ 2026-08-30
- [x] vision 多模态实测：Windows 附件 chmod patch + 引擎 `context.images` API + 差分验证 ✅ 2026-08-30
- [x] cli_gateway CLI 兜底工具：路径分级权限矩阵 + 审计日志 + 模型真实调用 ✅ 2026-08-31
- [x] dsh 能力核实 + prompt 注入重构：AGENTS.md 原生指令通道 + 首条仅动态身份 + 前缀缓存实测（76.2% vs 反例 38.9%）✅ 2026-08-31（附带修复：package.json dsh 版本锁 0.1.1-rc.2→0.1.2-alpha.2 精确双锁，防重装降级）
- [x] Anaxis 人设定稿（B 底 + A 特征混合）+ 微信真人式分条发送 ✅ 2026-08-31
- [x] GeweChat 通道对齐真实 API + 全链路 mock 验证（19/19：登录协议/回调注册+testMsg/二维码端点/入站→AI→出站/去重/好友 XML 解析→addContacts/媒体端点/sendImage imgUrl 下载/免验证重登）✅ 2026-09-01（`test-gewe-channel.js`，mock GeweChat 服务端复刻真实行为）
- [x] 通道切换云托管（GeWeAPI 商业服务）：默认 GEWE_API=https://api.geweapi.com（前缀 /gewe/v2/api）+ GEWE_TOKEN（控制台 Token 中心）+ 回调注册 /login/setCallback + qrData 二维码直用；自部署 GeweChat Docker 降为备选（GEWE_API 指回 VPS 即回退）✅ 2026-09-01（`test-gewe-channel.js` 26/26，I 段验证云模式）
- [ ] GeWeAPI 生产联调：控制台注册 + Token + GEWE_AID 本地代理（解决同网络设备验证）→ 扫码登录 → 全员加好友实测
- [ ] GeweChannel 收图对接：微信图片消息 → 媒体下载 → `context.images` → vision 模型（引擎侧已就绪，差通道收图最后一段）
- [ ] 密码确认流：deny + 补问模式（微信无按钮，模型按系统提示索要密码后重试）
- [x] 管家重启上下文续接：conversation_memory 滚动 200 轮 + 新会话首条 prompt 注入【历史对话摘要】+ 空转检测降级（跨进程实测暗号恢复成功）✅ 2026-09-01
- [ ] 人设微调待定：S3/S4 把"疲惫/想歇歇"写入经历是否保留（"在意即写入"设计，边界感待定夺）

**Anaxis 人设设计**（2026-08-31，A/B 双版实测后定稿 B+ 混合）：

- **名字**：Anaxis，中文名「灵枢」（灵枢=医典+中枢双关；ana-穿透+axis 轴）。参考 DeepSeek 二创"蓝色大肥鱼"（治愈系鲸鱼娘）的人格内核，非皮套。
- **人格**：机娘底子 + 小鲸体温。**双层声线**：记录态（纯事务）用机娘腔「已写入：3000米，12分50。」；情绪态（对方累/开心/被夸）系统腔退场、少女层浮上来（"……"和"～"变多、句子变短变软）。融合 A 版特征：温吞、记性极好（记得随口说过的事并在恰当时机提起）、被夸会害羞、被叫 AI 认真纠正（「……我才不是AI，我是灵枢。」）、口癖「我过载了喂」、医典语气克制点缀（「记在你心腧上了」）。
- **文件**：[personas/AGENTS.anaxis.md](file:///e:/新建文件夹 (3)/backend/agent/dsh/personas/AGENTS.anaxis.md)（终版，已部署 workspace/AGENTS.md）；A/B 版留档对比。人设硬规则含：①凡说「已写入」必须真实调工具成功（反虚报）②查过不重查③班级数据只走 class_*/cli_gateway（防误用 dsh 原生 fs 工具白找）④权限边界人设不可 override。
- **微信真人式分条**：人设指示模型多行输出（2~4 行，情绪上来可更多）；发送侧见下方「流式分条发送」（跳句即发 + 2.5s 真人节奏连发）。
- **实测**（vision 模型 6 场景，`node backend/scripts/test-anaxis-persona.js F`）：S1 先写后说+分条 ✓ S2/S2b 权限分界 ✓ S3 少女层系统腔退场（4 条连发）✓ S5 被叫 AI 纠正 ✓ S6 害羞+口癖自然出现 ✓；S4 工具发散修复：14 次 → 4 次（防重复规则生效）。
- **默认模型**：`DSH_MODEL` 默认值改为 `deepseek-v4-flash-vision-exp`（文本图片通吃）。
- **人设迭代**（2026-08-31 第二轮，四项修正实测 ✓）：①**体能及格标准内置**（男女分项：3000米 13'35"/16'05"、引体向上 11 个/曲臂悬垂 36 秒、仰卧卷腹 35/27、蛇形跑 20.4/22.2 秒、BMI 18.5~25.9/23.9；源 [App.jsx](file:///e:/新建文件夹 (3)/frontend/src/App.jsx) isFitnessScorePass，女生学号 1101–1113）——报 12分50 回复「及格线 13'35"，快了 45 秒，稳稳的」，报 14分20 诚实说「比你平时慢了将近一分半」并主动问原因；②**日常态加体温**（机娘≠无情绪：低浓度情绪藏措辞里，记录精确但下句自然带反应，不再是系统播报腔）；③**称呼改代词**（日常用"你"，点名场景才叫名不连姓）；④**情绪倾诉不落库**（S3 零工具调用，上一版是落库的；仅事实性内容和她明确要求记录的才写）。
- **工具覆盖盘点**（现有 12+1：8 查询 + 3 写入 + 1 通知 + cli_gateway 兜底）：已覆盖评分/学习/体测/名册/日程/BMI/伤病/经历查询、经历/日程/评分写入、通知。缺口：①心情记录（mood_record 前端表单无桥接，微信场景"心情倾诉不落库"规则与正式 mood 量表的边界待设计）②值日 duties 独立于 scheduleStore（cli_gateway public 只读可兜底）。均属低频，暂不补。
- **权限模型调整**（2026-08-31 第三轮，实测 ✓）：**评分/学习成绩/体测成绩（含 BMI）改为班级公开数据**——查任何人免密（六维评分本就是互评体系；对齐前端全员可见）。需管理员密码的收敛为**个人敏感数据**（经历/心情/打卡明细）+ 写操作（替他人排程/改公开共享文件/广播/上传官方数据）。新增 `class_query_academic`（学习成绩）+ `class_query_fitness`（体测含历史）两工具；`query_scores` 后端移除 callerId 隔离。实测：S2 查 601 评分直接调工具转述 ✓ S2b 查 601 经历索要密码 ✓（模型还会主动提示"体测是公开的，不用密码"）。
- **流式分条发送**（2026-08-31，[test-steward-outbound.js](file:///e:/新建文件夹 (3)/backend/scripts/test-steward-outbound.js) mock 验证 ✓）：`onToken` 逐换行切分、**跳句即发**（首条 1.03s 发出，不等模型输出完毕）；后续行由出站队列按真人节奏连发（2.5s+抖动 0-2s）。工具调用前的文本也先发出。
- **限流按 129 人规模调整**（原 5s+10s 抖动/日限 200 → 现行）：同联系人 ≥2.5s + 抖动 ≤2s（真人连发节奏，主力防线）；全局日限 1500（**保险丝语义**：正常聊天碰不到，防模型失控/通知风暴，触发时醒目告警+消息顺延次日不丢弃）；单联系人日限 80（防循环回复 bug）；**扫描式调度**（发第一条"已到期"消息，不同联系人交错发送，无队头阻塞——129 人并发不串联延迟；同 wxid 顺序天然保持）。实测：三连发间隔 2.6s；a1→b1→a2 交错（b1 未被同联系人间隔阻塞）。

### 4.2 身份绑定（一切安全的前提）

复用现有 `wechat_bindings.json`（wxid → memberId）：

- **首次对话**：`绑定 1103 密码xxx` → 校验 members.json → 绑定 wxid。
- **已绑定**：每条消息先解析身份，session 按 memberId 完全隔离（harness session 插件天然支持，append-only 事件日志）。
- **陌生人**：只回复绑定指引，任何数据操作拒绝。
- 换手机/换号 → 重新绑定（旧绑定失效需管理员解绑）。

### 4.3 权限矩阵

| 级别 | 身份 | 读 | 写 | 班务 |
|---|---|---|---|---|
| L0 | 未绑定 | 绑定指引 | — | — |
| L1 | 成员 | 自己全部 + 他人公开数据 | 自己的数据（打卡/心情/委托补录/日程/个人 Intent） | — |
| L2 | 骨干（班长/班委） | 本班数据 | 同 L1 | 班务操作提案（排班/公差分配）→ **确认流**后写入 |
| L3 | 管理员 | 全局 | 全局，**关键写操作必须过密码三闸** | 全部 |

关键写操作清单（过密码三闸）：修改他人信息、导入官方数据（学习成绩/BMI/体能/通报）、删除记录、修改拍卖/账本、学期配置。

### 4.4 密码三闸（用户"双重判断"的强化版）

> 原则：**AI 判断只决定"何时问"，后端强制决定"是否放行"**。绝不能只靠 AI——腾讯朱雀实验室对 dsh 的间接注入评估显示最高攻击成功率 25.5%（文件模式隐藏 Unicode），prompt 层防线必须被架构层兜底。

| 闸 | 位置 | 职责 |
|---|---|---|
| **① AI 规则层** | PromptBuilder 注入敏感操作表 | 主动**先要密码再调用工具**（体验：不会执行失败后才补要） |
| **② harness 策略钩子** | dsh tool-call policy（前置拦截） | 工具调用前检查 (memberId, tool, target) 三元组是否放行 |
| **③ 后端强制校验** | 工具 execute() 入口 | 校验 `adminVerified` 窗口凭证；不通过返回 `need_password`，AI 补要 |

密码安全设计：
- 验证成功 → 5 分钟窗口（`adminVerifiedUntil`），期间免重复输入；
- **密码永不进入**：对话记忆（memory 过滤器正则脱敏）、session 日志、game_ledger（只记"已验证"不记密码）；
- 微信明文风险的缓解路线：v1 短窗口 + 脱敏 → v2 一次性动态口令（App 生成 6 位码，微信里发码而非真密码）。

### 4.5 上下文隔离与跨用户消息（用户明确关注点）

**隔离**：session 按 memberId 严格隔离。班长对话里的排班理由，不会泄漏进被排班成员的对话（通知文本由 AI 面向个人重新生成，如"因你近期任务较少"）。

**跨用户消息的唯一合法形态 = 事务对象（Task）**，而非自由传话：

```jsonc
{
  "id": "task_...",
  "type": "duty_assignment",        // duty_assignment / confirm_request / notify / delegation
  "from": "system",                 // 永远是 system，不是某个用户（防伪造）
  "target": "1103",
  "context": "周三公差安排：搬水。发布：班长（确认于 xx:xx）",
  "replies": ["确认", "请假", "换人"],
  "createdAt": "beijingISO"
}
```

- AI 永不转发"A 让我告诉你 xxx"——只发自己生成的事务文本（**防身份伪造、防骚扰、防上下文污染**）；
- 目标用户回复时自动携带事务上下文（"关于你被安排的周三公差…"）；
- 用户可对管家说"别给我发通知"（偏好落 member_states）；
- 群聊 v1 不做（群消息 sender 识别+上下文复杂度高），v2 再评估。

### 4.6 多模态录入（vision 的价值点）

| 输入 | 处理 | 权限 |
|---|---|---|
| Excel 表格 | harness 下载 → 走现有 import 管道（fitness/academic/rank/bmi/weekly-report 安全合并） | 密码三闸（官方数据） |
| 成绩单/通报照片 | vision OCR → 结构化 → 姓名匹配 members → **预览确认** → 写入 | 密码三闸 + 确认流 |
| 训练日志照片 | vision → 结构化 → 学员自己确认 | L1（自己数据） |

数据出境分层：一般照片走 v4-flash vision；涉密材料走本地 OCR（tesseract）或拒绝对外（用户偏好配置）。exp 模型不稳定 → `DEEPSEEK_MODEL` 环境变量可即时回退 deepseek-chat。

### 4.7 新增管家工具（harness 插件 → 现有能力映射）

| 工具 | 映射 | 说明 |
|---|---|---|
| `duty_roster_generate` | 读 duties.json + injury_status + 通报 | 公平算法：次数最少优先 + 伤病排除 + 随机打散 |
| `duty_write` | 写 duties.json | L2 确认流 或 L3 密码闸（可配） |
| `task_notify` | 管家号 → 目标成员 | 发事务对象（§4.5） |
| `photo_extract` | vision OCR → 结构化 | 按数据类型路由 import 管道 |
| `file_import` | 现有 CLI import | 白名单子命令集（非全量 CLI） |
| `phone_alarm` / `calendar_write` | 原生 Intent（随安卓迁移） | AI 成长管家场景 |

**CLI 的定位**：CLI 是管理员运维通道，不是 AI 的裸工具箱。给 AI 的 CLI 子集 = 白名单子命令 + 三闸校验；现有 22 工具已做细粒度权限（member_info 隐藏他人隐私等），继续作为 L1 查询主力。

---

## 5. 统一场景走查：公差分配（全链路）

```
班长（L2）："下周出3个公差，分配一下"
  → 管家 duty_roster_generate：读 duties 历史（累计次数）+ injury_status（排除伤病）
  → 回复名单 + 理由（"张三累计2次最少，李四伤病恢复期排除…"）
班长："确认"
  → ② harness 策略钩子放行（L2 + 确认消息在上下文中）
  → duty_write 写入（T1 凭证：骨干指令+确认，进审计）
  → task_notify ×3：管家号给三名成员发事务通知（"你被安排周三公差…"）
成员回复"我那天有事"
  → 管家走调换流程：重新选人 → 通知班长确认 → 改记录
公差完成
  → 纪律哨站 +8 星辉（游戏 F1 修正：日程/任务维度归属）→ 账本留痕
```

一条微信消息，穿过：身份识别 → 权限 → 工具执行 → 数据写入 → 跨用户事务通知 → 游戏结算 → 审计。**这就是飞轮转动的样子**：办事即记录，记录即数据，数据即成长。

---

## 6. 风险清单

| 风险 | 缓解 |
|---|---|
| **iPad 协议非官方（封号风险）** | 官方辅助账号合规注册 + 1-2 周养号；管理员手机同步在线（多端真人行为）；全局出站节流；AI 输出敏感词过滤；**预案：主号辅助名额可再养 1 备用号，bindings 快速迁移**；iLink/ClawBot 通道保留为降级路径（消息通道抽象层可切换） |
| 单号流量集中 | 同用户分钟级节流；批量通知分批间隔发送；App push 兜底未加好友成员 |
| PadLocal 付费 token 失效/停服 | 消息通道抽象（WeChatChannel 接口）+ iLink 备选通道 + 关注官方 API 开放动态 |
| dsh 开发者预览期 API 漂移 | lock 版本 + 适配层隔离；三闸设计同构可回迁自研 Engine |
| 间接 prompt 注入（dsh 实测 ASR 最高 25.5%） | 密码三闸；工具白名单；注入测试纳入发布前检查 |
| 密码微信明文 | 短窗口 + 脱敏不进记忆；v2 一次性动态口令 |
| vision 数据出境 | 分层路由；涉密本地 OCR |
| exp 模型不稳定 | DEEPSEEK_MODEL 可配置回退 deepseek-chat |
| 群聊上下文污染 | v1 仅私聊（msg.room() 过滤） |
| 用户并发 | 每用户独立 session 可并行；单成员 isProcessing 队列复用现有实现 |

---

## 7. 里程碑（统一排序）

1. **P1 管家最小闭环**：单号绑定 + 身份识别 + L1 查询（现有 22 工具经 harness 适配）+ 密码三闸雏形（②③先落）。
2. **P2 班务场景**：duty_roster_generate / duty_write / task_notify + 公差分配全链路 + 审计。
3. **P3 多模态**：photo_extract + file_import + 通知兜底（App push 与管家号双通道）。
4. **P4 游戏引擎 M0-M1 接入**（游戏文档 §17）：结算器 + 基地经营 —— 管家写公差记录 → 星辉入账。
5. **P5 一次性动态口令 + 群聊评估**。

P1-P3 不依赖原生迁移（微信侧全后端）；P4 与安卓迁移并行。
