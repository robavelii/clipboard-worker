-- Device keys and vault key epochs, for re-keying.
--
-- Revoking a device stops its token but not what it already knows: it holds
-- the vault key. A re-key moves the account to a fresh vault key and seals it
-- to each remaining device's own public key, so devices that never knew the
-- passphrase keep working and a revoked one is left behind.

-- The device's long-term ECDH public key (raw P-256, base64url). NULL until
-- the device registers one; a re-key cannot reach such a device.
ALTER TABLE devices ADD COLUMN public_key TEXT;

-- Which vault key is current. Bumped by each re-key.
ALTER TABLE users ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 0;

-- Which vault key encrypted each clip. Re-encryption after a re-key moves
-- clips forward; the index finds the ones still left behind.
ALTER TABLE clips ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_clips_user_epoch ON clips(user_id, key_epoch);

-- The current vault key sealed to each device ("d1." envelopes, see
-- packages/crypto/src/device.ts). The server cannot open these.
CREATE TABLE sealed_vault_keys (
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  epoch       INTEGER NOT NULL,
  sealed      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, epoch)
);
