-- Schema v2: domain documents with revision CAS and append-only worklogs.
-- Additive only; legacy states remains available during client migration.

CREATE TABLE IF NOT EXISTS state_documents (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tasks', 'routines', 'sprints', 'jira_overrides')),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 2),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  blob TEXT NOT NULL CHECK (json_valid(blob)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS worklog_entries (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  text TEXT NOT NULL,
  priority TEXT,
  minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  deleted_at TEXT,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_worklog_user_date
  ON worklog_entries (user_id, local_date DESC, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_worklog_user_task
  ON worklog_entries (user_id, task_id);
