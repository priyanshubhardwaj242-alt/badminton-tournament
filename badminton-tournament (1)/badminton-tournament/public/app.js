(() => {
  const App = window.App = { pages: {}, me: null, current: null, filters: {} };
  const $ = (s, r = document) => r.querySelector(s);

  // ---------- helpers ----------
  function h(tag, a, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(a || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v === true) e.setAttribute(k, ''); else e.setAttribute(k, v);
    }
    const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) k.forEach(add); else e.append(k.nodeType ? k : document.createTextNode(String(k))); };
    kids.forEach(add); return e;
  }
  const LABEL = { in_progress: 'In progress', paused: 'Paused', awaiting_confirmation: 'Awaiting confirmation', disputed: 'Disputed', scheduled: 'Scheduled', pending: 'Not scheduled', postponed: 'Postponed',
    completed: 'Completed', walkover: 'Walkover', bye: 'Bye', cancelled: 'Cancelled', upcoming: 'Upcoming', available: 'Available', maintenance: 'Maintenance', approved: 'Approved', rejected: 'Rejected', live: 'Live' };
  const chip = (s, text) => h('span', { class: `chip s-${s}` }, s === 'in_progress' ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null, text || LABEL[s] || s);
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const fmtDT = iso => iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const localInput = d => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return x.toISOString().slice(0, 16); };
  const can = p => !!App.me && !!App.me.perms && (App.me.perms.includes('*') || App.me.perms.includes(p));
  const spinner = () => h('div', { class: 'stack', 'aria-busy': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  const empty = t => h('div', { class: 'empty card' }, t);
  Object.assign(App, { h, chip, fmtTime, fmtDT, localInput, can, empty, spinner, LABEL, $ });

  async function api(method, path, body) {
    let res;
    try { res = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
    catch { const e = new Error('Cannot reach the server. Check your connection.'); e.status = 0; throw e; }
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  App.api = api;
  function toast(msg, bad) { const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); $('#toasts').append(t); setTimeout(() => t.remove(), bad ? 7000 : 3500); }
  App.toast = toast;
  App.fail = e => { toast(e.message, true); if (e.status === 401) { App.me = null; buildNav(); location.hash = '#/login'; } };
  App.run = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { App.fail(e); return null; } };

  function dialog(title, body, actions = []) {
    return new Promise(resolve => {
      const d = h('dialog', { 'aria-labelledby': 'dlg-t' }), err = h('p', { class: 'err', role: 'alert' });
      const close = v => { d.close(); d.remove(); resolve(v); };
      const row = h('div', { class: 'row', style: null }, ...actions.map(a => h('button', { type: 'button', class: a.primary ? 'primary' : a.danger ? 'danger' : '', onclick: async ev => {
        if (!a.run) return close(a.value ?? null);
        ev.target.disabled = true; err.textContent = '';
        try { const r = await a.run(d); if (r !== false) close(r ?? true); else ev.target.disabled = false; } catch (e) { err.textContent = e.message; ev.target.disabled = false; if (e.status === 401) App.fail(e); }
      } }, a.label)));
      d.append(h('h2', { id: 'dlg-t', style: null }, title), body, err, h('div', { class: 'row' }, row, h('button', { type: 'button', onclick: () => close(null) }, 'Cancel')));
      d.addEventListener('cancel', () => resolve(null)); document.body.append(d); d.showModal();
    });
  }
  App.dialog = dialog;
  App.confirm = (msg, label = 'Confirm', danger) => dialog('Please confirm', h('p', {}, msg), [{ label, primary: !danger, danger, value: true }]).then(v => v === true);
  App.field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
  App.fd = f => Object.fromEntries(new FormData(f));
  App.table = (cols, rows, emptyMsg = 'Nothing to show yet.') => rows.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(c => h('th', { scope: 'col' }, c.h)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(c => h('td', {}, c.f(r)))))))) : empty(emptyMsg);

  // ---------- shared components ----------
  function matchCard(m, opts = {}) {
    const side = k => {
      const t = m[k], win = m.winner === k, games = m.games || [];
      return h('div', { class: 'side' + (win ? ' win' : '') }, h('span', { class: 'nm' }, t ? t.name : 'To be decided'), win ? h('span', { class: 'small', 'aria-label': 'winner' }, '✔') : null,
        h('span', { class: 'g' }, m.result_type === 'walkover' ? (win ? h('span', { class: 'pt' }, 'W/O') : null) : games.map(g => h('span', { class: 'pt' + (!g.complete ? ' cur' : '') }, g[k]))));
    };
    return h('article', { class: 'card match', 'aria-label': `${m.category_name} ${m.label}` },
      h('div', { class: 'meta' }, h('span', {}, `${m.category_name} · ${m.label}${m.court_name ? ' · ' + m.court_name : ''}${m.scheduled_at && !['completed', 'walkover'].includes(m.status) ? ' · ' + fmtTime(m.scheduled_at) : ''}`), chip(m.status)),
      side('a'), side('b'), opts.footer ? opts.footer : null);
  }
  function courtCard(ct, opts = {}) {
    const act = opts.actions;
    return h('section', { class: 'card court', 'aria-label': ct.name },
      h('div', { class: 'row between' }, h('h3', {}, ct.name), chip(ct.state)),
      ct.note ? h('p', { class: 'warn small' }, ct.note) : null,
      ct.current ? [h('div', { class: 'small muted' }, 'Now playing'), matchCard(ct.current, { footer: act ? act(ct.current, ct, 'current') : null })] : h('p', { class: 'muted' }, ct.state === 'maintenance' ? 'Court unavailable.' : 'No match in progress.'),
      ct.next ? [h('div', { class: 'small muted' }, `Next up${ct.next.scheduled_at ? ' · ' + fmtTime(ct.next.scheduled_at) : ''}`), matchCard(ct.next, { footer: act ? act(ct.next, ct, 'next') : null })] : h('p', { class: 'muted small' }, 'No upcoming match scheduled.'),
      ct.queue.length > 1 ? h('div', { class: 'q' }, h('strong', {}, 'Queue'), h('ul', { class: 'plain' }, ct.queue.slice(1).map(q => h('li', {}, `${fmtTime(q.scheduled_at)} · ${q.a ? q.a.name : 'TBD'} vs ${q.b ? q.b.name : 'TBD'} `, h('span', { class: 'muted small' }, `(${q.category_name}, ${q.label})`), act ? act(q, ct, 'queue') : null)))) : null,
      opts.footer ? opts.footer(ct) : null);
  }
  Object.assign(App, { matchCard, courtCard });

  // ---------- router / nav ----------
  const PUBLIC_NAV = [['', 'Home'], ['live', 'Live'], ['courts', 'Courts'], ['fixtures', 'Fixtures'], ['brackets', 'Brackets'], ['results', 'Results'], ['players', 'Players'], ['news', 'News'], ['rules', 'Rules']];
  function buildNav() {
    const nav = $('#nav'), staff = App.me && App.me.perms && (App.me.perms.includes('*') || App.me.perms.includes('panel'));
    const items = h('div', {}, PUBLIC_NAV.map(([p, l]) => h('a', { href: `#/${p}`, 'data-p': p }, l)), h('span', { class: 'right' }),
      staff ? h('a', { href: '#/admin', 'data-p': 'admin' }, 'Staff console') : null,
      App.me ? h('button', { class: 'sm', onclick: async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); App.me = null; buildNav(); location.hash = '#/'; toast('Signed out'); } }, `Sign out (${App.me.username})`)
        : [h('a', { href: '#/register' }, 'Register to play'), h('a', { href: '#/login', 'data-p': 'login' }, 'Sign in')]);
    nav.replaceChildren(...Array.from(items.childNodes));
    markNav();
  }
  function markNav() { const seg = location.hash.split('/')[1] || ''; document.querySelectorAll('#nav a[data-p]').forEach(a => a.getAttribute('data-p') === seg ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')); }
  $('#menu').addEventListener('click', () => { const n = $('#nav'); const o = n.classList.toggle('open'); $('#menu').setAttribute('aria-expanded', o); });

  let renderToken = 0;
  async function render(soft) {
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean), name = parts[0] || 'home', page = App.pages[name === 'admin' ? 'admin' : name] || App.pages.notfound;
    const token = ++renderToken, main = $('#main');
    App.current = { name, parts, page }; markNav(); if (name !== 'admin') $('#subnav-wrap').replaceChildren(); $('#nav').classList.remove('open');
    if (!soft) { main.replaceChildren(spinner()); window.scrollTo(0, 0); }
    try {
      const node = await page.render(parts.slice(1), parts);
      if (token !== renderToken) return;
      const y = window.scrollY; main.replaceChildren(node); if (soft) window.scrollTo(0, y); else main.focus({ preventScroll: true });
      document.title = `${page.title || 'Badminton'} - ${App.settings ? App.settings.tournament_name : 'Tournament'}`;
    } catch (e) { if (token !== renderToken) return; if (e.status === 401 || e.status === 403) { main.replaceChildren(h('div', { class: 'card' }, h('h1', {}, e.status === 401 ? 'Please sign in' : 'Not allowed'), h('p', {}, e.message), e.status === 401 ? h('a', { class: 'btn primary', href: '#/login' }, 'Sign in') : null)); } else main.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Something went wrong'), h('p', { class: 'err' }, e.message), h('button', { onclick: () => render() }, 'Try again'))); }
  }
  App.render = render;
  let timer; const softRefresh = () => { clearTimeout(timer); timer = setTimeout(() => { const p = App.current && App.current.page, c = App.current; const safe = c && (c.name !== 'admin' || [undefined, 'courts', 'matches', 'score'].includes(c.parts[1])); if (p && p.live && safe && !document.querySelector('dialog[open]') && !document.activeElement?.closest('input,select,textarea')) render(true); }, 350); };
  function connect() {
    let es; try { es = new EventSource('/api/events'); } catch { return; }
    es.onopen = () => { $('#conn').textContent = 'Live updates on'; }; es.onmessage = softRefresh;
    es.onerror = () => { $('#conn').textContent = 'Live updates reconnecting - refreshing every 15s'; };
  }
  setInterval(() => { if ($('#conn').textContent.includes('reconnecting')) softRefresh(); }, 15000);
  window.addEventListener('hashchange', () => render());

  App.start = async () => {
    try { App.me = (await api('GET', '/api/auth/me')).user; } catch {}
    try { App.settings = (await api('GET', '/api/public/overview')).settings; $('#brand').textContent = App.settings.tournament_name; } catch {}
    buildNav(); connect(); render();
  };
  App.buildNav = buildNav;

  // ---------- public pages ----------
  const P = (name, title, render, live) => { App.pages[name] = { title, render, live }; };
  const rulesLine = r => `Best of ${r.games_to_win * 2 - 1} games · first to ${r.points_to_win} · win by ${r.win_by}${r.cap ? ' · cap at ' + r.cap : ''}`;

  P('notfound', 'Not found', () => h('div', { class: 'card' }, h('h1', {}, 'Page not found'), h('a', { href: '#/' }, 'Back to home')));
  P('home', 'Home', async () => {
    const [o, c] = await Promise.all([api('GET', '/api/public/overview'), api('GET', '/api/public/courts')]); App.settings = o.settings; const s = o.settings;
    return h('div', { class: 'stack' },
      h('div', { class: 'hero' }, h('h1', {}, s.tournament_name), h('p', {}, [s.college_name, s.venue, s.event_date].filter(Boolean).join(' · ') || 'Welcome'), h('p', {}, rulesLine(s.rules)),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/live' }, 'Live scores'), s.registration_open ? h('a', { class: 'btn', href: '#/register' }, 'Register to play') : h('span', {}, 'Registration closed'))),
      h('div', { class: 'grid g4' }, [['Live now', o.counts.live], ['Matches completed', o.counts.completed], ['Players', o.counts.players], ['Categories', o.categories.length]].map(([l, v]) => h('div', { class: 'card stat' }, h('b', {}, v), h('span', {}, l)))),
      h('h2', {}, 'Courts'), h('div', { class: 'grid g3' }, c.courts.map(ct => courtCard(ct))),
      o.latest.length ? [h('h2', {}, 'Latest announcements'), h('div', { class: 'stack' }, o.latest.map(a => h('div', { class: 'card' }, h('strong', {}, a.title), a.kind === 'schedule' ? [' ', chip('upcoming', 'Schedule change')] : null, h('p', {}, a.body), h('span', { class: 'small muted' }, fmtDT(a.created_at)))))] : null);
  }, true);
  const catSelect = (cats, key, label = 'Category') => h('div', {}, h('label', { for: 'f-' + key }, label), h('select', { id: 'f-' + key, onchange: e => { App.filters[key] = e.target.value; render(); } }, h('option', { value: '' }, 'All'), cats.map(c => h('option', { value: c.id, selected: String(App.filters[key]) === String(c.id) }, c.name))));
  P('live', 'Live scores', async () => {
    const f = App.filters, q = k => (f[k] ? `&${k}=${f[k]}` : '');
    const [o, c, live, done] = await Promise.all([api('GET', '/api/public/overview'), api('GET', '/api/public/courts'), api('GET', `/api/public/matches?status=live${q('category')}${q('court')}`), api('GET', `/api/public/matches?status=done${q('category')}${q('court')}`)]);
    const upcoming = c.courts.flatMap(ct => ct.next ? [ct.next] : []).filter(m => (!f.category || String(m.category_id) === String(f.category)) && (!f.court || String(m.court_id) === String(f.court)));
    return h('div', {}, h('h1', {}, 'Live scores'), h('div', { class: 'row' }, catSelect(o.categories, 'category'), catSelect(c.courts, 'court', 'Court')),
      h('h2', {}, 'In progress'), live.matches.length ? h('div', { class: 'grid g3' }, live.matches.map(m => matchCard(m))) : empty('No matches are being played right now.'),
      h('h2', {}, 'Up next'), upcoming.length ? h('div', { class: 'grid g3' }, upcoming.map(m => matchCard(m))) : empty('No upcoming matches scheduled on the courts.'),
      h('h2', {}, 'Latest results'), done.matches.length ? h('div', { class: 'grid g3' }, done.matches.slice().sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || '')).slice(0, 9).map(m => matchCard(m))) : empty('No results yet.'));
  }, true);
  P('courts', 'Court schedule', async () => { const c = await api('GET', '/api/public/courts'); return h('div', {}, h('h1', {}, 'Court schedule'), h('div', { class: 'grid g3' }, c.courts.map(ct => courtCard(ct))), h('p', {}, h('a', { href: '/print/schedule', target: '_blank', rel: 'noopener' }, 'Printable court schedule'))); }, true);
  P('fixtures', 'Fixtures', async () => {
    const f = App.filters; const [o, m] = await Promise.all([api('GET', '/api/public/overview'), api('GET', `/api/public/matches?${f.category ? 'category=' + f.category : ''}${f.fstatus ? '&status=' + f.fstatus : ''}`)]);
    return h('div', {}, h('h1', {}, 'Fixtures and schedule'), h('div', { class: 'row' }, catSelect(o.categories, 'category'),
      h('div', {}, h('label', { for: 'f-s' }, 'Show'), h('select', { id: 'f-s', onchange: e => { App.filters.fstatus = e.target.value; render(); } }, [['', 'All'], ['upcoming', 'Upcoming'], ['live', 'Live'], ['done', 'Completed']].map(([v, l]) => h('option', { value: v, selected: f.fstatus === v }, l)))),
      h('a', { class: 'btn', href: '/print/fixtures', target: '_blank', rel: 'noopener' }, 'Print')),
      h('br'), App.table([{ h: 'Category', f: r => r.category_name }, { h: 'Round', f: r => r.label }, { h: 'Side A', f: r => r.a ? r.a.name : 'TBD' }, { h: 'Side B', f: r => r.b ? r.b.name : 'TBD' }, { h: 'Court', f: r => r.court_name || '-' },
        { h: 'Time', f: r => fmtDT(r.scheduled_at) || '-' }, { h: 'Status', f: r => chip(r.status) }, { h: 'Score', f: r => r.final_score || (r.games.length ? r.games.map(g => `${g.a}-${g.b}`).join(', ') : '') }], m.matches, 'No fixtures have been published yet.'));
  }, true);
  const bracketView = cat => {
    const ms = cat.matches.filter(m => m.status !== 'bye');
    if (cat.format === 'roundrobin') return h('div', { class: 'stack' }, standingsTable(cat), h('div', { class: 'grid g3' }, ms.map(m => matchCard(m))));
    const rounds = [...new Set(ms.map(m => m.round))].sort((a, b) => a - b), maxRound = Math.max(...rounds, 1);
    return h('div', { class: 'bracket', role: 'group', 'aria-label': cat.name + ' bracket' }, rounds.map(r => h('div', { class: 'round' }, h('h4', {}, ms.find(m => m.round === r && m.group_no === 0).label.replace(/ place$/, '')),
      ms.filter(m => m.round === r).sort((a, b) => a.number - b.number).map(m => matchCard(m)))));
  };
  const standingsTable = cat => { const rows = cat.standings.map((s, i, a) => ({ ...s, pos: a.filter(x => x.group_no === s.group_no).indexOf(s) + 1 })); return App.table([{ h: 'Group', f: r => String.fromCharCode(64 + r.group_no) }, { h: '#', f: r => r.pos }, { h: 'Team', f: r => r.name }, { h: 'P', f: r => r.played }, { h: 'W', f: r => r.won }, { h: 'L', f: r => r.lost }, { h: 'Games', f: r => `${r.games_for}-${r.games_against}` }, { h: 'Points', f: r => `${r.points_for}-${r.points_against}` }], rows); };
  P('brackets', 'Brackets', async () => {
    const b = await api('GET', '/api/public/brackets'); App.bracketView = bracketView;
    return h('div', {}, h('h1', {}, 'Tournament brackets'), b.categories.length ? b.categories.filter(c => c.matches.length).map(c => h('section', {}, h('h2', {}, c.name), bracketView(c))) : empty('Brackets will appear when fixtures are published.'));
  }, true);
  P('results', 'Results', async () => {
    const r = await api('GET', '/api/public/results');
    return h('div', {}, h('h1', {}, 'Results'), h('h2', {}, 'Category champions'),
      App.table([{ h: 'Category', f: x => x.name }, { h: 'Champion', f: x => x.champion ? h('strong', {}, '🏆 ' + x.champion) : h('span', { class: 'muted' }, 'In progress') }, { h: 'Runner-up', f: x => x.runner_up || '' }, { h: 'Third place', f: x => x.third || '' }, { h: 'Matches', f: x => `${x.finished}/${x.total}` }], r.categories, 'No categories published yet.'),
      h('h2', {}, 'Completed matches'), r.matches.length ? h('div', { class: 'grid g3' }, r.matches.map(m => matchCard(m))) : empty('No completed matches yet.'), h('p', {}, h('a', { href: '/print/results', target: '_blank', rel: 'noopener' }, 'Printable results')));
  }, true);
  P('players', 'Players', async () => { const p = await api('GET', '/api/public/players'); return h('div', {}, h('h1', {}, 'Approved players and teams'), p.categories.length ? p.categories.map(c => h('section', {}, h('h2', {}, c.name), c.teams.length ? h('ul', { class: 'grid g3 plain' }, c.teams.map(t => h('li', { class: 'card' }, t.name))) : h('p', { class: 'muted' }, 'No approved entries yet.'))) : empty('No categories published yet.')); });
  P('news', 'Announcements', async () => { const a = await api('GET', '/api/public/announcements'); return h('div', {}, h('h1', {}, 'Announcements and schedule changes'), a.announcements.length ? h('div', { class: 'stack' }, a.announcements.map(x => h('article', { class: 'card' }, h('h3', {}, x.title, ' ', x.kind === 'schedule' ? chip('upcoming', 'Schedule change') : null), h('p', {}, x.body), h('span', { class: 'small muted' }, fmtDT(x.created_at))))) : empty('No announcements yet.')); }, true);
  P('rules', 'Rules', async () => { const s = (await api('GET', '/api/public/overview')).settings; return h('div', { class: 'card stack' }, h('h1', {}, 'Tournament rules'), h('p', {}, h('strong', {}, 'Match format: '), rulesLine(s.rules)), h('p', {}, `Players are called to the court desk before their match. Grace period for absent players: ${s.grace_minutes} minutes.`), h('div', { style: null }, s.rules_text.split('\n').map(l => h('p', {}, l)))); });

  P('register', 'Register', async () => {
    const o = await api('GET', '/api/public/categories-open');
    if (!o.open) return h('div', { class: 'card' }, h('h1', {}, 'Registration is closed'), h('p', {}, 'Please contact the organisers.'));
    const partner = h('fieldset', { class: 'card', hidden: true }, h('legend', {}, 'Doubles partner'), person('p_'));
    function person(pre) { return h('div', {}, App.field('Full name', h('input', { name: pre + 'name', required: true, maxlength: 80, autocomplete: pre ? 'off' : 'name' })), App.field('Gender', h('select', { name: pre + 'gender', required: true }, h('option', { value: '' }, 'Select'), h('option', { value: 'male' }, 'Male'), h('option', { value: 'female' }, 'Female'), h('option', { value: 'other' }, 'Other'))),
      App.field('College ID', h('input', { name: pre + 'college_id', required: true, maxlength: 40 }), 'Checked again on event day.'), App.field('Course / year', h('input', { name: pre + 'course_year', maxlength: 40 })), App.field('Contact number', h('input', { name: pre + 'contact', maxlength: 60, type: 'tel' }), 'Only visible to organisers.')); }
    const boxes = o.categories.map(c => h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'cat', value: c.id, 'data-kind': c.kind, onchange: sync }), `${c.name} (${c.kind})`));
    function sync() { partner.hidden = !form.querySelector('input[data-kind=doubles]:checked'); partner.querySelectorAll('input,select').forEach(i => { if (['p_name', 'p_gender', 'p_college_id'].includes(i.name)) i.required = !partner.hidden; }); }
    const msg = h('p', { role: 'status' });
    const form = h('form', { class: 'form stack', onsubmit: async e => {
      e.preventDefault(); const d = App.fd(form), cats = [...form.querySelectorAll('input[name=cat]:checked')].map(i => Number(i.value));
      if (!cats.length) { msg.textContent = 'Choose at least one category.'; msg.className = 'err'; return; }
      const pick = pre => ({ name: d[pre + 'name'], gender: d[pre + 'gender'], college_id: d[pre + 'college_id'], course_year: d[pre + 'course_year'], contact: d[pre + 'contact'] });
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true; msg.textContent = '';
      try { await api('POST', '/api/public/register', { player: pick(''), partner: partner.hidden ? undefined : pick('p_'), category_ids: cats }); form.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Registration received'), h('p', {}, 'Your entry is pending approval by the organisers. Bring your college ID on event day.'))); }
      catch (er) { msg.textContent = er.message; msg.className = 'err'; btn.disabled = false; }
    } }, h('h1', {}, 'Register to play'), person(''), h('fieldset', { class: 'card' }, h('legend', {}, 'Categories'), boxes), partner, msg, h('button', { class: 'primary', type: 'submit' }, 'Submit registration'));
    return form;
  });
  P('login', 'Sign in', () => {
    const msg = h('p', { class: 'err', role: 'alert' });
    return h('form', { class: 'form card', onsubmit: async e => { e.preventDefault(); const d = App.fd(e.target); try { const r = await api('POST', '/api/auth/login', d); App.me = (await api('GET', '/api/auth/me')).user; buildNav(); location.hash = ['admin', 'scorer', 'staff'].includes(r.user.role) ? '#/admin' : '#/'; toast('Signed in'); } catch (er) { msg.textContent = er.message; } } },
      h('h1', {}, 'Sign in'), App.field('Username or email', h('input', { name: 'username', required: true, autocomplete: 'username' })), App.field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })), msg,
      h('button', { class: 'primary', type: 'submit' }, 'Sign in'), h('p', { class: 'small' }, App.settings && App.settings.allow_viewer_signup ? h('a', { href: '#/signup' }, 'Create a viewer account') : null));
  });
  P('signup', 'Create account', () => {
    const msg = h('p', { class: 'err', role: 'alert' });
    return h('form', { class: 'form card', onsubmit: async e => { e.preventDefault(); try { await api('POST', '/api/auth/register', App.fd(e.target)); toast('Account created. Please sign in.'); location.hash = '#/login'; } catch (er) { msg.textContent = er.message; } } },
      h('h1', {}, 'Create a viewer account'), h('p', { class: 'muted' }, 'Viewer accounts can sign in but cannot change any tournament data.'), App.field('Username', h('input', { name: 'username', required: true, minlength: 3, maxlength: 32, autocomplete: 'username' })),
      App.field('Email (optional)', h('input', { name: 'email', type: 'email', autocomplete: 'email' })), App.field('Password', h('input', { name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), 'At least 10 characters.'), msg, h('button', { class: 'primary', type: 'submit' }, 'Create account'));
  });
})();
