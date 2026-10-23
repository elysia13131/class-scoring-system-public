const fs = require('fs');
const path = require('path');

// 读取fitness_scores.json文件
const scoresPath = path.join(__dirname, 'data', 'fitness_scores.json');
const scoresData = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));

// 统一身高单位（转换为厘米）
const unifiedData = scoresData.map(member => ({
  ...member,
  history: member.history.map(record => {
    const scores = { ...record.scores };
    
    // 处理身高单位转换
    if (scores.身高) {
      const height = scores.身高;
      if (typeof height === 'string') {
        // 检查是否为米单位（包含小数点且值小于3）
        const heightNum = parseFloat(height);
        if (!isNaN(heightNum) && heightNum < 3) {
          // 转换为厘米并保留一位小数（如果有）
          const cmHeight = heightNum * 100;
          scores.身高 = cmHeight % 1 === 0 ? cmHeight.toString() : cmHeight.toFixed(1);
        }
      }
    }
    
    return {
      ...record,
      scores
    };
  })
}));

// 保存统一后的数据
fs.writeFileSync(scoresPath, JSON.stringify(unifiedData, null, 2), 'utf8');

console.log('身高单位统一完成！所有身高数据已转换为厘米单位。');
