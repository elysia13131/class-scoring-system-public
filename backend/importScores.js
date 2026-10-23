const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getScoreFilePath } = require('./utils/semester');

const DATA_DIR = path.join(__dirname, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');

// Helper to read JSON files
const readJSON = (file) => {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (!data || data.trim() === '') return [];
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading file ${file}:`, err);
    return [];
  }
};

// Write scores for specific week
const writeScoresByWeek = (week, data) => {
  const filePath = getScoreFilePath(week);
  try {
    const jsonData = JSON.stringify(data, null, 2);
    const compressed = zlib.gzipSync(jsonData);
    fs.writeFileSync(filePath, compressed);
    console.log(`✓ 成功导入第 ${week} 周数据，共 ${data.length} 条记录`);
  } catch (err) {
    console.error(`Error writing compressed file ${filePath}:`, err);
  }
};

// Main import function
const importScores = () => {
  console.log('开始导入评分数据...');
  
  // Read current scores
  const scores = readJSON(SCORES_FILE);
  console.log(`读取到 ${scores.length} 条评分记录`);
  
  // Group scores by week
  const scoresByWeek = {};
  scores.forEach(score => {
    const week = score.week;
    if (!scoresByWeek[week]) {
      scoresByWeek[week] = [];
    }
    scoresByWeek[week].push(score);
  });
  
  console.log(`按周次分组后，共 ${Object.keys(scoresByWeek).length} 个周次的数据`);
  
  // Write each week's scores to separate compressed file
  Object.keys(scoresByWeek).forEach(week => {
    const weekScores = scoresByWeek[week];
    writeScoresByWeek(parseInt(week), weekScores);
  });
  
  console.log('\n🎉 数据导入完成！');
  console.log('数据已按周次分片存储为压缩文件。');
};

// Run the import
importScores();
