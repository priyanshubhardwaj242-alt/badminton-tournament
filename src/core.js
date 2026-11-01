const crypto = require('node:crypto');
const { tx } = require('./db');
const S = require('./scoring');
const B = require('./bracket');

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }
const E = (s, m, x) => new HttpError(s, m, x);
const now = () => new Date().toISOString();
const LIVE = ['in_progress', 'paused', 'awaiting_confirmation', 'disputed'];
const OCCUPY = ['scheduled', ...LIVE];
const FINISHED = ['completed', 'walkover', 'bye'];
const ph = a => a.map(() => '?').join(',');

// ---------- permissions ----------
const PERMS = {
  admin: ['*'],
  scorer: ['panel', 'score', 'match.control', 'checkin'],
  staff: ['panel', 'checkin', 'registration.review', 'schedule.assign', 'match.control', 'announce', 'players.private'],
  player: [], viewer: [],
};
const can = (user, perm) => !!user && user.active !== 0 && (PERMS[user.role] || []).some(p => p === '*' || p === perm);

// ---------- settings / audit ----------
function settings(db) { const o = {}; for (const r of db.prepare('SELECT key,value FROM settings').all()) o[r.key] = r.value; return o; }
function audit(db, user, action, entity, entityId, details, ip) {
  db.prepare('INSERT INTO audit_log(user_id,username,action,entity,entity_id,details,ip,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(user ? user.id : null, user ? user.username : 'system', action, entity || null, entityId ?? null, details ? JSON.stringify(details) : null, ip || null, now());
}
const matchRules = db => S.normRules(JSON.parse(settings(db).rules));

// ---------- views ----------
const MSEL = `SELECT m.*, c.name category_name, c.published cat_published, c.kind cat_kind, ct.name court_name, ta.name a_name, tb.name b_name
 FROM matches m JOIN categories c ON c.id=m.category_id LEFT JOIN courts ct ON ct.id=m.court_id
 LEFT JOIN teams ta ON ta.id=m.team_a LEFT JOIN teams tb ON tb.id=m.team_b`;

function toViews(db, rows, pub) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id), gm = {};
  for (const g of db.prepare(`SELECT * FROM games WHERE match_id IN (${ph(ids)}) ORDER BY game_no`).all(...ids)) (gm[g.match_id] ||= []).push({ game_no: g.game_no, a: g.a, b: g.b, complete: !!g.complete });
  return rows.map(m => {
    const v = {
      id: m.id, category_id: m.category_id, category_name: m.category_name, group_no: m.group_no, round: m.round, number: m.number, label: m.label,
      a: m.team_a ? { id: m.team_a, name: m.a_name } : null, b: m.team_b ? { id: m.team_b, name: m.b_name } : null,
      court_id: m.court_id, court_name: m.court_name, scheduled_at: m.scheduled_at, status: m.status, games: gm[m.id] || [],
      final_score: m.final_score, winner_team: m.winner_team, winner: m.winner_team ? (m.winner_team === m.team_a ? 'a' : 'b') : null,
      result_type: m.result_type, started_at: m.started_at, finished_at: m.finished_at, version: m.version,
      rules: m.rules ? JSON.parse(m.rules) : null, next_match_id: m.next_match_id,
    };
    if (!pub) Object.assign(v, { notes: m.notes, dispute_note: m.dispute_note, walkover_reason: m.walkover_reason, called_at: m.called_at, scorer_id: m.scorer_id, confirmed_by: m.confirmed_by, confirmed_at: m.confirmed_at });
    return v;
  });
}
function listMatches(db, { pub, where = '', params = [] } = {}) {
  const w = [where, pub ? 'c.published=1' : ''].filter(Boolean).join(' AND ');
  const rows = db.prepare(`${MSEL} ${w ? 'WHERE ' + w : ''} ORDER BY (m.scheduled_at IS NULL), m.scheduled_at, m.category_id, m.group_no, m.round, m.number`).all(...params);
  return toViews(db, rows, pub);
}
function getRow(db, id) { const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id); if (!m) throw E(404, 'Match not found'); return m; }
function matchView(db, id, pub) { const r = db.prepare(`${MSEL} WHERE m.id=?`).get(id); if (!r) throw E(404, 'Match not found'); return toViews(db, [r], pub)[0]; }

function playerIds(db, m) {
  const ids = new Set();
  for (const t of [m.team_a, m.team_b]) {
    if (!t) continue;
    const r = db.prepare('SELECT player1_id,player2_id FROM teams WHERE id=?').get(t);
    if (r) { ids.add(r.player1_id); if (r.player2_id) ids.add(r.player2_id); }
  }
  return ids;
}
const checkVersion = (m, v) => { if (v !== undefined && v !== null && Number(v) !== m.version) throw E(409, 'This match was changed by someone else. Reloaded the latest state.', { code: 'stale', match: null }); };
const bump = (db, id, set, params) => db.prepare(`UPDATE matches SET ${set}, version=version+1 WHERE id=?`).run(...params, id);

// ---------- scheduling ----------
function findConflicts(db, m, courtId, startIso) {
  const mins = Number(settings(db).match_minutes) || 35;
  const court = db.prepare('SELECT * FROM courts WHERE id=?').get(courtId);
  if (!court) throw E(404, 'Court not found');
  const start = Date.parse(startIso), end = start + mins * 60000, out = [];
  if (court.status === 'maintenance') out.push({ type: 'court_unavailable', overridable: true, message: `${court.name} is under maintenance` });
  const mine = playerIds(db, m);
  const others = db.prepare(`SELECT * FROM matches WHERE id<>? AND status IN (${ph(OCCUPY)}) AND scheduled_at IS NOT NULL`).all(m.id, ...OCCUPY);
  for (const o of others) {
    const os = Math.min(Date.parse(o.scheduled_at), Date.parse(o.started_at || o.scheduled_at));
    let oe = Date.parse(o.scheduled_at) + mins * 60000; if (LIVE.includes(o.status)) oe = Math.max(oe, Date.now());
    if (!(start < oe && os < end)) continue;
    if (o.court_id === courtId) out.push({ type: 'court_double_booked', overridable: true, match_id: o.id, message: `${court.name} already has match #${o.id} scheduled in that time window` });
    const shared = [...playerIds(db, o)].filter(p => mine.has(p));
    if (shared.length) {
      const names = db.prepare(`SELECT name FROM players WHERE id IN (${ph(shared)})`).all(...shared).map(r => r.name).join(', ');
      out.push({ type: 'player_overlap', overridable: false, match_id: o.id, message: `${names} already plays match #${o.id} at an overlapping time` });
    }
  }
  return out;
}

function schedule(db, user, id, { court_id, scheduled_at, override, reason, version }, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (!['pending', 'scheduled', 'postponed'].includes(m.status)) throw E(409, `A ${m.status} match cannot be scheduled`);
    checkVersion(m, version);
    if (!Number.isInteger(court_id)) throw E(422, 'court_id is required');
    if (!scheduled_at || Number.isNaN(Date.parse(scheduled_at))) throw E(422, 'A valid scheduled time is required');
    const iso = new Date(scheduled_at).toISOString();
    const conflicts = findConflicts(db, m, court_id, iso);
    const hard = conflicts.filter(c => !c.overridable), soft = conflicts.filter(c => c.overridable);
    if (hard.length) throw E(409, hard[0].message, { code: 'player_overlap', conflicts });
    if (soft.length) {
      if (!override) throw E(409, soft[0].message, { code: 'needs_override', conflicts });
      if (!can(user, 'schedule.override')) throw E(403, 'Only an administrator can override scheduling warnings', { conflicts });
      if (!reason || String(reason).trim().length < 3) throw E(422, 'A reason is required to override scheduling warnings');
    }
    bump(db, id, "court_id=?, scheduled_at=?, status='scheduled', called_at=NULL", [court_id, iso]);
    audit(db, user, soft.length ? 'match.schedule_override' : 'match.schedule', 'match', id, { court_id, scheduled_at: iso, overridden: soft.map(c => c.type), reason }, ip);
    return { match: matchView(db, id), overridden: soft };
  });
}

function postpone(db, user, id, { reason, version }, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (!['pending', 'scheduled'].includes(m.status)) throw E(409, 'Only matches that have not started can be postponed');
    checkVersion(m, version);
    bump(db, id, "status='postponed', court_id=NULL, scheduled_at=NULL, called_at=NULL", []);
    audit(db, user, 'match.postpone', 'match', id, { reason }, ip);
    return matchView(db, id);
  });
}
function cancel(db, user, id, { reason, version }, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (FINISHED.includes(m.status) || m.status === 'cancelled') throw E(409, 'This match is already finished');
    if (!reason || reason.trim().length < 3) throw E(422, 'A reason is required to cancel a match');
    checkVersion(m, version);
    bump(db, id, "status='cancelled', notes=?", [`Cancelled: ${reason}`]);
    audit(db, user, 'match.cancel', 'match', id, { reason, previous: m.status }, ip);
    return matchView(db, id);
  });
}
function callup(db, user, id, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (m.status !== 'scheduled') throw E(409, 'Only scheduled matches can be called');
    if (!m.team_a || !m.team_b) throw E(409, 'Both participants must be known before calling the match');
    bump(db, id, 'called_at=?', [now()]);
    audit(db, user, 'match.callup', 'match', id, null, ip);
    return matchView(db, id);
  });
}

// ---------- match control ----------
function start(db, user, id, { version } = {}, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (m.status !== 'scheduled') throw E(409, `Only a scheduled match can be started (current status: ${m.status})`);
    checkVersion(m, version);
    if (!m.court_id) throw E(409, 'Assign a court first');
    if (!m.team_a || !m.team_b) throw E(409, 'Both participants must be known before starting');
    const court = db.prepare('SELECT * FROM courts WHERE id=?').get(m.court_id);
    if (court.status !== 'active') throw E(409, `${court.name} is under maintenance`);
    const busy = db.prepare(`SELECT id FROM matches WHERE court_id=? AND id<>? AND status IN (${ph(LIVE)})`).get(m.court_id, id, ...LIVE);
    if (busy) throw E(409, `${court.name} still has match #${busy.id} in progress. Finalize it first.`, { code: 'court_busy' });
    const mine = playerIds(db, m);
    for (const o of db.prepare(`SELECT * FROM matches WHERE id<>? AND status IN (${ph(LIVE)})`).all(id, ...LIVE)) {
      if ([...playerIds(db, o)].some(p => mine.has(p))) throw E(409, `A player in this match is already in live match #${o.id}`, { code: 'player_busy' });
    }
    const warnings = [];
    const unchecked = db.prepare(`SELECT name FROM players WHERE id IN (${ph([...mine])}) AND checked_in_at IS NULL`).all(...mine).map(r => r.name);
    if (unchecked.length) warnings.push(`Not checked in: ${unchecked.join(', ')}`);
    const rules = JSON.stringify(matchRules(db));
    bump(db, id, "status='in_progress', started_at=?, scorer_id=?, rules=?", [now(), user.id, rules]);
    materialize(db, id);
    audit(db, user, 'match.start', 'match', id, { court_id: m.court_id, warnings }, ip);
    return { match: matchView(db, id), warnings };
  });
}
function pauseResume(db, user, id, to, ip) {
  return tx(db, () => {
    const m = getRow(db, id), from = to === 'paused' ? 'in_progress' : 'paused';
    if (m.status !== from) throw E(409, `Match is ${m.status}; cannot ${to === 'paused' ? 'pause' : 'resume'}`);
    bump(db, id, 'status=?', [to]);
    audit(db, user, to === 'paused' ? 'match.pause' : 'match.resume', 'match', id, null, ip);
    return matchView(db, id);
  });
}

// ---------- scoring ----------
function materialize(db, id) {
  const m = getRow(db, id), rules = m.rules ? JSON.parse(m.rules) : matchRules(db);
  const sides = db.prepare('SELECT side FROM score_events WHERE match_id=? AND undone=0 ORDER BY id').all(id).map(r => r.side);
  const st = S.replay(sides, rules);
  db.prepare('DELETE FROM games WHERE match_id=?').run(id);
  const ins = db.prepare('INSERT INTO games(match_id,game_no,a,b,complete) VALUES(?,?,?,?,?)');
  st.games.forEach((g, i) => ins.run(id, i + 1, g.a, g.b, 1));
  if (st.current) ins.run(id, st.games.length + 1, st.current.a, st.current.b, 0);
  return st;
}
function point(db, user, id, { side, client_id, version }, ip) {
  return tx(db, () => {
    if (!['a', 'b'].includes(side)) throw E(422, 'side must be "a" or "b"');
    if (typeof client_id !== 'string' || !client_id || client_id.length > 64) throw E(422, 'client_id is required');
    const m = getRow(db, id);
    if (db.prepare('SELECT 1 FROM score_events WHERE match_id=? AND client_id=?').get(id, client_id)) return { match: matchView(db, id), duplicate: true };
    if (m.status === 'paused') throw E(409, 'Match is paused. Resume to continue scoring.');
    if (m.status !== 'in_progress') throw E(409, `Cannot score a match that is ${m.status}`);
    checkVersion(m, version);
    db.prepare('INSERT INTO score_events(match_id,client_id,side,user_id,created_at) VALUES(?,?,?,?,?)').run(id, client_id, side, user.id, now());
    const st = materialize(db, id);
    if (st.winner) bump(db, id, "status='awaiting_confirmation', final_score=?", [S.scoreString(st.games)]);
    else bump(db, id, 'scorer_id=?', [user.id]);
    return { match: matchView(db, id) };
  });
}
function undo(db, user, id, { version } = {}, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (!['in_progress', 'paused', 'awaiting_confirmation'].includes(m.status)) throw E(409, `Cannot undo while match is ${m.status}`);
    checkVersion(m, version);
    const ev = db.prepare('SELECT id,side FROM score_events WHERE match_id=? AND undone=0 ORDER BY id DESC LIMIT 1').get(id);
    if (!ev) throw E(409, 'Nothing to undo');
    db.prepare('UPDATE score_events SET undone=1 WHERE id=?').run(ev.id);
    materialize(db, id);
    bump(db, id, "status=CASE WHEN status='awaiting_confirmation' THEN 'in_progress' ELSE status END, final_score=NULL", []);
    audit(db, user, 'score.undo', 'match', id, { side: ev.side }, ip);
    return matchView(db, id);
  });
}
function winnerFromGames(db, id, rules) {
  const games = db.prepare('SELECT a,b FROM games WHERE match_id=? AND complete=1 ORDER BY game_no').all(id);
  const v = S.validateGames(games, rules);
  return { ...v, games };
}

// place winner/loser into later matches; refuses if that match already started
function place(db, matchId, slot, teamId) {
  const t = getRow(db, matchId);
  if (LIVE.includes(t.status) || ['completed', 'walkover'].includes(t.status)) throw E(409, `Cannot change the result: the next match (#${t.id}) has already started or finished`, { code: 'downstream_started' });
  db.prepare(`UPDATE matches SET ${slot === 'a' ? 'team_a' : 'team_b'}=?, version=version+1 WHERE id=?`).run(teamId, matchId);
}
function applyResult(db, m, winnerTeam) {
  const loser = winnerTeam === m.team_a ? m.team_b : m.team_a;
  if (m.next_match_id) place(db, m.next_match_id, m.next_slot, winnerTeam);
  if (m.loser_match_id) place(db, m.loser_match_id, m.loser_slot, loser);
}

function confirm(db, user, id, { version } = {}, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (m.status === 'completed' || m.status === 'walkover') throw E(409, 'This result has already been finalized');
    if (m.status !== 'awaiting_confirmation') throw E(409, 'The match has no completed score to confirm');
    checkVersion(m, version);
    const w = winnerFromGames(db, id, JSON.parse(m.rules));
    if (!w.ok) throw E(409, w.error);
    const winnerTeam = w.winner === 'a' ? m.team_a : m.team_b;
    bump(db, id, "status='completed', result_type='played', winner_team=?, final_score=?, finished_at=?, confirmed_by=?, confirmed_at=?",
      [winnerTeam, S.scoreString(w.games), now(), user.id, now()]);
    applyResult(db, m, winnerTeam);
    audit(db, user, 'result.confirm', 'match', id, { winner_team: winnerTeam, score: S.scoreString(w.games) }, ip);
    return matchView(db, id);
  });
}

// manual game-by-game entry (direct entry for quick events) and admin corrections
function setGames(db, user, id, { games, reason, version }, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    const afterPlay = ['awaiting_confirmation', 'disputed', 'completed'].includes(m.status);
    if (!afterPlay && !['scheduled', 'in_progress', 'paused'].includes(m.status)) throw E(409, `Cannot enter a score for a ${m.status} match`);
    if (afterPlay && !can(user, 'score.correct')) throw E(403, 'Only an administrator can correct a submitted score');
    if (!m.team_a || !m.team_b) throw E(409, 'Both participants must be known');
    if (afterPlay && (!reason || reason.trim().length < 3)) throw E(422, 'A reason is required for score corrections');
    checkVersion(m, version);
    const rules = m.rules ? JSON.parse(m.rules) : matchRules(db);
    const clean = Array.isArray(games) ? games.map(g => ({ a: Number(g.a), b: Number(g.b) })) : [];
    const v = S.validateGames(clean, rules);
    if (!v.ok) throw E(422, v.error);
    const before = { status: m.status, final_score: m.final_score, games: db.prepare('SELECT a,b FROM games WHERE match_id=? ORDER BY game_no').all(id), winner_team: m.winner_team };
    db.prepare('UPDATE score_events SET undone=1 WHERE match_id=?').run(id);
    db.prepare('DELETE FROM games WHERE match_id=?').run(id);
    clean.forEach((g, i) => db.prepare('INSERT INTO games(match_id,game_no,a,b,complete) VALUES(?,?,?,?,1)').run(id, i + 1, g.a, g.b));
    const fs = S.scoreString(clean), newWinner = v.winner === 'a' ? m.team_a : m.team_b;
    if (m.status === 'completed') {
      if (newWinner !== m.winner_team) applyResult(db, { ...m }, newWinner);
      bump(db, id, 'winner_team=?, final_score=?', [newWinner, fs]);
    } else {
      bump(db, id, "status='awaiting_confirmation', final_score=?, rules=?, scorer_id=?, dispute_note=NULL, dispute_prev=NULL, started_at=COALESCE(started_at, ?)", [fs, JSON.stringify(rules), user.id, now()]);
    }
    if (afterPlay) db.prepare('INSERT INTO corrections(match_id,user_id,username,reason,before,after,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, user.id, user.username, reason.trim(), JSON.stringify(before), JSON.stringify({ games: clean, final_score: fs, winner_team: newWinner }), now());
    audit(db, user, afterPlay ? 'score.correct' : 'score.enter', 'match', id, { before: before.final_score, after: fs, reason }, ip);
    return matchView(db, id);
  });
}

function dispute(db, user, id, { note }, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (!['in_progress', 'paused', 'awaiting_confirmation'].includes(m.status)) throw E(409, `Cannot dispute a ${m.status} match`);
    if (!note || note.trim().length < 3) throw E(422, 'Describe the dispute');
    bump(db, id, "status='disputed', dispute_prev=?, dispute_note=?", [m.status, note.trim()]);
    audit(db, user, 'score.dispute', 'match', id, { note }, ip);
    return matchView(db, id);
  });
}
function resolveDispute(db, user, id, { note }, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (m.status !== 'disputed') throw E(409, 'Match is not disputed');
    const to = m.dispute_prev === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'paused';
    bump(db, id, 'status=?, dispute_prev=NULL, notes=?', [to, `Dispute resolved: ${note || ''}`.trim()]);
    audit(db, user, 'score.dispute_resolved', 'match', id, { note, to }, ip);
    return matchView(db, id);
  });
}

function walkover(db, user, id, { winner, reason, version }, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (!['pending', 'scheduled', 'postponed', 'in_progress', 'paused'].includes(m.status)) throw E(409, `Cannot record a walkover for a ${m.status} match`);
    if (!['a', 'b'].includes(winner)) throw E(422, 'winner must be "a" or "b"');
    if (!reason || reason.trim().length < 3) throw E(422, 'A reason is required for a walkover');
    if (!m.team_a || !m.team_b) throw E(409, 'Both participants must be known');
    checkVersion(m, version);
    const wt = winner === 'a' ? m.team_a : m.team_b;
    bump(db, id, "status='walkover', result_type='walkover', winner_team=?, final_score='W/O', walkover_reason=?, finished_at=?, confirmed_by=?, confirmed_at=?",
      [wt, reason.trim(), now(), user.id, now()]);
    applyResult(db, m, wt);
    audit(db, user, 'match.walkover', 'match', id, { winner_team: wt, reason }, ip);
    return matchView(db, id);
  });
}
function noShow(db, user, id, { side, version }, ip) {
  const m = getRow(db, id);
  if (m.status !== 'scheduled' || !m.called_at) throw E(409, 'Call the players first; the grace period starts at the call-up');
  const grace = Number(settings(db).grace_minutes) || 10, left = Date.parse(m.called_at) + grace * 60000 - Date.now();
  if (left > 0) throw E(409, `Grace period not over: ${Math.ceil(left / 60000)} min remaining`, { code: 'grace_period', remaining_ms: left });
  if (!['a', 'b'].includes(side)) throw E(422, 'side must be "a" or "b" (the absent side)');
  const name = side === 'a' ? db.prepare('SELECT name FROM teams WHERE id=?').get(m.team_a)?.name : db.prepare('SELECT name FROM teams WHERE id=?').get(m.team_b)?.name;
  return walkover(db, user, id, { winner: side === 'a' ? 'b' : 'a', reason: `No-show: ${name} (grace period ${grace} min)`, version }, ip);
}

// ---------- fixtures ----------
const PLAYED = ['in_progress', 'paused', 'awaiting_confirmation', 'disputed', 'completed', 'walkover'];
function wipeMatches(db, categoryId) {
  const ids = db.prepare('SELECT id FROM matches WHERE category_id=?').all(categoryId).map(r => r.id);
  if (!ids.length) return 0;
  db.prepare('UPDATE matches SET next_match_id=NULL, loser_match_id=NULL WHERE category_id=?').run(categoryId);
  for (const t of ['games', 'score_events', 'corrections']) db.prepare(`DELETE FROM ${t} WHERE match_id IN (${ph(ids)})`).run(...ids);
  db.prepare('DELETE FROM matches WHERE category_id=?').run(categoryId);
  return ids.length;
}
function generateInner(db, user, categoryId, { shuffle } = {}, ip) {
  {
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId);
    if (!c) throw E(404, 'Category not found');
    const existing = db.prepare('SELECT status FROM matches WHERE category_id=?').all(categoryId);
    if (existing.some(r => !['pending', 'scheduled', 'bye', 'postponed'].includes(r.status))) throw E(409, 'Fixtures cannot be regenerated after matches have started');
    let teams = db.prepare('SELECT id,seed FROM teams WHERE category_id=? ORDER BY (seed IS NULL), seed, id').all(categoryId);
    if (teams.length < 2) throw E(422, 'At least 2 approved teams are needed');
    if (shuffle) {
      const seeded = teams.filter(t => t.seed != null), rest = teams.filter(t => t.seed == null);
      for (let i = rest.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1);[rest[i], rest[j]] = [rest[j], rest[i]]; }
      teams = [...seeded, ...rest];
    }
    wipeMatches(db, categoryId);
    const plan = c.format === 'roundrobin' ? B.planRoundRobin(teams.map(t => t.id), c.groups) : B.planKnockout(teams.map(t => t.id), { thirdPlace: !!c.third_place });
    const rowId = {}, ins = db.prepare('INSERT INTO matches(category_id,group_no,round,number,label,team_a,team_b,status) VALUES(?,?,?,?,?,?,?,?)');
    for (const p of plan) rowId[p.key] = Number(ins.run(categoryId, p.group_no || 0, p.round, p.number, p.label, p.a, p.b, p.bye ? 'bye' : 'pending').lastInsertRowid);
    for (const p of plan) db.prepare('UPDATE matches SET next_match_id=?, next_slot=?, loser_match_id=?, loser_slot=? WHERE id=?')
      .run(p.next ? rowId[p.next.key] : null, p.next ? p.next.slot : null, p.loser ? rowId[p.loser.key] : null, p.loser ? p.loser.slot : null, rowId[p.key]);
    for (const p of plan.filter(p => p.bye)) {
      const w = p.a || p.b;
      db.prepare("UPDATE matches SET winner_team=?, result_type='bye', final_score='BYE' WHERE id=?").run(w, rowId[p.key]);
      place(db, rowId[p.next.key], p.next.slot, w);
    }
    db.prepare('UPDATE categories SET generated=1 WHERE id=?').run(categoryId);
    audit(db, user, 'fixtures.generate', 'category', categoryId, { matches: plan.length, teams: teams.length, shuffle: !!shuffle }, ip);
    return { matches: plan.length, byes: plan.filter(p => p.bye).length };
  }
}
const generate = (...a) => tx(a[0], () => generateInner(...a));

function createMatch(db, user, d, ip) {
  return tx(db, () => {
    const cid = Number(d.category_id), a = Number(d.team_a), b = Number(d.team_b);
    if (!Number.isInteger(cid)) throw E(422, 'category_id is required');
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(cid);
    if (!c) throw E(404, 'Category not found');
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) throw E(422, 'Two different teams are required');
    if (d.label != null && typeof d.label !== 'string') throw E(422, 'label must be text');
    for (const t of [a, b]) if (!db.prepare('SELECT 1 FROM teams WHERE id=? AND category_id=?').get(t, c.id)) throw E(422, 'Team does not belong to this category');
    const dup = db.prepare("SELECT id FROM matches WHERE category_id=? AND status<>'cancelled' AND ((team_a=? AND team_b=?) OR (team_a=? AND team_b=?))").get(c.id, a, b, b, a);
    if (dup) throw E(409, `These teams already have a match in this category (#${dup.id})`);
    const round = Number(d.round) || 1, group = Number(d.group_no) || 0;
    const number = db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM matches WHERE category_id=? AND group_no=? AND round=?').get(c.id, group, round).n;
    const id = Number(db.prepare('INSERT INTO matches(category_id,group_no,round,number,label,team_a,team_b) VALUES(?,?,?,?,?,?,?)').run(c.id, group, round, number, d.label || `Round ${round}`, a, b).lastInsertRowid);
    db.prepare('UPDATE categories SET generated=1 WHERE id=?').run(c.id);
    audit(db, user, 'match.create', 'match', id, d, ip);
    return matchView(db, id);
  });
}
function editMatch(db, user, id, d, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (!['pending', 'scheduled', 'postponed'].includes(m.status)) throw E(409, 'Only matches that have not started can be edited');
    checkVersion(m, d.version);
    const a = 'team_a' in d ? d.team_a || null : m.team_a, b = 'team_b' in d ? d.team_b || null : m.team_b;
    if (a && a === b) throw E(422, 'A team cannot play itself');
    for (const t of [a, b]) if (t && !db.prepare('SELECT 1 FROM teams WHERE id=? AND category_id=?').get(t, m.category_id)) throw E(422, 'Team does not belong to this category');
    if (a && b) { const dup = db.prepare("SELECT id FROM matches WHERE id<>? AND category_id=? AND status<>'cancelled' AND ((team_a=? AND team_b=?) OR (team_a=? AND team_b=?))").get(id, m.category_id, a, b, b, a); if (dup) throw E(409, `Duplicate of match #${dup.id}`); }
    if (m.status === 'scheduled' && m.court_id) {
      const conflicts = findConflicts(db, { ...m, team_a: a, team_b: b }, m.court_id, m.scheduled_at).filter(c => c.type === 'player_overlap');
      if (conflicts.length) throw E(409, conflicts[0].message, { code: 'player_overlap', conflicts });
    }
    bump(db, id, 'team_a=?, team_b=?, notes=?', [a, b, d.notes ?? m.notes]);
    audit(db, user, 'match.edit', 'match', id, { team_a: a, team_b: b }, ip);
    return matchView(db, id);
  });
}

// ---------- courts ----------
function courtsView(db, pub) {
  const courts = db.prepare('SELECT * FROM courts ORDER BY id').all();
  const rows = listMatches(db, { pub, where: `m.status IN (${ph(OCCUPY)})`, params: OCCUPY });
  return courts.map(c => {
    const mine = rows.filter(r => r.court_id === c.id);
    const current = mine.find(r => LIVE.includes(r.status)) || null;
    const queue = mine.filter(r => r.status === 'scheduled').sort((x, y) => (x.scheduled_at || '').localeCompare(y.scheduled_at || '') || x.id - y.id);
    const state = c.status === 'maintenance' ? 'maintenance' : current ? (current.status === 'paused' ? 'paused' : 'in_progress') : queue.length ? 'upcoming' : 'available';
    return { id: c.id, name: c.name, status: c.status, note: pub ? null : c.note, state, current, next: queue[0] || null, queue };
  });
}

// ---------- standings / results ----------
function standings(db, categoryId) {
  const teams = db.prepare('SELECT id,name FROM teams WHERE category_id=?').all(categoryId);
  const st = {}; for (const t of teams) st[t.id] = { team_id: t.id, name: t.name, group_no: 1, played: 0, won: 0, lost: 0, games_for: 0, games_against: 0, points_for: 0, points_against: 0 };
  const ms = db.prepare(`SELECT * FROM matches WHERE category_id=? AND status IN ('completed','walkover')`).all(categoryId);
  for (const m of db.prepare('SELECT * FROM matches WHERE category_id=? AND group_no>0').all(categoryId)) { if (st[m.team_a]) st[m.team_a].group_no = m.group_no; if (st[m.team_b]) st[m.team_b].group_no = m.group_no; }
  for (const m of ms) {
    if (!st[m.team_a] || !st[m.team_b]) continue;
    const lose = m.winner_team === m.team_a ? m.team_b : m.team_a;
    st[m.winner_team].won++; st[lose].lost++; st[m.team_a].played++; st[m.team_b].played++;
    for (const g of db.prepare('SELECT a,b FROM games WHERE match_id=? AND complete=1').all(m.id)) {
      st[m.team_a].points_for += g.a; st[m.team_a].points_against += g.b; st[m.team_b].points_for += g.b; st[m.team_b].points_against += g.a;
      const wa = g.a > g.b; st[m.team_a][wa ? 'games_for' : 'games_against']++; st[m.team_b][wa ? 'games_against' : 'games_for']++;
    }
  }
  return Object.values(st).sort((x, y) => x.group_no - y.group_no || y.won - x.won || (y.games_for - y.games_against) - (x.games_for - x.games_against) || (y.points_for - y.points_against) - (x.points_for - x.points_against) || x.name.localeCompare(y.name));
}
function results(db, pub) {
  const cats = db.prepare(`SELECT * FROM categories ${pub ? 'WHERE published=1' : ''} ORDER BY id`).all();
  return cats.map(c => {
    const all = db.prepare("SELECT * FROM matches WHERE category_id=? AND status<>'cancelled'").all(c.id);
    const name = id => id ? db.prepare('SELECT name FROM teams WHERE id=?').get(id)?.name : null;
    const out = { category_id: c.id, name: c.name, format: c.format, total: all.length, finished: all.filter(m => FINISHED.includes(m.status)).length, champion: null, runner_up: null, third: null, standings: null };
    if (c.format === 'knockout') {
      const fin = all.find(m => m.label === 'Final'), th = all.find(m => m.label === 'Third place');
      if (fin && fin.winner_team) { out.champion = name(fin.winner_team); out.runner_up = name(fin.winner_team === fin.team_a ? fin.team_b : fin.team_a); }
      if (th && th.winner_team) out.third = name(th.winner_team);
    } else {
      out.standings = standings(db, c.id);
      if (all.length && out.finished === all.length && c.groups === 1) out.champion = out.standings[0]?.name;
    }
    return out;
  });
}

// ---------- registrations ----------
const norm = s => (s == null ? '' : String(s).trim());
function eligible(cat, players) {
  const g = players.map(p => p.gender);
  if (cat.gender === 'boys') return g.every(x => x === 'male');
  if (cat.gender === 'girls') return g.every(x => x === 'female');
  if (cat.gender === 'mixed') return players.length === 2 && g.includes('male') && g.includes('female');
  return true;
}
function validatePerson(p, label, requireId) {
  if (!p || norm(p.name).length < 2 || norm(p.name).length > 80) throw E(422, `${label}: name is required (2-80 characters)`);
  if (!['male', 'female', 'other'].includes(p.gender)) throw E(422, `${label}: gender must be male, female or other`);
  if (requireId && norm(p.college_id).length < 2) throw E(422, `${label}: college ID is required`);
  if (norm(p.college_id).length > 40 || norm(p.contact).length > 60 || norm(p.course_year).length > 40) throw E(422, `${label}: a field is too long`);
}
function findOrCreatePlayer(db, p, requireId) {
  validatePerson(p, 'Player', requireId);
  const cid = norm(p.college_id) || null;
  let row = cid ? db.prepare('SELECT * FROM players WHERE college_id=?').get(cid) : db.prepare('SELECT * FROM players WHERE lower(name)=lower(?) AND contact IS ?').get(norm(p.name), norm(p.contact) || null);
  if (row) return row;
  const id = Number(db.prepare('INSERT INTO players(name,gender,course_year,college_id,contact,created_at) VALUES(?,?,?,?,?,?)').run(norm(p.name), p.gender, norm(p.course_year) || null, cid, norm(p.contact) || null, now()).lastInsertRowid);
  return db.prepare('SELECT * FROM players WHERE id=?').get(id);
}
function submitRegistration(db, data, { admin, user, ip } = {}) {
  return tx(db, () => {
    const cfg = settings(db);
    if (!admin && cfg.registration_open !== '1') throw E(403, 'Registration is closed');
    if (!data || typeof data !== 'object' || !Array.isArray(data.category_ids)) throw E(422, 'Choose at least one category');
    const ids = [...new Set(data.category_ids.map(Number))];
    if (!ids.length) throw E(422, 'Choose at least one category');
    if (ids.some(n => !Number.isInteger(n) || n < 1)) throw E(422, 'Invalid category');
    const maxCats = Number(cfg.max_categories) || 99;
    const p1 = findOrCreatePlayer(db, data.player, !admin);
    const made = [];
    if (!admin && ids.length > maxCats) throw E(422, `You can enter at most ${maxCats} categories`);
    const existing = db.prepare("SELECT COUNT(*) n FROM registrations WHERE player_id=? AND status<>'rejected'").get(p1.id).n;
    if (!admin && existing + ids.length > maxCats) throw E(422, `You can enter at most ${maxCats} categories`);
    for (const cid of ids) {
      const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(cid);
      if (!cat) throw E(404, 'Category not found');
      if (db.prepare("SELECT 1 FROM registrations WHERE player_id=? AND category_id=? AND status<>'rejected'").get(p1.id, cid)) throw E(409, `${p1.name} is already registered for ${cat.name}`);
      let p2 = null;
      if (cat.kind === 'doubles') {
        if (!data.partner) throw E(422, `${cat.name} needs a partner`);
        p2 = findOrCreatePlayer(db, data.partner, !admin);
        if (p2.id === p1.id) throw E(422, 'Partner must be a different person');
        if (db.prepare("SELECT 1 FROM registrations WHERE player_id=? AND category_id=? AND status<>'rejected'").get(p2.id, cid)) throw E(409, `${p2.name} is already registered for ${cat.name}`);
      }
      if (!eligible(cat, p2 ? [p1, p2] : [p1])) throw E(422, `Players are not eligible for ${cat.name} (${cat.gender})`);
      const ins = db.prepare('INSERT INTO registrations(player_id,category_id,partner_player_id,created_at) VALUES(?,?,?,?)');
      made.push(Number(ins.run(p1.id, cid, p2 ? p2.id : null, now()).lastInsertRowid));
      if (p2) ins.run(p2.id, cid, p1.id, now());
    }
    audit(db, user || null, 'registration.submit', 'player', p1.id, { categories: ids, via: admin ? 'admin' : 'public' }, ip);
    return { ids: made };
  });
}
function teamNameFor(db, p1, p2) { const n = id => db.prepare('SELECT name FROM players WHERE id=?').get(id).name; return p2 ? `${n(p1)} / ${n(p2)}` : n(p1); }
function reviewRegistration(db, user, id, { status, reason }, ip) {
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM registrations WHERE id=?').get(id);
    if (!r) throw E(404, 'Registration not found');
    if (!['approved', 'rejected', 'pending'].includes(status)) throw E(422, 'Invalid status');
    const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(r.category_id);
    if (cat.generated) throw E(409, 'Fixtures already exist for this category. Add late entries manually.');
    const partnerReg = r.partner_player_id ? db.prepare('SELECT * FROM registrations WHERE player_id=? AND category_id=?').get(r.partner_player_id, r.category_id) : null;
    const set = db.prepare('UPDATE registrations SET status=?, reason=? WHERE id=?');
    const inTeam = pid => db.prepare('SELECT id FROM teams WHERE category_id=? AND (player1_id=? OR player2_id=?)').get(r.category_id, pid, pid);
    if (status === 'approved') {
      if (cat.kind === 'doubles' && !r.partner_player_id) throw E(422, 'This doubles entry has no partner. Delete it and register the pair again.');
      if (inTeam(r.player_id) || (r.partner_player_id && inTeam(r.partner_player_id))) { if (r.status !== 'approved') throw E(409, 'A player is already in a team for this category'); }
      else {
        // the player who registered first (lower registration id) is listed first in the team name
        const swap = partnerReg && partnerReg.id < r.id, p1 = swap ? r.partner_player_id : r.player_id, p2 = swap ? r.player_id : r.partner_player_id;
        db.prepare('INSERT INTO teams(category_id,name,player1_id,player2_id,created_at) VALUES(?,?,?,?,?)').run(r.category_id, teamNameFor(db, p1, p2), p1, p2, now());
      }
    } else {
      const t = inTeam(r.player_id); if (t) db.prepare('DELETE FROM teams WHERE id=?').run(t.id);
    }
    set.run(status, reason || null, id); if (partnerReg) set.run(status, reason || null, partnerReg.id);
    audit(db, user, `registration.${status}`, 'registration', id, { reason }, ip);
    return { ok: true };
  });
}
function refreshTeamNames(db, playerId) {
  for (const t of db.prepare('SELECT id,player1_id,player2_id FROM teams WHERE player1_id=? OR player2_id=?').all(playerId, playerId))
    db.prepare('UPDATE teams SET name=? WHERE id=?').run(teamNameFor(db, t.player1_id, t.player2_id), t.id);
}

// ---------- removing, resetting and discarding ----------
function clearFixtures(db, user, categoryId, { force } = {}, ip) {
  return tx(db, () => {
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId);
    if (!c) throw E(404, 'Category not found');
    const ms = db.prepare('SELECT status FROM matches WHERE category_id=?').all(categoryId), played = ms.filter(m => PLAYED.includes(m.status)).length;
    if (played && !force) throw E(409, `${played} match(es) in ${c.name} are live or already played. Clearing the fixtures deletes their scores.`, { code: 'has_results', played });
    wipeMatches(db, categoryId); db.prepare('UPDATE categories SET generated=0 WHERE id=?').run(categoryId);
    audit(db, user, 'fixtures.clear', 'category', categoryId, { matches: ms.length, played, force: !!force }, ip);
    return { removed: ms.length };
  });
}
function removeTeamInner(db, user, teamId, force, ip) {
  const t = db.prepare('SELECT * FROM teams WHERE id=?').get(teamId); if (!t) return;
  const c = db.prepare('SELECT * FROM categories WHERE id=?').get(t.category_id);
  const ms = db.prepare('SELECT status FROM matches WHERE category_id=?').all(c.id), played = ms.filter(m => PLAYED.includes(m.status)).length;
  let regen = false;
  if (ms.length) {
    if (played && !force) throw E(409, `${c.name} already has ${played} live or played match(es). Removing this entry discards that category's fixtures and scores.`, { code: 'has_results', category: c.name, played });
    wipeMatches(db, c.id); db.prepare('UPDATE categories SET generated=0 WHERE id=?').run(c.id); regen = !played;
  }
  db.prepare('DELETE FROM teams WHERE id=?').run(teamId);
  if (regen && db.prepare('SELECT COUNT(*) n FROM teams WHERE category_id=?').get(c.id).n >= 2) generateInner(db, user, c.id, {}, ip);
  audit(db, user, 'team.remove', 'team', teamId, { name: t.name, category: c.name, fixtures_rebuilt: regen, discarded_results: played }, ip);
}
function dropRegistrationInner(db, user, regId, force, ip) {
  const r = db.prepare('SELECT * FROM registrations WHERE id=?').get(regId); if (!r) return;
  const partnerReg = r.partner_player_id ? db.prepare('SELECT * FROM registrations WHERE player_id=? AND category_id=?').get(r.partner_player_id, r.category_id) : null;
  const team = db.prepare('SELECT id FROM teams WHERE category_id=? AND (player1_id=? OR player2_id=?)').get(r.category_id, r.player_id, r.player_id);
  if (team) removeTeamInner(db, user, team.id, force, ip);
  if (partnerReg) db.prepare("UPDATE registrations SET partner_player_id=NULL, status='rejected', reason='Partner was removed from this entry' WHERE id=?").run(partnerReg.id);
  db.prepare('DELETE FROM registrations WHERE id=?').run(regId);
}
function deleteRegistration(db, user, id, { force } = {}, ip) {
  return tx(db, () => {
    const r = db.prepare('SELECT r.*, p.name FROM registrations r JOIN players p ON p.id=r.player_id WHERE r.id=?').get(id);
    if (!r) throw E(404, 'Registration not found');
    dropRegistrationInner(db, user, id, !!force, ip);
    audit(db, user, 'registration.delete', 'registration', id, { player: r.name, category_id: r.category_id }, ip); return { ok: true };
  });
}
function deletePlayer(db, user, id, { force } = {}, ip) {
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM players WHERE id=?').get(id); if (!p) throw E(404, 'Player not found');
    for (const r of db.prepare('SELECT id FROM registrations WHERE player_id=?').all(id)) dropRegistrationInner(db, user, r.id, !!force, ip);
    for (const t of db.prepare('SELECT id FROM teams WHERE player1_id=? OR player2_id=?').all(id, id)) removeTeamInner(db, user, t.id, !!force, ip);
    db.prepare('UPDATE registrations SET partner_player_id=NULL WHERE partner_player_id=?').run(id);
    db.prepare('DELETE FROM players WHERE id=?').run(id);
    audit(db, user, 'player.delete', 'player', id, { name: p.name }, ip); return { ok: true };
  });
}
// discard a played/live/cancelled match so it can be scheduled and played again
function resetMatch(db, user, id, { reason, version } = {}, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (m.status === 'bye') throw E(409, 'A bye has no result to reset');
    if (['pending', 'scheduled', 'postponed'].includes(m.status)) throw E(409, 'This match has not been played yet, so there is nothing to reset');
    if (!reason || String(reason).trim().length < 3) throw E(422, 'A reason is required to reset a match');
    checkVersion(m, version);
    const hadResult = ['completed', 'walkover'].includes(m.status);
    if (hadResult) for (const [mid, slot] of [[m.next_match_id, m.next_slot], [m.loser_match_id, m.loser_slot]]) {
      if (!mid) continue;
      const t = getRow(db, mid);
      if (PLAYED.includes(t.status)) throw E(409, `Reset the later match (#${t.id}, ${t.label}) first. It already used this result.`, { code: 'downstream_started' });
      db.prepare(`UPDATE matches SET ${slot === 'a' ? 'team_a' : 'team_b'}=NULL, version=version+1 WHERE id=?`).run(mid);
    }
    const before = { status: m.status, final_score: m.final_score, winner_team: m.winner_team, games: db.prepare('SELECT a,b FROM games WHERE match_id=? ORDER BY game_no').all(id) };
    db.prepare('DELETE FROM score_events WHERE match_id=?').run(id); db.prepare('DELETE FROM games WHERE match_id=?').run(id);
    db.prepare(`UPDATE matches SET status='pending', court_id=NULL, scheduled_at=NULL, rules=NULL, winner_team=NULL, result_type=NULL, final_score=NULL, scorer_id=NULL, started_at=NULL, finished_at=NULL,
      confirmed_by=NULL, confirmed_at=NULL, called_at=NULL, dispute_note=NULL, dispute_prev=NULL, walkover_reason=NULL, notes=NULL, version=version+1 WHERE id=?`).run(id);
    db.prepare('INSERT INTO corrections(match_id,user_id,username,reason,before,after,created_at) VALUES(?,?,?,?,?,?,?)').run(id, user.id, user.username, String(reason).trim(), JSON.stringify(before), JSON.stringify({ reset: true }), now());
    audit(db, user, 'match.reset', 'match', id, { reason, was: m.status, score: m.final_score }, ip);
    return matchView(db, id);
  });
}
function deleteMatch(db, user, id, ip) {
  return tx(db, () => {
    const m = getRow(db, id);
    if (!['pending', 'scheduled', 'postponed', 'cancelled'].includes(m.status)) throw E(409, 'Reset a played or live match first (Reset), then it can be deleted');
    if (m.next_match_id || m.loser_match_id || db.prepare('SELECT 1 FROM matches WHERE next_match_id=? OR loser_match_id=?').get(id, id)) throw E(409, 'This match is part of a bracket. Use "Clear fixtures" or "Regenerate" on the category instead.', { code: 'in_bracket' });
    for (const t of ['games', 'score_events', 'corrections']) db.prepare(`DELETE FROM ${t} WHERE match_id=?`).run(id);
    db.prepare('DELETE FROM matches WHERE id=?').run(id);
    audit(db, user, 'match.delete', 'match', id, { category_id: m.category_id, round: m.round }, ip); return { ok: true };
  });
}

// ---------- reports ----------
function dashboard(db) {
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  const courts = courtsView(db, false);
  return {
    players: n("SELECT COUNT(DISTINCT player_id) n FROM registrations WHERE status='approved'"),
    pending_registrations: n("SELECT COUNT(*) n FROM registrations WHERE status='pending'"),
    checked_in: n('SELECT COUNT(*) n FROM players WHERE checked_in_at IS NOT NULL'),
    scheduled: n("SELECT COUNT(*) n FROM matches WHERE status='scheduled'"),
    live: n(`SELECT COUNT(*) n FROM matches WHERE status IN (${ph(LIVE)})`, ...LIVE),
    completed: n("SELECT COUNT(*) n FROM matches WHERE status IN ('completed','walkover')"),
    unscheduled: n("SELECT COUNT(*) n FROM matches WHERE status IN ('pending','postponed') AND team_a IS NOT NULL AND team_b IS NOT NULL"),
    courts_available: courts.filter(c => c.state === 'available' || c.state === 'upcoming').length,
    courts_total: courts.length,
    recent: db.prepare('SELECT id,username,action,entity,entity_id,created_at FROM audit_log ORDER BY id DESC LIMIT 10').all(),
  };
}
function csv(rows, cols) {
  const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = {
  HttpError, E, now, LIVE, OCCUPY, FINISHED, PERMS, can, settings, audit, matchRules, listMatches, matchView, getRow, findConflicts, schedule, postpone, cancel, callup,
  start, pauseResume, point, undo, confirm, setGames, dispute, resolveDispute, walkover, noShow, generate, createMatch, editMatch, courtsView, standings, results,
  PLAYED, wipeMatches, clearFixtures, deleteRegistration, deletePlayer, resetMatch, deleteMatch, submitRegistration, reviewRegistration, refreshTeamNames, teamNameFor, dashboard, csv, norm,
};
