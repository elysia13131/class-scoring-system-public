# 远程数据管理 CLI 使用教程

本文件面向 **AI 助手**(以及人类维护者),描述如何通过 `backend/cli.js` 命令行工具远程读取、修改、上传后端持久化卷 `/backend/data` 中的数据。

---

## 一、概述

`cli.js` 是一个独立的 Node.js 脚本,通过 HTTPS 调用后端的 `/api/cli/*` REST API,实现对生产环境数据的安全远程管理。

**典型场景**:用户把通报表格、体能成绩 Excel 等文件发给 AI 助手,AI 助手即可通过本 CLI 直接把数据上传/导入到 Zeabur 上的后端服务,无需人工介入。

**工作原理**:

```
AI 助手 ──调用──> node cli.js <command> ──HTTPS──> Zeabur 后端 /api/cli/* ──读写──> /backend/data 持久化卷
                      (本地)                  (Bearer CLI_API_KEY 鉴权)
```

---

## 二、配置

### 配置文件位置

CLI 启动时会按以下顺序加载 `.cli.env`:

1. 当前工作目录(`./.cli.env`)
2. CLI 脚本同目录(`backend/.cli.env`)← **推荐位置**
3. 上级目录(`../.cli.env`)

### 必填字段

```env
# 后端基础地址
CLI_API_BASE=https://your-domain.example.com

# 鉴权密钥(与 Zeabur 后端服务的 CLI_API_KEY 环境变量保持一致,自行填写,切勿提交)
CLI_API_KEY=<your-cli-api-key>
```

> ⚠️ `.cli.env` 已在 `.gitignore` 中,**切勿提交到 GitHub**。

### 当前已部署的环境

| 项 | 值 |
|---|---|
| Zeabur 项目 | `untitled-3` |
| 服务名 | `class-scoring-system` |
| 域名 | `https://your-domain.example.com` |
| 持久化卷路径 | `/backend/data` |

---

## 三、命令清单

所有命令都通过 `node backend/cli.js <command> [args] [options]` 调用。

### `ping` — 测试连接

验证 API Key 与后端连通性。

```bash
node backend/cli.js ping
```

返回示例:
```json
{
  "ok": true,
  "time": "2026-07-04T18:15:22.476Z",
  "dataDir": "/backend/data",
  "files": 37
}
```

---

### `week` — 读取后端当前周次

读取后端当前周次,**数据上传/导入前先执行此命令确定周次**,避免本地与服务器时间不一致导致数据写错周次或月份。

```bash
node backend/cli.js week
```

返回示例:
```
当前周次: 第 18 周
起始日期: 2026-03-02T00:00:00+08:00
```

**用途**:
- 确定 `import bmi --week=YYYY-WW` 的周次参数
- 确定 `import fitness/academic --month=YYYY-MM` 的月份参数
- 校验 `import weekly-report` 的 weekRange 是否与当前周次相符

> 周次由后端 `config.startDate`(默认 `2026-03-02`)按 7 天一周计算,可通过 `config.currentWeek` 手动覆盖。

---

### `list [dir]` — 列出数据目录文件

列出持久化卷根目录或指定子目录下的所有文件。

```bash
node backend/cli.js list              # 列出根目录
node backend/cli.js list scores       # 列出 scores/ 子目录
node backend/cli.js list uploads      # 列出 uploads/ 子目录
```

返回示例:
```json
{
  "base": "scores",
  "count": 18,
  "files": [
    { "path": "scores_week_1.json.gz", "type": "file", "size": 56830, "mtime": 1782843752688 },
    ...
  ]
}
```

> 子目录递归深度为 2 层,深层目录只显示目录名不展开。

---

### `read <path>` — 读取文件内容

读取持久化卷上的文件。**自动识别并处理**:
- `.json` → 解析为对象返回
- `.json.gz` → gunzip 解压后解析为对象返回
- 其他文本文件 → UTF-8 字符串返回
- 二进制文件 → base64 编码返回

```bash
node backend/cli.js read members.json
node backend/cli.js read scores/scores_week_18.json.gz
node backend/cli.js read config.json
node backend/cli.js read notices.json
```

返回示例(json.gz 自动解压):
```json
{
  "path": "scores/scores_week_18.json.gz",
  "size": 1529,
  "encoding": "gzip-json",
  "content": [ { "week": 18, "memberId": "312", "scores": {...} }, ... ]
}
```

单文件大小限制 20MB。

---

### `write <path> <content|--stdin> [--raw] [--merge|--append]` — 写入文件

支持三种写入模式:

| 模式 | 命令参数 | 行为 |
|---|---|---|
| **覆盖**(默认) | `write <path> <content>` | 整文件覆盖,原文件备份为 `.bak` |
| **合并** | `write <path> <content> --merge` | JSON 深合并(对象递归合并/数组按 key 去重合并) |
| **追加** | `write <path> <content> --append` | 数组末尾追加(不去重)/文本末尾追加 |

**`--merge` 合并规则**:
- 对象 → 深合并(递归合并嵌套对象和数组,同名顶层字段覆盖)
- 对象数组 → 按 `id`/`memberId`/`month`/`key`/`adminId` 字段去重合并(同 key 覆盖,新 key 追加)
- 基础类型数组 → union 去重(如 `memberIds`)

**自动处理**:
- 默认尝试把 `content` 解析为 JSON,非合法 JSON 时按纯文本写入
- `--raw` 强制按纯文本写入
- `.json.gz` 结尾时自动 gzip 压缩
- **自动备份**:文件已存在时,先把原文件复制为 `.bak`

```bash
# 1. 默认覆盖
node backend/cli.js write notices.json '{"msg":"今日通报","date":"2026-07-04"}'

# 2. 通过 stdin 写入
echo '{"a":1}' | node backend/cli.js write test.json --stdin

# 3. --merge 合并(在原对象上新增字段,其他字段保留)
node backend/cli.js write update_notices.json '{"contact":"新联系方式"}' --merge

# 4. --merge 数组合并(duties.json 加一条,同 id 覆盖,新 id 追加)
node backend/cli.js write duties.json '{"id":"new-001","content":"清洁"}' --merge

# 5. --append 数组追加(不去重,适合日志)
node backend/cli.js write daily_log.json '{"event":"重启"}' --append

# 6. --append 文本追加
node backend/cli.js write notes.txt "新的一行" --raw --append

# 7. 写入 .json.gz(自动压缩)
node backend/cli.js write scores/custom.json.gz '{"week":99,"data":[]}'
```

返回示例:
```json
{ "success": true, "path": "notices.json", "size": 65, "mtime": 1783161223456, "mode": "merge" }
```

---

### `upload <localFile> <remotePath>` — 上传二进制文件

通过 multipart 上传任意二进制文件到指定远程路径。适合上传 Excel、图片、APK 等。

```bash
node backend/cli.js upload ./report.xlsx reports/2026-07.xlsx
node backend/cli.js upload ./image.jpg uploads/custom-name.jpg
```

> `remotePath` 是相对 `/backend/data` 的路径,可省略(默认用本地文件名)。

---

### `delete <path>` — 删除文件

删除指定文件。**自动备份为 `.bak`**(便于误删恢复)。

```bash
node backend/cli.js delete test.json
```

返回示例:
```json
{ "success": true, "path": "test.json", "backup": "test.json.bak" }
```

> 不能删除目录。`.bak` 备份不会自动清理,需要时可用 `delete` 再删一次。

---

### `import <type> <localFile> [--month=YYYY-MM|--week=N]` — 导入 Excel

复用后端现有的成绩导入 API,自动解析 Excel 并写入对应数据文件。

| `type` | 对应端点 | 用途 | 参数 |
|---|---|---|---|
| `fitness` | `/api/upload/fitness-scores` | 体能成绩 | `--month=YYYY-MM` |
| `academic` | `/api/upload/academic-scores` | 学业成绩 | `--month=YYYY-MM` |
| `rank` | `/api/upload/rank-scores` | 军事体育成绩 | 无 |
| `bmi` | `/api/upload/bmi-scores` | BMI 数据 | `--week=N`(纯数字周次,必填,如 `--week=17`) |
| `weekly-report` | `/api/weekly-reports/upload` | 周量化扣分通报 | 无(weekRange 从 Excel 第 0 行读取) |

```bash
# 体能/学业(按月份合并)
node backend/cli.js import fitness ./体能成绩.xlsx --month=2026-07
node backend/cli.js import academic ./学业成绩.xlsx --month=2026-07

# 军体成绩(无需参数)
node backend/cli.js import rank ./军体成绩.xlsx

# BMI(按周次合并,必填 week,纯数字周次)
node backend/cli.js import bmi ./BMI数据.xlsx --week=17

# 周量化扣分通报(自动从 Excel 第 0 行读取周次)
node backend/cli.js import weekly-report ./2026.6.8—6.14量化.xlsx
```

**合并逻辑**(后端实现,安全):
- **fitness/academic**:按姓名匹配 members.json,定位成员 history 数组,**只覆盖 month 匹配的记录**,其他月份保留
- **rank**:整体替换 rank_scores.json
- **bmi**:按 week 合并到 bmi_scores.json,**只更新指定周次**,其他周保留
- **weekly-report**:按 Excel 第 0 行 weekRange 合并,**同 weekRange 覆盖,不同 weekRange 保留**;自动提取多姓名(空格/顿号分隔)、模糊匹配一字之差、按 `/人` 判断每人扣分、生成 reportText 和 memberScores

返回示例:
```json
{
  "success": true,
  "message": "通报导入成功,共 15 条记录,涉及 43 人,自动纠正 1 个错别名字",
  "weekRange": "2026.6.8—6.14",
  "itemCount": 15,
  "memberCount": 43,
  "reportText": "...",
  "memberScores": { "104": { "memberId": "104", "name": "樊宇博", "score": 81, "items": [...] } },
  "fuzzyMatches": [{ "original": "杨振箔", "resolved": "杨镇箔", "memberId": "709" }]
}
```

---

### `api <method> <path> [jsonBody]` — 调用任意后端 API

直接发起 HTTP 请求到后端任意 API,**自动带上 Bearer 鉴权头**。用于 CLI 未单独封装的接口。

```bash
# GET 请求
node backend/cli.js api GET /api/members
node backend/cli.js api GET /api/admin/reports

# POST 请求(JSON body 作为第三参数)
node backend/cli.js api POST /api/admin/verify-password '{"password":"123456"}'
node backend/cli.js api POST /api/agent/chat '{"memberId":"admin","message":"你好"}'
```

返回示例:
```
HTTP 200
{ ...响应体... }
```

---

### `help` — 查看帮助

```bash
node backend/cli.js help
```

---

## 四、AI 使用场景示例

### 场景 1:用户发了通报表格,要求更新到系统

```bash
# 1. 确认连接
node backend/cli.js ping

# 2. 用户提供的文件假设保存为 ./通报.xlsx
#    先看一下当前 notices.json 结构
node backend/cli.js read notices.json

# 3. 把 Excel 转 JSON 后写入(或者直接当文件存档)
node backend/cli.js upload ./通报.xlsx reports/2026-07-通报.xlsx

# 4. 如果需要更新 notices.json(假设是 {items:[...]} 结构)
node backend/cli.js write notices.json '{"items":["2026-07-04 训练通报","2026-07-05 内务通报"]}'
```

### 场景 2:用户发了体能成绩 Excel,要求导入

```bash
# 1. 确认连接
node backend/cli.js ping

# 2. 读取后端当前周次(确定月份参数,避免时间错误)
node backend/cli.js week

# 3. 导入到 fitness scores(自动解析 Excel)
node backend/cli.js import fitness ./体能成绩.xlsx --month=2026-07

# 4. 验证:读取最新数据
node backend/cli.js read fitness_scores.json
```

### 场景 3:用户要求查看某周评分

```bash
# 直接读取 json.gz(CLI 自动解压)
node backend/cli.js read scores/scores_week_18.json.gz
```

### 场景 4:用户要求修改某条数据

```bash
# 1. 先读取当前内容
node backend/cli.js read member_states.json

# 2. 在 AI 助手中根据用户意图修改 JSON(本地处理)

# 3. 写回(原文件自动备份为 member_states.json.bak)
node backend/cli.js write member_states.json '{"...修改后的内容..."}'
```

### 场景 5:用户发了一张图片要求存档

```bash
node backend/cli.js upload ./照片.jpg uploads/2026-07-04-活动照片.jpg
```

---

## 五、AI 调用注意事项

### 1. 数据修改前先读后写

修改任何数据文件前,**先 `read` 拿到当前内容**,在本地基于实际结构修改,再 `write` 写回。**不要凭空构造 JSON 结构**,否则可能破坏数据格式。

### 2. 自动备份机制

`write` 和 `delete` 会自动生成 `.bak` 备份。如果误操作,可以通过:

```bash
node backend/cli.js read <file>.bak       # 读取备份
node backend/cli.js write <file> '<备份内容>'  # 恢复
```

### 3. 路径安全

所有路径都是**相对 `/backend/data` 的路径**,自动拒绝包含 `..` 的路径穿越攻击。例如:
- ✅ `notices.json`
- ✅ `scores/scores_week_18.json.gz`
- ❌ `../etc/passwd`(会被拒绝)
- ❌ `/etc/passwd`(会被拒绝)

### 4. 大文件限制

- `read` 单文件限制 20MB,超过请用 `upload` 或拆分
- `write` 无硬限制,但建议单次 < 5MB

### 5. Excel 导入失败排查

`import` 命令依赖后端 `/api/upload/*-scores` 端点,如果 Excel 列名、成员姓名对不上后端 `members.json`,会返回部分成功的统计信息,需要仔细看返回的 `notFoundMembers` / `skippedNames` 字段。

### 6. 路径分隔符

CLI 内部统一用 POSIX 风格 `/`,Windows 上传文件时本地路径用 `\` 或 `/` 都可以,远程路径用 `/`。

---

## 六、安全提醒

1. **`CLI_API_KEY` 是访问生产数据的唯一凭证**,请勿在聊天中明文展示、提交到 git、或写入前端代码
2. `.cli.env` 已被 `.gitignore` 排除,不要手动 `git add -f`
3. 如需轮换密钥:在 Zeabur 控制台修改 `CLI_API_KEY` 环境变量,同时更新本地 `.cli.env`,重启服务即可
4. 所有写操作都会生成 `.bak` 备份,但 `.bak` 不会自动清理,长期运行需要定期清理

---

## 七、故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `错误: ping 失败 (401)` | API Key 不匹配 | 检查 `.cli.env` 的 `CLI_API_KEY` 与 Zeabur 环境变量是否一致 |
| `错误: fetch failed` | 网络或域名问题 | 检查 `CLI_API_BASE` 是否正确,网络是否能访问 |
| `错误: 文件不存在` | 路径写错 | 先 `list` 看实际文件名 |
| `错误: 非法路径` | 路径含 `..` 或绝对路径 | 使用相对路径,如 `scores/xxx.json.gz` |
| Zeabur 部署后 CLI 失效 | 部署时未注入 `CLI_API_KEY` | 在 Zeabur 服务 Variables 标签添加环境变量 |

---

## 八、快速参考表

| 想做的事 | 命令 |
|---|---|
| 测试连接 | `node backend/cli.js ping` |
| 查看后端当前周次 | `node backend/cli.js week` |
| 看有哪些数据文件 | `node backend/cli.js list` |
| 读 JSON / JSON.GZ | `node backend/cli.js read <path>` |
| 写 JSON | `node backend/cli.js write <path> '<json>'` |
| 上传二进制文件 | `node backend/cli.js upload <local> <remote>` |
| 删除文件 | `node backend/cli.js delete <path>` |
| 导入体能成绩 Excel | `node backend/cli.js import fitness <xlsx> --month=YYYY-MM` |
| 导入 BMI 数据 Excel | `node backend/cli.js import bmi <xlsx> --week=17` |
| 调用任意 API | `node backend/cli.js api <METHOD> <path> [body]` |
| 查看帮助 | `node backend/cli.js help` |
