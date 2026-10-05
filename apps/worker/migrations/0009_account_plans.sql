-- Plans and per-account usage (decisions §44): each account's limits, with
-- the Worker's global budgets kept as an outer guard. Additive only: the
-- live Worker keeps working until the new one replaces it.

-- What a plan allows. NULL means no limit of the plan's own (a TTL: the
-- default), so `unlimited` is all NULLs and `free` names its numbers.
-- Changing a number is one UPDATE; no deploy.
CREATE TABLE plans (
  name           TEXT PRIMARY KEY,
  max_devices    INTEGER,
  -- Days an unpinned clip lives: text, and images or files.
  text_ttl_days  INTEGER,
  file_ttl_days  INTEGER,
  -- 0: text and images only, no other files.
  files          INTEGER NOT NULL DEFAULT 1,
  -- Bytes of encrypted files held at once.
  storage_bytes  INTEGER,
  -- R2 operations a UTC month: writes (A) and reads (B).
  class_a        INTEGER,
  class_b        INTEGER
);

INSERT INTO plans (name) VALUES ('unlimited');
INSERT INTO plans (name, max_devices, text_ttl_days, file_ttl_days, files, storage_bytes, class_a, class_b)
  VALUES ('free', 3, 7, 7, 0, 52428800, 2000, 20000);

-- Every account so far keeps today's limits. Signup (milestone 2, PR 3)
-- names `free` for the accounts it makes. No REFERENCES: SQLite refuses one
-- on an added column with a default; resolveToken checks the name instead.
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'unlimited';

-- R2 operations per account per month, beside r2_usage's totals.
CREATE TABLE account_usage (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month    TEXT NOT NULL,
  class_a  INTEGER NOT NULL DEFAULT 0,
  class_b  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

-- Which spend() the global count last took, so the account's count in the
-- same batch moves only when the global one did (r2.ts).
ALTER TABLE r2_usage ADD COLUMN last_spend TEXT;

-- An account's stored bytes are summed on every upload.
CREATE INDEX idx_blobs_user ON blobs(user_id);
