const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const file = process.argv[2];
if (!file) { console.error('Usage: node restore.js <backup.json>'); process.exit(1); }
const root = __dirname;
const payload = JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
if (!payload.database || !['rajmukhi-education-backup-v1','rajmukhi-education-backup-v2'].includes(payload.format)) throw new Error('Invalid Rajmukhi backup');
if (payload.format === 'rajmukhi-education-backup-v2') {
  const {checksum,...withoutChecksum}=payload;
  const expected=crypto.createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex');
  if (checksum !== expected) throw new Error('Backup checksum verification failed');
}
const db = path.join(root,'data.json');
fs.writeFileSync(db+'.restore-tmp', JSON.stringify(payload.database,null,2), {mode:0o600});
fs.renameSync(db+'.restore-tmp', db);
const uploads = path.join(root,'uploads');
fs.mkdirSync(uploads,{recursive:true});
for (const item of (payload.uploads||[])) {
  if (!item || !item.name) continue;
  fs.writeFileSync(path.join(uploads,path.basename(item.name)), Buffer.from(item.data,'base64'));
}
console.log('Restore completed successfully. Restart the application.');
