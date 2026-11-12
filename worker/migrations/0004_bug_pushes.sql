-- GAP → tiket Bug Jira: riwayat pembuatan Bug per GAP (judul) per tiket sumber.
-- Aman diulang: Worker juga membuat tabel ini otomatis lewat SKEMA saat pertama dipakai.

CREATE TABLE IF NOT EXISTS bug_pushes (
  user_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  gap_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  bug_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','created_linked','created_unlinked','link_unverified','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, issue_key, gap_hash)
);
