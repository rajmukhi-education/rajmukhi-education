const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = __dirname;
const db = path.join(root, 'data.json');
const uploads = path.join(root, 'uploads');
const backups = path.join(root, 'backups');
fs.mkdirSync(backups, {recursive:true});
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const out = path.join(backups, `rajmukhi-backup-${stamp}.json`);
const payload = {
  format: 'rajmukhi-education-backup-v1',
  created_at: new Date().toISOString(),
  database: fs.existsSync(db) ? JSON.parse(fs.readFileSync(db,'utf8')) : null,
  uploads: fs.existsSync(uploads) ? fs.readdirSync(uploads).map(name => {
    const file = path.join(uploads,name);
    return {name, data: fs.readFileSync(file).toString('base64')};
  }) : []
};
fs.writeFileSync(out, JSON.stringify(payload));
console.log(`Backup created: ${out}`);
