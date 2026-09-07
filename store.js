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

   ACCOUNTS
   --------
   The email address is the account. Everything a devotee has ever
   offered hangs off the account's auth id, and that id never changes,
   so recovering an address keeps every round attached to it. Names are
   not identifying: three devotees called Dinesh are three accounts.

   Passwords are handled entirely by Supabase Auth — hashed there,
   never read back, never written to this browser. Recovering a
   forgotten password goes through Supabase's own emailed reset link,
   because an address alone must never be enough to take over an
   account that belongs to somebody else.
   ============================================================ */
(function () {
  'use strict';

  const MAX_ROUNDS = 216;
  const MIN_PASSWORD = 6;   // Supabase Auth's own minimum

  // One address, one account. Addresses are compared and stored folded
  // to lower case so Dinesh@… and dinesh@… are never two devotees.
  const normEmail = e => String(e == null ? '' : e).trim().toLowerCase();
  const cleanName = n => String(n == null ? '' : n).trim().replace(/\s+/g, ' ');

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

  // Demo mode keeps accounts the same way the database does — one per
  // email address, with rounds filed under that address — so the sign-in,
  // recovery and multiple-devotees-one-name flows can be exercised
  // offline. It has no real authentication: there is nowhere safe to
  // keep a password in a browser, so it never asks for one to be right.
  function DemoStore() {
    let s;
    try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    if (!Array.isArray(s.events) || s.events.length === 0) s.events = seedEvents();
    if (!s.accounts || typeof s.accounts !== 'object') s.accounts = {};
    if (!s.subs || typeof s.subs !== 'object') s.subs = {};
    if (typeof s.seq !== 'number') s.seq = 0;
    if (typeof s.email !== 'string') s.email = null;

    // Upgrade a state saved by the older single-devotee demo.
    if (s.user && s.user.email) {
      const addr = normEmail(s.user.email);
      if (!s.accounts[addr]) {
        s.accounts[addr] = {
          name: s.user.name || addr.split('@')[0],
          devoteeId: s.user.devoteeId || nextDevoteeId(),
          group: s.user.group || 'Jodhpur Folk'
        };
      }
      if (s.mySubmissions && typeof s.mySubmissions === 'object') {
        s.subs[addr] = Object.assign({}, s.mySubmissions, s.subs[addr]);
      }
      s.email = addr;
    }
    delete s.user;
    delete s.mySubmissions;

    // Upgrade states saved under the older date-only model.
    (s.events || []).forEach(e => {
      if (!e.start_at) e.start_at = new Date((e.event_date || new Date().toISOString().slice(0, 10)) + 'T00:00').toISOString();
      if (!e.end_at) e.end_at = new Date((e.end_date || e.event_date || new Date().toISOString().slice(0, 10)) + 'T23:59').toISOString();
      delete e.event_date; delete e.end_date; delete e.starts_at; delete e.ends_at;
      delete e.rank_by; delete e.featured;
    });

    function nextDevoteeId() {
      s.seq = (s.seq || 0) + 1;
      return 'HKMM' + String(s.seq).padStart(3, '0');
    }

    const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {} };

    // Re-read what is on disk before answering a read. Another tab is
    // the nearest demo mode has to somebody else writing to the temple
    // database, and this is what makes their challenge or their rounds
    // show up here. The signed-in address stays this tab's own.
    function sync() {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return; }
      if (!raw || typeof raw !== 'object') return;
      if (Array.isArray(raw.events) && raw.events.length) s.events = raw.events;
      if (raw.accounts && typeof raw.accounts === 'object') s.accounts = raw.accounts;
      if (raw.subs && typeof raw.subs === 'object') s.subs = raw.subs;
      if (typeof raw.seq === 'number' && raw.seq > s.seq) s.seq = raw.seq;
    }

    const now = () => new Date().toTimeString().slice(0, 5);
    const ev = id => s.events.find(e => e.id === id);
    // Mirrors the backend rule: exactly one address is the admin.
    const isAdminEmail = email => normEmail(email) === ADMIN_EMAIL;
    const mySubs = () => (s.email && s.subs[s.email]) || {};

    function shape(addr) {
      const acct = s.accounts[addr];
      if (!acct) return null;
      return {
        id: addr, email: addr, name: acct.name,
        devoteeId: acct.devoteeId, group: acct.group || 'Jodhpur Folk',
        isAdmin: isAdminEmail(addr), phone: acct.phone || ''
      };
    }

    // Rounds are filed under the address that offered them, so two
    // devotees who share a name stay separate here as well.
    function people(eventId) {
      return Object.keys(s.accounts).map(addr => {
        const sub = (s.subs[addr] || {})[eventId];
        const r = sub ? sub.rounds : 0;
        return {
          userId: addr, name: s.accounts[addr].name,
          devoteeId: s.accounts[addr].devoteeId,
          email: addr, phone: s.accounts[addr].phone || '',
          rounds: r, total: r, time: sub ? sub.time : '-',
          me: addr === s.email, isAdmin: isAdminEmail(addr)
        };
      }).sort((a, b) => b.total - a.total);
    }

    return {
      mode: 'demo',
      isDemo: true,

      async consumeAuthLink() { return { type: null }; },

      async hasSession() { return !!(s.email && s.accounts[s.email]); },

      async currentUser() { sync(); return s.email ? shape(s.email) : null; },

      async signIn(email) {
        const addr = normEmail(email);
        if (!s.accounts[addr]) throw new Error('That email and password do not match an account.');
        s.email = addr; save();
        return shape(addr);
      },

      // Same rule as the database: an address that already has an
      // account is never signed up twice — its details are replaced and
      // it keeps its devotee ID, so the rounds filed under it stay put.
      async signUp(email, _pass, name) {
        sync();
        const addr = normEmail(email);
        const replaced = !!s.accounts[addr];
        if (replaced) {
          if (cleanName(name)) s.accounts[addr].name = cleanName(name);
        } else {
          s.accounts[addr] = {
            name: cleanName(name) || addr.split('@')[0],
            devoteeId: nextDevoteeId(),
            group: 'Jodhpur Folk'
          };
        }
        s.email = addr; save();
        return { status: 'signed-in', user: shape(addr), replaced };
      },

      // Nothing is emailed in demo mode, so the link step is skipped and
      // the app goes straight to choosing a new password.
      async sendRecovery(email) {
        const addr = normEmail(email);
        if (!s.accounts[addr]) throw new Error('No account was found for that email address.');
        s.recovering = addr; save();
        return { sent: true, demo: true, email: addr };
      },

      async completeRecovery(_password, name) {
        const addr = s.recovering || s.email;
        if (!addr || !s.accounts[addr]) throw new Error('That recovery link is no longer valid. Please start again.');
        if (cleanName(name)) s.accounts[addr].name = cleanName(name);
        s.email = addr;
        s.recovering = null;
        save();
        return shape(addr);
      },

      async signOut() { s.email = null; s.recovering = null; save(); },

      onAuthEvent() {},

      async listEvents() { sync(); return s.events.slice(); },

      async myEntry(eventId) {
        sync();
        const sub = mySubs()[eventId];
        return sub ? { id: eventId, rounds: sub.rounds, updatedAt: sub.updatedAt || null } : null;
      },

      async myRounds(eventId) {
        sync();
        const sub = mySubs()[eventId];
        return sub ? sub.rounds : 0;
      },

      async saveRounds(eventId, rounds) {
        sync();
        if (!s.email) throw new Error('Please sign in again.');
        const value = normaliseRounds(rounds);
        if (!s.subs[s.email]) s.subs[s.email] = {};
        s.subs[s.email][eventId] = {
          rounds: value, time: now(), updatedAt: new Date().toISOString()
        };
        save();
        return { id: eventId, rounds: value, updatedAt: s.subs[s.email][eventId].updatedAt };
      },

      async eventTotals(eventId) {
        sync();
        const e = ev(eventId);
        if (!e) return { total: 0, participants: 0, average: 0, highest: 0, capacity: 0 };
        const all = people(eventId).filter(p => p.total > 0);
        const total = all.reduce((n, p) => n + p.total, 0);
        return {
          total, participants: all.length,
          average: all.length ? +(total / all.length).toFixed(1) : 0,
          highest: all.reduce((n, p) => Math.max(n, p.total), 0),
          capacity: Math.max(TOTAL_DEVOTEES, Object.keys(s.accounts).length)
        };
      },

      async leaderboard(eventId) { sync(); return people(eventId).filter(p => p.total > 0); },

      async devotees(eventId) { sync(); return people(eventId); },

      async myHistory() {
        sync();
        const subs = mySubs();
        return s.events
          .filter(e => subs[e.id])
          .map(e => ({
            eventId: e.id, name: e.name, date: e.start_at, status: e.status,
            rounds: subs[e.id].rounds, time: subs[e.id].time
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

  // Remembered only so a password-reset link that comes back without a
  // type on it can still be recognised as one. It holds an address, never
  // a password.
  const RECOVERY_KEY = 'japaSeva.recovering';

  function SupabaseStore(sb) {
    let profile = null;

    /* ---- profiles ---- */

    function mapProfile(r) {
      return {
        id: r.id,
        name: r.name,
        devoteeId: r.devotee_id,
        group: r.group_name,
        isAdmin: r.is_admin,
        phone: ''
      };
    }

    // The devotee's profile row, keyed on the account's auth id — the
    // same id before and after a password recovery, which is why rounds
    // and history survive it.
    //
    // The row is normally created by the on_auth_user_created trigger.
    // ensure_profile() is the backstop for accounts made before that
    // trigger existed and for the moment between signup and the trigger
    // committing. Neither one can ever produce a second row: the primary
    // key is the auth id.
    async function loadProfile(userId) {
      let data = null, error = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        ({ data, error } = await sb
          .from('profiles')
          .select('id,name,devotee_id,group_name,is_admin')
          .eq('id', userId)
          .maybeSingle());
        if (data) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 350));
      }
      if (!data) data = await ensureProfile(null);
      if (!data) {
        if (error) throw new Error(readMsg(error));
        throw new Error('Your devotee profile is still being set up. Please try signing in again in a moment.');
      }
      return mapProfile(data);
    }

    // supabase/fix-004-accounts.sql. On a project that has not run it yet
    // this quietly does nothing rather than blocking the sign-in.
    async function ensureProfile(name) {
      try {
        const { data, error } = await sb.rpc('ensure_profile', { p_name: cleanName(name) || null });
        if (error) return null;
        return Array.isArray(data) ? (data[0] || null) : (data || null);
      } catch (e) {
        return null;
      }
    }

    // Bring the profile in line with the name the devotee has just
    // given. It touches that one column: rounds, history, devotee ID and
    // admin status are left exactly as they are.
    async function syncProfile(userId, name) {
      const wanted = cleanName(name);
      const row = await ensureProfile(wanted);
      if (row) return mapProfile(row);
      if (wanted) {
        // profiles_update_self allows a devotee to rename only themselves.
        await sb.from('profiles').update({ name: wanted }).eq('id', userId);
      }
      return loadProfile(userId);
    }

    async function adopt(user, name) {
      profile = name ? await syncProfile(user.id, name) : await loadProfile(user.id);
      profile.email = user.email;
      return profile;
    }

    /* ---- email links ---- */

    // Where Supabase sends confirmation and password-reset links back to.
    // The address must also be listed under Authentication > URL
    // Configuration in the Supabase dashboard, or the link bounces to
    // the site URL instead.
    function redirectUrl() {
      return location.origin + location.pathname;
    }

    function rememberRecovery(email) {
      try { localStorage.setItem(RECOVERY_KEY, normEmail(email)); } catch (e) {}
    }
    function takeRecoveryFlag() {
      let v = null;
      try { v = localStorage.getItem(RECOVERY_KEY); localStorage.removeItem(RECOVERY_KEY); } catch (e) {}
      return v;
    }

    // Strip the credentials out of the address bar once they have been
    // exchanged, so a reset link cannot be re-followed from history or
    // read off a shared screenshot. Anything unrelated (?demo=1) stays.
    function cleanUrl() {
      const AUTH_PARAMS = [
        'code', 'token_hash', 'token', 'type', 'error', 'error_code', 'error_description',
        'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'provider_token'
      ];
      const keep = new URLSearchParams(location.search);
      AUTH_PARAMS.forEach(k => keep.delete(k));
      const qs = keep.toString();
      try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); }
      catch (e) {}
    }

    // A confirmation or password-reset link arrives with its credentials
    // in the address. They are exchanged for a session here, before
    // anything else runs, and then wiped. Supabase has used three link
    // shapes over the years and older emails may still be in inboxes, so
    // all three are accepted.
    async function consumeAuthLink() {
      const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const query = new URLSearchParams(location.search);
      const pick = k => hash.get(k) || query.get(k);

      const failure = pick('error_description') || pick('error');
      const access = pick('access_token');
      const refresh = pick('refresh_token');
      const tokenHash = pick('token_hash');
      const code = query.get('code');
      let type = pick('type');

      if (!failure && !access && !tokenHash && !code) return { type: null };

      // A reset link that comes back without a type on it (the PKCE
      // shape) is still a reset if this browser asked for one.
      const asked = takeRecoveryFlag();
      if (!type && asked) type = 'recovery';

      try {
        if (failure) return { type: type || null, error: linkMsg(failure) };

        if (access && refresh) {
          const { error } = await sb.auth.setSession({ access_token: access, refresh_token: refresh });
          if (error) return { type: type || null, error: linkMsg(error.message) };
          return { type: type || 'session' };
        }
        if (tokenHash && type) {
          const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error) return { type, error: linkMsg(error.message) };
          return { type };
        }
        if (code) {
          const { error } = await sb.auth.exchangeCodeForSession(code);
          if (error) return { type: type || null, error: linkMsg(error.message) };
          return { type: type || 'session' };
        }
        return { type: null };
      } catch (e) {
        return { type: type || null, error: linkMsg(e.message) };
      } finally {
        // Whatever happened, the credentials do not stay in the address.
        if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e2) {} }
        cleanUrl();
      }
    }

    /* ---- an address that already has an account ---- */

    // Supabase refuses to create a second account for an address that is
    // already registered — the uniqueness is enforced in auth.users, not
    // by this code. What is left to decide is what to do instead.
    //
    // If the password just typed happens to be the account's own, this
    // was simply a sign-in and the devotee goes straight in. Otherwise
    // the account is recovered through an emailed link. Letting anyone
    // who knows an address set a new password on it would hand them
    // somebody else's rounds, history and — for one address — the admin
    // tab, so that is not offered.
    // supabase/fix-005-claim-account.sql. The address is the account:
    // if one already exists under it, its password and name are replaced
    // with what has just been typed, without the old password being
    // asked for. The account keeps its id, so the devotee's rounds,
    // challenge history and devotee ID stay attached to it.
    //
    // Returns:
    //   'replaced' — the address had an account; it is now theirs to
    //                sign into with the password they just chose
    //   'new'      — nothing is registered under that address
    //   null       — this database has no claim_account(), so the app
    //                falls back to recovering by emailed link
    async function claimAccount(addr, password, name) {
      const { data, error } = await sb.rpc('claim_account', {
        p_email: addr,
        p_password: password,
        p_name: cleanName(name) || null
      });
      if (error) {
        const m = error.message || '';
        if (/claim_account/i.test(m) && /schema cache|could not find|does not exist/i.test(m)) return null;
        throw new Error(friendly(m));
      }
      const row = Array.isArray(data) ? data[0] : data;
      return (row && row.found) ? 'replaced' : 'new';
    }

    async function existingAccount(addr, password, name) {
      const { data, error } = await sb.auth.signInWithPassword({ email: addr, password });
      if (!error && data && data.user) {
        const user = await adopt(data.user, name);
        return { status: 'signed-in', user, recognised: true };
      }
      return { status: 'exists', email: addr };
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

      consumeAuthLink,

      // A returning devotee has a session in this browser already;
      // Supabase refreshes it in the background. Asked before the
      // profile is read, so a database hiccup is never mistaken for
      // being signed out.
      async hasSession() {
        const { data } = await sb.auth.getSession();
        return !!data.session;
      },

      // Pass { refresh: true } to re-read the profile from the database
      // rather than the copy held since sign-in.
      async currentUser(opts) {
        const { data } = await sb.auth.getSession();
        if (!data.session) { profile = null; return null; }
        if (!profile || (opts && opts.refresh)) profile = await loadProfile(data.session.user.id);
        profile.email = data.session.user.email;
        return profile;
      },

      async signIn(email, password) {
        const addr = normEmail(email);
        const { data, error } = await sb.auth.signInWithPassword({ email: addr, password });
        if (error) throw new Error(friendly(error.message));
        return adopt(data.user, null);
      },

      // Creating an account with an address that is already registered
      // never makes a second devotee. What happens instead depends on
      // whether the database has claim_account(): with it, the existing
      // account's details are replaced with the ones just typed and the
      // devotee goes straight in; without it, the account is recovered
      // by emailed link (see existingAccount above).
      //
      // Returns one of:
      //   { status: 'signed-in', user }  — in, and the app can open
      //   { status: 'confirm',  email }  — a confirmation link was sent
      //   { status: 'exists',   email }  — recover this account instead
      async signUp(email, password, name) {
        const addr = normEmail(email);

        // The address decides everything. An address that already has an
        // account has its password and name replaced here, keeping its
        // id — and with it every round already offered.
        if (await claimAccount(addr, password, name) === 'replaced') {
          const { data, error } = await sb.auth.signInWithPassword({ email: addr, password });
          if (error) throw new Error(friendly(error.message));
          const user = await adopt(data.user, name);
          return { status: 'signed-in', user, replaced: true };
        }

        const { data, error } = await sb.auth.signUp({
          email: addr,
          password,
          options: { data: { name: cleanName(name) }, emailRedirectTo: redirectUrl() }
        });

        if (error) {
          if (/already registered|already been registered|already exists/i.test(error.message)) {
            return existingAccount(addr, password, name);
          }
          throw new Error(friendly(error.message));
        }

        // With "Confirm email" switched on, Supabase will not say
        // outright that an address is taken — it answers with a user
        // carrying no identities. That is the signal for an account
        // that already exists.
        const identities = data.user && data.user.identities;
        if (data.user && Array.isArray(identities) && identities.length === 0) {
          return existingAccount(addr, password, name);
        }

        // With email confirmation on there is no session until the link
        // in the email is opened.
        if (!data.session || !data.user) return { status: 'confirm', email: addr };

        const user = await adopt(data.user, name);
        return { status: 'signed-in', user };
      },

      // Supabase emails the reset link and holds the one-time token; this
      // app never sees or stores it.
      async sendRecovery(email) {
        const addr = normEmail(email);
        if (!addr) throw new Error('Please enter your email address.');
        rememberRecovery(addr);
        const { error } = await sb.auth.resetPasswordForEmail(addr, { redirectTo: redirectUrl() });
        if (error) throw new Error(friendly(error.message));
        return { sent: true, email: addr };
      },

      // Runs while the one-time session from the reset link is live.
      // Supabase hashes the new password; it is never stored by this app,
      // and the account keeps its id, so every round already offered
      // stays attached to it.
      async completeRecovery(password, name) {
        if (String(password || '').length < MIN_PASSWORD) {
          throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
        }
        const payload = { password };
        if (cleanName(name)) payload.data = { name: cleanName(name) };
        const { data, error } = await sb.auth.updateUser(payload);
        if (error) throw new Error(friendly(error.message));
        if (!data || !data.user) throw new Error('That reset link is no longer valid. Please ask for a new one.');
        takeRecoveryFlag();
        return adopt(data.user, name);
      },

      async signOut() {
        profile = null;
        takeRecoveryFlag();
        await sb.auth.signOut();
      },

      // Sessions end for reasons the app did not ask for — a sign-out in
      // another tab, a refresh token that has expired. The app listens so
      // it can return to the welcome screen instead of failing every read.
      onAuthEvent(cb) {
        try {
          sb.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT' || !session) profile = null;
            try { cb(event, session); } catch (e) { console.warn(e); }
          });
        } catch (e) { /* an older client without the listener */ }
      },

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
            name: p.name, devoteeId: p.devotee_id,
            // The address is the account, so the directory shows it.
            // Present only once supabase/fix-004-accounts.sql has run.
            email: p.email || '',
            phone: p.phone || '-',
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
    function linkMsg(msg) {
      const m = String(msg || '');
      if (/expired|invalid|not found|already been used/i.test(m)) {
        return 'That link has expired or has already been used. Please ask for a new one.';
      }
      if (/access_denied|otp_expired/i.test(m)) {
        return 'That link is no longer valid. Please ask for a new one.';
      }
      return m || 'That link could not be opened. Please ask for a new one.';
    }
    function friendly(msg) {
      const m = String(msg || '');
      if (/Invalid login credentials/i.test(m))   return 'That email and password do not match an account.';
      if (/Email not confirmed/i.test(m))         return 'Please open the confirmation link we emailed you, then sign in.';
      if (/User already registered/i.test(m))     return 'An account with this email already exists.';
      if (/Password should be|at least .* characters/i.test(m)) return `Password must be at least ${MIN_PASSWORD} characters.`;
      if (/should be different from the old/i.test(m)) return 'Please choose a password different from your old one.';
      if (/Signups not allowed/i.test(m))         return 'New accounts are closed at the moment. Please ask the temple admin.';
      if (/only request this after|rate limit|too many/i.test(m)) {
        return 'Too many attempts just now. Please wait a minute and try again.';
      }
      if (/Auth session missing|session_not_found/i.test(m)) {
        return 'That reset link is no longer valid. Please ask for a new one.';
      }
      if (/Failed to fetch|NetworkError/i.test(m)) {
        return 'Could not reach the temple database. Please check your connection and try again.';
      }
      return m;
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
          // visit keeps the devotee signed in, and the refresh token is
          // renewed in the background so it does not lapse while they are
          // away. What is kept is Supabase's own token — never a
          // password. The rounds themselves always live in Postgres.
          persistSession: true,
          autoRefreshToken: true,
          // The links in Supabase's emails are exchanged by
          // consumeAuthLink() at boot instead, so that a password-reset
          // link is recognised as one before the app decides what screen
          // to show. Leaving this on would race with that.
          detectSessionInUrl: false,
          // Implicit links carry their own tokens, so a reset link still
          // works when the email is opened in a different browser from
          // the one that asked for it.
          flowType: 'implicit'
        }
      });
      return SupabaseStore(client);
    },
    MAX_ROUNDS,
    MIN_PASSWORD
  };
})();
