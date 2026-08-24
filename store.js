/* ============================================================
   Data layer for Ekadashi Japa Seva.

   Exposes one async API (window.JapaStore) with two implementations:

     SupabaseStore — the temple database. Used whenever config.js has
                     keys, which is always in the deployed app.
     DemoStore     — localStorage, reachable ONLY by adding ?demo=1 to
                     the address. A deliberate developer opt-in.

   There is no automatic fallback between them. If the database is
   unreachable the app says so and offers to retry; it never quietly
   keeps rounds in the browser, because rounds kept there are invisible
   to the rest of the temple and to admins.

   A challenge is one continuous window (start_at → end_at). Each
   devotee keeps a single running total for that window, held in one
   submissions row keyed on (event_id, user_id) — so revising a count
   updates that row rather than adding another.
   ============================================================ */
(function () {
  'use strict';

  const MAX_ROUNDS = 216;

  const localTime = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toTimeString().slice(0, 5);
  };

  // A count of rounds is a whole number from 0 to MAX_ROUNDS. Anything
  // else — text, a negative, a fraction, Infinity — is refused here
  // rather than being quietly rounded into something the devotee did
  // not mean. The same rule is a check constraint in the database.
  function normaliseRounds(value) {
    const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10);
    if (!Number.isFinite(n)) throw new Error('Please enter the number of rounds.');
    if (n < 0)               throw new Error('Rounds cannot be a negative number.');
    if (!Number.isInteger(n)) throw new Error('Please enter a whole number of rounds.');
    if (n > MAX_ROUNDS)      throw new Error(`The most that can be recorded is ${MAX_ROUNDS} rounds.`);
    return n;
  }

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

      async myEntry(eventId) {
        const sub = s.mySubmissions[eventId];
        return sub ? { id: eventId, rounds: sub.rounds, updatedAt: sub.updatedAt || null } : null;
      },

      async myRounds(eventId) {
        const sub = s.mySubmissions[eventId];
        return sub ? sub.rounds : 0;
      },

      async saveRounds(eventId, rounds) {
        const value = normaliseRounds(rounds);
        s.mySubmissions[eventId] = {
          rounds: value, time: now(), updatedAt: new Date().toISOString()
        };
        save();
        return { id: eventId, rounds: value, updatedAt: s.mySubmissions[eventId].updatedAt };
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
        if (error) throw new Error(readMsg(error));
        return (data || []).map(mapEvent);
      },

      // This devotee's own row for the challenge, or null if they have
      // not offered anything yet.
      async myEntry(eventId) {
        const me = await this.currentUser();
        if (!me) return null;
        const { data, error } = await sb
          .from('submissions')
          .select('id,rounds,updated_at')
          .eq('event_id', eventId)
          .eq('user_id', me.id)
          .maybeSingle();
        if (error) throw error;
        return data ? { id: data.id, rounds: data.rounds, updatedAt: data.updated_at } : null;
      },

      // This devotee's running total for the challenge.
      async myRounds(eventId) {
        const entry = await this.myEntry(eventId);
        return entry ? entry.rounds : 0;
      },

      // Creating and revising are the same operation: the row is keyed
      // on (event_id, user_id), so an edit updates that one record in
      // place and can never leave a duplicate behind. Returns the row
      // the database actually stored, so the interface shows the saved
      // figure rather than the one that was typed.
      async saveRounds(eventId, rounds) {
        const me = await this.currentUser();
        if (!me) throw new Error('Please sign in again.');
        const value = normaliseRounds(rounds);

        const { data, error } = await sb.from('submissions').upsert({
          event_id: eventId,
          // Pinned to the signed-in devotee. Row level security refuses
          // any other value, so one devotee cannot edit another's entry.
          user_id: me.id,
          rounds: value,
          updated_at: new Date().toISOString()
        }, { onConflict: 'event_id,user_id' })
          .select('id,rounds,updated_at')
          .single();

        if (error) throw new Error(saveMsg(error));
        return { id: data.id, rounds: data.rounds, updatedAt: data.updated_at };
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
    // A project that has not had supabase/fix-003-persistence.sql run
    // against it still has the first-generation columns, and every read
    // fails with 42703. Name the cure rather than the Postgres error.
    function needsMigration(m) {
      return /column .*\b(start_at|end_at)\b.* does not exist/i.test(m)
          || /42703/.test(m)
          || /schema cache/i.test(m);
    }
    function readMsg(error) {
      const m = error.message || '';
      if (needsMigration(m)) {
        return 'The temple database needs its latest update. Run supabase/fix-003-persistence.sql in the Supabase SQL Editor, then reload.';
      }
      if (/Failed to fetch|NetworkError/i.test(m)) {
        return 'Could not reach the temple database. Please check your connection and try again.';
      }
      return m || 'The temple database did not respond. Please try again.';
    }
    function saveMsg(error) {
      const m = error.message || '';
      // RLS rejects writes outside the challenge window, and any attempt
      // to write against another devotee's user_id.
      if (/row-level security/i.test(m))        return 'This challenge is not open right now, so rounds cannot be changed.';
      if (/violates check constraint/i.test(m)) return `Please enter a whole number between 0 and ${MAX_ROUNDS}.`;
      if (needsMigration(m)) {
        return 'The temple database needs its latest update before rounds can be saved. Run supabase/fix-003-persistence.sql in the Supabase SQL Editor.';
      }
      if (/Failed to fetch|NetworkError/i.test(m)) {
        return 'Your rounds were not saved — the temple database could not be reached. Please try again.';
      }
      return m || 'Your rounds could not be saved. Please try again.';
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
    // When the temple database is configured, it is the only store. An
    // earlier version fell back to localStorage whenever the backend
    // hiccuped, which quietly turned every devotee's rounds into private
    // browser data that nobody else — not even an admin — could see.
    // A real failure is now reported where it happens instead.
    async create() {
      const cfg = window.JAPA_CONFIG || {};

      // ?demo=1 is a deliberate developer opt-in, never automatic.
      if (/[?&]demo=1/.test(location.search)) return DemoStore();

      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        throw new Error('The temple database is not configured yet. Add the Supabase project URL and publishable key to config.js.');
      }
      if (!window.supabase) {
        throw new Error('Could not load the database library. Please check your internet connection and reload.');
      }

      const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: {
          // The session lives in this browser so a reload or a return
          // visit keeps the devotee signed in; the rounds themselves
          // always live in Postgres.
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
      return SupabaseStore(client);
    },
    MAX_ROUNDS
  };
})();
