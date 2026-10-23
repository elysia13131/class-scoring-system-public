/**
 * generateServerFork.js —— 生成 steward-jsonrpc-server（dsh SDK server 的 resume 补丁 fork）
 *
 * 为什么：dsh SDK JSON-RPC 协议只有 initialize/session/prompt/shutdown，服务端
 * createSession 只调 AgentRegistry.create（永远新建空会话）——磁盘持久化日志
 * （$DSH_HOME/sessions/，zstd JSONL）写了但 SDK 路径从不读，导致重启后上下文
 * 只能靠 conversation_memory 摘要兜底，无法完整恢复。
 *
 * 怎么做：fork @deepseek-ai/dsh-sdk-jsonrpc-server，把 createSession 改为
 * 「有持久化日志 → agents.resume（完整恢复历史）；无日志 → create」。
 * 语义复刻 dsh-agent-loop 自带的 restoreOrCreateConfigured（try resume →
 * 失败且 id 不在 persistence.list() → create）。
 *
 * 生成方式：读已安装原包源码，锚点定位 createSession 方法（括号配对取方法体），
 * 整方法替换。不手抄整包——避免转录错误，且上游版本更新时可重新生成自愈
 * （锚点找不到时报警并保留现有 fork）。
 *
 * 生成的 fork 由 DshAgentEngine._ensureProfilePlugin 以 file: 依赖 +
 * cordis.patch.yml 挂进 profile。注意挂载方式：bundle 的 sdk-jsonrpc-server
 * 原行 disable（行覆盖不能改 name——patch 的 name 与目标行不一致时整行被
 * 静默跳过，applyEntryPatches 的 name-mismatch 守卫），fork 以独立 insert
 * 行加入（与 steward-bridge 同机制）。
 *
 * 直接运行：node generateServerFork.js（用默认 HOME_DIR 生成到 plugins/）
 */
const fs = require('fs');
const path = require('path');

const HOME_DIR = path.join(__dirname, 'home');

/** 原包 lib/index.js 的候选位置（bundle 树装在 profiles/node_modules 或 profile 本地） */
function originalCandidates(homeDir) {
  return [
    path.join(homeDir, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-server', 'lib', 'index.js'),
    path.join(homeDir, 'profiles', 'sdk', 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-server', 'lib', 'index.js'),
  ];
}

/** 补丁后的 createSession（保持原包代码风格：tab 缩进、void 0 展开） */
const PATCHED_CREATE_SESSION = `	async createSession(sessionId) {
		const agentOptions = {
			provider: this.provider,
			model: this.model,
			...this.reasoningEffort === void 0 ? {} : { reasoningEffort: this.reasoningEffort },
			...this.maxTokens === void 0 ? {} : { maxTokens: this.maxTokens }
		};
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence !== void 0) {
			try {
				const handle = await this.ctx.agents.resume({
					resumeSessionId: brandString(sessionId),
					agentOptions
				});
				const rec = { handle };
				this.sessions.set(sessionId, rec);
				console.error("[steward-jsonrpc-server] session " + sessionId + " resumed from persisted log");
				return rec;
			} catch (error) {
				const listed = await persistence.list().then((headers) => headers.some((header) => header.id === sessionId), () => false);
				if (listed) {
					console.error("[steward-jsonrpc-server] session " + sessionId + " resume failed: " + String(error && error.message || error));
					throw error;
				}
			}
		}
		const rec = { handle: await this.ctx.agents.create({
			sessionId: brandString(sessionId),
			meta: { cwd: this.cwd },
			agentOptions
		}) };
		this.sessions.set(sessionId, rec);
		return rec;
	}`;

const FORK_PACKAGE_JSON = {
  name: 'steward-jsonrpc-server',
  description: 'Fork of @deepseek-ai/dsh-sdk-jsonrpc-server with cross-process session resume (auto-resume materialized logs in createSession; steward patch)',
  version: '0.1.2-alpha.2',
  private: true,
  type: 'module',
  main: 'lib/index.js',
  exports: {
    '.': './lib/index.js',
    './package.json': './package.json',
  },
};

/**
 * 从已安装的原包生成/刷新 fork。
 * @param {{ homeDir?: string, forkDir?: string }} opts
 * @returns {{ ok: boolean, reason?: string, from?: string }}
 *   ok=false 且 reason='original not installed'：原包尚未安装（首次冷启动），
 *   保留仓库内已提交的 fork 基线即可，不算错误。
 */
function generateServerFork(opts = {}) {
  const homeDir = opts.homeDir || HOME_DIR;
  const forkDir = opts.forkDir || path.join(__dirname, 'plugins', 'steward-jsonrpc-server');

  const src = originalCandidates(homeDir).find(p => fs.existsSync(p));
  if (!src) return { ok: false, reason: 'original not installed' };

  let code = fs.readFileSync(src, 'utf8');

  // 锚点定位 createSession 方法体（括号配对）
  const ANCHOR = 'async createSession(sessionId) {';
  const start = code.indexOf(ANCHOR);
  if (start === -1) return { ok: false, reason: 'createSession anchor not found (upstream changed?)' };
  let depth = 0;
  let end = -1;
  for (let i = code.indexOf('{', start); i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return { ok: false, reason: 'createSession body end not found' };
  const originalMethod = code.slice(start, end);
  // 健全性检查：确认替换目标是预期的方法（防锚点漂移误伤）
  if (!originalMethod.includes('agents.create') || !originalMethod.includes('brandString')) {
    return { ok: false, reason: 'createSession body sanity check failed' };
  }

  code = code.slice(0, start) + PATCHED_CREATE_SESSION + code.slice(end);

  // 补丁 2：prompt 支持 mode='steer'（当前 turn 的 next-step inbox 插队——
  // 用户消息随下步模型迭代消费，无需等整轮结束）与 mode='interrupt'
  // （agent.cancel 中断在产生成——一次性输出也能打断，keepInbox 保留并发
  // steer/followup；引擎随后 drain 以同一 session 立即重跑下一轮）。
  // followup 保持默认。
  const steerAnchor = 'rec.handle.agent.followup(message);';
  const steerIdx = code.indexOf(steerAnchor);
  if (steerIdx !== -1) {
    const lineStart = code.lastIndexOf('\n', steerIdx) + 1;
    const indent = code.slice(lineStart, steerIdx);
    const steerPatch =
      indent + '// Steward fork: steer mode → next-step inbox（turn 内插队，下步模型迭代消费）；interrupt mode → cancel 在产生成（一次性输出也能打断）\n'
      + indent + 'if (params.mode === "steer") {\n'
      + indent + '\trec.handle.agent.steer(message);\n'
      + indent + '} else if (params.mode === "interrupt") {\n'
      + indent + '\tconst cause = Object.assign(new Error("user interrupt: rerun next turn immediately"), { kind: "user-interrupt" });\n'
      + indent + '\trec.handle.agent.cancel(cause, { keepInbox: true });\n'
      + indent + '} else {\n'
      + indent + '\trec.handle.agent.followup(message);\n'
      + indent + '}\n';
    code = code.slice(0, lineStart) + steerPatch + code.slice(steerIdx + steerAnchor.length);
  } else {
    console.warn('[generateServerFork] prompt followup 锚点未找到（上游变更？），跳过 steer/interrupt 补丁');
  }

  fs.mkdirSync(path.join(forkDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(forkDir, 'lib', 'index.js'), code);
  fs.writeFileSync(path.join(forkDir, 'package.json'), JSON.stringify(FORK_PACKAGE_JSON, null, 2) + '\n');
  return { ok: true, from: src };
}

module.exports = { generateServerFork };

if (require.main === module) {
  const r = generateServerFork();
  if (r.ok) console.log(`✅ fork 已生成: ${r.from} → plugins/steward-jsonrpc-server/lib/index.js`);
  else if (r.reason === 'original not installed') console.log('（原包尚未安装，保留仓库内 fork 基线）');
  else { console.error(`❌ fork 生成失败: ${r.reason}`); process.exit(1); }
}
