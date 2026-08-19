-- Migration: VR manipulation lease (Phase D1 of the room-scoping/join-
-- correctness/manipulation-authority plan).
--
-- A manipulation lease is strictly 1:1 with a session, so it lives as five
-- columns on vr_exploration_sessions rather than a new table: a single
-- atomic `UPDATE ... WHERE` gives the same compare-and-swap shape already
-- used for view OCC (views.js's base_revision check, views.js:437-445),
-- with no join and no orphan rows to garbage-collect. The manipulation
-- *request* queue stays entirely in Y.js (vr-manipulation-<sessionId>) — it
-- is advisory UI, not authority, so it does not belong here.
--
-- lease_epoch is the fencing token: it increments on every acquire/grant
-- (server/src/routes/vr.js's POST /sessions/:id/lease and
-- POST /sessions/:id/lease/grant). POST /sessions/:id/lease/heartbeat must
-- match it in its WHERE clause (lease_participant_id = $2 AND
-- lease_epoch = $3) so a participant who has been preempted — superseded by
-- a newer acquire or an explicit grant to someone else — cannot extend a
-- lease that is no longer theirs, even if their heartbeat request was
-- already in flight when the preemption happened.
--
-- Stale-lease reclaim is lazy: the acquire WHERE clause includes
-- `lease_expires_at < NOW()` as an alternative to "currently unheld", so an
-- expired lease is simply reclaimable on the next acquire attempt. There is
-- no sweeper job or cron — expiry is evaluated only when someone next tries
-- to acquire.
--
-- revision is the session-level "authority epoch" — bumped on lease changes
-- only (acquire/grant/release), never on every visualization mutation.
-- view_configurations already has its own revision/base_revision pair for
-- per-mutation OCC; inventing a second per-patch counter here would race
-- against that one and neither would be trustworthy (see D6 of the plan).

ALTER TABLE vr_exploration_sessions
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_participant_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS lease_user_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'revision'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'lease_participant_id'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'lease_user_name'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'lease_expires_at'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'lease_epoch'
    ) THEN
        RAISE NOTICE 'VR manipulation lease migration applied successfully';
    ELSE
        RAISE EXCEPTION 'Failed to apply VR manipulation lease migration';
    END IF;
END
$$;
