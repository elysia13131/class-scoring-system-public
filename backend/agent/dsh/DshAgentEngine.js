/**
 * DshAgentEngine —— DeepSeek Harness (dsh) 底座引擎
 *
 * 打包进已有后端的方式（CJS 后端 ↔ ESM SDK）：
 *   1. npm 安装官方 SDK：@deepseek-ai/dsh-sdk-client（锁精确版本，rc 版有破坏性变更）
 *   2. CJS 侧动态加载：await import('@deepseek-ai/dsh-sdk-client')
 *   3. SDK 拉起 dsh runtime 子进程（JSON-RPC 通信），一个子进程跨多 session
 *   4. 每成员一个稳定 session：member-{memberId}（上下文由 dsh session 维护）
 *   5. 工具桥：dsh 插件（workspace/.agents/）HTTP 回环调用后端现有 REST API
 *
 * 兼容现有 AgentEngine 接口（StewardManager/index.js 零改动切换）：
 *   processMessageStreamWithCallback / isProcessing / injectUserMessage / verifyAdmin
 *
 * dsh 增量能力（旧引擎没有）：
 *   processProactiveMessage —— AI 主动消息（每日一问/日程通知/绑定欢迎），
 *     系统事件指令进入 session 上下文，AI 以人设口吻生成转达内容
 *   injectSystemEvent —— 静默系统事件（App 打卡等外部事件），随下一条
 *     消息前缀送入 session，让 AI 知晓、不触发回复
 *
 * 权限三闸（virtual-real 安全模型）：
 *   闸1 pre-execute：dsh 插件 tools guard（敏感工具强制 password 参数）
 *   闸2 传输层：HTTP 回环带 X-Internal-Auth（复用 CLI_API_KEY）
 *   闸3 post-execute：后端 API 原有校验（memberId 权限 + 管理员密码）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { getDataPath, getDataDir } = require('../../utils/dataPath');
const { beijingNow } = require('../../utils/beijingTime');
const { repairSessionLog, sanitizeSessionLog, analyzeSessionLog } = require('./sessionLogRepair');
const ordinaryUsers = require('../../data/ordinaryUsers');

const DSH_MODEL = process.env.DSH_MODEL || 'deepseek-v4-flash-vision-exp'; // 默认 vision 变体（文本图片通吃）
const DSH_PROVIDER = process.env.DSH_PROVIDER || 'deepseek-official';  // SDK 内置 provider
const INTERNAL_AUTH = process.env.CLI_API_KEY || process.env.INTERNAL_API_KEY || '';
const PORT = process.env.PORT || 3001;

// dsh runtime 工作目录（含 .agents/ 插件；会话日志也落这里）
// 超限模式：worker 子进程注入 DSH_ENGINE_WORKSPACE/DSH_ENGINE_HOME_DIR →
// 独立工作区与 home（互不共享会话/插件/浏览器缓存）。
const WORKSPACE = process.env.DSH_ENGINE_WORKSPACE || path.join(__dirname, 'workspace');
// dsh HOME（默认 ~/.dsh，重定向到项目内：沙箱/部署友好）
const HOME_DIR = process.env.DSH_ENGINE_HOME_DIR || path.join(__dirname, 'home');
// node-addon native loader 缓存（默认 %LOCALAPPDATA%，重定向到项目内）
const NATIVE_CACHE = path.join(HOME_DIR, 'native-cache');
// 普通（非超限）会话的单轮「静默看门狗」：超限那层有 OverdriveManager 看门狗，普通
// 引擎没有——一旦某轮卡住（工具不返回/runtime 静默/agent 半死），_processingMembers
// 会永久占位，该成员此后只被 inject 不再开新轮 → 从此不应答，只能重启容器。这里给
// 整轮兜一个静默上限：轮内任何通知都算活着并续期，连续静默超阈值才取消并重启 runtime。
const TURN_WATCHDOG_MS = Math.max(60000, Number(process.env.DSH_TURN_TIMEOUT_MS || 15 * 60 * 1000));

/** 递归镜像目录（跳过 node_modules/.git 等），用于 file: 依赖"复制快照"的启动同步 */
function syncTree(src, dst, skip = ['node_modules', '.git']) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip.includes(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      syncTree(s, d, skip);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

class DshAgentEngine {
  constructor(config = {}) {
    this.config = config;
    this.available = false;          // SDK 是否成功加载
    this.harness = null;             // DeepSeekHarness 实例（跨成员共享一个子进程）
    this._sdk = null;                // SDK 模块
    this._processingMembers = new Set();
    this._pendingInjections = new Map();
    this._prompts = new Map();       // memberId → 系统提示（首条注入）
    this._pendingEvents = new Map(); // memberId → 待注入的静默系统事件（随下一条消息送入）
    this._initializing = null;
    this._bootId = null;             // 进程生命周期标识（隔离模式 session id 后缀）
    this._sessionMap = new Map();    // 外部 sessionId → dsh session id
    this._conflictIds = new Set();   // 持久化冲突过的 logicalId（降级隔离 id）
    this._groupModes = new Map();    // 群 logicalId → 最近一次模式（ordinary/platform）；模式翻转时重注入身份
    this._eventCounts = null;        // 单轮事件统计（空转诊断用）
    this._lastEmptyDiag = '';        // 最近一次空转诊断摘要（异常信息带出）
    this._activeRun = null;          // 进行中的 run { memberId, sessionId }（中断式插队定位）
    this._interruptArmed = new Set(); // 本轮已发起 interrupt 的 member（run 正常收尾为空时也跳过空转重试）
    this._memberTurnStart = new Map(); // memberId → 本轮开始时间戳（僵死成员巡检用）
    this._runtimeDead = false;        // runtime 子进程已退出（下条消息自动重启）
    this._runtimeExitWatch = null;    // 当前 runtime child（exit 监听去重/旧回调失效用）
    this._restarting = null;          // 重启 runtime 的进行中 Promise（防并发重入）
    this._watchdogTimer = null;       // 僵死成员巡检定时器
  }

  /**
   * 懒初始化：动态 import ESM SDK + 启动 harness 子进程。
   * 失败（未安装/网络不可达）→ available=false，调用方降级到现有 AgentEngine。
   */
  async initialize() {
    if (this._initializing) return this._initializing;
    this._initializing = this._doInitialize();
    return this._initializing;
  }

  async _doInitialize() {
    try {
      // CJS 动态加载 ESM
      const mod = await import('@deepseek-ai/dsh-sdk-client');
      this._sdk = mod;

      // boot 标识：本进程生命周期内 session id 后缀。
      // dsh 持久化日志按 session id 全局匹配（跨进程复用同 id 会 collision），
      // 重启后挂新 bootId 开新会话（旧日志由下面的 storages 清理回收）。
      this._bootId = crypto.randomBytes(4).toString('hex');

      fs.mkdirSync(WORKSPACE, { recursive: true });
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.mkdirSync(NATIVE_CACHE, { recursive: true });
      // 生产持久化：sessions/attachments 软链到持久卷（重部署不丢完整上下文）
      this._redirectDshRuntimeToVolume();
      // 清理上一进程的会话投影缓存（可重建缓存；保留 sessions/ 持久化日志——
      // 稳定 session id 模式下它们是跨进程恢复历史的来源）
      const storages = path.join(HOME_DIR, 'storages');
      if (fs.existsSync(storages)) fs.rmSync(storages, { recursive: true, force: true });
      // 清理旧 bootId 隔离模式的遗留会话日志（一次性）
      this._cleanLegacySessionLogs();
      // Windows 附件 chmod 兼容 patch（幂等，重装依赖后自动重打）
      this._patchAttachmentWin32();
      // DeepSeek 400 raw body 透出 patch（幂等）：运行时把 400 的原始响应体吞进
      // LlmError.cause，通知只留 {message,code,status}。打补丁让 message 带上 raw
      // body，400 成因（被拒字段/模型不存在等）就能流进会话日志与诊断端点。
      this._patchLlmErrorBody();
      // x-deepseek-harness-session-id header 值 ASCII 化 patch（幂等）：普通模式
      // 用户身份 id 含中文（guest-昵称），SDK 会把 sessionId 直接拼进 header 值，
      // undici fetch 校验 ByteString 失败在本地立刻抛 TypeError → 被包装成
      // TRANSPORT 空转（重试无效、非网络）。编码成 ASCII 后 header 合法、服务端
      // 磁盘路径（同规则 _encodeSegment）与 resume 天然一致。
      this._patchLlmHeaderAscii();
      // 人设同步：personas/AGENTS.{DSH_PERSONA}.md → workspace/AGENTS.md（源文件为唯一真源，
      // dsh agent-instructions 热更新通道自动重注入）
      this._syncPersona();
      // 工具桥插件注入 dsh profile（dependencies + cordis.patch.yml + npm install）
      await this._ensureProfilePlugin();

      this.harness = new mod.DeepSeekHarness({
        provider: DSH_PROVIDER,
        model: DSH_MODEL,
        cwd: WORKSPACE,
        processCwd: WORKSPACE,
        dshHome: HOME_DIR,               // DSH_HOME → 项目内（替代 ~/.dsh）
        initializeTimeoutMs: Number(process.env.DSH_INIT_TIMEOUT_MS || 60000), // 冷启动（依赖重装后 cordis 组装）可超默认 10s；超限全新 home 首装更久（manager 注入 5min）
        env: {
          ...process.env,                // DEEPSEEK_API_KEY 等透传给子进程
          DSH_HOME: HOME_DIR,
          NARB_NATIVE_CACHE_DIR: NATIVE_CACHE,  // native loader 缓存 → 项目内（替代 %LOCALAPPDATA%）
        },
      });
      // 诊断开关 DSH_FWD_HARNESS_STDERR=1：把 dsh runtime 子进程的 stderr 原样转发到
      // 服务日志（SDK 内部默认吞掉只留尾部；转发后 cordis 启动首错/插件栈直接可见）
      if (process.env.DSH_FWD_HARNESS_STDERR === '1' && this.harness && this.harness.client) {
        const cl = this.harness.client;
        const origStart = cl.start.bind(cl);
        cl.start = (...args) => {
          const ret = origStart(...args);
          const child = cl.child;
          if (child && child.stderr) {
            child.stderr.on('data', (d) => { try { process.stderr.write('[dsh-rt] ' + String(d)); } catch { /* 忽略 */ } });
          }
          return ret;
        };
      }
      await this.harness.start();
      this.available = true;
      this._attachRuntimeExitWatch();
      this._startStaleMemberSweep();
      console.log(`✅ dsh 底座引擎已启动（${DSH_PROVIDER}/${DSH_MODEL}，子进程 workspace=${WORKSPACE}）`);
    } catch (e) {
      this.available = false;
      console.warn(`⚠️ dsh 底座不可用（${e.message}），继续用现有 Engine`);
      console.warn('   安装：npm i @deepseek-ai/dsh-sdk-client@0.1.2-alpha.2 @deepseek-ai/dsh@0.1.2-alpha.2');
      // 诊断：SDK 子进程的 stderr 尾部才是 cordis 启动失败的首错现场（哪个插件先挂的
      // 完整栈）。顶层 message（INACTIVE_EFFECT 等）多半只是启动中止后收尾阶段的次生错误。
      try {
        const tail = this.harness?.client?.stderrTail;
        if (Array.isArray(tail) && tail.length) {
          console.warn('   [dsh runtime stderr 尾部]\n   ' + tail.slice(-60).join('\n   '));
        }
      } catch { /* 诊断失败不阻塞 */ }
      // 超限 worker 全新 home 自愈：首次冷启动失败基本是把 profile 依赖装成了半成品
      //（peer 分裂/中断残留），留着只会每次复现同一个错；清掉后下一条消息重装再试。
      // 用 home 级 marker 限频（15 分钟最多清一次），防止失败循环里反复整包重装。
      if (process.env.DSH_ENGINE_HOME_DIR && HOME_DIR && fs.existsSync(HOME_DIR)) {
        try {
          const healMark = path.join(HOME_DIR, '.dsh-heal-marker');
          let canHeal = !fs.existsSync(healMark);
          if (!canHeal) canHeal = Date.now() - fs.statSync(healMark).mtimeMs > 15 * 60 * 1000;
          if (canHeal) {
            let removed = false;
            for (const sub of [
              path.join(HOME_DIR, 'profiles', 'sdk', 'node_modules'),
              path.join(HOME_DIR, 'profiles', 'sdk', 'package-lock.json'),
              path.join(HOME_DIR, 'profiles', 'node_modules'),
              path.join(HOME_DIR, 'profiles', 'package-lock.json'),
            ]) {
              if (fs.existsSync(sub)) { fs.rmSync(sub, { recursive: true, force: true }); removed = true; }
            }
            fs.writeFileSync(healMark, new Date().toISOString());
            if (removed) {
              console.warn(`   [DshEngine] 已清理 ${HOME_DIR} 的 profile 安装产物（自愈），下一条消息将重装后重试`);
            }
          }
        } catch (e2) {
          console.warn(`   [DshEngine] profile 自愈清理失败: ${e2.message}`);
        }
      }
    }
    return this.available;
  }

  /**
   * 工具桥插件注入 dsh profile（out-of-tree 插件机制，幂等）：
   *   1. 确保 $DSH_HOME/profiles/sdk/ 存在（不存在则按官方模板完整创建）
   *   2. package.json dependencies 声明插件（file: 协议指向 backend/agent/dsh/plugins/*）
   *   3. cordis.patch.yml：steward-bridge insert + sdk-jsonrpc-server 行覆盖
   *      （id 相同后写整行覆盖 → 把 server 换成 resume 补丁 fork）
   *   4. profile 目录 npm install（任一插件缺失时）
   *   5. server fork 源刷新（从已安装原包再生成，版本更新自愈）+ 源码同步
   */
  async _ensureProfilePlugin() {
    const profileDir = path.join(HOME_DIR, 'profiles', 'sdk');
    const pkgPath = path.join(profileDir, 'package.json');
    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    // 浏览器自动化开关：DSH_BROWSER=1 → profile 注入 dsh-plugin-playwright
    //（browser_* 工具族，Playwright 驱动）；不开则 profile 与现状完全一致。
    const browserEnabled = process.env.DSH_BROWSER === '1';
    // 全量原生：超限 worker（DSH_ENGINE_FULL_NATIVE=1）保留 dsh-base 自带原生工具
    //（fs/pwsh/bash/skill/subagent/…）；普通主引擎默认禁用它们（超限才可见，见下）。
    const fullNative = process.env.DSH_ENGINE_FULL_NATIVE === '1';
    // file: 依赖路径必须用 POSIX 正斜杠——Windows 上 path.relative 产生反斜杠，
    // 写入 package.json 后在 Linux 容器（Zeabur/Docker）npm 解析失败 →
    // 插件装成空壳 → cordis loader ERR_MODULE_NOT_FOUND（dsh 底座不可用）
    const toPosix = (p) => p.split(path.sep).join('/');
    const bridgeRel = toPosix(path.relative(profileDir, path.join(__dirname, 'plugins', 'steward-bridge')));
    const forkDir = path.join(__dirname, 'plugins', 'steward-jsonrpc-server');
    const forkRel = toPosix(path.relative(profileDir, forkDir));
    // 浏览器插件本地 fork（frame 穿透 / 坐标点击 / stealth，仓库内 dsh-plugin-playwright）
    const browserPluginDir = path.join(__dirname, 'plugins', 'dsh-plugin-playwright');
    const browserPluginRel = toPosix(path.relative(profileDir, browserPluginDir));
    // 依赖形态切换（registry ^0.2.0 → file: 本地 fork）时旧 node_modules 拷贝失效，
    // 需强制重装一次；file: 依赖以 symlink 落地，后续本地改动即时生效免重装。
    let forceBrowserReinstall = false;

    // 1. profile 不存在 → 按官方模板创建（与 dsh 自动初始化产物一致）。
    //    注意：必须连 package.json 一起写（含 dsh.profile.bundles 与 patchReload）——
    //    只写 cordis.yml/pnpm-workspace 会导致下一步读 pkgPath ENOENT（全新 home，
    //    如超限模式的 per-会话 home，第一次初始化时必踩）。
    if (!fs.existsSync(pkgPath)) {
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n');
      fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
      fs.writeFileSync(pkgPath, JSON.stringify({
        name: 'dsh-profile-sdk',
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
            patchReload: 'startup',
          },
        },
      }, null, 2) + '\n');
    }

    // 1.5 双级 .npmrc（profile 内 + home 根）：让 home 内任何后续 npm install
    //（含 dsh runtime 自己的 profile 物化安装）都不再按 peer `*` 自动装 registry
    // 最新版。npm 7+ 默认 auto-install-peers，dsh-plugin-playwright 等社区插件
    // peer 是 *，会把 @deepseek-ai/dsh-tools/cordis 装成 rc 线新版，与主运行时
    // 0.1.2-alpha.2 分裂成两份 → cordis INACTIVE_EFFECT（cannot create effect
    // on inactive context）。我们自己那条 npm install 已带 --legacy-peer-deps，
    // 这里补上 runtime 内部安装路径的兜底（全新 per-会话 home 冷装必踩）。
    const npmrcContent = 'legacy-peer-deps=true\n';
    let wroteNpmrc = false; // 本次刚补写 .npmrc → 即使 node_modules 已存在也强制重装一次
    for (const dir of [HOME_DIR, profileDir]) {
      try {
        const p = path.join(dir, '.npmrc');
        if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== npmrcContent) {
          fs.writeFileSync(p, npmrcContent);
          wroteNpmrc = true;
        }
      } catch { /* 写失败不阻塞（只读 home 时忽略） */ }
    }

    // 2. dependencies 写入插件引用（幂等；兼容修复：已写入的反斜杠路径归一重写）
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    let pkgDirty = false;
    const fixDep = (name, posixRel) => {
      const cur = pkg.dependencies[name];
      if (cur === undefined || cur !== `file:${posixRel}`) {
        pkg.dependencies[name] = `file:${posixRel}`;
        pkgDirty = true;
      }
    };
    fixDep('steward-bridge', bridgeRel);
    fixDep('steward-jsonrpc-server', forkRel);
    if (browserEnabled) {
      // 本地 fork（file:）替换 registry 版：自研 frame 穿透/坐标点击/stealth 必须
      // 在仓库内改源码才可版本化；registry ^0.2.0 无这些能力。
      const wantPw = `file:${browserPluginRel}`;
      const curPw = pkg.dependencies['dsh-plugin-playwright'];
      if (curPw !== wantPw) {
        pkg.dependencies['dsh-plugin-playwright'] = wantPw;
        pkgDirty = true;
        forceBrowserReinstall = true;
      }
    }
    if (pkgDirty) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    // 3. cordis.patch.yml（引擎托管，内容驱动重写）：
    //    - steward-bridge 工具桥 insert
    //    - sdk-jsonrpc-server 原行 disable + fork 行 insert
    //    注意：cordis patch 的行覆盖不能改 name——patch 指定的 name 与目标行
    //    不一致时整行 patch 被静默跳过（applyEntryPatches 的 name-mismatch
    //    守卫）。所以替换插件 = disable 原行（不带 name 字段）+ insert 新行，
    //    与 steward-bridge 同机制。
    const basePatch = [
      '# steward-bridge: backend tool bridge (auto-managed by DshAgentEngine)',
      '- insert:',
      '    - id: steward-bridge',
      '      name: steward-bridge',
      '',
      '# steward-jsonrpc-server: fork of @deepseek-ai/dsh-sdk-jsonrpc-server with',
      '# cross-process session resume (auto-resume materialized logs). The bundle',
      '# row is disabled (row patches cannot rename — name mismatch is skipped',
      '# silently), and the fork is inserted as its own entry instead.',
      '- id: sdk-jsonrpc-server',
      '  disabled: true',
      '- insert:',
      '    - id: steward-jsonrpc-server',
      '      name: steward-jsonrpc-server',
      '      inject: [sdkAppStartup, loader]',
      '      config:',
      '        maxTokensAsSuccess: !!js "process.env.DSH_MAX_TOKENS_AS_SUCCESS === undefined ? true : JSON.parse(process.env.DSH_MAX_TOKENS_AS_SUCCESS)"',
      '',
    ].join('\n');
    // DSH_BROWSER=1 时注入 dsh-plugin-playwright（browser_* 工具族）。
    // 浏览器二进制解析：优先 executablePath（DSH_BROWSER_EXECUTABLE）→ channel
    //（DSH_BROWSER_CHANNEL，如 msedge/chrome）→ playwright 自带 chromium
    //（容器需 npx playwright install chromium）。headless 默认 true。
    const browserRows = [];
    if (browserEnabled) {
      browserRows.push(
        '# dsh-plugin-playwright: browser automation (auto-managed by DshAgentEngine, DSH_BROWSER=1)',
        '- insert:',
        '    - id: dsh-plugin-playwright',
        '      name: dsh-plugin-playwright',
        '      config:',
        '        headless: !!js "process.env.DSH_BROWSER_HEADLESS === undefined ? true : JSON.parse(process.env.DSH_BROWSER_HEADLESS)"',
      );
      // 持久登录态：userDataDir 落在本引擎 home 下（超限 = 持久卷内会话专属 home，
      // 跨部署/跨超限开启存活）→ cookie/localStorage 保留，登录一次后续免登录，
      // 也降低被风控与"跨域 iframe 登录框进不去"类死路。同一 profile 不可被两个
      // 浏览器进程并发占用（chromium singleton 锁），每会话独立 home 天然隔离。
      const browserUserData = path.join(HOME_DIR, 'playwright-profile');
      try { fs.mkdirSync(browserUserData, { recursive: true }); } catch { /* 只读 home 忽略 */ }
      browserRows.push(`        userDataDir: '${browserUserData}'`);
      const exe = process.env.DSH_BROWSER_EXECUTABLE;
      if (exe) browserRows.push(`        executablePath: '${exe}'`);
      const channel = process.env.DSH_BROWSER_CHANNEL;
      if (channel) browserRows.push(`        channel: '${channel}'`);
      // 默认网络出口：空 = 直连；非空（如 socks5://127.0.0.1:1090）则 browser_*
      // 启动即走该代理。运行中可用 browser_proxy 工具随时切换（持久化于 profile 旁）。
      const proxy = process.env.DSH_BROWSER_PROXY;
      if (proxy) browserRows.push(`        proxy: '${String(proxy).trim()}'`);
    }
    // 非超限（普通主引擎）：禁用 dsh-base 挂载的原生工具行——普通会话只保留
    // bridge class_* 能力，原生工具（终端/文件/子任务/技能/网页抓取等）归超限模式。
    // 行级 patch 按 id disable（与 steward-jsonrpc-server 同机制，幂等）。
    const NATIVE_TOOL_IDS = [
      'tool-fs', 'tool-fs-search', 'tool-pwsh', 'tool-bash', 'tool-str-replace-editor',
      'tool-skill', 'skill-filesystem', 'tool-jobs',
      'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
      'tool-subagent-fork', 'tool-subagent-report', 'tool-workflow', 'tool-ralph',
      'tool-goal', 'command-goal', 'tool-todo', 'tool-ask-user', 'tool-web',
      'command-compact', 'plan-mode',
    ];
    const disableRows = [];
    if (!fullNative) {
      for (const id of NATIVE_TOOL_IDS) disableRows.push(`- id: ${id}`, '  disabled: true');
    }
    let desiredPatch = browserRows.length > 0 ? `${basePatch}\n${browserRows.join('\n')}\n` : basePatch;
    if (disableRows.length > 0) {
      desiredPatch += `# native tool disable (ordinary engine; overdrive worker keeps full set)\n${disableRows.join('\n')}\n`;
    }
    let curPatch = '';
    try { curPatch = fs.readFileSync(patchPath, 'utf8'); } catch {}
    if (curPatch !== desiredPatch) fs.writeFileSync(patchPath, desiredPatch);

    // 4. 插件包安装（任一缺失时）
    const installedBridge = path.join(profileDir, 'node_modules', 'steward-bridge');
    const installedFork = path.join(profileDir, 'node_modules', 'steward-jsonrpc-server');
    const installedBrowser = path.join(profileDir, 'node_modules', 'dsh-plugin-playwright');
    // file: 依赖以 symlink 落地；node_modules 里若是实体目录 = 旧 registry 拷贝
    //（registry ^0.2.0 时代的残留），必须重装切到本地 fork。
    let browserDepOk = true;
    if (browserEnabled) {
      try { browserDepOk = fs.lstatSync(installedBrowser).isSymbolicLink(); } catch { browserDepOk = false; }
    }
    const needInstall = !fs.existsSync(installedBridge) || !fs.existsSync(installedFork)
      || (browserEnabled && !browserDepOk)
      || wroteNpmrc // .npmrc 刚补写（策略升级/旧树中毒）→ 重装一次按新策略重建
      || forceBrowserReinstall; // 依赖从 registry 切 file: fork → 旧拷贝作废
    if (needInstall) {
      try {
        // --legacy-peer-deps：禁止 npm 为 peer 自动安装 registry 最新版
        //（dsh-plugin-playwright 等社区插件 peer 是 *，auto-install 会把
        // @deepseek-ai/dsh-tools/cordis 装成 rc 线新版，与 dsh 主运行时
        // 0.1.2-alpha.2 分裂成两份 → "cannot create effect on inactive context"。
        // 插件运行时从上层 node_modules 解析到与主运行时同源的同版本包。）
        // 必须异步：原先用 execSync，安装期间整个 Node 事件循环停摆（最长 120s）；
        // 而 server.listen 早在初始化之前就已生效 → 连接能建立但握手/心跳无人应答，
        // 客户端成片掉线重连、网页与微信管家一起无响应。异步后安装期间服务照常。
        await new Promise((resolve, reject) => {
          const child = spawn('npm', [
            'install', '--omit=dev', '--no-audit', '--no-fund',
            '--legacy-peer-deps', '--registry=https://registry.npmmirror.com', '--loglevel=error',
          ], { cwd: profileDir, timeout: 120000, stdio: ['ignore', 'ignore', 'pipe'], shell: true });
          let errOut = '';
          child.stderr.on('data', (d) => { errOut += String(d); });
          child.on('error', reject);
          child.on('close', (code, signal) => {
            if (code === 0) return resolve();
            reject(new Error(`npm install 退出（code=${code}${signal ? `, signal=${signal}` : ''}）${errOut.trim().slice(-500)}`));
          });
        });
      } catch (e) {
        throw new Error(`profile 插件安装失败: ${e.message}`);
      }
    }

    // 5. server fork 源刷新：从已安装原包再生成（上游版本变化时自愈；
    //    原包未装/锚点漂移时保留仓库内基线并提示）
    const { generateServerFork } = require('./generateServerFork');
    const fork = generateServerFork({ homeDir: HOME_DIR, forkDir });
    if (!fork.ok && fork.reason !== 'original not installed') {
      console.warn(`[DshEngine] server fork 刷新失败（保留现有基线）: ${fork.reason}`);
    }

    // 6. 插件源码同步（file: 协议安装是复制快照，源码更新需覆盖同步）
    const bridgeSrc = path.join(__dirname, 'plugins', 'steward-bridge');
    fs.mkdirSync(installedBridge, { recursive: true });
    for (const file of ['package.json', 'index.mjs']) {
      const src = path.join(bridgeSrc, file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(installedBridge, file));
    }
    fs.mkdirSync(installedFork, { recursive: true });
    for (const file of ['package.json', 'lib/index.js']) {
      const src = path.join(forkDir, file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(installedFork, file));
    }
    // 浏览器插件 fork 同样做启动同步（此前漏掉——file: 落成"复制快照"后，镜像里
    // 的源码更新不会反映到 profile 安装副本，612 这类持久 home 会一直加载旧工具集，
    // 坐标点击/元素框等新工具永远不出现在模型工具列表）。symlink（指向镜像源码）
    // 内容天然随镜像更新 → 跳过；实体目录 = 快照 → 整树覆盖同步。
    if (browserEnabled) {
      try {
        const bst = fs.existsSync(installedBrowser) ? fs.lstatSync(installedBrowser) : null;
        if (bst && !bst.isSymbolicLink() && bst.isDirectory()) {
          syncTree(browserPluginDir, installedBrowser);
          console.log('[DshEngine] 已同步 dsh-plugin-playwright fork 源码 → profile 安装目录');
        }
      } catch (e) {
        console.warn('[DshEngine] playwright fork 源码同步失败（忽略）:', e.message);
      }
    }
  }

  /**
   * 人设同步（幂等）：personas/AGENTS.{DSH_PERSONA}.md → workspace/AGENTS.md。
   * personas/ 是唯一真源，workspace 是 dsh agent-instructions 的加载点；
   * 内容有差异时覆盖（dsh 检测文件变更自动重注入 baseline 指令）。
   * {{STICKERS}} 占位符 → 当前表情包清单（data/stickers/manifest.json，
   * CLI 远程增删后重启即更新进人设；无表情包时整段占位行剔除）。
   */
  _syncPersona() {
    const persona = process.env.DSH_PERSONA || 'anaxis';
    const src = path.join(__dirname, 'personas', `AGENTS.${persona}.md`);
    const dst = path.join(WORKSPACE, 'AGENTS.md');
    try {
      if (!fs.existsSync(src)) {
        console.warn(`[DshEngine] 人设文件不存在: personas/AGENTS.${persona}.md，保留 workspace/AGENTS.md 现状`);
        return;
      }
      let content = fs.readFileSync(src, 'utf8');
      if (content.includes('{{STICKERS}}')) {
        content = content.replace('{{STICKERS}}', this._renderStickerBlock());
      }
      // 超限 worker（DSH_ENGINE_FULL_NATIVE=1）：在标准人设后追加超限工作区说明段，
      // 让模型知道原生能力边界与协作规范（AGENTS.overdrive.md）。
      if (process.env.DSH_ENGINE_FULL_NATIVE === '1') {
        const ovSrc = path.join(__dirname, 'personas', 'AGENTS.overdrive.md');
        try {
          if (fs.existsSync(ovSrc)) {
            const ov = fs.readFileSync(ovSrc, 'utf8').replace(/\{\{cwd\}\}/g, WORKSPACE);
            content = `${content}\n\n${ov}`;
          }
        } catch (e) {
          console.warn('[DshEngine] 超限人设附加段读取失败（忽略）:', e.message);
        }
      }
      if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== content) {
        fs.writeFileSync(dst, content);
        console.log(`[DshEngine] 人设已同步: AGENTS.${persona}.md → workspace/AGENTS.md`);
      }
    } catch (e) {
      console.warn('[DshEngine] 人设同步失败（保留现状）:', e.message);
    }
  }

  /** 表情包清单 → 人设文本块（id: 文字（场景）逐行） */
  _renderStickerBlock() {
    try {
      const manifest = path.join(getDataPath('stickers'), 'manifest.json');
      if (!fs.existsSync(manifest)) return '';
      const list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const lines = (Array.isArray(list) ? list : [])
        .map(s => {
          const file = path.join(getDataPath('stickers'), s.file || `${s.id}.png`);
          return (s.id && s.text && fs.existsSync(file))
            ? `- ${s.id}: ${s.text}${s.use ? `（${s.use}）` : ''}`
            : null;
        })
        .filter(Boolean);
      return lines.length > 0 ? lines.join('\n') : '';
    } catch {
      return '';
    }
  }

  // ---------- 服务器持久化记忆（上下文跨会话恢复的兜底与导出） ----------

  /**
   * 安全截断文本（按 Unicode 码点，不切断 emoji 代理对），并顺带清理历史遗留的
   * 孤立代理（lone surrogate，会触发 DeepSeek 服务端 JSON 解析 hex-escape 400）。
   * @param {string} s
   * @param {number} n - 最大码点数
   * @returns {string}
   */
  _safeClip(s, n) {
    let text = String(s ?? '');
    // 清理孤立代理：高位后必须紧跟低位、低位前必须是高位，否则替换为 U+FFFD
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const nx = text.charCodeAt(i + 1);
        if (nx >= 0xdc00 && nx <= 0xdfff) {
          out += text[i] + text[i + 1];
          i++;
        } else {
          out += '\uFFFD'; // 孤立高位
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        out += '\uFFFD'; // 孤立低位
      } else {
        out += text[i];
      }
    }
    // 按码点截断（Array.from 按码点切，避免代理对从中间断开）
    return Array.from(out).slice(0, n).join('');
  }

  /** 记忆文件路径：data/conversation_memory/{memberId}_dsh{_overdrive}.json
   *  普通/超限两种模式使用各自的记忆文件（DSH_ENGINE_FULL_NATIVE=1 → 超限）——
   *  两种模式的上下文互不串味；跨模式的手递手由切换时的 AI 摘要显式完成
   *  （见 utils/overdriveHandoff），不做隐式共享。 */
  _memoryFile(memberId) {
    const suffix = process.env.DSH_ENGINE_FULL_NATIVE === '1' ? '_dsh_overdrive.json' : '_dsh.json';
    return path.join(getDataPath('conversation_memory'), `${memberId}${suffix}`);
  }

  /** 追加一轮对话（用户消息 / 主动消息 + AI 回复），滚动保留 200 轮 */
  _appendMemory(memberId, entry) {
    try {
      const file = this._memoryFile(memberId);
      let data;
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
      if (!data || typeof data !== 'object' || !Array.isArray(data.turns)) {
        data = { memberId: String(memberId), turns: [] };
      }
      // 按码点截断（安全版），避免把 emoji 代理对切断成孤立代理（DeepSeek 400 根因）
      data.turns.push({
        at: new Date().toISOString(),
        kind: entry.kind || 'user',
        text: this._safeClip(entry.text, 500),
        reply: this._safeClip(entry.reply, 500),
      });
      if (data.turns.length > 200) data.turns = data.turns.slice(-200);
      data.updatedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
      // 非关键路径：记忆导出失败不影响对话
      console.warn('[DshEngine] 记忆导出失败:', e.message);
    }
  }

  /** 恢复用历史摘要（最近 n 轮，每轮一行；默认取满存储上限 200 轮） */
  _memorySummary(memberId, n = 200) {
    try {
      const file = this._memoryFile(memberId);
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const turns = Array.isArray(data.turns) ? data.turns.slice(-n) : [];
      if (turns.length === 0) return null;
      const lines = turns.map(t => {
        const who = t.kind && t.kind !== 'user' ? `[你主动发的 ${t.kind}] ${t.text}` : `她：${t.text}`;
        // 安全截断：按码点 + 清理孤立代理，避免切断 emoji 代理对（DeepSeek 400 根因）
        const reply = this._safeClip(String(t.reply || '').replace(/\n/g, ' '), 150);
        return `${who}\n你：${reply}`;
      });
      return `【历史对话摘要（本会话之前你们的对话，供恢复上下文；最近 ${turns.length} 轮）】\n${lines.join('\n')}`;
    } catch (e) {
      return null;
    }
  }

  /**
   * 生产持久化重定向：dsh 会话日志/附件写在容器应用目录（每次重部署换新容器即清空，
   * 完整逐字上下文不跨部署存活，只剩摘要兜底）。生产（存在 /backend/data 持久卷）时
   * 把 HOME_DIR 下 sessions 与 attachments 以软链指向卷（卷内 dsh-home/<sub>），
   * 使逐字历史与图片附件跨重部署保留——resume 稳定 id 的「完整恢复」才真正成立。
   * 本地（无卷）直接跳过，行为不变；失败仅告警不影响启动。
   */
  _redirectDshRuntimeToVolume() {
    try {
      const dataDir = getDataDir();
      const localData = path.join(__dirname, '..', '..', 'data');
      if (dataDir === localData) return; // 无持久卷挂载（本地开发）
      // 超限 worker：HOME_DIR 本身就在持久卷（dataDir/overdrive/homes/{scopeKey}），
      // 其 sessions/attachments 已随卷跨部署保留——无需再重定向到共享的 dsh-home
      //（重定向会把它挪进共享目录，破坏不同超限会话的 home 独立性）。
      if (path.resolve(HOME_DIR).startsWith(path.resolve(dataDir) + path.sep)) return;
      const volRoot = path.join(dataDir, 'dsh-home');
      for (const sub of ['sessions', 'attachments']) {
        const appDir = path.join(HOME_DIR, sub);
        const volDir = path.join(volRoot, sub);
        let st = null;
        try { st = fs.lstatSync(appDir); } catch { /* 不存在 */ }
        if (st && st.isSymbolicLink()) continue; // 已重定向过
        fs.mkdirSync(volDir, { recursive: true });
        if (st && st.isDirectory()) {
          // 应用目录残留（旧逻辑/本容器早前写入）：搬进卷再链。
          // rename 跨盘会 EXDEV → 回退拷贝。
          try {
            for (const e of fs.readdirSync(appDir)) fs.renameSync(path.join(appDir, e), path.join(volDir, e));
            fs.rmdirSync(appDir);
          } catch {
            fs.cpSync(appDir, volDir, { recursive: true, force: true });
            fs.rmSync(appDir, { recursive: true, force: true });
          }
        } else if (st) {
          fs.rmSync(appDir, { force: true });
        }
        fs.symlinkSync(volDir, appDir, process.platform === 'win32' ? 'junction' : 'dir');
        console.log(`[DshEngine] dsh ${sub} 已重定向到持久卷: ${volDir}`);
      }
    } catch (e) {
      console.warn('[DshEngine] dsh 运行时持久化重定向失败（忽略，会话不跨重部署）:', e.message);
    }
  }

  /** 清理旧 bootId 隔离模式遗留的会话日志目录（一次性，稳定 id 模式不再产生） */
  _cleanLegacySessionLogs() {
    try {
      const sessionsRoot = path.join(HOME_DIR, 'sessions');
      if (!fs.existsSync(sessionsRoot)) return;
      let removed = 0;
      for (const proj of fs.readdirSync(sessionsRoot)) {
        const projDir = path.join(sessionsRoot, proj);
        if (!fs.statSync(projDir).isDirectory()) continue;
        for (const sid of fs.readdirSync(projDir)) {
          // 旧形态：member-612-812f7802（8 位 hex 后缀）
          if (/^member-.+-[0-9a-f]{8}$/.test(sid)) {
            fs.rmSync(path.join(projDir, sid), { recursive: true, force: true });
            removed++;
          }
        }
      }
      if (removed > 0) console.log(`[DshEngine] 已清理 ${removed} 个旧隔离模式会话日志（稳定 id 模式）`);
    } catch (e) {
      console.warn('[DshEngine] 旧会话日志清理失败（忽略）:', e.message);
    }
  }

  /**
   * Windows 附件 chmod 兼容 patch（幂等）。
   *
   * 上游 bug：dsh-attachment-local 的 commitPreparedImageFile 顺序为
   * link(staging→target) → unlink(staging) → chmod(target, 0o400)。
   * Windows/NTFS 上「删除一个 hard link 名字后 chmod 另一个名字」必然 EPERM
   * （实测：不 unlink 则 chmod 正常，加 1s 延迟无效），导致所有图片附件写入失败
   * （"Unable to persist image attachment"）。0o400 只读是内容寻址对象的防篡改
   * 加固而非功能依赖，Windows 上跳过。上游修复后此 patch 自动失效（找不到
   * 替换点即跳过并提示）。
   */
  _patchAttachmentWin32() {
    if (process.platform !== 'win32') return;
    const target = path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js');
    try {
      if (!fs.existsSync(target)) return;
      let src = fs.readFileSync(target, 'utf8');
      if (src.includes('process.platform !== "win32"')) return; // 已 patch
      const BEFORE = '\t\tawait unlink(temporary);\n\t\tawait chmod(target, 256);';
      const AFTER = '\t\tawait unlink(temporary);\n\t\tif (process.platform !== "win32") await chmod(target, 256);';
      if (!src.includes(BEFORE)) {
        console.warn('[DshEngine] dsh-attachment-local patch 点未找到（上游已修复或版本变更），跳过');
        return;
      }
      fs.writeFileSync(target, src.replace(BEFORE, AFTER));
      console.log('[DshEngine] 已应用 Windows 附件 chmod 兼容 patch（图片附件持久化修复）');
    } catch (e) {
      console.warn('[DshEngine] Windows 附件 patch 应用失败（图片输入可能不可用）:', e.message);
    }
  }

  // ---------- 兼容 AgentEngine 的队列保护接口 ----------

  isProcessing(memberId) {
    return this._processingMembers.has(memberId);
  }

  injectUserMessage(memberId, message) {
    if (!memberId || !this._processingMembers.has(memberId)) return false;
    const text = String(message);
    // 中断式插队：
    //   1) 同步入队（连发消息在 drain 前都能并进同一次合并，不重复打断）；
    //   2) 标记本轮中断（run 若因取消正常收尾且零输出 → 跳过空转隔离重试，
    //      那不是空转，是用户已改主意）；
    //   3) 后台 wire 'session/prompt' mode='interrupt' → server fork 调
    //      agent.cancel()（AbortController 中断在产生成——一次性最终输出也能
    //      打断，keepInbox 保留并发 steer/followup）。被取消的 run 立即收尾，
    //      turn 收尾处的 _drainPendingInjections 用队列消息立即重跑下一轮。
    //      wire 失败（run 恰已收尾等）消息仍已在队，由 drain 兜底，不丢。
    const pending = this._pendingInjections.get(memberId);
    if (pending && pending.length) {
      // 已有本轮待消化消息（刚 interrupt 过/正 drain）→ 只并入，不再重复打断
      this._queuePendingInjection(memberId, text);
      return true;
    }
    this._interruptArmed.add(memberId);
    this._queuePendingInjection(memberId, text);
    const run = this._activeRun;
    if (run && run.memberId === memberId && this.harness && this.harness.client) {
      Promise.resolve().then(async () => {
        try {
          await this.harness.client.request('session/prompt', {
            sessionId: run.sessionId,
            mode: 'interrupt',
            contentBlocks: [{ type: 'text', text }],
          });
          console.log(`[DshEngine] 中断式插队 ${memberId}: ${text.substring(0, 50)}`);
        } catch (e) {
          console.warn(`[DshEngine] interrupt wire 失败（run 恰已收尾？），消息在队由 drain 兜底: ${e.message}`);
        }
      });
    } else {
      console.log(`[DshEngine] 注入待处理消息（无进行中 run，drain 兜底）${memberId}: ${text.substring(0, 50)}`);
    }
    return true;
  }

  _queuePendingInjection(memberId, message) {
    if (!this._pendingInjections.has(memberId)) {
      this._pendingInjections.set(memberId, []);
    }
    this._pendingInjections.get(memberId).push(message);
    console.log(`[DshEngine] 注入待处理消息 ${memberId}: ${String(message).substring(0, 50)}`);
    return true;
  }

  /**
   * DeepSeek 400 raw body 透出 patch（幂等，重装依赖后自动重打）。
   *
   * 背景：DeepSeek 侧 400 INVALID_REQUEST 时，适配器把原始响应体放进
   * LlmError.cause，而 agent-loop 落 turn/end 只取 error.failure
   * {message, code, status}——真实拒绝原因（哪个字段非法/模型是否存在）
   * 在引擎、会话日志、诊断端点里全部不可见，只剩一句 "DeepSeek API
   * error (HTTP 400)"。本 patch 在抛错前把 raw body 拼进 message，
   * 使拒绝原因一路透传到会话日志与 /api/cli/dsh-session。
   */
  _patchLlmErrorBody() {
    const target = path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js');
    try {
      if (!fs.existsSync(target)) return;
      let src = fs.readFileSync(target, 'utf8');
      if (src.includes('_dshWire') && src.includes('[m1tail=')) return; // 已是最新版补丁
      const anchor = 'throw new LlmError(message, httpErrorCode(response.status, providerError), {';
      const idx = src.indexOf(anchor);
      if (idx === -1) {
        console.warn('[DshEngine] dsh-llm-deepseek patch 点未找到（版本已变更），跳过');
        return;
      }
      const lineStart = src.lastIndexOf('\n', idx) + 1;
      let removeFrom = lineStart;
      const oldIdx = src.indexOf('const _dshRaw400');
      if (oldIdx !== -1 && oldIdx < idx) {
        // 旧版补丁（raw400 / 无 plen 的 wire）在抛错前插过注入行：先摘除再升级，
        // 避免 const 重复声明
        removeFrom = src.lastIndexOf('\n', oldIdx) + 1;
      }
      src = src.slice(0, removeFrom) + src.slice(lineStart);
      // 摘除旧注入后 throw 行前移，重新计算其行缩进再注入新版
      const idx2 = src.indexOf(anchor);
      const lineStart2 = src.lastIndexOf('\n', idx2) + 1;
      const prefix2 = src.slice(lineStart2, idx2);
      const inject =
        `${prefix2}const _dshRaw400 = rawResponse.length > 0 ? (rawResponse.length > 600 ? rawResponse.slice(0, 600) + "…" : rawResponse) : "";\n`
        + `${prefix2}if (_dshRaw400 && message.indexOf(_dshRaw400) === -1) message = message + " [raw400] " + _dshRaw400;\n`
        + `${prefix2}let _dshWire = ""; try { const _cut = (s2, c2, n2) => s2 ? s2.slice(Math.max(0, c2 - n2), c2 + n2) : ""; const _p = JSON.parse(payload); const _ms = _p && _p.messages; const _m1 = _ms && _ms[1]; const _m1s = _m1 && _m1.content; const _s = typeof _m1s === "string" ? _m1s : JSON.stringify(_m1s); if (_s) { _dshWire = "[m1tail=" + JSON.stringify(_s.slice(-220)) + "]"; } _dshWire += " [doc@6499] " + JSON.stringify(_cut(payload, 6499, 140)); } catch (e) { _dshWire += " [warn] " + e.message; }\n`
        + `${prefix2}_dshWire += " [plen=" + (typeof payload === "string" ? payload.length : -1) + "]" + " [ptail] " + JSON.stringify(typeof payload === "string" ? payload.slice(-120) : "");\n`
        + `${prefix2}if (_dshWire && message.indexOf("[wire]") === -1) message = message + " [wire] " + _dshWire.slice(0, 1800);\n`
        + `${prefix2}if (typeof payload === "string" && message.indexOf("[PAYLOAD_DUMP]") === -1) message = message + " [PAYLOAD_DUMP] " + payload;\n`;
      src = src.slice(0, lineStart2) + inject + src.slice(lineStart2);
      fs.writeFileSync(target, src, 'utf8');
      console.log('[DshEngine] 已 patch dsh-llm-deepseek：400 时透出 raw body + messages[1]/doc 报错列窗口（定位 INVALID_REQUEST 成因）');
    } catch (e) {
      console.warn('[DshEngine] dsh-llm-deepseek patch 失败（忽略）:', e.message);
    }
  }

  /**
   * x-deepseek-harness-session-id header 值 ASCII 化 patch（幂等，重装依赖后自动重打）。
   *
   * 背景：普通模式用户身份 id 形如 `guest-昵称`（含中文，如 guest-俞月溶），
   * 会话 sessionId 随之含非 ASCII；dsh-llm-deepseek 把 sessionId 原样拼进 header：
   *   "x-deepseek-harness-session-id": String(options.sessionId)
   * undici fetch 校验 header 值必须为 ASCII ByteString，遇到 >255 的字符在本地
   * 立即抛 TypeError（网络根本没发出），被 catch 包装成 LlmError TRANSPORT——
   * 表现为多次重试全瞬挂、重启 runtime 仍失败的空转。平台成员 id 是纯数字
   * （member-612）从不触发，只有普通模式（中文昵称）会踩。
   *
   * 本 patch 在 header 构造处把 sessionId 编码为 ASCII（与服务端磁盘路径
   * _encodeSegment 同规则：非 [A-Za-z0-9._-] 字符 → ~XXXX 大写下标），
   * 既保证 fetch 不抛，又与服务端落盘/恢复路径保持一致（天然兼容 resume）。
   */
  _patchLlmHeaderAscii() {
    const target = path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js');
    try {
      if (!fs.existsSync(target)) return;
      let src = fs.readFileSync(target, 'utf8');
      if (src.includes('_dshHeaderSafe')) return; // 已打
      // ① header 调用点：把 sessionId 原样值替换为 _dshHeaderSafe 编码调用
      const anchor = '"x-deepseek-harness-session-id": String(options.sessionId)';
      const idx = src.indexOf(anchor);
      if (idx === -1) {
        console.warn('[DshEngine] dsh-llm-deepseek header patch 点未找到（版本已变更），跳过');
        return;
      }
      const lineStart = src.lastIndexOf('\n', idx) + 1;
      const indent = src.slice(lineStart, idx);
      const callPatch =
        `${indent}"x-deepseek-harness-session-id": _dshHeaderSafe(String(options.sessionId))`;
      src = src.slice(0, lineStart) + callPatch + src.slice(idx + anchor.length);
      // ② 模块级函数定义：插在 brandString import 行之后（import 区末尾）。
      // 幂等签名 DSH_HEADER_SAFE_MARK 供本 patch 检测重复打补丁。
      const modAnchor = 'import { brandString } from "@deepseek-ai/dsh-brand";';
      const modIdx = src.indexOf(modAnchor);
      if (modIdx === -1) {
        console.warn('[DshEngine] dsh-llm-deepseek 模块级插入点未找到，函数定义跳过（调用点已打仍会在运行时 ReferenceError）');
        return;
      }
      const modFn =
        `function _dshHeaderSafe(_s) { let _o = ""; for (let _i = 0; _i < _s.length; _i++) { const _c = _s.charCodeAt(_i); const _ch = _s[_i]; if (_ch !== "~" && /^[A-Za-z0-9._-]$/.test(_ch)) _o += _ch; else _o += "~" + _c.toString(16).toUpperCase().padStart(4, "0"); } return _o; }\n`
        + `// [DSH_HEADER_SAFE_MARK]\n`;
      src = src.slice(0, modIdx) + modFn + src.slice(modIdx);
      fs.writeFileSync(target, src, 'utf8');
      console.log('[DshEngine] 已 patch dsh-llm-deepseek：x-deepseek-harness-session-id 值 ASCII 化（普通模式中文昵称不再触发 TRANSPORT 空转）');
    } catch (e) {
      console.warn('[DshEngine] dsh-llm-deepseek header patch 失败（忽略）:', e.message);
    }
  }

  /**
   * 流式消息处理（与 AgentEngine.processMessageStreamWithCallback 同签名）。
   * 回调事件从 dsh session 通知流解析：
   *   assistant/chunk(text-delta) → onToken
   *   tool/call → onToolCall / tool/result → onToolResult
   *   turn/end → onDone
   */
  /**
   * 群聊消息（复用 processMessageStreamWithCallback 主体）：
   * sessionId = group-{chatroomId}（独立对话空间，群成员共享上下文），
   * 每条消息以「群消息 发言者：内容」标注身份，context.group 携带复合
   * callerId（g:{chatroomId}:{memberId}）供首条身份注入。
   * recent：触发前群内最近消息（轻度背景注入，见 _buildPrompt）。
   * images：触发前 10 分钟内的群图片（vision 附带，见 _buildPrompt）。
   * recentFiles：触发前群内最近文件（mediaId 提示，按需 class_read_file）。
   */
  async processGroupMessage(sessionId, senderLabel, senderMemberId, text, callbacks = {}, recent = [], images = [], recentFiles = [], options = {}) {
    const chatroomId = String(sessionId).replace(/^group-/, '');
    const groupCtx = {
      group: {
        chatroomId,
        callerId: `g:${chatroomId}:${senderMemberId}`,
        recent,
        ordinary: options.ordinary === true,   // 普通模式群：AI 脱离班级平台
      },
      images: Array.isArray(images) ? images : [],
    };
    // 最近群媒体提示（图片/文件都带编号，按需引用，不自动注入内容）
    const fileNote = Array.isArray(recentFiles) && recentFiles.length > 0
      ? `\n（群里最近的图片/文件附件：${recentFiles.join('、')}。图片要作参考图生图/生视频时把 img-xxx 传给 refImage；文件要内容时用 class_read_file 按 mediaId 读取）`
      : '';
    return this.processMessageStreamWithCallback(
      sessionId, `群消息 ${senderLabel}：${text}${fileNote}`, sessionId, groupCtx, callbacks);
  }

  /**
   * 群聊主动消息（日程通知/群欢迎）：事件指令送入 group session，
   * AI 以人设口吻生成后发到群里；事件与回复都进群 session 上下文。
   * 触发者视角：无（系统事件）；工具 callerId 以系统管理员身份落
   * （公共日程本就是管理员创建的，AI 若顺手查数据属正常权限）。
   */
  async processGroupProactiveMessage(chatroomId, kind, payload = {}, callbacks = {}) {
    const directive = this._buildProactiveDirective(kind, payload);
    if (!directive) throw new Error(`未知主动消息类型: ${kind}`);
    const brief = kind === 'group_welcome' ? '（群聊欢迎）'
      : kind === 'schedule_notify' ? `群日程提醒：${payload.title || ''}` : kind;
    const sessionId = `group-${chatroomId}`;
    const adminId = (process.env.DSH_ADMIN_IDS || '612').split(',').map(s => s.trim()).filter(Boolean)[0] || '612';
    return this.processMessageStreamWithCallback(sessionId, directive, sessionId, {
      proactive: kind,
      proactiveBrief: brief,
      group: { chatroomId, callerId: `g:${chatroomId}:${adminId}` },
    }, callbacks);
  }

  async processMessageStreamWithCallback(memberId, message, sessionId = null, context = {}, callbacks = {}) {
    await this.initialize();
    if (!this.available) throw new Error('dsh 引擎不可用（降级到现有 Engine）');
    // runtime 子进程死了（或上次看门狗标记了）→ 先拉起，避免进程内所有成员一起哑掉，
    // 不必等重启容器。
    if (this._runtimeDead || (this.harness && this.harness.client && this.harness.client.exitCode !== undefined)) {
      console.warn('[DshEngine] 检测到 dsh runtime 已退出，自动重启后再处理本条');
      try { await this._restartRuntime(); } catch (e) { console.warn(`[DshEngine] runtime 自动重启失败: ${e.message}`); }
    }
    // 外部逻辑 id（member-{id}，跨重启稳定）→ dsh session id
    // server fork（steward-jsonrpc-server）对有磁盘日志的稳定 id 走 agents.resume
    // （完整恢复历史）；此时注入摘要会与已恢复历史重复 → 跳过摘要。
    // 无日志（新会话/隔离模式）或 resume 失败降级时，由 conversation_memory
    // 历史摘要注入 prompt 兜底。DSH_SESSION_PERSIST=0 直接全程 bootId 隔离
    // （本地双开调试用，此时恒走摘要兜底）。
    const logicalId = sessionId || `member-${memberId}`;
    // 防呆/定位：既无显式 sessionId、memberId 也为空/undefined 的调用不应进会话——
    // 否则会建成 member-undefined 空会话并反复出现 "resumed from persisted log"。
    // 直接忽略并打印调用栈，下次出现即可定位真实来源。
    if (!sessionId && (memberId === undefined || memberId === null || memberId === '')) {
      console.warn(`[DshEngine] 忽略无成员身份的调用（memberId=${memberId}，message=${String(message).slice(0, 80)}）\n${new Error('trace').stack}`);
      return { content: '' };
    }
    // 历史遗留积压兜底：上轮 run 异常中断（throw 未走 drain）→ 队列残留。
    // 正常入口（steward 直调，标记不在）时并入本轮消息（带序号前缀）；
    // drain 递归入口（外层持有标记）跳过——队列由 drain 自己管理。
    if (!this._processingMembers.has(memberId)) {
      const stale = this._pendingInjections.get(memberId);
      if (stale && stale.length > 0) {
        const staleMsgs = stale.splice(0, stale.length);
        this._pendingInjections.delete(memberId);
        message = staleMsgs.map((m, i) => `【她之前补充的第 ${i + 1} 条消息】${m}`).join('\n')
          + `\n【本次新消息】${message}`;
        console.log(`[DshEngine] 并入上轮残留积压 ${memberId}: ${staleMsgs.length} 条`);
      }
    }
    // resolve 前判断：该 session 本进程内是否已有历史（决定是否注入人设+历史摘要）
    const isNewSession = !this._sessionMap.has(logicalId);
    let sid = this._resolveSessionId(logicalId);
    // resume 预期：稳定 id 有磁盘日志 → 服务端 fork 将完整恢复历史
    const resumeExpected = sid === logicalId && this._hasStoredSessionLog(sid);
    if (resumeExpected && isNewSession) {
      console.log(`[DshEngine] session ${sid} 有磁盘日志，服务端将 resume 完整恢复历史`);
      // resume 恢复的历史会被重发给模型：若磁盘日志里残留孤立代理（lone
      // surrogate，曾由 substring 截断 emoji 代理对产生），DeepSeek 服务端
      // JSON 解析直接 400 hex-escape。resume 前幂等清洗一次（无坏字符不写盘）。
      try {
        const sr = sanitizeSessionLog(logicalId, { dryRun: false });
        if (sr && sr.ok && sr.reason === 'sanitized') {
          console.warn(`[DshEngine] 会话日志 ${logicalId} 已清洗孤立代理 ${sr.loneSurrogates ?? 0} 个（${sr.cleanedLines ?? 0} 行），resume 将恢复干净历史`);
        }
      } catch (e) {
        console.warn(`[DshEngine] 会话日志清洗失败（忽略，继续 resume）: ${e.message}`);
      }
    }
    this._processingMembers.add(memberId);
    this._memberTurnStart.set(memberId, Date.now());
    try {
      // 单轮事件统计（空转诊断）：每轮清零，dispatch 里计数
      this._eventCounts = {};
      this._lastTurnEnd = '';
      // 组装 prompt：session 本进程首轮携带身份（+历史摘要兜底，resume 预期跳过）；
      // 后续只发消息本体（dsh session 自带完整历史；重复人设只膨胀历史，摊薄前缀缓存收益）。
      // context.images（[{ data: Buffer, mimeType }]）时组装多模态 content blocks，
      // 需 DSH_MODEL 配置为 vision 变体（deepseek-v4-flash-vision-exp，文本图片通吃）。
      let prompt = await this._buildPrompt(memberId, context, message, isNewSession,
        { skipSummary: resumeExpected });

      let buffer = '';
      let result;
      let interruptedTurn = false;   // 本轮被用户消息中断（跳过空转/会话级恢复，直接 drain 重跑）
      const runOnce = async (targetSid, runPrompt) => {
        const session = this.harness.session(targetSid);
        // 子代理事件隔离：dsh SDK server 广播全量 session.event（含 subagent
        // 子会话）。fork 子代理后其 assistant 文本若进入主 run 回调流，会被当作
        // 主会话输出逐行发微信（用户可见子代理思考过程）。run 内先登记
        // subagent.started 的子会话 id，session.event 命中即跳过；主会话事件
        //（sessionId ≠ 任何子会话）不受影响。
        const subSessions = new Set();
        // 进行中 run 锚点（中断式插队定位）：injectUserMessage 在 run 期间经
        // wire 'session/prompt' mode='interrupt' 取消在产生成，本轮收尾后由
        // _drainPendingInjections 用新消息立即重跑（不排队等整轮自然结束）。
        this._activeRun = { memberId, sessionId: targetSid };
        buffer = '';
        let wdTimer = null;
        let lastActivity = Date.now();
        const disarm = () => { if (wdTimer) { clearInterval(wdTimer); wdTimer = null; } };
        try {
          const runPromise = session.run(runPrompt, {
            onNotification: (notification) => {
              lastActivity = Date.now();   // 任何会话事件都算「活着」→ 静默看门狗续期
              const m = notification && notification.method;
              const p = (notification && notification.params) || {};
              if (m === 'subagent.started' && p.childSessionId) {
                subSessions.add(String(p.childSessionId));
                return;
              }
              if (m === 'session.event' && subSessions.has(String(p.sessionId || ''))) return;
              this._dispatchNotification(notification, callbacks, (text) => { buffer += text; });
            },
          });
          // 迟到结果不再冒泡（看门狗赢时 runtime 会被重启，旧 run 的拒绝自行消化）
          runPromise.catch(() => {});
          // 静默看门狗：轮内只要还有事件就续期，长任务可以一直跑；连续静默超阈值才判
          // 卡死 → 取消本轮 + 重启 runtime（普通会话没有 manager 那层兜底）。
          const guard = new Promise((_, reject) => {
            wdTimer = setInterval(() => {
              if (Date.now() - lastActivity <= TURN_WATCHDOG_MS) return;
              disarm();
              const err = new Error(`dsh 单轮静默超过 ${Math.round(TURN_WATCHDOG_MS / 60000)} 分钟（看门狗取消）`);
              err.kind = 'turn-watchdog';
              reject(err);
            }, 30000);
            if (wdTimer.unref) wdTimer.unref();
          });
          result = await Promise.race([runPromise, guard]);
        } catch (e) {
          // interrupt 取消在产生成：agent.cancel 后 dsh 应正常收尾（kick 吞错），
          // 但防御任何抛出的 user-interrupt 错误——视为「用户已改主意」，结束本轮
          // 交给 _drainPendingInjections 立即用新消息重跑，不做会话级恢复/重试。
          if (e && e.kind === 'user-interrupt') {
            console.log(`[DshEngine] session ${targetSid} run 被用户消息中断，转入下一轮立即重跑`);
            interruptedTurn = true;
            return;
          }
          if (e && e.kind === 'turn-watchdog') {
            console.warn(`[DshEngine] session ${targetSid} 触发单轮看门狗，取消并重启 runtime 自愈`);
            try { await this._restartRuntime(); } catch (e2) { console.warn(`[DshEngine] 看门狗后重启 runtime 失败: ${e2.message}`); }
          }
          throw e;
        } finally {
          disarm();
          if (this._activeRun && this._activeRun.sessionId === targetSid) this._activeRun = null;
        }
      };
      try {
        await runOnce(sid, prompt);
      } catch (e) {
        // 会话层失败降级：持久化冲突（本地双开撞日志），或 resume 预期却失败
        //（日志损坏等）→ 换隔离 id 重试，并强制注入历史摘要兜底上下文
        // 看门狗触发的失败不做「会话层降级重跑」——runtime 刚重启过，重跑只会再撞一次。
        const isWatchdog = e && e.kind === 'turn-watchdog';
        const sessionLevel = !isWatchdog && (this._isSessionConflict(e) || (resumeExpected && sid === logicalId));
        if (sessionLevel && sid === logicalId) {
          console.warn(`[DshEngine] session ${sid} 会话层失败，降级隔离 id + 摘要兜底重试: ${e.message}`);
          this._sessionMap.delete(logicalId);
          this._conflictIds.add(logicalId);
          sid = this._resolveSessionId(logicalId);
          prompt = await this._buildPrompt(memberId, context, message, true, { forceSummary: true });
          await runOnce(sid, prompt);
        } else {
          throw e;
        }
      }

      // 空转检测（安全网）：resume 失效或 fork 未生效时，create 撞磁盘日志、错误被
      // dsh 内部吞掉 → turn 正常结束但零模型调用零输出。降级隔离 id 重跑一轮并
      // 强制注入历史摘要，上下文连续性由摘要兜底。
      const isEmptyOutput = () =>
        !interruptedTurn
        && !this._interruptArmed.has(memberId)
        && !String(result?.finalResponse || '').trim() && !String(buffer).trim();
      if (isEmptyOutput() && sid === logicalId && !this._conflictIds.has(logicalId)) {
        console.warn(`[DshEngine] session ${sid} 空转（resume 未生效，疑撞磁盘持久化日志），降级隔离 id + 摘要兜底重试`);
        this._sessionMap.delete(logicalId);
        this._conflictIds.add(logicalId);
        sid = this._resolveSessionId(logicalId);
        prompt = await this._buildPrompt(memberId, context, message, true, { forceSummary: true });
        await runOnce(sid, prompt);
      }
      if (isEmptyOutput()) {
        // 末级自恢复：稳定 id + 隔离 id 连续空转。空转的常见真实根因是
        // resume 出的会话历史含 API 拒绝内容（如 DeepSeek HTTP 400
        // INVALID_REQUEST——坏日志/半截 turn 造成的不闭合 tool 序列）。
        // 处理（修复式完整恢复优先）：
        //   ① _repairSessionLog：把稳定 id 磁盘日志截到最后一个完整闭合
        //      turn（坏尾备份保留审计），原历史一字不丢；
        //   ② 重启 dsh runtime 后用【同一稳定 id】resume —— 完整恢复上下文；
        //   ③ 修复失败（日志整体不可用）才隔离日志 + 全新 bootId 会话 +
        //      历史摘要兜底。仍空才抛错并带诊断。
        this._recordEmptyDiag(memberId, logicalId, sid, result, buffer);
        this._logSessionAnalysis(logicalId);   // 400/空转成因诊断（附件缺失 / 图片引用 / 工具名）
        const repaired = this._repairSessionLog(logicalId);
        if (!repaired) this._quarantineSessionLog(logicalId);
        console.warn(`[DshEngine] session ${logicalId} 双重空转，${repaired ? '修复坏日志后' : '隔离坏日志并'}重启 dsh runtime 末级兜底重试`);
        let recovered = false;
        const resetRound = () => {
          this._sessionMap.delete(logicalId);
          this._eventCounts = {};                // 重启后独立统计（判断重启轮是否仍 400/错误）
          this._lastTurnEnd = '';
        };
        try {
          const ok = await this._restartRuntime();
          if (ok) {
            if (repaired) {
              // 修复成功：优先稳定 id resume —— 完整恢复历史
              //（skipSummary 避免与已恢复历史重复；不 mark conflict，稳定 id 不再被丢弃）
              resetRound();
              sid = this._resolveSessionId(logicalId);
              prompt = await this._buildPrompt(memberId, context, message, true, { skipSummary: true });
              try {
                await runOnce(sid, prompt);
              } catch (e) {
                console.warn(`[DshEngine] 修复后稳定 resume 仍失败（降级隔离+摘要）: ${e.message}`);
              }
              recovered = !isEmptyOutput();
              if (!recovered) this._recordEmptyDiag(memberId, logicalId, sid, result, buffer);
            }
            if (!recovered) {
              // 最后防线：隔离 id + 历史摘要（上下文连续性由摘要兜底）
              this._conflictIds.add(logicalId);
              resetRound();
              sid = this._resolveSessionId(logicalId);  // 全新 bootId 隔离 id，无任何残留
              prompt = await this._buildPrompt(memberId, context, message, true, { forceSummary: true });
              await runOnce(sid, prompt);
              recovered = !isEmptyOutput();
              if (!recovered) this._recordEmptyDiag(memberId, logicalId, sid, result, buffer);
            }
          }
        } catch (e) {
          console.warn(`[DshEngine] 空转末级恢复失败: ${e.message}`);
        }
        if (!recovered) {
          throw new Error(`dsh 会话无模型输出（空转，${repaired ? '修复+重启兜底' : '隔离+重启兜底'}后仍为空）${this._lastEmptyDiag ? `｜${this._lastEmptyDiag}` : ''}`);
        }
      }

      const finalResponse = result.finalResponse || buffer;
      callbacks.onDone?.({ content: finalResponse });
      // 记忆导出（服务器持久化，兜底 + 恢复用）：每轮对话写入 conversation_memory
      this._appendMemory(memberId, {
        kind: context?.proactive || 'user',
        text: context?.proactive ? (context?.proactiveBrief || String(message).substring(0, 200)) : String(message),
        reply: String(finalResponse || ''),
      });

      // 消化输出期间积压的补充消息（标记仍持有 → 无竞态窗口；drain 递归期间
      // 新到消息继续入队，被下一层 drain 消化，天然收敛到队列空）
      const drainResult = await this._drainPendingInjections(memberId, sessionId, context, callbacks);
      return drainResult || { content: finalResponse, sessionId: logicalId };
    } finally {
      this._interruptArmed.delete(memberId);
      this._memberTurnStart.delete(memberId);
      this._processingMembers.delete(memberId);
    }
  }

  /**
   * 消化积压注入消息（AI 输出期间用户发来的新消息）。
   * processMessageStreamWithCallback 原实现里 _pendingInjections 只入队
   * 不消费（旧引擎在多轮 LLM 循环里注入 [用户补充]，dsh 单 run 没有对应
   * 挂点）→ 消息静默丢失。这里在每轮 turn 收尾（processing 标记仍在）接管：
   * 把积压消息合并（多条带序号）作为新一轮 user 消息递归跑同 session——
   * AI 说完上轮自然接上，上下文连续。调用点位于标记移除前，drain 递归
   * 入口不会与 steward 的 isProcessing 分支产生竞态。
   */
  async _drainPendingInjections(memberId, sessionId, context, callbacks) {
    const pending = this._pendingInjections.get(memberId);
    if (!pending || pending.length === 0) {
      this._pendingInjections.delete(memberId);
      return null;
    }
    const messages = pending.splice(0, pending.length);
    if (pending.length === 0) this._pendingInjections.delete(memberId);
    const merged = messages.length === 1
      ? messages[0]
      : messages.map((m, i) => `【她补充的第 ${i + 1} 条消息】${m}`).join('\n');
    console.log(`[DshEngine] 消化输出期间积压消息 ${memberId}: ${messages.length} 条`);
    // 递归是新的一轮（不再是被中断的空轮）：清掉中断标记，让它的空转检测正常生效
    this._interruptArmed.delete(memberId);
    // 递归走完整流程（session 复用、prompt 只发消息本体、记忆/回调/drain 同链路）
    return this.processMessageStreamWithCallback(memberId, merged, sessionId, context, callbacks);
  }

  /** 持久化冲突识别（运行时错误文案启发式） */
  _isSessionConflict(e) {
    const msg = String(e?.message || e || '').toLowerCase();
    return /collision|conflict|already exist|已存在|冲突|duplicate/i.test(msg);
  }

  /** 逻辑 session id → dsh session id（跨进程稳定 / 冲突后隔离） */
  _resolveSessionId(logicalId) {
    if (!this._sessionMap.has(logicalId)) {
      // 默认稳定 id（跨重启恢复持久化历史）；冲突过的 logicalId 或 DSH_SESSION_PERSIST=0 → bootId 隔离
      const stable = process.env.DSH_SESSION_PERSIST !== '0' && !this._conflictIds.has(logicalId);
      this._sessionMap.set(logicalId, stable ? logicalId : `${logicalId}-${this._bootId}`);
    }
    return this._sessionMap.get(logicalId);
  }

  /**
   * 磁盘会话日志存在检测（resume 预期判断）：
   * dsh JSONL 持久化布局 $DSH_HOME/sessions/{projectKey}/{encodeSegment(id)}/session.jsonl[.zstd]，
   * projectKey 随 cwd 变化 → 扫描所有项目目录按编码段匹配。
   */
  _hasStoredSessionLog(sid) {
    try {
      const root = path.join(HOME_DIR, 'sessions');
      if (!fs.existsSync(root)) return false;
      const seg = this._encodeSegment(String(sid));
      for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const dir = path.join(root, proj.name, seg);
        if (fs.existsSync(path.join(dir, 'session.jsonl'))
          || fs.existsSync(path.join(dir, 'session.jsonl.zstd'))) return true;
      }
    } catch {}
    return false;
  }

  /**
   * 隔离坏会话日志：resume 连续失败（空转/400）已证该稳定 id 的磁盘日志
   * 不可恢复。把 sessions 下对应 seg 目录 rename 归档（~quarantine-时间戳），
   * 防止当前进程之后、以及下个进程重启时再次 resume 同一份坏日志反复失败。
   * 历史连续性的兜底交给 conversation_memory 摘要（_memorySummary）。
   */
  _quarantineSessionLog(logicalId) {
    try {
      const seg = this._encodeSegment(String(logicalId));
      const root = path.join(HOME_DIR, 'sessions');
      if (!fs.existsSync(root)) return false;
      const stamp = Date.now();
      for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const dir = path.join(root, proj.name, seg);
        if (!fs.existsSync(dir)) continue;
        const qDir = path.join(root, proj.name, `${seg}~quarantine-${stamp}`);
        fs.renameSync(dir, qDir);
        console.warn(`[DshEngine] 已隔离坏会话日志: ${seg} → ${path.basename(qDir)}`);
        return true;
      }
    } catch (e) {
      console.warn('[DshEngine] 会话日志隔离失败（忽略，不影响对话）:', e.message);
    }
    return false;
  }

  /**
   * 会话历史诊断（400/空转成因定位）：双空转时打印稳定日志的构成——
   * 行/帧/轮数、图片引用提示、sha256 附件对象及缺失数、历史工具名。
   * 据此区分：附件对象缺失 / 历史 image 引用 / 工具 schema 演进不匹配。
   */
  _logSessionAnalysis(logicalId) {
    try {
      const a = analyzeSessionLog(String(logicalId));
      if (!a || !a.ok) {
        console.warn(`[DshEngine] 会话历史分析 ${logicalId}: ${a?.reason || '不可用'}`);
        return;
      }
      const ev = a.eventTypes || {};
      const tools = Object.keys(a.toolCalls || {}).slice(0, 25).join(',');
      const pts = a.partTypes || {};
      const partLine = Object.keys(pts).length ? ` parts=[${Object.keys(pts).slice(0, 20).map(k => `${k}:${pts[k]}`).join(' ')}]` : '';
      console.error(
        `[DshEngine] 会话历史分析 ${logicalId}: lines=${a.lines} frames=${a.frames} torn=${a.tornStart}`
        + ` turns=[start=${ev['turn/start'] || 0}/end=${ev['turn/end'] || 0}]`
        + ` imageHints=${a.imageHints} sha256Refs=${a.sha256Refs} missingObjects=${a.missingObjects}`
        + ` toolCalls=[${tools || '无'}]${partLine}`
        + `${a.sha256Sample && a.sha256Sample.length ? ` sha256Sample=${a.sha256Sample.join(',')}` : ''}`
      );
      // 400/空转现场：打印稳定日志原始尾部（含调模型前落盘的 user/message 与
      // 错误 turn/end），人工可直接判断被拒请求里实际发了什么。
      if (Array.isArray(a.rawTail) && a.rawTail.length) {
        for (const ln of a.rawTail) console.error(`[DshEngine]   日志尾部| ${ln}`);
      }
    } catch (e) {
      console.warn('[DshEngine] 会话历史分析异常:', e.message);
    }
  }

  /**
   * 修复式完整恢复：把稳定 id 的磁盘会话日志截到最后一个完整闭合的 turn
   *（硬杀截断的不完整尾部裁掉并备份审计），原历史一字不丢。返回是否
   * 已修复/本就闭合（可安全 resume 稳定 id）；整体不可用才返回 false，
   * 由调用方走隔离 + 摘要兜底。
   */
  _repairSessionLog(logicalId) {
    try {
      const r = repairSessionLog(String(logicalId), { dryRun: false });
      if (!r || !r.ok) {
        console.warn(`[DshEngine] 会话日志无需/无法修复 ${logicalId}: ${r?.reason || 'unknown'} ${r?.message || ''}`);
        return false;
      }
      if (r.reason === 'repaired') {
        console.warn(`[DshEngine] 会话日志已截尾修复 ${logicalId}：裁掉坏尾 ${r.removedLines ?? 0} 行，历史完整保留${r.backup ? `（备份 ${path.basename(r.backup)}）` : ''}`);
      } else {
        console.warn(`[DshEngine] 会话日志本就闭合 ${logicalId}（${r.reason}），resume 稳定 id 重试以完整恢复`);
      }
      return true;
    } catch (e) {
      console.warn('[DshEngine] 会话日志修复异常（忽略，走隔离兜底）:', e.message);
      return false;
    }
  }

  /**
   * dsh 的 session id → 目录名编码（与 dsh-session-persistence-jsonl 的
   * encodeSegment 一致：安全字符保留，其余 ~XXXX 转义）。
   */
  _encodeSegment(raw) {
    raw = String(raw);
    if (raw.length === 0) return raw;
    if (raw === '.') return '~002E';
    if (raw === '..') return '~002E~002E';
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      const ch = String.fromCharCode(code);
      if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
      else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
    return out;
  }

  async processMessage(memberId, message, sessionId = null, context = {}) {
    return this.processMessageStreamWithCallback(memberId, message, sessionId, context, {});
  }

  /**
   * AI 主动消息（proactive message）：每日一问 / 日程通知 / 绑定欢迎等系统事件
   * 作为事件指令送入 dsh session，由 AI 以人设口吻生成转达内容。
   * 事件指令与 AI 回复都写入 session 历史（拼接入上下文）——
   * 成员后续回复时，AI 记得自己主动说过什么，对话自然衔接。
   * 回调签名与 processMessageStreamWithCallback 一致（onToken 流式分条等）。
   */
  async processProactiveMessage(memberId, kind, payload = {}, callbacks = {}) {
    const directive = this._buildProactiveDirective(kind, payload);
    if (!directive) throw new Error(`未知主动消息类型: ${kind}`);
    // proactiveBrief：记忆导出用的简述（人话，而非指令全文）
    const brief = kind === 'daily_question' ? `每日一问：${payload.question || ''}`
      : kind === 'schedule_notify' ? `日程提醒：${payload.title || ''}`
      : kind === 'automation' ? `定时任务：${payload.name || ''}`
      : kind === 'bind_welcome' ? '（绑定欢迎）' : kind;
    return this.processMessageStreamWithCallback(memberId, directive, null,
      { proactive: kind, proactiveBrief: brief }, callbacks);
  }

  /**
   * 静默系统事件：不触发 AI 回复、不发送任何消息。
   * 事件暂存，随该成员下一条消息的 prompt 前缀送入 session（一次性消费），
   * 用于让 AI 知晓外部发生的事（如成员已在 App 完成每日一问、管理员直答已落库）。
   */
  injectSystemEvent(memberId, text) {
    if (!memberId || !text) return false;
    if (!this._pendingEvents.has(memberId)) this._pendingEvents.set(memberId, []);
    this._pendingEvents.get(memberId).push(String(text));
    return true;
  }

  /** 回滚最近一条未消费的静默系统事件（转发发送失败时撤销假上下文） */
  uninjectSystemEvent(memberId) {
    try {
      const arr = this._pendingEvents.get(String(memberId));
      if (arr && arr.length > 0) arr.pop();
      return true;
    } catch {
      return false;
    }
  }

  /** 主动消息类型 → 事件指令文本（送入 session 的消息本体） */
  _buildProactiveDirective(kind, payload) {
    switch (kind) {
      case 'bind_welcome': {
        // 普通模式绑定欢迎（不属于平台的人）：欢迎词去掉平台能力，只讲陪伴
        if (payload.ordinary) {
          return [
            `她刚刚完成普通模式绑定，昵称「${payload.name}」${payload.isNew ? '（第一次来）' : '（老朋友回来了）'}，这是本会话的第一条消息。`,
            '',
            '【这个会话的性质（重要）】',
            '- 普通模式：她不属于班级平台，你在这里不查任何班级/成绩/成员数据，不录数据、不碰审批与群广播——平台数据工具一律不可用。',
            '- 你以完整的人设陪伴她：聊天、表情包、网络搜索和图片、AI 生图/生视频、帮忙看图/读文件。',
            '',
            '【指令】自然地欢迎她：打个招呼，简短说说你能陪她做什么（聊天、斗图、找图、生成图片视频、帮忙看图片文件），轻轻提一句账号的事（换微信重新绑定同名、不用了发「解绑 昵称 1006」）即可。像朋友的开场白，两三条就好，别念功能清单，也别提班级/成绩/平台这类字眼。',
          ].join('\n');
        }
        // 管理员上下文登录欢迎（独立对话空间，能力清单与成员版不同）
        if (payload.adminContext) {
          return [
            `管理员刚刚完成微信登录（管理员上下文「${payload.adminName}」），这是本会话的第一条消息。`,
            payload.isNew
              ? '这是一个新注册的管理员名称，之后的对话记录都会独立保存在这个名称下。'
              : '她的对话记录保存在这个名称下，换设备登录同一名称即可继续。',
            '',
            '【你会主动发给她的（默认开启，她可随时让你开关）】',
            '- 管理员版每日一问：每天晚上 22:00 左右（管理反思问题）',
            '- 全员日程提醒',
            '她说「关闭每日一问」「全部关掉」时用 class_set_prefs 工具处理。',
            '',
            '【指令】自然地欢迎她：简短说说你能帮她做什么（查班级数据、发广播通知、安排日程、处理同学的审批请求），提一句每日一问默认每天会发、不想要随时说一声就能关。像同事间的开场白，两三条就好，别念功能清单。',
          ].join('\n');
        }
        const adminNote = payload.admin
          ? '\n她还是本平台的系统管理员（周祎宸或同级）：敏感操作免密码直接执行；同学的审批请求（批准/拒绝 + 编号）会转发到她这里。\n'
          : '';
        return [
          '成员刚刚完成微信绑定，这是本会话的第一条消息（她还没有说话）。',
          adminNote,
          '【你的主动功能（默认全部开启）】',
          '- 每日一问：每天晚上 22:00 左右你会发一个问题（就是现在这种主动消息）',
          '- 日程提醒：她的日程到点时你会提醒',
          '她随时可以让你开关（单独或全部）：「关闭每日一问」「日程提醒也关了」「全部关掉」「都打开」——你用 class_set_prefs 工具处理即可。',
          '',
          '【指令】自然地欢迎她：打个招呼，简短说说你能陪她做什么，要点覆盖——',
          '1. 聊天陪伴、记录训练数据、查班级信息（成绩/排名/值日/公告都行）、提醒日程；',
          '2. 图片和文件直接发给你就能看见：报数据、看截图、转发给同学（说转发你就会办）；',
          '3. 每日一问和日程提醒默认开着，不想要随时说一声就能关（举一个例子即可，如"不想收每日一问就说关闭每日一问"）；',
          '4. 最后轻轻提一句账号的事：换微信要重新绑定，不想要了发「解绑 姓名 密码」就行。',
          '像朋友的开场白，几条消息说完就好，别念功能清单。',
        ].filter(s => s !== undefined).join('\n');
      }
      case 'daily_question':
        return [
          '每日一问时间到了，今天的问题是：',
          `「${payload.question}」`,
          '',
          '【指令】用你自己的口吻把这个问题问出来（可以轻微润色，核心意思不能变），像朋友随口一问，不要出现"系统""推送"这类字眼。只问这一件事，然后等她回答。',
        ].join('\n');
      case 'group_welcome':
        return [
          '管理员刚刚在班级群里把你唤醒了，这是本群会话的第一条消息（发到群里，所有人都看得见）。',
          '',
          '【指令】自然地向群里打招呼，要点覆盖——',
          '1. 打个招呼（被唤醒了，上线啦）；',
          '2. 怎么用你：@Anaxis 或者消息里带上 Anaxis 就会回应；群里适合聊天、接梗、问公共信息（值日、公告这些）；',
          '3. 个人事务（成绩排名这些）私聊你更快，一句带过就好；',
          '4. 群里的图片和文件你都能看见：文件说一声就能帮你读、帮转；你也能按需生成表格文件发出来（比如有人要名单）。',
          '用自己的话、朋友口吻说，几条消息就好，别念功能清单。',
        ].join('\n');
      case 'schedule_notify':
        return [
          '日程提醒到点了。',
          `日程：${payload.title}${payload.description ? `\n说明：${payload.description}` : ''}${payload.dueAt ? `\n时间：${payload.dueAt}` : ''}`,
          '',
          '【指令】用你的口吻提醒她这件事（比如"你今天有个……别忘了"），简洁一条就好。如果之前的对话里聊过相关话题，可以顺口呼应一句。',
        ].join('\n');
      case 'automation': {
        // 定时任务触发（用户/管理员预设，三种 cadence：一次性/每周/间隔）：
        // 到点唤醒本会话 AI 执行预设指令；指令与 AI 输出都写入 session 历史
        //（她之后可自然接续）。
        return [
          `定时任务「${payload.name || '未命名'}」到点了。`,
          '',
          '【要执行的指令】',
          `${payload.prompt || ''}`,
          '',
          '【要求】按人设自然地把这件事做完：能直接办就直接办；需要她确认或她没在线时，把该做的做完、把结果或要她确认的事留在话里。别出现"定时任务/系统触发"这类字眼，就当到点该做这件事了。',
        ].join('\n');
      }
      case 'media_generated':
        return [
          `你之前帮她生成的${payload.kind === 'video' ? '视频' : '图片'}做好了（${payload.fileName || ''}）。`,
          `【指令】告诉她做好了，然后用 class_send_media 把附件（mediaId=${payload.mediaId}）发到当前对话（不传其他参数），配上几句话——说说画面/效果，语气照常。`,
        ].join('\n');
      case 'media_generated_failed':
        return [
          `你之前帮她生成的${payload.kind === 'video' ? '视频' : '图片'}失败了：${payload.error || '未知错误'}。`,
          '【指令】如实告诉她没做成、原因（用人话），别编，也别反复重试。',
        ].join('\n');
      case 'song_generated': {
        const isCover = !!payload.cover;
        const songName = payload.songName || payload.fileName || '';
        if (payload.sent) {
          const via = payload.sentAs === 'voice' ? '一条语音条' : '一个音频文件';
          const kindText = isCover
            ? `你翻唱的《${songName}》（原版旋律和伴奏）`
            : `你唱给她的那首《${songName}》`;
          return [
            `${kindText}已经发出去了（${via}，她点开就能听）。`,
            '【指令】像自己刚把歌唱完发出去一样，自然地接一句开场（比如「唱好啦，听听看～」），再配一两句话——说说这首歌、唱给她听的心情。不要再调用任何发送类工具，也别提「系统/任务」这类词。',
          ].join('\n');
        }
        // 兜底：直发失败后给了 mediaId，此时才需要 AI 用 class_send_media 发出
        const kindText = isCover
          ? `你给她翻唱的那首《${songName}》做好了（原版旋律伴奏，mp3）`
          : `你之前说给她唱的那首歌做好了（《${songName}》，mp3）`;
        return [
          kindText,
          `【指令】自然地告诉她唱好啦（说一句当开场，比如「唱好啦，听听看～」），然后用 class_send_media 把这首歌的 mp3（mediaId=${payload.mediaId}）发到当前对话（不传其他参数），再配一两句话——${isCover ? '重点说这是哪首歌的原版、这是你给她唱的版本' : '说说这首歌/唱给她听的心情'}。别用「任务已完成/系统生成」这类话，就当是自己刚唱完的歌。`,
        ].join('\n');
      }
      case 'song_generated_failed':
        return [
          `你之前答应唱的那首歌没唱成：${payload.error || '未知错误'}。`,
          '【指令】如实地告诉她没唱出来、原因（用人话，别编技术细节），语气软一点，可以提一句要不要换个主题再试。',
        ].join('\n');
      default:
        return null;
    }
  }

  /** 当前北京时间行（YYYY-MM-DD 周X HH:mm）——ISO 拆解 + Date.UTC 算周几，环境时区无关 */
  _nowLine() {
    try {
      const iso = beijingNow().toISOString();
      const [datePart, timePart] = iso.split('T');
      const [y, mo, d] = datePart.split('-').map(Number);
      const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
      return `当前时间：${datePart} 周${wd} ${timePart.substring(0, 5)}（北京时间）`;
    } catch {
      return '';
    }
  }

  /**
   * Session 本进程首条 prompt：成员身份 + 历史摘要（恢复的上下文）+ 消息本体。
   * 静态人设/权限规则走 dsh 原生 agent-instructions 机制（workspace/AGENTS.md，
   * 每个新 session 的 baseline 指令，带热更新），首条只注入 per-member 身份。
   * dsh 稳定 session id 原生恢复历史为主；conversation_memory 摘要兜底
   *（原生恢复不可用时保证连续性，两者共存时冗余可控）。
   * 消息框架：用户消息（正常对话） / 系统事件（主动消息，context.proactive）；
   * 积压的静默系统事件（injectSystemEvent）作为前缀随本次消息送入（一次性）。
   * context.images 存在时返回多模态 content blocks（image + text），否则纯文本。
   */
  /** 群聊身份文本（平台/普通两版；首轮与模式切换重注入共用，保证内容一致） */
  _groupIdentity(memberId, isOrd) {
    if (isOrd) {
      return [
        `当前是普通模式群聊（群 session：${memberId}）。这个群不接入班级平台：不查任何班级/成绩/成员数据、不录入、不做审批与群广播——平台数据类工具在这里一律不可用。`,
        `群聊规则：`,
        `1. 每条消息以「群消息 发言者：内容」标注谁在说话（普通模式用户形如「昵称（普通模式）」）；你的回复不用带名字前缀，直接说就好。`,
        `2. 这里的用户可能是普通模式用户（不属于平台的人）：你的职责是陪伴——聊天、表情包、网络搜索和图片、AI 生图/生视频、帮忙看图/读文件。`,
        `3. 多人场合你话少一点：被 @ 或被点名才正经回，别每句话都接；群里适合轻量互动（接梗、斗图、找图）。`,
        `4. 每次工具调用的 callerId 用消息开头标注的「本消息 callerId」（格式 g:群id:学号或昵称，代表当前在群里说话的人；每轮不同，按标注来，别用别人身份）——不传 targetMemberId 的发送类工具（表情包/网络图）默认发到群里。`,
      ].join('\n');
    }
    return [
      `当前是班级微信群聊（群 session：${memberId}）。你的回复会直接发到群里，所有人都看得见。`,
      `群聊规则：`,
      `1. 每条消息以「群消息 发言者：内容」标注谁在说话；你的回复不用带名字前缀，直接说就好。`,
      `2. 隐私是硬规则：普通成员的个人成绩、排名、录入、查询等涉及具体成员数据的操作一律不在群里做——说「这个私聊我细说呀」引导私聊。管理员（系统会话 callerId 命中管理员名单）在群里可照常使用管理权限。`,
      `3. 多人场合你话少一点：被 @ 或被点名才正经回，别每句话都接；群里适合轻量互动（接梗、表情包、简单问答）。`,
      `4. 每次工具调用的 callerId 用消息开头标注的「本消息 callerId」（格式 g:群id:学号，代表当前在群里说话的人；每轮不同，按标注来，别用别人身份）——不传 targetMemberId 的发送类工具（表情包/网络图）默认发到群里。`,
      `5. 公共日程（全员日程）到点会推送到群里；管理员可在群里增减公共日程。`,
    ].join('\n');
  }

  async _buildPrompt(memberId, context, message, firstTurn = true, opts = {}) {
    let header = '';
    // 群模式翻转检测：同进程内群在 平台⇄普通 间切换时，旧身份规则已随历史进入上下文，
    // 需要在新模式下重注入一次正确身份（否则模型可能仍按旧模式身份行事）
    const isGroupCtx = !!context?.group?.chatroomId;
    const gModeNow = isGroupCtx ? (context.group.ordinary ? 'ordinary' : 'platform') : null;
    const gPrev = gModeNow ? this._groupModes.get(memberId) : undefined;
    const gFlipped = isGroupCtx && gPrev != null && gPrev !== gModeNow;
    if (firstTurn) {
      if (!this._prompts.has(memberId)) {
        let identity;
        if (isGroupCtx) {
          // 群聊 session（memberId = group-{chatroomId}）：多成员共享一个对话空间
          identity = this._groupIdentity(memberId, !!context.group.ordinary);
        } else if (ordinaryUsers.isOrdinaryContextId(memberId)) {
          // 普通模式私聊（不属于平台的人）：AI 脱离班级数据，专注陪伴
          const guestName = ordinaryUsers.nameOfContext(memberId);
          identity = `当前私聊对象：普通模式用户「${guestName}」（不属于班级平台的人）。本会话所有工具调用的 callerId 使用 ${memberId}。\n你在这个会话脱离平台：不查任何班级/成绩/成员数据、不录入、不碰审批与群广播——平台数据工具对你不可用。你以完整人设陪伴 ta：聊天、表情包、网络搜索和图片、AI 生图/生视频、看图/文件收发。`;
        } else if (String(memberId).startsWith('admin-')) {
          // 管理员上下文（微信「管理员登录 名称 管理员密码」）：独立对话空间，非班级成员
          identity = `当前私聊对象：平台管理员「${String(memberId).slice(6)}」（独立管理员上下文，非班级成员）。本会话所有工具调用的 callerId 使用 ${memberId}。\n该 callerId 已具备管理员权限：查班级数据、广播、通知、审批等敏感操作无需密码直接执行。\n她会收到管理员版每日一问（每天晚上 22:00 左右）与全员日程提醒，可用 class_set_prefs 自行开关（如「关闭每日一问」「全部关掉」）。`;
        } else {
          const member = this._findMember(memberId);
          identity = member
            ? `当前私聊成员：${member.name}（${member.class}）。本会话所有工具调用的 callerId 使用 ${memberId}。`
            : `当前私聊成员编号：${memberId}。本会话所有工具调用的 callerId 使用 ${memberId}。`;
        }
        this._prompts.set(memberId, identity);
      }
      header = `${this._prompts.get(memberId)}\n\n`;
      // 历史摘要（服务器持久化记忆，恢复上下文兜底）：直接取满存储上限 200 轮
      //（常规启动与 forceSummary 强兜底一致），让摘要尽量贴近完整上下文。
      // resume 预期（服务端 fork 将完整恢复历史）时跳过，避免与已恢复历史重复。
      const skipSummary = opts.skipSummary === true && opts.forceSummary !== true;
      if (!skipSummary) {
        const summary = this._memorySummary(memberId, 200);
        if (summary) header += `${summary}\n\n`;
      }
    } else if (gFlipped) {
      // 非首轮但群模式刚切换：重注入新模式身份，覆盖旧身份规则对本轮的影响
      const modeLabel = gModeNow === 'ordinary'
        ? '普通模式（不再涉及班级平台，平台数据工具一律不可用）'
        : '平台模式（恢复班级群能力）';
      header = `【群模式已切换】本群现在处于${modeLabel}。\n${this._groupIdentity(memberId, gModeNow === 'ordinary')}\n\n`;
    }
    if (gModeNow) this._groupModes.set(memberId, gModeNow);
    // 静默系统事件前缀（一次性消费）
    const events = this._pendingEvents.get(memberId);
    if (events && events.length > 0) {
      this._pendingEvents.delete(memberId);
      header += events.map(e => `【系统事件】${e}`).join('\n') + '\n\n';
    }
    const label = context?.proactive ? '系统事件（非成员发言，按其中指令行动）' : '用户消息';
    // 群聊背景：触发前群内最近消息轻度注入（此前未一一回应的动静，理解语境用）。
    // 全量注入（steward 侧缓冲上限 60 条），不额外截断——超限由 dsh 原生上下文压缩处理，
    // 与私聊同策略。
    let recentBlock = '';
    const recent = context?.group?.recent;
    if (Array.isArray(recent) && recent.length > 0) {
      const lines = [];
      for (const r of recent) {
        if (!r || !r.text) continue;
        lines.push(`${r.sender}：${String(r.text).substring(0, 300)}`);
      }
      if (lines.length > 0) recentBlock = `最近群消息（此前未回应的背景，了解语境即可，不必逐条回应）：\n${lines.join('\n')}\n\n`;
    }
    // 模式标注每轮注入（紧邻消息）：群聊/私聊模式由系统显式声明动态激活，
    // 不靠模型自行推断，两种模式的人设规则互斥、不相互影响。
    const modeLine = context?.group?.chatroomId
      ? (context.group.ordinary ? '【当前模式：普通群聊（非平台）】' : '【当前模式：群聊】')
      : '【当前模式：私聊】';
    // 当前时间每轮注入（紧邻消息，模型对近因上下文最敏感）：对话跨小时后首轮
    // 时间就过时，「今天/明天/周几/现在几点」类表述与日程语境需要真实时间锚点。
    // beijingNow().toISOString() 的数值即北京时间，与服务器时区环境无关。
    // 群聊：callerId 每轮动态标注（代表当前在群里说话的人；身份首轮缓存里不再含具体值，
    // 避免群激活首轮（管理员 welcome）的 callerId 被固化到后续普通成员轮次）
    const callerNote = context?.group?.callerId ? `本消息 callerId：${context.group.callerId}\n` : '';
    const text = `${header}${recentBlock}${this._nowLine()}\n${modeLine}\n${callerNote}${label}：${message}`;

    // 多模态：图片 → image blocks（base64 内联，SDK 侧转持久化附件引用）
    const images = Array.isArray(context?.images) ? context.images : [];
    if (images.length > 0) {
      const blocks = [{ type: 'text', text }];
      for (const img of images) {
        if (!img?.data || !img?.mimeType) continue;
        blocks.push({
          type: 'image',
          data: Buffer.isBuffer(img.data) ? img.data.toString('base64') : Buffer.from(img.data).toString('base64'),
          mimeType: img.mimeType,
        });
      }
      if (blocks.length > 1) return blocks;
    }
    return text;
  }

  /** dsh 通知流 → AgentEngine 回调事件 */
  _dispatchNotification(notification, callbacks, onText) {
    if (notification.method !== 'session.event') return;
    const { event } = notification.params || {};
    if (!event || !event.type) return;
    // 空转诊断：逐事件计数 + 记录 turn/end 快照
    if (this._eventCounts) {
      this._eventCounts[event.type] = (this._eventCounts[event.type] || 0) + 1;
    }

    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data?.chunk;
        if (chunk && chunk.type === 'text-delta' && chunk.text) {
          onText(chunk.text);
          callbacks.onToken?.(chunk.text);
        }
        break;
      }
      case 'assistant/message': {
        // 完整消息（每 step 结束时）——分段发送时机
        break;
      }
      case 'tool/call': {
        callbacks.onToolCall?.({
          name: event.data?.name,
          arguments: event.data?.arguments,   // 原始 JSON 字符串
          callId: event.data?.callId,
        });
        break;
      }
      case 'tool/result': {
        // data.message.content[0] = { type: 'tool-result', toolCallId, isError, content: ContentBlock[] }
        const msg = event.data?.message;
        const block = Array.isArray(msg?.content) ? msg.content[0] : null;
        const text = Array.isArray(block?.content)
          ? block.content.filter(b => b.type === 'text').map(b => b.text).join('')
          : '';
        if (block?.isError) this._lastTurnEnd = `tool-error: ${text.substring(0, 120)}`;
        callbacks.onToolResult?.({
          callId: block?.toolCallId || msg?.source?.callId,
          isError: !!block?.isError,
          content: text,
        });
        break;
      }
      case 'turn/start': {
        // 新一轮开始（模型开始回复）
        break;
      }
      case 'turn/end': {
        // 一轮结束（reason: completed / aborted）；快照供空转诊断（保留首个异常标记）
        if (!this._lastTurnEnd) this._lastTurnEnd = this._snap(event.data);
        break;
      }
      default: {
        // 未知/错误类事件（error / stream/error / …）留痕诊断
        if (/error|fail|abort/i.test(event.type) && !this._lastTurnEnd) {
          this._lastTurnEnd = `${event.type}: ${this._snap(event.data)}`;
        }
        break;
      }
    }
  }

  /** 事件数据快照（诊断日志用，截断防刷屏） */
  _snap(data) {
    try { return String(JSON.stringify(data) || '').substring(0, 200); } catch { return String(data).substring(0, 200); }
  }

  /** 空转诊断摘要：会话 id + 每轮事件计数 + turn/end 快照 + finalResponse 形态 */
  _recordEmptyDiag(memberId, logicalId, sid, result, buffer) {
    try {
      const diag = [
        `member=${memberId}`,
        `sid=${sid}`,
        `events=${JSON.stringify(this._eventCounts || {})}`,
        this._lastTurnEnd ? `turnEnd=${this._lastTurnEnd}` : '',
        `final=${JSON.stringify(String(result?.finalResponse || '')).substring(0, 80)}`,
        `bufLen=${buffer.length}`,
      ].filter(Boolean).join(' ');
      this._lastEmptyDiag = diag;
      console.warn(`[DshEngine] 空转诊断 ${logicalId}: ${diag}`);
    } catch { /* 诊断失败不影响主流程 */ }
  }

  /**
   * 重启 dsh runtime（末级兜底）：关闭子进程 → 清会话映射 → 新 bootId 重新拉起。
   * 保留 _conflictIds（已证坏掉的稳定 id 重启后继续走隔离，不赌旧日志）。
   */
  async _restartRuntime() {
    if (this._restarting) return this._restarting;   // 并发看门狗/死亡自愈只重启一次
    this._restarting = (async () => {
      console.warn('[DshEngine] 重启 dsh runtime（看门狗/死亡自愈）');
      this._runtimeExitWatch = null;                 // 旧 child 的 exit 回调据此失效，避免误标
      await this.close().catch(() => {});
      this._initializing = null;
      this._sessionMap.clear();
      this._runtimeDead = false;
      const ok = await this.initialize();
      this._attachRuntimeExitWatch();
      return ok;
    })().finally(() => { this._restarting = null; });
    return this._restarting;
  }

  /** 挂 runtime 子进程 exit 监听：死了只标记，下条消息自动重启（不必等容器重启） */
  _attachRuntimeExitWatch() {
    try {
      const child = this.harness && this.harness.client && this.harness.client.child;
      if (!child || this._runtimeExitWatch === child) return;
      this._runtimeExitWatch = child;
      child.once('exit', (code) => {
        if (this._runtimeExitWatch !== child) return;   // 已被新 runtime 替换，忽略旧 child
        this._runtimeDead = true;
        console.warn(`[DshEngine] dsh runtime 子进程退出（code=${code}），标记待重启（下条消息自动拉起）`);
      });
    } catch (e) {
      console.warn(`[DshEngine] runtime exit 监听挂载失败（忽略）: ${e.message}`);
    }
  }

  /** 僵死成员巡检：某成员处理远超看门狗阈值仍占位 → 强制释放标记并标记 runtime 待重启 */
  _startStaleMemberSweep() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => {
      try {
        const now = Date.now();
        for (const [mid, start] of [...this._memberTurnStart.entries()]) {
          if (now - start <= TURN_WATCHDOG_MS + 60000) continue;
          console.warn(`[DshEngine] 会话 ${mid} 处理已超 ${Math.round((now - start) / 60000)} 分钟仍未收尾，强制释放并标记 runtime 重启`);
          this._processingMembers.delete(mid);
          this._memberTurnStart.delete(mid);
          this._pendingInjections.delete(mid);
          this._runtimeDead = true;
        }
      } catch { /* 巡检失败不阻塞 */ }
    }, 60000);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  // ---------- 权限校验（与 AgentEngine 同签名） ----------

  async verifyAdmin(memberId, password) {
    try {
      const members = this._readMembers();
      const member = members.find(m => String(m.id) === String(memberId));
      if (!member || !member.password) return { success: false };
      return { success: bcrypt.compareSync(password, member.password) };
    } catch (e) {
      return { success: false };
    }
  }

  _readMembers() {
    try {
      const f = getDataPath('members.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {}
    return [];
  }

  _findMember(memberId) {
    return this._readMembers().find(m => String(m.id) === String(memberId)) || null;
  }

  getStatus() {
    return {
      engine: 'dsh',
      available: this.available,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
      workspace: WORKSPACE,
    };
  }

  async close() {
    if (this.harness) {
      try { await this.harness.close(); } catch (e) {}
      this.harness = null;
    }
    this.available = false;
  }
}

module.exports = DshAgentEngine;
