-- Migration: VR exploration session lifecycle (Issue 6 of Round 2 of the
-- room-scoping/join-correctness/manipulation-authority/host-identity plan).
--
-- Two problems, both because nothing ever moves a session forward once
-- created: (1) a session stays 'preparing' forever — nothing calls
-- PUT .../status:'active' — and (2) nothing ends a session when its last
-- participant leaves, or cleans up a losing client's own orphaned row from a
-- create race. GET /sessions therefore lists every session ever created,
-- and a room can accumulate an unbounded number of independent VR sessions
-- over the same dataset with no way for two users to converge on one.
--
-- CORRECTION TO 021's OWN COMMENT (read this before touching
-- client_session_key/ux_vr_sessions_room_client_key): 021's header claims
-- client_session_key encodes dataset identity and that its
-- (room_id, client_session_key) uniqueness prevents two clients in the same
-- room from opening independent sessions over the same dataset. That is
-- wrong. client_session_key is session.id — a fresh
-- `vrsession_<Date.now()>_<random>` string minted client-side per VR-entry
-- ATTEMPT (see VRExplorationManager.startExploration), with no dataset
-- semantics at all: two attempts on the SAME dataset by the SAME client
-- mint two different keys, and the index does nothing to stop them. The
-- index itself is harmless (it does fix the narrower bug it was actually
-- built for — see 021's own comment on the room-scoping-not-global-uniqueness
-- change) — it just was never doing the per-dataset job its comment
-- attributed to it. dataset_sync_key below is the real per-dataset identity:
-- it carries resolveViewSyncKey()'s value (dataset id first, viewConfigId
-- fallback — see src/core/instances/viewSyncKey.js), which was computed
-- client-side all along but never actually sent to the server until now.
-- Do NOT remove 021's index — it still prevents a genuine same-room,
-- same-client-session-key double POST; it just isn't a dataset-collision
-- guard, and never was.
--
-- KNOWN LIMITATION (documented, not fixed here): resolveViewSyncKey() falls
-- back to a per-client-minted viewConfigId when an instance has no dataset
-- id yet. Two clients hitting that fallback mint DIFFERENT viewConfigIds, so
-- they never collide on dataset_sync_key and this migration's uniqueness
-- rule silently does not apply to them. This is the exact same gap the Y.js
-- vr-sessions registry already has for the same reason (see
-- VRExplorationManager._resolveSessionKey) — not a new hole, just not closed
-- by this change either.
--
-- dataset_sync_key is VARCHAR, not the existing UUID dataset_id column:
-- built-in demo datasets (e.g. "builtin-lungs") are client-side-only and get
-- nulled out of dataset_id by asUuidOrNull() (server/src/routes/vr.js) at
-- INSERT time, so dataset_id can never carry per-dataset identity for them.
--
-- PRODUCT DECISION (confirmed): one active (non-'ended') session per
-- (room, dataset_sync_key), enforced by ux_vr_sessions_room_dataset_active
-- below. Two users in the same room can no longer run independent VR
-- sessions over the same dataset — a losing POST /sessions adopts the
-- winner's row (server/src/routes/vr.js) rather than erroring. This hardens
-- what the Y.js registry (claimVRSession) already tries, unreliably, to do.
--
-- LAZY EXPIRY, same house style as 022_vr_manipulation_lease.sql's lease
-- reclaim: no sweeper/cron. last_heartbeat_at is fed by the client's
-- POST .../heartbeat (session-liveness, distinct from the manipulation
-- lease's own POST .../lease/heartbeat) and evaluated only when
-- reapStaleVrSessions() runs — at the top of GET /sessions, POST /sessions,
-- and POST /sessions/:id/join (server/src/routes/vr.js). A 'preparing'
-- session that never got its owner's first heartbeat is reaped sooner than
-- an 'active' one — see reapStaleVrSessions' REAP_*_STALE_MS constants.
--
-- No CHECK/ENUM change needed: status already permits 'active'
-- (init.sql ~:634) and ended_at already exists — this migration only adds
-- the columns/indexes the lifecycle logic reads and writes.

ALTER TABLE vr_exploration_sessions
  ADD COLUMN IF NOT EXISTS dataset_sync_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- Best-effort backfill so pre-existing non-ended rows aren't immediately
-- eligible for reaping the moment this migration lands (their heartbeat
-- history obviously doesn't exist) — treat "started, or at least created" as
-- a last-known-alive point, same COALESCE chain reapStaleVrSessions() itself
-- uses.
UPDATE vr_exploration_sessions
   SET last_heartbeat_at = COALESCE(started_at, created_at)
 WHERE last_heartbeat_at IS NULL AND status <> 'ended';

-- THE uniqueness rule: one non-ended session per (room, dataset). See the
-- correction-to-021 comment above for why this is a NEW column/index rather
-- than reusing ux_vr_sessions_room_client_key.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vr_sessions_room_dataset_active
  ON vr_exploration_sessions(room_id, dataset_sync_key)
  WHERE dataset_sync_key IS NOT NULL AND room_id IS NOT NULL AND status <> 'ended';

CREATE INDEX IF NOT EXISTS idx_vr_sessions_liveness
  ON vr_exploration_sessions(last_heartbeat_at) WHERE status <> 'ended';

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'dataset_sync_key'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'last_heartbeat_at'
    ) AND EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'ux_vr_sessions_room_dataset_active'
    ) AND EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_vr_sessions_liveness'
    ) THEN
        RAISE NOTICE 'VR session lifecycle migration applied successfully';
    ELSE
        RAISE EXCEPTION 'Failed to apply VR session lifecycle migration';
    END IF;
END
$$;
