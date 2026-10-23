# 主应用（vendor/agentlink-wechat 已预编译并提交到仓库，无需 git clone）
# Node 22：dsh cordis-plugin-loader 的 internal loader（bare specifier 按 profile 解析）
# 依赖 Node>=22 的 cascaded ESM loader API——Node 20 上插件解析退化为从 loader
# 自身位置 parent-walk，导致 dsh runtime 起不来
# 基础镜像走 DaoCloud 国内源：阿里云区域构建拉 Docker Hub 会被 429 限流
FROM docker.m.daocloud.io/library/node:22-alpine

WORKDIR /app

# 浏览器二进制统一由下方 apk chromium 提供（executablePath=wrapper），npm 依赖
# （playwright/patchright）的 postinstall 一律跳过浏览器下载——避免 glibc build
# 下载到 musl 容器（白耗镜像/时间）且无法使用。npm 统一走国内镜像（构建稳定）。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_registry=https://registry.npmmirror.com

# ---- 浏览器运行时层（放最前、尽量不变：Zeabur 镜像层缓存复用，代码/依赖变化
# 的部署不再重跑 apk 下载 chromium——避免每次重部署慢）。----
# 容器 root 下跑 chromium 必须 --no-sandbox，用 wrapper 作为 executablePath（playwright
# 可 spawn 任意可执行文件，自动追加自身参数）。构建期装好，运行时 AI 无需再下载。
# patchright driver 经 CDP 层消除自动化控制面检测（不依赖特定 chromium build），
# 与系统 chromium 兼容；注意：node:alpine 的 apk 源默认只有 main 仓库，
# chromium 在 community——需按版本显式重建 repositories 并启用两个仓库。
# chromium 的 apk 依赖树很大（182 包含 ffmpeg 系），单源下载一个卡死整构建——
# 配多源（官方 CDN 主 + 清华 TUNA 备）提高大包下载稳定性。
RUN VER=$(cut -d. -f1-2 /etc/alpine-release) \
 && printf 'https://dl-cdn.alpinelinux.org/alpine/v%s/main\nhttps://dl-cdn.alpinelinux.org/alpine/v%s/community\nhttps://mirrors.tuna.tsinghua.edu.cn/alpine/v%s/main\nhttps://mirrors.tuna.tsinghua.edu.cn/alpine/v%s/community\n' "$VER" "$VER" "$VER" "$VER" > /etc/apk/repositories \
 && apk add --no-cache chromium font-noto-cjk bash \
 && printf '%s\n' '#!/bin/sh' 'if [ -x /usr/bin/chromium-browser ]; then B=/usr/bin/chromium-browser; else B=/usr/bin/chromium; fi' 'exec "$B" --no-sandbox --disable-dev-shm-usage "$@"' > /usr/local/bin/dsh-chromium \
 && chmod +x /usr/local/bin/dsh-chromium
ENV DSH_BROWSER_EXECUTABLE=/usr/local/bin/dsh-chromium

# 复制并安装后端依赖
# - @agentlink/wechat 通过 file:./vendor/agentlink-wechat 解析（dist 已预编译入仓库）
# - steward-bridge / steward-jsonrpc-server 通过 file: 装入主 node_modules——
#   dsh runtime 的 cordis loader 解析插件包名的 parent-walk 锚点
COPY backend/package*.json ./backend/
COPY backend/agent/dsh/plugins ./backend/agent/dsh/plugins
# dsh 关键 peers（dsh-sdk-protocol/llm/session/…）随 lock 与默认 auto-install-peers 装齐；
# dsh-plugin-playwright 已声明为主依赖（loader 从主 node_modules 解析 include 插件）。
RUN cd backend && npm install --production

# 复制并安装前端依赖
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install --legacy-peer-deps

# 复制源代码（含已预编译的 backend/vendor/agentlink-wechat/dist）
COPY backend ./backend
COPY frontend ./frontend

# 构建前端
RUN cd frontend && npm run build

# 创建后端public目录并复制前端构建结果
RUN mkdir -p backend/public
RUN cp -r frontend/dist backend/public/

EXPOSE 3001

WORKDIR /app/backend
# 种子数据到持久化卷（首次部署时），然后启动服务
CMD ["sh", "-c", "node seed-data.js && node index.js"]
