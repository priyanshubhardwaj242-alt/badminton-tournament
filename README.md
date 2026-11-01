# Badminton Tournament Manager

Student-run college badminton tournament system: public live site + staff console for 3 courts (more can be added), live scoring, brackets, registration, check-in, reports. Zero npm dependencies.

**Stack:** Node.js >= 22.13 (built-in `node:sqlite` database, built-in HTTP server), vanilla JS front end (no build step). Data lives in one SQLite file (`data/tournament.db`, WAL mode) - persistent across refreshes and restarts.

> `node:sqlite` is flagged "experimental" by Node (the warning is silenced by the npm scripts). It is stable in practice for this workload but pin your Node version in production.

## Install and run

```bash
node -v                      # must be >= 22.13
cp .env.example .env         # edit if needed (PORT, DB_PATH, COOKIE_SECURE...)
npm run create-admin         # interactive: username, email, password (hidden, min 10 chars)
npm start                    # http://localhost:3000
```
No dependencies to install. The database and its tables are created automatically on first start (migrations in `src/db.js`), with Courts 1-3 pre-created.

Optional demo data (refuses when `NODE_ENV=production`): `npm run seed:demo` (add `-- --users` to also create demo scorer/staff accounts with random passwords printed once).

## First administrator (secure setup)
There are **no default credentials anywhere**. `npm run create-admin` prompts for a password (hidden) and stores a scrypt hash. Non-interactive: `ADMIN_USERNAME=... ADMIN_PASSWORD=... npm run create-admin`. Further users are created by an admin under *Staff console > Users*.

## Running the event (workflow)
1. **Settings** - tournament name, venue, date, scoring rules (default best of 3 to 21, win by 2, cap 30; use games-to-win = 1 for short events), grace period, match duration. Rules are snapshotted into each match when it starts, so changing settings never alters a live match.
2. **Categories** - create e.g. Boys' Singles, Girls' Doubles, Mixed Doubles; choose knockout (optional third-place match) or round robin (optional groups). New categories are published by default; untick **Publish** if you want to keep one hidden. Visitors only ever see published categories, so a hidden category shows zero players and scores on the public pages (the dashboard warns you, and *Categories* has a one-click toggle).
3. **Registrations** - players register at `/#/register` (or staff add them). Review under *Registrations*: approve/reject. Approving creates the team (doubles partners are approved together). Duplicate checks use the college ID.
4. **Seeds (optional) and Generate fixtures** - *Categories > Seeds*, then *Generate fixtures*. Byes go to top seeds and advance automatically. Fixtures can't be regenerated after play has started.
5. **Schedule** - *Courts* page: *Assign match* on a court, or *Matches > Schedule*. Hard blocks: a player in two overlapping matches (never overridable). Warnings an administrator can override with a recorded reason: court double-booking, court under maintenance.
6. **Event day** - *Players*: check in, mark ready. *Courts*: *Call players* (starts the grace timer), *Start match* (warns about players not checked in), *Walkover / no-show* (no-show only after the grace period).
7. **Scoring** - the console has large +1 buttons, undo, pause/resume, dispute, enter-full-score. When a game sequence ends the match moves to *awaiting confirmation*; press **Confirm final result** and only then the winner advances. Admin corrections require a reason and are kept in the correction history; a correction that would change the winner is refused once the next match has started.
8. **Publish** - tick *Publish to the public site* on each category; the home, live, courts, brackets and results pages update in real time (server-sent events, with 15 s polling fallback).
9. **After** - *Reports*: CSV exports (players, registrations, matches, results, standings, corrections, audit) and printable fixtures/schedule/results/score sheets (browser *Save as PDF*).

## Roles
| Role | Can |
|---|---|
| admin | everything, incl. overrides, corrections, users, settings, categories, exports |
| scorer | score, start/pause/resume/walkover, check-in |
| staff | registrations, check-in, scheduling (no override), announcements, call-ups, walkovers |
| player / viewer | sign in, read public data only |

All checks are enforced server-side per route (`src/server.js`); denied attempts are written to the audit log.

## Security notes
scrypt password hashing; random 256-bit session tokens (only SHA-256 stored), `HttpOnly; SameSite=Strict` cookie (`Secure` when `COOKIE_SECURE=1`); login lockout (5 failures / 15 min per IP+username, 40 per IP); public sign-up/registration rate limits; origin check + JSON-only writes; CSP, `nosniff`, no framing; all DOM output via `textContent`; CSV formula-injection guard; public API returns no contact, college ID, notes or unpublished data.

## Deployment (single server)
```bash
# on a Linux VM with Node >= 22.13
git clone <your repo> && cd badminton && cp .env.example .env
# .env: NODE_ENV=production COOKIE_SECURE=1 TRUST_PROXY=1 PORT=3000 HOST=127.0.0.1
npm run create-admin && npm start
```
Put it behind HTTPS (Caddy or nginx reverse proxy to `127.0.0.1:3000`; for nginx disable buffering on `/api/events` with `proxy_buffering off`). Keep it as a **single process** - SQLite plus in-memory SSE clients assume one instance. Use systemd/pm2 to restart on failure. Nothing here has been deployed or load-tested by the author.

## Backups
`npm run backup` writes a consistent copy to `data/backups/` (uses `VACUUM INTO`, safe while running; keeps the newest 30). Schedule it (e.g. cron every 15 min on event day) and copy the folder off the machine. Restore: stop the server, replace `data/tournament.db` (delete `-wal`/`-shm` files), start.

## Tests
`npm test` - 29 tests: scoring rules, brackets/byes/seeding, auth + lockout, role permissions, full match lifecycle, bracket advancement, corrections, conflicts, 3-court queues, concurrency, privacy, registration, walkovers/no-shows, CSV, restart persistence, malformed-input robustness, a complete 8-team knockout to a champion, and a full round robin, resetting/replaying matches, and removing players, entries, courts and users. They run against the real HTTP server with a real SQLite database.

`npm run fuzz` - sends ~13,000 malformed requests at every API route and fails if any returns a server error (5xx). It uses a temporary in-memory database.

## Fixing mistakes: edit, remove, reset
| To... | Do this (Staff console) |
|---|---|
| Replay a finished or live match | **Matches** (or the scoring console) > **Reset / replay**. Scores are deleted, the match returns to *Not scheduled*, and the winner is taken out of the next round. Blocked if the next round's match has already started; reset that one first. Every reset is kept in the correction history. Also un-cancels a cancelled match. |
| Fix a wrong score without replaying | Scoring console > **Correct score (admin)** |
| Remove a player | **Players** > **Delete**. Their entries go; if their categories already have a draw it is rebuilt automatically (court assignments in it are cleared). If matches were already played you are asked before those results are discarded. A doubles partner's entry is marked *rejected* so you can re-register them. |
| Remove one entry | **Registrations** > **Delete** (or **Reject** to keep a record) |
| Redo a draw / allow late entries | **Categories** > **Clear fixtures**, approve the late entries, then **Generate fixtures** |
| Delete a whole category | **Categories** > **Delete** (asks before removing its entries, teams and matches; the players themselves are kept) |
| Delete a manually added match | **Matches** > **Delete** (bracket matches are removed with Clear fixtures) |
| Edit teams in an unplayed match | **Matches** > **Edit teams** |
| Courts | **Courts** > **Add court / Rename / Delete court** (matches scheduled on a deleted court become unscheduled; a court that hosted finished matches can't be deleted, use Maintenance) |
| Announcements, volunteers, users, categories, players | **Edit** / **Delete** buttons on each list |

All of these are administrator-only except Reject, and each one is written to the audit log. The audit log itself can't be edited or deleted.

## Starting the server
`npm start` prints the address to open (**http://localhost:3000**; never `0.0.0.0`, which browsers can't visit) and opens it in your browser automatically (set `OPEN_BROWSER=0` in `.env` to stop that). If the port is taken it tells you so instead of failing quietly; change `PORT` in `.env`.

## Known limits / assumptions
- Cancelling a match inside a bracket stops that bracket advancing; use *Walkover* to send a player through (or *Reset / replay* to bring a cancelled match back).
- PDFs come from the browser's print dialog (print-optimised pages), not server-side PDF generation.
- Single event per database (settings are global); start a fresh `DB_PATH` for a new year.
- Round-robin standings tie-breaks: wins, game difference, point difference (no head-to-head).
- Times are shown in the viewer's local time zone; the server stores UTC.
- Email/SMS notifications and password-reset emails are not implemented (an admin resets passwords).
- The UI was verified by rendering every page and driving the scoring console in jsdom against the live server, not in real browsers or on physical phones - test on your own devices before the event.
