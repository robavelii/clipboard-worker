-- Free as a trial, Pro as the paid plan (decisions §54). Additive only: the
-- live Worker reads the free row's new numbers at once and ignores max_pins
-- until the new one replaces it.

-- Pinned clips never expire, so a plan that keeps history briefly also caps
-- how many may be pinned. NULL: no cap.
ALTER TABLE plans ADD COLUMN max_pins INTEGER;

-- One computer and one phone, a few days of text, a day of images, no other
-- files. Clips already stored keep the expiry they were written with.
UPDATE plans
   SET max_devices = 2, text_ttl_days = 3, file_ttl_days = 1, files = 0,
       storage_bytes = 10485760, class_a = 500, class_b = 5000, max_pins = 10
 WHERE name = 'free';

-- What billing will sell. Its numbers are one UPDATE away, like the others.
INSERT INTO plans (name, max_devices, text_ttl_days, file_ttl_days, files, storage_bytes, class_a, class_b, max_pins)
VALUES ('pro', 10, 90, 30, 1, 2147483648, 20000, 200000, NULL);
