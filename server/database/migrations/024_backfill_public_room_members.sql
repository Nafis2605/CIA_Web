-- Migration: backfill room_members for public rooms.
--
-- WHY THIS EXISTS
-- room_members was completely empty (0 rows) on every deployment, including
-- the seeded Demo Room / Main Room, because nothing ever wrote to it:
-- init.sql seeds project_members (for the five fixed dev UUIDs) but never
-- room_members, createMainRoom() in server/src/routes/rooms.js only adds the
-- creator of a room it creates itself, and the one self-join endpoint
-- (POST /api/projects/:projectId/rooms/:roomId/join) is called from exactly
-- one place -- the Rooms panel's manual "Join" button.
--
-- That was invisible for most of the app, because every guard except two
-- short-circuits under DEV_BYPASS_AUTH. The two exceptions are the newest
-- ones, and they are precisely the VR collaboration path:
--   * resolveRoomAccess()      server/src/routes/vr.js
--   * wsManager._checkRoomAccess()  server/src/services/websocket.js
-- Both are raw membership queries. Both returned 403 / "Access denied" for
-- any identity that was not one of the five seeded UUIDs -- i.e. for every
-- real headset, which uses a per-device UUID from
-- src/core/identity/deviceIdentity.js. The WS denial left
-- wsManager.roomChannels empty, so every broadcastToRoom() VR event
-- (vr:session-created, vr:participant-joined, vr:lease-changed, ...) reached
-- zero sockets. Two headsets in the same room could never see each other.
--
-- Going forward, dev-bypass device identities are provisioned on first API
-- call by grantDevMemberships() in server/src/middleware/auth.js. This
-- migration closes the gap for rows that already exist.
--
-- SCOPE: public rooms only, and only for users who are already members of
-- the room's project. Private rooms still require a real invite -- this
-- grants nothing that resolveRoomAccess's own `is_public AND project_members`
-- branch would not already have allowed. It only materialises that implicit
-- access as explicit rows, so member lists and rosters stop showing an empty
-- room that demonstrably has people in it.

INSERT INTO room_members (room_id, user_id, role)
SELECT r.id, pm.user_id, 'member'
  FROM rooms r
  JOIN project_members pm ON pm.project_id = r.project_id
 WHERE r.is_public = true
ON CONFLICT (room_id, user_id) DO NOTHING;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
DECLARE
    orphaned INTEGER;
BEGIN
    -- Every (public room, project member) pair must now have a room_members
    -- row. If any remain, the INSERT above silently did not cover them.
    SELECT COUNT(*) INTO orphaned
      FROM rooms r
      JOIN project_members pm ON pm.project_id = r.project_id
     WHERE r.is_public = true
       AND NOT EXISTS (
         SELECT 1 FROM room_members rm
          WHERE rm.room_id = r.id AND rm.user_id = pm.user_id
       );

    IF orphaned = 0 THEN
        RAISE NOTICE 'Public room membership backfill applied successfully';
    ELSE
        RAISE EXCEPTION 'Backfill incomplete: % (public room, project member) pairs still unmatched', orphaned;
    END IF;
END
$$;
