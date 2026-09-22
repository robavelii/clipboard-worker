-- ClipSync initial schema.
--
-- The server stores ciphertext only: `clips.envelope` is opaque to this
-- database and `clips.content_hash` is an HMAC under a key the server never
-- sees, so neither column can be used to confirm a guess at clipboard content.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  -- Public PBKDF2 salt. Handed to every device at pair time.
  kdf_salt    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  -- SHA-256 of the bearer token. The token itself is shown exactly once.
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  revoked_at  INTEGER
);

CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE clips (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  type          TEXT NOT NULL,
  envelope      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER
);

-- History listing and cursor paging.
CREATE INDEX idx_clips_user_created ON clips(user_id, created_at DESC);
-- Dedupe lookup against the newest clip.
CREATE INDEX idx_clips_user_hash ON clips(user_id, content_hash);
-- Cron purge.
CREATE INDEX idx_clips_expiry ON clips(expires_at) WHERE pinned = 0;

CREATE TABLE pair_codes (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- Short-lived credential for the sync WebSocket: browsers cannot set headers
-- on a WS handshake, and a long-lived token in a URL ends up in logs.
CREATE TABLE sync_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
