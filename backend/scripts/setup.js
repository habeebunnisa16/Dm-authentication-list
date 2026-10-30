/**
 * First-run setup, used by start.bat / start.sh: creates .env from .env.example when it is missing,
 * with a random SESSION_SECRET, then prints the port the server will use (for opening the browser).
 * An existing .env is never changed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');

if (!fs.existsSync(envFile)) {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(envFile, example.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`));
  console.error('Created backend/.env with a random SESSION_SECRET (edit it to change METABASE_URL or other settings).');
}

const port = /^PORT=(\d+)\s*$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1] || '4000';
console.log(port);
