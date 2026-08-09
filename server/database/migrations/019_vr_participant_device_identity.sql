-- Migration: split VR participant account identity from device identity,
-- and give VR sessions a client-owned stable key separate from their
-- server-generated primary key.
--
-- H2: vr_session_participants previously upserted on (session_id,
-- od_user_id) where od_user_id was the account id only. Two devices signed
-- into the same account joining the same session collided on one row.
-- account_user_id keeps the account id (used for auth/ownership-style
-- checks); participant_id is the account+device composite
-- (`${accountId}#${deviceId}`, mirrors getParticipantId() in
-- src/collaboration/presence/userManagement.js) and is now the uniqueness
-- key for the roster.
--
-- H3: vr_exploration_sessions gets client_session_key so a client's
-- locally-generated collaboration id can be recorded on the row without
-- being forced to also be its primary key.

ALTER TABLE vr_session_participants RENAME COLUMN od_user_id TO account_user_id;
ALTER TABLE vr_session_participants ADD COLUMN participant_id VARCHAR(255);
UPDATE vr_session_participants SET participant_id = account_user_id WHERE participant_id IS NULL;
ALTER TABLE vr_session_participants ALTER COLUMN participant_id SET NOT NULL;

ALTER TABLE vr_session_participants DROP CONSTRAINT IF EXISTS unique_session_participant;
ALTER TABLE vr_session_participants ADD CONSTRAINT unique_session_participant UNIQUE (session_id, participant_id);

ALTER INDEX IF EXISTS idx_vr_participants_user RENAME TO idx_vr_participants_account;
CREATE INDEX IF NOT EXISTS idx_vr_participants_participant ON vr_session_participants(participant_id);

ALTER TABLE vr_exploration_sessions ADD COLUMN IF NOT EXISTS client_session_key VARCHAR(64);
ALTER TABLE vr_exploration_sessions DROP CONSTRAINT IF EXISTS vr_sessions_client_key_unique;
ALTER TABLE vr_exploration_sessions ADD CONSTRAINT vr_sessions_client_key_unique UNIQUE (client_session_key);

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vr_session_participants' AND column_name = 'participant_id'
    ) THEN
        RAISE NOTICE 'VR participant device identity migration applied successfully';
    ELSE
        RAISE EXCEPTION 'Failed to apply VR participant device identity migration';
    END IF;
END
$$;
