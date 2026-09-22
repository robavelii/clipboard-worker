-- Device linking by ECDH key agreement.
--
-- The server relays two public keys and one ciphertext it cannot open. The
-- joining device's public key also travels out of band (QR or paste), which is
-- what stops the server substituting its own -- see packages/crypto/src/link.ts.

CREATE TABLE link_requests (
  id                  TEXT PRIMARY KEY,
  -- Joining device's ephemeral ECDH public key, raw point, base64url.
  public_key          TEXT NOT NULL,
  device_name         TEXT NOT NULL,
  platform            TEXT NOT NULL,
  -- SHA-256 of the pickup token. Only the requester holds the token, so only
  -- the requester can collect the approval.
  pickup_hash         TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,

  -- Filled in on approval.
  approved_at         INTEGER,
  approver_public_key TEXT,
  wrapped_secret      TEXT,
  device_id           TEXT,
  -- Held in the clear for the few minutes between approval and pickup, then
  -- deleted by the claiming read. The row is unreachable without the pickup
  -- token and expires regardless.
  device_token        TEXT
);

CREATE INDEX idx_link_expiry ON link_requests(expires_at);
