const fs = require("fs");
const { randomUUID } = require("crypto");

const filePath = "e:\\新建文件夹 (3)\\backend\\data\\duties.json";
const duties = JSON.parse(fs.readFileSync(filePath, "utf-8"));

// Remove the 12 records we just imported (they have "计次表导入" in content)
const beforeCount = duties.length;
const filtered = duties.filter(d => !d.content || !d.content.includes("计次表导入"));
const removed = beforeCount - filtered.length;
console.log(`移除 ${removed} 条旧的导入记录`);

const imports = [
  { name: "卢泽卿", id: "402", count: 21 },
  { name: "李志伟", id: "311", count: 19 },
  { name: "蔡旭东", id: "401", count: 18 },
  { name: "洪承宇", id: "411", count: 19 },
  { name: "薛润博", id: "407", count: 18 },
  { name: "徐若皓", id: "404", count: 18 },
  { name: "杜佳合", id: "406", count: 20 },
  { name: "付裔珈", id: "405", count: 18 },
  { name: "代添", id: "408", count: 16 },
  { name: "祁进春", id: "304", count: 19 },
  { name: "王镱箫", id: "403", count: 20 },
  { name: "丁建扬", id: "409", count: 15 },
];

const today = new Date().toISOString().substring(0, 10);
let totalInserted = 0;

for (const d of imports) {
  for (let i = 1; i <= d.count; i++) {
    filtered.push({
      id: randomUUID(),
      memberIds: [d.id],
      content: `计次表导入 #${i}/${d.count}（${d.name}）`,
      time: today,
      score: null,
      class: "卢泽卿班",
      monitorId: "卢泽卿",
      createdAt: new Date().toISOString(),
    });
    totalInserted++;
  }
}

fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), "utf-8");

console.log(`\n✅ 导入完成！`);
console.log(`   班级: 卢泽卿班`);
console.log(`   日期: ${today}`);
imports.forEach(d => console.log(`   ${d.name}: ${d.count}次 → ${d.count}条记录`));
console.log(`   总计: ${totalInserted}条记录`);
