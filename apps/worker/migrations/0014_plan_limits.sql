-- Plans can cap pinned clips (decisions §54). Additive only: the live
-- Worker ignores the column until the new one replaces it.

-- Pinned clips never expire, so a plan that keeps history briefly also caps
-- how many may be pinned. NULL: no cap. The plans a hosted service sells
-- set it in their own rows; this repository's plans set none.
ALTER TABLE plans ADD COLUMN max_pins INTEGER;
