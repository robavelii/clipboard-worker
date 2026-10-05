-- Deleting and exporting accounts (decisions §46). Adds only, plus one
-- UPDATE the running Worker ignores.

-- The account the admin secret enrols into: the owner's. Marked rather than
-- taken to be the oldest, so deleting it never hands the admin secret
-- someone else's account; bootstrap makes a new one instead. At most one.
ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_users_admin ON users(admin) WHERE admin = 1;
UPDATE users SET admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1);

-- One pending deletion confirmation per account, mailed to its address, as
-- a SHA-256 of the code. Five wrong guesses end it.
CREATE TABLE deletion_codes (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
