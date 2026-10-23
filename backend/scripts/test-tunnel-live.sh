#!/bin/bash
# =====================================================================
# test-tunnel-live.sh — 一键验证「tailnet + 手机 SOCKS5」链路（灵枢校园隧道）
# ---------------------------------------------------------------------
# 复刻超限会话里 AI 的验证流程：
#   0) 用持久化登录态拉起 tailscaled（重启后无需重新授权）
#   1) 打印 tailnet 状态 / 本节点 IP
#   2) 定位「在线、非本机」的手机节点（100.x）
#   3) curl 经手机 socks5 取出口 IP（与服务器直连出口对比判断是否走通）
#   4) 可选 --browser：用 netbrowse（chromium+playwright）经代理打开 URL，
#      验证浏览器侧也能走通（对应 browser_proxy 的落地效果）
#
# 用法(容器内 /backend/data 或镜像内均可用):
#   bash test-tunnel-live.sh [url] [--browser]
# 默认 url=https://icanhazip.com
# =====================================================================
set +e
BIN=/backend/data/overdrive/shared-cache/bin
TS="$BIN/tailscale"
STATE_DIR=/backend/data/overdrive/workspaces/612/tailscale
STATE="$STATE_DIR/tailscaled.state"
SOCK=/var/run/tailscale/tailscaled.sock
URL="${1:-https://icanhazip.com}"
BROWSER=0
for a in "$@"; do
  [ "$a" = "--browser" ] && BROWSER=1
done

echo "== 0) tailscaled 守护 =="
if [ ! -S "$SOCK" ] || ! pgrep -f tailscaled >/dev/null 2>&1; then
  echo "未运行，用持久化登录态拉起（$STATE）…"
  mkdir -p /var/run/tailscale "$STATE_DIR"
  nohup "$BIN/tailscaled" --tun=userspace-networking \
    --state="$STATE" --socket="$SOCK" \
    --socks5-server=127.0.0.1:1090 \
    > /tmp/ts-test.log 2>&1 < /dev/null &
  for i in $(seq 1 12); do
    [ -S "$SOCK" ] && break
    sleep 1
  done
fi
echo "sock=$SOCK 存在: $([ -S "$SOCK" ] && echo yes || echo no)"

echo
echo "== 1) tailnet 状态 =="
"$TS" status 2>&1 | head -8
SELF=$("$TS" ip -4 2>/dev/null | head -1)
echo "本节点 IP: $SELF"

echo
echo "== 2) 定位手机出口（在线、非本机 100.x）=="
PHONE=$("$TS" status 2>/dev/null | awk -v s="$SELF" \
  'NR>1 && $1 ~ /^100\./ && $1 != s && $0 !~ /offline/ { print $1; exit }')
if [ -z "$PHONE" ]; then
  echo ">> 未发现在线手机节点 —— 手机端（Tailscale + 代理/校园网）需先保持在线。"
  echo "在线节点："
  "$TS" status 2>&1 | grep -v offline | head -10
  exit 3
fi
echo "手机节点: $PHONE  代理入口 socks5h://$PHONE:1080"

echo
echo "== 3) 经手机代理出口检测 =="
DIRECT=$(curl -s --max-time 10 https://icanhazip.com 2>&1)
VIA=$(curl -s --max-time 25 --proxy "socks5h://$PHONE:1080" "$URL" 2>&1)
echo "服务器直连出口(对照): $DIRECT"
echo "经手机代理访问 $URL : $VIA"
if [ -n "$VIA" ] && [ "$VIA" != "$DIRECT" ]; then
  echo ">> OK：出口已从服务器切到手机所在网络"
else
  echo ">> 未走通：出口未变化或请求失败（检查手机代理是否监听 0.0.0.0:1080）"
fi

if [ "$BROWSER" = "1" ]; then
  echo
  echo "== 4) 浏览器(playwright/netbrowse)经代理 =="
  NETBROWSE_PROXY="socks5://$PHONE:1080" \
  node /backend/data/overdrive/shared-cache/netbrowse/netbrowse.js \
    goto "$URL" --wait 6000 --limit 300
fi

echo
echo "== 完成 =="
