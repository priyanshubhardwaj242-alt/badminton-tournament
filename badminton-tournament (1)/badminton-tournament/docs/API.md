# API reference
JSON over HTTP. Cookie session (`sid`). Writes need `Content-Type: application/json`. Errors: `{ "error": "message", ...extra }` with status 400/401/403/404/409/422/429. Match writes accept `version` (optimistic lock); a stale version returns `409 { code: "stale", match }`.
Permissions: `-` public, `auth` any signed-in user, otherwise the permission needed (admin = `*`; see README roles).

## Auth & system
| Method | Path | Perm |
|---|---|---|
| GET | /api/health | - |
| GET | /api/events (SSE "update" pings) | - |
| POST | /api/auth/login, /logout, /register (viewer sign-up), /password | - / - / - / auth |
| GET | /api/auth/me | - |

## Public (published categories only)
GET `/api/public/overview` `matches?category&court&status=live|done|upcoming` `courts` `brackets` `results` `players` `announcements` `categories-open`; POST `/api/public/register`. Printables: GET `/print/fixtures` `/print/schedule` `/print/results`.

## Staff
| Area | Endpoints (perm) |
|---|---|
| Dashboard/reports | GET /api/admin/dashboard, /api/reports/summary (panel) |
| Categories | GET /api/categories (panel); POST, PATCH /:id, POST /:id/generate, POST /:id/clear-fixtures {force?}, DELETE /:id {force?} (admin; `409 has_results` / `not_empty` unless `force:true`); GET /:id/standings (panel) |
| Players | GET /api/players (panel; private fields need players.private); PATCH /:id (registration.review); DELETE /:id {force?} (admin; removes entries, rebuilds draws; `409 has_results` unless forced); POST /:id/checkin, /:id/ready (checkin) |
| Registrations | GET /api/registrations, PATCH /:id {status,reason}, POST /api/registrations/admin (registration.review); DELETE /:id {force?} (admin) |
| Teams | GET /api/teams (panel); PATCH /:id {seed} (admin) |
| Matches | GET /api/matches?category&court&status&q&unscheduled, GET /:id (panel); POST, PATCH /:id, DELETE /:id (admin; delete only for unplayed non-bracket matches) |
| Reset / replay | POST /api/matches/:id/reset {reason, version?} (score.correct = admin) - clears scores, returns to Not scheduled, rolls back bracket advancement; `409 downstream_started` if the next match already started |
| Scheduling | POST /api/matches/:id/schedule {court_id, scheduled_at, override?, reason?}, /postpone (schedule.assign; override = admin) |
| Control | POST /api/matches/:id/start, /pause, /resume, /callup, /cancel, /walkover {winner,reason}, /noshow {side} (match.control) |
| Scoring | POST /api/matches/:id/point {side, client_id, version}, /undo, /games {games:[{a,b}], reason?}, /confirm, /dispute {note} (score; correcting after submit and /resolve-dispute need score.correct = admin) |
| Courts | GET /api/courts (panel); POST, DELETE /:id (admin); PATCH /:id {status,note,name} (schedule.assign; rename = admin) |
| Announcements | GET (panel); POST, PATCH /:id, DELETE /:id (announce) |
| Volunteers, Users, Settings, Audit | /api/volunteers (POST, PATCH, DELETE), /api/users (POST, PATCH, DELETE; not yourself or the last admin), /api/settings, GET /api/audit (admin) |
| Exports | GET /api/export/{players,registrations,matches,results,standings,corrections,audit}.csv (admin); GET /print/scoresheet/:id (panel) |

Scheduling conflict responses: `409 { code: "player_overlap" | "needs_override", conflicts: [{type, message, overridable}] }`.
