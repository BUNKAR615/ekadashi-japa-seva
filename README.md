# Ekadashi Japa Seva

A rounds-counter app for **Hare Krishna Marwad Mandir** — devotees record their
Ekadashi japa rounds, see the group's combined offering, and temple admins run
events. Implemented from the Claude Design project *Japa Seva*.

## Run it

No build step — it's plain HTML/CSS/JS. Serve the folder over HTTP:

```bash
python -m http.server 8734
```

then open <http://localhost:8734>.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | Welcome/sign-in screen (arch & jali direction) + app shell |
| `styles.css` | Full design system: ivory/sandalwood/maroon/saffron palette, Yeseva One + Jost + Tiro Devanagari type, jali watermarks |
| `app.js` | All app logic; state persists in `localStorage` |
| `manifest.webmanifest` | Installable-app metadata — devotees can add it to their home screen |
| `assets/` | Temple logo, Śrīla Prabhupāda photograph, and generated app icons |

## Features

**Devotee** — Japa tab (today's seva card, numeric keypad entry capped at 216
rounds, lotus toast on save), Together tab (group stats + leaderboard),
Journey tab (event history timeline), Me tab (profile, sign out).

**Admin** (header toggle) — Overview dashboard (participation, top offerings,
CSV export), Events (create / activate / close / reopen / edit, per-event
leaderboard visibility: names, devotee IDs, or admin-only), Devotees (search).

Community data (other devotees, past event totals) is seeded demo data; your
own account, rounds and any events you create are stored locally in the
browser.
