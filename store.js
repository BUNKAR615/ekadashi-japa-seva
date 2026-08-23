/* ============================================================
   Data layer for Ekadashi Japa Seva.

   Exposes one async API (window.JapaStore) with two implementations:

     SupabaseStore — real shared backend, used when config.js has keys
     DemoStore     — localStorage only, used otherwise

   The app talks to this module and never to Supabase directly, so the
   two modes stay interchangeable.

   Rounds are recorded per devotee per DAY (entry_date), so multi-day
   challenges accumulate and "daily progress" ranking works.
   ============================================================ */
(function () {
  'use strict';

  const MAX_ROUNDS = 216;

  const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const localTime = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toTimeString().slice(0, 5);
  };

  /* ================= Demo (localStorage) ================= */

  const LS_KEY = 'japaSeva.v1';

  const OTHERS = [
    { name: 'Rahul Vyas',     id: 'HKMM014', phone: '+91 98280 11402', rounds: 60, time: '17:31' },
    { name: 'Amit Purohit',   id: 'HKMM008', phone: '+91 98290 55317', rounds: 48, time: '19:05' },
    { name: 'Sanjay Bishnoi', id: 'HKMM021', phone: '+91 94140 78226', rounds: 42, time: '16:12' },
    { name: 'Kunal Rathore',  id: 'HKMM003', phone: '+91 98875 30194', rounds: 36, time: '20:04' },
    { name: 'Nikhil Joshi',   id: 'HKMM037', phone: '+91 96360 42871', rounds: 32, time: '15:48' },
    { name: 'Vivek Suthar',   id: 'HKMM042', phone: '+91 97830 66508', rounds: 28, time: '21:10' },
    { name: 'Harsh Solanki',  id: 'HKMM011', phone: '+91 99280 13645', rounds: 24, time: '13:26' }
  ];
  const UNNAMED_BASE = 2102;
  const TOTAL_DEVOTEES = 87;
  const OTHERS_SUBMITTED = 73;

  function seedEvents() {
    const iso = d => d.toISOString().slice(0, 10);
    const today = new Date();
    const shift = n => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
    const base = { starts_at: '00:00', ends_at: '23:59', goal_rounds: 3000, visibility: 'names', rank_by: 'total', featured: false };
    return [
      Object.assign({}, base, { id: 'e1', name: 'Ekadashi Japa Seva', event_date: iso(today), end_date: iso(today), status: 'active',
        description: 'Offer your chanting with devotion. Rounds can be updated until midnight.' }),
      Object.assign({}, base, { id: 'e2', name: 'Ekadashi Japa Seva', event_date: shift(14), end_date: shift(14), status: 'upcoming', description: '' }),
      Object.assign({}, base, { id: 'e3', name: 'Ekadashi Japa Seva', event_date: shift(-17), end_date: shift(-17), status: 'closed',
        description: '', baseRounds: 1908, baseParticipants: 68 }),
      Object.assign({}, base, { id: 'e5', name: 'Ekadashi Japa Seva', event_date: shift(-32), end_date: shift(-32), status: 'closed',
        description: '', baseRounds: 1642, baseParticipants: 61 }),
      Object.assign({}, base, { id: 'e0', name: 'Purushottama Japa Retreat', event_date: shift(-46), end_date: shift(-40), status: 'closed',
        description: '', baseRounds: 2204, baseParticipants: 70 }),
      Object.assign({}, base, { id: 'e4', name: 'Janmashtami Maha-Japa', event_date: shift(18), end_date: shift(18), status: 'draft', goal_rounds: 4000,
        description: 'A special maha-japa offering for Sri Krishna Janmashtami.' })
    ];
  }

  function DemoStore() {
    let s;
    try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { s = null; }
    if (!s) {
      s = {
        user: null,
        events: seedEvents(),
        mySubmissions: { e3: { rounds: 32, time: '18:12' }, e5: { rounds: 24, time: '19:40' }, e0: { rounds: 48, time: '17:05' } },
        adminOverrides: {}
      };
    }
    // Normalise states saved by older versions.
    s.adminOverrides = s.adminOverrides || {};
    (s.events || []).forEach(e => {
      if (!e.end_date) e.end_date = e.event_date;
      if (!e.rank_by) e.rank_by = 'total';
      if (e.featured == null) e.featured = false;
    });

    const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {} };
    const now = () => new Date().toTimeString().slice(0, 5);
    const ev = id => s.events.find(e => e.id === id);
    const isAdminId = id => id === 'HKMM001'
      ? (s.adminOverrides[id] !== undefined ? s.adminOverrides[id] : true)
      : !!s.adminOverrides[id];

    function people(eventId) {
      const list = OTHERS.map(o => ({
        userId: o.id, name: o.name, devoteeId: o.id, phone: o.phone,
        rounds: o.rounds, total: o.rounds, today: o.rounds, time: o.time,
        me: false, isAdmin: isAdminId(o.id)
      }));
      if (s.user) {
        const sub = s.mySubmissions[eventId];
        const r = sub ? sub.rounds : 0;
        list.push({
          userId: s.user.devoteeId, name: s.user.name, devoteeId: s.user.devoteeId, phone: s.user.phone,
          rounds: r, total: r, today: r, time: sub ? sub.time : '—',
          me: true, isAdmin: isAdminId(s.user.devoteeId)
        });
      }
      return list.sort((a, b) => b.total - a.total);
    }

    return {
      mode: 'demo',
      isDemo: true,

      async currentUser() {
        if (s.user) s.user.isAdmin = isAdminId(s.user.devoteeId);
        return s.user;
      },

      async signIn(email) {
        if (!s.user) {
          s.user = {
            name: email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            email, devoteeId: 'HKMM001', phone: '+91 98280 41172',
            group: 'Jodhpur Youth Bhakti Vriksha', isAdmin: isAdminId('HKMM001')
          };
        } else { s.user.email = email; }
        save();
        return this.currentUser();
      },

      async signUp(email, _pass, name) {
        s.user = {
          name, email, devoteeId: 'HKMM001', phone: '+91 98280 41172',
          group: 'Jodhpur Youth Bhakti Vriksha', isAdmin: isAdminId('HKMM001')
        };
        save();
        return { user: await this.currentUser(), needsConfirmation: false };
      },

      async signOut() { s.user = null; save(); },

      async listEvents() { return s.events.slice(); },

      async myRounds(eventId) {
        const sub = s.mySubmissions[eventId];
        return sub ? sub.rounds : 0;
      },

      async saveRounds(eventId, rounds) {
        s.mySubmissions[eventId] = { rounds: Math.min(MAX_ROUNDS, rounds), time: now() };
        save();
      },

      async eventTotals(eventId) {
        const e = ev(eventId);
        if (!e) return { total: 0, participants: 0, average: 0, highest: 0, capacity: 0 };
        const mine = (s.mySubmissions[eventId] || {}).rounds || 0;
        if (e.status === 'closed' && e.baseRounds) {
          const p = e.baseParticipants || 0;
          return {
            total: e.baseRounds, participants: p,
            average: p ? +(e.baseRounds / p).toFixed(1) : 0,
            highest: 64, capacity: TOTAL_DEVOTEES
          };
        }
        const named = OTHERS.reduce((t, o) => t + o.rounds, 0);
        const total = UNNAMED_BASE + named + mine;
        const participants = OTHERS_SUBMITTED + (mine > 0 ? 1 : 0);
        return {
          total, participants,
          average: participants ? +(total / participants).toFixed(1) : 0,
          highest: Math.max(mine, ...OTHERS.map(o => o.rounds)),
          capacity: TOTAL_DEVOTEES
        };
      },

      async leaderboard(eventId) { return people(eventId).filter(p => p.total > 0); },

      async devotees(eventId) { return people(eventId); },

      async myHistory() {
        return s.events
          .filter(e => s.mySubmissions[e.id])
          .map(e => ({
            eventId: e.id, name: e.name, date: e.event_date, status: e.status,
            rounds: s.mySubmissions[e.id].rounds, time: s.mySubmissions[e.id].time
          }))
          .sort((a, b) => b.date.localeCompare(a.date));
      },

      async createEvent(data) {
        if (data.status === 'active') s.events.forEach(e => { if (e.status === 'active') e.status = 'closed'; });
        s.events.push(Object.assign({ id: 'e' + Date.now(), featured: false }, data));
        save();
      },

      async updateEvent(id, data) {
        const e = ev(id);
        if (!e) return;
        if (data.status === 'active') s.events.forEach(x => { if (x.status === 'active' && x.id !== id) x.status = 'closed'; });
        Object.assign(e, data);
        save();
      },

      async setEventStatus(id, status) {
        const e = ev(id);
        if (!e) return;
        if (status === 'active') s.events.forEach(x => { if (x.status === 'active' && x.id !== id) x.status = 'closed'; });
        e.status = status;
        save();
      },

      async setAdmin(userId, makeAdmin) {
        if (!makeAdmin) {
          const remaining = people(null).filter(p => p.isAdmin && p.userId !== userId);
          if (remaining.length === 0) throw new Error('At least one admin must remain');
        }
        s.adminOverrides[userId] = makeAdmin;
        if (s.user && s.user.devoteeId === userId) s.user.isAdmin = makeAdmin;
        save();
      },

      async setFeatured(eventId) {
        s.events.forEach(e => { e.featured = !!eventId && e.id === eventId; });
        save();
      }
    };
  }

  /* ================= Supabase ================= */

  function SupabaseStore(sb) {
    let profile = null;

    async function loadProfile(userId) {
      // The profile is created by a trigger on signup. On the very first
      // sign-in that row can lag by a moment, so retry briefly instead of
      // failing the whole sign-in.
      let data = null, error = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        ({ data, error } = await sb
          .from('profiles')
          .select('id,name,devotee_id,group_name,is_admin')
          .eq('id', userId)
          .maybeSingle());
        if (data) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 400));
      }
      if (error) throw error;
      if (!data) throw new Error('Your devotee profile is still being set up. Please try signing in again in a moment.');
      return {
        id: data.id,
        name: data.name,
        devoteeId: data.devotee_id,
        group: data.group_name,
        isAdmin: data.is_admin,
        phone: ''
      };
    }

    function mapEvent(r) {
      return {
        id: r.id, name: r.name, event_date: r.event_date,
        end_date: r.end_date || r.event_date,
        status: r.status,
        starts_at: r.starts_at, ends_at: r.ends_at,
        goal_rounds: r.goal_rounds, visibility: r.visibility,
        rank_by: r.rank_by || 'total',
        featured: !!r.featured,
        description: r.description || ''
      };
    }

    return {
      mode: 'supabase',
      isDemo: false,

      async currentUser() {
        const { data } = await sb.auth.getSession();
        if (!data.session) { profile = null; return null; }
        if (!profile) profile = await loadProfile(data.session.user.id);
        profile.email = data.session.user.email;
        return profile;
      },

      async signIn(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error(friendly(error.message));
        profile = await loadProfile(data.user.id);
        profile.email = data.user.email;
        return profile;
      },

      async signUp(email, password, name) {
        const { data, error } = await sb.auth.signUp({
          email, password, options: { data: { name } }
        });
        if (error) throw new Error(friendly(error.message));
        // With email confirmation on, there is no session until the link is clicked.
        if (!data.session) return { user: null, needsConfirmation: true };
        profile = await loadProfile(data.user.id);
        profile.email = data.user.email;
        return { user: profile, needsConfirmation: false };
      },

      async signOut() { profile = null; await sb.auth.signOut(); },

      async listEvents() {
        const { data, error } = await sb
          .from('events')
          .select('*')
          .order('event_date', { ascending: false });
        if (error) throw error;
        return data.map(mapEvent);
      },

      // Today's rounds for this devotee.
      async myRounds(eventId) {
        const me = await this.currentUser();
        if (!me) return 0;
        const { data, error } = await sb
          .from('submissions')
          .select('rounds')
          .eq('event_id', eventId)
          .eq('user_id', me.id)
          .eq('entry_date', todayStr())
          .maybeSingle();
        if (error) throw error;
        return data ? data.rounds : 0;
      },

      async saveRounds(eventId, rounds) {
        const me = await this.currentUser();
        if (!me) throw new Error('Please sign in again.');
        const { error } = await sb.from('submissions').upsert({
          event_id: eventId,
          user_id: me.id,
          entry_date: todayStr(),
          rounds: Math.min(MAX_ROUNDS, rounds),
          updated_at: new Date().toISOString()
        }, { onConflict: 'event_id,user_id,entry_date' });
        if (error) {
          // RLS rejects writes once an event is closed.
          throw new Error(/row-level security/i.test(error.message)
            ? 'This event is closed, so rounds can no longer be changed.'
            : error.message);
        }
      },

      async eventTotals(eventId) {
        const { data, error } = await sb.rpc('event_totals', { p_event: eventId });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true });
        return {
          total: Number(row ? row.total : 0),
          participants: Number(row ? row.participants : 0),
          average: Number(row ? row.average : 0),
          highest: Number(row ? row.highest : 0),
          capacity: count || 0
        };
      },

      // One row per devotee: {total, today, time}. Visibility is enforced
      // by RLS — for 'admin'/'off' events non-admins get no rows back.
      async leaderboard(eventId) {
        const me = await this.currentUser();
        const { data, error } = await sb
          .from('submissions')
          .select('rounds,entry_date,updated_at,user_id,profiles(name,devotee_id)')
          .eq('event_id', eventId)
          .gt('rounds', 0);
        if (error) throw error;
        const today = todayStr();
        const byUser = {};
        data.forEach(r => {
          const u = byUser[r.user_id] || (byUser[r.user_id] = {
            userId: r.user_id,
            name: r.profiles ? r.profiles.name : 'Devotee',
            devoteeId: r.profiles ? r.profiles.devotee_id : '—',
            total: 0, today: 0, time: '', _t: '',
            me: !!me && r.user_id === me.id,
            phone: ''
          });
          u.total += r.rounds;
          if (r.entry_date === today) u.today = r.rounds;
          if (!u._t || (r.updated_at || '') > u._t) { u._t = r.updated_at || ''; u.time = localTime(r.updated_at); }
        });
        return Object.values(byUser).sort((a, b) => b.total - a.total);
      },

      async devotees(eventId) {
        const me = await this.currentUser();
        const { data: dir, error: dirErr } = await sb.rpc('admin_devotees');
        if (dirErr) throw dirErr;
        const byUser = {};
        if (eventId) {
          const { data: subs } = await sb.from('submissions')
            .select('user_id,rounds,updated_at').eq('event_id', eventId);
          (subs || []).forEach(x => {
            const u = byUser[x.user_id] || (byUser[x.user_id] = { total: 0, _t: '' });
            u.total += x.rounds;
            if ((x.updated_at || '') > u._t) u._t = x.updated_at || '';
          });
        }
        return dir.map(p => {
          const sub = byUser[p.id];
          return {
            userId: p.id,
            name: p.name, devoteeId: p.devotee_id, phone: p.phone || '—',
            rounds: sub ? sub.total : 0,
            time: sub && sub._t ? localTime(sub._t) : '—',
            me: !!me && p.id === me.id,
            isAdmin: p.is_admin
          };
        }).sort((a, b) => b.rounds - a.rounds);
      },

      async myHistory() {
        const me = await this.currentUser();
        if (!me) return [];
        const { data, error } = await sb
          .from('submissions')
          .select('rounds,entry_date,updated_at,event_id,events(name,event_date,status)')
          .eq('user_id', me.id);
        if (error) throw error;
        const byEvent = {};
        data.filter(r => r.events).forEach(r => {
          const h = byEvent[r.event_id] || (byEvent[r.event_id] = {
            eventId: r.event_id, name: r.events.name, date: r.events.event_date,
            status: r.events.status, rounds: 0, time: '', _t: ''
          });
          h.rounds += r.rounds;
          if ((r.updated_at || '') > h._t) { h._t = r.updated_at || ''; h.time = localTime(r.updated_at); }
        });
        return Object.values(byEvent).sort((a, b) => b.date.localeCompare(a.date));
      },

      async createEvent(d) {
        if (d.status === 'active') await clearActive(sb);
        const { error } = await sb.from('events').insert(toRow(d));
        if (error) throw new Error(adminMsg(error));
      },

      async updateEvent(id, d) {
        if (d.status === 'active') await clearActive(sb, id);
        const { error } = await sb.from('events').update(toRow(d)).eq('id', id);
        if (error) throw new Error(adminMsg(error));
      },

      async setEventStatus(id, status) {
        if (status === 'active') await clearActive(sb, id);
        const { error } = await sb.from('events').update({ status }).eq('id', id);
        if (error) throw new Error(adminMsg(error));
      },

      async setAdmin(userId, makeAdmin) {
        const { error } = await sb.rpc('set_admin', { p_target: userId, p_admin: makeAdmin });
        if (error) throw new Error(error.message);
      },

      async setFeatured(eventId) {
        const { error } = await sb.rpc('set_featured_event', { p_event: eventId || null });
        if (error) throw new Error(error.message);
      }
    };

    function toRow(d) {
      return {
        name: d.name, event_date: d.event_date, end_date: d.end_date || d.event_date,
        status: d.status,
        starts_at: d.starts_at, ends_at: d.ends_at,
        goal_rounds: d.goal_rounds, visibility: d.visibility,
        rank_by: d.rank_by || 'total',
        description: d.description || ''
      };
    }
    async function clearActive(client, exceptId) {
      let q = client.from('events').update({ status: 'closed' }).eq('status', 'active');
      if (exceptId) q = q.neq('id', exceptId);
      await q;
    }
    function adminMsg(error) {
      return /row-level security/i.test(error.message)
        ? 'Only temple admins can change events.'
        : error.message;
    }
    function friendly(msg) {
      if (/Invalid login credentials/i.test(msg)) return 'That email and password do not match an account.';
      if (/User already registered/i.test(msg))   return 'An account with this email already exists — please sign in.';
      if (/Password should be/i.test(msg))        return 'Password must be at least 6 characters.';
      return msg;
    }
  }

  /* ================= Selection ================= */

  window.JapaStore = {
    async create() {
      const cfg = window.JAPA_CONFIG || {};
      const forceDemo = /[?&]demo=1/.test(location.search);
      if (!forceDemo && cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
        try {
          const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
          const store = SupabaseStore(client);
          await store.listEvents();   // fail fast if the project is unreachable
          return store;
        } catch (e) {
          console.warn('Supabase unavailable, falling back to demo mode:', e.message);
        }
      }
      return DemoStore();
    },
    MAX_ROUNDS
  };
})();
