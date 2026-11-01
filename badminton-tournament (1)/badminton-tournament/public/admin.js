(() => {
  const { h, api, chip, can, toast, fmtTime, fmtDT, localInput, empty, field, fd, table, dialog, matchCard, courtCard } = Object.assign({}, window.App, { field: (...a) => window.App.field(...a), fd: f => window.App.fd(f), table: (...a) => window.App.table(...a), dialog: (...a) => window.App.dialog(...a) });
  const App = window.App;
  const S = {};
  const NAV = [['', 'Dashboard', 'panel'], ['courts', 'Courts', 'panel'], ['matches', 'Matches', 'panel'], ['registrations', 'Registrations', 'registration.review'], ['players', 'Players', 'panel'], ['categories', 'Categories', 'admin'],
    ['news', 'Announcements', 'announce'], ['volunteers', 'Volunteers', 'admin'], ['users', 'Users', 'admin'], ['settings', 'Settings', 'admin'], ['audit', 'Audit log', 'admin'], ['reports', 'Reports', 'panel']];
  const reload = () => App.render(true);
  const post = (path, body) => api('POST', path, body || {});
  const act = async (fn, ok) => { const r = await App.run(fn, ok); if (r !== null) reload(); return r; };
  const sel = (name, opts, val, attrs) => h('select', { name, ...attrs }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l)));
  const inp = (name, val, attrs) => h('input', { name, value: val ?? '', ...attrs });
  const when = (v) => new Date(v).toISOString();

  // ---------- scheduling flow (conflict warnings, override with reason, audit via server) ----------
  async function scheduleFlow(matchId, courtId, iso) {
    try { await post(`/api/matches/${matchId}/schedule`, { court_id: courtId, scheduled_at: iso }); toast('Match scheduled'); return true; }
    catch (e) {
      if (e.data && e.data.code === 'needs_override') {
        if (!can('schedule.override')) { toast(`${e.message}. Only an administrator can override this warning.`, true); return false; }
        const reason = h('input', { name: 'reason', required: true, placeholder: 'Reason for override' });
        const ok = await dialog('Scheduling warning', h('div', { class: 'stack' }, h('div', { class: 'warn' }, e.data.conflicts.map(c => h('p', {}, c.message))), field('Reason (recorded in the audit log)', reason)),
          [{ label: 'Override and schedule', danger: true, run: async () => { if (reason.value.trim().length < 3) throw new Error('Enter a reason'); await post(`/api/matches/${matchId}/schedule`, { court_id: courtId, scheduled_at: iso, override: true, reason: reason.value }); } }]);
        if (ok) toast('Scheduled with override'); return !!ok;
      }
      toast(e.message, true); if (e.status === 401) App.fail(e); return false;
    }
  }
  async function scheduleDialog(match, courts, defaultCourt) {
    const c = sel('court', courts.map(x => [x.id, x.name + (x.state === 'maintenance' ? ' (maintenance)' : '')]), defaultCourt || match.court_id || courts[0].id), t = h('input', { type: 'datetime-local', required: true, value: localInput(match.scheduled_at ? new Date(match.scheduled_at) : new Date(Date.now() + 5 * 60000)) });
    const r = await dialog(`Schedule match #${match.id}`, h('div', { class: 'stack' }, h('p', {}, `${match.category_name} · ${match.label}: ${match.a ? match.a.name : 'TBD'} vs ${match.b ? match.b.name : 'TBD'}`), field('Court', c), field('Start time', t)),
      [{ label: 'Check and schedule', primary: true, run: async () => { if (!t.value) throw new Error('Choose a time'); return (await scheduleFlow(match.id, Number(c.value), when(t.value))) ? true : false; } }]);
    if (r) reload();
  }
  async function assignDialog(ct, courts) {
    const ms = (await api('GET', '/api/matches?unscheduled=1')).matches;
    if (!ms.length) return toast('No unscheduled matches. Generate fixtures in Categories first.', true);
    const m = sel('m', ms.map(x => [x.id, `#${x.id} ${x.category_name} · ${x.label}: ${x.a ? x.a.name : 'TBD'} vs ${x.b ? x.b.name : 'TBD'}`]), ms[0].id), t = h('input', { type: 'datetime-local', required: true, value: localInput(new Date(Date.now() + 5 * 60000)) });
    const r = await dialog(`Assign a match to ${ct.name}`, h('div', {}, field('Match', m), field('Start time', t)), [{ label: 'Check and assign', primary: true, run: async () => (await scheduleFlow(Number(m.value), ct.id, when(t.value))) ? true : false }]);
    if (r) reload();
  }

  // ---------- match action buttons ----------
  function matchActions(m, ct, where, courts) {
    const b = (label, fn, cls = 'sm', dis) => h('button', { class: cls, disabled: dis, onclick: fn }, label), kids = [];
    const live = ['in_progress', 'paused', 'awaiting_confirmation', 'disputed'].includes(m.status);
    if (live && can('score')) kids.push(h('a', { class: 'btn sm primary', href: `#/admin/score/${m.id}` }, m.status === 'awaiting_confirmation' ? 'Review and confirm' : 'Open scoring'));
    if (m.status === 'in_progress' && can('match.control')) kids.push(b('Pause', () => act(() => post(`/api/matches/${m.id}/pause`), 'Paused')));
    if (m.status === 'paused' && can('match.control')) kids.push(b('Resume', () => act(() => post(`/api/matches/${m.id}/resume`), 'Resumed')));
    if (m.status === 'scheduled') {
      if (can('match.control')) {
        kids.push(b(m.called_at ? 'Called ✓' : 'Call players', () => act(() => post(`/api/matches/${m.id}/callup`), 'Players called')));
        kids.push(b('Start match', async () => { const r = await App.run(() => post(`/api/matches/${m.id}/start`)); if (r) { if (r.warnings.length) toast(r.warnings.join('; ')); location.hash = `#/admin/score/${m.id}`; } }, 'sm primary'));
        kids.push(b('Walkover / no-show', () => walkoverDialog(m)));
      }
      if (can('schedule.assign')) { kids.push(b('Reschedule', () => scheduleDialog(m, courts)));
        kids.push(b('Postpone', async () => { if (await App.confirm(`Postpone match #${m.id}? It leaves the court queue.`, 'Postpone')) act(() => post(`/api/matches/${m.id}/postpone`, {}), 'Postponed'); })); }
    }
    return h('div', { class: 'row', style: null }, kids);
  }
  async function walkoverDialog(m) {
    const absent = sel('absent', [['a', m.a ? m.a.name : 'Side A'], ['b', m.b ? m.b.name : 'Side B']], 'a'), reason = h('input', { required: true, placeholder: 'e.g. injured, withdrew' });
    const calledOk = m.status === 'scheduled' && m.called_at;
    const r = await dialog(`Walkover - match #${m.id}`, h('div', {}, field('Which side is absent / withdrawing?', absent), field('Reason (required for a walkover)', reason),
      h('p', { class: 'small muted' }, calledOk ? 'This match was called. "No-show" works once the grace period has passed.' : 'Call the players first to use "No-show"; it needs the grace period to have passed.')),
      [{ label: 'Record walkover', primary: true, run: async () => { await post(`/api/matches/${m.id}/walkover`, { winner: absent.value === 'a' ? 'b' : 'a', reason: reason.value }); } },
        { label: 'No-show (after grace period)', run: async () => { await post(`/api/matches/${m.id}/noshow`, { side: absent.value }); } }]);
    if (r) reload();
  }

  // ---------- remove / reset / edit helpers ----------
  const RESETTABLE = ['in_progress', 'paused', 'awaiting_confirmation', 'disputed', 'completed', 'walkover', 'cancelled'];
  async function removeFlow(path, what, extra, label = 'Remove') {
    if (!(await App.confirm(`${label} ${what}? ${extra || ''} This cannot be undone.`, label, true))) return false;
    try { await api('DELETE', path, {}); toast('Removed'); reload(); return true; }
    catch (e) {
      const code = e.data && e.data.code;
      if (code === 'has_results' || code === 'not_empty') {
        if (await App.confirm(`${e.message} Continue and delete all of it?`, 'Delete everything', true)) return !!(await act(() => api('DELETE', path, { force: true }), 'Removed'));
        return false;
      }
      App.fail(e); return false;
    }
  }
  async function resetDialog(m, after) {
    const reason = h('input', { required: true, placeholder: 'e.g. wrong players were on court' });
    const r = await dialog(`Reset match #${m.id}`, h('div', {}, h('p', {}, `${m.a ? m.a.name : 'TBD'} vs ${m.b ? m.b.name : 'TBD'} goes back to "Not scheduled" with every score removed, so it can be scheduled and played again.`),
      m.next_match_id ? h('p', { class: 'warn small' }, 'If it was finished, the winner is taken out of the next round. This is blocked once the next match has started; reset that one first.') : null, field('Reason (kept in the correction history)', reason)),
      [{ label: 'Reset match', danger: true, run: async () => (await post(`/api/matches/${m.id}/reset`, { reason: reason.value, version: m.version })).match }]);
    if (r && r.id) { toast('Match reset. Schedule it again when you are ready.'); after ? after(r) : reload(); }
  }
  async function removeMatch(m) {
    if (await App.confirm(`Delete match #${m.id} (${m.a ? m.a.name : 'TBD'} vs ${m.b ? m.b.name : 'TBD'})? Only manually added matches can be deleted. Bracket matches are removed with "Clear fixtures".`, 'Delete match', true)) act(() => api('DELETE', `/api/matches/${m.id}`), 'Match deleted');
  }
  async function clearFix(cat) {
    if (!(await App.confirm(`Remove all fixtures for ${cat.name}? Teams and registrations stay, so you can approve late entries and generate the draw again.`, 'Clear fixtures', true))) return;
    try { await post(`/api/categories/${cat.id}/clear-fixtures`, {}); toast('Fixtures cleared'); reload(); }
    catch (e) { if (e.data && e.data.code === 'has_results') { if (await App.confirm(`${e.message} Discard those scores too?`, 'Discard scores and clear', true)) act(() => post(`/api/categories/${cat.id}/clear-fixtures`, { force: true }), 'Fixtures and scores cleared'); } else App.fail(e); }
  }
  async function courtNameDialog(ct) {
    const n = h('input', { required: true, maxlength: 40, value: ct ? ct.name : `Court ${Math.floor(Math.random() * 90) + 4}` });
    const ok = await dialog(ct ? `Rename ${ct.name}` : 'Add a court', field('Court name', n), [{ label: 'Save', primary: true, run: async () => { await (ct ? api('PATCH', `/api/courts/${ct.id}`, { name: n.value }) : post('/api/courts', { name: n.value })); } }]); if (ok) reload();
  }
  async function removeCourt(ct) {
    if (!(await App.confirm(`Delete ${ct.name}? Matches scheduled on it go back to "Not scheduled". Courts that hosted finished matches cannot be deleted (use Maintenance).`, 'Delete court', true))) return;
    act(() => api('DELETE', `/api/courts/${ct.id}`, {}), 'Court deleted');
  }
  async function editNews(x) {
    const t = h('input', { value: x.title, maxlength: 120 }), b = h('textarea', { maxlength: 2000 }, x.body), k = sel('kind', [['info', 'Announcement'], ['schedule', 'Schedule change']], x.kind);
    const ok = await dialog('Edit announcement', h('div', {}, field('Title', t), field('Type', k), field('Message', b)), [{ label: 'Save', primary: true, run: async () => { await api('PATCH', `/api/announcements/${x.id}`, { title: t.value, body: b.value, kind: k.value }); } }]); if (ok) reload();
  }
  async function editVolunteer(x) {
    const courts = (await api('GET', '/api/courts')).courts, body = h('div', {}, field('Name', inp('name', x.name)), field('Role', inp('role', x.role)), field('Court', sel('court_id', [['', 'None'], ...courts.map(c => [c.id, c.name])], x.court_id || '')), field('Shift', inp('shift', x.shift)), field('Contact (private)', inp('contact', x.contact)));
    const v = n => body.querySelector(`[name=${n}]`).value;
    const ok = await dialog(`Edit ${x.name}`, body, [{ label: 'Save', primary: true, run: async () => { await api('PATCH', `/api/volunteers/${x.id}`, { name: v('name'), role: v('role'), court_id: v('court_id') || null, shift: v('shift'), contact: v('contact') }); } }]); if (ok) reload();
  }

  // ---------- pages ----------
  const A = {};
  A.dashboard = async () => {
    const [d, c, cats] = await Promise.all([api('GET', '/api/admin/dashboard'), api('GET', '/api/courts'), api('GET', '/api/categories')]);
    const hidden = cats.categories.filter(x => !x.published);
    return h('div', { class: 'stack' }, h('h1', {}, 'Dashboard'),
      hidden.length ? h('div', { class: 'warn', role: 'status' }, h('strong', {}, 'Not visible to the public yet: '), hidden.map(x => x.name).join(', '), '. Visitors only see categories that are published, so the public pages show zero players and no scores for these.', ' ',
        can('admin') ? h('button', { class: 'sm primary', onclick: async () => { if (await App.confirm(`Publish ${hidden.length} categor${hidden.length > 1 ? 'ies' : 'y'} to the public site? Approved player names, fixtures and scores become visible to everyone.`, 'Publish')) act(async () => { for (const x of hidden) await api('PATCH', `/api/categories/${x.id}`, { published: true }); }, 'Published'); } }, 'Publish all') : null) : null,
      h('div', { class: 'grid g4' }, [['Players (approved)', d.players], ['Pending registrations', d.pending_registrations], ['Checked in', d.checked_in], ['Scheduled matches', d.scheduled], ['Live matches', d.live], ['Completed matches', d.completed], ['Ready to schedule', d.unscheduled], ['Courts available', `${d.courts_available}/${d.courts_total}`]].map(([l, v]) => h('div', { class: 'card stat' }, h('b', {}, v), h('span', {}, l)))),
      h('h2', {}, 'Courts'), h('div', { class: 'grid g3' }, c.courts.map(ct => courtCard(ct, { actions: (m, x, w) => matchActions(m, x, w, c.courts) }))),
      h('h2', {}, 'Recent activity'), table([{ h: 'When', f: r => fmtDT(r.created_at) }, { h: 'Who', f: r => r.username }, { h: 'Action', f: r => r.action }, { h: 'Item', f: r => r.entity ? `${r.entity} #${r.entity_id ?? ''}` : '' }], d.recent));
  };
  A.courts = async () => {
    const c = await api('GET', '/api/courts');
    return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, 'Court control'), can('admin') ? h('button', { onclick: () => courtNameDialog() }, 'Add court') : null), h('p', { class: 'muted' }, 'Finishing a match updates the queue automatically. The next match is never started automatically; an authorised user must start it.'),
      h('div', { class: 'grid g3' }, c.courts.map(ct => courtCard(ct, { actions: (m, x, w) => matchActions(m, x, w, c.courts), footer: x => h('div', { class: 'row' },
        can('schedule.assign') ? h('button', { class: 'sm', onclick: () => assignDialog(x, c.courts) }, 'Assign match') : null,
        can('schedule.assign') ? h('button', { class: 'sm' + (x.status === 'maintenance' ? '' : ' danger'), onclick: async () => {
          if (x.status === 'maintenance') return act(() => api('PATCH', `/api/courts/${x.id}`, { status: 'active', note: '' }), `${x.name} is back in service`);
          const note = h('input', { placeholder: 'e.g. wet floor' }); const r = await dialog(`${x.name} maintenance`, field('Reason shown to staff', note), [{ label: 'Mark unavailable', danger: true, run: async () => { await api('PATCH', `/api/courts/${x.id}`, { status: 'maintenance', note: note.value }); } }]); if (r) reload();
        } }, x.status === 'maintenance' ? 'Return to service' : 'Maintenance') : null,
        can('admin') ? h('button', { class: 'sm', onclick: () => courtNameDialog(x) }, 'Rename') : null, can('admin') ? h('button', { class: 'sm danger', onclick: () => removeCourt(x) }, 'Delete court') : null) }))));
  };

  // scoring console
  A.score = async ([id]) => {
    let m = (await api('GET', `/api/matches/${id}`)).match, corrections = (await api('GET', `/api/matches/${id}`)).corrections, busy = false;
    const wrap = h('div', { class: 'stack' }), post2 = async (path, body) => { const r = await App.run(() => post(`/api/matches/${m.id}/${path}`, { ...body, version: m.version })); if (r) { m = r.match; if (r.warnings && r.warnings.length) toast(r.warnings.join('; ')); } draw(); return r; };
    async function tap(side) {
      if (busy) return; busy = true;
      try { m = (await post(`/api/matches/${m.id}/point`, { side, client_id: crypto.randomUUID(), version: m.version })).match; }
      catch (e) { if (e.data && e.data.code === 'stale' && e.data.match) { m = e.data.match; toast('Score changed elsewhere. Showing the latest.', true); } else App.fail(e); }
      busy = false; draw();
    }
    function draw() {
      const g = m.games, cur = g.find(x => !x.complete) || g[g.length - 1] || { a: 0, b: 0 }, done = g.filter(x => x.complete), won = k => done.filter(x => x[k] > x[k === 'a' ? 'b' : 'a']).length;
      const live = m.status === 'in_progress', rules = m.rules;
      const team = k => h('div', { class: 'card team' }, h('div', { class: 'nm' }, m[k] ? m[k].name : 'TBD', m.winner === k ? ' 🏆' : ''), h('div', { class: 'big', 'aria-live': 'polite', 'aria-label': `${m[k] ? m[k].name : k} current game points` }, cur[k]), h('div', { class: 'muted' }, `Games won: ${won(k)}`),
        h('button', { class: 'plus', disabled: !live || busy || !can('score'), onclick: () => tap(k), 'aria-label': `Add point for ${m[k] ? m[k].name : k}` }, '+1'));
      const tools = [];
      if (m.status === 'scheduled' && can('match.control')) tools.push(h('button', { class: 'primary', onclick: () => post2('start') }, 'Start match'));
      if (can('score') && ['in_progress', 'paused', 'awaiting_confirmation'].includes(m.status)) tools.push(h('button', { onclick: () => post2('undo') }, '↩ Undo last point'));
      if (live && can('match.control')) tools.push(h('button', { onclick: () => post2('pause') }, 'Pause'));
      if (m.status === 'paused' && can('match.control')) tools.push(h('button', { class: 'primary', onclick: () => post2('resume') }, 'Resume'));
      if (m.status === 'awaiting_confirmation') tools.push(h('button', { class: 'primary', onclick: async () => { if (await App.confirm(`Confirm final result ${m.final_score}? The winner will advance in the bracket.`, 'Confirm result')) post2('confirm'); } }, '✔ Confirm final result'));
      if (['in_progress', 'paused', 'awaiting_confirmation'].includes(m.status) && can('score')) tools.push(h('button', { onclick: async () => { const n = h('input', { required: true, placeholder: 'What is disputed?' }); const r = await dialog('Dispute score', field('Details', n), [{ label: 'Pause and refer to referee', primary: true, run: async () => { await post(`/api/matches/${m.id}/dispute`, { note: n.value }); } }]); if (r) reload(); } }, 'Dispute'));
      if (m.status === 'disputed' && can('score.correct')) tools.push(h('button', { class: 'primary', onclick: async () => { const n = h('input', { placeholder: 'Referee decision' }); const r = await dialog('Resolve dispute', field('Decision', n), [{ label: 'Resolve', primary: true, run: async () => { await post(`/api/matches/${m.id}/resolve-dispute`, { note: n.value }); } }]); if (r) reload(); } }, 'Resolve dispute'));
      if (['scheduled', 'in_progress', 'paused'].includes(m.status) && can('score')) tools.push(h('button', { onclick: () => manualDialog(false) }, 'Enter full score'));
      if (['awaiting_confirmation', 'disputed', 'completed'].includes(m.status) && can('score.correct')) tools.push(h('button', { onclick: () => manualDialog(true) }, 'Correct score (admin)'));
      if (['scheduled', 'in_progress', 'paused'].includes(m.status) && can('match.control')) tools.push(h('button', { onclick: () => walkoverDialog(m) }, 'Walkover / retire'));
      if (RESETTABLE.includes(m.status) && can('score.correct')) tools.push(h('button', { class: 'danger', onclick: () => resetDialog(m, async r => { m = r; corrections = (await api('GET', `/api/matches/${m.id}`)).corrections; draw(); }) }, 'Reset / replay match'));
      tools.push(h('a', { class: 'btn', href: `/print/scoresheet/${m.id}`, target: '_blank', rel: 'noopener' }, 'Score sheet'));
      wrap.replaceChildren(h('a', { href: '#/admin/courts' }, '← Courts'),
        h('div', { class: 'row between' }, h('div', {}, h('h1', {}, `${m.category_name} · ${m.label}`), h('span', { class: 'muted' }, `${m.court_name || 'No court'} · ${fmtDT(m.scheduled_at)} · ${rules ? `best of ${rules.games_to_win * 2 - 1}, to ${rules.points_to_win}` : ''}`)), chip(m.status)),
        live && !can('score') ? h('div', { class: 'warn' }, 'Your account can start, pause and call matches but cannot enter scores. Ask a scorer or administrator.') : null,
        m.status === 'disputed' ? h('div', { class: 'warn' }, `Disputed: ${m.dispute_note || ''}. Scoring is paused until an administrator resolves it.`) : null,
        h('div', { class: 'console' }, team('a'), team('b')),
        h('div', { class: 'gamestrip', 'aria-label': 'Game scores' }, done.length ? done.map((x, i) => h('span', { class: 'pt' }, `G${i + 1}: ${x.a}-${x.b}`)) : h('span', { class: 'muted' }, 'No completed games yet')),
        m.status === 'awaiting_confirmation' || m.status === 'completed' ? h('p', { class: 'card', style: null }, h('strong', {}, 'Final score: '), m.final_score || '', m.winner ? ` · Winner: ${m[m.winner].name}` : '') : null,
        h('div', { class: 'tools' }, tools), corrections.length ? h('div', {}, h('h2', {}, 'Correction history'), table([{ h: 'When', f: r => fmtDT(r.created_at) }, { h: 'By', f: r => r.username }, { h: 'Reason', f: r => r.reason }, { h: 'Before', f: r => (JSON.parse(r.before).final_score || '') }, { h: 'After', f: r => { const a = JSON.parse(r.after); return a.reset ? 'RESET (to be replayed)' : a.final_score; } }], corrections)) : null);
    }
    function manualDialog(correcting) {
      const n = (m.rules ? m.rules.games_to_win : 2) * 2 - 1, rows = [...Array(n)].map((_, i) => ({ a: h('input', { type: 'number', min: 0, max: 99, inputmode: 'numeric', 'aria-label': `Game ${i + 1} ${m.a ? m.a.name : 'A'}`, value: m.games[i]?.complete ? m.games[i].a : '' }), b: h('input', { type: 'number', min: 0, max: 99, inputmode: 'numeric', 'aria-label': `Game ${i + 1} ${m.b ? m.b.name : 'B'}`, value: m.games[i]?.complete ? m.games[i].b : '' }) }));
      const reason = h('input', { placeholder: 'Reason for correction', required: correcting });
      return dialog(correcting ? 'Correct final score' : 'Enter full score', h('div', {}, h('p', { class: 'small muted' }, 'Leave unplayed games blank. The score is validated against the match rules.'),
        h('div', { class: 'grid g2' }, h('strong', {}, m.a ? m.a.name : 'A'), h('strong', {}, m.b ? m.b.name : 'B')), ...rows.map(r => h('div', { class: 'grid g2' }, r.a, r.b)), correcting ? field('Reason (audited)', reason) : null),
        [{ label: correcting ? 'Save correction' : 'Save score', primary: true, run: async () => {
          const games = rows.filter(r => r.a.value !== '' || r.b.value !== '').map(r => ({ a: Number(r.a.value), b: Number(r.b.value) }));
          const res = await post(`/api/matches/${m.id}/games`, { games, reason: reason.value, version: m.version }).catch(e => { if (e.data && e.data.code === 'stale') { m = e.data.match; draw(); } throw e; });
          m = res.match; corrections = (await api('GET', `/api/matches/${m.id}`)).corrections; draw(); toast(correcting ? 'Correction saved' : 'Score saved. Confirm the result to finalise.'); } }]);
    }
    draw(); return wrap;
  };

  A.matches = async () => {
    const f = App.filters, qs = new URLSearchParams(); if (f.mcat) qs.set('category', f.mcat); if (f.mstatus) qs.set('status', f.mstatus); if (f.mq) qs.set('q', f.mq);
    const [ms, cats, c] = await Promise.all([api('GET', `/api/matches?${qs}`), api('GET', '/api/categories'), api('GET', '/api/courts')]);
    const flt = (k, label, opts) => h('div', {}, h('label', {}, label), sel(k, opts, f[k], { onchange: e => { f[k] = e.target.value; App.render(); } }));
    return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, 'Matches and schedule'), can('admin') ? h('button', { class: 'primary', onclick: () => newFixture(cats.categories) }, 'New fixture') : null),
      h('div', { class: 'row' }, flt('mcat', 'Category', [['', 'All'], ...cats.categories.map(x => [x.id, x.name])]), flt('mstatus', 'Status', [['', 'All'], ...Object.keys(App.LABEL).filter(k => !['upcoming', 'available', 'maintenance', 'approved', 'rejected', 'live'].includes(k)).map(k => [k, App.LABEL[k]])]),
        h('div', {}, h('label', {}, 'Search player/team'), h('input', { type: 'search', value: f.mq || '', onchange: e => { f.mq = e.target.value; App.render(); } }))), h('br'),
      table([{ h: '#', f: r => r.id }, { h: 'Category', f: r => r.category_name }, { h: 'Round', f: r => r.label }, { h: 'Match', f: r => `${r.a ? r.a.name : 'TBD'} vs ${r.b ? r.b.name : 'TBD'}` }, { h: 'Court / time', f: r => r.court_name ? `${r.court_name} · ${fmtDT(r.scheduled_at)}` : '-' }, { h: 'Status', f: r => chip(r.status) }, { h: 'Score', f: r => r.final_score || '' },
        { h: 'Actions', f: r => h('div', { class: 'row' }, RESETTABLE.includes(r.status) && can('score.correct') ? h('button', { class: 'sm', onclick: () => resetDialog(r) }, 'Reset / replay') : null, ['pending', 'scheduled', 'postponed', 'cancelled'].includes(r.status) && can('admin') ? h('button', { class: 'sm danger', onclick: () => removeMatch(r) }, 'Delete') : null, ['pending', 'postponed', 'scheduled'].includes(r.status) && can('schedule.assign') ? h('button', { class: 'sm', onclick: () => scheduleDialog(r, c.courts) }, r.status === 'scheduled' ? 'Move' : 'Schedule') : null,
          r.status === 'scheduled' && can('match.control') ? h('button', { class: 'sm', onclick: () => act(() => post(`/api/matches/${r.id}/callup`), 'Players called') }, 'Call') : null,
          ['scheduled', 'in_progress', 'paused', 'awaiting_confirmation', 'disputed', 'completed'].includes(r.status) && can('score') ? h('a', { class: 'btn sm', href: `#/admin/score/${r.id}` }, 'Score') : null,
          ['pending', 'scheduled', 'postponed'].includes(r.status) && can('admin') ? h('button', { class: 'sm', onclick: () => editFixture(r) }, 'Edit teams') : null,
          !['completed', 'walkover', 'bye', 'cancelled'].includes(r.status) && can('match.control') ? h('button', { class: 'sm danger', onclick: async () => { const n = h('input', { required: true }); const ok = await dialog(`Cancel match #${r.id}`, h('div', {}, r.next_match_id ? h('p', { class: 'warn small' }, 'This match feeds the next round. Cancelling it stops the bracket from advancing. To send a player through, use Walkover instead.') : null, field('Reason', n)), [{ label: 'Cancel match', danger: true, run: async () => { await post(`/api/matches/${r.id}/cancel`, { reason: n.value }); } }]); if (ok) reload(); } }, 'Cancel') : null) }], ms.matches, 'No matches. Generate fixtures from the Categories page.'));
    async function teamsFor(cat) { return (await api('GET', `/api/teams?category=${cat}`)).teams; }
    async function newFixture(cs) {
      const cat = sel('c', cs.map(x => [x.id, x.name]), cs[0]?.id), a = sel('a', [], ''), b = sel('b', [], ''), round = inp('round', 1, { type: 'number', min: 1 });
      const fill = async () => { const ts = await teamsFor(cat.value); for (const s of [a, b]) s.replaceChildren(...ts.map(t => h('option', { value: t.id }, t.name))); }; cat.onchange = fill; await fill();
      const r = await dialog('New manual fixture', h('div', {}, field('Category', cat), field('Side A', a), field('Side B', b), field('Round number', round)), [{ label: 'Create fixture', primary: true, run: async () => { await post('/api/matches', { category_id: Number(cat.value), team_a: Number(a.value), team_b: Number(b.value), round: Number(round.value), label: `Round ${round.value}` }); } }]); if (r) reload();
    }
    async function editFixture(r) {
      const ts = await teamsFor(r.category_id), opt = k => sel(k, [['', 'To be decided'], ...ts.map(t => [t.id, t.name])], r[k === 'team_a' ? 'a' : 'b']?.id || '');
      const a = opt('team_a'), b = opt('team_b'); const ok = await dialog(`Edit match #${r.id}`, h('div', {}, field('Side A', a), field('Side B', b)), [{ label: 'Save', primary: true, run: async () => { await api('PATCH', `/api/matches/${r.id}`, { team_a: a.value ? Number(a.value) : null, team_b: b.value ? Number(b.value) : null, version: r.version }); } }]); if (ok) reload();
    }
  };

  A.registrations = async () => {
    const f = App.filters, qs = new URLSearchParams(); if (f.rstatus) qs.set('status', f.rstatus); if (f.rcat) qs.set('category', f.rcat);
    const [r, cats] = await Promise.all([api('GET', `/api/registrations?${qs}`), api('GET', '/api/categories')]);
    return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, 'Registrations'), h('button', { class: 'primary', onclick: () => addReg(cats.categories) }, 'Add registration')),
      h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Status'), sel('s', [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']], f.rstatus, { onchange: e => { f.rstatus = e.target.value; App.render(); } })),
        h('div', {}, h('label', {}, 'Category'), sel('c', [['', 'All'], ...cats.categories.map(c => [c.id, c.name])], f.rcat, { onchange: e => { f.rcat = e.target.value; App.render(); } }))), h('br'),
      table([{ h: 'Player', f: x => x.name }, { h: 'Partner', f: x => x.partner_name || '' }, { h: 'Category', f: x => x.category }, { h: 'College ID', f: x => x.college_id || '' }, { h: 'Contact', f: x => x.contact || '' }, { h: 'Status', f: x => chip(x.status) },
        { h: 'Decision', f: x => h('div', { class: 'row' }, x.status !== 'approved' ? h('button', { class: 'sm primary', onclick: () => act(() => api('PATCH', `/api/registrations/${x.id}`, { status: 'approved' }), 'Approved') }, 'Approve') : null,
          x.status !== 'rejected' ? h('button', { class: 'sm danger', onclick: async () => { const n = h('input', { placeholder: 'Reason (optional)' }); const ok = await dialog(`Reject ${x.name}`, field('Reason', n), [{ label: 'Reject', danger: true, run: async () => { await api('PATCH', `/api/registrations/${x.id}`, { status: 'rejected', reason: n.value }); } }]); if (ok) reload(); } }, 'Reject') : null, can('admin') ? h('button', { class: 'sm danger', onclick: () => removeFlow(`/api/registrations/${x.id}`, `${x.name}'s entry in ${x.category}`, 'If they are already in a bracket, that category\'s fixtures are rebuilt.', 'Delete') }, 'Delete') : null) }], r.registrations, 'No registrations match.'));
    async function addReg(cs) {
      const P = pre => ['name', 'gender', 'college_id', 'contact', 'course_year'].map(k => k === 'gender' ? field(k.replace('_', ' '), sel(pre + k, [['male', 'Male'], ['female', 'Female'], ['other', 'Other']], 'male')) : field(k.replace('_', ' '), inp(pre + k, '')));
      const cat = sel('cat', cs.map(c => [c.id, `${c.name} (${c.kind})`]), cs[0]?.id), body = h('div', {}, field('Category', cat), ...P(''), h('h3', {}, 'Partner (doubles only)'), ...P('p_'));
      const pick = (pre, root) => Object.fromEntries(['name', 'gender', 'college_id', 'contact', 'course_year'].map(k => [k, root.querySelector(`[name=${pre + k}]`).value]));
      const ok = await dialog('Add registration', body, [{ label: 'Add', primary: true, run: async () => { const kind = cs.find(c => c.id === Number(cat.value)).kind; await post('/api/registrations/admin', { player: pick('', body), partner: kind === 'doubles' ? pick('p_', body) : undefined, category_ids: [Number(cat.value)] }); } }]); if (ok) reload();
    }
  };

  A.players = async () => {
    const q = App.filters.pq || '', p = await api('GET', `/api/players?q=${encodeURIComponent(q)}`);
    return h('div', {}, h('h1', {}, 'Players and check-in'), h('div', {}, h('label', {}, 'Search name or college ID'), h('input', { type: 'search', value: q, onchange: e => { App.filters.pq = e.target.value; App.render(); } })), h('br'),
      table([{ h: 'Name', f: x => x.name }, { h: 'College ID', f: x => x.college_id || '' }, { h: 'Entries', f: x => x.registrations.map(r => `${r.category} (${r.status})`).join(', ') },
        { h: 'Attendance', f: x => x.checked_in_at ? chip('approved', 'Checked in ' + fmtTime(x.checked_in_at)) : chip('pending', 'Not here') }, { h: 'Ready', f: x => x.ready ? chip('in_progress', 'Ready') : chip('available', 'Not ready') },
        { h: 'Actions', f: x => h('div', { class: 'row' }, can('checkin') ? [h('button', { class: 'sm', onclick: () => act(() => post(`/api/players/${x.id}/checkin`, { checked_in: !x.checked_in_at }), x.checked_in_at ? 'Check-in removed' : 'Checked in') }, x.checked_in_at ? 'Undo check-in' : 'Check in'),
          h('button', { class: 'sm', disabled: !x.checked_in_at, onclick: () => act(() => post(`/api/players/${x.id}/ready`, { ready: !x.ready })) }, x.ready ? 'Not ready' : 'Mark ready')] : null,
          can('registration.review') ? h('button', { class: 'sm', onclick: () => editPlayer(x) }, 'Edit') : null, can('admin') ? h('button', { class: 'sm danger', onclick: () => removeFlow(`/api/players/${x.id}`, `player ${x.name}`, 'Their entries are removed, and fixtures for their categories are rebuilt (court assignments there are cleared).', 'Delete') }, 'Delete') : null) }], p.players, 'No players found.'));
    async function editPlayer(x) {
      const pub = h('input', { type: 'checkbox', name: 'public', checked: !!x.public }), body = h('div', {}, field('Name', inp('name', x.name)), field('Gender', sel('gender', [['male', 'Male'], ['female', 'Female'], ['other', 'Other']], x.gender)), field('College ID', inp('college_id', x.college_id)), field('Contact (private)', inp('contact', x.contact)), field('Course / year', inp('course_year', x.course_year)), field('Admin notes (private)', inp('notes', x.notes)), h('label', { class: 'inline' }, pub, 'Show on public players page'));
      const val = n => body.querySelector(`[name=${n}]`).value;
      const ok = await dialog(`Edit ${x.name}`, body, [{ label: 'Save', primary: true, run: async () => { await api('PATCH', `/api/players/${x.id}`, { name: val('name'), gender: val('gender'), college_id: val('college_id'), contact: val('contact'), course_year: val('course_year'), notes: val('notes'), public: pub.checked }); } }]); if (ok) reload();
    }
  };

  A.categories = async () => {
    const [c, teams] = await Promise.all([api('GET', '/api/categories'), api('GET', '/api/teams')]);
    return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, 'Categories and fixtures'), h('button', { class: 'primary', onclick: () => catDialog() }, 'New category')),
      table([{ h: 'Category', f: x => x.name }, { h: 'Type', f: x => `${x.kind}, ${x.gender}` }, { h: 'Format', f: x => x.format === 'roundrobin' ? `Round robin (${x.groups} group${x.groups > 1 ? 's' : ''})` : `Knockout${x.third_place ? ' + third place' : ''}` }, { h: 'Teams', f: x => teams.teams.filter(t => t.category_id === x.id).length },
        { h: 'Public site', f: x => h('button', { class: 'sm' + (x.published ? '' : ' primary'), 'aria-label': (x.published ? 'Hide ' : 'Publish ') + x.name, onclick: () => act(() => api('PATCH', `/api/categories/${x.id}`, { published: !x.published }), x.published ? 'Hidden from public site' : 'Now visible on the public site') }, x.published ? 'Public ✓ (click to hide)' : 'Hidden - click to publish') }, { h: 'Fixtures', f: x => x.generated ? chip('scheduled', 'Generated') : chip('pending', 'Not yet') },
        { h: 'Actions', f: x => h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => catDialog(x) }, 'Edit'), h('button', { class: 'sm', disabled: x.generated, onclick: () => seedDialog(x, teams.teams.filter(t => t.category_id === x.id)) }, 'Seeds'),
          h('button', { class: 'sm primary', onclick: () => gen(x) }, x.generated ? 'Regenerate' : 'Generate fixtures'), x.generated ? h('button', { class: 'sm', onclick: () => clearFix(x) }, 'Clear fixtures') : null, h('button', { class: 'sm danger', onclick: () => removeFlow(`/api/categories/${x.id}`, `category "${x.name}"`, '', 'Delete') }, 'Delete')) }], c.categories, 'Create categories such as Boys\' Singles, then register players.'));
    async function gen(x) {
      const shuffle = h('input', { type: 'checkbox' }); const ok = await dialog(`Generate fixtures: ${x.name}`, h('div', {}, h('p', {}, x.generated ? 'This replaces existing fixtures. It is blocked once any match has started.' : 'Builds the bracket from approved teams. Seeded teams are placed first; byes go to the top seeds.'), h('label', { class: 'inline' }, shuffle, 'Randomise unseeded teams')),
        [{ label: 'Generate', primary: true, run: async () => { await post(`/api/categories/${x.id}/generate`, { shuffle: shuffle.checked }); } }]); if (ok) { toast('Fixtures generated'); reload(); }
    }
    async function seedDialog(x, ts) {
      const rows = ts.map(t => [t, inp('s' + t.id, t.seed ?? '', { type: 'number', min: 1, max: 999 })]);
      const ok = await dialog(`Seeds: ${x.name}`, h('div', {}, h('p', { class: 'small muted' }, 'Lower number = stronger seed. Leave blank for unseeded.'), rows.map(([t, i]) => field(t.name, i))), [{ label: 'Save seeds', primary: true, run: async () => { for (const [t, i] of rows) await api('PATCH', `/api/teams/${t.id}`, { seed: i.value }); } }]); if (ok) reload();
    }
    async function catDialog(x = {}) {
      const pub = h('input', { type: 'checkbox', checked: x.id ? !!x.published : true }), third = h('input', { type: 'checkbox', checked: !!x.third_place });
      const body = h('div', {}, field('Name', inp('name', x.name, { maxlength: 60 })), field('Type', sel('kind', [['singles', 'Singles'], ['doubles', 'Doubles']], x.kind || 'singles')), field('Gender', sel('gender', [['boys', 'Boys'], ['girls', 'Girls'], ['mixed', 'Mixed (doubles)'], ['open', 'Open']], x.gender || 'open')),
        field('Format', sel('format', [['knockout', 'Knockout'], ['roundrobin', 'Round robin']], x.format || 'knockout')), field('Round-robin groups', inp('groups', x.groups || 1, { type: 'number', min: 1, max: 8 })), h('label', { class: 'inline' }, third, 'Third-place match (knockout)'), h('label', { class: 'inline' }, pub, 'Publish to the public site'));
      const v = n => body.querySelector(`[name=${n}]`).value;
      const ok = await dialog(x.id ? 'Edit category' : 'New category', body, [{ label: 'Save', primary: true, run: async () => { const d = { name: v('name'), kind: v('kind'), gender: v('gender'), format: v('format'), groups: Number(v('groups')), third_place: third.checked, published: pub.checked }; await (x.id ? api('PATCH', `/api/categories/${x.id}`, d) : post('/api/categories', d)); } }]); if (ok) reload();
    }
  };

  A.news = async () => {
    const a = await api('GET', '/api/announcements'), kind = sel('kind', [['info', 'Announcement'], ['schedule', 'Schedule change']], 'info');
    return h('div', {}, h('h1', {}, 'Announcements'), h('form', { class: 'form card', onsubmit: async e => { e.preventDefault(); const d = fd(e.target); if (await act(() => post('/api/announcements', { title: d.title, body: d.body, kind: d.kind }), 'Published')) e.target.reset(); } },
      field('Title', h('input', { name: 'title', required: true, maxlength: 120 })), field('Type', kind), field('Message', h('textarea', { name: 'body', required: true, maxlength: 2000 })), h('br'), h('button', { class: 'primary', type: 'submit' }, 'Publish')), h('h2', {}, 'Published and drafts'),
      table([{ h: 'When', f: x => fmtDT(x.created_at) }, { h: 'Title', f: x => x.title }, { h: 'Type', f: x => x.kind }, { h: 'Visible', f: x => x.published ? 'Public' : 'Hidden' }, { h: '', f: x => h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => editNews(x) }, 'Edit'), h('button', { class: 'sm', onclick: () => act(() => api('PATCH', `/api/announcements/${x.id}`, { published: !x.published })) }, x.published ? 'Hide' : 'Publish'),
        h('button', { class: 'sm danger', onclick: async () => { if (await App.confirm('Delete this announcement?', 'Delete', true)) act(() => api('DELETE', `/api/announcements/${x.id}`)); } }, 'Delete')) }], a.announcements));
  };
  A.volunteers = async () => {
    const [v, c] = await Promise.all([api('GET', '/api/volunteers'), api('GET', '/api/courts')]);
    return h('div', {}, h('h1', {}, 'Volunteer assignments'), h('form', { class: 'form card', onsubmit: async e => { e.preventDefault(); const d = fd(e.target); if (await act(() => post('/api/volunteers', { ...d, court_id: d.court_id || null }), 'Added')) e.target.reset(); } },
      field('Name', h('input', { name: 'name', required: true })), field('Role', h('input', { name: 'role', required: true, placeholder: 'Scorer, Registration, Equipment...' })), field('Court (optional)', sel('court_id', [['', 'None'], ...c.courts.map(x => [x.id, x.name])], '')), field('Shift', h('input', { name: 'shift' })), field('Contact (private)', h('input', { name: 'contact' })), h('br'), h('button', { class: 'primary', type: 'submit' }, 'Add volunteer')),
      h('br'), table([{ h: 'Name', f: x => x.name }, { h: 'Role', f: x => x.role }, { h: 'Court', f: x => x.court || '' }, { h: 'Shift', f: x => x.shift || '' }, { h: 'Contact', f: x => x.contact || '' }, { h: '', f: x => h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => editVolunteer(x) }, 'Edit'), h('button', { class: 'sm danger', onclick: () => removeFlow(`/api/volunteers/${x.id}`, x.name, '', 'Remove') }, 'Remove')) }], v.volunteers, 'No volunteers assigned yet.'));
  };
  A.users = async () => {
    const u = await api('GET', '/api/users'); const roles = [['admin', 'Administrator'], ['scorer', 'Scorer'], ['staff', 'Staff'], ['player', 'Player'], ['viewer', 'Viewer']];
    return h('div', {}, h('div', { class: 'row between' }, h('h1', {}, 'Users and roles'), h('button', { class: 'primary', onclick: () => userDialog() }, 'New user')),
      table([{ h: 'Username', f: x => x.username }, { h: 'Email', f: x => x.email || '' }, { h: 'Role', f: x => x.role }, { h: 'Active', f: x => x.active ? 'Yes' : chip('cancelled', 'Disabled') }, { h: 'Created', f: x => fmtDT(x.created_at) }, { h: '', f: x => h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => userDialog(x) }, 'Edit'), h('button', { class: 'sm danger', disabled: x.id === App.me.id, 'aria-label': 'Delete ' + x.username, onclick: () => removeFlow(`/api/users/${x.id}`, `user ${x.username}`, 'They can no longer sign in. Their past actions stay in the audit log.', 'Delete') }, 'Delete')) }], u.users),
      h('p', { class: 'muted small' }, 'Administrators: everything. Scorers: score and control matches. Staff: registrations, check-in, scheduling, announcements. Players and viewers: read-only.'));
    async function userDialog(x) {
      const body = h('div', {}, x ? null : field('Username', inp('username', '', { maxlength: 32 })), x ? null : field('Email (optional)', inp('email', '', { type: 'email' })), field('Role', sel('role', roles, x ? x.role : 'scorer')), field(x ? 'New password (leave blank to keep)' : 'Password', inp('password', '', { type: 'password', autocomplete: 'new-password' }), 'At least 10 characters.'),
        x ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'active', checked: !!x.active }), 'Account active') : null); const v = n => body.querySelector(`[name=${n}]`);
      const ok = await dialog(x ? `Edit ${x.username}` : 'New user', body, [{ label: 'Save', primary: true, run: async () => { if (x) await api('PATCH', `/api/users/${x.id}`, { role: v('role').value, active: v('active').checked, password: v('password').value || undefined }); else await post('/api/users', { username: v('username').value, email: v('email').value, role: v('role').value, password: v('password').value }); } }]); if (ok) reload();
    }
  };
  A.settings = async () => {
    const s = (await api('GET', '/api/settings')).settings, r = s.rules;
    return h('form', { class: 'form stack', onsubmit: async e => { e.preventDefault(); const d = fd(e.target), cb = n => e.target.querySelector(`[name=${n}]`).checked;
      await act(() => api('PATCH', '/api/settings', { tournament_name: d.tournament_name, college_name: d.college_name, venue: d.venue, event_date: d.event_date, registration_open: cb('registration_open'), allow_viewer_signup: cb('allow_viewer_signup'), match_minutes: d.match_minutes, grace_minutes: d.grace_minutes, max_categories: d.max_categories,
        rules: { games_to_win: Number(d.games_to_win), points_to_win: Number(d.points_to_win), win_by: Number(d.win_by), cap: Number(d.cap) }, rules_text: d.rules_text }), 'Settings saved'); } },
      h('h1', {}, 'Tournament settings'), field('Tournament name', inp('tournament_name', s.tournament_name)), field('College', inp('college_name', s.college_name)), field('Venue', inp('venue', s.venue)), field('Event date', inp('event_date', s.event_date, { placeholder: 'e.g. 14-15 March 2027' })),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'registration_open', checked: s.registration_open === '1' }), 'Public registration open'), h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'allow_viewer_signup', checked: s.allow_viewer_signup === '1' }), 'Allow viewer accounts'),
      h('h2', {}, 'Scoring rules (snapshotted when a match starts)'), field('Games needed to win', inp('games_to_win', r.games_to_win, { type: 'number', min: 1, max: 5 }), '2 = best of three. 1 = a single game.'), field('Points to win a game', inp('points_to_win', r.points_to_win, { type: 'number', min: 1 })), field('Winning margin', inp('win_by', r.win_by, { type: 'number', min: 1, max: 5 })), field('Point cap (0 for none)', inp('cap', r.cap, { type: 'number', min: 0 })),
      h('h2', {}, 'Operations'), field('Match duration for scheduling (minutes)', inp('match_minutes', s.match_minutes, { type: 'number', min: 1 })), field('No-show grace period (minutes)', inp('grace_minutes', s.grace_minutes, { type: 'number', min: 1 })), field('Max categories per player (public registration)', inp('max_categories', s.max_categories, { type: 'number', min: 1 })),
      field('Public rules text', h('textarea', { name: 'rules_text', rows: 10 }, s.rules_text)), h('button', { class: 'primary', type: 'submit' }, 'Save settings'));
  };
  A.audit = async () => {
    const a = await api('GET', '/api/audit');
    return h('div', {}, h('h1', {}, 'Audit log'), h('p', { class: 'muted' }, 'Every change to scores, fixtures, court assignments, settings, users and registrations is recorded here.'), table([{ h: 'When', f: x => new Date(x.created_at).toLocaleString() }, { h: 'Who', f: x => x.username }, { h: 'Action', f: x => x.action }, { h: 'Item', f: x => x.entity ? `${x.entity} #${x.entity_id ?? ''}` : '' }, { h: 'Details', f: x => h('code', { class: 'small' }, (x.details || '').slice(0, 160)) }], a.entries), h('p', {}, h('a', { class: 'btn', href: '/api/export/audit.csv' }, 'Download full audit CSV')));
  };
  A.reports = async () => {
    const r = await api('GET', '/api/reports/summary');
    return h('div', { class: 'stack' }, h('h1', {}, 'Reports'), h('h2', {}, 'Participation'), table([{ h: 'Category', f: x => x.name }, { h: 'Approved entries', f: x => x.approved }, { h: 'Pending', f: x => x.pending }, { h: 'Teams', f: x => x.teams }, { h: 'Matches', f: x => `${x.finished}/${x.matches} finished` }], r.participation),
      h('h2', {}, 'Winners'), table([{ h: 'Category', f: x => x.name }, { h: 'Champion', f: x => x.champion || 'In progress' }, { h: 'Runner-up', f: x => x.runner_up || '' }, { h: 'Third', f: x => x.third || '' }], r.results),
      h('h2', {}, 'Exports and printables'), h('div', { class: 'row' }, can('admin') ? ['players', 'registrations', 'matches', 'results', 'standings', 'corrections', 'audit'].map(n => h('a', { class: 'btn', href: `/api/export/${n}.csv` }, `${n}.csv`)) : null),
      h('div', { class: 'row' }, [['/print/fixtures', 'Fixtures'], ['/print/schedule', 'Court schedule'], ['/print/results', 'Results']].map(([u, l]) => h('a', { class: 'btn', href: u, target: '_blank', rel: 'noopener' }, `Print ${l}`))), h('p', { class: 'muted small' }, 'Print pages open a clean layout; use your browser\'s "Save as PDF" in the print dialog for PDFs. Score sheets are on each match.'));
  };

  App.pages.admin = { title: 'Staff console', live: true, async render(args) {
    if (!App.me) { const e = new Error('Sign in with a staff account to continue.'); e.status = 401; throw e; }
    const sec = args[0] || '', hasPerm = p => can(p);
    if (!hasPerm('panel')) { const e = new Error('Your account is read-only. Staff accounts are created by an administrator.'); e.status = 403; throw e; }
    const link = NAV.filter(([, , p]) => hasPerm(p));
    App.$('#subnav-wrap').replaceChildren(h('nav', { class: 'subnav', 'aria-label': 'Staff' }, link.map(([s, l]) => h('a', { href: `#/admin${s ? '/' + s : ''}`, 'aria-current': s === sec ? 'page' : null }, l))));
    const need = NAV.find(([s]) => s === sec); if (!need || !hasPerm(need[2])) { if (sec === 'score' && hasPerm('score')) return A.score(args.slice(1)); const e = new Error('You do not have access to this section.'); e.status = 403; throw e; }
    return (A[sec || 'dashboard'])(args.slice(1));
  } };
  // scoring console is reachable as #/admin/score/ID
  const baseRender = App.pages.admin.render;
  App.pages.admin.render = async args => { if (args[0] === 'score') { if (!App.me) { const e = new Error('Sign in to score.'); e.status = 401; throw e; } if (!App.can('panel')) { const e = new Error('Only staff accounts can open the scoring console.'); e.status = 403; throw e; } App.$('#subnav-wrap').replaceChildren(); return A.score(args.slice(1)); } return baseRender(args); };
  App.start();
})();
