const crypto = require('node:crypto');
const { open } = require('../src/db');
const { createApp, hashPassword } = require('../src/server');

async function boot(dbFile = ':memory:') {
  const db = open(dbFile), { server } = createApp(db, {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const mkUser = (username, role, password = 'correct-horse-battery') => db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(username, hashPassword(password), role);
  function client() {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.getSetCookie?.() || []; for (const c of sc) { const m = /^sid=([^;]*)/.exec(c); if (m) cookie = m[1] ? `sid=${m[1]}` : ''; }
      const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    };
    call.login = async (u, p = 'correct-horse-battery') => { const r = await call('POST', '/api/auth/login', { username: u, password: p }); if (r.status !== 200) throw new Error('login failed ' + r.status); return call; };
    return call;
  }
  const close = () => new Promise(r => { server.close(() => { try { db.close(); } catch {} r(); }); server.closeAllConnections?.(); });
  return { db, port, mkUser, client, close };
}

// builds a published knockout singles category with n approved teams and generated fixtures
let seq = 0;
async function setupCategory(admin, n, { third = false, name } = {}) {
  const tag = ++seq;
  const cat = (await admin('POST', '/api/categories', { name: name || `Cat ${tag}`, kind: 'singles', gender: 'open', format: 'knockout', third_place: third, published: true })).body.id;
  for (let i = 1; i <= n; i++) {
    const r = await admin('POST', '/api/registrations/admin', { player: { name: `Player ${tag}-${i}`, gender: 'male', college_id: `ID-${tag}-${i}`, contact: `secret-${tag}-${i}@mail.test` }, category_ids: [cat] });
    if (r.status !== 200) throw new Error('reg failed ' + JSON.stringify(r.body));
  }
  for (const reg of (await admin('GET', `/api/registrations?category=${cat}`)).body.registrations) await admin('PATCH', `/api/registrations/${reg.id}`, { status: 'approved' });
  const g = await admin('POST', `/api/categories/${cat}/generate`, {});
  if (g.status !== 200) throw new Error('generate failed ' + JSON.stringify(g.body));
  const matches = (await admin('GET', `/api/matches?category=${cat}`)).body.matches;
  return { cat, matches };
}
const soon = (min = 0) => new Date(Date.now() + min * 60000).toISOString();
async function winGame(sc, id, side, n = 21) { for (let i = 0; i < n; i++) { const r = await sc('POST', `/api/matches/${id}/point`, { side, client_id: crypto.randomUUID() }); if (r.status !== 200) throw new Error('point failed ' + JSON.stringify(r.body)); } }
async function playMatch(sc, id, winner = 'a') { // 2-0 win
  await winGame(sc, id, winner); await winGame(sc, id, winner);
}
module.exports = { boot, setupCategory, soon, winGame, playMatch };
