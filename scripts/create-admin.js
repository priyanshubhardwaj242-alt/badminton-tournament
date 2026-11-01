// Creates the first (or an additional) administrator. No default credentials exist anywhere.
// Usage: npm run create-admin            (interactive, password hidden)
//        ADMIN_USERNAME=.. ADMIN_PASSWORD=.. ADMIN_EMAIL=.. npm run create-admin   (non-interactive)
const readline = require('node:readline');
const cfg = require('../src/config');
const { open } = require('../src/db');
const { hashPassword } = require('../src/server');
const C = require('../src/core');

function ask(q, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(s); }; }
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}
(async () => {
  const db = open(cfg.dbPath);
  let username = process.env.ADMIN_USERNAME, password = process.env.ADMIN_PASSWORD, email = process.env.ADMIN_EMAIL || null;
  if (!username || !password) {
    if (!process.stdin.isTTY) { console.error('Provide ADMIN_USERNAME and ADMIN_PASSWORD, or run in an interactive terminal.'); process.exit(1); }
    username = await ask('Admin username: '); email = (await ask('Admin email (optional): ')) || null;
    password = await ask('Password (min 10 chars): ', true);
    if (password !== await ask('Repeat password: ', true)) { console.error('Passwords do not match.'); process.exit(1); }
  }
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username || '')) { console.error('Username must be 3-32 chars: letters, digits, _ . -'); process.exit(1); }
  if (!password || password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
  try {
    const r = db.prepare('INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,?)').run(username, email, hashPassword(password), 'admin');
    C.audit(db, { id: Number(r.lastInsertRowid), username }, 'user.create_admin_cli', 'user', Number(r.lastInsertRowid), null, 'cli');
    console.log(`Administrator "${username}" created.`);
  } catch (e) { console.error(/UNIQUE/.test(e.message) ? 'That username or email already exists.' : e.message); process.exit(1); }
})();
