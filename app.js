/* ============================================================
   Ekadashi Japa Seva — devotee & admin app
   Vanilla JS single-page app; state persisted in localStorage.
   ============================================================ */
(function () {
  'use strict';

  const LS_KEY = 'japaSeva.v1';
  const MAX_ROUNDS = 216;
  const NAMES_PER_ROUND = 108;

  /* ---------- Seed data (demo community) ---------- */

  const OTHERS = [
    { name: 'Rahul Vyas',     id: 'HKMM014', phone: '+91 98280 11402' },
    { name: 'Amit Purohit',   id: 'HKMM008', phone: '+91 98290 55317' },
    { name: 'Sanjay Bishnoi', id: 'HKMM021', phone: '+91 94140 78226' },
    { name: 'Kunal Rathore',  id: 'HKMM003', phone: '+91 98875 30194' },
    { name: 'Nikhil Joshi',   id: 'HKMM037', phone: '+91 96360 42871' },
    { name: 'Vivek Suthar',   id: 'HKMM042', phone: '+91 97830 66508' },
    { name: 'Harsh Solanki',  id: 'HKMM011', phone: '+91 99280 13645' }
  ];

  // Rounds the named devotees offered for the currently active event.
  const OTHERS_ROUNDS = {
    HKMM014: { rounds: 60, time: '17:31' },
    HKMM008: { rounds: 48, time: '19:05' },
    HKMM021: { rounds: 42, time: '16:12' },
    HKMM003: { rounds: 36, time: '20:04' },
    HKMM037: { rounds: 32, time: '15:48' },
    HKMM042: { rounds: 28, time: '21:10' },
    HKMM011: { rounds: 24, time: '13:26' }
  };

  const UNNAMED_BASE = 2102;      // rounds from the wider community
  const TOTAL_DEVOTEES = 87;
  const OTHERS_SUBMITTED = 73;

  function seedEvents() {
    return [
      { id: 'e1', name: 'Ekadashi Japa Seva',        date: '2026-08-15', status: 'active',
        start: '00:00', end: '23:59', goal: 3000, visibility: 'names',
        desc: 'Offer your chanting with devotion. Rounds can be updated until midnight.' },
      { id: 'e2', name: 'Ekadashi Japa Seva',        date: '2026-08-29', status: 'upcoming',
        start: '00:00', end: '23:59', goal: 3000, visibility: 'names',
        desc: 'Offer your chanting with devotion.' },
      { id: 'e3', name: 'Ekadashi Japa Seva',        date: '2026-07-29', status: 'closed',
        start: '00:00', end: '23:59', goal: 3000, visibility: 'names',
        desc: '', baseRounds: 1908, baseParticipants: 68 },
      { id: 'e5', name: 'Ekadashi Japa Seva',        date: '2026-07-14', status: 'closed',
        start: '00:00', end: '23:59', goal: 3000, visibility: 'names',
        desc: '', baseRounds: 1642, baseParticipants: 61 },
      { id: 'e0', name: 'Purushottama Japa Retreat', date: '2026-06-30', status: 'closed',
        start: '00:00', end: '23:59', goal: 3000, visibility: 'names',
        desc: '', baseRounds: 2204, baseParticipants: 70 },
      { id: 'e4', name: 'Janmashtami Maha-Japa',     date: '2026-09-04', status: 'draft',
        start: '00:00', end: '23:59', goal: 4000, visibility: 'names',
        desc: 'A special maha-japa offering for Sri Krishna Janmashtami.' }
    ];
  }

  /* ---------- State ---------- */

  let state = load() || {
    user: null,            // {name,email,devoteeId,phone,group}
    role: 'devotee',
    tab: 'japa',
    events: seedEvents(),
    mySubmissions: {       // eventId -> {rounds,time}
      e3: { rounds: 32, time: '18:12' },
      e5: { rounds: 24, time: '19:40' },
      e0: { rounds: 48, time: '17:05' }
    }
  };

  // Transient UI state (not persisted)
  const ui = { sheet: null, draft: '', capped: false, toastTimer: null, query: '', editEventId: null };

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  /* ---------- Helpers ---------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const fmt = n => n.toLocaleString('en-IN');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDateShort(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDateLong(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function nowTime() {
    return new Date().toTimeString().slice(0, 5);
  }

  function activeEvent()   { return state.events.find(e => e.status === 'active'); }
  function nextUpcoming()  {
    return state.events.filter(e => e.status === 'upcoming')
      .sort((a, b) => a.date.localeCompare(b.date))[0];
  }
  function lastClosed() {
    return state.events.filter(e => e.status === 'closed')
      .sort((a, b) => b.date.localeCompare(a.date))[0];
  }
  // The event shown on the Japa tab: active first, else most recent closed, else none.
  function displayEvent() { return activeEvent() || lastClosed() || null; }

  function myRounds(ev) {
    if (!ev) return 0;
    const sub = state.mySubmissions[ev.id];
    return sub ? sub.rounds : 0;
  }

  // Everyone's rounds for the event shown on the Japa/Together tabs.
  function groupTotals(ev) {
    if (!ev) return { total: 0, submitted: 0 };
    const mine = myRounds(ev);
    if (ev.status === 'closed' && ev.baseRounds) {
      // Archived totals already include every submission, ours too.
      return { total: ev.baseRounds, submitted: ev.baseParticipants || 0 };
    }
    const named = Object.values(OTHERS_ROUNDS).reduce((s, o) => s + o.rounds, 0);
    return {
      total: UNNAMED_BASE + named + mine,
      submitted: OTHERS_SUBMITTED + (mine > 0 ? 1 : 0)
    };
  }

  function boardPeople(ev) {
    const me = state.user;
    const people = OTHERS.map(o => ({
      name: o.name, id: o.id, phone: o.phone,
      rounds: OTHERS_ROUNDS[o.id].rounds, time: OTHERS_ROUNDS[o.id].time, me: false
    }));
    if (me) {
      const sub = ev ? state.mySubmissions[ev.id] : null;
      people.push({
        name: me.name, id: me.devoteeId, phone: me.phone,
        rounds: sub ? sub.rounds : 0, time: sub ? sub.time : '—', me: true
      });
    }
    return people.sort((a, b) => b.rounds - a.rounds);
  }

  function lifetime() {
    return Object.values(state.mySubmissions).reduce((s, x) => s + x.rounds, 0);
  }

  /* ---------- Welcome / auth ---------- */

  let authMode = 'signin';

  function initAuth() {
    const form = $('#auth-form');
    const toggle = $('#auth-toggle');

    toggle.addEventListener('click', ev => {
      ev.preventDefault();
      authMode = authMode === 'signin' ? 'create' : 'signin';
      const create = authMode === 'create';
      $('#auth-name-block').classList.toggle('hidden', !create);
      $('#auth-title').textContent = create ? 'Welcome, devotee' : 'Hare Krishna 🙏';
      $('#auth-sub').textContent = create
        ? 'Create your account to offer rounds'
        : 'Welcome to Hare Krishna Marwad Mandir';
      $('#auth-submit').textContent = create ? 'Create Account' : 'Sign In';
      $('#auth-switch').firstChild.textContent = create ? 'Already have an account? ' : 'Don’t have an account? ';
      toggle.textContent = create ? 'Sign In' : 'Create Account';
      $('#auth-error').classList.add('hidden');
    });

    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const email = $('#auth-email').value.trim();
      const pass = $('#auth-pass').value;
      const err = $('#auth-error');
      if (!email || !pass) {
        err.textContent = 'Please enter your email and password.';
        err.classList.remove('hidden');
        return;
      }
      let name;
      if (authMode === 'create') {
        name = $('#auth-name').value.trim();
        if (!name) {
          err.textContent = 'Please enter your full name.';
          err.classList.remove('hidden');
          return;
        }
      } else {
        name = state.user ? state.user.name
          : email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
      err.classList.add('hidden');
      if (!state.user) {
        state.user = {
          name, email,
          devoteeId: 'HKMM001',
          phone: '+91 98280 41172',
          group: 'Marwad Youth Bhakti Vriksha'
        };
      } else {
        state.user.email = email;
        if (authMode === 'create') state.user.name = name;
      }
      persist();
      enterApp();
    });
  }

  function enterApp() {
    $('#loading').classList.remove('hidden');
    setTimeout(() => {
      $('#welcome').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#loading').classList.add('hidden');
      render();
    }, 900);
  }

  function signOut() {
    state.user = null;
    state.role = 'devotee';
    state.tab = 'japa';
    persist();
    closeOverlay();
    $('#app').classList.add('hidden');
    $('#welcome').classList.remove('hidden');
    $('#auth-pass').value = '';
  }

  /* ---------- Rendering ---------- */

  function render() {
    renderHeader();
    renderTabs();
    renderContent();
  }

  function renderHeader() {
    $('#role-toggle').querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.role === state.role);
    });
  }

  const DEV_TABS = [
    { key: 'japa',     label: 'Japa',     icon: '🪷' },
    { key: 'together', label: 'Together', icon: '🌸' },
    { key: 'journey',  label: 'Journey',  icon: '▤' },
    { key: 'me',       label: 'Me',       icon: '☸' }
  ];
  const ADM_TABS = [
    { key: 'aOverview', label: 'Overview', icon: '▦' },
    { key: 'aEvents',   label: 'Events',   icon: '🪷' },
    { key: 'aDevotees', label: 'Devotees', icon: '☸' },
    { key: 'me',        label: 'Me',       icon: '◉' }
  ];

  function renderTabs() {
    const tabs = state.role === 'admin' ? ADM_TABS : DEV_TABS;
    $('#tabbar').innerHTML = tabs.map(t => `
      <button type="button" class="tab-btn${state.tab === t.key ? ' on' : ''}" data-tab="${t.key}">
        <span class="ico">${t.icon}</span><span class="lbl">${t.label}</span>
      </button>`).join('');
  }

  function renderContent() {
    const c = $('#content');
    switch (state.tab) {
      case 'japa':      c.innerHTML = viewJapa(); break;
      case 'together':  c.innerHTML = viewTogether(); break;
      case 'journey':   c.innerHTML = viewJourney(); break;
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
      if (ui.query) renderDevoteeList();
    }
  }

  /* ----- Devotee: Japa ----- */

  function viewJapa() {
    const ev = displayEvent();

    if (!ev) {
      const next = nextUpcoming();
      return `<div class="pad">
        <div class="card no-event-card">
          <div class="flower">🌸</div>
          <p class="big">There is currently no active Japa event.</p>
          <p class="small">${next
            ? `The next Ekadashi is ${esc(fmtDateShort(next.date))}. Your rounds can be offered then.`
            : 'A new Japa event will be announced soon. Hare Krishna!'}</p>
        </div>
        ${quoteCard()}${mantraBlock()}
      </div>`;
    }

    const closed = ev.status === 'closed';
    const rounds = myRounds(ev);
    const g = groupTotals(ev);
    const pct = Math.min(100, Math.round((g.total / ev.goal) * 100));

    return `<div class="pad">
      <div class="card event-card">
        <div class="jali"></div>
        <div class="inner">
          <div class="event-head">
            <span class="eyebrow">Today’s seva</span>
            <span class="chip ${closed ? 'closed' : 'active'}">${closed ? 'Closed' : 'Active now'}</span>
          </div>
          <div class="event-lotus">🪷</div>
          <h2 class="event-title">${esc(ev.name)}</h2>
          <div class="event-date">${esc(fmtDateLong(ev.date))}</div>
          <div class="gold-rule"></div>
          <p class="event-tag">Offer your chanting with devotion.</p>
          <div style="text-align:center">
            <div class="rounds-label">Your rounds</div>
            <div class="rounds-num">${rounds}</div>
            <div class="rounds-caption">${rounds === 0
              ? 'Not recorded yet'
              : `Rounds completed · ${fmt(rounds * NAMES_PER_ROUND)} names`}</div>
            <button type="button" class="cta ${closed ? 'dead' : 'live'}" data-action="open-sheet">
              ${closed ? 'Event closed' : (rounds === 0 ? 'Record my rounds' : 'Update Rounds')}
            </button>
            <div class="cta-hint">${closed
              ? 'Results stay in your Journey'
              : `You can change this any time until ${esc(ev.end)}`}</div>
          </div>
        </div>
      </div>

      <div class="card together-card">
        <div class="together-head">
          <span class="eyebrow">Together we chant</span>
          <a href="#" data-action="goto-together">See all</a>
        </div>
        <div class="group-num-row">
          <div class="group-num">${fmt(g.total)}</div>
          <div class="group-unit">rounds</div>
        </div>
        <div class="participants-line">${TOTAL_DEVOTEES} devotees participating · ${g.submitted} have submitted</div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-meta"><span>${pct}% of today’s goal</span><span>${fmt(ev.goal)} goal</span></div>
        <p class="together-line">Together we have offered ${fmt(g.total)} rounds today.</p>
      </div>

      ${quoteCard()}${mantraBlock()}
    </div>`;
  }

  function quoteCard() {
    return `<div class="quote-card">
      <div class="photo"><img src="assets/prabhupada.jpg" alt="Śrīla Prabhupāda"></div>
      <div>
        <p>“Chant Hare Krishna and be happy.”</p>
        <div class="attrib">Śrīla Prabhupāda</div>
      </div>
    </div>`;
  }

  function mantraBlock() {
    return `<div class="mantra-block">
      <div class="gold-divider"><span class="line"></span><span class="dot"></span><span class="line"></span></div>
      <p class="mantra-dev">हरे कृष्ण हरे कृष्ण कृष्ण कृष्ण हरे हरे<br>हरे राम हरे राम राम राम हरे हरे</p>
      <p class="mantra-lat">HARE KṚṢṆA HARE KṚṢṆA KṚṢṆA KṚṢṆA HARE HARE<br>HARE RĀMA HARE RĀMA RĀMA RĀMA HARE HARE</p>
    </div>`;
  }

  /* ----- Devotee: Together ----- */

  function viewTogether() {
    const ev = displayEvent();
    if (!ev) {
      return `<div class="pad-lg">
        <h2 class="h-serif" style="font-size:25px;margin:0 0 4px">🌸 Japa Seva</h2>
        <p style="margin:0 0 18px;font-size:13px;color:var(--muted)">No event yet — the group offering will appear here.</p>
      </div>`;
    }
    const g = groupTotals(ev);
    const people = boardPeople(ev).filter(p => p.rounds > 0);
    const top = people.length ? people[0].rounds : 1;
    const marks = ['🥇', '🥈', '🥉'];
    const vis = ev.visibility;

    const stats = [
      { label: 'Total rounds', value: fmt(g.total) },
      { label: 'Participants', value: String(g.submitted) },
      { label: 'Average', value: g.submitted ? (g.total / g.submitted).toFixed(1) : '0' },
      { label: 'Highest', value: String(top) }
    ];

    let board;
    if (vis === 'admin') {
      board = `<div class="private-card">
        <div class="flower">🪷</div>
        <p class="big">Individual rounds are kept private for this event.</p>
        <p class="small">Only temple admins can see each devotee’s submission. The group total above is everyone’s offering together.</p>
      </div>`;
    } else {
      board = `<div class="board">
        ${people.map((p, i) => `
          <div class="board-row${p.me ? ' me' : ''}">
            <div class="bar" style="width:${Math.round((p.rounds / top) * 100)}%;background:${i < 3 ? 'rgba(217,119,46,.10)' : 'rgba(176,138,62,.07)'}"></div>
            <div class="mark">${i < 3 ? marks[i] : i + 1}</div>
            <div class="who">
              <div class="nm">${esc(vis === 'ids' ? p.id : p.name)}</div>
              <div class="sb">${vis === 'ids' ? (p.me ? 'You' : 'Devotee') : (p.me ? 'You · ' + esc(p.id) : esc(p.id))}</div>
            </div>
            <div class="cnt"><div class="n">${p.rounds}</div><div class="u">rounds</div></div>
          </div>`).join('')}
      </div>
      <p class="board-note">Not a competition — a shared offering.<br>${vis === 'ids' ? 'Shown by Devotee ID for this event.' : 'Shown by name for this event.'}</p>`;
    }

    return `<div class="pad-lg">
      <h2 class="h-serif" style="font-size:25px;margin:0 0 4px">🌸 Japa Seva</h2>
      <p style="margin:0 0 18px;font-size:13px;color:var(--muted)">Together we chant — ${ev.name.indexOf('Ekadashi') === 0 ? 'Ekadashi, ' : ''}${esc(fmtDateShort(ev.date))}</p>
      <div class="stat-grid">
        ${stats.map(s => `<div class="stat-tile"><div class="lbl">${s.label}</div><div class="val">${s.value}</div></div>`).join('')}
      </div>
      ${board}
    </div>`;
  }

  /* ----- Devotee: Journey ----- */

  function viewJourney() {
    const items = [];
    const act = activeEvent();
    if (act) {
      const sub = state.mySubmissions[act.id];
      items.push({
        date: act.date, title: act.name,
        rounds: sub ? sub.rounds : 0,
        note: sub ? `Today · updated at ${sub.time}` : 'Today · not recorded yet',
        dot: '#D9772E'
      });
    }
    state.events
      .filter(e => e.status === 'closed' && state.mySubmissions[e.id])
      .sort((a, b) => b.date.localeCompare(a.date))
      .forEach(e => {
        const g = groupTotals(e);
        items.push({
          date: e.date, title: e.name,
          rounds: state.mySubmissions[e.id].rounds,
          note: `Group offered ${fmt(g.total)} rounds`,
          dot: '#B08A3E'
        });
      });

    const total = lifetime();
    const count = Object.keys(state.mySubmissions).length;

    return `<div class="pad-lg">
      <h2 class="h-serif" style="font-size:25px;margin:0 0 4px">Your Japa Journey</h2>
      <p style="margin:0 0 20px;font-size:13px;color:var(--muted)">${fmt(total)} rounds across ${count} event${count === 1 ? '' : 's'} with the group</p>
      <div class="timeline">
        <div class="rail"></div>
        ${items.map(h => `
          <div class="tl-item">
            <div class="dot" style="background:${h.dot}"></div>
            <div class="tl-card">
              <div class="tl-top">
                <div>
                  <div class="tl-date">${esc(fmtDateShort(h.date))}</div>
                  <div class="tl-title">${esc(h.title)}</div>
                </div>
                <div style="flex:none">
                  <div class="tl-rounds">🪷 ${h.rounds}</div>
                  <div class="tl-unit">rounds</div>
                </div>
              </div>
              <div class="tl-note">${esc(h.note)}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  /* ----- Me (shared) ----- */

  function viewMe() {
    const u = state.user;
    const total = lifetime();
    const count = Object.keys(state.mySubmissions).length;
    const rows = [
      { label: 'Devotee ID', value: u.devoteeId },
      { label: 'Mobile', value: u.phone },
      { label: 'Email', value: u.email },
      { label: 'Group', value: u.group }
    ];
    return `<div class="pad-lg">
      <div class="card profile-card">
        <div class="avatar">${esc(u.name[0] || 'D')}</div>
        <div class="profile-name">${esc(u.name)}</div>
        <div class="profile-id">${esc(u.devoteeId)}</div>
        <div class="profile-stats">
          <div class="profile-stat"><div class="n">${fmt(total)}</div><div class="l">Total rounds</div></div>
          <div class="profile-stat"><div class="n">${count}</div><div class="l">Events joined</div></div>
        </div>
      </div>
      <div class="profile-rows">
        ${rows.map(r => `<div class="profile-row"><span class="l">${r.label}</span><span class="v">${esc(r.value)}</span></div>`).join('')}
      </div>
      <button type="button" class="btn-outline" data-action="sign-out">Sign out</button>
      <p class="me-footer">Chant • Remember • Serve</p>
    </div>`;
  }

  /* ----- Admin: Overview ----- */

  function viewAdminOverview() {
    const ev = activeEvent();
    const g = groupTotals(ev);
    const people = ev ? boardPeople(ev).filter(p => p.rounds > 0) : [];
    const pct = Math.round((g.submitted / TOTAL_DEVOTEES) * 100);

    const stats = ev ? [
      { label: 'Active event', value: ev.name.split(' ')[0], sub: `${fmtDateShort(ev.date).slice(0, 6)} · closes ${ev.end}` },
      { label: 'Total devotees', value: String(TOTAL_DEVOTEES), sub: '4 added this month' },
      { label: 'Total rounds', value: fmt(g.total), sub: 'today' },
      { label: 'Average rounds', value: g.submitted ? (g.total / g.submitted).toFixed(1) : '0', sub: 'per participant' }
    ] : [
      { label: 'Active event', value: '—', sub: 'none live' },
      { label: 'Total devotees', value: String(TOTAL_DEVOTEES), sub: '4 added this month' },
      { label: 'Total rounds', value: '—', sub: 'no event' },
      { label: 'Average rounds', value: '—', sub: 'no event' }
    ];

    return `<div class="pad-lg">
      <div class="admin-hero">
        <div class="jali"></div>
        <div class="inner">
          <div class="eyebrow">Hare Krishna Marwad Mandir</div>
          <h2>Admin Dashboard</h2>
          <div class="live-line">
            <span class="live-dot${ev ? '' : ' off'}"></span>
            ${ev ? `${esc(ev.name)} · live until ${esc(ev.end)}` : 'No event is live right now'}
          </div>
        </div>
      </div>

      <div class="stat-grid" style="margin:14px 0 0">
        ${stats.map(s => `<div class="stat-tile"><div class="lbl">${s.label}</div><div class="val">${esc(s.value)}</div><div class="sub">${esc(s.sub)}</div></div>`).join('')}
      </div>

      <div class="admin-panel">
        <span class="eyebrow">Participation</span>
        <div class="progress-track"><div class="progress-fill" style="width:${ev ? pct : 0}%"></div></div>
        <div class="panel-meta">
          <span>${ev ? `${g.submitted} of ${TOTAL_DEVOTEES} devotees have submitted` : 'Waiting for the next event'}</span>
          <span style="color:var(--gold-label)">${ev ? pct + '%' : ''}</span>
        </div>
        <div class="panel-rule"></div>
        <div class="btn-row">
          <button type="button" class="btn-solid-sm" data-action="new-event">New event</button>
          <button type="button" class="btn-ghost-sm" data-action="export-csv">Export CSV</button>
        </div>
      </div>

      ${people.length ? `<div class="top-list">
        <div class="hd">Top offerings today</div>
        ${people.slice(0, 4).map((p, i) => `
          <div class="top-row">
            <div class="rk">${i + 1}</div>
            <div class="who"><div class="nm">${esc(p.name)}</div><div class="sb">${esc(p.id)} · ${esc(p.time)}</div></div>
            <div class="n">${p.rounds}</div>
          </div>`).join('')}
      </div>` : ''}
    </div>`;
  }

  /* ----- Admin: Events ----- */

  function eventMeta(e) {
    const g = groupTotals(e);
    switch (e.status) {
      case 'active':   return `${g.submitted} of ${TOTAL_DEVOTEES} submitted · ${e.start}–${e.end}`;
      case 'upcoming': return `Leaderboard: ${e.visibility === 'names' ? 'names visible' : e.visibility === 'ids' ? 'devotee IDs' : 'admin only'}`;
      case 'closed':   return `${g.submitted} participants · ${fmt(g.total)} rounds`;
      default:         return 'Not published yet';
    }
  }
  function eventPrimary(e) {
    switch (e.status) {
      case 'active':   return { label: 'Close event', action: 'close-event' };
      case 'upcoming': return { label: 'Activate', action: 'activate-event' };
      case 'closed':   return { label: 'Reopen', action: 'reopen-event' };
      default:         return { label: 'Edit', action: 'edit-event' };
    }
  }

  function viewAdminEvents() {
    const order = { active: 0, upcoming: 1, draft: 2, closed: 3 };
    const events = [...state.events].sort((a, b) =>
      (order[a.status] - order[b.status]) || b.date.localeCompare(a.date));
    return `<div class="pad-lg">
      <div class="admin-header-row">
        <h2 class="h-serif" style="font-size:24px;margin:0">Events</h2>
        <button type="button" class="btn-saffron" data-action="new-event">+ New</button>
      </div>
      ${events.map(e => {
        const p = eventPrimary(e);
        return `<div class="event-item">
          <div class="top">
            <span class="dt">${esc(fmtDateShort(e.date))}</span>
            <span class="chip ${e.status}">${e.status.charAt(0).toUpperCase() + e.status.slice(1)}</span>
          </div>
          <div class="nm">${esc(e.name)}</div>
          <div class="meta">${esc(eventMeta(e))}</div>
          <div class="event-actions">
            <button type="button" data-action="${p.action}" data-id="${e.id}">${p.label}</button>
            <button type="button" data-action="event-results" data-id="${e.id}">Results</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  /* ----- Admin: Devotees ----- */

  function viewAdminDevotees() {
    return `<div class="pad-lg">
      <h2 class="h-serif" style="font-size:24px;margin:0 0 14px">Devotees</h2>
      <input type="text" id="devotee-search" class="search-field" placeholder="Search name or devotee ID">
      <div id="devotee-list-wrap">${devoteeListHtml()}</div>
    </div>`;
  }

  function devoteeListHtml() {
    const ev = displayEvent();
    const q = ui.query.trim().toLowerCase();
    const people = boardPeople(ev)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    const rows = people.map(p => {
      const inactive = p.id === 'HKMM042';
      return `<div class="devotee-row">
        <div class="av">${esc(p.name[0])}</div>
        <div class="who">
          <div class="nm">${esc(p.name)}</div>
          <div class="sb">${esc(p.id)} · ${esc(p.phone)}</div>
        </div>
        <div class="cnt">
          <div class="n">${p.rounds}</div>
          <div class="st" style="color:${inactive ? '#B0836A' : '#5F8A66'}">${inactive ? 'Inactive' : 'Active'}</div>
        </div>
      </div>`;
    }).join('');
    return `<div class="list-meta"><span>${people.length} devotee${people.length === 1 ? '' : 's'}</span><span>Sorted by rounds</span></div>
      <div class="devotee-list">${rows}</div>
      ${people.length === 0 ? `<p class="empty-note">No devotee matches “${esc(ui.query)}”.</p>` : ''}`;
  }

  function renderDevoteeList() {
    const wrap = $('#devotee-list-wrap');
    if (wrap) wrap.innerHTML = devoteeListHtml();
  }

  /* ---------- Rounds sheet (keypad) ---------- */

  function openRoundsSheet() {
    const ev = activeEvent();
    if (!ev) return;
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
      const val = parseInt(nx, 10);
      if (val > MAX_ROUNDS) { ui.draft = String(MAX_ROUNDS); ui.capped = true; }
      else { ui.draft = nx; ui.capped = false; }
    }
    updateDraftBox();
  }

  function updateDraftBox() {
    const ev = activeEvent();
    const cur = myRounds(ev);
    const num = $('#draft-num'), hint = $('#draft-hint');
    if (!num) return;
    num.textContent = ui.draft === '' ? String(cur) : ui.draft;
    num.style.color = ui.draft === '' ? 'rgba(74,27,31,.28)' : '#4A1B1F';
    hint.textContent = ui.capped ? `Maximum ${MAX_ROUNDS} rounds`
      : (ui.draft === '' ? 'Currently recorded — type to replace' : 'Rounds');
    hint.style.color = ui.capped ? '#8C2F26' : '#A8845A';
  }

  function saveRounds() {
    const ev = activeEvent();
    if (!ev || ui.draft === '') { closeOverlay(); return; }
    const val = Math.min(MAX_ROUNDS, parseInt(ui.draft, 10) || 0);
    const first = myRounds(ev) === 0;
    state.mySubmissions[ev.id] = { rounds: val, time: nowTime() };
    persist();
    closeOverlay();
    render();
    toast(first
      ? 'Hare Krishna! Your chanting has been recorded.'
      : `Rounds updated — ${val} offered today.`);
  }

  /* ---------- Event form sheet ---------- */

  function openEventForm(editId) {
    ui.sheet = 'event-form';
    ui.editEventId = editId || null;
    renderOverlay();
  }

  function submitEventForm() {
    const name = $('#ef-name').value.trim() || 'Ekadashi Japa Seva';
    const date = $('#ef-date').value || new Date().toISOString().slice(0, 10);
    const status = $('#ef-status').value;
    const start = $('#ef-start').value || '00:00';
    const end = $('#ef-end').value || '23:59';
    const goal = Math.max(100, parseInt($('#ef-goal').value, 10) || 3000);
    const desc = $('#ef-desc').value.trim();
    const visEl = $('.vis-option.on');
    const visibility = visEl ? visEl.dataset.vis : 'names';

    if (status === 'active') {
      state.events.forEach(e => { if (e.status === 'active') e.status = 'closed'; });
    }
    if (ui.editEventId) {
      const e = state.events.find(x => x.id === ui.editEventId);
      if (e) Object.assign(e, { name, date, status, start, end, goal, desc, visibility });
    } else {
      state.events.push({
        id: 'e' + Date.now(), name, date, status, start, end, goal, desc, visibility
      });
    }
    persist();
    closeOverlay();
    render();
    toast(ui.editEventId ? 'Event updated.' : 'Japa event created.');
    ui.editEventId = null;
  }

  /* ---------- Admin event actions ---------- */

  function setEventStatus(id, status) {
    const e = state.events.find(x => x.id === id);
    if (!e) return;
    if (status === 'active') {
      state.events.forEach(x => { if (x.status === 'active' && x.id !== id) x.status = 'closed'; });
    }
    e.status = status;
    persist();
    render();
    toast(status === 'active' ? `${e.name} is now live.` : status === 'closed' ? 'Event closed. Hare Krishna!' : 'Event updated.');
  }

  function showResults(id) {
    const e = state.events.find(x => x.id === id);
    if (!e) return;
    ui.sheet = 'results';
    ui.resultsEventId = id;
    renderOverlay();
  }

  function exportCsv() {
    const ev = activeEvent() || lastClosed();
    if (!ev) { toast('No event to export yet.'); return; }
    const people = boardPeople(ev);
    const rows = [['Name', 'Devotee ID', 'Rounds', 'Names chanted', 'Time']];
    people.forEach(p => rows.push([p.name, p.id, p.rounds, p.rounds * NAMES_PER_ROUND, p.time]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ev.name.replace(/\s+/g, '-')}-${ev.date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast('CSV exported.');
  }

  /* ---------- Overlays ---------- */

  function renderOverlay() {
    const root = $('#overlay-root');
    if (!ui.sheet) { root.innerHTML = ''; return; }

    if (ui.sheet === 'rounds') {
      const ev = activeEvent();
      const cur = myRounds(ev);
      const keyDefs = ['1','2','3','4','5','6','7','8','9','clr','0','del'];
      root.innerHTML = `<div class="overlay">
        <div class="scrim" data-action="close-overlay"></div>
        <div class="sheet">
          <div class="grabber"></div>
          <h3 style="text-align:center">How many rounds have you completed?</h3>
          <p class="sheet-sub">${esc(ev.name)} · you can update this any time today</p>
          <div class="draft-box">
            <div class="draft-num" id="draft-num" style="color:rgba(74,27,31,.28)">${cur}</div>
            <div class="draft-hint" id="draft-hint" style="color:#A8845A">Currently recorded — type to replace</div>
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
      const edit = ui.editEventId ? state.events.find(x => x.id === ui.editEventId) : null;
      const e = edit || {
        name: 'Ekadashi Japa Seva',
        date: (nextUpcoming() || {}).date || '',
        status: 'upcoming', start: '00:00', end: '23:59', goal: 3000,
        visibility: 'names',
        desc: 'Offer your chanting with devotion. Rounds can be updated until midnight.'
      };
      const visOpts = [
        { key: 'names', label: 'Public within group', desc: 'Everyone sees name + rounds' },
        { key: 'ids',   label: 'Anonymous leaderboard', desc: 'Everyone sees Devotee ID + rounds' },
        { key: 'admin', label: 'Admin only', desc: 'Only admins see individual submissions' }
      ];
      root.innerHTML = `<div class="overlay">
        <div class="scrim" data-action="close-overlay"></div>
        <div class="sheet">
          <div class="grabber"></div>
          <h3>${edit ? 'Edit Japa Event' : 'New Japa Event'}</h3>
          <div class="form-col" style="margin-top:16px">
            <div><label class="field-label" for="ef-name">Event name</label>
              <input class="field" id="ef-name" type="text" value="${esc(e.name)}"></div>
            <div class="form-row">
              <div><label class="field-label" for="ef-date">Date</label>
                <input class="field" id="ef-date" type="date" value="${esc(e.date)}"></div>
              <div><label class="field-label" for="ef-status">Status</label>
                <select class="field" id="ef-status">
                  ${['upcoming', 'active', 'draft'].map(s =>
                    `<option value="${s}"${e.status === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
                </select></div>
            </div>
            <div class="form-row">
              <div><label class="field-label" for="ef-start">Starts</label>
                <input class="field" id="ef-start" type="time" value="${esc(e.start)}"></div>
              <div><label class="field-label" for="ef-end">Ends</label>
                <input class="field" id="ef-end" type="time" value="${esc(e.end)}"></div>
            </div>
            <div><label class="field-label" for="ef-goal">Group goal (rounds)</label>
              <input class="field" id="ef-goal" type="number" min="100" step="100" value="${e.goal}"></div>
            <div><label class="field-label" for="ef-desc">Description</label>
              <textarea class="field" id="ef-desc">${esc(e.desc || '')}</textarea></div>
            <div>
              <div class="field-label" style="margin-bottom:7px">Leaderboard visibility</div>
              <div class="form-col" style="gap:7px">
                ${visOpts.map(v => `
                  <div class="vis-option${e.visibility === v.key ? ' on' : ''}" data-vis="${v.key}">
                    <div class="radio"><i></i></div>
                    <div><div class="t">${v.label}</div><div class="d">${v.desc}</div></div>
                  </div>`).join('')}
              </div>
            </div>
          </div>
          <button type="button" class="btn-primary" data-action="submit-event-form">${edit ? 'Save Changes' : 'Create Event'}</button>
          <button type="button" class="btn-cancel" data-action="close-overlay">Cancel</button>
        </div>
      </div>`;
      return;
    }

    if (ui.sheet === 'results') {
      const e = state.events.find(x => x.id === ui.resultsEventId);
      if (!e) { closeOverlay(); return; }
      const g = groupTotals(e);
      const mine = myRounds(e);
      root.innerHTML = `<div class="overlay">
        <div class="scrim" data-action="close-overlay"></div>
        <div class="modal-center">
          <div class="modal-card">
            <span class="chip ${e.status}" style="position:absolute;top:20px;right:18px">${e.status.charAt(0).toUpperCase() + e.status.slice(1)}</span>
            <div class="eyebrow" style="margin-bottom:6px">${esc(fmtDateShort(e.date))}</div>
            <h3 style="margin:0 0 14px">${esc(e.name)}</h3>
            <div class="stat-grid" style="margin-bottom:0">
              <div class="stat-tile"><div class="lbl">Total rounds</div><div class="val">${fmt(g.total)}</div></div>
              <div class="stat-tile"><div class="lbl">Participants</div><div class="val">${g.submitted}</div></div>
              <div class="stat-tile"><div class="lbl">Average</div><div class="val">${g.submitted ? (g.total / g.submitted).toFixed(1) : '0'}</div></div>
              <div class="stat-tile"><div class="lbl">Your rounds</div><div class="val">${mine}</div></div>
            </div>
            <button type="button" class="btn-cancel" data-action="close-overlay" style="margin-top:12px">Close</button>
          </div>
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
    const root = $('#overlay-root');
    clearTimeout(ui.toastTimer);
    const wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.innerHTML = `<div class="toast-card"><div class="lotus">🪷</div><p>${esc(text)}</p></div>`;
    root.appendChild(wrap);
    ui.toastTimer = setTimeout(() => wrap.remove(), 1900);
  }

  /* ---------- Event wiring ---------- */

  document.addEventListener('click', ev => {
    const t = ev.target.closest('[data-action],[data-tab],[data-role],[data-key],.vis-option');
    if (!t) return;

    if (t.dataset.role) {
      const role = t.dataset.role;
      if (role !== state.role) {
        state.role = role;
        state.tab = role === 'admin' ? 'aOverview' : 'japa';
        closeOverlay();
        persist();
        render();
      }
      return;
    }
    if (t.dataset.tab) {
      state.tab = t.dataset.tab;
      persist();
      render();
      return;
    }
    if (t.dataset.key) { pressKey(t.dataset.key); return; }
    if (t.classList.contains('vis-option')) {
      document.querySelectorAll('.vis-option').forEach(o => o.classList.toggle('on', o === t));
      return;
    }

    switch (t.dataset.action) {
      case 'open-sheet':       if (activeEvent()) openRoundsSheet(); break;
      case 'close-overlay':    closeOverlay(); break;
      case 'save-rounds':      saveRounds(); break;
      case 'goto-together':    ev.preventDefault(); state.tab = 'together'; persist(); render(); break;
      case 'sign-out':         signOut(); break;
      case 'new-event':        openEventForm(null); break;
      case 'edit-event':       openEventForm(t.dataset.id); break;
      case 'submit-event-form': submitEventForm(); break;
      case 'close-event':      setEventStatus(t.dataset.id, 'closed'); break;
      case 'activate-event':   setEventStatus(t.dataset.id, 'active'); break;
      case 'reopen-event':     setEventStatus(t.dataset.id, 'active'); break;
      case 'event-results':    showResults(t.dataset.id); break;
      case 'export-csv':       exportCsv(); break;
    }
  });

  /* ---------- Boot ---------- */

  initAuth();
  if (state.user) {
    $('#welcome').classList.add('hidden');
    $('#app').classList.remove('hidden');
    render();
  }
})();
