const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getScoresDir } = require('./utils/semester');

const scoresDir = getScoresDir();
const files = fs.readdirSync(scoresDir);
const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'));

if (scoreFiles.length > 0) {
  for (const file of scoreFiles) {
    const filePath = path.join(scoresDir, file);
    const buffer = fs.readFileSync(filePath);
    const decompressed = zlib.gunzipSync(buffer);
    const data = JSON.parse(decompressed.toString('utf8'));
    console.log('Scores file:', file);
    console.log('Data length:', data.length);
    if (data.length > 0) {
      const itemWithSubScores = data.find(item => item.subItemScores && Object.keys(item.subItemScores).length > 0);
      if (itemWithSubScores) {
        console.log('Item with subItemScores:', JSON.stringify(itemWithSubScores, null, 2));
      } else {
        console.log('First item:', JSON.stringify(data[0], null, 2));
      }
      break;
    }
  }
} else {
  console.log('No scores files found');
}
