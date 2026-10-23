const fs = require('fs');
const path = require('path');

const MEMBERS_FILE = path.join(__dirname, 'data', 'members.json');

const members = require(MEMBERS_FILE);

const updatedMembers = members.map(member => ({
  ...member,
  height: null,
  weight: null,
  mbti: null
}));

fs.writeFileSync(MEMBERS_FILE, JSON.stringify(updatedMembers, null, 2));
console.log('Members updated successfully!');
