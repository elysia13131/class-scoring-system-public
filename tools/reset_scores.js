const fs = require('fs');
const path = require('path');

const SCORES_FILE = path.join(__dirname, '..', 'backend', 'data', 'scores.json');

try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify([], null, 2));
    console.log('✅ 所有评分数据已成功重置！');
} catch (err) {
    console.error('❌ 重置评分数据失败:', err);
}
