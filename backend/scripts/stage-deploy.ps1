# stage-deploy.ps1 -- build a clean deployment staging dir for zeabur deploy
#
# Why: `zeabur deploy` uploads the whole working directory (git-tracked set),
# which includes APKs / android build outputs / research files (~57MB) and
# exceeds the free plan's 50MB upload limit. The Docker image only needs:
# root Dockerfile + backend code (vendor/plugins/stickers/data-*.js) + frontend src.
#
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File backend\scripts\stage-deploy.ps1
#   # then deploy from the staging dir:
#   zeabur deploy --project-id <pid> --service-id <sid> --name class-scoring-system --interactive=false
#
# What is intentionally NOT staged (lives on the persistent volume / runtime):
#   data/*.json（业务数据） apk/ uploads/ chart_images/ 会话与记忆目录、
#   dsh home 的 sessions/native-cache/storages（运行时可重建）
# What MUST be staged: data/*.js（adminContexts 等运行时代码，require 引用）；
#   wechat/stickers（表情包资产）、dsh home/profiles（SDK profile 模板）
#
# NOTE: robocopy /XD /XF 按名字全局匹配——data/wechat 不能用名字排除（会连带
# 排除 backend/wechat 代码目录），data 子目录的剔除放在第二跳（按源路径）做。

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent (Resolve-Path $MyInvocation.MyCommand.Path).Path
$root = Split-Path -Parent (Split-Path -Parent $scriptDir)   # scripts -> backend -> repo root
$stage = Join-Path $root '.deploy-stage'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$stage\backend", "$stage\frontend", "$stage\.zeabur" | Out-Null

# Root files
Copy-Item (Join-Path $root 'Dockerfile') $stage
if (Test-Path (Join-Path $root '.dockerignore')) { Copy-Item (Join-Path $root '.dockerignore') $stage }
Copy-Item (Join-Path $root '.zeabur\deploy.toml') "$stage\.zeabur\"

# 第一跳：backend 全部代码（只剔除全局安全的名字：node_modules 与 dsh 运行时可重建状态）
# 不排除 *.json —— package.json / package-lock.json / stickers/manifest.json / profile 都必须保留
robocopy (Join-Path $root 'backend') "$stage\backend" /E /NFL /NDL /NJH /NJS /NP /XD node_modules sessions native-cache storages /XF .cli.env .seed.lock *.log *.bak | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy backend failed: $LASTEXITCODE" }

# 第二跳：data 子目录剔除（体积大户/持久化卷数据）——按源路径单独 robocopy /MIR 清理
# 只删 staging 里多出来的 data 子目录与数据文件，保留第一跳带过去的 data/*.js 代码。
# 注意：checkin_records / wechat 不能整目录排除（里面有被 require 的 store.js 等代码），
# 其中的数据文件（*.json）由 /XF 兜底剔除。
$dataXd = 'apk', 'chart_images', 'uploads', 'conversation_memory',
          'agent_memories', 'agent_profiles', 'scores',
          'temp_download', 'temp_restore', 'example'
robocopy (Join-Path $root 'backend\data') "$stage\backend\data" /MIR /NFL /NDL /NJH /NJS /NP /XD $dataXd /XF *.json *.json.gz *.jsonl *.xlsx .seed.lock *.log *.bak | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy data failed: $LASTEXITCODE" }

# Frontend: source only (npm install + build happen inside the image)
robocopy (Join-Path $root 'frontend') "$stage\frontend" /E /NFL /NDL /NJH /NJS /NP /XD node_modules android dist | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy frontend failed: $LASTEXITCODE" }

# 关键资产断言（缺一个就中止，不部署坏镜像）
$must = @(
  'backend\index.js',
  'backend\package.json',
  'backend\package-lock.json',
  'backend\wechat\steward.js',
  'backend\wechat\geweChannel.js',
  'backend\wechat\stickers\manifest.json',
  'backend\wechat\stickers\overload.jpg',
  'backend\agent\dsh\personas\AGENTS.anaxis.md',
  'backend\agent\dsh\plugins\steward-bridge\index.mjs',
  'backend\agent\dsh\home\profiles\sdk\package.json',
  'backend\data\adminContexts.js',
  'backend\vendor\agentlink-wechat\dist',
  'frontend\package.json',
  'frontend\src',
  'Dockerfile',
  '.zeabur\deploy.toml'
)
$missing = $must | Where-Object { -not (Test-Path (Join-Path $stage $_)) }
if ($missing) { throw ("staging missing critical assets: " + ($missing -join ', ')) }

$size = (Get-ChildItem $stage -Recurse -File | Measure-Object -Sum Length).Sum
Write-Output ("staging dir ready: {0} ({1:N1} MB)" -f $stage, ($size/1MB))
