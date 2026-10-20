-- Import test case QAlity: token QAlity per user + riwayat push per case.
-- Token di tabel sendiri (bukan ALTER TABLE users) supaya aman diulang:
-- Worker juga membuat tabel ini otomatis lewat SKEMA saat pertama dipakai.

CREATE TABLE IF NOT EXISTS qality_credentials (
  user_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS testcase_pushes (
  user_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  case_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  test_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','created_linked','created_unlinked','link_unverified','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, issue_key, case_hash)
);
