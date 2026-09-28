-- Abuse limits on the unauthenticated endpoints.
--
-- link_requests.requester: SHA-256 of the requesting address, so pending
-- requests can be capped per address instead of globally. A global cap let
-- anyone block `clipsync link` for everyone with 20 anonymous requests.

ALTER TABLE link_requests ADD COLUMN requester TEXT;
CREATE INDEX idx_link_requester ON link_requests(requester, approved_at);

-- invites.proof_hash now holds SHA-256 of the proof the claimant presents,
-- not the proof itself, so reading the table no longer lets anyone claim.
-- Invites live five minutes; any created under the old scheme are dropped
-- rather than left unclaimable.
DELETE FROM invites;
