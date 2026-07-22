const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node verify-backup.js <backup.json>');
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
if (payload.format !== 'rajmukhi-education-backup-v2' || !payload.database) {
  console.error('Invalid Rajmukhi Education backup format');
  process.exit(1);
}
const { checksum, ...withoutChecksum } = payload;
const expected = crypto.createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex');
const ok = checksum === expected;
console.log(JSON.stringify({
  ok,
  file: path.basename(file),
  created_at: payload.created_at || null,
  checksum: checksum || null,
  expected_checksum: expected
}, null, 2));
process.exit(ok ? 0 : 2);
