-- Proof of the passphrase, so only its holder can replace the wrapped key.
--
-- Devices joined by link or invite hold the vault key but never learn the
-- passphrase. Holding the vault key is enough to wrap it under a passphrase
-- of one's own, so without this any such device could lock the owner out.
--
-- auth_hash is SHA-256 of an HKDF branch off the PBKDF2 master, separate from
-- the KEK (see packages/crypto/src/index.ts). NULL on accounts that predate
-- it; the next passphrase unlock registers it (POST /api/vault/auth).

ALTER TABLE users ADD COLUMN auth_hash TEXT;
