// Consistent hot backup of the SQLite database (safe while the server is running).
const fs = require('node:fs'); const path = require('node:path');
const cfg = require('../src/config'); const { open } = require('../src/db');
const dir = path.join(path.dirname(cfg.dbPath), 'backups'); fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `tournament-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = open(cfg.dbPath); db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); db.close();
const keep = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort(); for (const f of keep.slice(0, Math.max(0, keep.length - 30))) fs.unlinkSync(path.join(dir, f));
console.log('Backup written to', out);
