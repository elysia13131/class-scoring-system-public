const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const salt = bcrypt.genSaltSync(10);

const membersPath = path.join(process.cwd(), 'data', 'members.json');
let members = JSON.parse(fs.readFileSync(membersPath, 'utf-8'));
let changed = 0;
members = members.map(m => {
  if (m.password && !m.password.startsWith('$2')) {
    m.password = bcrypt.hashSync(m.password, salt);
    changed++;
  }
  return m;
});
fs.writeFileSync(membersPath, JSON.stringify(members, null, 2), 'utf-8');
console.log('members.json:', changed, 'passwords hashed');

const configPath = path.join(process.cwd(), 'data', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
let adminChanged = 0;
if (config.adminPasswords && Array.isArray(config.adminPasswords)) {
  config.adminPasswords = config.adminPasswords.map(p => {
    if (!p.startsWith('$2')) {
      const h = bcrypt.hashSync(p, salt);
      adminChanged++;
      return h;
    }
    return p;
  });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
console.log('config.json:', adminChanged, 'admin passwords hashed');
console.log('Done');