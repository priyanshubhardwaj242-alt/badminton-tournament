const test = require('node:test'); const assert = require('node:assert/strict');
const crypto = require('node:crypto'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { boot, setupCategory, soon, winGame, playMatch } = require('./helpers');

async function env() {
  const t = await boot(); t.mkUser('admin1', 'admin'); t.mkUser('scorer1', 'scorer'); t.mkUser('staff1', 'staff'); t.mkUser('viewer1', 'viewer');
  const admin = await t.client().login('admin1'), scorer = await t.client().login('scorer1'), staff = await t.client().login('staff1'), viewer = await t.client().login('viewer1'), anon = t.client();
  return { ...t, admin, scorer, staff, viewer, anon };
}

test('authentication: hashing, failed logins, lockout, sessions', async () => {
  const t = await boot(); t.mkUser('boss', 'admin'); const c = t.client();
  assert.ok(t.db.prepare('SELECT password_hash h FROM users').get().h.startsWith('scrypt$'));
  assert.equal((await c('GET', '/api/admin/dashboard')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await c('POST', '/api/auth/login', { username: 'boss', password: 'wrong-wrong-wrong' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'boss', password: 'correct-horse-battery' })).status, 429, 'locked even with right password');
  const c2 = t.client(); assert.equal((await c2('POST', '/api/auth/login', { username: 'nobody', password: 'x' })).status, 401);
  t.db.prepare('DELETE FROM login_attempts').run();
  const ok = await c('POST', '/api/auth/login', { username: 'boss', password: 'correct-horse-battery' }); assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/); assert.match(ok.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await c('GET', '/api/auth/me')).body.user.role, 'admin');
  await c('POST', '/api/auth/logout', {}); assert.equal((await c('GET', '/api/admin/dashboard')).status, 401);
  assert.equal((await t.client()('POST', '/api/auth/register', { username: 'weak', password: 'short' })).status, 422);
  assert.equal((await t.client()('POST', '/api/auth/register', { username: 'newviewer', password: 'long-enough-password' })).status, 200);
  assert.equal(t.db.prepare("SELECT role FROM users WHERE username='newviewer'").get().role, 'viewer', 'signup can only create viewers');
  await t.close();
});

test('role permissions are enforced on the backend', async () => {
  const t = await env(); const { cat, matches } = await setupCategory(t.admin, 4); const m = matches[0];
  for (const [who, name] of [[t.viewer, 'viewer'], [t.scorer, 'scorer'], [t.staff, 'staff']]) assert.equal((await who('POST', '/api/categories', { name: 'X' + name, kind: 'singles' })).status, 403, name + ' cannot create category');
  assert.equal((await t.viewer('GET', '/api/admin/dashboard')).status, 403);
  assert.equal((await t.viewer('POST', `/api/matches/${m.id}/point`, { side: 'a', client_id: 'x' })).status, 403);
  assert.equal((await t.staff('POST', `/api/matches/${m.id}/point`, { side: 'a', client_id: 'x' })).status, 403, 'staff cannot score');
  assert.equal((await t.scorer('POST', `/api/matches/${m.id}/schedule`, { court_id: 1, scheduled_at: soon(5) })).status, 403, 'scorer cannot schedule');
  assert.equal((await t.scorer('GET', '/api/users')).status, 403); assert.equal((await t.staff('GET', '/api/export/players')).status, 403);
  assert.equal((await t.scorer('GET', '/api/players')).body.players[0].contact, undefined, 'scorer sees no private contact data');
  assert.ok((await t.staff('GET', '/api/players')).body.players[0].contact);
  assert.equal((await t.staff('POST', `/api/matches/${m.id}/schedule`, { court_id: 1, scheduled_at: soon(5) })).status, 200);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='auth.denied'").get(), 'denied attempts are audited');
  await t.close();
});

test('full flow: schedule on 3 courts, score, confirm, advance, queue updates but never auto-starts', async () => {
  const t = await env(); const { cat, matches } = await setupCategory(t.admin, 4, { third: true });
  const semis = matches.filter(m => m.label === 'Semifinal'), final = matches.find(m => m.label === 'Final'), third = matches.find(m => m.label === 'Third place');
  assert.equal(semis.length, 2); assert.ok(final && third);
  assert.equal((await t.admin('POST', `/api/matches/${semis[0].id}/schedule`, { court_id: 1, scheduled_at: soon(1) })).status, 200);
  assert.equal((await t.admin('POST', `/api/matches/${semis[1].id}/schedule`, { court_id: 2, scheduled_at: soon(1) })).status, 200);
  assert.equal((await t.admin('POST', `/api/matches/${final.id}/schedule`, { court_id: 1, scheduled_at: soon(60) })).status, 200, 'future match with unknown players can queue');
  assert.equal((await t.anon('POST', `/api/matches/${semis[0].id}/start`, {})).status, 401);
  assert.equal((await t.scorer('POST', `/api/matches/${final.id}/start`, {})).status, 409, 'cannot start with unknown participants');
  let courts = (await t.anon('GET', '/api/public/courts')).body.courts;
  assert.equal(courts[0].state, 'upcoming'); assert.equal(courts[0].next.id, semis[0].id); assert.equal(courts[2].state, 'available');
  const st = await t.scorer('POST', `/api/matches/${semis[0].id}/start`, {}); assert.equal(st.status, 200); assert.ok(st.body.warnings.length, 'warns about players not checked in');
  courts = (await t.anon('GET', '/api/public/courts')).body.courts;
  assert.equal(courts[0].state, 'in_progress'); assert.equal(courts[0].current.id, semis[0].id); assert.equal(courts[0].next.id, final.id);
  assert.equal((await t.scorer('POST', `/api/matches/${semis[0].id}/confirm`, {})).status, 409, 'cannot confirm before a result exists');
  await playMatch(t.scorer, semis[0].id, 'b');
  let v = (await t.scorer('GET', `/api/matches/${semis[0].id}`)).body.match; assert.equal(v.status, 'awaiting_confirmation'); assert.equal(v.final_score, '0-21, 0-21');
  assert.equal((await t.anon('GET', '/api/public/matches')).body.matches.find(m => m.id === semis[0].id).winner_team, null, 'no winner is public before confirmation');
  assert.equal((await t.scorer('POST', `/api/matches/${semis[0].id}/point`, { side: 'a', client_id: 'late' })).status, 409);
  const next = (await t.admin('GET', `/api/matches/${final.id}`)).body.match; assert.equal(next.a, null, 'no advancement before confirmation');
  const c1 = await t.scorer('POST', `/api/matches/${semis[0].id}/confirm`, {}); assert.equal(c1.status, 200); assert.equal(c1.body.match.status, 'completed');
  assert.equal((await t.scorer('POST', `/api/matches/${semis[0].id}/confirm`, {})).status, 409, 'duplicate confirmation is rejected');
  const f = (await t.admin('GET', `/api/matches/${final.id}`)).body.match; assert.equal(f.a.id, c1.body.match.winner_team, 'winner advanced to final');
  const th = (await t.admin('GET', `/api/matches/${third.id}`)).body.match; assert.ok(th.a, 'loser dropped to third-place match');
  courts = (await t.anon('GET', '/api/public/courts')).body.courts; assert.equal(courts[0].current, null); assert.equal(courts[0].next.id, final.id); assert.equal(courts[0].next.status, 'scheduled', 'next match is not auto-started');
  await t.close();
});

test('scoring: undo, idempotent taps, stale versions, pause, dispute and corrections history', async () => {
  const t = await env(); const { matches } = await setupCategory(t.admin, 2); const m = matches[0];
  await t.admin('POST', `/api/matches/${m.id}/schedule`, { court_id: 3, scheduled_at: soon(1) }); await t.scorer('POST', `/api/matches/${m.id}/start`, {});
  const tap = (side, id) => t.scorer('POST', `/api/matches/${m.id}/point`, { side, client_id: id });
  const r1 = await tap('a', 'tap-1'), r2 = await tap('a', 'tap-1'); assert.equal(r2.body.duplicate, true);
  assert.deepEqual(r2.body.match.games[0], { game_no: 1, a: 1, b: 0, complete: false }, 'a retried tap does not double count');
  assert.equal((await t.scorer('POST', `/api/matches/${m.id}/point`, { side: 'b', client_id: 'tap-2', version: r1.body.match.version - 1 })).body.code, 'stale');
  await tap('b', 'tap-3'); const u = await t.scorer('POST', `/api/matches/${m.id}/undo`, {}); assert.equal(u.body.match.games[0].b, 0);
  await t.scorer('POST', `/api/matches/${m.id}/pause`, {}); assert.equal((await tap('a', 'tap-4')).status, 409, 'cannot score while paused'); await t.scorer('POST', `/api/matches/${m.id}/resume`, {});
  await winGame(t.scorer, m.id, 'a', 20); // 21-0 game 1 (one point was already scored above)
  assert.equal((await t.scorer('GET', `/api/matches/${m.id}`)).body.match.games.length, 2, 'game 1 complete, game 2 started');
  await winGame(t.scorer, m.id, 'a', 21);
  assert.equal((await t.scorer('GET', `/api/matches/${m.id}`)).body.match.status, 'awaiting_confirmation');
  assert.equal((await t.scorer('POST', `/api/matches/${m.id}/undo`, {})).body.match.status, 'in_progress', 'undo reopens a finished match');
  await winGame(t.scorer, m.id, 'b', 1);
  const d = await t.scorer('POST', `/api/matches/${m.id}/dispute`, { note: 'line call' }); assert.equal(d.body.match.status, 'disputed');
  assert.equal((await t.scorer('POST', `/api/matches/${m.id}/resolve-dispute`, { note: 'ok' })).status, 403, 'scorers cannot resolve disputes');
  assert.equal((await t.admin('POST', `/api/matches/${m.id}/resolve-dispute`, { note: 'referee decided' })).body.match.status, 'paused');
  await t.scorer('POST', `/api/matches/${m.id}/resume`, {});
  const bad = await t.admin('POST', `/api/matches/${m.id}/games`, { games: [{ a: 21, b: 5 }, { a: 22, b: 5 }] }); assert.equal(bad.status, 422);
  assert.equal((await t.scorer('POST', `/api/matches/${m.id}/games`, { games: [{ a: 21, b: 19 }, { a: 21, b: 18 }] })).status, 200, 'scorer can enter a full score');
  await t.scorer('POST', `/api/matches/${m.id}/confirm`, {});
  const cor = (g, reason) => t.admin('POST', `/api/matches/${m.id}/games`, { games: g, reason });
  assert.equal((await t.scorer('POST', `/api/matches/${m.id}/games`, { games: [{ a: 10, b: 21 }, { a: 10, b: 21 }], reason: 'x' })).status, 403, 'scorer cannot correct');
  assert.equal((await cor([{ a: 10, b: 21 }, { a: 10, b: 21 }], '')).status, 422, 'correction needs a reason');
  const fin = (await t.admin('GET', `/api/matches/${m.id}`)).body.match; assert.equal(fin.winner, 'a');
  const c = await cor([{ a: 10, b: 21 }, { a: 12, b: 21 }], 'scorer tapped wrong side'); assert.equal(c.status, 200); assert.equal(c.body.match.winner, 'b');
  const hist = (await t.admin('GET', `/api/matches/${m.id}`)).body.corrections; assert.equal(hist.length, 1); assert.equal(hist[0].username, 'admin1'); assert.match(hist[0].before, /21-19/);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='score.correct'").get());
  await t.close();
});

test('byes advance automatically; odd draws never invent participants', async () => {
  const t = await env(); const { matches } = await setupCategory(t.admin, 3);
  const byes = matches.filter(m => m.status === 'bye'); assert.equal(byes.length, 1);
  const final = matches.find(m => m.label === 'Final'), fresh = (await t.admin('GET', `/api/matches/${final.id}`)).body.match;
  assert.ok(fresh.a || fresh.b, 'bye winner is already in the final'); assert.ok(!(fresh.a && fresh.b));
  const real = matches.find(m => m.label === 'Semifinal' && m.status !== 'bye'); assert.ok(real.a && real.b);
  assert.equal((await t.admin('POST', `/api/matches/${byes[0].id}/schedule`, { court_id: 1, scheduled_at: soon(5) })).status, 409, 'bye matches cannot be scheduled');
  const players = t.db.prepare('SELECT COUNT(*) n FROM teams').get().n; assert.equal(players, 3);
  await t.close();
});

test('scheduling conflicts: overlapping players blocked, court clashes need admin override, maintenance', async () => {
  const t = await env(); const a = await setupCategory(t.admin, 4), m1 = a.matches.find(m => m.label === 'Semifinal' && m.number === 1), m2 = a.matches.find(m => m.label === 'Semifinal' && m.number === 2);
  const at = soon(30); assert.equal((await t.staff('POST', `/api/matches/${m1.id}/schedule`, { court_id: 1, scheduled_at: at })).status, 200);
  const dbl = await t.staff('POST', `/api/matches/${m2.id}/schedule`, { court_id: 1, scheduled_at: at }); assert.equal(dbl.status, 409); assert.equal(dbl.body.code, 'needs_override');
  assert.equal((await t.staff('POST', `/api/matches/${m2.id}/schedule`, { court_id: 1, scheduled_at: at, override: true, reason: 'because' })).status, 403, 'staff cannot override');
  assert.equal((await t.admin('POST', `/api/matches/${m2.id}/schedule`, { court_id: 1, scheduled_at: at, override: true })).status, 422, 'override needs a reason');
  assert.equal((await t.admin('POST', `/api/matches/${m2.id}/schedule`, { court_id: 1, scheduled_at: at, override: true, reason: 'organizer decision' })).status, 200);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='match.schedule_override'").get(), 'override audited');
  assert.equal((await t.admin('POST', `/api/matches/${m2.id}/schedule`, { court_id: 2, scheduled_at: soon(31) })).status, 200, 'moved to another court');
  // same player in two matches at the same time: build via manual duplicate-player scenario in a second category
  const p = t.db.prepare('SELECT player1_id pid FROM teams WHERE id=?').get(m1.a.id).pid;
  const cat2 = (await t.admin('POST', '/api/categories', { name: 'Overlap cat', kind: 'singles', published: true })).body.id;
  await t.admin('POST', '/api/registrations/admin', { player: { name: 'Other', gender: 'male', college_id: 'OTH1' }, category_ids: [cat2] });
  t.db.prepare('INSERT INTO teams(category_id,name,player1_id) VALUES(?,?,?)').run(cat2, 'Dup team', p);
  const t1 = t.db.prepare('SELECT id FROM teams WHERE category_id=?').all(cat2); const other = t.db.prepare("SELECT id FROM teams WHERE name='Dup team'").get().id;
  t.db.prepare('INSERT INTO teams(category_id,name,player1_id) VALUES(?,?,(SELECT id FROM players WHERE college_id=?))').run(cat2, 'Opp', 'OTH1'); const opp = t.db.prepare("SELECT id FROM teams WHERE name='Opp'").get().id;
  const mm = (await t.admin('POST', '/api/matches', { category_id: cat2, team_a: other, team_b: opp, round: 1 })).body.match;
  const ov = await t.admin('POST', `/api/matches/${mm.id}/schedule`, { court_id: 3, scheduled_at: at, override: true, reason: 'try to force it' });
  assert.equal(ov.status, 409); assert.equal(ov.body.code, 'player_overlap', 'a player can never be in two simultaneous matches, even with override');
  assert.equal((await t.admin('POST', '/api/matches', { category_id: cat2, team_a: opp, team_b: other })).status, 409, 'duplicate fixture rejected');
  await t.admin('PATCH', '/api/courts/3', { status: 'maintenance' });
  assert.equal((await t.admin('POST', `/api/matches/${mm.id}/schedule`, { court_id: 3, scheduled_at: soon(300) })).body.code, 'needs_override');
  assert.equal((await t.anon('GET', '/api/public/courts')).body.courts[2].state, 'maintenance');
  await t.close();
});

test('only one court can run one live match; players cannot be in two live matches', async () => {
  const t = await env(); const { matches } = await setupCategory(t.admin, 8); const r1 = matches.filter(m => m.round === 1 && m.status !== 'bye');
  await t.admin('POST', `/api/matches/${r1[0].id}/schedule`, { court_id: 1, scheduled_at: soon(1) }); await t.admin('POST', `/api/matches/${r1[1].id}/schedule`, { court_id: 1, scheduled_at: soon(40) });
  assert.equal((await t.scorer('POST', `/api/matches/${r1[0].id}/start`, {})).status, 200);
  const busy = await t.scorer('POST', `/api/matches/${r1[1].id}/start`, {}); assert.equal(busy.status, 409); assert.equal(busy.body.code, 'court_busy');
  assert.equal((await t.staff('PATCH', '/api/courts/1', { status: 'maintenance' })).status, 409, 'cannot put a live court into maintenance');
  await t.close();
});

test('concurrent updates: simultaneous start and confirm resolve to a single winner', async () => {
  const t = await env(); const { matches } = await setupCategory(t.admin, 2); const m = matches[0];
  await t.admin('POST', `/api/matches/${m.id}/schedule`, { court_id: 1, scheduled_at: soon(1) });
  const starts = await Promise.all([1, 2, 3, 4].map(() => t.scorer('POST', `/api/matches/${m.id}/start`, {}))); assert.equal(starts.filter(r => r.status === 200).length, 1);
  await playMatch(t.scorer, m.id, 'a');
  const confirms = await Promise.all([1, 2, 3, 4, 5].map(() => t.scorer('POST', `/api/matches/${m.id}/confirm`, {}))); assert.equal(confirms.filter(r => r.status === 200).length, 1);
  const taps = await Promise.all(Array.from({ length: 6 }, () => t.scorer('POST', `/api/matches/${m.id}/point`, { side: 'a', client_id: 'same-tap' })));
  assert.ok(taps.every(r => r.status === 409), 'finished match accepts no taps');
  const t2 = await setupCategory(t.admin, 2); const m2 = t2.matches[0];
  await t.admin('POST', `/api/matches/${m2.id}/schedule`, { court_id: 2, scheduled_at: soon(1) }); await t.scorer('POST', `/api/matches/${m2.id}/start`, {});
  const same = await Promise.all(Array.from({ length: 8 }, () => t.scorer('POST', `/api/matches/${m2.id}/point`, { side: 'a', client_id: 'dup-id' })));
  assert.ok(same.every(r => r.status === 200)); assert.equal((await t.scorer('GET', `/api/matches/${m2.id}`)).body.match.games[0].a, 1);
  const lost = await Promise.all([t.scorer('POST', `/api/matches/${m2.id}/point`, { side: 'a', client_id: 'p1', version: 99 }), t.scorer('POST', `/api/matches/${m2.id}/point`, { side: 'a', client_id: 'p2', version: 99 })]);
  assert.ok(lost.every(r => r.status === 409 && r.body.code === 'stale' && r.body.match));
  await t.close();
});

test('walkovers, call-ups, grace period and no-shows', async () => {
  const t = await env(); const { matches } = await setupCategory(t.admin, 4); const sf = matches.filter(m => m.label === 'Semifinal'), fin = matches.find(m => m.label === 'Final');
  await t.admin('POST', `/api/matches/${sf[0].id}/schedule`, { court_id: 1, scheduled_at: soon(1) });
  assert.equal((await t.staff('POST', `/api/matches/${sf[0].id}/noshow`, { side: 'a' })).status, 409, 'must call first');
  assert.equal((await t.staff('POST', `/api/matches/${sf[0].id}/callup`, {})).status, 200);
  const early = await t.staff('POST', `/api/matches/${sf[0].id}/noshow`, { side: 'a' }); assert.equal(early.body.code, 'grace_period');
  t.db.prepare("UPDATE matches SET called_at=? WHERE id=?").run(new Date(Date.now() - 20 * 60000).toISOString(), sf[0].id);
  const ns = await t.staff('POST', `/api/matches/${sf[0].id}/noshow`, { side: 'a' }); assert.equal(ns.status, 200); assert.equal(ns.body.match.status, 'walkover'); assert.equal(ns.body.match.winner, 'b');
  assert.equal((await t.admin('GET', `/api/matches/${fin.id}`)).body.match.a.id, sf[0].b.id, 'walkover winner advances');
  assert.equal((await t.staff('POST', `/api/matches/${sf[1].id}/walkover`, { winner: 'a', reason: '' })).status, 422, 'reason required');
  assert.equal((await t.staff('POST', `/api/matches/${sf[1].id}/walkover`, { winner: 'a', reason: 'Injury before play' })).status, 200);
  const done = await t.admin('POST', `/api/matches/${sf[1].id}/schedule`, { court_id: 1, scheduled_at: soon(5) }); assert.equal(done.status, 409);
  await t.close();
});

test('correcting a result is blocked once the next match has started; allowed before', async () => {
  const t = await env(); const { matches } = await setupCategory(t.admin, 4); const sf = matches.filter(m => m.label === 'Semifinal'), fin = matches.find(m => m.label === 'Final');
  for (const [i, m] of sf.entries()) { await t.admin('POST', `/api/matches/${m.id}/schedule`, { court_id: i + 1, scheduled_at: soon(1) }); await t.scorer('POST', `/api/matches/${m.id}/start`, {}); await playMatch(t.scorer, m.id, 'a'); await t.scorer('POST', `/api/matches/${m.id}/confirm`, {}); }
  const flip = [{ a: 5, b: 21 }, { a: 5, b: 21 }];
  assert.equal((await t.admin('POST', `/api/matches/${sf[0].id}/games`, { games: flip, reason: 'wrong side' })).status, 200);
  const fin1 = (await t.admin('GET', `/api/matches/${fin.id}`)).body.match; assert.equal(fin1.a.id, sf[0].b.id, 'corrected winner replaced in the final');
  await t.admin('POST', `/api/matches/${fin.id}/schedule`, { court_id: 3, scheduled_at: soon(2) }); await t.scorer('POST', `/api/matches/${fin.id}/start`, {});
  const blocked = await t.admin('POST', `/api/matches/${sf[0].id}/games`, { games: [{ a: 21, b: 5 }, { a: 21, b: 5 }], reason: 'flip again' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'downstream_started');
  assert.equal((await t.admin('GET', `/api/matches/${sf[0].id}`)).body.match.winner, 'b', 'rolled back on failure');
  await t.close();
});

test('public privacy: no contacts, notes, IDs, drafts or unpublished categories', async () => {
  const t = await env(); const a = await setupCategory(t.admin, 4, { name: 'Public cat' }); const hid = await setupCategory(t.admin, 2, { name: 'Hidden cat' });
  await t.admin('PATCH', `/api/categories/${hid.cat}`, { published: false }); await t.admin('PATCH', '/api/players/1', { notes: 'admin only note' });
  await t.admin('POST', `/api/matches/${a.matches[0].id}/dispute`, { note: 'x' });
  const blob = JSON.stringify(await Promise.all(['overview', 'matches', 'courts', 'brackets', 'results', 'players', 'announcements'].map(async p => (await t.anon('GET', `/api/public/${p}`)).body)));
  assert.ok(!/secret-|@mail\.test|ID-\d|admin only note|Hidden cat|dispute_note|college_id|contact|password/i.test(blob), 'no private data in public payloads');
  assert.ok(/Public cat/.test(blob));
  await t.admin('POST', '/api/announcements', { title: 'Draft', body: 'not yet', published: false }); await t.admin('POST', '/api/announcements', { title: 'Live news', body: 'hello' });
  const an = (await t.anon('GET', '/api/public/announcements')).body.announcements; assert.deepEqual(an.map(x => x.title), ['Live news']);
  assert.equal((await t.anon('GET', '/api/players')).status, 401); assert.equal((await t.viewer('GET', '/api/players')).status, 403);
  const pr = await t.anon('GET', `/print/scoresheet/${a.matches[0].id}`); assert.equal(pr.status, 401);
  assert.equal((await t.anon('GET', '/print/fixtures')).status, 200);
  await t.close();
});

test('registration: validation, duplicates, eligibility, approval workflow, doubles', async () => {
  const t = await env(); const open = t.client();
  const bs = (await t.admin('POST', '/api/categories', { name: "Boys' singles", kind: 'singles', gender: 'boys' })).body.id;
  const md = (await t.admin('POST', '/api/categories', { name: 'Mixed', kind: 'doubles', gender: 'mixed' })).body.id;
  const gs = (await t.admin('POST', '/api/categories', { name: "Girls' singles", kind: 'singles', gender: 'girls' })).body.id;
  const P = (n, g, id) => ({ name: n, gender: g, college_id: id, contact: '999' });
  assert.equal((await open('POST', '/api/public/register', { player: P('Ravi', 'male', 'C1'), category_ids: [bs] })).status, 200);
  assert.equal((await open('POST', '/api/public/register', { player: P('Ravi', 'male', 'c1'), category_ids: [bs] })).status, 409, 'duplicate (ID case-insensitive)');
  assert.equal((await open('POST', '/api/public/register', { player: P('Sita', 'female', 'C2'), category_ids: [bs] })).status, 422, 'gender eligibility');
  assert.equal((await open('POST', '/api/public/register', { player: P('Ravi', 'male', 'C1'), category_ids: [md] })).status, 422, 'doubles needs partner');
  assert.equal((await open('POST', '/api/public/register', { player: P('Ravi', 'male', 'C1'), partner: P('Sam', 'male', 'C3'), category_ids: [md] })).status, 422, 'mixed needs one of each');
  assert.equal((await open('POST', '/api/public/register', { player: P('Ravi', 'male', 'C1'), partner: P('Sita', 'female', 'C2'), category_ids: [md] })).status, 200);
  assert.equal((await open('POST', '/api/public/register', { player: P('Ravi', 'male', 'C1'), category_ids: [bs, gs, md] })).status, 422, 'category limit');
  assert.equal((await open('POST', '/api/public/register', { player: { name: '', gender: 'male' }, category_ids: [bs] })).status, 422);
  await t.admin('PATCH', '/api/settings', { registration_open: false }); assert.equal((await open('POST', '/api/public/register', { player: P('Late', 'male', 'C9'), category_ids: [bs] })).status, 403);
  const regs = (await t.staff('GET', '/api/registrations?category=' + md)).body.registrations; assert.equal(regs.length, 2);
  assert.equal((await t.staff('PATCH', `/api/registrations/${regs[0].id}`, { status: 'approved' })).status, 200);
  assert.equal(t.db.prepare('SELECT name FROM teams WHERE category_id=?').get(md).name, 'Ravi / Sita');
  assert.ok((await t.staff('GET', '/api/registrations?category=' + md)).body.registrations.every(r => r.status === 'approved'), 'partner approved together');
  await t.staff('PATCH', `/api/registrations/${regs[0].id}`, { status: 'rejected', reason: 'ineligible' }); assert.equal(t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(md).n, 0);
  assert.equal((await t.staff('POST', '/api/players/1/ready', { ready: true })).status, 409, 'must check in before ready');
  assert.equal((await t.staff('POST', '/api/players/1/checkin', { checked_in: true })).status, 200); assert.equal((await t.staff('POST', '/api/players/1/ready', { ready: true })).status, 200);
  await t.close();
});

test('admin safety: last admin protected, audit trail, CSV export with injection guard, settings validation, health', async () => {
  const t = await env(); const me = (await t.admin('GET', '/api/auth/me')).body.user;
  assert.equal((await t.admin('PATCH', `/api/users/${me.id}`, { role: 'viewer' })).status, 409); assert.equal((await t.admin('PATCH', `/api/users/${me.id}`, { active: false })).status, 409);
  assert.equal((await t.admin('POST', '/api/users', { username: 'x', password: 'long-enough-password', role: 'staff' })).status, 422);
  assert.equal((await t.admin('POST', '/api/users', { username: 'helper', password: 'long-enough-password', role: 'admin' })).status, 201);
  assert.equal((await t.admin('PATCH', '/api/settings', { match_minutes: 'abc' })).status, 422); assert.equal((await t.admin('PATCH', '/api/settings', { evil: 1 })).status, 422);
  assert.equal((await t.admin('PATCH', '/api/settings', { rules: { games_to_win: 1, points_to_win: 11, win_by: 2, cap: 15 } })).status, 200);
  await t.admin('POST', '/api/registrations/admin', { player: { name: '=HYPERLINK("http://evil")', gender: 'male', college_id: 'INJ' }, category_ids: [(await t.admin('POST', '/api/categories', { name: 'Cat', kind: 'singles' })).body.id] });
  const csv = await t.admin('GET', '/api/export/players.csv'); assert.equal(csv.status, 200); assert.match(csv.body, /'=HYPERLINK/); assert.match(csv.headers.get('content-disposition'), /players\.csv/);
  const au = (await t.admin('GET', '/api/audit')).body.entries; assert.ok(au.some(e => e.action === 'settings.update' && e.username === 'admin1' && e.created_at));
  const h = await t.anon('GET', '/api/health'); assert.equal(h.body.ok, true); assert.equal(h.headers.get('x-content-type-options'), 'nosniff'); assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  const r = await fetch(`http://127.0.0.1:${t.port}/api/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' }); assert.equal(r.status, 403, 'cross-origin writes rejected');
  await t.close();
});

test('data persists across a server restart (file database)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-')), 't.db');
  let t = await boot(file); t.mkUser('admin1', 'admin'); let admin = await t.client().login('admin1');
  const { matches } = await setupCategory(admin, 2); const m = matches[0];
  await admin('POST', `/api/matches/${m.id}/schedule`, { court_id: 1, scheduled_at: soon(1) }); await admin('POST', `/api/matches/${m.id}/start`, {}); await playMatch(admin, m.id, 'a'); await admin('POST', `/api/matches/${m.id}/confirm`, {});
  await t.close();
  t = await boot(file); admin = await t.client().login('admin1');
  const again = (await admin('GET', `/api/matches/${m.id}`)).body.match; assert.equal(again.status, 'completed'); assert.equal(again.final_score, '21-0, 21-0');
  assert.equal((await t.client()('GET', '/api/public/results')).body.categories[0].champion, again.a.name);
  await t.close();
});

test('robustness: malformed input is rejected with 4xx, never a server crash', async () => {
  const t = await env(); const { cat } = await setupCategory(t.admin, 4);
  const raw = (method, p, headers = {}, body) => fetch(`http://127.0.0.1:${t.port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
  const ck = (await t.admin('GET', '/api/auth/me')) && null; void ck;
  assert.equal((await t.admin('POST', '/api/registrations/admin', { player: null, category_ids: 'x' })).status, 422);
  assert.equal((await t.admin('POST', '/api/registrations/admin', { player: { name: 'Zed', gender: 'male', college_id: 'Z1' }, category_ids: [{}] })).status, 422);
  assert.equal((await t.admin('POST', '/api/matches', {})).status, 422);
  assert.equal((await t.admin('POST', '/api/matches', { category_id: cat, team_a: {}, team_b: [] })).status, 422);
  assert.equal((await t.admin('POST', '/api/matches', { category_id: 'abc', team_a: 1, team_b: 2 })).status, 422);
  assert.equal((await t.admin('POST', '/api/categories', { name: 'Odd', kind: 'singles', groups: 'many' })).status, 422);
  assert.equal((await t.admin('GET', '/api/matches/abc')).status, 422); assert.equal((await t.admin('GET', '/api/matches/999999')).status, 404);
  assert.equal((await t.admin('POST', '/api/matches/1/schedule', { court_id: 'x', scheduled_at: 'nope' })).status, 422);
  assert.equal((await t.admin('POST', '/api/matches/1/walkover', { winner: {}, reason: [] })).status, 422);
  assert.equal((await raw('GET', '/%E0%A4%A')).status, 400, 'broken percent-encoding');
  assert.equal((await raw('GET', '/..%2f..%2fsrc%2fdb.js')).status, 404, 'no path traversal');
  assert.equal((await raw('POST', '/api/auth/login', { Origin: 'null' }, '{}')).status, 403);
  assert.equal((await raw('POST', '/api/auth/login', { Origin: 'not a url' }, '{}')).status, 403);
  assert.equal((await raw('POST', '/api/auth/login', {}, '{bad json')).status, 400);
  assert.equal((await raw('PUT', '/api/health', {}, '{}')).status, 404);
  await t.close();
});

test('complete 8-team knockout: every round advances to a champion, third place included', async () => {
  const t = await env(); const { cat } = await setupCategory(t.admin, 8, { third: true }); let clock = 0, played = 0;
  for (let guard = 0; guard < 12; guard++) {
    const ready = (await t.admin('GET', `/api/matches?category=${cat}`)).body.matches.filter(m => m.status === 'pending' && m.a && m.b); if (!ready.length) break;
    for (const m of ready) {
      assert.equal((await t.admin('POST', `/api/matches/${m.id}/schedule`, { court_id: 1, scheduled_at: soon(60 * ++clock) })).status, 200);
      assert.equal((await t.scorer('POST', `/api/matches/${m.id}/start`, {})).status, 200); await playMatch(t.scorer, m.id, played % 2 ? 'b' : 'a'); played++;
      assert.equal((await t.scorer('POST', `/api/matches/${m.id}/confirm`, {})).status, 200);
    }
  }
  const all = (await t.admin('GET', `/api/matches?category=${cat}`)).body.matches;
  assert.equal(played, 8, '4 + 2 + final + third place'); assert.ok(all.every(m => ['completed', 'bye'].includes(m.status)), 'nothing left unplayed');
  const res = (await t.anon('GET', '/api/public/results')).body.categories[0], fin = all.find(m => m.label === 'Final'), th = all.find(m => m.label === 'Third place');
  assert.equal(res.champion, fin[fin.winner].name); assert.equal(res.runner_up, fin[fin.winner === 'a' ? 'b' : 'a'].name); assert.equal(res.third, th[th.winner].name);
  assert.equal(new Set([res.champion, res.runner_up, res.third]).size, 3, 'three distinct podium teams');
  const reports = (await t.admin('GET', '/api/reports/summary')).body; assert.equal(reports.participation[0].finished, 8);
  await t.close();
});

test('round robin with a doubles category: standings, completion and champion', async () => {
  const t = await env(); const rr = (await t.admin('POST', '/api/categories', { name: 'RR Singles', kind: 'singles', format: 'roundrobin', published: true })).body.id;
  for (let i = 1; i <= 4; i++) await t.admin('POST', '/api/registrations/admin', { player: { name: `RR${i}`, gender: 'male', college_id: `RR${i}` }, category_ids: [rr] });
  for (const r of (await t.admin('GET', `/api/registrations?category=${rr}`)).body.registrations) await t.admin('PATCH', `/api/registrations/${r.id}`, { status: 'approved' });
  assert.equal((await t.admin('POST', `/api/categories/${rr}/generate`, {})).body.matches, 6);
  let clock = 0; for (const m of (await t.admin('GET', `/api/matches?category=${rr}`)).body.matches) {
    await t.admin('POST', `/api/matches/${m.id}/schedule`, { court_id: 2, scheduled_at: soon(60 * ++clock) }); await t.scorer('POST', `/api/matches/${m.id}/start`, {}); await playMatch(t.scorer, m.id, 'a'); await t.scorer('POST', `/api/matches/${m.id}/confirm`, {});
  }
  const st = (await t.anon('GET', '/api/public/brackets')).body.categories[0].standings; assert.equal(st.length, 4); assert.deepEqual(st.map(s => s.played), [3, 3, 3, 3]);
  assert.equal(st.reduce((a, s) => a + s.won, 0), 6); assert.equal(st[0].won, 3, 'a team that won all 3 tops the table');
  assert.equal((await t.anon('GET', '/api/public/results')).body.categories[0].champion, st[0].name);
  // doubles: a registered pair becomes one team and plays as a unit
  const dbl = (await t.admin('POST', '/api/categories', { name: 'Doubles', kind: 'doubles', gender: 'open', published: true })).body.id;
  for (let i = 1; i <= 2; i++) assert.equal((await t.admin('POST', '/api/registrations/admin', { player: { name: `D${i}a`, gender: 'male', college_id: `D${i}a` }, partner: { name: `D${i}b`, gender: 'female', college_id: `D${i}b` }, category_ids: [dbl] })).status, 200);
  for (const r of (await t.admin('GET', `/api/registrations?category=${dbl}&status=pending`)).body.registrations) await t.admin('PATCH', `/api/registrations/${r.id}`, { status: 'approved' });
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(dbl).n, 2, 'two pairs -> two teams, not four');
  const g = await t.admin('POST', `/api/categories/${dbl}/generate`, {}); assert.equal(g.body.matches, 1);
  assert.match((await t.anon('GET', '/api/public/players')).body.categories.find(c => c.name === 'Doubles').teams[0].name, / \/ /);
  await t.close();
});

test('reset / replay: discards a finished match, rolls the bracket back, and keeps a history', async () => {
  const t = await env(); const { cat, matches } = await setupCategory(t.admin, 4); const sf = matches.filter(m => m.label === 'Semifinal'), fin = matches.find(m => m.label === 'Final'); let clock = 0;
  const play = async (id, w) => { await t.admin('POST', `/api/matches/${id}/schedule`, { court_id: 1, scheduled_at: soon(60 * ++clock) }); await t.scorer('POST', `/api/matches/${id}/start`, {}); await playMatch(t.scorer, id, w); await t.scorer('POST', `/api/matches/${id}/confirm`, {}); };
  await play(sf[0].id, 'a'); await play(sf[1].id, 'a');
  const before = (await t.admin('GET', `/api/matches/${fin.id}`)).body.match; assert.ok(before.a && before.b);
  assert.equal((await t.admin('POST', `/api/matches/${sf[0].id}/reset`, { reason: '' })).status, 422, 'reason required');
  assert.equal((await t.scorer('POST', `/api/matches/${sf[0].id}/reset`, { reason: 'oops' })).status, 403, 'only admins reset');
  assert.equal((await t.admin('POST', `/api/matches/${fin.id}/reset`, { reason: 'not played' })).status, 409, 'nothing to reset yet');
  const r = await t.admin('POST', `/api/matches/${sf[0].id}/reset`, { reason: 'Wrong players were on court' }); assert.equal(r.status, 200);
  assert.equal(r.body.match.status, 'pending'); assert.equal(r.body.match.final_score, null); assert.equal(r.body.match.games.length, 0); assert.equal(r.body.match.court_id, null);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM score_events WHERE match_id=?').get(sf[0].id).n, 0);
  const rolled = (await t.admin('GET', `/api/matches/${fin.id}`)).body.match; assert.equal(rolled.a, null, 'winner removed from the final'); assert.ok(rolled.b, 'the other finalist is untouched');
  const hist = (await t.admin('GET', `/api/matches/${sf[0].id}`)).body.corrections; assert.equal(hist.length, 1); assert.equal(JSON.parse(hist[0].after).reset, true); assert.match(hist[0].before, /21-0/);
  assert.equal((await t.admin('POST', `/api/matches/${fin.id}/schedule`, { court_id: 2, scheduled_at: soon(500) })).status, 200);
  assert.equal((await t.scorer('POST', `/api/matches/${fin.id}/start`, {})).status, 409, 'final cannot start until the semifinal is replayed');
  await play(sf[0].id, 'b'); assert.equal((await t.admin('GET', `/api/matches/${fin.id}`)).body.match.a.id, sf[0].b.id, 'replayed result advances the other player');
  // later match started -> cannot reset the earlier one
  await t.scorer('POST', `/api/matches/${fin.id}/start`, {});
  const blocked = await t.admin('POST', `/api/matches/${sf[0].id}/reset`, { reason: 'too late' }); assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'downstream_started');
  assert.equal((await t.admin('POST', `/api/matches/${fin.id}/reset`, { reason: 'restart the final' })).body.match.status, 'pending', 'a live match can be restarted from 0-0');
  assert.equal((await t.admin('POST', `/api/matches/${sf[0].id}/reset`, { reason: 'now allowed' })).status, 200);
  // a cancelled match can be brought back
  await t.admin('POST', `/api/matches/${sf[1].id}/reset`, { reason: 'redo' }); await t.admin('POST', `/api/matches/${sf[1].id}/cancel`, { reason: 'rain' });
  assert.equal((await t.admin('POST', `/api/matches/${sf[1].id}/reset`, { reason: 'un-cancel' })).body.match.status, 'pending');
  await t.close();
});

test('deleting matches, clearing fixtures and deleting categories', async () => {
  const t = await env(); const { cat, matches } = await setupCategory(t.admin, 4); const sf = matches.filter(m => m.label === 'Semifinal');
  assert.equal((await t.admin('DELETE', `/api/matches/${sf[0].id}`)).body.code, 'in_bracket', 'bracket matches cannot be deleted one by one');
  assert.equal((await t.staff('DELETE', `/api/matches/${sf[0].id}`)).status, 403);
  const teams = t.db.prepare('SELECT id FROM teams WHERE category_id=?').all(cat); const manual = (await t.admin('POST', '/api/categories', { name: 'Manual cat', kind: 'singles' })).body.id;
  const mt = []; for (let i = 1; i <= 2; i++) { await t.admin('POST', '/api/registrations/admin', { player: { name: `Man ${i}`, gender: 'male', college_id: `MAN${i}` }, category_ids: [manual] }); }
  for (const r of (await t.admin('GET', `/api/registrations?category=${manual}`)).body.registrations) await t.admin('PATCH', `/api/registrations/${r.id}`, { status: 'approved' });
  const tm = t.db.prepare('SELECT id FROM teams WHERE category_id=?').all(manual); void mt; void teams;
  const nm = (await t.admin('POST', '/api/matches', { category_id: manual, team_a: tm[0].id, team_b: tm[1].id, round: 1 })).body.match;
  assert.equal((await t.admin('DELETE', `/api/matches/${nm.id}`)).status, 200, 'manual match can be deleted'); assert.equal((await t.admin('GET', `/api/matches/${nm.id}`)).status, 404);
  // clear fixtures: blocked once something was played, allowed with force
  await t.admin('POST', `/api/matches/${sf[0].id}/schedule`, { court_id: 1, scheduled_at: soon(5) }); await t.scorer('POST', `/api/matches/${sf[0].id}/start`, {}); await playMatch(t.scorer, sf[0].id, 'a'); await t.scorer('POST', `/api/matches/${sf[0].id}/confirm`, {});
  const no = await t.admin('POST', `/api/categories/${cat}/clear-fixtures`, {}); assert.equal(no.status, 409); assert.equal(no.body.code, 'has_results');
  assert.equal((await t.staff('POST', `/api/categories/${cat}/clear-fixtures`, { force: true })).status, 403);
  assert.equal((await t.admin('POST', `/api/categories/${cat}/clear-fixtures`, { force: true })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM matches WHERE category_id=?').get(cat).n, 0); assert.equal(t.db.prepare('SELECT generated g FROM categories WHERE id=?').get(cat).g, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM games').get().n, 0, 'scores are gone');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(cat).n, 4, 'teams and registrations stay');
  await t.admin('POST', '/api/registrations/admin', { player: { name: 'Late Entry', gender: 'male', college_id: 'LATE1' }, category_ids: [cat] });
  const late = (await t.admin('GET', `/api/registrations?category=${cat}&status=pending`)).body.registrations[0]; assert.equal((await t.admin('PATCH', `/api/registrations/${late.id}`, { status: 'approved' })).status, 200, 'late entries can be approved after clearing');
  assert.equal((await t.admin('POST', `/api/categories/${cat}/generate`, {})).status, 200); assert.equal(t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(cat).n, 5);
  // category delete needs force when it has content
  const d1 = await t.admin('DELETE', `/api/categories/${cat}`, {}); assert.equal(d1.status, 409); assert.equal(d1.body.code, 'not_empty'); assert.equal(d1.body.counts.teams, 5);
  assert.equal((await t.admin('DELETE', `/api/categories/${cat}`, { force: true })).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM matches WHERE category_id=?').get(cat).n + t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(cat).n + t.db.prepare('SELECT COUNT(*) n FROM registrations WHERE category_id=?').get(cat).n, 0);
  assert.ok(t.db.prepare("SELECT 1 FROM players WHERE name='Late Entry'").get(), 'players themselves are kept when a category is deleted');
  await t.close();
});

test('removing players and entries: brackets rebuild, results are protected, doubles partners handled', async () => {
  const t = await env(); const { cat, matches } = await setupCategory(t.admin, 4);
  const sf = matches.find(m => m.label === 'Semifinal'); await t.admin('POST', `/api/matches/${sf.id}/schedule`, { court_id: 1, scheduled_at: soon(30) });
  const pid = id => t.db.prepare('SELECT player1_id p FROM teams WHERE id=?').get(id).p, victim = pid(sf.a.id);
  assert.equal((await t.staff('DELETE', `/api/players/${victim}`)).status, 403, 'only admins delete players');
  assert.equal((await t.admin('DELETE', `/api/players/${victim}`, {})).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM players WHERE id=?').get(victim).n, 0); assert.equal(t.db.prepare('SELECT COUNT(*) n FROM registrations WHERE player_id=?').get(victim).n, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(cat).n, 3);
  const rebuilt = (await t.admin('GET', `/api/matches?category=${cat}`)).body.matches; assert.equal(rebuilt.length, 3, '3 teams -> 1 bye + semi + final');
  assert.equal(rebuilt.filter(m => m.status === 'bye').length, 1); assert.ok(rebuilt.every(m => m.status === 'bye' || m.status === 'pending'), 'old court assignments were cleared with the old draw');
  assert.ok(rebuilt.every(m => ![m.a, m.b].some(x => x && x.id === sf.a.id)), 'removed team appears nowhere');
  // results protect: need force
  const real = rebuilt.find(m => m.status === 'pending' && m.a && m.b); await t.admin('POST', `/api/matches/${real.id}/schedule`, { court_id: 1, scheduled_at: soon(90) }); await t.scorer('POST', `/api/matches/${real.id}/start`, {}); await playMatch(t.scorer, real.id, 'a'); await t.scorer('POST', `/api/matches/${real.id}/confirm`, {});
  const other = pid(real.b.id), guard = await t.admin('DELETE', `/api/players/${other}`, {}); assert.equal(guard.status, 409); assert.equal(guard.body.code, 'has_results'); assert.ok(t.db.prepare('SELECT 1 FROM players WHERE id=?').get(other), 'nothing deleted when refused');
  assert.equal((await t.admin('DELETE', `/api/players/${other}`, { force: true })).status, 200);
  assert.equal(t.db.prepare('SELECT generated g FROM categories WHERE id=?').get(cat).g, 0, 'fixtures were discarded'); assert.equal(t.db.prepare('SELECT COUNT(*) n FROM matches WHERE category_id=?').get(cat).n, 0);
  // registration delete + doubles partner
  const dbl = (await t.admin('POST', '/api/categories', { name: 'Pairs', kind: 'doubles', published: true })).body.id;
  for (const n of ['P1', 'P2']) await t.admin('POST', '/api/registrations/admin', { player: { name: n + 'a', gender: 'male', college_id: n + 'a' }, partner: { name: n + 'b', gender: 'male', college_id: n + 'b' }, category_ids: [dbl] });
  for (const r of (await t.admin('GET', `/api/registrations?category=${dbl}&status=pending`)).body.registrations) await t.admin('PATCH', `/api/registrations/${r.id}`, { status: 'approved' });
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(dbl).n, 2);
  const p1a = t.db.prepare("SELECT id FROM players WHERE college_id='P1a'").get().id; assert.equal((await t.admin('DELETE', `/api/players/${p1a}`, {})).status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(dbl).n, 1, 'their pair is dissolved');
  const orphan = t.db.prepare("SELECT r.* FROM registrations r JOIN players p ON p.id=r.player_id WHERE p.college_id='P1b'").get(); assert.equal(orphan.status, 'rejected'); assert.equal(orphan.partner_player_id, null); assert.match(orphan.reason, /Partner was removed/);
  assert.equal((await t.staff('DELETE', `/api/registrations/${orphan.id}`)).status, 403); assert.equal((await t.admin('DELETE', `/api/registrations/${orphan.id}`, {})).status, 200); assert.equal(t.db.prepare('SELECT COUNT(*) n FROM registrations WHERE id=?').get(orphan.id).n, 0);
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action='player.delete'").get() && t.db.prepare("SELECT 1 FROM audit_log WHERE action='team.remove'").get(), 'removals are audited');
  await t.close();
});

test('removing users, courts and volunteers: safeguards and edits', async () => {
  const t = await env(); const me = (await t.admin('GET', '/api/auth/me')).body.user; const users = (await t.admin('GET', '/api/users')).body.users;
  assert.equal((await t.admin('DELETE', `/api/users/${me.id}`, {})).status, 409, 'cannot delete yourself'); assert.equal((await t.staff('DELETE', `/api/users/${users[0].id}`, {})).status, 403);
  const viewerId = users.find(u => u.username === 'viewer1').id; assert.equal((await t.admin('DELETE', `/api/users/${viewerId}`, {})).status, 200); assert.equal((await t.viewer('GET', '/api/auth/me')).body.user, null, 'their session ends');
  await t.admin('POST', '/api/users', { username: 'admin2', password: 'long-enough-password', role: 'admin' }); const a2 = (await t.admin('GET', '/api/users')).body.users.find(u => u.username === 'admin2').id;
  const second = await t.client().login('admin2', 'long-enough-password'); assert.equal((await second('DELETE', `/api/users/${me.id}`, {})).status, 200, 'another admin may delete an admin when one remains'); assert.equal((await second('DELETE', `/api/users/${a2}`, {})).status, 409);
  // courts
  const { matches } = await setupCategory(second, 4); const sf = matches.find(m => m.label === 'Semifinal');
  assert.equal((await second('POST', '/api/courts', { name: 'Court 4' })).status, 201); const c4 = (await second('GET', '/api/courts')).body.courts.find(c => c.name === 'Court 4').id;
  await second('POST', `/api/matches/${sf.id}/schedule`, { court_id: c4, scheduled_at: soon(20) });
  assert.equal((await second('PATCH', `/api/courts/${c4}`, { name: 'Show Court' })).status, 200);
  const del = await second('DELETE', `/api/courts/${c4}`, {}); assert.equal(del.status, 200); assert.equal(del.body.unscheduled, 1);
  const back = (await second('GET', `/api/matches/${sf.id}`)).body.match; assert.equal(back.status, 'pending'); assert.equal(back.court_id, null);
  await second('POST', `/api/matches/${sf.id}/schedule`, { court_id: 1, scheduled_at: soon(20) }); const sc = await t.client().login('scorer1'); await sc('POST', `/api/matches/${sf.id}/start`, {}); await playMatch(sc, sf.id, 'a'); await sc('POST', `/api/matches/${sf.id}/confirm`, {});
  assert.equal((await second('DELETE', '/api/courts/1', {})).status, 409, 'a court with finished matches cannot be deleted');
  // volunteers
  const v = await second('POST', '/api/volunteers', { name: 'Ravi', role: 'Scorer' }); assert.equal((await second('PATCH', `/api/volunteers/${v.body.id}`, { role: 'Referee', court_id: 2, shift: 'AM' })).status, 200);
  const list = (await second('GET', '/api/volunteers')).body.volunteers; assert.equal(list[0].role, 'Referee'); assert.equal(list[0].court, 'Court 2');
  assert.equal((await second('DELETE', `/api/volunteers/${v.body.id}`, {})).status, 200); assert.equal((await t.staff('PATCH', `/api/volunteers/${v.body.id}`, { role: 'x' })).status, 403);
  await t.close();
});
