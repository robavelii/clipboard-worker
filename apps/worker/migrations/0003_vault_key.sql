-- The vault key, sealed under a key derived from the passphrase.
--
-- Content keys now hang off a vault key rather than off the passphrase
-- directly, so changing the passphrase re-wraps 32 bytes instead of
-- re-encrypting every clip. The server stores only the sealed form and has no
-- way to open it.
--
-- NULL means the account has not been migrated yet; the first device to unlock
-- it writes the wrapped key. See packages/crypto/src/index.ts.

ALTER TABLE users ADD COLUMN wrapped_vault_key TEXT;
