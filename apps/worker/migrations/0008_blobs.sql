-- Images and files: encrypted chunks in R2, tracked here.

-- The blob holding an image or file clip's bytes; null for text.
ALTER TABLE clips ADD COLUMN blob_id TEXT;
CREATE INDEX idx_clips_blob ON clips(blob_id);

-- One row per uploaded blob. `size` is the declared ciphertext total,
-- reserved against the storage budget when the blob is created, so the
-- budget holds while chunks are still arriving. A blob no clip adopted
-- within an hour is an abandoned upload, and the cron deletes it.
CREATE TABLE blobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunks      INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  attached_at INTEGER
);

CREATE TABLE blob_chunks (
  blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  size    INTEGER NOT NULL,
  PRIMARY KEY (blob_id, idx)
);

-- R2 operations this Worker made, per UTC month, counted before each one
-- is made and refused past the budget: the guard against leaving the free
-- tier, since R2 itself has no spending cap.
CREATE TABLE r2_usage (
  month   TEXT PRIMARY KEY,
  class_a INTEGER NOT NULL DEFAULT 0,
  class_b INTEGER NOT NULL DEFAULT 0
);
