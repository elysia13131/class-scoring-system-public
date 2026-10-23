/** CSV→xlsx 行解析 + SheetJS 生成回读校验（send_file 同款逻辑） */
const fs = require('fs');
const assert = require('assert');
const XLSX = require('xlsx');

// 与 index.js send_file 相同的 CSV 行状态机
function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// 带引号字段（含逗号）
assert.deepStrictEqual(parseCsvLine('"张三,副班长",601,98'), ['张三,副班长', '601', '98']);
// 转义双引号
assert.deepStrictEqual(parseCsvLine('"他说""好""",5'), ['他说"好"', '5']);
// 普通行
assert.deepStrictEqual(parseCsvLine('学号,姓名,分数'), ['学号', '姓名', '分数']);
// 尾逗号（尾空字段）
assert.deepStrictEqual(parseCsvLine('a,b,'), ['a', 'b', '']);
// 字段中间的引号按 CSV 语义剥除（宽松解析，AI 生成内容规整无影响）
assert.deepStrictEqual(parseCsvLine('备注："无需"'), ['备注：无需']);
console.log('✓ CSV 行解析 5/5');

// 生成 xlsx → 回读
const rows = [
  ['学号', '姓名', '是否完成评分'],
  [601, '张三', '未完成'],
  [602, '李四', '未完成'],
];
const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const tmp = 'data/uploads/_test_sendfile.xlsx';
XLSX.writeFile(wb, tmp);
const back = XLSX.readFile(tmp);
const backRows = XLSX.utils.sheet_to_json(back.Sheets.Sheet1, { header: 1 });
assert.deepStrictEqual(backRows, rows);
fs.unlinkSync(tmp);
console.log('✓ xlsx 生成回读 1/1');

// ---- md/纯文字 → .docx（AI 生成文件只发手机可读格式：md/txt 原样手机打不开）----
const { markdownToDocx } = require('../utils/markdownDocx');
const AdmZip = require('adm-zip');
(async () => {
  try {
    const buf = await markdownToDocx('# 第18周小结\n\n## 训练\n- 3000米及格\n- 引体向上 8 个\n\n整体状态不错，继续加油');
    assert.ok(Buffer.isBuffer(buf) && buf.length > 100, 'docx Buffer 过小');
    const xml = new AdmZip(buf).readAsText('word/document.xml');
    assert.ok(xml.includes('第18周小结'), 'docx 缺标题文本');
    assert.ok(xml.includes('3000米及格'), 'docx 缺列表项文本');
    assert.ok(xml.includes('整体状态不错'), 'docx 缺正文文本');
    console.log('✓ md→docx（标题/列表/正文内容完整，Word 手机可读）1/1');
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
  console.log('全部通过');
})();
