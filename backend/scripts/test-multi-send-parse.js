/**
 * test-multi-send-parse.js —— 多张发送与表情包清单校验（不启动服务）
 *
 * 1. _toList：send_sticker / send_message(mediaId) / send_web_image 多值参数
 *    的归一化（从 index.js 源码提取生产函数执行，保证测的就是线上代码）
 * 2. 表情包清单：内置目录与数据目录的 manifest 条目、文件齐全性
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const backendDir = path.join(__dirname, '..');

// ---- 1. _toList（提取生产函数）----
const src = fs.readFileSync(path.join(backendDir, 'index.js'), 'utf8');
const m = src.match(/function _toList\(v\) \{[\s\S]*?\n\}/);
assert.ok(m, 'index.js 中找不到 _toList 函数');
const _toList = eval(`(${m[0]})`);

assert.deepStrictEqual(_toList(undefined), []);
assert.deepStrictEqual(_toList(null), []);
assert.deepStrictEqual(_toList(''), []);
assert.deepStrictEqual(_toList('hooray'), ['hooray']);
assert.deepStrictEqual(_toList('sad,hooray'), ['sad', 'hooray']);
assert.deepStrictEqual(_toList('sad，hooray'), ['sad', 'hooray']);            // 中文逗号
assert.deepStrictEqual(_toList(' sad , hooray '), ['sad', 'hooray']);         // 空格容忍
assert.deepStrictEqual(_toList('sad,,hooray'), ['sad', 'hooray']);            // 连续逗号
assert.deepStrictEqual(_toList(['sad', 'hooray']), ['sad', 'hooray']);        // 数组对象
assert.deepStrictEqual(_toList('["sad","hooray"]'), ['sad', 'hooray']);      // JSON 数组字符串
assert.deepStrictEqual(_toList('["u1","https://a.com/1.jpg"]'), ['u1', 'https://a.com/1.jpg']);
console.log('✓ _toList 多值解析 10/10');

// ---- 2. 表情包清单完整性 ----
const EXPECT_IDS = ['sad', 'melon', 'sleepy', 'here', 'water', 'hooray', 'happy', 'proud', 'notai', 'goodnight', 'nyeh', 'overload',
  'lol', 'ok', 'dismiss', 'brazen', 'noexplain', 'giveup', 'goodmodel', 'nopressure'];
for (const dir of ['wechat/stickers', 'data/stickers']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(backendDir, dir, 'manifest.json'), 'utf8'));
  const ids = manifest.map(s => s.id);
  assert.deepStrictEqual(ids, EXPECT_IDS, `${dir} 清单 id 不符`);
  for (const s of manifest) {
    assert.ok(s.file && s.text, `${dir}/${s.id} 缺 file/text`);
    const f = path.join(backendDir, dir, s.file);
    assert.ok(fs.existsSync(f), `${dir}/${s.file} 文件缺失`);
    assert.ok(fs.statSync(f).size > 10 * 1024 && fs.statSync(f).size < 512 * 1024,
      `${dir}/${s.file} 体积异常（${(fs.statSync(f).size / 1024).toFixed(0)}KB，期望 10~512KB）`);
  }
  console.log(`✓ ${dir}: ${manifest.length} 个表情包，文件齐全`);
}
console.log('全部通过');
