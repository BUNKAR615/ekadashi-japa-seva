# Ekadashi Japa Seva

A rounds-counter app for **Hare Krishna Marwad Mandir** — devotees record their
Ekadashi japa rounds, see the group's combined offering, and temple admins run
events. Implemented from the Claude Design project *Japa Seva* (clean pass).

**Live:** https://japa-seva.vercel.app

## Where the data lives

Every round is written to the temple's Supabase database and read back from
there. Nothing is kept only in the browser, so a refresh, a sign-out, or a
different phone all show the same figures, and admins see every entry.

There is **no automatic fallback to local storage**. An earlier version quietly
switched to a browser-only store whenever the backend hiccuped, which turned
each devotee's rounds into private data nobody else could see. If the database
cannot be reached the app now says so and offers to retry.

A localStorage-only mode still exists for development, reachable only by adding
`?demo=1` to the address. It is never chosen automatically.

## Connecting the backend (one-time setup)

**1. Create a Supabase project** at [supabase.com](https://supabase.com) —
the free tier is ample. Choose a region close to India (Mumbai / Singapore).

**2. Run the schema.** In the dashboard open **SQL Editor**, paste the whole of
[`supabase/schema.sql`](supabase/schema.sql), and run it. It creates the tables,
the security policies, and one active event to start with.

**Already have a project from an earlier version?** Run
[`supabase/fix-003-persistence.sql`](supabase/fix-003-persistence.sql) instead —
one file, safe to re-run, and safe on a project that is already current. It
supersedes fix-001 and fix-002. Until it has been run, the app cannot save
rounds at all: the first schema stored a challenge as a date plus two clock-time
strings, and every query the app now makes asks for `start_at` / `end_at`, so
PostgREST rejects it with `42703 column events.start_at does not exist`.

Then run [`supabase/fix-004-accounts.sql`](supabase/fix-004-accounts.sql). It
gives every account a profile (including any made before the signup trigger
existed, which otherwise get stuck on *"Your devotee profile is still being set
up"*), adds `ensure_profile()`, and puts the email address in the admin devotee
directory. It touches no rounds and deletes nothing.

Then run [`supabase/fix-005-claim-account.sql`](supabase/fix-005-claim-account.sql),
which makes Create Account replace an existing account rather than refuse. **Read
its header first** — it deliberately drops the check that the person typing an
address owns it. See [Accounts](#accounts) below.

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

**4. Admin access.** Exactly one address is the admin, set in `admin_email()`
inside the schema. Signing up with that address grants the Admin tab
automatically; every other account is an ordinary user. To change who it is,
edit that one function and re-run it.

**5. Allow the app's address to receive email links.** In the dashboard, under
**Authentication > URL Configuration**, add the address the app is served from to
**Redirect URLs**:

```
https://japa-seva.vercel.app
https://japa-seva.vercel.app/
http://localhost:8734
```

Password-reset and confirmation emails send devotees back to that address. If it
is not listed, Supabase drops them at the project's Site URL instead and the
reset cannot finish. **Forgot password does not work until this is done.**

**6. Bump the cache version.** After changing `config.js`, edit `index.html` and
raise the `?v=` number by one on the script and stylesheet tags, so phones pick up the
new files instead of a cached copy.

## Accounts

**The email address is the account.** Everything a devotee has ever offered
hangs off their auth id, and that id never changes — so recovering an address
keeps every round, every challenge and the devotee ID attached to it. Names are
not identifying: three devotees called Dinesh with three addresses are three
separate accounts, and the app never merges them.

The one card on the welcome screen covers every case, so nobody is ever left on
a screen with no way forward:

| The devotee… | What happens |
|---|---|
| is new | **Create Account** — name, email, password. Straight into the app. |
| knows their password | **Sign In** — email and password. |
| has forgotten it | **Forgot password?** — Supabase emails a link; opening it asks for a new password and takes them in. |
| types an address that already exists into Create Account | No second account is made. That account's password and name are replaced with what was just typed and the devotee goes straight in, keeping their devotee ID, rounds and history. |
| comes back later | The session was kept in this browser. The app opens straight onto today's data. |

**Create Account is also the way back in.** A devotee who has forgotten their
password simply creates their account again with the same address and a new
password. `claim_account()` finds the existing account by address, replaces its
password and name, and leaves its id alone — so the rounds, the challenge
history and the devotee ID are all still there when they arrive.

**What that costs, stated plainly.** This removes the check that the person
typing an address owns it. Anyone who knows a devotee's address can set a new
password on their account and sign in as them. That includes the admin address
in `admin_email()`, which is published in this repository — so it also hands
over the devotee directory, the phone numbers, the CSV export and control of
every challenge.

It was chosen knowingly, to spare devotees the emailed link. The safe path is
still there and still works — **Forgot password?** on the sign-in card uses
Supabase's own reset flow, which proves the devotee reads that inbox. To make
that the only way back in, drop the function:

```sql
drop function if exists public.claim_account(text, text, text);
```

The app notices it is gone and falls back to the emailed link on its own; no
front-end change is needed.

**Email delivery.** Supabase's built-in mail service is rate-limited to a
handful of messages an hour, which is fine for occasional recovery but not for a
whole temple resetting at once. For anything busier, set your own SMTP under
**Project Settings > Authentication > SMTP Settings**.

### Email confirmation

By default Supabase emails a confirmation link on signup. For a temple group you
may prefer to turn it off (**Authentication > Sign In / Providers > Email >
Confirm email**), so devotees can start chanting immediately. Leave it on if you
want verified addresses. The app handles both: with it on, a new account is told
to open the link; with it off, the devotee is signed in at once. Either way an
address that is already registered is recovered rather than duplicated.

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
- Rounds are constrained to a whole number from 0 to 216 by a check
  constraint, matching the keypad. The same rule is applied in the interface
  and in the data layer, so a bad value is refused three times over.
- **A devotee can edit only their own entry.** The update policy matches on
  `user_id = auth.uid()`, so an attempt to revise someone else's count changes
  nothing — even with the interface bypassed.
- Editing never creates a second row: submissions are unique on
  `(event_id, user_id)` and the app upserts on that key, so a revision updates
  the existing record and stamps `updated_at`.
- Admin is pinned to one email address by a trigger; nobody can be promoted
  from inside the app.
- **One account per email address.** Uniqueness is enforced by Supabase Auth
  itself — `auth.users` has a unique index on the address — so a second signup
  for a registered address is refused before it reaches this schema. The app
  recovers the existing account instead of trying to create another.
- **Knowing an address IS enough to take the account**, by deliberate choice —
  see [Accounts](#accounts). Passwords are still hashed (bcrypt, never stored in
  readable form) and nothing password-shaped is written to the browser, only
  Supabase's own session token. But `claim_account()` is callable before
  sign-in, so the address alone is what guards an account. Dropping that one
  function restores the emailed-link requirement.
- `ensure_profile()` works on `auth.uid()` alone and writes only `name`, so a
  devotee can create or rename their own profile and nobody else's, and no call
  to it can touch rounds, history, devotee IDs or admin status.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | Welcome/sign-in screen + app shell |
| `styles.css` | Design system: paper/white/ink neutrals with a saffron accent, Poppins + Tiro Devanagari type |
| `app.js` | Views, interaction, and rendering |
| `store.js` | Data layer — the Supabase and demo implementations behind one async API |
| `config.js` | Your Supabase keys (blank = demo mode) |
| `supabase/schema.sql` | Tables, policies and functions; run once in the SQL Editor |
| `supabase/fix-003-persistence.sql` | **Run this on an existing project.** One idempotent migration to the current schema; supersedes fix-001 and fix-002 |
| `supabase/fix-004-accounts.sql` | **Run this too.** One profile per account, `ensure_profile()`, and the address in the admin directory |
| `supabase/fix-005-claim-account.sql` | **Read its header before running.** Makes Create Account replace an existing account instead of refusing |
| `supabase/verify-accounts.sql` | Read-only health report on the accounts; run it any time to check the above landed |
| `supabase/fix-002-challenges.sql` | Superseded by fix-003; kept for reference |
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

**Revising your count.** Chanting more rounds later is the normal case, not an
exception. An **Edit** control sits on the Japa card, on your own leaderboard
row, and on the challenge in My Journey — on your own entry only. The sheet
opens showing what is already recorded, with *Chanted more?* chips (+1 +2 +4 +8)
that add to the running total, so eight rounds plus four saves twelve. The
existing database row is updated in place, `updated_at` is re-stamped, and the
new figure appears on the leaderboard and in the group total immediately.

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
- **Admin access is fixed to one address.** A database trigger re-derives
  is_admin from the account email on every write, so exactly one account is
  an admin and nobody can be promoted — not from the app, not by a bug, not
  by a stray SQL update. That account is a full participant too: it records
  rounds and appears on the leaderboard like everyone else, and additionally
  sees the Admin tab. To hand the role over, change the address inside
  admin_email() in the schema.
- **Overview** — participation, top offerings, CSV export (with the address,
  so two devotees of the same name can be told apart).
- **Devotees** — directory with email addresses, phone numbers and status,
  searchable by name, address or devotee ID.

**Staying signed in.** Once a devotee has signed in, the session is kept in
their browser and renewed in the background: closing the app and opening it
again lands them straight in the app, not on the sign-in card. Signing back in
is asked for only when they sign out themselves or the session genuinely ends.
Staying signed in never means seeing yesterday's temple — every time the app
comes back into view it re-reads the challenge, the leaderboard and the profile
from the database, so a challenge an admin opened this morning and rounds
another devotee revised a minute ago are both there.

## Developing

No build step — plain HTML/CSS/JS. Serve the folder over HTTP:

```bash
python -m http.server 8734
```

then open <http://localhost:8734>. Pushing to `main` deploys automatically to
Vercel (japa-seva.vercel.app) and GitHub Pages.
