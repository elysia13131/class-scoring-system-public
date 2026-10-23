# 播放模式插件化扩展设计（2026-09-03）

## 背景与目标

播放模式当前只循环播放各班级雷达评分页（每页 6 人，固定 8 秒切换）。需要把它扩展成"清单驱动"的轮播：

- 清单由班级块 + 自定义项（图片 URL、网页 URL）线性组成，班级块可自由穿插任意位置，每项可独立设时长；
- 网页项以**可交互 iframe** 呈现；切走时**隐藏保活**（不销毁），滚动位置天然保留，切回秒开；
- 图片项在进入播放模式时预载（缓存好）；
- 全局雷达页时长与整份清单都可以通过 CLI **远程更新**（无需改前端/重启）。

已确认的关键决策：

1. 序列模型：`class` 块为最小单位（自动展开成每页 6 人的雷达子页），图片/网页可插到任意班级块前/后或自定义项之间，自由重排。
2. 每个 slide 独立时长；雷达页默认时长全局配置（写死 8s → `radarDuration`），班级块可单独覆盖。
3. 网页项：可交互 iframe + 隐藏保活记忆滚动位置；保活数量设上限，超出按 LRU 卸载。
4. 无配置时前端兜底"全部班级 + radarDuration"，与现状行为一致。

## 数据模型（服务端落盘 `data/playmode.json`，生产持久卷，git 忽略）

```json
{
  "radarDuration": 8,
  "keepAlive": 3,
  "items": [
    { "id": "c1", "type": "class", "className": "高一(1)班" },
    { "id": "i2", "type": "image", "label": "本周之星", "url": "https://…", "duration": 10 },
    { "id": "u3", "type": "url", "label": "值日表", "url": "https://…", "duration": 25 }
  ],
  "updatedAt": "2026-09-03T08:00:00Z"
}
```

字段规则：

| 字段 | 类型 | 说明 |
|---|---|---|
| `radarDuration` | number | 全局雷达页默认时长（秒），1–3600，缺省 8 |
| `keepAlive` | number | 网页保活 iframe 上限（个），≥1，缺省 3 |
| `items[]` | array | 线性清单；缺省/为空 = 全部班级按序 + radarDuration |
| `items[].id` | string | 服务端分配，供 rm/move 引用（可选，写入时不传则生成） |
| `items[].type` | string | `class` / `image` / `url` |
| `items[].className` | string | 仅 class，必须匹配当前班级集合 |
| `items[].url` | string | 仅 image/url，必须 `http(s)://` |
| `items[].label` | string | 可选展示名；缺省用 URL 主机名 |
| `items[].duration` | number | 可选；1–3600，覆盖全局时长 |
| `updatedAt` | string | 落盘时间 |

文件缺失/损坏/`items` 为空 → 均视为"无配置"，前端走默认兜底。

## 后端接口

### 读（公开）
```
GET /api/playmode
```
返回整份对象；`items` 空或缺省字段补齐默认。磁盘读取 + 3 秒内存缓存。

### 写（受保护，与 /api/cli/* 同鉴权：`Authorization: Bearer <CLI_API_KEY|INTERNAL_API_KEY>`）
```
POST /api/playmode
Body: { radarDuration?, keepAlive?, items? }   // 全量替换
```
服务端校验（任一失败 → 400 + 具体错误信息）：
- `radarDuration`（若有）为 1–3600 数字；
- `keepAlive`（若有）为 ≥1 整数；
- `items`（若有）为数组；
- 每项：`type` ∈ class/image/url；`class` 的 `className` 必须存在于当前班级集合（缺失名单列出）；`image/url` 的 `url` 以 `http(s)://` 开头；`duration`（若有）1–3600；非法 `label` 忽略重写。
- 全量通过后：补充缺省字段、分配缺失 id、写盘、更新 `updatedAt`，返回最终清单（200）。

校验口径唯一收口在服务端；CLI 仅组装请求。

## CLI 子命令（`node cli.js playlist …`，沿用 CLI_API_BASE/CLI_API_KEY 远程调用）

采用"读当前 → 应用修改 → POST 全量"的 read-modify-write；并发写者极少（单显示屏场景），以全量 POST 保证原子性。

```
playlist list                     # 打印清单；班级项附带"将展开为 N 页(每页6人)"
playlist set-radar-duration <秒>  # 全局雷达页时长
playlist set-keep-alive <N>       # 网页保活上限
playlist add class --name 高一(1)班 [--at start|end|before:<id>|after:<id>] [--duration N]
playlist add image --url https://… [--label 名称] [--duration N] [--at …]
playlist add url   --url https://… [--label 名称] [--duration N] [--at …]
playlist set-duration <id> <秒>
playlist move <id> --to <序号|before:<id>|after:<id>|start|end>
playlist rm <id>
playlist clear                    # 清空 → 回默认全校
```

- 锚点缺省 `--at end`。
- `--to <序号>` 为 1-based 位置（移动后位置），与 `--at before/after` 可互换。
- 校验错误直接以服务端 400 信息提示（如班级名不存在）。

## 前端（frontend/src/App.jsx 播放模式）

### 数据与展开
进入播放模式时，沿用现有班级/成绩拉取逻辑（`initPlayMode`），并行 `GET /api/playmode`。将配置展开为扁平 slide 数组（存 state + ref 双份，供渲染与调度）：
- `class` → 每 6 人一页拆为雷达 slide；时长 = 该项 `duration ?? radarDuration`；
- `image` / `url` → 各一 slide；时长同上；
- 班级名不在已拉取统计集合 → 丢弃（一次性 console.warn）；
- 非法项（URL 非 http(s)、时长非法）→ 丢弃并告警；
- 展开结果为空 → 保留现有"暂无上周评分数据"兜底视图。

### 调度器
- 移除固定 8s `setInterval`，改为 **per-slide `setTimeout`（时长 = 当前 slide.duration）**；
- 到点 `index = (index+1) % slides.length` 循环；
- 定时器 id 存 ref；退出播放 / slides 变化时清理；避免闭包过期用 ref 读取当前时长；
- 保留原有退出按钮返回登录视图。

### 顶栏与角标
统一播放壳：左上返回；中间 `第X周 · {当前标题} · 播放 {k}/{total} · {当前时长}秒切换`。标题：雷达=班级名；image/url=`label || url 主机名`。图片/网页 slide 时顶栏可半透明悬浮（不占满交互区）。

### 图片 slide
- 进入播放模式时对所有 image URL `new Image()` 预载；
- 激活时整屏 `object-contain` 居中展示（配深色/现有背景）；
- 加载失败：占位图 + 按自身时长自动推进，不阻塞轮播。

### 网页 slide（iframe 保活池）
- url slide **首次激活**时创建 iframe 并加载（含 `referrerpolicy` 默认即可）；
- 切走后 `display:none` **保活不销毁** → 滚动/导航状态天然保留（跨源也无需读 scroll）；
- 保活数量超过 `keepAlive` 时按"最久未显示"LRU 卸载；
- **预热**：进入播放与每次切换前，若下一 slide 为未加载的 url，先建隐藏 iframe 加载；
- iframe 全屏（扣除悬浮角标），可交互（允许滚动/点按），不加 sandbox（信任管理员配置的 URL）；
- 退出播放：清定时器、卸载全部保活 iframe。

## 边界与错误处理

| 场景 | 行为 |
|---|---|
| playmode.json 缺失/损坏 | GET 返回默认（8s、空 items）；前端全校兜底 |
| 配置里班级不存在 | 写接口拒收并列出；历史脏数据前端丢弃+告警 |
| image URL 加载失败 | 占位 + 到点自动推进 |
| url 加载失败/超时 | iframe 显示浏览器错误页，保活不卸载，到点推进；冷启动有 8s 缓冲期避免误判 |
| keepAlive 设太小 | 仅影响回看滚动记忆，不影响播放 |
| 播放中清单被 CLI 更新 | 下次进入播放模式生效（本会话不热更新；不做轮询） |
| 全校都无上周数据 | 现有"暂无上周评分数据"兜底不变 |

## 非目标
- 不做雷达子页之间的页级锚点（数据每周漂移，班级块粒度已够）；
- 不做播放中热更新清单；
- 不做网页项的服务端快照/截图缓存；
- 不改动 Android APK 的独立构建产物（前端源码更新后，如需同步走既有"同步安卓"流程）。

## 验证清单
1. 后端：`node --check`；本地起服务后 `GET /api/playmode`（默认响应）；带 CLI_KEY `POST /api/playmode` 校验通过/失败分支。
2. CLI：playlist list / set-radar-duration / add / move / rm / clear 的读写正确；错误参数回显服务端信息。
3. 前端：`npm run build` 通过；播放模式无配置时行为不变；配置图片/网页后：图片预载秒开、网页可滚动、切走切回滚动位置保留、LRU 卸载、循环到尾回到第一 slide。
4. 回归：15s→8s 的改动并入 radarDuration 后，角标与切换频率跟随配置。
