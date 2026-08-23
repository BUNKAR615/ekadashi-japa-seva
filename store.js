/* ============================================================
   Data layer for Ekadashi Japa Seva.

   Exposes one async API (window.JapaStore) with two implementations:

     SupabaseStore — real shared backend, used when config.js has keys
     DemoStore     — localStorage only, used otherwise

   The app talks to this module and never to Supabase directly, so the
   two modes stay interchangeable.

   A challenge is one continuous window (start_at → end_at). Each
   devotee keeps a single running total for that window.
   ============================================================ */
(function () {
  'use strict';

  const MAX_ROUNDS = 216;

  const localTime = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toTimeString().slice(0, 5);
  };

  /* ================= Demo (localStorage) ================= */

  const LS_KEY = 'japaSeva.v1';

  // The single admin address. The real rule lives in the database
  // (admin_email() in supabase/schema.sql); this mirrors it for demo mode.
  const ADMIN_EMAIL = 'dineshbunkar533@gmail.com';

  // Demo mode carries no invented devotees or past challenges — it
  // mirrors a fresh install so it can never be mistaken for real data.
  const OTHERS = [];
  const TOTAL_DEVOTEES = 0;

  function seedEvents() {
    const now = new Date();
    const start = new Date(now); start.setHours(4, 30, 0, 0);
    const end = new Date(now);   end.setHours(21, 0, 0, 0);
    return [{
      id: 'e1',
      name: 'Ekadashi Japa Yagna',
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      status: 'active',
      goal_rounds: 3000,
      visibility: 'names',
      description: 'Offer your chanting with devotion.'
    }];
  }

  function DemoStore() {
    let s;
    try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { s = null; }
    if (!s) {
      s = {
        user: null,
        events: seedEvents(),
        mySubmissions: {}
      };
    }
    // Normalise states saved by older versions, and repair anything
    // corrupted so a bad payload can never break the app.
    if (!s || typeof s !== 'object') s = {};
    if (!Array.isArray(s.events) || s.events.length === 0) s.events = seedEvents();
    if (!s.mySubmissions || typeof s.mySubmissions !== 'object') s.mySubmissions = {};
    // Upgrade states saved under the older date-only model.
    (s.events || []).forEach(e => {
      if (!e.start_at) e.start_at = new Date((e.event_date || new Date().toISOString().slice(0, 10)) + 'T00:00').toISOString();
      if (!e.end_at) e.end_at = new Date((e.end_date || e.event_date || new Date().toISOString().slice(0, 10)) + 'T23:59').toISOString();
      delete e.event_date; delete e.end_date; delete e.starts_at; delete e.ends_at;
      delete e.rank_by; delete e.featured;
    });

    const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {} };
    const now = () => new Date().toTimeString().slice(0, 5);
    const ev = id => s.events.find(e => e.id === id);
    // Mirrors the backend rule: exactly one address is the admin.
    const isAdminEmail = email => String(email || '').toLowerCase() === ADMIN_EMAIL;

    function people(eventId) {
      const list = OTHERS.map(o => ({
        userId: o.id, name: o.name, devoteeId: o.id, phone: o.phone,
        rounds: o.rounds, total: o.rounds, time: o.time,
        me: false, isAdmin: false
      }));
      if (s.user) {
        const sub = s.mySubmissions[eventId];
        const r = sub ? sub.rounds : 0;
        list.push({
          userId: s.user.devoteeId, name: s.user.name, devoteeId: s.user.devoteeId, phone: s.user.phone,
          rounds: r, total: r, time: sub ? sub.time : '-',
          me: true, isAdmin: isAdminEmail(s.user.email)
        });
      }
      return list.sort((a, b) => b.total - a.total);
    }

    return {
      mode: 'demo',
      isDemo: true,

      async currentUser() {
        if (s.user) s.user.isAdmin = isAdminEmail(s.user.email);
        return s.user;
      },

      async signIn(email) {
        if (!s.user) {
          s.user = {
            name: email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            email, devoteeId: 'HKMM001', phone: '+91 98280 41172',
            group: 'Jodhpur Folk', isAdmin: isAdminEmail(email)
          };
        } else { s.user.email = email; }
        save();
        return this.currentUser();
      },

      async signUp(email, _pass, name) {
        s.user = {
          name, email, devoteeId: 'HKMM001', phone: '+91 98280 41172',
          group: 'Jodhpur Folk', isAdmin: isAdminEmail(email)
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
        const total = mine;
        const participants = mine > 0 ? 1 : 0;
        return {
          total, participants,
          average: participants ? +(total / participants).toFixed(1) : 0,
          highest: mine,
          capacity: Math.max(TOTAL_DEVOTEES, s.user ? 1 : 0)
        };
      },

      async leaderboard(eventId) { return people(eventId).filter(p => p.total > 0); },

      async devotees(eventId) { return people(eventId); },

      async myHistory() {
        return s.events
          .filter(e => s.mySubmissions[e.id])
          .map(e => ({
            eventId: e.id, name: e.name, date: e.start_at, status: e.status,
            rounds: s.mySubmissions[e.id].rounds, time: s.mySubmissions[e.id].time
          }))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      },

      async createEvent(data) {
        if (data.status === 'active') s.events.forEach(e => { if (e.status === 'active') e.status = 'closed'; });
        s.events.push(Object.assign({ id: 'e' + Date.now() }, data));
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
        id: r.id, name: r.name,
        start_at: r.start_at, end_at: r.end_at,
        status: r.status,
        goal_rounds: r.goal_rounds, visibility: r.visibility,
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
          .order('start_at', { ascending: false });
        if (error) throw error;
        return data.map(mapEvent);
      },

      // This devotee's running total for the challenge.
      async myRounds(eventId) {
        const me = await this.currentUser();
        if (!me) return 0;
        const { data, error } = await sb
          .from('submissions')
          .select('rounds')
          .eq('event_id', eventId)
          .eq('user_id', me.id)
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
          rounds: Math.min(MAX_ROUNDS, rounds),
          updated_at: new Date().toISOString()
        }, { onConflict: 'event_id,user_id' });
        if (error) {
          // RLS rejects writes outside the challenge window.
          throw new Error(/row-level security/i.test(error.message)
            ? 'This challenge is not open right now, so rounds cannot be changed.'
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

      // One row per devotee. Visibility is enforced by RLS — for
      // admin-only or disabled leaderboards non-admins get no rows back.
      async leaderboard(eventId) {
        const me = await this.currentUser();
        const { data, error } = await sb
          .from('submissions')
          .select('rounds,updated_at,user_id,profiles(name,devotee_id)')
          .eq('event_id', eventId)
          .gt('rounds', 0)
          .order('rounds', { ascending: false });
        if (error) throw error;
        return data.map(r => ({
          userId: r.user_id,
          name: r.profiles ? r.profiles.name : 'Devotee',
          devoteeId: r.profiles ? r.profiles.devotee_id : '-',
          total: r.rounds, rounds: r.rounds,
          time: localTime(r.updated_at),
          me: !!me && r.user_id === me.id,
          phone: ''
        }));
      },

      async devotees(eventId) {
        const me = await this.currentUser();
        const { data: dir, error: dirErr } = await sb.rpc('admin_devotees');
        if (dirErr) throw dirErr;
        const byUser = {};
        if (eventId) {
          const { data: subs } = await sb.from('submissions')
            .select('user_id,rounds,updated_at').eq('event_id', eventId);
          (subs || []).forEach(x => { byUser[x.user_id] = x; });
        }
        return dir.map(p => {
          const sub = byUser[p.id];
          return {
            userId: p.id,
            name: p.name, devoteeId: p.devotee_id, phone: p.phone || '-',
            rounds: sub ? sub.rounds : 0,
            time: sub ? localTime(sub.updated_at) : '-',
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
          .select('rounds,updated_at,event_id,events(name,start_at,status)')
          .eq('user_id', me.id);
        if (error) throw error;
        return data.filter(r => r.events).map(r => ({
          eventId: r.event_id, name: r.events.name, date: r.events.start_at,
          status: r.events.status, rounds: r.rounds, time: localTime(r.updated_at)
        })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
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

    };

    function toRow(d) {
      return {
        name: d.name,
        start_at: d.start_at, end_at: d.end_at,
        status: d.status,
        goal_rounds: d.goal_rounds, visibility: d.visibility,
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
      const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);

      if (!forceDemo && configured) {
        try {
          const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
          const store = SupabaseStore(client);
          await store.listEvents();   // fail fast if the project is unreachable
          return store;
        } catch (e) {
          // The backend is configured but not answering correctly — usually a
          // migration that has not been run. Falling back silently would show
          // local data as though it were the temple's, so say so loudly
          // instead: the store still works, but it is flagged as degraded.
          console.error('Cannot reach the temple database:', e.message);
          const store = DemoStore();
          store.degraded = true;
          store.degradedReason = e.message || 'The temple database did not respond as expected.';
          return store;
        }
      }
      return DemoStore();
    },
    MAX_ROUNDS
  };
})();
