# 班级评分系统 · Class Scoring System

面向班级的**六维周评分与成长记录平台**：网页、安卓 App、大屏播放和微信 AI 管家共用同一套数据，评分、成绩、日程、心理关注和通知都收在一个后端里。

- 前端：React 18 + Vite + Tailwind + ECharts + Socket.IO
- 后端：Node.js 22 + Express + Socket.IO
- AI：DeepSeek `dsh` 引擎（每个成员独立会话与记忆）
- 部署：Docker + Zeabur（GitHub 推送自动构建）

---

## 仓库与部署

| 用途 | 仓库 | 说明 |
|---|---|---|
| **部署源** | [`elysia13131/class-scoring-system`](https://github.com/elysia13131/class-scoring-system)（私有） | 唯一部署仓库。推送到 `master` 即触发 Zeabur 自动构建，生产数据存放在 Zeabur 持久化卷。 |
| 公开快照 | [`elysia13131/class-scoring-system-public`](https://github.com/elysia13131/class-scoring-system-public)（公开） | 从部署仓库导出的单次快照，无历史提交，仅用于展示与阅读代码；**不接入 Zeabur，不参与部署**。 |

日常开发一律提交到私有部署仓库；需要对外展示时，再从该仓库导出一份清理过敏感信息的快照推到公开仓库。

---

## 功能

### 评分与统计

- **六维评分**：学习成绩、管理能力、体能素质、人文素养、遵章守纪、班级贡献，自评 + 他评各占一半
- **周次自动推算**：按学期起始日期计算第 N 周，无需手填
- **多学期模型**：每个学期独立的周次起点，可新增、删除、切换，历史数据按学期归档
- **图表**：个人六维雷达图（含上周对比）、班级周汇总、熵权法权重
- **补评与异常**：补评周期、未评分成员提示、连续评分对比、重复评分校验
- **成绩导入**：体能、学业、军事体育、BMI、周量化通报等 Excel 批量入库

### 成员与班级

- 免注册登录，选择姓名进入；敏感操作需管理员 / 成员密码
- 成员档案、文件管理、伤病状态、值日排班、经历记录
- 通知与公告、审批流、日程提醒
- 心理关注：预警、周报、社交地图

### 大屏播放模式

- 雷达图、图片、网页三类帧轮播，可按班级、时长、顺序编排
- 适用于教室大屏 / 活动展示

### AI 管家 Anaxis（灵枢）

- 基于 DeepSeek `dsh` 引擎，每个成员一个稳定 session，带长期记忆
- 工具桥覆盖：评分查询与提交、成绩、日程、打卡、通知、文件、心理、生图、生歌
- 主动消息：每日一问、日程提醒、绑定欢迎、审批转达
- 微信接入：GeWe 协议，`绑定 姓名 密码` 绑定账号，支持私聊、群聊 @、引用、合并转发、表情包、语音

### 客户端

- PWA + Web Push / 极光推送
- Android APK 内置自动更新（按 `versionCode` 比较）
- 语音条（silk）、图片压缩、文档导出等媒体处理

---

## 目录结构

```
.
├── backend/                 # Express 服务、AI 引擎、微信管家
│   ├── index.js             # 主入口与全部 REST 路由
│   ├── agent/               # dsh 引擎、记忆、工具、推送
│   ├── wechat/              # 微信管家（GeWe）
│   ├── utils/               # 北京时间、数据路径、学期、导出等
│   ├── routes/              # 独立路由模块
│   ├── scripts/             # 运维与测试脚本
│   └── data/                # 运行时数据（本地开发）
├── frontend/                # React 前端
│   ├── src/App.jsx          # 主界面（登录 / 评分 / 主页 / 播放 / AI）
│   └── android/             # Capacitor 安卓工程
├── Dockerfile
└── .zeabur/deploy.toml
```

---

## 本地运行

需要 Node.js >= 22。

```bash
# 后端（默认 3001）
cd backend
npm install
npm start

# 前端（开发模式，默认 5174，已代理 /api 与 /socket.io 到 3001）
cd frontend
npm install
npm run dev
```

生产构建：

```bash
cd frontend && npm run build   # 产物在 frontend/dist
```

---

## 数据与配置

运行时数据默认位于 `backend/data`，生产环境使用持久化卷 `/backend/data`。
`backend/data` 中的 `*.json` 为业务数据，`*.js` 为被代码 `require` 的运行时代码，两者都在部署包中区别对待。

主要配置文件 `config.json`：

| 字段 | 说明 |
|---|---|
| `startDate` | 旧的全局学期起点（兼容保留） |
| `semesters` | 学期列表，每项含 `id` / `name` / `startDate` |
| `currentSemesterId` | 当前学期 |
| `currentWeek` | 当前周次（手动覆盖时使用） |

常用环境变量：

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口，默认 3001 |
| `CLI_API_KEY` | 远程数据管理 CLI 的鉴权密钥 |
| `INTERNAL_API_KEY` | 服务内部调用鉴权（未设置时随机生成） |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | AI 模型 |
| `DSH_ENGINE` | 设为 `1` 启用 dsh 引擎 |
| `DSH_ADMIN_IDS` | 具备多会话权限的成员 ID，逗号分隔 |
| `STEWARD_ENABLED` | 设为 `1` 启用微信管家 |
| `GEWE_TOKEN` / `GEWE_APP_ID` / `GEWE_AID` | GeWe 账号与本地代理编号 |
| `GEWE_CALLBACK_URL` | 微信回调地址 |
| `AGNES_API_KEY` | 生图 / 生视频（可选） |

> 所有时间逻辑统一按北京时间（UTC+8）处理。

---

## 部署

唯一的部署源是私有仓库 `elysia13131/class-scoring-system` 的 `master` 分支——Zeabur 已关联该仓库，推送到 `master` 即自动构建部署。公开快照仓库不接入 Zeabur。

项目自带 `Dockerfile`，新环境部署时：

1. 新建服务并关联上述私有仓库
2. 添加持久化卷，挂载路径 `/backend/data`
3. 按需配置上表环境变量
4. 绑定域名

容器启动时会先执行 `node seed-data.js` 补齐种子数据，再启动服务。

---

## 远程数据 CLI

`backend/cli.js` 通过 `/api/cli/*` 远程读写生产数据卷，适合批量导入与运维。

```bash
node backend/cli.js ping                 # 连通性
node backend/cli.js week                 # 当前周次
node backend/cli.js list scores          # 列目录
node backend/cli.js read config.json     # 读文件（自动解压 .json.gz）
node backend/cli.js write notices.json '{...}' --merge
node backend/cli.js upload ./a.xlsx reports/a.xlsx
node backend/cli.js import fitness ./体能.xlsx --month=2026-10
```

凭据放在 `backend/.cli.env`（`CLI_API_BASE` + `CLI_API_KEY`），该文件不入库。详见 [backend/CLI.md](backend/CLI.md)。

---

## 发布 Android APK

```bash
# 1. 改版本号
#    frontend/android/app/build.gradle: versionCode / versionName
# 2. 构建并同步
cd frontend
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
# 3. 产物：frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

发布到线上：上传为 `apk/app-update.apk` 并更新 `apk_version.json`（`version` / `versionCode` / `releaseNotes` / `fileSize`），App 通过 `/api/apk/check-update` 检查更新。

---

## 安全说明

- 仓库历史中包含早期示例上传文件与 AI 记忆样例，仅用于开发演示
- 生产凭据（`.cli.env`、`config.json` 中的密码哈希等）不随代码发布
- 评分、文件网关、成员操作等敏感接口均校验身份与密码
