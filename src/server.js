const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('./config');
const { open, tx } = require('./db');
const C = require('./core');
const S = require('./scoring');
const { E, can } = C;

const SESSION_MS = 12 * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// ---------- passwords & sessions ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64).toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64), x = Buffer.from(hash, 'base64');
  return h.length === x.length && crypto.timingSafeEqual(h, x);
}
const DUMMY = hashPassword('dummy-password-for-timing');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function checkPassword(pw) { if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200) throw E(422, 'Password must be 10-200 characters'); }

function createApp(db, opts = {}) {
  const production = opts.production ?? cfg.production, secure = opts.cookieSecure ?? cfg.cookieSecure, trustProxy = opts.trustProxy ?? cfg.trustProxy;
  const clients = new Set();
  const broadcast = () => { for (const r of clients) { try { r.write('data: update\n\n'); } catch { clients.delete(r); } } };
  const hb = setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some(x => t - x < 3600000)) hits.delete(k); for (const r of clients) { try { r.write(': hb\n\n'); } catch { clients.delete(r); } } }, 25000); hb.unref();
  const hits = new Map(); // in-memory limiter for public write endpoints
  const limit = (key, max, ms) => {
    const t = Date.now(), h = (hits.get(key) || []).filter(x => t - x < ms);
    if (h.length >= max) throw E(429, 'Too many requests. Please try again later.');
    h.push(t); hits.set(key, h);
  };

  function sessionUser(req) {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
    const row = db.prepare('SELECT u.id,u.username,u.email,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(m[1]));
    if (!row || row.expires_at < Date.now() || !row.active) return null;
    return { id: row.id, username: row.username, email: row.email, role: row.role, active: row.active };
  }
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
  }
  function throttle(key, max, lockMs = 15 * 60000) {
    const t = Date.now(), r = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
    if (r && r.locked_until > t) throw E(429, `Too many failed attempts. Try again in ${Math.ceil((r.locked_until - t) / 60000)} minute(s).`);
    return {
      fail() {
        const cur = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
        if (!cur || t - cur.first_at > lockMs) db.prepare('INSERT OR REPLACE INTO login_attempts(key,fails,first_at,locked_until) VALUES(?,?,?,0)').run(key, 1, t);
        else db.prepare('UPDATE login_attempts SET fails=fails+1, locked_until=CASE WHEN fails+1>=? THEN ? ELSE 0 END WHERE key=?').run(max, t + lockMs, key);
      },
      clear() { db.prepare('DELETE FROM login_attempts WHERE key=?').run(key); },
    };
  }

  // ---------- validation helpers ----------
  const str = (v, name, min, max) => { const s = C.norm(v); if (s.length < min || s.length > max) throw E(422, `${name} must be ${min}-${max} characters`); return s; };
  const bool = v => (v ? 1 : 0);
  const oneOf = (v, list, name) => { if (!list.includes(v)) throw E(422, `${name} must be one of: ${list.join(', ')}`); return v; };
  const int = (v, name, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw E(422, `${name} must be an integer ${min}-${max}`); return n; };
  const pubSettings = () => {
    const s = C.settings(db);
    return { tournament_name: s.tournament_name, college_name: s.college_name, venue: s.venue, event_date: s.event_date, registration_open: s.registration_open === '1',
      allow_viewer_signup: s.allow_viewer_signup === '1', rules: JSON.parse(s.rules), rules_text: s.rules_text, grace_minutes: Number(s.grace_minutes), match_minutes: Number(s.match_minutes) };
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = iso => iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.TZ || undefined }) : '';
  const raw = (type, body, extra = {}) => ({ __raw: { type, body, ...extra } });
  const csvOut = (name, rows, cols) => raw('text/csv; charset=utf-8', C.csv(rows, cols), { headers: { 'Content-Disposition': `attachment; filename="${name}.csv"` } });

  function printPage(title, body) {
    const s = pubSettings();
    return raw('text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - ${esc(s.tournament_name)}</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}h2{font-size:16px;margin:22px 0 6px;border-bottom:2px solid #111}table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{border:1px solid #999;padding:5px 7px;text-align:left;font-size:13px}th{background:#eee}.sub{color:#555;margin:2px 0 12px}.box{height:34px}@media print{.noprint{display:none}body{margin:10mm}}</style></head>
<body><button class="noprint" onclick="window.print()">Print / Save as PDF</button><h1>${esc(s.tournament_name)} - ${esc(title)}</h1><div class="sub">${esc(s.college_name)} ${esc(s.venue)} ${esc(s.event_date)}</div>${body}</body></html>`,
      { csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  }
  const matchRowsHtml = ms => `<table><tr><th>#</th><th>Round</th><th>Side A</th><th>Side B</th><th>Court</th><th>Time</th><th>Status</th><th>Score</th></tr>${ms.map(m =>
    `<tr><td>${m.id}</td><td>${esc(m.label)}</td><td>${esc(m.a?.name || 'TBD')}</td><td>${esc(m.b?.name || 'TBD')}</td><td>${esc(m.court_name)}</td><td>${esc(fmtTime(m.scheduled_at))}</td><td>${esc(m.status.replace(/_/g, ' '))}</td><td>${esc(m.final_score)}</td></tr>`).join('')}</table>`;

  // ---------- routes ----------
  const routes = [];
  const R = (method, pattern, perm, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), perm, fn });
  const mid = c => int(c.params.id, 'id', 1, 1e9);
  const ip = c => c.ip;
  const U = c => c.user;

  R('GET', '/api/health', null, () => { db.prepare('SELECT 1').get(); return { ok: true, uptime_s: Math.round(process.uptime()), time: C.now() }; });
  R('GET', '/api/events', null, c => { c.sse = true; });

  // auth
  R('POST', '/api/auth/login', null, c => {
    const username = str(c.body.username, 'Username', 1, 100), password = typeof c.body.password === 'string' ? c.body.password : '';
    const a = throttle(`u|${c.ip}|${username.toLowerCase()}`, 5), b = throttle(`ip|${c.ip}`, 40);
    const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(username, username);
    const ok = verifyPassword(password, u ? u.password_hash : DUMMY) && u && u.active;
    if (!ok) { a.fail(); b.fail(); C.audit(db, null, 'auth.login_failed', 'user', u?.id, { username }, c.ip); throw E(401, 'Invalid username or password'); }
    a.clear(); startSession(c.res, u.id); C.audit(db, u, 'auth.login', 'user', u.id, null, c.ip);
    return { user: { id: u.id, username: u.username, role: u.role } };
  });
  R('POST', '/api/auth/logout', null, c => {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(c.req.headers.cookie || ''); if (m) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(m[1]));
    c.res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return { ok: true };
  });
  R('GET', '/api/auth/me', null, c => ({ user: c.user ? { id: c.user.id, username: c.user.username, role: c.user.role, perms: C.PERMS[c.user.role] } : null }));
  R('POST', '/api/auth/register', null, c => {
    if (C.settings(db).allow_viewer_signup !== '1') throw E(403, 'Account sign-up is disabled');
    limit(`signup|${c.ip}`, 10, 3600000);
    const username = str(c.body.username, 'Username', 3, 32); if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw E(422, 'Username may contain letters, digits, _ . -');
    checkPassword(c.body.password);
    const email = C.norm(c.body.email) || null; if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw E(422, 'Invalid email');
    const r = db.prepare('INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,?)').run(username, email, hashPassword(c.body.password), 'viewer');
    C.audit(db, { id: Number(r.lastInsertRowid), username }, 'auth.signup', 'user', Number(r.lastInsertRowid), null, c.ip);
    return { ok: true };
  });
  R('POST', '/api/auth/password', 'auth', c => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.user.id);
    if (!verifyPassword(String(c.body.current || ''), u.password_hash)) throw E(403, 'Current password is incorrect');
    checkPassword(c.body.new);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(c.body.new), u.id);
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(c.req.headers.cookie || '');
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, m ? sha(m[1]) : '');
    C.audit(db, c.user, 'auth.password_change', 'user', u.id, null, c.ip); return { ok: true };
  });

  // public data
  R('GET', '/api/public/overview', null, () => ({
    settings: pubSettings(),
    categories: db.prepare('SELECT id,name,kind,gender,format,third_place FROM categories WHERE published=1 ORDER BY id').all(),
    counts: {
      live: db.prepare(`SELECT COUNT(*) n FROM matches m JOIN categories c ON c.id=m.category_id WHERE c.published=1 AND m.status IN (${C.LIVE.map(() => '?').join(',')})`).get(...C.LIVE).n,
      completed: db.prepare("SELECT COUNT(*) n FROM matches m JOIN categories c ON c.id=m.category_id WHERE c.published=1 AND m.status IN ('completed','walkover')").get().n,
      players: db.prepare("SELECT COUNT(DISTINCT r.player_id) n FROM registrations r JOIN categories c ON c.id=r.category_id JOIN players p ON p.id=r.player_id WHERE r.status='approved' AND c.published=1 AND p.public=1").get().n,
    },
    latest: db.prepare('SELECT id,title,body,kind,created_at FROM announcements WHERE published=1 ORDER BY id DESC LIMIT 3').all(),
  }));
  R('GET', '/api/public/matches', null, c => {
    const w = [], p = [];
    if (c.query.category) { w.push('m.category_id=?'); p.push(Number(c.query.category)); }
    if (c.query.court) { w.push('m.court_id=?'); p.push(Number(c.query.court)); }
    if (c.query.status === 'live') { w.push(`m.status IN (${C.LIVE.map(() => '?').join(',')})`); p.push(...C.LIVE); }
    else if (c.query.status === 'done') w.push("m.status IN ('completed','walkover')");
    else if (c.query.status === 'upcoming') w.push("m.status IN ('scheduled','pending','postponed')");
    w.push("m.status NOT IN ('bye','cancelled')");
    return { matches: C.listMatches(db, { pub: true, where: w.join(' AND '), params: p }) };
  });
  R('GET', '/api/public/courts', null, () => ({ courts: C.courtsView(db, true) }));
  R('GET', '/api/public/brackets', null, () => ({
    categories: db.prepare('SELECT id,name,kind,format,third_place,groups FROM categories WHERE published=1 ORDER BY id').all().map(cat => ({
      ...cat, matches: C.listMatches(db, { pub: true, where: 'm.category_id=?', params: [cat.id] }), standings: cat.format === 'roundrobin' ? C.standings(db, cat.id) : null })),
  }));
  R('GET', '/api/public/results', null, () => ({
    categories: C.results(db, true),
    matches: C.listMatches(db, { pub: true, where: "m.status IN ('completed','walkover')" }).sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || '')),
  }));
  R('GET', '/api/public/players', null, () => ({
    categories: db.prepare('SELECT id,name FROM categories WHERE published=1 ORDER BY id').all().map(cat => ({
      ...cat, teams: db.prepare(`SELECT t.id,t.name FROM teams t JOIN players p ON p.id=t.player1_id LEFT JOIN players p2 ON p2.id=t.player2_id WHERE t.category_id=? AND p.public=1 AND (p2.id IS NULL OR p2.public=1) ORDER BY t.name`).all(cat.id) })),
  }));
  R('GET', '/api/public/announcements', null, () => ({ announcements: db.prepare('SELECT id,title,body,kind,created_at FROM announcements WHERE published=1 ORDER BY id DESC LIMIT 100').all() }));
  R('GET', '/api/public/categories-open', null, () => ({ categories: db.prepare('SELECT id,name,kind,gender FROM categories WHERE generated=0 ORDER BY id').all(), open: pubSettings().registration_open }));
  R('POST', '/api/public/register', null, c => { limit(`reg|${c.ip}`, 15, 3600000); const r = C.submitRegistration(db, c.body, { ip: c.ip }); return { ok: true, count: r.ids.length }; });

  // dashboard & reports
  R('GET', '/api/admin/dashboard', 'panel', () => C.dashboard(db));
  R('GET', '/api/reports/summary', 'panel', () => ({
    participation: db.prepare(`SELECT c.id,c.name,(SELECT COUNT(*) FROM registrations r WHERE r.category_id=c.id AND r.status='approved') approved,
      (SELECT COUNT(*) FROM registrations r WHERE r.category_id=c.id AND r.status='pending') pending, (SELECT COUNT(*) FROM teams t WHERE t.category_id=c.id) teams,
      (SELECT COUNT(*) FROM matches m WHERE m.category_id=c.id AND m.status NOT IN ('bye','cancelled')) matches,
      (SELECT COUNT(*) FROM matches m WHERE m.category_id=c.id AND m.status IN ('completed','walkover')) finished FROM categories c ORDER BY c.id`).all(),
    results: C.results(db, false),
  }));

  // categories
  const catFields = b => ({ name: str(b.name, 'Name', 2, 60), kind: oneOf(b.kind, ['singles', 'doubles'], 'kind'), gender: oneOf(b.gender || 'open', ['boys', 'girls', 'mixed', 'open'], 'gender'),
    format: oneOf(b.format || 'knockout', ['knockout', 'roundrobin'], 'format'), third_place: bool(b.third_place), groups: int(b.groups ?? 1, 'groups', 1, 8), published: bool(b.published) });
  R('GET', '/api/categories', 'panel', () => ({ categories: db.prepare('SELECT * FROM categories ORDER BY id').all() }));
  R('POST', '/api/categories', 'admin', c => {
    const f = catFields(c.body); if (f.gender === 'mixed' && f.kind !== 'doubles') throw E(422, 'Mixed categories must be doubles');
    const r = db.prepare('INSERT INTO categories(name,kind,gender,format,third_place,groups,published) VALUES(?,?,?,?,?,?,?)').run(f.name, f.kind, f.gender, f.format, f.third_place, f.groups, f.published);
    C.audit(db, U(c), 'category.create', 'category', Number(r.lastInsertRowid), f, ip(c)); return { id: Number(r.lastInsertRowid) };
  });
  R('PATCH', '/api/categories/:id', 'admin', c => {
    const id = mid(c), cur = db.prepare('SELECT * FROM categories WHERE id=?').get(id); if (!cur) throw E(404, 'Category not found');
    const f = catFields({ ...cur, ...c.body });
    if (cur.generated && (f.kind !== cur.kind || f.format !== cur.format)) throw E(409, 'Kind and format cannot change after fixtures exist');
    db.prepare('UPDATE categories SET name=?,kind=?,gender=?,format=?,third_place=?,groups=?,published=? WHERE id=?').run(f.name, f.kind, f.gender, f.format, f.third_place, f.groups, f.published, id);
    C.audit(db, U(c), 'category.update', 'category', id, f, ip(c)); return { ok: true };
  });
  R('DELETE', '/api/categories/:id', 'admin', c => tx(db, () => {
    const id = mid(c), cat = db.prepare('SELECT * FROM categories WHERE id=?').get(id); if (!cat) throw E(404, 'Category not found');
    const counts = { registrations: db.prepare('SELECT COUNT(*) n FROM registrations WHERE category_id=?').get(id).n, teams: db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(id).n, matches: db.prepare('SELECT COUNT(*) n FROM matches WHERE category_id=?').get(id).n };
    if ((counts.registrations || counts.teams || counts.matches) && !c.body.force) throw E(409, `${cat.name} still has ${counts.registrations} registration(s), ${counts.teams} team(s) and ${counts.matches} match(es).`, { code: 'not_empty', counts });
    C.wipeMatches(db, id); db.prepare('DELETE FROM teams WHERE category_id=?').run(id); db.prepare('DELETE FROM registrations WHERE category_id=?').run(id); db.prepare('DELETE FROM categories WHERE id=?').run(id);
    C.audit(db, U(c), 'category.delete', 'category', id, { name: cat.name, ...counts }, ip(c)); return { ok: true };
  }));
  R('POST', '/api/categories/:id/clear-fixtures', 'admin', c => C.clearFixtures(db, U(c), mid(c), c.body, ip(c)));
  R('POST', '/api/categories/:id/generate', 'admin', c => C.generate(db, U(c), mid(c), c.body, ip(c)));
  R('GET', '/api/categories/:id/standings', 'panel', c => ({ standings: C.standings(db, mid(c)) }));

  // players, registrations, teams
  R('GET', '/api/players', 'panel', c => {
    const priv = can(c.user, 'players.private'), q = `%${C.norm(c.query.q)}%`;
    const rows = db.prepare('SELECT * FROM players WHERE name LIKE ? OR college_id LIKE ? ORDER BY name LIMIT 500').all(q, q);
    const regs = db.prepare('SELECT r.player_id,r.status,r.category_id,c.name category FROM registrations r JOIN categories c ON c.id=r.category_id').all();
    return { players: rows.map(p => ({ id: p.id, name: p.name, gender: p.gender, course_year: p.course_year, public: p.public, checked_in_at: p.checked_in_at, ready: p.ready,
      ...(priv ? { college_id: p.college_id, contact: p.contact, notes: p.notes } : {}), registrations: regs.filter(r => r.player_id === p.id) })) };
  });
  R('POST', '/api/registrations/admin', 'registration.review', c => C.submitRegistration(db, c.body, { admin: true, user: U(c), ip: ip(c) }));
  R('PATCH', '/api/players/:id', 'registration.review', c => {
    const id = mid(c), p = db.prepare('SELECT * FROM players WHERE id=?').get(id); if (!p) throw E(404, 'Player not found');
    const b = { ...p, ...c.body };
    db.prepare('UPDATE players SET name=?,gender=?,course_year=?,college_id=?,contact=?,notes=?,public=? WHERE id=?')
      .run(str(b.name, 'Name', 2, 80), oneOf(b.gender, ['male', 'female', 'other'], 'gender'), C.norm(b.course_year) || null, C.norm(b.college_id) || null, C.norm(b.contact) || null, C.norm(b.notes).slice(0, 500) || null, bool(b.public), id);
    C.refreshTeamNames(db, id); C.audit(db, U(c), 'player.update', 'player', id, { fields: Object.keys(c.body) }, ip(c)); return { ok: true };
  });
  R('DELETE', '/api/players/:id', 'admin', c => C.deletePlayer(db, U(c), mid(c), c.body, ip(c)));
  R('POST', '/api/players/:id/checkin', 'checkin', c => {
    const id = mid(c), on = !!c.body.checked_in;
    db.prepare('UPDATE players SET checked_in_at=?, ready=CASE WHEN ? THEN ready ELSE 0 END WHERE id=?').run(on ? C.now() : null, on ? 1 : 0, id);
    C.audit(db, U(c), on ? 'player.checkin' : 'player.checkout', 'player', id, null, ip(c)); return { ok: true };
  });
  R('POST', '/api/players/:id/ready', 'checkin', c => {
    const id = mid(c), p = db.prepare('SELECT checked_in_at FROM players WHERE id=?').get(id); if (!p) throw E(404, 'Player not found');
    if (c.body.ready && !p.checked_in_at) throw E(409, 'Check the player in first');
    db.prepare('UPDATE players SET ready=? WHERE id=?').run(bool(c.body.ready), id); C.audit(db, U(c), 'player.ready', 'player', id, { ready: !!c.body.ready }, ip(c)); return { ok: true };
  });
  R('GET', '/api/registrations', 'registration.review', c => {
    const w = [], p = [];
    if (c.query.status) { w.push('r.status=?'); p.push(c.query.status); }
    if (c.query.category) { w.push('r.category_id=?'); p.push(Number(c.query.category)); }
    return { registrations: db.prepare(`SELECT r.id,r.status,r.reason,r.created_at,r.category_id,c.name category,c.kind,p.id player_id,p.name,p.gender,p.college_id,p.contact,pp.name partner_name
      FROM registrations r JOIN players p ON p.id=r.player_id JOIN categories c ON c.id=r.category_id LEFT JOIN players pp ON pp.id=r.partner_player_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 1000`).all(...p) };
  });
  R('PATCH', '/api/registrations/:id', 'registration.review', c => C.reviewRegistration(db, U(c), mid(c), c.body, ip(c)));
  R('DELETE', '/api/registrations/:id', 'admin', c => C.deleteRegistration(db, U(c), mid(c), c.body, ip(c)));
  R('GET', '/api/teams', 'panel', c => ({ teams: db.prepare('SELECT * FROM teams WHERE category_id=? OR ? IS NULL ORDER BY (seed IS NULL), seed, id').all(c.query.category ? Number(c.query.category) : null, c.query.category ? 1 : null) }));
  R('PATCH', '/api/teams/:id', 'admin', c => {
    const id = mid(c), t = db.prepare('SELECT * FROM teams WHERE id=?').get(id); if (!t) throw E(404, 'Team not found');
    if (db.prepare('SELECT generated FROM categories WHERE id=?').get(t.category_id).generated) throw E(409, 'Seeds cannot change after fixtures exist');
    db.prepare('UPDATE teams SET seed=? WHERE id=?').run(c.body.seed == null || c.body.seed === '' ? null : int(c.body.seed, 'seed', 1, 999), id);
    C.audit(db, U(c), 'team.seed', 'team', id, { seed: c.body.seed }, ip(c)); return { ok: true };
  });

  // matches
  R('GET', '/api/matches', 'panel', c => {
    const w = [], p = [];
    if (c.query.category) { w.push('m.category_id=?'); p.push(Number(c.query.category)); }
    if (c.query.court) { w.push('m.court_id=?'); p.push(Number(c.query.court)); }
    if (c.query.status) { w.push('m.status=?'); p.push(c.query.status); }
    if (c.query.unscheduled) w.push("m.status IN ('pending','postponed')");
    if (c.query.q) { w.push('(ta.name LIKE ? OR tb.name LIKE ?)'); p.push(`%${c.query.q}%`, `%${c.query.q}%`); }
    return { matches: C.listMatches(db, { where: w.join(' AND '), params: p }) };
  });
  R('GET', '/api/matches/:id', 'panel', c => ({ match: C.matchView(db, mid(c)), corrections: db.prepare('SELECT * FROM corrections WHERE match_id=? ORDER BY id').all(mid(c)) }));
  R('POST', '/api/matches', 'admin', c => ({ match: C.createMatch(db, U(c), c.body, ip(c)) }));
  R('PATCH', '/api/matches/:id', 'admin', c => ({ match: C.editMatch(db, U(c), mid(c), c.body, ip(c)) }));
  R('DELETE', '/api/matches/:id', 'admin', c => C.deleteMatch(db, U(c), mid(c), ip(c)));
  R('POST', '/api/matches/:id/reset', 'score.correct', c => ({ match: C.resetMatch(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/schedule', 'schedule.assign', c => C.schedule(db, U(c), mid(c), c.body, ip(c)));
  R('POST', '/api/matches/:id/postpone', 'schedule.assign', c => ({ match: C.postpone(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/cancel', 'match.control', c => ({ match: C.cancel(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/callup', 'match.control', c => ({ match: C.callup(db, U(c), mid(c), ip(c)) }));
  R('POST', '/api/matches/:id/start', 'match.control', c => C.start(db, U(c), mid(c), c.body, ip(c)));
  R('POST', '/api/matches/:id/pause', 'match.control', c => ({ match: C.pauseResume(db, U(c), mid(c), 'paused', ip(c)) }));
  R('POST', '/api/matches/:id/resume', 'match.control', c => ({ match: C.pauseResume(db, U(c), mid(c), 'in_progress', ip(c)) }));
  R('POST', '/api/matches/:id/walkover', 'match.control', c => ({ match: C.walkover(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/noshow', 'match.control', c => ({ match: C.noShow(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/point', 'score', c => C.point(db, U(c), mid(c), c.body, ip(c)));
  R('POST', '/api/matches/:id/undo', 'score', c => ({ match: C.undo(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/games', 'score', c => ({ match: C.setGames(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/confirm', 'score', c => ({ match: C.confirm(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/dispute', 'score', c => ({ match: C.dispute(db, U(c), mid(c), c.body, ip(c)) }));
  R('POST', '/api/matches/:id/resolve-dispute', 'score.correct', c => ({ match: C.resolveDispute(db, U(c), mid(c), c.body, ip(c)) }));

  // courts
  R('GET', '/api/courts', 'panel', () => ({ courts: C.courtsView(db, false) }));
  R('POST', '/api/courts', 'admin', c => {
    const name = str(c.body.name, 'Name', 2, 40), r = db.prepare('INSERT INTO courts(name) VALUES(?)').run(name);
    C.audit(db, U(c), 'court.create', 'court', Number(r.lastInsertRowid), { name }, ip(c)); return { id: Number(r.lastInsertRowid) };
  });
  R('PATCH', '/api/courts/:id', 'schedule.assign', c => tx(db, () => {
    const id = mid(c), ct = db.prepare('SELECT * FROM courts WHERE id=?').get(id); if (!ct) throw E(404, 'Court not found');
    const status = oneOf(c.body.status ?? ct.status, ['active', 'maintenance'], 'status');
    let name = ct.name; if (c.body.name && c.body.name !== ct.name) { if (!can(c.user, 'admin')) throw E(403, 'Only administrators can rename courts'); name = str(c.body.name, 'Name', 2, 40); }
    if (status === 'maintenance' && db.prepare(`SELECT 1 FROM matches WHERE court_id=? AND status IN (${C.LIVE.map(() => '?').join(',')})`).get(id, ...C.LIVE)) throw E(409, 'A match is live on this court. Finalize or pause-and-move it first.');
    db.prepare('UPDATE courts SET status=?, name=?, note=? WHERE id=?').run(status, name, C.norm(c.body.note ?? ct.note).slice(0, 200) || null, id);
    C.audit(db, U(c), 'court.update', 'court', id, { status, name, note: c.body.note }, ip(c)); return { ok: true };
  }));

  R('DELETE', '/api/courts/:id', 'admin', c => tx(db, () => {
    const id = mid(c), ct = db.prepare('SELECT * FROM courts WHERE id=?').get(id); if (!ct) throw E(404, 'Court not found');
    if (db.prepare(`SELECT 1 FROM matches WHERE court_id=? AND status IN (${C.LIVE.map(() => '?').join(',')})`).get(id, ...C.LIVE)) throw E(409, 'A match is live on this court');
    if (db.prepare("SELECT 1 FROM matches WHERE court_id=? AND status IN ('completed','walkover')").get(id)) throw E(409, 'This court hosted finished matches, so deleting it would erase that history. Set it to Maintenance instead.');
    if (db.prepare('SELECT COUNT(*) n FROM courts').get().n <= 1) throw E(409, 'Keep at least one court');
    const un = db.prepare("UPDATE matches SET court_id=NULL, scheduled_at=NULL, status='pending', called_at=NULL, version=version+1 WHERE court_id=? AND status='scheduled'").run(id).changes;
    db.prepare('UPDATE matches SET court_id=NULL WHERE court_id=?').run(id); db.prepare('UPDATE volunteers SET court_id=NULL WHERE court_id=?').run(id); db.prepare('DELETE FROM courts WHERE id=?').run(id);
    C.audit(db, U(c), 'court.delete', 'court', id, { name: ct.name, unscheduled: un }, ip(c)); return { ok: true, unscheduled: un };
  }));

  // announcements, volunteers
  R('GET', '/api/announcements', 'panel', () => ({ announcements: db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 200').all() }));
  R('POST', '/api/announcements', 'announce', c => {
    const r = db.prepare('INSERT INTO announcements(title,body,kind,published,created_by,created_at) VALUES(?,?,?,?,?,?)')
      .run(str(c.body.title, 'Title', 2, 120), str(c.body.body, 'Message', 1, 2000), oneOf(c.body.kind || 'info', ['info', 'schedule'], 'kind'), c.body.published === false ? 0 : 1, U(c).id, C.now());
    C.audit(db, U(c), 'announcement.create', 'announcement', Number(r.lastInsertRowid), { title: c.body.title }, ip(c)); return { id: Number(r.lastInsertRowid) };
  });
  R('PATCH', '/api/announcements/:id', 'announce', c => {
    const id = mid(c), a = db.prepare('SELECT * FROM announcements WHERE id=?').get(id); if (!a) throw E(404, 'Not found'); const b = { ...a, ...c.body };
    db.prepare('UPDATE announcements SET title=?,body=?,kind=?,published=? WHERE id=?').run(str(b.title, 'Title', 2, 120), str(b.body, 'Message', 1, 2000), oneOf(b.kind, ['info', 'schedule'], 'kind'), bool(b.published), id);
    C.audit(db, U(c), 'announcement.update', 'announcement', id, null, ip(c)); return { ok: true };
  });
  R('DELETE', '/api/announcements/:id', 'announce', c => { db.prepare('DELETE FROM announcements WHERE id=?').run(mid(c)); C.audit(db, U(c), 'announcement.delete', 'announcement', mid(c), null, ip(c)); return { ok: true }; });
  R('GET', '/api/volunteers', 'admin', () => ({ volunteers: db.prepare('SELECT v.*,c.name court FROM volunteers v LEFT JOIN courts c ON c.id=v.court_id ORDER BY v.id').all() }));
  R('POST', '/api/volunteers', 'admin', c => {
    const r = db.prepare('INSERT INTO volunteers(name,role,court_id,shift,contact) VALUES(?,?,?,?,?)').run(str(c.body.name, 'Name', 2, 80), str(c.body.role, 'Role', 2, 60), c.body.court_id ? Number(c.body.court_id) : null, C.norm(c.body.shift).slice(0, 60) || null, C.norm(c.body.contact).slice(0, 60) || null);
    C.audit(db, U(c), 'volunteer.create', 'volunteer', Number(r.lastInsertRowid), { name: c.body.name }, ip(c)); return { id: Number(r.lastInsertRowid) };
  });
  R('PATCH', '/api/volunteers/:id', 'admin', c => {
    const id = mid(c), v = db.prepare('SELECT * FROM volunteers WHERE id=?').get(id); if (!v) throw E(404, 'Not found'); const b = { ...v, ...c.body };
    db.prepare('UPDATE volunteers SET name=?,role=?,court_id=?,shift=?,contact=? WHERE id=?').run(str(b.name, 'Name', 2, 80), str(b.role, 'Role', 2, 60), b.court_id ? Number(b.court_id) : null, C.norm(b.shift).slice(0, 60) || null, C.norm(b.contact).slice(0, 60) || null, id);
    C.audit(db, U(c), 'volunteer.update', 'volunteer', id, null, ip(c)); return { ok: true };
  });
  R('DELETE', '/api/volunteers/:id', 'admin', c => { db.prepare('DELETE FROM volunteers WHERE id=?').run(mid(c)); C.audit(db, U(c), 'volunteer.delete', 'volunteer', mid(c), null, ip(c)); return { ok: true }; });

  // users
  R('GET', '/api/users', 'admin', () => ({ users: db.prepare('SELECT id,username,email,role,active,created_at FROM users ORDER BY id').all() }));
  R('POST', '/api/users', 'admin', c => {
    const username = str(c.body.username, 'Username', 3, 32); if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw E(422, 'Username may contain letters, digits, _ . -');
    checkPassword(c.body.password); const role = oneOf(c.body.role, Object.keys(C.PERMS), 'role'); const email = C.norm(c.body.email) || null;
    const r = db.prepare('INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,?)').run(username, email, hashPassword(c.body.password), role);
    C.audit(db, U(c), 'user.create', 'user', Number(r.lastInsertRowid), { username, role }, ip(c)); return { id: Number(r.lastInsertRowid) };
  });
  R('PATCH', '/api/users/:id', 'admin', c => tx(db, () => {
    const id = mid(c), u = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!u) throw E(404, 'User not found');
    const role = c.body.role ? oneOf(c.body.role, Object.keys(C.PERMS), 'role') : u.role, active = 'active' in c.body ? bool(c.body.active) : u.active;
    if (u.role === 'admin' && (role !== 'admin' || !active) && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n <= 1) throw E(409, 'Cannot remove the last active administrator');
    if (c.body.password) { checkPassword(c.body.password); db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(c.body.password), id); }
    db.prepare('UPDATE users SET role=?, active=? WHERE id=?').run(role, active, id);
    if (!active || c.body.password || role !== u.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    C.audit(db, U(c), 'user.update', 'user', id, { role, active, password_reset: !!c.body.password }, ip(c)); return { ok: true };
  }));

  R('DELETE', '/api/users/:id', 'admin', c => tx(db, () => {
    const id = mid(c), u = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!u) throw E(404, 'User not found');
    if (u.id === c.user.id) throw E(409, 'You cannot delete the account you are signed in with');
    if (u.role === 'admin' && u.active && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n <= 1) throw E(409, 'Cannot delete the last administrator');
    db.prepare('DELETE FROM users WHERE id=?').run(id); C.audit(db, U(c), 'user.delete', 'user', id, { username: u.username, role: u.role }, ip(c)); return { ok: true };
  }));

  // settings & audit
  R('GET', '/api/settings', 'admin', () => ({ settings: { ...C.settings(db), rules: JSON.parse(C.settings(db).rules) } }));
  R('PATCH', '/api/settings', 'admin', c => tx(db, () => {
    const set = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)'), changed = {};
    for (const [k, v] of Object.entries(c.body)) {
      let val;
      if (['tournament_name', 'college_name', 'venue', 'event_date'].includes(k)) val = C.norm(v).slice(0, 120);
      else if (k === 'rules_text') val = C.norm(v).slice(0, 5000);
      else if (['registration_open', 'allow_viewer_signup'].includes(k)) val = v ? '1' : '0';
      else if (['match_minutes', 'grace_minutes', 'max_categories'].includes(k)) val = String(int(v, k, 1, 600));
      else if (k === 'rules') { try { val = JSON.stringify(S.normRules(v)); } catch (e) { throw E(422, e.message); } }
      else throw E(422, `Unknown setting: ${k}`);
      set.run(k, val); changed[k] = val;
    }
    C.audit(db, U(c), 'settings.update', 'settings', null, changed, ip(c)); return { ok: true };
  }));
  R('GET', '/api/audit', 'admin', c => ({ entries: db.prepare(`SELECT * FROM audit_log ${c.query.before ? 'WHERE id<?' : ''} ORDER BY id DESC LIMIT 200`).all(...(c.query.before ? [Number(c.query.before)] : [])) }));

  // CSV
  R('GET', '/api/export/:name', 'admin', c => {
    const n = c.params.name.replace(/\.csv$/, '');
    if (n === 'players') return csvOut(n, db.prepare(`SELECT p.id,p.name,p.gender,p.course_year,p.college_id,p.contact,p.checked_in_at,(SELECT group_concat(c.name,'; ') FROM registrations r JOIN categories c ON c.id=r.category_id WHERE r.player_id=p.id AND r.status='approved') categories FROM players p ORDER BY p.name`).all(), ['id', 'name', 'gender', 'course_year', 'college_id', 'contact', 'checked_in_at', 'categories']);
    if (n === 'registrations') return csvOut(n, db.prepare('SELECT r.id,p.name player,c.name category,pp.name partner,r.status,r.reason,r.created_at FROM registrations r JOIN players p ON p.id=r.player_id JOIN categories c ON c.id=r.category_id LEFT JOIN players pp ON pp.id=r.partner_player_id ORDER BY r.id').all(), ['id', 'player', 'category', 'partner', 'status', 'reason', 'created_at']);
    if (n === 'matches') return csvOut(n, C.listMatches(db).map(m => ({ id: m.id, category: m.category_name, round: m.label, side_a: m.a?.name, side_b: m.b?.name, court: m.court_name, scheduled_at: m.scheduled_at, status: m.status, score: m.final_score, winner: m.winner ? (m.winner === 'a' ? m.a.name : m.b.name) : '', finished_at: m.finished_at })), ['id', 'category', 'round', 'side_a', 'side_b', 'court', 'scheduled_at', 'status', 'score', 'winner', 'finished_at']);
    if (n === 'results') return csvOut(n, C.results(db, false).map(r => ({ category: r.name, champion: r.champion, runner_up: r.runner_up, third: r.third, finished: r.finished, total: r.total })), ['category', 'champion', 'runner_up', 'third', 'finished', 'total']);
    if (n === 'standings') return csvOut(n, db.prepare('SELECT id,name FROM categories').all().flatMap(cat => C.standings(db, cat.id).map(s => ({ category: cat.name, ...s }))), ['category', 'group_no', 'name', 'played', 'won', 'lost', 'games_for', 'games_against', 'points_for', 'points_against']);
    if (n === 'audit') return csvOut(n, db.prepare('SELECT * FROM audit_log ORDER BY id').all(), ['id', 'created_at', 'username', 'action', 'entity', 'entity_id', 'details', 'ip']);
    if (n === 'corrections') return csvOut(n, db.prepare('SELECT * FROM corrections ORDER BY id').all(), ['id', 'match_id', 'created_at', 'username', 'reason', 'before', 'after']);
    throw E(404, 'Unknown export');
  });

  // printable pages
  R('GET', '/print/fixtures', null, () => {
    const cats = db.prepare('SELECT id,name FROM categories WHERE published=1 ORDER BY id').all();
    return printPage('Fixtures', cats.map(cat => `<h2>${esc(cat.name)}</h2>${matchRowsHtml(C.listMatches(db, { pub: true, where: "m.category_id=? AND m.status<>'bye'", params: [cat.id] }))}`).join('') || '<p>No fixtures published yet.</p>');
  });
  R('GET', '/print/schedule', null, () => printPage('Court schedule', C.courtsView(db, true).map(ct => `<h2>${esc(ct.name)}</h2>${matchRowsHtml([ct.current, ...ct.queue].filter(Boolean))}`).join('')));
  R('GET', '/print/results', null, () => printPage('Results', `<h2>Champions</h2><table><tr><th>Category</th><th>Champion</th><th>Runner-up</th><th>Third</th></tr>${C.results(db, true).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.champion)}</td><td>${esc(r.runner_up)}</td><td>${esc(r.third)}</td></tr>`).join('')}</table><h2>Completed matches</h2>${matchRowsHtml(C.listMatches(db, { pub: true, where: "m.status IN ('completed','walkover')" }))}`));
  R('GET', '/print/scoresheet/:id', 'panel', c => {
    const m = C.matchView(db, mid(c)), r = m.rules || S.normRules(JSON.parse(C.settings(db).rules));
    const rows = Array.from({ length: r.games_to_win * 2 - 1 }, (_, i) => `<tr><td>Game ${i + 1}</td><td class="box"></td><td class="box"></td></tr>`).join('');
    return printPage(`Score sheet #${m.id}`, `<p><b>${esc(m.category_name)}</b> - ${esc(m.label)} - ${esc(m.court_name || 'Court TBD')} - ${esc(fmtTime(m.scheduled_at))}</p><p>Best of ${r.games_to_win * 2 - 1} games, to ${r.points_to_win}, win by ${r.win_by}${r.cap ? ', cap ' + r.cap : ''}.</p>
<table><tr><th>Game</th><th>${esc(m.a?.name || 'Side A')}</th><th>${esc(m.b?.name || 'Side B')}</th></tr>${rows}</table><p>Winner: ______________________ Final score: ______________</p><p>Scorer: ____________________ Referee: ____________________</p>`);
  });

  // ---------- dispatcher ----------
  async function readBody(req) {
    const chunks = []; let n = 0;
    for await (const ch of req) { n += ch.length; if (n > 200000) throw E(413, 'Request too large'); chunks.push(ch); }
    if (!n) return {};
    try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!b || typeof b !== 'object' || Array.isArray(b)) throw 0; return b; } catch { throw E(400, 'Invalid JSON body'); }
  }
  function headers(res, csp) {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', csp || "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  function send(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) }); res.end(b); }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), method = req.method;
    const clientIp = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    headers(res);
    try {
      const isApi = url.pathname.startsWith('/api/'), isPrint = url.pathname.startsWith('/print/');
      if (!isApi && !isPrint) {
        if (method !== 'GET' && method !== 'HEAD') throw E(405, 'Method not allowed');
        let rel; try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch { throw E(400, 'Malformed URL'); }
        const file = path.normalize(path.join(PUBLIC_DIR, rel));
        if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw E(404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(file));
      }
      if (method !== 'GET') {
        const origin = req.headers.origin;
        if (origin) {
          let host = null; try { host = new URL(origin).host; } catch {}
          const fwd = trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
          if (host !== req.headers.host && host !== fwd) throw E(403, 'Cross-origin request rejected');
        }
        if (!String(req.headers['content-type'] || '').includes('application/json') && Number(req.headers['content-length'] || 0) > 0) throw E(415, 'Content-Type must be application/json');
      }
      const route = routes.find(r => r.method === method && r.re.test(url.pathname));
      if (!route) throw E(404, 'Not found');
      const user = sessionUser(req);
      if (route.perm) {
        if (!user) throw E(401, 'Please sign in');
        if (route.perm !== 'auth' && !can(user, route.perm)) { C.audit(db, user, 'auth.denied', 'route', null, { route: `${method} ${url.pathname}`, perm: route.perm }, clientIp); throw E(403, 'You do not have permission to do that'); }
      }
      const ctx = { req, res, db, user, ip: clientIp, query: Object.fromEntries(url.searchParams), params: route.re.exec(url.pathname).groups || {}, body: method === 'GET' ? {} : await readBody(req) };
      let out;
      try { out = route.fn(ctx); }
      catch (e) { if (e.extra && e.extra.code === 'stale' && ctx.params.id) e.extra.match = C.matchView(db, Number(ctx.params.id), !user); throw e; }
      if (ctx.sse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.write('retry: 3000\n\n'); clients.add(res);
        req.on('close', () => clients.delete(res)); return;
      }
      if (out && out.__raw) {
        const o = out.__raw; if (o.csp) res.setHeader('Content-Security-Policy', o.csp);
        res.writeHead(200, { 'Content-Type': o.type, 'Cache-Control': 'no-store', ...(o.headers || {}) }); return res.end(o.body);
      }
      send(res, method === 'POST' && out && out.id && !out.match ? 201 : 200, out ?? { ok: true });
      if (method !== 'GET') broadcast();
    } catch (e) {
      if (e instanceof C.HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      const msg = String(e && e.message);
      if (/UNIQUE constraint/.test(msg)) return send(res, 409, { error: 'That record already exists (duplicate)' });
      if (/FOREIGN KEY|CHECK constraint|NOT NULL/.test(msg)) return send(res, 422, { error: 'Invalid or inconsistent data' });
      if (e && (e.code === 'ERR_INVALID_ARG_TYPE' || /cannot be bound/.test(msg))) return send(res, 422, { error: 'A required field is missing or has the wrong type' });
      console.error('Unhandled error:', e); send(res, 500, { error: 'Internal server error' });
    }
  });
  server.on('close', () => clearInterval(hb));
  return { server, broadcast, hashPassword, routes };
}

// For hosts without a terminal: create the first administrator from secret environment variables, only if no admin exists yet.
function bootstrapAdmin(db, env = process.env) {
  const u = env.ADMIN_USERNAME, pw = env.ADMIN_PASSWORD;
  if (!u || !pw || db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) return null;
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(u) || pw.length < 10) return 'invalid';
  const r = db.prepare('INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,?)').run(u, env.ADMIN_EMAIL || null, hashPassword(pw), 'admin');
  C.audit(db, { id: Number(r.lastInsertRowid), username: u }, 'user.create_admin_env', 'user', Number(r.lastInsertRowid), null, 'startup');
  return 'created';
}

if (require.main === module) {
  const db = open(cfg.dbPath), { server } = createApp(db);
  const boot = bootstrapAdmin(db); if (boot === 'created') console.log('Administrator created from ADMIN_USERNAME / ADMIN_PASSWORD. Remove ADMIN_PASSWORD from your environment now.'); if (boot === 'invalid') console.error('ADMIN_USERNAME/ADMIN_PASSWORD ignored: username must be 3-32 letters/digits/_.- and password at least 10 characters.');
  const admins = db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get('admin').n, url = `http://localhost:${cfg.port}`;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${cfg.port} is already in use. The tournament server is probably already running.\n  -> Open ${url} in your browser.\n  -> If it is not running, close the other program using this port, or set a different PORT in the .env file (for example PORT=3001).\n`);
    else if (e.code === 'EACCES') console.error(`\nNot allowed to use port ${cfg.port}. Choose a higher number, e.g. PORT=3000 in the .env file.\n`);
    else console.error('\nCould not start the server:', e.message);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    const nets = Object.values(require('node:os').networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.log('\nBadminton Tournament Manager is running.');
    console.log(`  Open in your browser:  ${url}`);
    if (cfg.host === '0.0.0.0') for (const a of nets) console.log(`  On your Wi-Fi/phones:  http://${a}:${cfg.port}`);
    console.log(`  (database: ${cfg.dbPath})  Press Ctrl+C to stop.\n`);
    if (!admins) console.log('  No administrator exists yet. Stop the server (Ctrl+C) and run:  npm run create-admin\n');
    if (!cfg.production && process.env.OPEN_BROWSER !== '0' && process.stdout.isTTY) {
      try { const cp = require('node:child_process'), w = process.platform === 'win32', m = process.platform === 'darwin';
        cp.spawn(w ? 'cmd' : m ? 'open' : 'xdg-open', w ? ['/c', 'start', '', url] : [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
    }
  });
  const stop = () => { server.close(); try { db.close(); } catch {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { createApp, hashPassword, verifyPassword, bootstrapAdmin };
