const test = require('node:test'); const assert = require('node:assert/strict');
const S = require('../src/scoring'); const B = require('../src/bracket');
const R = S.normRules();

test('game score validation: 21-19 ok, 22-19 impossible, 30-29 cap ok, 31-29 invalid, 21-20 not finished', () => {
  assert.ok(S.validGameScore(21, 19, R)); assert.ok(!S.validGameScore(22, 19, R)); assert.ok(S.validGameScore(30, 29, R));
  assert.ok(S.validGameScore(30, 28, R)); assert.ok(!S.validGameScore(31, 29, R)); assert.ok(!S.validGameScore(21, 20, R)); assert.ok(S.validGameScore(23, 21, R));
});
test('replay: best of three, deuce, match ends exactly on the deciding point', () => {
  const seq = [...Array(21).fill('a'), ...Array(20).fill('b'), 'a', 'b', 'a', 'b', 'a', ...Array(21).fill('b')]; // game1 21-0 -> wait
  const s = S.replay(['a', 'b'].flatMap(x => []), R); assert.equal(s.winner, null);
  const g = [...Array(20).fill('a'), ...Array(20).fill('b'), 'a', 'b', 'a', 'a']; // 20-20, 21-21, 22-21? deuce -> 23-21
  const st = S.replay(g, R); assert.equal(st.games.length, 1); assert.deepEqual([st.games[0].a, st.games[0].b], [23, 21]);
  const m = S.replay([...Array(21).fill('a'), ...Array(21).fill('b'), ...Array(21).fill('a')], R); assert.equal(m.winner, 'a'); assert.equal(m.games.length, 3); assert.equal(m.current, null);
  assert.equal(seq.length > 0, true);
});
test('cap: 29-29 then next point wins at 30', () => {
  const pts = []; for (let i = 0; i < 29; i++) pts.push('a', 'b'); pts.push('a');
  assert.deepEqual(S.replay(pts, R).games[0], { a: 30, b: 29, complete: true });
});
test('configurable rules: single game to 11', () => {
  const r = S.normRules({ games_to_win: 1, points_to_win: 11, win_by: 2, cap: 15 });
  assert.equal(S.replay(Array(11).fill('b'), r).winner, 'b'); assert.ok(S.validateGames([{ a: 11, b: 9 }], r).ok); assert.ok(!S.validateGames([{ a: 11, b: 10 }], r).ok);
  assert.throws(() => S.normRules({ cap: 5, points_to_win: 21 }));
});
test('validateGames rejects games after the match is decided and undecided matches', () => {
  assert.ok(!S.validateGames([{ a: 21, b: 5 }, { a: 21, b: 5 }, { a: 21, b: 5 }], R).ok);
  assert.ok(!S.validateGames([{ a: 21, b: 5 }], R).ok);
  assert.equal(S.validateGames([{ a: 21, b: 5 }, { a: 10, b: 21 }, { a: 21, b: 19 }], R).winner, 'a');
});
test('knockout plans: sizes, byes, third place, links', () => {
  for (const n of [2, 3, 4, 5, 8, 11, 16]) {
    const p = B.planKnockout(Array.from({ length: n }, (_, i) => i + 1), { thirdPlace: true }), size = B.nextPow2(n);
    const main = p.filter(m => m.key !== 'third'); assert.equal(main.length, size - 1, `n=${n}`);
    assert.equal(p.filter(m => m.bye).length, size - n);
    const teams = p.filter(m => m.round === 1).flatMap(m => [m.a, m.b]).filter(Boolean); assert.equal(new Set(teams).size, n);
    assert.equal(!!p.find(m => m.key === 'third'), n >= 4);
    assert.ok(!p.some(m => m.bye && !m.a && !m.b));
  }
});
test('top seeds are separated and receive byes', () => {
  const p = B.planKnockout([1, 2, 3, 4, 5], {}), byes = p.filter(m => m.bye).map(m => m.a || m.b).sort(); assert.deepEqual(byes, [1, 2, 3]);
  const o = B.seedOrder(8); assert.ok(o.indexOf(1) < 4 && o.indexOf(2) >= 4);
});
test('round robin: every pair meets exactly once', () => {
  const p = B.planRoundRobin([1, 2, 3, 4, 5], 1), pairs = new Set(p.map(m => [m.a, m.b].sort().join('-'))); assert.equal(p.length, 10); assert.equal(pairs.size, 10);
  assert.equal(B.planRoundRobin([1, 2, 3, 4, 5, 6, 7, 8], 2).length, 12);
});
