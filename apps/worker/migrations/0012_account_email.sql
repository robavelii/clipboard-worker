-- Adding or changing an account's email (decisions §47). Additive only.

-- One pending change per account: the new address, and a SHA-256 of the
-- code mailed to it. Five wrong guesses end it.
CREATE TABLE email_changes (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
