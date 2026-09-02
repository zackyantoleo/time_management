-- Derived Weekly Wrapped report produced by the private engine.
-- This table is intentionally separate from canonical CATET state.
CREATE TABLE IF NOT EXISTS weekly_wrapped_reports (
  user_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  blob TEXT NOT NULL CHECK (json_valid(blob)),
  updated_at TEXT NOT NULL
);
