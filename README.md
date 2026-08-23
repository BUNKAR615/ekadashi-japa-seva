# Ekadashi Japa Seva

A rounds-counter app for **Hare Krishna Marwad Mandir** — devotees record their
Ekadashi japa rounds, see the group's combined offering, and temple admins run
events. Implemented from the Claude Design project *Japa Seva* (clean pass).

**Live:** https://japa-seva.vercel.app

## Two modes

The app runs in one of two modes, chosen automatically at startup:

| Mode | When | Behaviour |
|------|------|-----------|
| **Demo** | `config.js` has no keys | Everything works, but data is saved only in that browser. A banner says so. |
| **Live** | `config.js` has Supabase keys | Real accounts, shared data, real admin permissions. |

This means the site never breaks — it degrades to demo mode if the backend is
missing or unreachable.

## Connecting the backend (one-time setup)

**1. Create a Supabase project** at [supabase.com](https://supabase.com) —
the free tier is ample. Choose a region close to India (Mumbai / Singapore).

**2. Run the schema.** In the dashboard open **SQL Editor**, paste the whole of
[`supabase/schema.sql`](supabase/schema.sql), and run it. It creates the tables,
the security policies, and one active event to start with. (Projects created
before challenge management existed run
[`supabase/fix-002-challenges.sql`](supabase/fix-002-challenges.sql) instead.)

**3. Paste your keys** into [`config.js`](config.js):

```js
window.JAPA_CONFIG = {
  supabaseUrl: 'https://xxxxxxxx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...'
};
```

Both come from **Project Settings**: the URL is under *Data API*, the key is the
`anon` / `public` one under *API Keys*. The anon key is meant to be public and is
safe to commit. **Never** put the `service_role` key here — it bypasses all
security.

**4. Make yourself an admin.** The first devotee to register becomes the temple
admin automatically, so simply sign up first. To promote someone later, run this
in the SQL Editor:

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'them@example.com');
```

The **Admin** toggle appears in the header only for admin accounts.

**5. Bump the cache version.** After changing `config.js`, edit `index.html` and
raise the `?v=` number by one on the script and stylesheet tags, so phones pick up the
new files instead of a cached copy.

### Email confirmation

By default Supabase emails a confirmation link on signup. For a temple group you
may prefer to turn it off (**Authentication > Sign In / Providers > Email >
Confirm email**), so devotees can start chanting immediately. Leave it on if you
want verified addresses.

## Security model

Permissions are enforced by Postgres row-level security, not by the interface —
so they hold even if someone edits the page in their browser:

- A devotee can read and write **only their own** submission.
- Rounds can only be saved while the challenge window is genuinely open —
  published, started, and not yet ended. The database checks the timestamps,
  so a closed or not-yet-open challenge rejects writes even if the interface
  is bypassed.
- Only accounts with `is_admin = true` can create, edit, activate or close
  events, and only they can read the devotee directory with phone numbers.
- The **Admin only** leaderboard setting is a real privacy guarantee: the
  database refuses to return other devotees' rows for such an event. Group
  totals still work, because they come from an aggregate function that returns
  sums only — never an individual's figure.
- Rounds are constrained to 0–216 per day in the schema, matching the keypad.
- Promoting or demoting admins happens through a guarded database function;
  the last remaining admin can never be demoted.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | Welcome/sign-in screen + app shell |
| `styles.css` | Design system: paper/white/ink neutrals with a saffron accent, Poppins + Tiro Devanagari type |
| `app.js` | Views, interaction, and rendering |
| `store.js` | Data layer — the Supabase and demo implementations behind one async API |
| `config.js` | Your Supabase keys (blank = demo mode) |
| `supabase/schema.sql` | Tables, policies and functions; run once in the SQL Editor |
| `supabase/fix-002-challenges.sql` | Migration for projects created before challenge windows existed |
| `manifest.webmanifest` | Installable-app metadata — devotees can add it to their home screen |
| `assets/` | Temple logo, Srila Prabhupada portrait, and generated app icons |

## Features

A **challenge** is one continuous window: it opens at a chosen date and time
and closes at a chosen date and time. It does not repeat daily. Each devotee
keeps a single running total for that window, editable until it closes.

**Devotee** — three tabs: Japa (your rounds for the challenge, numeric keypad
capped at 216, lotus toast on save), Leaderboard (percentage of the goal
completed, group stats, and the leaders ranked by total rounds), and Me
(profile, challenge history, sign out).

**Admins keep every devotee ability** and gain a fourth tab. There is no mode
switch: an admin records their own rounds and appears on the leaderboard like
anyone else, and the Admin tab adds Overview / Challenges / Devotees.

**Admin** (header toggle, only shown to admins):

- **Challenges** — create / edit / publish / close / reopen. A challenge has
  a start date-and-time, an end date-and-time, a group goal, description and
  rules, and a leaderboard visibility setting. A running challenge can be
  edited mid-flight: move the end later or raise the goal without losing any
  rounds already offered. Only admins can start one; the database enforces
  it. Once the end moment passes the challenge reads "Challenge completed"
  and rounds are refused — in the interface and at the database.
- **Leaderboard controls** — per-challenge visibility: names, devotee IDs,
  admin-only, or fully off. One challenge runs at a time, and the Leaderboard
  tab always shows that challenge, ranked by total rounds.
- **Admin roles** — promote or demote any devotee from the Devotees tab.
  The database guarantees at least one admin always remains.
- **Overview** — participation, top offerings, CSV export.
- **Devotees** — searchable directory with phone numbers and status.

## Developing

No build step — plain HTML/CSS/JS. Serve the folder over HTTP:

```bash
python -m http.server 8734
```

then open <http://localhost:8734>. Pushing to `main` deploys automatically to
Vercel (japa-seva.vercel.app) and GitHub Pages.
