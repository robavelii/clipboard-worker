-- The recovery key (decisions §48). Additive only: nullable columns the
-- running Worker never reads.
--
-- All of it is safe for the server to hold: the recovery key's public key,
-- its private key wrapped under the recovery key, the current vault key
-- sealed to the public key, the epoch that seal is for, and a SHA-256 of the
-- proof derived from the recovery key. On the users row, so deleting the
-- account deletes it.
ALTER TABLE users ADD COLUMN recovery_public_key TEXT;
ALTER TABLE users ADD COLUMN recovery_private TEXT;
ALTER TABLE users ADD COLUMN recovery_sealed TEXT;
ALTER TABLE users ADD COLUMN recovery_epoch INTEGER;
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
