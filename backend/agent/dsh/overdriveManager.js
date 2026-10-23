/**
 * overdriveManager —— 超限会话 runtime 管理器（Phase2）
 *
 * 每个开启超限的会话（群/私聊）按需拉起一个 overdriveWorker 子进程：
 *  - 独立 DSH_ENGINE_WORKSPACE/HOME_DIR → 独立工作区/home/会话/浏览器，天然隔离；
 *  - 单 scope 单轮串行：忙时新消息经 worker 引擎 inject（user 注入 → 引擎 drain
 *    在本轮结束后自动作为下一轮输入消化），与主引擎的队列语义一致，不丢消息；
 *  - 空闲（30min，与 overdriveState 阈值一致）自动回收释放内存；
 *  - 并发上限 MAX_CONCURRENT=3，超出对新区请求快速失败提示。
 *
 * 帧协议见 overdriveWorker.js：请求 id 关联；'text' 帧逐行回调（可立即发微信），
 * 'done'/'error'/'ack' 终结。pending 上下文（切换摘要/打破事件）随下一条 process
 * 帧由 worker 作为引擎系统事件注入，冷启动缓解与复读打破共用此通道。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getDataDir } = require('../../utils/dataPath');
const overdrive = require('../../utils/overdriveState');

const MAX_CONCURRENT = Number(process.env.DSH_OVERDRIVE_MAX || 3);
const IDLE_RECYCLE_MS = overdrive.IDLE_RECYCLE_MS || 30 * 60 * 1000;
const CLOSED_RECYCLE_MS = 5 * 60 * 1000;          // 已关闭超限 → 5 分钟未活跃即回收
const PING_TIMEOUT_MS = 120000;                    // worker 首次 ping
const INJECT_TIMEOUT_MS = 15000;                   // inject 帧（引擎忙时排队也应很快）
// 单轮「静默」阈值（注意：不是总时长上限）。worker 在轮内每 30s 发一次心跳帧，
// 有模型输出也续期——只要它还活着就一直续；只有连续这么久「无输出、无心跳」才判卡死。
// 这样长任务不再被 10 分钟总时长误杀（取消原先的单轮总时长限制）。
const TURN_TIMEOUT_MS = Number(process.env.DSH_OVERDRIVE_TURN_TIMEOUT_MS || 10 * 60 * 1000);

/** 会话 key → 安全目录名 */
function safeName(scopeKey) {
  return String(scopeKey).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** 引擎侧 member 标识：群 = group-{chatroomId}；私聊/主动 = memberId */
function engineMemberKey(kind, scopeKey) {
  return kind === 'group' ? `group-${scopeKey}` : String(scopeKey);
}

class OverdriveManager {
  constructor() {
    this.workers = new Map();       // scopeKey → worker 句柄
    this._pendingContexts = new Map(); // scopeKey → [string]（下一条 process 注入的引擎事件）
    this._stateBumpAt = new Map();  // scopeKey → 状态层活跃刷新的上次时间（节流用）
    this._sweepTimer = null;
  }

  /** 超限工作区根：{dataDir}/overdrive/workspaces/{scopeKey}（持久化卷） */
  workspaceRoot(scopeKey) {
    return path.join(getDataDir(), 'overdrive', 'workspaces', safeName(scopeKey));
  }

  homeDir(scopeKey) {
    return path.join(getDataDir(), 'overdrive', 'homes', safeName(scopeKey));
  }

  /** 全局共享依赖缓存（各超限 runtime 共用，避免重复下载） */
  sharedCacheDir() {
    return path.join(getDataDir(), 'overdrive', 'shared-cache');
  }

  _ensureDirs(scopeKey) {
    fs.mkdirSync(this.workspaceRoot(scopeKey), { recursive: true });
    fs.mkdirSync(this.homeDir(scopeKey), { recursive: true });
    for (const sub of ['npm', 'ms-playwright', 'pip', 'uv']) {
      fs.mkdirSync(path.join(this.sharedCacheDir(), sub), { recursive: true });
    }
    // 共享 bin：各超限会话全局安装的 CLI 工具落点（纳入 PATH，跨会话直接命令调用）
    fs.mkdirSync(path.join(this.sharedCacheDir(), 'bin'), { recursive: true });
  }

  /**
   * 启动定时回收（每 5 分钟：空闲超阈/已关闭的 worker 回收，保留工作区与记录）。
   */
  startSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.sweep().catch(() => {}), 5 * 60 * 1000);
    this._sweepTimer.unref?.();
  }

  _bindChild(scopeKey, kind) {
    if (this.workers.size >= MAX_CONCURRENT) {
      return { error: `超限会话已满（同时最多 ${MAX_CONCURRENT} 个）。稍后再试，或让某个会话 关闭超限。` };
    }
    this._ensureDirs(scopeKey);
    const workerFile = path.join(__dirname, 'overdriveWorker.js');
    const cache = this.sharedCacheDir();
    const child = spawn(process.execPath, [workerFile], {
      cwd: this.workspaceRoot(scopeKey),
      env: {
        ...process.env,
        // 超限 worker：全量原生（主引擎默认禁用）+ 浏览器自动化 + 独立工作区/home
        DSH_ENGINE_FULL_NATIVE: '1',
        DSH_BROWSER: '1',
        // 文件权限全放：dsh 三档模式无"工作区+共享目录"粒度，且 ask 审批在微信
        // 无人值守下会卡死，故不让 dsh 沙箱档位拦 AI；越界（非本会话工作区/共享
        // 目录）的写操作由手动边界守卫（DshAgentEngine pre-execute guard）拦截。
        DSH_PERMISSION_MODE: 'danger-full-access',
        // 手动守卫的允许写根：会话工作区 + 共享缓存目录（npm/playwright/pip/uv）
        DSH_ALLOW_WRITE_ROOTS: [this.workspaceRoot(scopeKey), this.homeDir(scopeKey), cache].join(path.delimiter),
        DSH_ENGINE_WORKSPACE: this.workspaceRoot(scopeKey),
        DSH_ENGINE_HOME_DIR: this.homeDir(scopeKey),
        // 会话归属兜底：dm/proactive payload 万一缺 memberId 时，worker 用它当
        // 默认会话身份（防 member-undefined 空会话再出现）
        DSH_OVERDRIVE_SCOPE_KEY: String(scopeKey),
        // 转发 dsh runtime 子进程 stderr 到服务日志（排障关键：cordis 启动首错/插件栈）
        DSH_FWD_HARNESS_STDERR: process.env.DSH_FWD_HARNESS_STDERR === '0' ? '0' : '1',
        // 依赖统一路径：各超限 runtime 共享同一份缓存，避免重复下载
        npm_config_cache: path.join(cache, 'npm'),
        PLAYWRIGHT_BROWSERS_PATH: path.join(cache, 'ms-playwright'),
        PIP_CACHE_DIR: path.join(cache, 'pip'),
        UV_CACHE_DIR: path.join(cache, 'uv'),
        // 共享环境：所有系统环境基本都落在共享目录且已加入 PATH——
        // ① 共享 bin（全局 CLI 落点 + PATH 前置）；② npm 全局前缀指到共享 bin
        DSH_SHARED_CACHE_DIR: cache,
        PATH: [path.join(cache, 'bin'), path.join(cache, 'npm', 'node_modules', '.bin'), process.env.PATH || '']
          .filter(Boolean).join(path.delimiter),
        npm_config_prefix: path.join(cache, 'bin'),
        // 全新 per-会话 home 首次要装 profile 依赖 + bootstrap dsh runtime → 放宽初始化时限
        DSH_INIT_TIMEOUT_MS: String(Number(process.env.DSH_INIT_TIMEOUT_MS || 5 * 60 * 1000)),
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const handle = {
      scopeKey,
      kind,
      child,
      nextId: 1,
      pending: new Map(),       // opId → { onFrame, timer }
      busy: false,              // 是否有 process 轮在跑（串行闸）
      lastActive: Date.now(),
    };
    this.workers.set(scopeKey, handle);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = handle.pending.get(msg.id);
        if (!waiter) continue;
        if (msg.kind === 'text') {
          if (waiter.onText) waiter.onText(String(msg.text || ''));
          if (waiter.rearm) waiter.rearm();  // 有输出 = 活着 → 续期静默看门狗
          continue;                       // 流式帧不终结
        }
        if (msg.kind === 'beat') {
          if (waiter.rearm) waiter.rearm();  // worker 心跳 → 续期（长工具调用期间无 token 也不误杀）
          continue;                          // 心跳不终结
        }
        clearTimeout(waiter.timer);
        handle.pending.delete(msg.id);
        if (waiter.onDone) waiter.onDone(msg);
      }
    });
    child.on('exit', () => {
      // 进程退出 → 拒绝挂起请求，移除表项
      for (const [, waiter] of handle.pending) {
        clearTimeout(waiter.timer);
        if (waiter.onDone) waiter.onDone({ ok: false, kind: 'error', error: '超限引擎进程已退出' });
      }
      handle.pending.clear();
      if (this.workers.get(scopeKey) === handle) this.workers.delete(scopeKey);
    });
    child.on('error', (e) => {
      console.error(`[Overdrive] worker 启动失败 ${scopeKey}:`, e.message);
    });
    return { handle };
  }

  /** 拉取/复用某超限会话的 worker 句柄（并发上限内）。失败返回 { error } */
  async _ensureHandle(scopeKey, kind) {
    const existing = this.workers.get(scopeKey);
    if (existing) {
      existing.lastActive = Date.now();
      if (!existing.kind) existing.kind = kind;
      return { handle: existing };
    }
    const r = this._bindChild(scopeKey, kind);
    if (r.error) return { error: r.error };
    const handle = r.handle;
    try {
      await this._request(handle, 'ping', {}, PING_TIMEOUT_MS);
    } catch (e) {
      this._teardown(handle, '启动失败');
      return { error: `超限引擎启动失败: ${e.message || e}` };
    }
    console.log(`[Overdrive] 超限 worker 就绪: ${scopeKey}（并发 ${this.workers.size}/${MAX_CONCURRENT}）`);
    return { handle };
  }

  /** 发送一个请求帧并等待终结帧；stream 期间 'text' 帧走 callbacks.onText，'beat' 帧续期 */
  _request(handle, op, payload, timeoutMs = TURN_TIMEOUT_MS, callbacks = {}) {
    return new Promise((resolve) => {
      const id = handle.nextId++;
      const waiter = { onText: callbacks.onText, onDone: resolve, timer: null, rearm: null };
      const arm = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.timer = setTimeout(() => {
          handle.pending.delete(id);
          // 关键：超时只让调用方「不再等」是不够的——worker 里那一轮还在跑。必须连
          // worker 一起回收，否则卡死的旧轮会和新轮并发叠在同一 session 上（僵尸轮 →
          // 后续全超时/静默，只能重启容器）。仅 process 轮回收；ping/inject 超时不杀。
          if (op === 'process') {
            try { this._teardown(handle, `单轮静默超时（${Math.round(timeoutMs / 60000)} 分钟无输出无心跳）`); } catch { /* 忽略 */ }
          }
          resolve({ ok: false, kind: 'error', error: `超限引擎响应超时（${op}）` });
        }, timeoutMs);
      };
      waiter.rearm = arm;
      arm();
      handle.pending.set(id, waiter);
      handle.child.stdin.write(JSON.stringify({ id, op, payload }) + '\n');
    });
  }

  /** 关停句柄（杀进程 + 清表项 + 清待注入上下文 + 清理过期截图残留） */
  _teardown(handle, reason) {
    console.log(`[Overdrive] 回收 worker: ${handle.scopeKey}（${reason}）`);
    this.workers.delete(handle.scopeKey);
    this._pendingContexts.delete(String(handle.scopeKey));
    try {
      const scr = path.join(this.workspaceRoot(handle.scopeKey), '.dsh', 'playwright');
      if (fs.existsSync(scr)) {
        const now = Date.now();
        for (const f of fs.readdirSync(scr)) {
          const fp = path.join(scr, f);
          try {
            const st = fs.statSync(fp);
            if (st.isFile() && now - st.mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(fp); // 截图保留 1 天
          } catch { /* 忽略单个失败 */ }
        }
      }
    } catch { /* 清理失败不阻塞回收 */ }
    handle.child.kill('SIGTERM');
  }

  /** 状态层活跃刷新（节流 ≤1/分钟）：长轮里 AI 持续输出不会把"仍开启"的会话误判闲置 */
  _bumpState(stateKind, key) {
    const now = Date.now();
    const last = this._stateBumpAt.get(String(key)) || 0;
    if (now - last >= 60000) {
      this._stateBumpAt.set(String(key), now);
      try { overdrive.markActive(stateKind, key); } catch { /* 状态写失败不阻塞对话 */ }
    }
  }

  /** 单 scope 回收扫描：仍开启的会话 30 分钟无新消息（用户或 AI 输出）→ 只停 worker、模式保持；
   *  已明确"关闭超限"的会话 → 5 分钟快速回收（用户已退出，尽快释放内存）。 */
  async sweep() {
    const now = Date.now();
    const enabledKeys = new Set(overdrive.listEnabled().map((r) => r.scopeKey));
    for (const [key, w] of [...this.workers.entries()]) {
      const idleMs = now - (w.lastActive || now);
      if (w.busy) continue;              // 轮次进行中（含长任务 AI 输出）不算闲置
      const closedIdle = !enabledKeys.has(key) && idleMs > CLOSED_RECYCLE_MS;
      if (closedIdle || idleMs > IDLE_RECYCLE_MS) {
        this._teardown(w, `闲置 ${Math.round(idleMs / 60000)} 分钟（模式保持，下条消息自动再拉起）`);
      }
    }
  }

  /** 给某超限会话预置一条"引擎事件"（切换摘要/防复读打破），随下一条消息注入 */
  pushContext(kind, scopeKey, text) {
    if (!text) return;
    const key = String(scopeKey);
    if (!this._pendingContexts.has(key)) this._pendingContexts.set(key, []);
    this._pendingContexts.get(key).push(String(text));
  }

  _takePendingContext(scopeKey) {
    const arr = this._pendingContexts.get(String(scopeKey));
    if (!arr || arr.length === 0) return [];
    this._pendingContexts.delete(String(scopeKey));
    return arr;
  }

  /** 清空某超限会话的待注入上下文（关闭超限/回收时防陈旧摘要/打破事件串到下次开启） */
  clearContext(scopeKey) {
    this._pendingContexts.delete(String(scopeKey));
  }

  isProcessing(scopeKey) {
    const w = this.workers.get(String(scopeKey));
    return !!(w && w.busy);
  }

  isReady(scopeKey) {
    return this.workers.has(String(scopeKey));
  }

  workerCount() {
    return this.workers.size;
  }

  listWorkers() {
    return [...this.workers.values()].map((w) => ({
      scopeKey: w.scopeKey,
      kind: w.kind || null,
      busy: w.busy,
      idleMs: Date.now() - w.lastActive,
    }));
  }

  /**
   * 超限会话处理一条消息/事件。忙时自动转 worker 引擎 inject（user 注入，
   * 本轮结束由引擎 drain 作为下一轮消化），返回 { queued:true } 不阻塞调用方。
   * @param {object} payload 见 overdriveWorker：kind=dm/group/proactive + 会话参数
   * @param {{onText?:Function}} callbacks onText(text) 逐行回调（可立即发微信）
   * @returns {Promise<{ok, queued?, content?, error?}>}
   */
  async process(kind, scopeKey, payload, callbacks = {}) {
    const key = String(scopeKey);
    // proactive 是私聊会话的一种事件形态：状态/成员标识都按 dm 记
    const stateKind = kind === 'proactive' ? 'dm' : kind;
    const ensure = await this._ensureHandle(key, stateKind);
    if (ensure.error) return { ok: false, error: ensure.error };
    const handle = ensure.handle;
    handle.lastActive = Date.now();
    overdrive.markActive(stateKind, key);
    // 活跃刷新：用户消息与 AI 输出（text 帧）都会刷新闲置计时
    const touch = () => {
      handle.lastActive = Date.now();
      this._bumpState(stateKind, key);
    };
    touch();

    // 忙：先走注入路径（引擎 drain 消化 → 语义等同主引擎队列）。
    // 注意：此时不能取 pendingContext——它属于下一条"真正开跑的轮次"，
    // 若被取走却未随 process 发出就会丢。
    if (handle.busy) {
      const member = engineMemberKey(kind, key);
      // 群消息需带发言者标注（injectText 由 steward 组好），私聊直接用 text
      const text = payload && (payload.injectText || payload.text);
      if (text) {
        const inj = await this._request(handle, 'inject',
          { type: 'user', member, text: String(text) }, INJECT_TIMEOUT_MS).catch(() => null);
        if (inj && inj.ok) return { ok: true, queued: true, injected: true };
        // 注入失败（如引擎恰好已收尾）：若已不再忙则直接开新一轮；否则并入 pending
        if (!handle.busy) { /* fallthrough 到下方开轮 */ }
        else {
          this.pushContext(kind, key, `【等待处理的消息】${text}`);
          return { ok: true, queued: true };
        }
      } else {
        // 无文本载荷（异常）→ 并入 pending，避免丢失
        this.pushContext(kind, key, `【等待处理的事件】${JSON.stringify(payload || {}).substring(0, 300)}`);
        return { ok: true, queued: true };
      }
    }

    // 引擎空闲 → 真正开跑：带上下待注入的引擎事件（切换摘要/防复读打破/兜底消息）
    const pending = this._takePendingContext(key);
    const procPayload = { ...payload, kind, pending };
    handle.busy = true;
    try {
      const done = await this._request(handle, 'process', procPayload, TURN_TIMEOUT_MS, {
        onText: (t) => {
          touch();                              // AI 每行输出都算活动
          if (callbacks.onText) callbacks.onText(t);
        },
      });
      handle.lastActive = Date.now();
      if (!done.ok) return { ok: false, error: done.error || '超限引擎处理失败' };
      return { ok: true, content: done.content || '' };
    } finally {
      handle.busy = false;
    }
  }

  /** 向某超限会话注入静默系统事件（引擎忙/空闲均可，下一条 prompt 消费） */
  async injectEvent(kind, scopeKey, text) {
    const handle = this.workers.get(String(scopeKey));
    if (!handle) { this.pushContext(kind, scopeKey, text); return { ok: true, deferred: true }; }
    const member = engineMemberKey(kind, String(scopeKey));
    const r = await this._request(handle, 'inject', { type: 'event', member, text: String(text) }, INJECT_TIMEOUT_MS)
      .catch(() => ({ ok: false }));
    if (!r || !r.ok) { this.pushContext(kind, scopeKey, text); return { ok: true, deferred: true }; }
    return { ok: true, accepted: !!r.accepted };
  }

  /** 关闭指定超限 worker（保留工作区；忙时由调用方自行等待或跳过） */
  async release(scopeKey) {
    const w = this.workers.get(String(scopeKey));
    if (!w) return;
    if (w.busy) return { busy: true };
    this._teardown(w, '手动释放');
    return { ok: true };
  }

  /** 全量关停（进程退出用）：先温柔 shutdown，忙/无响应 2s 后强制 SIGTERM */
  async closeAll() {
    const entries = [...this.workers.entries()];
    await Promise.allSettled(entries.map(async ([key, w]) => {
      try {
        await Promise.race([
          this._request(w, 'shutdown', {}, 2000).catch(() => {}),
          new Promise((r) => setTimeout(r, 2500)),
        ]);
      } catch { /* 忽略 */ }
      this.workers.delete(key);
      w.child.kill('SIGTERM');
    }));
    // 兜底：仍存活的直接杀掉（worker 自身有 SIGTERM → exit）
    setTimeout(() => {
      for (const [, w] of [...this.workers.entries()]) {
        this.workers.delete(w.scopeKey);
        w.child.kill('SIGTERM');
      }
    }, 1500).unref?.();
  }
}

module.exports = { OverdriveManager, MAX_CONCURRENT, engineMemberKey };
