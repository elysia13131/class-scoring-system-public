const fs = require('fs');
const zlib = require('zlib');

const filePath = './backend/data/scores/scores_week_4.json.gz';
const buffer = fs.readFileSync(filePath);
const decompressed = zlib.gunzipSync(buffer);
const data = JSON.parse(decompressed.toString('utf8'));

console.log('Number of scores:', data.length);

// Find the last score
const lastScore = data[data.length - 1];
console.log('Last score:', JSON.stringify(lastScore, null, 2));

if (lastScore.subItemScores) {
  console.log('subItemScores exists:', JSON.stringify(lastScore.subItemScores, null, 2));
} else {
  console.log('No subItemScores in last score');
}

// Find scores with subItemScores
const scoresWithSub = data.filter(s => s.subItemScores && Object.keys(s.subItemScores).length > 0);
console.log('Scores with subItemScores:', scoresWithSub.length);
if (scoresWithSub.length > 0) {
  console.log('First score with subItemScores:', JSON.stringify(scoresWithSub[0], null, 2));
}
