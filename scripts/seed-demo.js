// Loads demo data: 3 courts, categories, players, approved teams, generated fixtures and some scheduled matches.
// Refuses to run when NODE_ENV=production unless --force. Use `--users` to also create demo staff accounts (random passwords printed once).
const crypto = require('node:crypto');
const cfg = require('../src/config'); const { open } = require('../src/db'); const C = require('../src/core'); const { hashPassword } = require('../src/server');
if (cfg.production && !process.argv.includes('--force')) { console.error('Refusing to seed demo data in production (use --force).'); process.exit(1); }
const db = open(cfg.dbPath);
if (db.prepare('SELECT COUNT(*) n FROM players').get().n) { console.error('Database already has players; demo seed skipped.'); process.exit(1); }
const cat = (name, kind, gender, extra = {}) => Number(db.prepare('INSERT INTO categories(name,kind,gender,format,third_place,groups,published) VALUES(?,?,?,?,?,?,1)').run(name, kind, gender, extra.format || 'knockout', extra.third || 0, extra.groups || 1).lastInsertRowid);
const bs = cat("Boys' Singles", 'singles', 'boys', { third: 1 }), gs = cat("Girls' Singles", 'singles', 'girls', { format: 'roundrobin' }), md = cat('Mixed Doubles', 'doubles', 'mixed');
const boys = ['Aarav Mehta', 'Rohan Gupta', 'Vikram Singh', 'Karan Joshi', 'Aditya Rao', 'Dev Malhotra', 'Arjun Nair', 'Sameer Khan', 'Nikhil Verma', 'Yash Patel'];
const girls = ['Ananya Sharma', 'Priya Iyer', 'Meera Das', 'Kavya Reddy', 'Ishita Jain', 'Sneha Kulkarni'];
let n = 1000; const P = (name, gender) => ({ name, gender, course_year: 'B.Tech Y2', college_id: `DEMO${++n}`, contact: '' });
for (const b of boys) C.submitRegistration(db, { player: P(b, 'male'), category_ids: [bs] }, { admin: true });
for (const g of girls) C.submitRegistration(db, { player: P(g, 'female'), category_ids: [gs] }, { admin: true });
for (let i = 0; i < 4; i++) C.submitRegistration(db, { player: P(boys[i], 'male'), partner: P(girls[i], 'female'), category_ids: [md] }, { admin: true });
for (const r of db.prepare("SELECT id,player_id,category_id FROM registrations WHERE status='pending'").all()) {
  if (db.prepare("SELECT status FROM registrations WHERE id=?").get(r.id).status === 'pending') C.reviewRegistration(db, null, r.id, { status: 'approved' }, 'seed');
}
for (const c of [bs, gs, md]) C.generate(db, null, c, {}, 'seed');
const t0 = Date.now(); let slot = 0;
for (const m of db.prepare("SELECT * FROM matches WHERE status='pending' AND team_a IS NOT NULL AND team_b IS NOT NULL ORDER BY category_id, id LIMIT 9").all()) {
  try { C.schedule(db, null, m.id, { court_id: 1 + (slot % 3), scheduled_at: new Date(t0 + Math.floor(slot / 3) * 40 * 60000 + 10 * 60000).toISOString() }, 'seed'); slot++; } catch {}
}
console.log(`Demo data loaded: 3 categories, players, teams, fixtures, ${slot} matches scheduled across Courts 1-3.`);
if (process.argv.includes('--users')) {
  for (const [u, role] of [['demo-scorer', 'scorer'], ['demo-staff', 'staff']]) {
    const pw = crypto.randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(u, hashPassword(pw), role); console.log(`  ${role}: ${u} / ${pw}   (shown once)`);
  }
}
