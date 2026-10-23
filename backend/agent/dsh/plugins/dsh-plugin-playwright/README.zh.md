# dsh-plugin-playwright

面向 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 Playwright 浏览器自动化工具。

本插件把一组 `browser_*` 工具注册到 Harness 的工具注册表上，通过真实启动的 Chromium / Firefox / WebKit 浏览器，让智能体能够：导航页面、与元素交互、读取可达性树、抓取文件、管理会话——全部通过结构化的工具调用完成。

> **设计说明：** 本代码库是一个独立的 DSH 插件，按**用户意图**来组织（导航 / 交互 / 观察 / 控制 / 捕获 / PowerShell），而不是照搬某个 Playwright 移植版的分层。它借鉴了 Playwright 工具生态中广泛使用的浏览器自动化思路，但实现是自有的。

---

## 目录

- [安装](#安装)
- [快速上手](#快速上手)
- [配置](#配置)
- [工具目录](#工具目录)
- [架构](#架构)
- [开发](#开发)
- [差异说明](#差异说明)

---

## 安装

把插件加入 DSH 配置并激活：

```sh
# 把插件加入 `web` profile（dsh plugin 会把参数转发到 profile 目录里的 pnpm）
dsh plugin --profile web add dsh-plugin-playwright
```

由于浏览器是宿主环境的真实二进制，你需要一个真实的浏览器引擎。Playwright 会在首次启动时下载它托管的构建（`npx playwright install chromium`）；或者通过 `executablePath` 指定一个已安装的浏览器（见 [配置](#配置)）。

## 快速上手

激活后，代理可以这样驱动页面：

1. **感知** —— `browser_snapshot` 返回带数值 ref 的可访问性树。
2. **导航** —— `browser_navigate { "url": "https://example.com" }`。
3. **操作** —— `browser_click { "ref": 4 }` 或 `browser_type { "selector": "#q", "text": "hello" }`。
4. **观察** —— `browser_console_messages` / `browser_network_requests`。
5. **输出** —— `browser_screenshot` 在输出目录下保存 PNG。

浏览器在第一次调用工具时才懒启动，并在插件 fiber 卸载时关闭。

---

## 配置

配置通过 `src/config.ts` 中的 schema 声明。默认配置（`cordis.patch.yml`）默认无头运行、范围谨慎。常用配置项：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `browser` | `chromium` | 引擎：`firefox` / `webkit` / `msedge`（msedge = chromium + msedge channel） |
| `headless` | `true` | 无可见窗口 |
| `executablePath` | — | 用该浏览器二进制代替 Playwright 托管的构建；优先于 `channel` |
| `userDataDir` | — | 持久配置文件目录（仅 chromium/msedge）；cookies/localStorage 跨重启保留 |
| `isolated` | `false` | 为 true 时，每次调用使用全新的 context 并在调用结束时关闭（调用之间无状态） |
| `viewport` | `1280×720` | 初始视口 |
| `device` / `locale` / `timezoneId` / `colorScheme` | — | 设备描述符 / locale / IANA 时区 / 配色方案 |
| `outputDir` | `.dsh/playwright` | 截图 / PDF / 跟踪的写入目录 |
| `timeoutMs` | `30000` | 默认单操作超时 |
| `navigationWaitUntil` | `load` | 导航的默认等待条件 |
| `capabilities` | 见下表 | 逐能力开关 |
| `evaluate` | `false` | 启用 `browser_evaluate` 逃生舱（默认关闭） |

### capabilities

用于整体关闭某些工具或从结果中剥离数据：

```yaml
capabilities:
  accessibility: true   # 在有状态的结果上附带快照
  screenshot: true      # 注册 browser_screenshot
  pdf: true             # 注册 browser_pdf（chromium/msedge）
  network: true         # 注册 browser_network_requests 并捕获网络
  tracing: false        # 注册 browser_tracing_start/stop
  storageState: false   # 注册 browser_storage_state 与 browser_init_script
```

---

## 工具目录

工具按行为模块组织（见 [架构](#架构)）。所有工具的名称、参数和输出都是稳定契约。

### navigation —— 移动 / 等待页面

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 加载 URL 并等待；返回 URL + 标题 + 快照 |
| `browser_back` / `browser_forward` | 历史前进/后退 |
| `browser_reload` | 重载当前页面 |
| `browser_wait_for` | 等待某个 CSS 选择器达到指定状态 |

### interact —— 修改页面

| 工具 | 作用 |
|---|---|
| `browser_click` | 按 ref 或 CSS 选择器点击（支持按钮/修饰键/次数） |
| `browser_type` | 填充 input/textarea（默认清空），或不清空地输入 |
| `browser_type_submit` | 输入后按 Enter（表单、搜索框） |
| `browser_select_option` | 按 value/label 选择 `<select>` 选项 |
| `browser_hover` / `browser_focus` | 悬浮 / 聚焦一个元素 |
| `browser_press_key` | 在元素或页面上按键 / 快捷键 |
| `browser_drag` | 把元素拖到另一个元素上 |
| `browser_upload_file` | 向 `<input type=file>` 设置文件 |

### inspect —— 读取页面状态

| 工具 | 作用 |
|---|---|
| `browser_snapshot` | 可访问性树，含交互元素的数值 ref |
| `browser_console_messages` | 抓到的控制台消息（环形缓冲） |
| `browser_network_requests` | 抓到的请求/响应条目，可按 URL/状态筛选 |

### control —— 操作会话

| 工具 | 作用 |
|---|---|
| `browser_tab_new` / `browser_tab_switch` / `browser_tab_close` / `browser_tab_list` | 标签页生命周期 |
| `browser_resize` | 调整当前视口尺寸 |
| `browser_init_script` *(能力)* | 注册一个在每次页面加载前运行的脚本 |
| `browser_storage_state` *(能力)* | 返回共享 context 的 cookies + localStorage |

### capture —— 产出文件

| 工具 | 作用 |
|---|---|
| `browser_screenshot` *(能力)* | 在输出目录下保存截图 |
| `browser_pdf` *(能力)* | 打印成 PDF（chromium/msedge） |
| `browser_tracing_start` / `browser_tracing_stop` *(能力)* | 开始/结束跟踪并写出 trace zip |

### power —— 逃生舱

| 工具 | 作用 |
|---|---|
| `browser_evaluate` *(配置 `evaluate`)* | 在页面里执行任意 JS（可读可写；默认关闭） |

---

## 架构

```
src/
├── index.ts          装配：注册工具 + 拥有浏览器生命周期
├── config.ts         配置 schema + 默认值
├── browser.ts        BrowserSession, CallHandle, withAbort（懒启动，共享/隔离）
├── snapshot.ts       ariaSnapshot → JSON 树 + ref→locator 映射
└── tools/
    ├── schema.ts     共享值契约（state / tab / file 结果）
    ├── util.ts       跨模块助手（pageState, resolveLocator, abortable, …）
    ├── factory.ts     createTools(session, config) —— 装配所有行为模块
    └── …              每个模块拥有一个行为组
```

每个工具的 `execute(body)` 都会经由 `session.run` 执行，它会解析出一个 `CallHandle`——默认是共享持久 context，隔离模式下则是调用结束即关闭的一次性 context。取消信号（`AbortSignal`）通过 `withAbort` 桥接到 Playwright 操作上。

---

## 开发

```bash
pnpm install        # 安装依赖
pnpm typecheck      # 对 src + test 运行 tsc
pnpm smoke          # 挂载插件并用真实的 headless chromium 驱动一次
```

维护者视角的代码地图与「如何新增工具」的约定，见 [`AGENTS.md`](./AGENTS.md)。

---

## 差异说明

本插件是一个独立的 DSH 实现。几个值得注意的设计点：

- **按用户意图组织。** 文件按 *导航 / 交互 / 观察 / 控制 / 输出 / 逃生舱* 分组，而不是照搬某个冲动的上游 API 表面。
- **会话模型。** 每个插件实例持有一个懒启动的共享浏览器；`isolated` 提供逐调用透明性。默认共享状态跨调用保留。
- **可取消。** 工具操作可通过 harness 信号中止，而不是「发后不管」。
- **契约驱动。** 每个工具都定义一套 canonical JSON 值 + 独立的模型面 `render` 投影，并通过 harness 的 lossless-JSON 校验。
- **`browser_evaluate` 默认关闭。** 允许任意 JS 的逃生舱默认关闭，除非你显式开启。