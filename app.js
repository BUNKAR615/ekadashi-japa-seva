/* ============================================================
   Ekadashi Japa Seva — Hare Krishna Marwad Mandir

   All data access goes through window.JapaStore (see store.js), which
   talks to the temple's Supabase database. Rounds are written there and
   read back from there — never kept only in this browser.
   ============================================================ */
(function () {
  'use strict';

  const MAX_ROUNDS = 216;
  const NAMES_PER_ROUND = 108;

  let store = null;

  const data = {
    user: null, events: [],
    event: null,                 // the one current challenge (active, else last closed)
    mine: 0,
    myUpdatedAt: null,           // when this devotee last revised their count
    totals: { total: 0, participants: 0, average: 0, highest: 0, capacity: 0 },
    leaders: [], activeLeaders: [], devotees: [], history: [],
    loadError: null              // set when the database could not be read
  };

  const ui = {
    tab: 'japa', adminSection: 'overview',
    sheet: null, draft: '', capped: false,
    query: '', editEventId: null,
    toastTimer: null, busy: false
  };

  /* ---------- Helpers ---------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const fmt = n => Number(n || 0).toLocaleString('en-IN');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDateShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
  }
  const fmtStamp = iso => iso ? `${fmtDateShort(iso)}, ${fmtTime(iso)}` : '';

  const sameDay = e => e && new Date(e.start_at).toDateString() === new Date(e.end_at).toDateString();

  // The full challenge window, written the shortest way that stays clear.
  const dateRange = e => !e ? '' : (sameDay(e)
    ? `${fmtDateShort(e.start_at)}, ${fmtTime(e.start_at)} – ${fmtTime(e.end_at)}`
    : `${fmtStamp(e.start_at)} – ${fmtStamp(e.end_at)}`);

  // A challenge is only open between its start and end moments.
  function windowState(e) {
    if (!e) return 'none';
    if (e.status === 'draft') return 'draft';
    if (e.status === 'closed') return 'ended';
    const now = Date.now();
    if (now < new Date(e.start_at).getTime()) return 'notStarted';
    if (now > new Date(e.end_at).getTime()) return 'ended';
    return e.status === 'active' ? 'open' : 'notStarted';
  }
  const isOpen = e => windowState(e) === 'open';

  // "in 2 days", "in 3 hours", "in 14 minutes"
  function untilText(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'now';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
    return `in ${Math.round(hrs / 24)} days`;
  }

  const activeEvent  = () => data.events.find(e => e.status === 'active');
  const nextUpcoming = () => data.events.filter(e => e.status === 'upcoming')
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)))[0];
  const lastClosed   = () => data.events.filter(e => e.status === 'closed')
    .sort((a, b) => String(b.start_at).localeCompare(String(a.start_at)))[0];

  const isAdmin = () => !!(data.user && data.user.isAdmin);

  // Ranked by total rounds offered within the challenge window.
  function rankSorted(rows) {
    return rows.slice().sort((a, b) => b.total - a.total);
  }

  /* ---------- Loading ---------- */

  async function refresh() {
    data.events = await store.listEvents();
    const ev = activeEvent() || lastClosed() || null;
    data.event = ev;

    if (ev) {
      const [entry, totals] = await Promise.all([
        store.myEntry(ev.id),
        store.eventTotals(ev.id)
      ]);
      data.mine = entry ? entry.rounds : 0;
      data.myUpdatedAt = entry ? entry.updatedAt : null;
      data.totals = totals;
    } else {
      data.mine = 0;
      data.myUpdatedAt = null;
      data.totals = { total: 0, participants: 0, average: 0, highest: 0, capacity: 0 };
    }

    if (ev) {
      const hidden = ev.visibility === 'off' || (ev.visibility === 'admin' && !isAdmin());
      data.leaders = hidden ? [] : await store.leaderboard(ev.id);
    } else {
      data.leaders = [];
    }

    // Admin overview still ranks the challenge even when the public
    // leaderboard is hidden or off.
    if (isAdmin() && ev) {
      data.activeLeaders = data.leaders.length ? data.leaders : await store.leaderboard(ev.id);
    } else {
      data.activeLeaders = [];
    }

    data.history = await store.myHistory();

    if (isAdmin() && ui.tab === 'admin' && ui.adminSection === 'devotees') {
      try { data.devotees = await store.devotees(ev ? ev.id : null); }
      catch (e) { data.devotees = []; }
    }
  }

  async function reload() {
    if (ui.busy) return;
    ui.busy = true;
    try {
      await refresh();
      data.loadError = null;
      render();
    } catch (e) {
      console.error(e);
      const msg = e.message || 'Something went wrong. Please try again.';
      // With nothing on screen yet, a toast would vanish and leave an
      // empty app that looks like "no challenge". Show the reason and
      // a way to retry instead.
      if (!data.event) { data.loadError = msg; render(); }
      else { showError(msg); }
    } finally {
      ui.busy = false;
    }
  }

  // Retry after a failed load, with the spinner while it runs.
  async function retryLoad() {
    data.loadError = null;
    $('#loading').classList.remove('hidden');
    try { await reload(); }
    finally { $('#loading').classList.add('hidden'); }
  }

  /* ---------- Auth ---------- */

  let authMode = 'signin';

  function initAuth() {
    const form = $('#auth-form');
    const toggle = $('#auth-toggle');

    toggle.addEventListener('click', ev => {
      ev.preventDefault();
      authMode = authMode === 'signin' ? 'create' : 'signin';
      const create = authMode === 'create';
      $('#auth-name-block').classList.toggle('hidden', !create);
      $('#auth-submit').textContent = create ? 'Create Account' : 'Sign In';
      $('#auth-switch').firstChild.textContent = create ? 'Already registered? ' : 'New here? ';
      toggle.textContent = create ? 'Sign In' : 'Create Account';
      hideAuthMsg();
    });

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const email = $('#auth-email').value.trim();
      const pass = $('#auth-pass').value;
      const name = $('#auth-name').value.trim();
      const btn = $('#auth-submit');

      if (!email || !pass) return authMsg('Please enter your email and password.');
      if (authMode === 'create' && !name) return authMsg('Please enter your full name.');

      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Please wait…';
      hideAuthMsg();

      try {
        if (authMode === 'create') {
          const res = await store.signUp(email, pass, name);
          if (res.needsConfirmation) {
            authMsg('Account created. Please check your email for a confirmation link, then sign in.', 'ok');
            return;
          }
          data.user = res.user;
        } else {
          data.user = await store.signIn(email, pass);
        }
        await enterApp();
      } catch (err) {
        authMsg(err.message || 'Could not sign in. Please try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }

  function authMsg(text, kind) {
    const el = $('#auth-error');
    el.textContent = text;
    el.style.color = kind === 'ok' ? '#2F7D45' : '';
    el.classList.remove('hidden');
  }
  function hideAuthMsg() { $('#auth-error').classList.add('hidden'); }

  async function enterApp() {
    $('#loading').classList.remove('hidden');
    data.loadError = null;
    try {
      await refresh();
    } catch (e) {
      // A failed first load used to be swallowed, which showed an empty
      // app as though the temple simply had no challenge running.
      console.error(e);
      data.loadError = e.message || 'Could not load the temple database. Please try again.';
    }
    $('#welcome').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#loading').classList.add('hidden');
    ui.tab = 'japa';
    ui.adminSection = 'overview';
    render();
  }

  async function signOut() {
    await store.signOut();
    data.user = null;
    ui.tab = 'japa';
    ui.adminSection = 'overview';
    closeOverlay();
    $('#app').classList.add('hidden');
    $('#welcome').classList.remove('hidden');
    $('#auth-pass').value = '';
  }

  /* ---------- Render ---------- */

  function render() {
    renderHeader();
    renderTabs();
    renderContent();
  }

  function renderHeader() {
    // Admins keep every devotee ability and gain the Admin tab; the badge
    // is informational, not a mode switch.
    const badge = $('#role-badge');
    badge.classList.toggle('hidden', !isAdmin());
  }

  const DEV_TABS = [
    { key: 'japa', label: 'Japa' },
    { key: 'together', label: 'Leaderboard' },
    { key: 'me', label: 'Me' }
  ];
  const ADM_TABS = [
    { key: 'japa', label: 'Japa' },
    { key: 'together', label: 'Leaderboard' },
    { key: 'admin', label: 'Admin' },
    { key: 'me', label: 'Me' }
  ];

  function renderTabs() {
    const tabs = isAdmin() ? ADM_TABS : DEV_TABS;
    $('#tabbar').innerHTML = tabs.map(t => `
      <button type="button" class="tab-btn${ui.tab === t.key ? ' on' : ''}" data-tab="${t.key}">
        <span class="dot"></span><span class="lbl">${t.label}</span>
      </button>`).join('');
  }

  function viewLoadError() {
    return `<div class="pad">
      <div class="card no-event-card">
        <p class="big">Could not load from the temple database</p>
        <p class="small">${esc(data.loadError)}</p>
        <button type="button" class="btn-primary" data-action="retry-load">Try again</button>
      </div>
      ${quoteCard()}${mantraBlock()}
    </div>`;
  }

  function renderContent() {
    const c = $('#content');
    if (data.loadError) { c.innerHTML = viewLoadError(); c.scrollTop = 0; return; }
    switch (ui.tab) {
      case 'japa':      c.innerHTML = viewJapa(); break;
      case 'together':  c.innerHTML = viewTogether(); break;
      case 'me':        c.innerHTML = viewMe(); break;
      case 'admin':     c.innerHTML = viewAdmin(); break;
      default:          c.innerHTML = viewJapa();
    }
    c.scrollTop = 0;
    const search = $('#devotee-search');
    if (search) {
      search.value = ui.query;
      search.addEventListener('input', e => {
        ui.query = e.target.value;
        renderDevoteeList();
      });
    }
  }

  /* ----- Japa ----- */

  function viewJapa() {
    const ev = data.event;

    if (!ev) {
      const next = nextUpcoming();
      return `<div class="pad">
        <div class="card no-event-card">
          <p class="big">No active Japa challenge</p>
          <p class="small">${next
            ? `The next challenge opens ${esc(fmtStamp(next.start_at))}. Your rounds can be offered then.`
            : 'A new Japa challenge will be announced soon.'}</p>
        </div>
        ${quoteCard()}${mantraBlock()}
      </div>`;
    }

    const state = windowState(ev);
    const open = state === 'open';
    const ended = state === 'ended';
    const notStarted = state === 'notStarted' || state === 'draft';
    const rounds = data.mine;
    const t = data.totals;
    const pct = ev.goal_rounds ? Math.round((t.total / ev.goal_rounds) * 100) : 0;
    const barPct = Math.min(100, pct);

    return `<div class="pad">
      <div class="card event-card">
        <div class="event-top">
          <span class="eyebrow">${esc(dateRange(ev))}</span>
          <span class="chip ${ended ? 'closed' : open ? 'active' : 'upcoming'}">${
            ended ? 'Completed' : open ? 'Open' : 'Not started'}</span>
        </div>
        ${ended ? '<div class="completed-banner">Challenge completed</div>' : ''}
        <h2 class="event-title">${esc(ev.name)}</h2>
        <div class="rounds-head">
          <span class="rounds-label">Your rounds</span>
          ${rounds > 0 && open
            ? '<button type="button" class="edit-link" data-action="edit-rounds">Edit</button>'
            : ''}
        </div>
        <div class="rounds-num">${rounds}</div>
        <div class="rounds-caption">${rounds === 0
          ? 'Not recorded yet'
          : `${fmt(rounds * NAMES_PER_ROUND)} holy names${
              data.myUpdatedAt ? ` · saved ${esc(fmtTime(data.myUpdatedAt))}` : ''}`}</div>
        <button type="button" class="cta ${open ? 'live' : 'dead'}" data-action="open-sheet">
          ${ended ? 'Challenge completed' : notStarted ? 'Not started yet' : (rounds === 0 ? 'Record my rounds' : 'Edit my rounds')}
        </button>
        <div class="cta-hint">${
          ended ? `Ended ${esc(fmtStamp(ev.end_at))}`
          : notStarted ? `Opens ${esc(fmtStamp(ev.start_at))} · ${esc(untilText(ev.start_at))}`
          : `Open until ${esc(fmtStamp(ev.end_at))} · closes ${esc(untilText(ev.end_at))}`}</div>
      </div>

      <div class="card together-card">
        <div class="together-top">
          <span class="eyebrow">Together</span>
          <a href="#" data-action="goto-together">See all</a>
        </div>
        <div class="group-row">
          <div class="group-num">${fmt(t.total)}</div>
          <div class="group-unit">rounds</div>
          <div class="pct-big${pct >= 100 ? ' done' : ''}">${pct}%</div>
        </div>
        <div class="participants-line">${t.capacity
          ? `${fmt(t.capacity)} devotee${t.capacity === 1 ? '' : 's'} registered · ${fmt(t.participants)} submitted`
          : `${fmt(t.participants)} devotee${t.participants === 1 ? '' : 's'} submitted`}</div>
        <div class="progress-track"><div class="progress-fill${pct >= 100 ? ' done' : ''}" style="width:${barPct}%"></div></div>
        <div class="progress-meta"><span>${pct}% of the goal completed</span><span>${fmt(ev.goal_rounds)} goal</span></div>
      </div>

      ${quoteCard()}${mantraBlock()}
    </div>`;
  }

  function quoteCard() {
    return `<div class="card quote-card">
      <div class="portrait"><img src="assets/prabhupada-circle.png" alt="Srila Prabhupada"></div>
      <div>
        <p>“Chant Hare Krishna and be happy.”</p>
        <div class="attrib">Srila Prabhupada</div>
      </div>
    </div>`;
  }

  function mantraBlock() {
    return `<div class="mantra-block">
      <p class="mantra-dev">हरे कृष्ण हरे कृष्ण कृष्ण कृष्ण हरे हरे<br>हरे राम हरे राम राम राम हरे हरे</p>
      <p class="mantra-lat">HARE KRISHNA HARE KRISHNA KRISHNA KRISHNA HARE HARE<br>HARE RAMA HARE RAMA RAMA RAMA HARE HARE</p>
    </div>`;
  }

  /* ----- Together ----- */

  function viewTogether() {
    const ev = data.event;
    if (!ev) {
      return `<div class="pad-lg">
        <h2 class="h2">Leaderboard</h2>
        <p class="sub">No challenge yet — the leaderboard will appear here.</p>
      </div>`;
    }
    const t = data.totals;
    const people = rankSorted(data.leaders);
    const off = ev.visibility === 'off';
    const privated = ev.visibility === 'admin' && !isAdmin();

    const closed = windowState(ev) === 'ended';
    const pct = ev.goal_rounds ? Math.round((t.total / ev.goal_rounds) * 100) : 0;
    const barPct = Math.min(100, pct);

    const stats = [
      { label: 'Total rounds', value: fmt(t.total) },
      { label: 'Participants', value: fmt(t.participants) },
      { label: 'Average', value: String(t.average) },
      { label: 'Highest', value: fmt(t.highest) }
    ];

    const progress = `<div class="card progress-card">
      ${closed ? '<div class="completed-banner">Challenge completed</div>' : ''}
      <div class="pct-row">
        <div class="pct-huge${pct >= 100 ? ' done' : ''}">${pct}%</div>
        <div class="pct-side">
          <div class="pct-label">of the goal completed</div>
          <div class="pct-sub">${fmt(t.total)} of ${fmt(ev.goal_rounds)} rounds</div>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill${pct >= 100 ? ' done' : ''}" style="width:${barPct}%"></div></div>
    </div>`;

    let board;
    if (off) {
      board = `<div class="private-card">
        <p class="big">The leaderboard is turned off</p>
        <p class="small">The temple has disabled the leaderboard for this challenge. The totals above are everyone’s offering together.</p>
      </div>`;
    } else if (privated) {
      board = `<div class="private-card">
        <p class="big">Individual rounds are private for this challenge</p>
        <p class="small">Only temple admins can see each devotee’s submission. The totals above are everyone’s offering together.</p>
      </div>`;
    } else if (people.length === 0) {
      board = `<div class="private-card">
        <p class="big">No rounds recorded yet</p>
        <p class="small">Be the first to offer your chanting.</p></div>`;
    } else {
      // Only the devotee's own row offers Edit, and only while the
      // window is open. The database enforces the same rule.
      const canEdit = isOpen(ev);
      board = `<div class="list-card">
        ${people.map((p, i) => `
          <div class="board-row${p.me ? ' me' : ''}">
            <div class="rank">${i + 1}</div>
            <div class="who">
              <div class="nm">${esc(ev.visibility === 'ids' ? p.devoteeId : p.name)}</div>
              <div class="sb">${ev.visibility === 'ids'
                ? (p.me ? 'You' : 'Devotee')
                : (p.me ? 'You · ' + esc(p.devoteeId) : esc(p.devoteeId))}</div>
            </div>
            <div class="cnt">${p.total}</div>
            ${p.me && canEdit
              ? '<button type="button" class="edit-link row" data-action="edit-rounds">Edit</button>'
              : ''}
          </div>`).join('')}
      </div>
      <p class="board-note">Not a competition — a shared offering.<br>${
        ev.visibility === 'ids' ? 'Shown by Devotee ID, ranked by total rounds.' : 'Ranked by total rounds.'}</p>`;
    }

    return `<div class="pad-lg">
      <h2 class="h2">Leaderboard</h2>
      <p class="sub">${esc(ev.name)}<br>${esc(dateRange(ev))}</p>
      ${progress}
      <div class="stat-grid" style="margin-top:12px">
        ${stats.map(s => `<div class="stat-tile"><div class="lbl">${s.label}</div><div class="val">${s.value}</div></div>`).join('')}
      </div>
      ${board}
    </div>`;
  }

  /* ----- Me ----- */

  function viewMe() {
    const u = data.user || {};
    const items = data.history;
    const total = items.reduce((s, h) => s + h.rounds, 0);
    const active = activeEvent();
    const journey = items.length === 0 ? '' : `
      <div>
        <div class="eyebrow" style="display:block;margin:4px 0 8px 4px">My journey</div>
        <div class="list-card">
          ${items.map(h => {
            const isToday = active && h.eventId === active.id;
            const canEdit = isToday && isOpen(active);
            return `<div class="tl-row">
              <div class="who">
                <div class="tl-date">${esc(fmtDateShort(h.date))}</div>
                <div class="tl-title">${esc(h.name)}</div>
                <div class="tl-note">${isToday ? 'In progress · updated at ' + esc(h.time) : 'Recorded at ' + esc(h.time)}</div>
                ${canEdit ? '<button type="button" class="edit-link tl" data-action="edit-rounds">Edit rounds</button>' : ''}
              </div>
              <div style="flex:none">
                <div class="tl-rounds">${h.rounds}</div>
                <div class="tl-unit">rounds</div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    const rows = [
      { label: 'Devotee ID', value: u.devoteeId || '—' },
      { label: 'Email', value: u.email || '—' },
      { label: 'Group', value: u.group || '—' },
      { label: 'Role', value: u.isAdmin ? 'Admin' : 'User' }
    ];
    return `<div class="pad">
      <div class="card profile-card">
        <div class="avatar">${esc((u.name || 'D')[0])}</div>
        <div class="profile-name">${esc(u.name)}</div>
        <div class="profile-id">${esc(u.devoteeId || '')}</div>
        <div class="profile-stats">
          <div class="profile-stat"><div class="n">${fmt(total)}</div><div class="l">Total rounds</div></div>
          <div class="profile-stat"><div class="n">${items.length}</div><div class="l">Challenges joined</div></div>
        </div>
      </div>

      ${journey}

      <div class="list-card">
        ${rows.map(r => `<div class="profile-row"><span class="l">${r.label}</span><span class="v">${esc(r.value)}</span></div>`).join('')}
      </div>

      <button type="button" class="btn-outline" data-action="sign-out">Sign Out</button>
      <p class="me-footer">Chant Hare Krishna and Be Happy</p>
    </div>`;
  }

  /* ----- Admin hub ----- */

  const ADMIN_SECTIONS = [
    { key: 'overview',  label: 'Overview' },
    { key: 'events',    label: 'Challenges' },
    { key: 'devotees',  label: 'Devotees' }
  ];

  function viewAdmin() {
    if (!isAdmin()) return viewJapa();
    const seg = `<div class="segmented">
      ${ADMIN_SECTIONS.map(x => `<button type="button" class="seg${ui.adminSection === x.key ? ' on' : ''}" data-adminsec="${x.key}">${x.label}</button>`).join('')}
    </div>`;
    const body = ui.adminSection === 'events' ? viewAdminEvents()
      : ui.adminSection === 'devotees' ? viewAdminDevotees()
      : viewAdminOverview();
    return `<div class="admin-wrap">${seg}${body}</div>`;
  }

  /* ----- Admin: Overview ----- */

  function viewAdminOverview() {
    const ev = activeEvent();
    const t = data.totals;
    const pct = ev && t.capacity ? Math.round((t.participants / t.capacity) * 100) : 0;
    const top = ev ? rankSorted(data.activeLeaders).slice(0, 4) : [];

    const stats = ev ? [
      { label: 'Live challenge', value: ev.name.split(' ')[0], sub: dateRange(ev) },
      { label: 'Total devotees', value: fmt(t.capacity), sub: 'registered' },
      { label: 'Total rounds', value: fmt(t.total), sub: 'this challenge' },
      { label: 'Average rounds', value: String(t.average), sub: 'per participant' }
    ] : [
      { label: 'Live challenge', value: '—', sub: 'none live' },
      { label: 'Total devotees', value: fmt(t.capacity), sub: 'registered' },
      { label: 'Total rounds', value: '—', sub: 'no challenge' },
      { label: 'Average rounds', value: '—', sub: 'no challenge' }
    ];

    return `<div class="pad">
      <div class="card admin-head">
        <h2>Admin</h2>
        <div class="live-line">
          <span class="live-dot${ev && isOpen(ev) ? '' : ' off'}"></span>
          ${ev ? `${esc(ev.name)} · ${isOpen(ev) ? 'open until ' + esc(fmtStamp(ev.end_at)) : windowState(ev) === 'notStarted' ? 'opens ' + esc(fmtStamp(ev.start_at)) : 'window has ended'}` : 'No challenge is live right now'}
        </div>
      </div>

      <div class="stat-grid" style="margin-bottom:0">
        ${stats.map(s => `<div class="stat-tile"><div class="lbl">${s.label}</div><div class="val">${esc(s.value)}</div><div class="sub">${esc(s.sub)}</div></div>`).join('')}
      </div>

      <div class="panel">
        <span class="eyebrow">Participation</span>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="panel-meta">
          <span>${ev ? `${fmt(t.participants)} of ${fmt(t.capacity)} devotee${t.capacity === 1 ? '' : 's'} have submitted` : 'Waiting for the next challenge'}</span>
          <span>${ev ? pct + '%' : ''}</span>
        </div>
        <div class="btn-row">
          <button type="button" class="btn-fill" data-action="new-event">New Challenge</button>
          <button type="button" class="btn-line" data-action="export-csv">Export CSV</button>
        </div>
      </div>

      ${top.length ? `<div class="list-card">
        <div class="top-hd">Top offerings</div>
        ${top.map((p, i) => `
          <div class="top-row">
            <div class="rk">${i + 1}</div>
            <div class="who"><div class="nm">${esc(p.name)}</div><div class="sb">${esc(p.devoteeId)} · ${esc(p.time)}</div></div>
            <div class="n">${p.total}</div>
          </div>`).join('')}
      </div>` : ''}
    </div>`;
  }

  /* ----- Admin: Events ----- */

  function eventMeta(e) {
    const vis = e.visibility === 'names' ? 'names visible'
      : e.visibility === 'ids' ? 'devotee IDs'
      : e.visibility === 'admin' ? 'admin only' : 'leaderboard off';
    const st = windowState(e);
    if (e.status === 'draft') return 'Draft — not visible to devotees yet';
    if (st === 'open')       return `Open now, closes ${untilText(e.end_at)} · ${vis}`;
    if (st === 'notStarted') return `Opens ${untilText(e.start_at)} · ${vis}`;
    return `Ended · goal was ${fmt(e.goal_rounds)} rounds`;
  }
  function eventPrimary(e) {
    switch (e.status) {
      case 'active':   return { label: 'Close', action: 'close-event' };
      case 'upcoming': return { label: 'Publish now', action: 'activate-event' };
      case 'closed':   return { label: 'Reopen', action: 'reopen-event' };
      default:         return { label: 'Publish now', action: 'activate-event' };
    }
  }

  function viewAdminEvents() {
    const order = { active: 0, upcoming: 1, draft: 2, closed: 3 };
    const events = data.events.slice().sort((a, b) =>
      (order[a.status] - order[b.status]) || String(b.start_at).localeCompare(String(a.start_at)));
    return `<div class="pad-lg">
      <div class="admin-header-row">
        <h2 class="h2" style="margin:0">Challenges</h2>
        <button type="button" class="btn-new" data-action="new-event">+ New</button>
      </div>
      ${events.map(e => {
        const p = eventPrimary(e);
        return `<div class="event-item">
          <div class="top">
            <span class="dt">${esc(dateRange(e))}</span>
            <span class="chip ${e.status}">${e.status.charAt(0).toUpperCase() + e.status.slice(1)}</span>
          </div>
          <div class="nm">${esc(e.name)}</div>
          <div class="meta">${esc(eventMeta(e))}</div>
          <div class="event-actions">
            ${e.status === 'active'
              ? `<button type="button" class="primary" data-action="edit-event" data-id="${e.id}">Edit challenge</button>
                 <button type="button" data-action="${p.action}" data-id="${e.id}">${p.label}</button>`
              : `<button type="button" data-action="${p.action}" data-id="${e.id}">${p.label}</button>
                 <button type="button" data-action="edit-event" data-id="${e.id}">Edit</button>`}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  /* ----- Admin: Devotees ----- */

  function viewAdminDevotees() {
    return `<div class="pad-lg">
      <h2 class="h2" style="margin-bottom:12px">Devotees</h2>
      <input type="text" id="devotee-search" class="search-field" placeholder="Search name or devotee ID">
      <div id="devotee-list-wrap">${devoteeListHtml()}</div>
    </div>`;
  }

  function devoteeListHtml() {
    const q = ui.query.trim().toLowerCase();
    const people = data.devotees.filter(p =>
      !q || p.name.toLowerCase().includes(q) || (p.devoteeId || '').toLowerCase().includes(q));
    const rows = people.map(p => `
      <div class="devotee-row">
        <div class="av">${esc((p.name || '?')[0])}</div>
        <div class="who">
          <div class="nm">${esc(p.name)}${p.isAdmin ? ' <span class="admin-tag">admin</span>' : ''}</div>
          <div class="sb">${esc(p.devoteeId)} · ${esc(p.phone || '—')}</div>
        </div>
        <div class="cnt">
          <div class="n">${p.rounds}</div>
          <div class="st" style="color:${p.rounds > 0 ? '#2F7D45' : '#B3ACA1'}">${p.rounds > 0 ? 'Submitted' : 'Pending'}</div>
        </div>
      </div>`).join('');
    return `<div class="list-meta"><span>${people.length} devotee${people.length === 1 ? '' : 's'}</span><span>Sorted by rounds</span></div>
      <div class="list-card">${rows}</div>
      <p class="board-note" style="text-align:left;padding:0 4px">Admin access is fixed to one temple account and cannot be granted from here.</p>
      ${people.length === 0 ? `<p class="empty-note">${ui.query ? `No devotee matches “${esc(ui.query)}”.` : 'No devotees yet.'}</p>` : ''}`;
  }

  function renderDevoteeList() {
    const wrap = $('#devotee-list-wrap');
    if (wrap) wrap.innerHTML = devoteeListHtml();
  }

  /* ---------- Rounds sheet ---------- */

  function openRoundsSheet() {
    const ev = activeEvent();
    if (!ev) return;
    if (!isOpen(ev)) {
      showError(windowState(ev) === 'notStarted'
        ? `This challenge opens ${fmtStamp(ev.start_at)}.`
        : 'This challenge has ended, so rounds can no longer be changed.');
      return;
    }
    ui.sheet = 'rounds';
    ui.draft = '';
    ui.capped = false;
    renderOverlay();
  }

  function pressKey(k) {
    if (k === 'clr') { ui.draft = '0'; ui.capped = false; }
    else if (k === 'del') { ui.draft = ui.draft.slice(0, -1); ui.capped = false; }
    else {
      const nx = (ui.draft === '' || ui.draft === '0' ? '' : ui.draft) + k;
      if (parseInt(nx, 10) > MAX_ROUNDS) { ui.draft = String(MAX_ROUNDS); ui.capped = true; }
      else { ui.draft = nx; ui.capped = false; }
    }
    updateDraftBox();
  }

  // "Chanted more?" — the chips work from the running total, so four
  // more rounds on top of eight saves twelve.
  function addRounds(n) {
    const base = ui.draft === '' ? data.mine : (parseInt(ui.draft, 10) || 0);
    const next = base + n;
    ui.capped = next > MAX_ROUNDS;
    ui.draft = String(Math.min(MAX_ROUNDS, next));
    updateDraftBox();
  }

  function updateDraftBox() {
    const num = $('#draft-num'), hint = $('#draft-hint');
    if (!num) return;
    const editing = data.mine > 0;
    num.textContent = ui.draft === '' ? String(data.mine) : ui.draft;
    num.style.color = ui.draft === '' ? '#B3ACA1' : '#221F1B';
    hint.textContent = ui.capped ? `Maximum ${MAX_ROUNDS} rounds`
      : ui.draft === ''
        ? (editing ? 'Recorded now — type the new total' : 'Currently recorded — type to replace')
        : (editing ? `New total — was ${data.mine}` : 'Rounds');
    hint.style.color = ui.capped ? '#C0392B' : '#B3ACA1';
  }

  async function saveRounds() {
    const ev = activeEvent();
    if (!ev || ui.draft === '') { closeOverlay(); return; }
    if (!isOpen(ev)) { closeOverlay(); showError('This challenge is not open right now.'); return; }

    // A whole number from 0 to MAX_ROUNDS. The keypad cannot produce
    // anything else, but the value is checked here as well as in the
    // store and in the database.
    const val = parseInt(ui.draft, 10);
    if (!Number.isInteger(val) || val < 0 || val > MAX_ROUNDS) {
      showError(`Please enter a whole number between 0 and ${MAX_ROUNDS}.`);
      return;
    }

    const first = data.mine === 0;
    const btn = $('[data-action="save-rounds"]');
    const label = btn ? btn.textContent : 'Save Rounds';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      // The store returns the row the database stored, so the message
      // reports what was actually persisted rather than what was typed.
      const saved = await store.saveRounds(ev.id, val);
      closeOverlay();
      await reload();
      toast(first ? 'Hare Krishna! Your chanting has been recorded.'
                  : `Rounds updated — ${saved ? saved.rounds : val} offered.`);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      showError(e.message);
    }
  }

  /* ---------- Challenge form ---------- */

  function openEventForm(editId) {
    ui.sheet = 'event-form';
    ui.editEventId = editId || null;
    renderOverlay();
  }

  async function submitEventForm() {
    const startRaw = $('#ef-start').value;
    const endRaw = $('#ef-end').value;
    if (!startRaw || !endRaw) { showError('Please set both the start and the end of the challenge.'); return; }
    const start = new Date(startRaw), end = new Date(endRaw);
    if (end <= start) { showError('The challenge must end after it starts.'); return; }
    const payload = {
      name: $('#ef-name').value.trim() || 'Ekadashi Japa Seva',
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      status: $('#ef-status').value,
      goal_rounds: Math.max(100, parseInt($('#ef-goal').value, 10) || 3000),
      description: $('#ef-desc').value.trim(),
      visibility: $('.vis-option.on') ? $('.vis-option.on').dataset.vis : 'names'
    };
    const btn = $('[data-action="submit-event-form"]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const wasEdit = !!ui.editEventId;
      if (wasEdit) await store.updateEvent(ui.editEventId, payload);
      else await store.createEvent(payload);
      ui.editEventId = null;
      closeOverlay();
      await reload();
      toast(wasEdit ? 'Challenge updated.' : 'Japa challenge created.');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = label;
      showError(e.message);
    }
  }

  async function setEventStatus(id, status) {
    try {
      await store.setEventStatus(id, status);
      await reload();
      toast(status === 'active' ? 'Challenge is now live.'
          : status === 'closed' ? 'Challenge closed. Hare Krishna!' : 'Challenge updated.');
    } catch (e) { showError(e.message); }
  }

  async function exportCsv() {
    const ev = activeEvent() || lastClosed();
    if (!ev) { toast('No challenge to export yet.'); return; }
    try {
      const people = await store.devotees(ev.id);
      const rows = [['Name', 'Devotee ID', 'Phone', 'Rounds', 'Holy names', 'Last update']];
      people.forEach(p => rows.push([p.name, p.devoteeId, p.phone, p.rounds, p.rounds * NAMES_PER_ROUND, p.time]));
      const csv = rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${ev.name.replace(/\s+/g, '-')}-${String(ev.start_at).slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast('CSV exported.');
    } catch (e) { showError(e.message); }
  }

  /* ---------- Overlays ---------- */

  function renderOverlay() {
    const root = $('#overlay-root');
    if (!ui.sheet) { root.innerHTML = ''; return; }

    if (ui.sheet === 'rounds') {
      const ev = activeEvent();
      if (!ev) { root.innerHTML = ''; return; }
      const keyDefs = ['1','2','3','4','5','6','7','8','9','clr','0','del'];
      const editing = data.mine > 0;
      // Chanting a few more rounds is the common case, so offer it
      // directly: each chip sets the new total, which is what gets saved.
      const addChips = [1, 2, 4, 8].filter(n => data.mine + n <= MAX_ROUNDS);
      root.innerHTML = `<div class="overlay">
        <div class="scrim" data-action="close-overlay"></div>
        <div class="sheet">
          <div class="grabber"></div>
          <h3 style="text-align:center">${editing ? 'Update your rounds' : 'How many rounds today?'}</h3>
          <p class="sheet-sub">${editing
            ? `${data.mine} recorded so far — set your new total. Editable until ${esc(fmtStamp(ev.end_at))}`
            : `You can update this any time until ${esc(fmtStamp(ev.end_at))}`}</p>
          <div class="draft-box">
            <div class="draft-num" id="draft-num" style="color:#B3ACA1">${data.mine}</div>
            <div class="draft-hint" id="draft-hint" style="color:#B3ACA1">${editing
              ? 'Recorded now — type the new total'
              : 'Currently recorded — type to replace'}</div>
          </div>
          ${editing && addChips.length ? `<div class="add-row">
            <span class="add-label">Chanted more?</span>
            ${addChips.map(n => `<button type="button" class="add-chip" data-add="${n}">+${n}</button>`).join('')}
          </div>` : ''}
          <div class="keypad">
            ${keyDefs.map(k => `<button type="button"
              class="key${k === 'clr' || k === 'del' ? ' fn' : ''}${k === 'del' ? ' del' : ''}"
              data-key="${k}">${k === 'del' ? '⌫' : k === 'clr' ? 'Clear' : k}</button>`).join('')}
          </div>
          <button type="button" class="btn-primary" data-action="save-rounds">${editing ? 'Save Changes' : 'Save Rounds'}</button>
          <button type="button" class="btn-cancel" data-action="close-overlay">Cancel</button>
        </div>
      </div>`;
      return;
    }

    if (ui.sheet === 'event-form') {
      const edit = ui.editEventId ? data.events.find(x => x.id === ui.editEventId) : null;
      const e = edit || {
        name: 'Ekadashi Japa Seva',
        start_at: '', end_at: '', status: 'upcoming',
        goal_rounds: 3000, visibility: 'names', description: ''
      };
      // datetime-local needs a local "YYYY-MM-DDTHH:MM" string.
      const forInput = iso => {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const visOpts = [
        { key: 'names', label: 'Public within group', desc: 'Everyone sees name + rounds' },
        { key: 'ids',   label: 'Anonymous leaderboard', desc: 'Everyone sees Devotee ID + rounds' },
        { key: 'admin', label: 'Admin only', desc: 'Only admins see individual submissions' },
        { key: 'off',   label: 'Leaderboard off', desc: 'No leaderboard — group totals only' }
      ];
      const statuses = edit ? ['upcoming', 'active', 'draft', 'closed'] : ['upcoming', 'active', 'draft'];
      root.innerHTML = `<div class="overlay">
        <div class="scrim" data-action="close-overlay"></div>
        <div class="sheet">
          <div class="grabber"></div>
          <h3>${edit ? 'Edit Japa Challenge' : 'New Japa Challenge'}</h3>
          ${edit && edit.status === 'active'
            ? '<p class="sheet-sub" style="text-align:left;margin:2px 0 0">This challenge is running. You can move the end date and time later or raise the goal — devotees keep the rounds they have already offered.</p>'
            : ''}
          <div class="form-col" style="margin-top:16px">
            <div><label class="field-label" for="ef-name">Challenge name</label>
              <input class="field" id="ef-name" type="text" value="${esc(e.name)}"></div>
            <div><label class="field-label" for="ef-start">Starts — date &amp; time</label>
              <input class="field" id="ef-start" type="datetime-local" value="${esc(forInput(e.start_at))}"></div>
            <div><label class="field-label" for="ef-end">Ends — date &amp; time</label>
              <input class="field" id="ef-end" type="datetime-local" value="${esc(forInput(e.end_at))}"></div>
            <div><label class="field-label" for="ef-status">Status</label>
              <select class="field" id="ef-status">
                ${statuses.map(s => `<option value="${s}"${e.status === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
              </select></div>
            <div><label class="field-label" for="ef-goal">Group goal (rounds)</label>
              <input class="field" id="ef-goal" type="number" min="100" step="100" value="${e.goal_rounds}"></div>
            <div><label class="field-label" for="ef-desc">Description / rules</label>
              <textarea class="field" id="ef-desc">${esc(e.description || '')}</textarea></div>
            <div>
              <div class="field-label">Leaderboard visibility</div>
              <div class="form-col" style="gap:7px">
                ${visOpts.map(v => `
                  <div class="vis-option${e.visibility === v.key ? ' on' : ''}" data-vis="${v.key}">
                    <div class="radio"><i></i></div>
                    <div><div class="t">${v.label}</div><div class="d">${v.desc}</div></div>
                  </div>`).join('')}
              </div>
            </div>
          </div>
          <button type="button" class="btn-primary" data-action="submit-event-form">${edit ? 'Save Changes' : 'Create Challenge'}</button>
          <button type="button" class="btn-cancel" data-action="close-overlay">Cancel</button>
        </div>
      </div>`;
      return;
    }
  }

  function closeOverlay() {
    ui.sheet = null;
    ui.draft = '';
    ui.capped = false;
    renderOverlay();
  }

  function toast(text) {
    clearTimeout(ui.toastTimer);
    const wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.innerHTML = `<div class="toast-card"><div class="lotus">🪷</div><p>${esc(text)}</p></div>`;
    $('#overlay-root').appendChild(wrap);
    ui.toastTimer = setTimeout(() => wrap.remove(), 1900);
  }

  function showError(text) {
    clearTimeout(ui.toastTimer);
    const wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.innerHTML = `<div class="toast-card err"><p>${esc(text || 'Something went wrong. Please try again.')}</p></div>`;
    $('#overlay-root').appendChild(wrap);
    ui.toastTimer = setTimeout(() => wrap.remove(), 3200);
  }

  /* ---------- Events ---------- */

  document.addEventListener('click', async ev => {
    const t = ev.target.closest('[data-action],[data-tab],[data-adminsec],[data-key],[data-add],.vis-option');
    if (!t) return;

    if (t.dataset.adminsec) {
      ui.adminSection = t.dataset.adminsec;
      if (ui.adminSection === 'devotees') await reload();
      else render();
      return;
    }
    if (t.dataset.tab) {
      ui.tab = t.dataset.tab;
      if (ui.tab === 'admin' && ui.adminSection === 'devotees') await reload();
      else render();
      return;
    }
    if (t.dataset.key) { pressKey(t.dataset.key); return; }
    if (t.dataset.add) { addRounds(parseInt(t.dataset.add, 10) || 0); return; }
    if (t.classList.contains('vis-option')) {
      document.querySelectorAll('.vis-option').forEach(o => o.classList.toggle('on', o === t));
      return;
    }

    switch (t.dataset.action) {
      case 'open-sheet':
      case 'edit-rounds':       openRoundsSheet(); break;
      case 'retry-load':        await retryLoad(); break;
      case 'close-overlay':     closeOverlay(); break;
      case 'save-rounds':       await saveRounds(); break;
      case 'goto-together':     ev.preventDefault(); ui.tab = 'together'; render(); break;
      case 'sign-out':          await signOut(); break;
      case 'new-event':         openEventForm(null); break;
      case 'edit-event':        openEventForm(t.dataset.id); break;
      case 'submit-event-form': await submitEventForm(); break;
      case 'close-event':       await setEventStatus(t.dataset.id, 'closed'); break;
      case 'activate-event':    await setEventStatus(t.dataset.id, 'active'); break;
      case 'reopen-event':      await setEventStatus(t.dataset.id, 'active'); break;
      case 'export-csv':        await exportCsv(); break;
    }
  });

  /* ---------- Boot ---------- */

  (async function boot() {
    try {
      store = await window.JapaStore.create();
    } catch (e) {
      // Without the temple database there is nothing to sign in to.
      // Say why on the sign-in card instead of failing silently.
      console.error(e);
      $('#auth-submit').disabled = true;
      authMsg(e.message || 'The temple database could not be reached.');
      return;
    }
    initAuth();
    try {
      const user = await store.currentUser();
      if (user) {
        data.user = user;
        await enterApp();
      }
    } catch (e) {
      console.warn('Could not restore session:', e.message);
    }
  })();
})();
