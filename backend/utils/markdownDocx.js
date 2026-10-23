/**
 * markdownDocx.js —— Markdown/纯文本 → Word(.docx) Buffer
 *
 * AI 生成文件统一走"手机可读"格式：文字/总结/报告类内容经此转成 .docx
 * （md/txt 在微信里打不开，Word 手机可直接预览/用 WPS 打开）。
 * 基于已装依赖 docx（纯 JS），无需系统字体，中文正常。
 */
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

const HEADING_MAP = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/** md/纯文本 → docx 段落数组（标题/无序/有序列表/普通段落，其余内容原样保留） */
function renderParagraphs(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const children = [];
  for (const l of lines) {
    const line = l.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      children.push(new Paragraph({
        text: h[2],
        heading: HEADING_MAP[h[1].length] || HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      children.push(new Paragraph({
        children: [new TextRun('• '), new TextRun(String(ul[1]))],
        indent: { left: 420 },
        spacing: { after: 60 },
      }));
      continue;
    }
    const ol = line.match(/^\s*(\d+)[.、]\s+(.*)$/);
    if (ol) {
      children.push(new Paragraph({
        children: [new TextRun(`${ol[1]}. `), new TextRun(String(ol[2]))],
        indent: { left: 420 },
        spacing: { after: 60 },
      }));
      continue;
    }
    // 表格行/引用/分隔线等一律按普通段落保留原文，不丢内容
    children.push(new Paragraph({ text: line, spacing: { after: 80 } }));
  }
  if (children.length === 0) children.push(new Paragraph({ text: '' }));
  return children;
}

/** 渲染成 .docx 文件 Buffer */
async function markdownToDocx(raw) {
  const doc = new Document({
    sections: [{ properties: {}, children: renderParagraphs(raw) }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { markdownToDocx, renderParagraphs };
