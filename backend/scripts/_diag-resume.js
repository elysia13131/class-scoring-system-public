/**
 * _diag-resume.js —— resume fork 诊断：两轮子进程，打印进程2完整 stdout/stderr
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const script = path.join(__dirname, '_persist-round.js');
const sessionsRoot = path.join(__dirname, '..', 'agent', 'dsh', 'home', 'sessions');
const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
const seg = new DshAgentEngine({})._encodeSegment('member-613');

const cleanLogs = () => {
  try {
    for (const proj of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const sid of fs.readdirSync(path.join(sessionsRoot, proj.name))) {
        if (sid === seg || /^member-613-[0-9a-f]{8}$/.test(sid)) {
          fs.rmSync(path.join(sessionsRoot, proj.name, sid), { recursive: true, force: true });
        }
      }
    }
  } catch {}
};
const findLog = () => {
  for (const proj of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const f of ['session.jsonl.zstd', 'session.jsonl']) {
      const p = path.join(sessionsRoot, proj.name, seg, f);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
};

const round = (label, payload) => new Promise((resolve, reject) => {
  const outFile = path.join(__dirname, `_diag-out-${label}.txt`);
  const p = spawn(process.execPath, [script], {
    env: { ...process.env, PERSIST_PAYLOAD: JSON.stringify(payload), PERSIST_OUT_FILE: outFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '', out = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  p.on('exit', code => {
    const reply = code === 0 ? fs.readFileSync(outFile, 'utf8').trim() : '';
    try { fs.rmSync(outFile, { force: true }); } catch {}
    resolve({ code, reply, out, err });
  });
});

(async () => {
  cleanLogs();
  const memFile = path.join(__dirname, '..', 'data', 'conversation_memory', '613_dsh.json');
  try { fs.rmSync(memFile, { force: true }); } catch {}

  const r1 = await round('1', { memberId: '613', message: '（记住这个，不用工具）我的暗号是雪鲸号。回复"记住了"即可。' });
  console.log('=== 进程1 stdout ===\n' + r1.out);
  console.log('=== 进程1 stderr ===\n' + r1.err);
  console.log('=== 进程1 reply ===\n' + r1.reply);
  const log1 = findLog();
  console.log('log1:', log1, log1 ? fs.statSync(log1).size : '');
  const size1 = log1 ? fs.statSync(log1).size : 0;

  const r2 = await round('2', { memberId: '613', message: '我的暗号是什么？只回暗号本身。' });
  console.log('\n=== 进程2 stdout ===\n' + r2.out);
  console.log('=== 进程2 stderr ===\n' + r2.err);
  console.log('=== 进程2 reply ===\n' + r2.reply);
  console.log('=== 进程2 exit code ===', r2.code);
  const log2 = findLog();
  console.log('log2:', log2, log2 ? `${fs.statSync(log2).size} (was ${size1})` : '');

  // 隔离目录检查
  for (const proj of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const sid of fs.readdirSync(path.join(sessionsRoot, proj.name))) {
      if (/^member-613-[0-9a-f]{8}$/.test(sid)) console.log('隔离目录:', sid);
    }
  }
  cleanLogs();
  try { fs.rmSync(memFile, { force: true }); } catch {}
})();
