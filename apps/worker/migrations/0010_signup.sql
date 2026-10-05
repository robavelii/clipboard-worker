-- Signup and device-less sign-in (decisions §45). Additive only.

-- An account's email: lowercased, and the handle a device-less sign-in
-- looks the account up by. NULL for accounts bootstrap made.
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;

-- Failed device-less sign-ins in the current hour, per account: past the
-- limit, the account refuses sign-in until the hour is out.
ALTER TABLE users ADD COLUMN signin_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN signin_window INTEGER;

-- The one pending emailed code per address, as a SHA-256 of the code. A
-- new request replaces it; a wrong guess counts against it, and five end it.
CREATE TABLE email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- Signup invites an admin mints (with ADMIN_SECRET), for a server whose
-- signup is not open, or that sends no mail. Single use.
CREATE TABLE signup_invites (
  code_hash  TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
