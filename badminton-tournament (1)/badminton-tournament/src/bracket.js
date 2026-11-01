// Bracket / round-robin planning. Pure functions: return a plan, the caller persists it.
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) { const m = order.length * 2 + 1; order = order.flatMap(x => [x, m - x]); }
  return order.slice(0, size);
}

function roundLabel(round, rounds, size) {
  const left = rounds - round;
  if (left === 0) return 'Final';
  if (left === 1) return 'Semifinal';
  if (left === 2) return 'Quarterfinal';
  return `Round of ${size / 2 ** (round - 1)}`;
}

// teamIds ordered by seed (best first). Returns [{key, round, number, label, a, b, next:{key,slot}, loser:{key,slot}, bye}]
function planKnockout(teamIds, { thirdPlace = false } = {}) {
  const n = teamIds.length;
  if (n < 2) throw new Error('At least 2 teams are needed to build a knockout bracket');
  const size = nextPow2(n), rounds = Math.log2(size), order = seedOrder(size);
  const plan = [];
  const key = (r, k) => `${r}-${k}`;
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let k = 0; k < count; k++) {
      const m = { key: key(r, k), round: r, number: k + 1, label: roundLabel(r, rounds, size), a: null, b: null, next: null, loser: null, bye: false };
      if (r < rounds) m.next = { key: key(r + 1, k >> 1), slot: k % 2 === 0 ? 'a' : 'b' };
      if (r === 1) {
        const sa = order[2 * k], sb = order[2 * k + 1];
        m.a = sa <= n ? teamIds[sa - 1] : null; m.b = sb <= n ? teamIds[sb - 1] : null;
        m.bye = !m.a || !m.b;
      }
      plan.push(m);
    }
  }
  if (thirdPlace && n >= 4) {
    plan.push({ key: 'third', round: rounds, number: 2, label: 'Third place', a: null, b: null, next: null, loser: null, bye: false });
    for (const m of plan.filter(m => m.round === rounds - 1)) m.loser = { key: 'third', slot: m.number === 1 ? 'a' : 'b' };
  }
  return plan;
}

// Circle method round robin within groups (snake distribution by seed).
function planRoundRobin(teamIds, groups = 1) {
  const g = Math.max(1, Math.min(groups, Math.floor(teamIds.length / 2) || 1));
  const buckets = Array.from({ length: g }, () => []);
  teamIds.forEach((t, i) => { const row = Math.floor(i / g), col = i % g; buckets[row % 2 ? g - 1 - col : col].push(t); });
  const plan = [];
  buckets.forEach((teams, gi) => {
    if (teams.length < 2) return;
    const list = teams.slice(); if (list.length % 2) list.push(null);
    const rounds = list.length - 1; let number = 0;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < list.length / 2; i++) {
        const a = list[i], b = list[list.length - 1 - i];
        if (a && b) plan.push({ key: `g${gi + 1}-${r + 1}-${++number}`, group_no: gi + 1, round: r + 1, number, label: `Group ${String.fromCharCode(65 + gi)} - Round ${r + 1}`, a, b, next: null, loser: null, bye: false });
      }
      list.splice(1, 0, list.pop());
    }
  });
  return plan;
}

module.exports = { nextPow2, seedOrder, planKnockout, planRoundRobin };
