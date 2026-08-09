// server/src/routes/roomLookup.js
// LEGACY COMPAT ONLY: resolves a bare room id to its owning project id, for
// old /rooms/:roomId bookmarks and share links from before the app moved to
// the /projects/:projectId/rooms/:roomId URL scheme. The canonical URL flow
// never calls this — it already knows its projectId from the URL.
//
// Returns no membership data. The client always re-validates real access via
// the existing GET /api/projects/:projectId/rooms/:roomId afterward, so this
// endpoint can't grant access beyond what that re-check allows — it only
// reveals which project a room id belongs to, no more sensitive than the
// room id itself.

const express = require("express");
const router = express.Router();
const { createLogger } = require("../utils/logger");
const { validateRoomId } = require("../middleware/validateUUID");

const log = createLogger("room-lookup");

/**
 * GET /api/rooms/:roomId
 * Legacy-link compat lookup: room id -> owning project id.
 * DM rooms are excluded — they were never link-shareable and shouldn't be
 * discoverable via a bare id guess.
 */
router.get("/:roomId", validateRoomId, async (req, res, next) => {
  try {
    const { roomId } = req.params;
    const { pool } = req.app.locals;

    const result = await pool.query(
      `SELECT id, project_id, name, room_type, is_public
       FROM rooms WHERE id = $1 AND room_type != 'dm'`,
      [roomId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Room not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    log.error("Error resolving legacy room:", error);
    next(error);
  }
});

module.exports = router;
