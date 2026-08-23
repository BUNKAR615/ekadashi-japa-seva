/* ============================================================
   Ekadashi Japa Seva — Hare Krishna Marwad Mandir

   All data access goes through window.JapaStore (see store.js), which
   is either the Supabase backend or the localStorage demo store.
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
    totals: { total: 0, participants: 0, average: 0, highest: 0, capacity: 0 },
    leaders: [], activeLeaders: [], devotees: [], history: []
  };

  const ui = {
    role: 'devotee', tab: 'japa',
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
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDateLong(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  const isMultiDay = e => e && e.end_date && e.end_date !== e.event_date;
  const dateRange = e => isMultiDay(e)
    ? `${fmtDateShort(e.event_date)} – ${fmtDateShort(e.end_date)}`
    : fmtDateShort(e.event_date);

  const activeEvent  = () => data.events.find(e => e.status === 'active');
  const nextUpcoming = () => data.events.filter(e => e.status === 'upcoming')
    .sort((a, b) => a.event_date.localeCompare(b.event_date))[0];
  const lastClosed   = () => data.events.filter(e => e.status === 'closed')
    .sort((a, b) => b.event_date.localeCompare(a.event_date))[0];

  const isAdmin = () => !!(data.user && data.user.isAdmin);

  // Sort board rows by the challenge's ranking parameter.
  function rankSorted(rows, ev) {
    const daily = ev && ev.rank_by === 'daily';
    const metric = daily ? (p => p.today) : (p => p.total);
    return rows.slice().sort((a, b) => (metric(b) - metric(a)) || (b.total - a.total));
  }

  /* ---------- Loading ---------- */

  async function refresh() {
    data.events = await store.listEvents();
    const ev = activeEvent() || lastClosed() || null;
    data.event = ev;

    if (ev) {
      const [mine, totals] = await Promise.all([
        store.myRounds(ev.id),
        store.eventTotals(ev.id)
      ]);
      data.mine = mine;
      data.totals = totals;
    } else {
      data.mine = 0;
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

    if (ui.role === 'admin' && isAdmin() && ui.tab === 'aDevotees') {
      try { data.devotees = await store.devotees(ev ? ev.id : null); }
      catch (e) { data.devotees = []; }
    }
  }

  async function reload() {
    if (ui.busy) return;
    ui.busy = true;
    try {
      await refresh();
      render();
    } catch (e) {
      console.error(e);
      showError(e.message || 'Something went wrong. Please try again.');
    } finally {
      ui.busy = false;
    }
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
    try { await refresh(); } catch (e) { console.error(e); }
    $('#welcome').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#loading').classList.add('hidden');
    ui.role = 'devotee';
    ui.tab = 'japa';
    render();
  }

  async function signOut() {
    await store.signOut();
    data.user = null;
    ui.role = 'devotee';
    ui.tab = 'japa';
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
    renderModeBanner();
  }

  function renderModeBanner() {
    let el = $('#mode-banner');
    if (store.isDemo) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'mode-banner';
        el.className = 'mode-banner';
        el.textContent = 'Demo mode — rounds are saved only on this device';
        $('#app').insertBefore(el, $('#content'));
      }
    } else if (el) { el.remove(); }
  }

  function renderHeader() {
    const toggle = $('#role-toggle');
    // The Admin pill only exists for accounts the backend marks as admins.
    toggle.classList.toggle('hidden', !isAdmin());
    toggle.querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.role === ui.role);
    });
  }

  const DEV_TABS = [
    { key: 'japa', label: 'Japa' },
    { key: 'together', label: 'Leaderboard' },
    { key: 'me', label: 'Me' }
  ];
  const ADM_TABS = [
    { key: 'aOverview', label: 'Overview' },
    { key: 'aEvents', label: 'Events' },
    { key: 'aDevotees', label: 'Devotees' },
    { key: 'me', label: 'Me' }
  ];

  function renderTabs() {
    const tabs = ui.role === 'admin' ? ADM_TABS : DEV_TABS;
    $('#tabbar').innerHTML = tabs.map(t => `
      <button type="button" class="tab-btn${ui.tab === t.key ? ' on' : ''}" data-tab="${t.key}">
        <span class="dot"></span><span class="lbl">${t.label}</span>
      </button>`).join('');
  }

  function renderContent() {
    const c = $('#content');
    switch (ui.tab) {
      case 'japa':      c.innerHTML = viewJapa(); break;
      case 'together':  c.innerHTML = viewTogether(); break;
      case 'me':        c.innerHTML = viewMe(); break;
      case 'aOverview': c.innerHTML = viewAdminOverview(); break;
      case 'aEvents':   c.innerHTML = viewAdminEvents(); break;
      case 'aDevotees': c.innerHTML = viewAdminDevotees(); break;
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
            ? `The next challenge begins ${esc(fmtDateLong(next.event_date))}. Your rounds can be offered then.`
            : 'A new Japa challenge will be announced soon.'}</p>
        </div>
        ${quoteCard()}${mantraBlock()}
      </div>`;
    }

    const closed = ev.status !== 'active';
    const rounds = data.mine;
    const t = data.totals;
    const pct = ev.goal_rounds ? Math.min(100, Math.round((t.total / ev.goal_rounds) * 100)) : 0;
    const eyebrow = isMultiDay(ev) ? dateRange(ev) : `Ekadashi · ${fmtDateShort(ev.event_date)}`;

    return `<div class="pad">
      <div class="card event-card">
        <div class="event-top">
          <span class="eyebrow">${esc(eyebrow)}</span>
          <span class="chip ${closed ? 'closed' : 'active'}">${closed ? 'Closed' : 'Active'}</span>
        </div>
        <h2 class="event-title">${esc(ev.name)}</h2>
        <div class="rounds-label">Your rounds today</div>
        <div class="rounds-num">${rounds}</div>
        <div class="rounds-caption">${rounds === 0
          ? 'Not recorded yet'
          : `${fmt(rounds * NAMES_PER_ROUND)} holy names`}</div>
        <button type="button" class="cta ${closed ? 'dead' : 'live'}" data-action="open-sheet">
          ${closed ? 'Challenge closed' : (rounds === 0 ? 'Record my rounds' : 'Update Rounds')}
        </button>
        <div class="cta-hint">${closed
          ? 'Your rounds are saved in your profile'
          : `You can change this any time until ${esc(ev.ends_at)}${isMultiDay(ev) ? ' · rounds are counted each day' : ''}`}</div>
      </div>

      <div class="card together-card">
        <div class="together-top">
          <span class="eyebrow">Together${isMultiDay(ev) ? '' : ' today'}</span>
          <a href="#" data-action="goto-together">See all</a>
        </div>
        <div class="group-row">
          <div class="group-num">${fmt(t.total)}</div>
          <div class="group-unit">rounds</div>
        </div>
        <div class="participants-line">${t.capacity
          ? `${fmt(t.capacity)} devotees registered · ${fmt(t.participants)} have submitted`
          : `${fmt(t.participants)} devotees have submitted`}</div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-meta"><span>${pct}% of the goal</span><span>${fmt(ev.goal_rounds)} goal</span></div>
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
    const daily = ev.rank_by === 'daily';
    const people = rankSorted(data.leaders, ev);
    const off = ev.visibility === 'off';
    const privated = ev.visibility === 'admin' && !isAdmin();

    const stats = [
      { label: 'Total rounds', value: fmt(t.total) },
      { label: 'Participants', value: fmt(t.participants) },
      { label: 'Average', value: String(t.average) },
      { label: 'Highest', value: fmt(t.highest) }
    ];

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
      board = `<div class="list-card">
        ${people.map((p, i) => `
          <div class="board-row${p.me ? ' me' : ''}">
            <div class="rank">${i + 1}</div>
            <div class="who">
              <div class="nm">${esc(ev.visibility === 'ids' ? p.devoteeId : p.name)}</div>
              <div class="sb">${ev.visibility === 'ids'
                ? (p.me ? 'You' : 'Devotee')
                : (p.me ? 'You · ' + esc(p.devoteeId) : esc(p.devoteeId))}${
                daily ? ' · ' + fmt(p.total) + ' total' : ''}</div>
            </div>
            <div class="cnt">${daily ? p.today : p.total}</div>
          </div>`).join('')}
      </div>
      <p class="board-note">Not a competition — a shared offering.<br>${
        daily ? 'Ranked by today’s progress.' :
        ev.visibility === 'ids' ? 'Shown by Devotee ID for this challenge.' : 'Ranked by total rounds.'}</p>`;
    }

    return `<div class="pad-lg">
      <h2 class="h2">Leaderboard</h2>
      <p class="sub">${esc(ev.name)} · ${esc(dateRange(ev))}</p>
      <div class="stat-grid">
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
            return `<div class="tl-row">
              <div class="who">
                <div class="tl-date">${esc(fmtDateShort(h.date))}</div>
                <div class="tl-title">${esc(h.name)}</div>
                <div class="tl-note">${isToday ? 'In progress · updated at ' + esc(h.time) : 'Recorded at ' + esc(h.time)}</div>
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

  /* ----- Admin: Overview ----- */

  function viewAdminOverview() {
    const ev = activeEvent();
    const t = data.totals;
    const pct = ev && t.capacity ? Math.round((t.participants / t.capacity) * 100) : 0;
    const top = ev ? rankSorted(data.activeLeaders, ev).slice(0, 4) : [];

    const stats = ev ? [
      { label: 'Live challenge', value: ev.name.split(' ')[0], sub: `${dateRange(ev)} · until ${ev.ends_at}` },
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
          <span class="live-dot${ev ? '' : ' off'}"></span>
          ${ev ? `${esc(ev.name)} · live until ${esc(ev.ends_at)}` : 'No challenge is live right now'}
        </div>
      </div>

      <div class="stat-grid" style="margin-bottom:0">
        ${stats.map(s => `<div class="stat-tile"><div class="lbl">${s.label}</div><div class="val">${esc(s.value)}</div><div class="sub">${esc(s.sub)}</div></div>`).join('')}
      </div>

      <div class="panel">
        <span class="eyebrow">Participation</span>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="panel-meta">
          <span>${ev ? `${fmt(t.participants)} of ${fmt(t.capacity)} devotees have submitted` : 'Waiting for the next challenge'}</span>
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
            <div class="n">${ev.rank_by === 'daily' ? p.today : p.total}</div>
          </div>`).join('')}
      </div>` : ''}
    </div>`;
  }

  /* ----- Admin: Events ----- */

  function eventMeta(e) {
    const vis = e.visibility === 'names' ? 'names visible'
      : e.visibility === 'ids' ? 'devotee IDs'
      : e.visibility === 'admin' ? 'admin only' : 'leaderboard off';
    const rank = e.rank_by === 'daily' ? 'daily progress' : 'total rounds';
    switch (e.status) {
      case 'active':   return `Live now · ${e.starts_at}–${e.ends_at} · ${vis}`;
      case 'upcoming': return `Leaderboard: ${vis} · ranked by ${rank}`;
      case 'closed':   return `Closed · goal was ${fmt(e.goal_rounds)} rounds`;
      default:         return 'Draft — not visible to devotees yet';
    }
  }
  function eventPrimary(e) {
    switch (e.status) {
      case 'active':   return { label: 'Close', action: 'close-event' };
      case 'upcoming': return { label: 'Start now', action: 'activate-event' };
      case 'closed':   return { label: 'Reopen', action: 'reopen-event' };
      default:         return { label: 'Start now', action: 'activate-event' };
    }
  }

  function viewAdminEvents() {
    const order = { active: 0, upcoming: 1, draft: 2, closed: 3 };
    const events = data.events.slice().sort((a, b) =>
      (order[a.status] - order[b.status]) || b.event_date.localeCompare(a.event_date));
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
            <button type="button" data-action="${p.action}" data-id="${e.id}">${p.label}</button>
            <button type="button" data-action="edit-event" data-id="${e.id}">Edit</button>
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
        ${p.me ? '' : `<button type="button" class="btn-mini${p.isAdmin ? ' warn' : ''}"
          data-action="toggle-admin" data-id="${esc(p.userId)}" data-make="${p.isAdmin ? '0' : '1'}"
          data-name="${esc(p.name)}">${p.isAdmin ? 'Remove admin' : 'Make admin'}</button>`}
        <div class="cnt">
          <div class="n">${p.rounds}</div>
          <div class="st" style="color:${p.rounds > 0 ? '#2F7D45' : '#B3ACA1'}">${p.rounds > 0 ? 'Submitted' : 'Pending'}</div>
        </div>
      </div>`).join('');
    return `<div class="list-meta"><span>${people.length} devotee${people.length === 1 ? '' : 's'}</span><span>Sorted by rounds</span></div>
      <div class="list-card">${rows}</div>
      ${people.length === 0 ? `<p class="empty-note">${ui.query ? `No devotee matches “${esc(ui.query)}”.` : 'No devotees yet.'}</p>` : ''}`;
  }

  function renderDevoteeList() {
    const wrap = $('#devotee-list-wrap');
    if (wrap) wrap.innerHTML = devoteeListHtml();
  }

  async function toggleAdmin(userId, makeAdmin, name) {
    try {
      await store.setAdmin(userId, makeAdmin);
      if (data.user && (userId === data.user.id || userId === data.user.devoteeId)) {
        data.user.isAdmin = makeAdmin;
      }
      data.devotees = await store.devotees(data.event ? data.event.id : null);
      render();
      toast(makeAdmin ? `${name} is now a temple admin.` : `Admin rights removed from ${name}.`);
    } catch (e) { showError(e.message); }
  }

  /* ---------- Rounds sheet ---------- */

  function openRoundsSheet() {
    if (!activeEvent()) return;
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

  function updateDraftBox() {
    const num = $('#draft-num'), hint = $('#draft-hint');
    if (!num) return;
    num.textContent = ui.draft === '' ? String(data.mine) : ui.draft;
    num.style.color = ui.draft === '' ? '#B3ACA1' : '#221F1B';
    hint.textContent = ui.capped ? `Maximum ${MAX_ROUNDS} rounds`
      : (ui.draft === '' ? 'Currently recorded — type to replace' : 'Rounds');
    hint.style.color = ui.capped ? '#C0392B' : '#B3ACA1';
  }

  async function saveRounds() {
    const ev = activeEvent();
    if (!ev || ui.draft === '') { closeOverlay(); return; }
    const val = Math.min(MAX_ROUNDS, parseInt(ui.draft, 10) || 0);
    const first = data.mine === 0;
    const btn = $('[data-action="save-rounds"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await store.saveRounds(ev.id, val);
      closeOverlay();
      await reload();
      toast(first ? 'Hare Krishna! Your chanting has been recorded.'
                  : `Rounds updated — ${val} offered today.`);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Rounds'; }
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
    const start = $('#ef-date').value || new Date().toLocaleDateString('en-CA');
    let end = $('#ef-date2').value || start;
    if (end < start) end = start;
    const payload = {
      name: $('#ef-name').value.trim() || 'Ekadashi Japa Seva',
      event_date: start,
      end_date: end,
      status: $('#ef-status').value,
      starts_at: $('#ef-start').value || '00:00',
      ends_at: $('#ef-end').value || '23:59',
      goal_rounds: Math.max(100, parseInt($('#ef-goal').value, 10) || 3000),
      rank_by: $('#ef-rank').value,
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
      a.download = `${ev.name.replace(/\s+/g, '-')}-${ev.event_date}.csv`;
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
      const keyDefs = ['1','2','3','4','5','6','7','8','9','clr','0','del'];
      root.innerHTML = `<div class="overlay">
        <div class="scrim" data-action="close-overlay"></div>
        <div class="sheet">
          <div class="grabber"></div>
          <h3 style="text-align:center">How many rounds today?</h3>
          <p class="sheet-sub">You can update this any time until ${esc(ev.ends_at)}</p>
          <div class="draft-box">
            <div class="draft-num" id="draft-num" style="color:#B3ACA1">${data.mine}</div>
            <div class="draft-hint" id="draft-hint" style="color:#B3ACA1">Currently recorded — type to replace</div>
          </div>
          <div class="keypad">
            ${keyDefs.map(k => `<button type="button"
              class="key${k === 'clr' || k === 'del' ? ' fn' : ''}${k === 'del' ? ' del' : ''}"
              data-key="${k}">${k === 'del' ? '⌫' : k === 'clr' ? 'Clear' : k}</button>`).join('')}
          </div>
          <button type="button" class="btn-primary" data-action="save-rounds">Save Rounds</button>
          <button type="button" class="btn-cancel" data-action="close-overlay">Cancel</button>
        </div>
      </div>`;
      return;
    }

    if (ui.sheet === 'event-form') {
      const edit = ui.editEventId ? data.events.find(x => x.id === ui.editEventId) : null;
      const e = edit || {
        name: 'Ekadashi Japa Seva',
        event_date: '', end_date: '', status: 'upcoming', starts_at: '00:00', ends_at: '23:59',
        goal_rounds: 3000, visibility: 'names', rank_by: 'total', description: ''
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
          <div class="form-col" style="margin-top:16px">
            <div><label class="field-label" for="ef-name">Challenge name</label>
              <input class="field" id="ef-name" type="text" value="${esc(e.name)}"></div>
            <div class="form-row">
              <div><label class="field-label" for="ef-date">Start date</label>
                <input class="field" id="ef-date" type="date" value="${esc(e.event_date)}"></div>
              <div><label class="field-label" for="ef-date2">End date</label>
                <input class="field" id="ef-date2" type="date" value="${esc(e.end_date || e.event_date)}"></div>
            </div>
            <div class="form-row">
              <div><label class="field-label" for="ef-status">Status</label>
                <select class="field" id="ef-status">
                  ${statuses.map(s => `<option value="${s}"${e.status === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
                </select></div>
              <div><label class="field-label" for="ef-rank">Ranking</label>
                <select class="field" id="ef-rank">
                  <option value="total"${e.rank_by !== 'daily' ? ' selected' : ''}>Total rounds</option>
                  <option value="daily"${e.rank_by === 'daily' ? ' selected' : ''}>Daily progress</option>
                </select></div>
            </div>
            <div class="form-row">
              <div><label class="field-label" for="ef-start">Opens (daily)</label>
                <input class="field" id="ef-start" type="time" value="${esc(e.starts_at)}"></div>
              <div><label class="field-label" for="ef-end">Closes (daily)</label>
                <input class="field" id="ef-end" type="time" value="${esc(e.ends_at)}"></div>
            </div>
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
    const t = ev.target.closest('[data-action],[data-tab],[data-role],[data-key],.vis-option');
    if (!t) return;

    if (t.dataset.role) {
      const role = t.dataset.role;
      if (role === 'admin' && !isAdmin()) return;
      if (role !== ui.role) {
        ui.role = role;
        ui.tab = role === 'admin' ? 'aOverview' : 'japa';
        closeOverlay();
        await reload();
      }
      return;
    }
    if (t.dataset.tab) {
      ui.tab = t.dataset.tab;
      if (t.dataset.tab === 'aDevotees') await reload();
      else render();
      return;
    }
    if (t.dataset.key) { pressKey(t.dataset.key); return; }
    if (t.classList.contains('vis-option')) {
      document.querySelectorAll('.vis-option').forEach(o => o.classList.toggle('on', o === t));
      return;
    }

    switch (t.dataset.action) {
      case 'open-sheet':        openRoundsSheet(); break;
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
      case 'toggle-admin':
        await toggleAdmin(t.dataset.id, t.dataset.make === '1', t.dataset.name);
        break;
    }
  });

  /* ---------- Boot ---------- */

  (async function boot() {
    store = await window.JapaStore.create();
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
