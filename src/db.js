const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [`
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','scorer','staff','player','viewer')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE login_attempts(key TEXT PRIMARY KEY, fails INTEGER NOT NULL, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN('singles','doubles')),
  gender TEXT NOT NULL DEFAULT 'open' CHECK(gender IN('boys','girls','mixed','open')),
  format TEXT NOT NULL DEFAULT 'knockout' CHECK(format IN('knockout','roundrobin')),
  third_place INTEGER NOT NULL DEFAULT 0, groups INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 0,
  generated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE players(id INTEGER PRIMARY KEY, name TEXT NOT NULL, gender TEXT NOT NULL DEFAULT 'male' CHECK(gender IN('male','female','other')),
  course_year TEXT, college_id TEXT COLLATE NOCASE, contact TEXT, notes TEXT, public INTEGER NOT NULL DEFAULT 1,
  checked_in_at TEXT, ready INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE UNIQUE INDEX players_college_id ON players(college_id) WHERE college_id IS NOT NULL AND college_id<>'';
CREATE TABLE registrations(id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id), partner_player_id INTEGER REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')), reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(player_id, category_id));
CREATE TABLE teams(id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL,
  player1_id INTEGER NOT NULL REFERENCES players(id), player2_id INTEGER REFERENCES players(id), seed INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE courts(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','maintenance')), note TEXT);
CREATE TABLE matches(id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), group_no INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL, number INTEGER NOT NULL, label TEXT, team_a INTEGER REFERENCES teams(id), team_b INTEGER REFERENCES teams(id),
  next_match_id INTEGER REFERENCES matches(id), next_slot TEXT, loser_match_id INTEGER REFERENCES matches(id), loser_slot TEXT,
  court_id INTEGER REFERENCES courts(id), scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','scheduled','in_progress','paused','awaiting_confirmation','disputed','completed','walkover','bye','postponed','cancelled')),
  rules TEXT, winner_team INTEGER REFERENCES teams(id), result_type TEXT, final_score TEXT, scorer_id INTEGER, started_at TEXT, finished_at TEXT,
  confirmed_by INTEGER, confirmed_at TEXT, called_at TEXT, dispute_note TEXT, dispute_prev TEXT, notes TEXT, walkover_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1, UNIQUE(category_id, group_no, round, number));
CREATE INDEX matches_court ON matches(court_id, status);
CREATE TABLE score_events(id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id), client_id TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN('a','b')),
  undone INTEGER NOT NULL DEFAULT 0, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(match_id, client_id));
CREATE TABLE games(match_id INTEGER NOT NULL REFERENCES matches(id), game_no INTEGER NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(match_id, game_no));
CREATE TABLE corrections(id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id), user_id INTEGER, username TEXT, reason TEXT NOT NULL, before TEXT, after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE announcements(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'info' CHECK(kind IN('info','schedule')),
  published INTEGER NOT NULL DEFAULT 1, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE volunteers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, court_id INTEGER REFERENCES courts(id), shift TEXT, contact TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE audit_log(id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, action TEXT NOT NULL, entity TEXT, entity_id INTEGER, details TEXT, ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX audit_created ON audit_log(id DESC);
`];

const DEFAULT_RULES_TEXT = `1. Every player must be registered before the deadline and show a valid college ID when asked.
2. Report to the call desk at least 10-15 minutes before your scheduled match.
3. If a player is absent when called, the announced grace period applies before a walkover is recorded.
4. Standard badminton rules and rally-point scoring apply. The match format is shown on this site and will not change mid-event without informing affected players.
5. Final scores are verified by the scorer and confirmed before the results board is updated.
6. Disputed scores are paused and referred to the referee or Event Coordinator, whose decision is final.
7. Wear suitable sports clothing and non-marking court shoes. Respect opponents, volunteers and officials.
8. Play stops if a court is unsafe or a player is injured.`;

const DEFAULT_SETTINGS = {
  tournament_name: 'College Badminton Tournament', college_name: '', venue: '', event_date: '',
  registration_open: '1', allow_viewer_signup: '1', match_minutes: '35', grace_minutes: '10', max_categories: '2',
  rules: JSON.stringify({ games_to_win: 2, points_to_win: 21, win_by: 2, cap: 30 }), rules_text: DEFAULT_RULES_TEXT,
};

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER NOT NULL)');
  let cur = db.prepare('SELECT MAX(v) v FROM schema_version').get().v || 0;
  for (; cur < MIGRATIONS.length; cur++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[cur]); db.prepare('INSERT INTO schema_version(v) VALUES(?)').run(cur + 1); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  if (!db.prepare('SELECT 1 FROM courts').get()) for (const n of ['Court 1', 'Court 2', 'Court 3']) db.prepare('INSERT INTO courts(name) VALUES(?)').run(n);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

module.exports = { open, tx };
