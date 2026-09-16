-- TMS persistence schema.
--
-- Each aggregate is stored as a JSON document alongside the columns the
-- application actually filters on. That keeps the nested structures the spec
-- defines (draw slot maps, score event logs, correction history, reschedule
-- history) in one place while still allowing indexed queries by tournament,
-- event, match and status.
--
-- The GMS will have its own database. `TmsStore` in db.ts is the seam: swap
-- this file and the SQLite driver for Postgres/Prisma and nothing above the
-- store layer changes.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tournaments (
  tournament_id TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  start_date    TEXT NOT NULL,
  doc           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(tournament_id),
  sport         TEXT NOT NULL,
  status        TEXT NOT NULL,
  draw_status   TEXT NOT NULL,
  doc           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_tournament ON events(tournament_id);

CREATE TABLE IF NOT EXISTS entries (
  entry_id  TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(event_id),
  unit_id   TEXT NOT NULL,
  status    TEXT NOT NULL,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_entries_event ON entries(event_id);
CREATE INDEX IF NOT EXISTS ix_entries_unit  ON entries(unit_id);

CREATE TABLE IF NOT EXISTS formats (
  format_id TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(event_id),
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_formats_event ON formats(event_id);

CREATE TABLE IF NOT EXISTS draws (
  draw_id  TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  status   TEXT NOT NULL,
  doc      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_draws_event ON draws(event_id);

CREATE TABLE IF NOT EXISTS matches (
  match_id       TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(event_id),
  match_no       TEXT NOT NULL,
  stage          TEXT NOT NULL,
  status         TEXT NOT NULL,
  scheduled_date TEXT,
  fop_id         TEXT,
  doc            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_matches_event ON matches(event_id);
CREATE INDEX IF NOT EXISTS ix_matches_date  ON matches(scheduled_date);
CREATE INDEX IF NOT EXISTS ix_matches_fop   ON matches(fop_id, scheduled_date);

CREATE TABLE IF NOT EXISTS match_operations (
  match_id TEXT PRIMARY KEY REFERENCES matches(match_id),
  doc      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  result_id TEXT PRIMARY KEY,
  match_id  TEXT NOT NULL UNIQUE REFERENCES matches(match_id),
  event_id  TEXT NOT NULL,
  status    TEXT NOT NULL,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_results_event  ON results(event_id);
CREATE INDEX IF NOT EXISTS ix_results_status ON results(status);

CREATE TABLE IF NOT EXISTS assignments (
  assignment_id TEXT PRIMARY KEY,
  match_id      TEXT NOT NULL REFERENCES matches(match_id),
  official_id   TEXT NOT NULL,
  status        TEXT NOT NULL,
  doc           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assign_match    ON assignments(match_id);
CREATE INDEX IF NOT EXISTS ix_assign_official ON assignments(official_id);

CREATE TABLE IF NOT EXISTS standings (
  event_id       TEXT NOT NULL,
  group_id       TEXT NOT NULL,
  participant_ref TEXT NOT NULL,
  doc            TEXT NOT NULL,
  PRIMARY KEY (event_id, group_id, participant_ref)
);

CREATE TABLE IF NOT EXISTS medals (
  event_id        TEXT NOT NULL,
  participant_ref TEXT NOT NULL,
  doc             TEXT NOT NULL,
  PRIMARY KEY (event_id, participant_ref)
);

CREATE TABLE IF NOT EXISTS protests (
  protest_id TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  status     TEXT NOT NULL,
  doc        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_protests_event ON protests(event_id);

CREATE TABLE IF NOT EXISTS exceptions (
  exception_id  TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  event_id      TEXT,
  scenario      TEXT NOT NULL,
  doc           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_exceptions_tournament ON exceptions(tournament_id);

CREATE TABLE IF NOT EXISTS venues (
  venue_id      TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  doc           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS officials_pool (
  official_id   TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  doc           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants_pool (
  participant_id TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL,
  unit_id        TEXT NOT NULL,
  doc            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pool_unit ON participants_pool(tournament_id, unit_id);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  role    TEXT NOT NULL,
  doc     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  tournament_id   TEXT NOT NULL,
  type            TEXT NOT NULL,
  sent_at         TEXT NOT NULL,
  doc             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notif_tournament ON notifications(tournament_id, sent_at);

-- Append-only by construction: the store exposes insert and select only, and
-- rule 7.6.27 forbids update or delete for every role including Super Admin.
CREATE TABLE IF NOT EXISTS audit_log (
  log_id        TEXT PRIMARY KEY,
  timestamp     TEXT NOT NULL,
  tournament_id TEXT,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  action        TEXT NOT NULL,
  doc           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_tournament ON audit_log(tournament_id, timestamp);
CREATE INDEX IF NOT EXISTS ix_audit_entity     ON audit_log(entity_type, entity_id);

-- Schedule publication state per event, so publishing stays an explicit act.
CREATE TABLE IF NOT EXISTS schedule_state (
  event_id             TEXT PRIMARY KEY,
  status               TEXT NOT NULL,
  acknowledged_soft    TEXT NOT NULL DEFAULT '[]',
  published_at         TEXT,
  version_no           INTEGER NOT NULL DEFAULT 1
);
