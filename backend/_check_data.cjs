const fs = require('fs');
const z = require('zlib');
const d = z.gunzipSync(fs.readFileSync('data/scores/scores_week_10.json.gz'));
const s = JSON.parse(d.toString());
console.log('Total records:', s.length);
console.log('First record keys:', Object.keys(s[0]));
console.log('Sample record:', JSON.stringify(s[0], null, 2));
let byMember = {};
s.forEach(r => {
  let id = r.memberId || r.evaluatorId;
  if (!byMember[id]) byMember[id] = {self: 0, peer: 0, total: 0};
  byMember[id].total++;
  if (r.evaluatorId === r.memberId) byMember[id].self++;
  else byMember[id].peer++;
});
let entries = Object.entries(byMember).slice(0, 3);
entries.forEach(([id, c]) => console.log(`memberId=${id}: total=${c.total} self=${c.self} peer=${c.peer}`));
