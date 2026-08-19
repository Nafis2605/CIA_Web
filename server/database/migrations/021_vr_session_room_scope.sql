-- Migration: scope VR exploration sessions to a room, not just a project.
--
-- VR was built on project-scoped REST/WebSocket state, but every
-- collaboration channel it actually depends on (Y.js — yjsSetup.js binds the
-- ydoc to sessionManager.getRoomId()) is room-scoped. A user in room B could
-- list and join a session created in room A: the server would record them
-- as a participant and announce it project-wide, but their Y.js doc is a
-- different document entirely — no poses, no visualization updates, no
-- avatars. room_id closes that gap.
--
-- owner_participant_id: VRManipulationLock.isHost() compares against
-- owner_user_id, which is account-level, so the same account signed in on
-- two devices (headset + laptop) both believe they are host. Recording the
-- account+device composite here (buildParticipantId(userId, deviceId),
-- already computed in server/src/routes/vr.js) gives future host/authority
-- checks the right grain.
--
-- room_id is deliberately NOT NOT NULL: a legacy row's project_id can itself
-- be null, or its project may have no main room, so a backfill can leave
-- room_id unresolved. Presence is enforced at the application layer (new
-- session creation requires roomId in the request body) rather than at the
-- schema level, so this migration can never abort partway through on
-- pre-existing data.

ALTER TABLE vr_exploration_sessions
  ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS owner_participant_id VARCHAR(255);

-- Best-effort backfill: attribute pre-existing sessions to their project's
-- main room. Sessions whose project has no main room (or no project_id at
-- all) are simply left with room_id = NULL and degrade to no broadcast
-- audience (see the `if (!roomId) return;` guard added to the wsManager.vr*
-- helpers) rather than blocking the migration.
UPDATE vr_exploration_sessions s SET room_id = (
  SELECT r.id FROM rooms r WHERE r.project_id = s.project_id AND r.is_main = true LIMIT 1
) WHERE room_id IS NULL;

-- client_session_key (019_vr_participant_device_identity.sql) was uniqued
-- globally, but _resolveSessionKey() on the client returns the dataset id —
-- two rooms exploring the same dataset mint the same key, and the second
-- POST /vr/sessions in the second room hits a 23505 that the generic error
-- handler turns into an opaque 500. Scoping the uniqueness to (room_id,
-- client_session_key) fixes that while still preventing a genuine
-- same-room double-create.
ALTER TABLE vr_exploration_sessions
  DROP CONSTRAINT IF EXISTS vr_sessions_client_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ux_vr_sessions_room_client_key
  ON vr_exploration_sessions(room_id, client_session_key) WHERE client_session_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vr_sessions_room_active
  ON vr_exploration_sessions(room_id, status) WHERE status <> 'ended';

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'room_id'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_exploration_sessions' AND column_name = 'owner_participant_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vr_sessions_client_key_unique'
    ) AND EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'ux_vr_sessions_room_client_key'
    ) THEN
        RAISE NOTICE 'VR session room scope migration applied successfully';
    ELSE
        RAISE EXCEPTION 'Failed to apply VR session room scope migration';
    END IF;
END
$$;
