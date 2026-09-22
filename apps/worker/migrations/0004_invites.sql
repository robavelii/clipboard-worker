-- Scan-to-join invites.
--
-- The set-up device seals the vault key under a secret that exists only in a
-- QR code. This table holds the ciphertext and a hash proving who may claim
-- it; the server can open neither. See packages/crypto/src/invite.ts.

CREATE TABLE invites (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the QR secret. Claiming requires presenting it, so knowing the
  -- invite id alone is not enough to enrol a device.
  proof_hash       TEXT NOT NULL,
  -- The vault key, sealed under a key derived from the QR secret.
  sealed_vault_key TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  claimed_at       INTEGER
);

CREATE INDEX idx_invites_expiry ON invites(expires_at);
