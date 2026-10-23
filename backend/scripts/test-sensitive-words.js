/**
 * test-sensitive-words.js —— 出站敏感词谐音过滤单元测试
 *
 * 验证：
 *   1. 内置默认词表替换（军→菌、排长→派长 等）
 *   2. 长 key 优先（多字词条先于单字替换）
 *   3. 无命中返回原文（不误伤普通文本）
 *   4. data/sensitive-words.json 远程词表：覆盖内置同名项 + 新增词
 *   5. mtime 缓存动态重读（词表更新后无需重启，立即生效）
 *
 * 运行：node scripts/test-sensitive-words.js
 */
const fs = require('fs');
const path = require('path');
const StewardManager = require('../wechat/steward');
const { sanitizeSensitiveText, _resetSensitiveWordsCache } = StewardManager;

const DATA_DIR = path.join(__dirname, '..', 'data');
const REMOTE_FILE = path.join(DATA_DIR, 'sensitive-words.json');

let pass = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = actual === expected;
  console.log(`${ok ? '✓' : '❌'} ${name}`);
  if (!ok) console.log(`   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  if (ok) pass++;
}

function setRemoteWords(obj) {
  _resetSensitiveWordsCache();
  if (obj === null) { try { fs.unlinkSync(REMOTE_FILE); } catch {} return; }
  fs.writeFileSync(REMOTE_FILE, JSON.stringify(obj, null, 2));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const backup = fs.existsSync(REMOTE_FILE) ? fs.readFileSync(REMOTE_FILE, 'utf8') : null;

  try {
    // ---- 1. 内置默认词表 ----
    setRemoteWords(null);
    check('单字替换：军→菌（军理→菌理）', sanitizeSensitiveText('今天的军理课上得咋样'), '今天的菌理课上得咋样');
    check('多字替换：排长→派长', sanitizeSensitiveText('我们排长说下午加练'), '我们派长说下午加练');
    check('多词混替换', sanitizeSensitiveText('部队的排长要来查军容'), '布队的派长要来查菌容');
    check('无命中原文返回', sanitizeSensitiveText('晚上吃火锅嘛'), '晚上吃火锅嘛');
    check('空串安全', sanitizeSensitiveText(''), '');
    check('非字符串安全', sanitizeSensitiveText(123), 123);

    // ---- 2. 长词优先（自定义「军长」不被单字「军」先吃掉）----
    setRemoteWords({ '军长': '君掌' });
    check('长 key 优先：军长→君掌（而非菌长）', sanitizeSensitiveText('军长来了'), '君掌来了');
    check('远程词表生效时内置仍兜底：排→派', sanitizeSensitiveText('排长好'), '派长好');

    // ---- 3. 远程覆盖内置同名项 ----
    setRemoteWords({ '军': '均' });
    check('远程覆盖内置：军→均', sanitizeSensitiveText('军训开始了'), '均训开始了');

    // ---- 4. mtime 动态重读（同进程内更新词表立即生效）----
    setRemoteWords({ '熄灯': '息灯' });
    check('词表更新后立即生效：熄灯→息灯', sanitizeSensitiveText('十点半熄灯哦'), '十点半息灯哦');

    // ---- 5. 词表损坏容错（坏 JSON → 仅内置）----
    _resetSensitiveWordsCache();
    fs.writeFileSync(REMOTE_FILE, '{broken json');
    check('词表损坏时退回内置：军→菌', sanitizeSensitiveText('军理'), '菌理');
  } finally {
    // 还原现场：测试前有词表则恢复，没有则清掉测试产物
    if (backup !== null) fs.writeFileSync(REMOTE_FILE, backup);
    else { try { fs.unlinkSync(REMOTE_FILE); } catch {} }
    _resetSensitiveWordsCache();
  }

  console.log(`\n结果: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
