// Badminton scoring rules (rally-point). Pure functions, no I/O.
const DEFAULT_RULES = { games_to_win: 2, points_to_win: 21, win_by: 2, cap: 30 };

function normRules(r) {
  const x = { ...DEFAULT_RULES, ...(r || {}) };
  for (const k of ['games_to_win', 'points_to_win', 'win_by', 'cap']) x[k] = Number(x[k]);
  if (!Number.isInteger(x.games_to_win) || x.games_to_win < 1 || x.games_to_win > 5) throw new Error('games_to_win must be 1-5');
  if (!Number.isInteger(x.points_to_win) || x.points_to_win < 1 || x.points_to_win > 99) throw new Error('points_to_win must be 1-99');
  if (!Number.isInteger(x.win_by) || x.win_by < 1 || x.win_by > 5) throw new Error('win_by must be 1-5');
  if (!x.cap) x.cap = 0;
  else if (!Number.isInteger(x.cap) || x.cap < x.points_to_win) throw new Error('cap must be 0 (none) or >= points_to_win');
  return x;
}

function gameComplete(a, b, r) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (r.cap && hi >= r.cap) return true;
  return hi >= r.points_to_win && hi - lo >= r.win_by;
}

// A valid *final* game score: complete, and not already complete one rally earlier.
function validGameScore(a, b, r) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  if (!gameComplete(a, b, r)) return false;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (r.cap && hi > r.cap) return false;
  return !gameComplete(hi - 1, lo, r);
}

function replay(sides, rules) {
  const r = normRules(rules);
  const games = []; let cur = { a: 0, b: 0 }; const won = { a: 0, b: 0 }; let winner = null;
  for (const s of sides) {
    if (winner) break;
    cur[s]++;
    if (gameComplete(cur.a, cur.b, r)) {
      const w = cur.a > cur.b ? 'a' : 'b';
      games.push({ ...cur, complete: true }); won[w]++; cur = { a: 0, b: 0 };
      if (won[w] >= r.games_to_win) winner = w;
    }
  }
  return { games, current: winner ? null : cur, won, winner, gameNo: games.length + 1 };
}

function validateGames(games, rules) {
  const r = normRules(rules);
  if (!Array.isArray(games) || !games.length) return { ok: false, error: 'At least one game is required' };
  if (games.length > r.games_to_win * 2 - 1) return { ok: false, error: 'Too many games for this format' };
  const won = { a: 0, b: 0 };
  for (let i = 0; i < games.length; i++) {
    const { a, b } = games[i];
    if (won.a >= r.games_to_win || won.b >= r.games_to_win) return { ok: false, error: `Game ${i + 1} was played after the match was already decided` };
    if (!validGameScore(a, b, r)) return { ok: false, error: `Game ${i + 1} score ${a}-${b} is not valid (first to ${r.points_to_win}, win by ${r.win_by}${r.cap ? ', cap ' + r.cap : ''})` };
    won[a > b ? 'a' : 'b']++;
  }
  const winner = won.a >= r.games_to_win ? 'a' : won.b >= r.games_to_win ? 'b' : null;
  if (!winner) return { ok: false, error: `Match not decided: a player needs ${r.games_to_win} game(s)` };
  return { ok: true, winner, won };
}

const scoreString = games => games.map(g => `${g.a}-${g.b}`).join(', ');

module.exports = { DEFAULT_RULES, normRules, gameComplete, validGameScore, replay, validateGames, scoreString };
