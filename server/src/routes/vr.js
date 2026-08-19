// server/src/routes/vr.js
// VR exploration session management API

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { createLogger } = require("../utils/logger");
const { isValidUUID } = require("../middleware/validateUUID");
const vrPreprocessing = require("../services/vrPreprocessing");
const {
  getUserId,
  getUser,
  ensureDevPublicRoomMembership,
} = require("../middleware/auth");

// Device ids come from the client (localStorage-backed, see
// src/core/identity/deviceIdentity.js) and are only ever used to build the
// composite participant id below — never for authorization. "#" is the
// separator, so strip any the client sends to keep the composite parseable.
function buildParticipantId(accountUserId, rawDeviceId) {
  const deviceId = String(rawDeviceId || "default").replace(/#/g, "").slice(0, 200);
  return `${accountUserId}#${deviceId}`;
}

const router = express.Router({ mergeParams: true });
const log = createLogger("vr");

// Default manipulation-lease TTL (Phase D2 of the room-scoping/join-
// correctness/manipulation-authority plan). Deliberately above the client's
// MANIP_STALE_MS (8000ms, src/core/vr/VRManipulationLock.js:40) so the
// client's own staleness view never reads "free" while the server still
// holds the lease — otherwise a client could locally treat a still-valid
// server lease as abandoned and start manipulating before the server would
// actually let a competing acquire through.
const LEASE_TTL_DEFAULT_MS = 10000;

function resolveLeaseTtlMs(rawTtlMs) {
  const n = Number(rawTtlMs);
  return Number.isFinite(n) && n > 0 ? n : LEASE_TTL_DEFAULT_MS;
}

// Lazy-expiry thresholds (Issue 6 of Round 2 — session lifecycle). Mirrors
// the manipulation lease's "no sweeper, evaluated lazily" house style (see
// 022_vr_manipulation_lease.sql's header) rather than adding a cron/interval
// job. A 'preparing' session that never received its owner device's first
// POST .../heartbeat is reaped sooner than an 'active' one — stuck in
// 'preparing' this long almost always means the owner's tab/headset died
// before ever completing VR entry, not a slow start.
const REAP_PREPARING_STALE_MS = 90000;
const REAP_ACTIVE_STALE_MS = 120000;

/**
 * Lazily expire sessions in `roomId` whose heartbeat has gone stale — the
 * session-lifecycle equivalent of the manipulation lease's lazy stale
 * reclaim, evaluated only when this runs (no sweeper job). Ending a session
 * this way also clears its lease columns, or a reaped session would leave a
 * dangling manipulation lease nobody can ever release.
 *
 * Called at the top of GET /sessions (unlisting), POST /sessions (scoped to
 * the new session's datasetSyncKey, so a stale slot occupying that exact
 * (room, dataset) pair doesn't force a spurious unique-index
 * conflict/adoption), and POST /sessions/:id/join (so joining a zombie 404s
 * honestly instead of attaching to a dead session).
 *
 * @param {import('pg').Pool} pool
 * @param {string|null|undefined} roomId
 * @param {{datasetSyncKey?: string|null}} [opts] - when omitted/null, every
 *   stale non-ended session in the room is reaped regardless of dataset.
 * @returns {Promise<object[]>} the reaped rows (full columns), so the caller
 *   can broadcast wsManager.vrSessionEnded(row.room_id, row.id) for each.
 */
async function reapStaleVrSessions(pool, roomId, { datasetSyncKey = null } = {}) {
  if (!roomId) return [];
  const result = await pool.query(
    `UPDATE vr_exploration_sessions
        SET status = 'ended', ended_at = NOW(),
            lease_participant_id = NULL, lease_user_name = NULL, lease_expires_at = NULL
      WHERE room_id = $1 AND status <> 'ended'
        AND ($2::varchar IS NULL OR dataset_sync_key = $2)
        AND COALESCE(last_heartbeat_at, started_at, created_at) <
          NOW() - (CASE WHEN status = 'preparing'
                         THEN ($3 || ' milliseconds')::interval
                         ELSE ($4 || ' milliseconds')::interval END)
      RETURNING *`,
    [roomId, datasetSyncKey, REAP_PREPARING_STALE_MS, REAP_ACTIVE_STALE_MS]
  );
  return result.rows;
}

// Client-supplied ids bound into UUID columns are sometimes not UUIDs at all —
// built-in demo datasets (e.g. "builtin-lungs") are client-side-only and have
// no row in `datasets`, so Postgres rejects the cast and the whole insert
// aborts (see the "invalid input syntax for type uuid" failure this guards
// against). Mirrors the client's own builtin-id guard in
// ViewConfigurationManager.createView(); null is always safe here since every
// UUID column these ids feed is nullable (ON DELETE SET NULL / no NOT NULL).
function asUuidOrNull(value) {
  if (isValidUUID(value)) return value;
  if (value != null) {
    log.debug(`Non-UUID id "${value}" nulled before UUID column bind`);
  }
  return null;
}

/**
 * Local access guard for VR routes. Not middleware — no VR route has
 * :roomId in its path (session id, not room id, is the URL param), so
 * requireRoomPermission (auth.js:608), which reads req.params.roomId, does
 * not apply here.
 *
 * Deliberately does NOT call checkRoomAccess (auth.js:517): under
 * DEV_BYPASS_AUTH it short-circuits to `{allowed:true, role:'admin',
 * room:null}` (auth.js:518), which would make every dev-bypass caller "a
 * room member" and leave `.room` unusable for the room-vs-project
 * comparison below. rooms.js already hit the same problem for
 * GET /:roomId/members and worked around it with a plain query instead of
 * checkRoomAccess/requireRoomPermission (see the comment there) — this
 * mirrors that pattern so the guard is actually enforced under the
 * DEV_BYPASS_AUTH harness this project's integration tests run under, not
 * just in production.
 *
 * @param {import('pg').Pool} pool
 * @param {string} roomId
 * @param {string} userId
 * @param {string} [expectedProjectId] - when given, the room must belong to
 *   this project or the guard fails with 409 (catches a roomId/projectId
 *   pair that doesn't actually correspond to the same room+project).
 * @returns {Promise<{ok:true, room:{id:string,project_id:string,name:string}, role:string}
 *                   |{ok:false, status:number, body:object}>}
 */
async function resolveRoomAccess(pool, roomId, userId, expectedProjectId) {
  if (!roomId) {
    return { ok: false, status: 400, body: { error: "missing-room" } };
  }
  // roomId binds into a `uuid` column below. A malformed value (client bug,
  // or a stale/local id like the vrsession_* pattern used elsewhere in this
  // file) would otherwise reach Postgres as-is and raise 22P02 invalid
  // input syntax, which the route's generic catch turns into an opaque
  // 500 — validate it here instead, same as asUuidOrNull already does for
  // the other client-supplied ids in this file, and return a distinct code
  // from the missing-roomId case so the client can tell "you forgot to
  // send one" apart from "you sent something malformed".
  const validRoomId = asUuidOrNull(roomId);
  if (!validRoomId) {
    return { ok: false, status: 400, body: { error: "invalid-room" } };
  }

  const result = await pool.query(
    `SELECT r.id, r.project_id, r.name,
       EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.user_id = $2) AS is_room_member,
       (SELECT rm.role FROM room_members rm WHERE rm.room_id = r.id AND rm.user_id = $2) AS member_role,
       (r.is_public AND EXISTS(
         SELECT 1 FROM project_members pm WHERE pm.project_id = r.project_id AND pm.user_id = $2
       )) AS via_public_room
     FROM rooms r
     WHERE r.id = $1`,
    [validRoomId, userId]
  );

  const row = result.rows[0];
  // A nonexistent room and "not a member" both come back as the same
  // not-a-room-member error — no need to distinguish, and folding them
  // together avoids confirming/denying room existence to a non-member.
  if (!row || (!row.is_room_member && !row.via_public_room)) {
    // Last chance before refusing: in dev bypass, a per-device identity may
    // self-join a PUBLIC room. Real headsets authenticate as their own device
    // UUID (src/core/identity/deviceIdentity.js), which belongs to no project
    // and no room, so without this every headset is refused here — and,
    // because the WS guard applies the same rule, never joins the room
    // channel either, which silently drops every VR broadcast. No-ops for
    // private rooms and outside dev bypass. See auth.js for the full note.
    const selfJoined =
      row && (await ensureDevPublicRoomMembership(pool, validRoomId, userId));
    if (!selfJoined) {
      return { ok: false, status: 403, body: { error: "not-a-room-member" } };
    }
    row.is_room_member = true;
    row.member_role = "member";
  }

  if (expectedProjectId && row.project_id !== expectedProjectId) {
    return {
      ok: false,
      status: 409,
      body: { error: "room-project-mismatch", roomId: validRoomId, projectId: row.project_id },
    };
  }

  return {
    ok: true,
    room: { id: row.id, project_id: row.project_id, name: row.name },
    role: row.is_room_member ? row.member_role || "member" : "member",
  };
}

/**
 * Recover a built-in dataset's client-side manifest key (e.g. "builtin-lungs")
 * for a session whose `dataset_id` column is NULL because asUuidOrNull()
 * rejected that non-UUID string at INSERT time (POST /sessions above).
 *
 * ViewConfigurationManager.createView() (src/core/data/managers/
 * ViewConfigurationManager.js) hits the identical constraint on
 * view_configurations.dataset_id and works around it by stashing the raw key
 * in `visualization.builtinDatasetId`, then recovering it client-side via its
 * own _recoverBuiltinDatasetId() on read. A client joining a session it
 * didn't create has no local view to read that from — this is the
 * server-side mirror of that same recovery, keyed off the session's
 * view_configuration_id instead. Without it, dataset.id would be null for
 * every builtin-hosted session and a joiner without the dataset already open
 * could never know what to auto-load.
 *
 * @param {import('pg').Pool} pool
 * @param {string|null} viewConfigurationId
 * @returns {Promise<string|null>}
 */
async function recoverBuiltinDatasetId(pool, viewConfigurationId) {
  if (!viewConfigurationId) return null;
  try {
    const result = await pool.query(
      `SELECT visualization->>'builtinDatasetId' AS builtin_id FROM view_configurations WHERE id = $1`,
      [viewConfigurationId]
    );
    return result.rows[0]?.builtin_id || null;
  } catch (err) {
    // migration 017 (view_configurations.visualization) not applied, or the
    // view row is gone — degrade to "no builtin id recovered" rather than
    // failing the whole join.
    log.debug(`recoverBuiltinDatasetId: lookup failed for view ${viewConfigurationId}: ${err.message}`);
    return null;
  }
}

/**
 * Build the authoritative visualization/time/camera snapshot for a session's
 * view (Phase C of the room-scoping/join-correctness plan) — used both to
 * embed `state` in the join response (so a joiner needs no second round
 * trip) and by `GET /sessions/:id/state` (resync, e.g. after a reconnect).
 *
 * Reads `view_configurations.visualization` / `.time` / `.camera` /
 * `.revision` (migration 017 added the first two; `camera` and `revision`
 * already existed). A session with no `view_configuration_id` — or whose
 * view row is gone/unreadable — has nothing to snapshot: revision 0,
 * visualization null, so a joiner's hydration step has nothing to apply and
 * falls through cleanly to whatever Y.js replay finds.
 *
 * builtinDatasetId stripping: `visualization` is the SAME JSONB column
 * recoverBuiltinDatasetId() above reads `builtinDatasetId` out of — a
 * server-plumbing key ViewConfigurationManager.createView() stashes there
 * (client-side) purely to recover a non-UUID manifest key later. It is not
 * part of the shared visualization state applySharedState() knows how to
 * consume, and must not round-trip into a joiner's local visualization state
 * (a client that runs a future patch through that state and echoes it back
 * to Y.js/REST would otherwise re-persist it as if it were a real
 * visualization field). Stripped here so both consumers of this function
 * (join response and the resync route) get a clean object.
 *
 * @param {import('pg').Pool} pool
 * @param {object} session - vr_exploration_sessions row (view_configuration_id)
 * @returns {Promise<{viewConfigurationId: string|null, revision: number,
 *   visualization: object|null, time: object|null, camera: object|null,
 *   updatedAt: string|null}>}
 */
async function buildSessionState(pool, session) {
  const viewConfigurationId = session?.view_configuration_id || null;
  const empty = {
    viewConfigurationId,
    revision: 0,
    visualization: null,
    time: null,
    camera: null,
    updatedAt: null,
  };
  if (!viewConfigurationId) return empty;

  try {
    const result = await pool.query(
      `SELECT visualization, time, camera, revision, updated_at
       FROM view_configurations WHERE id = $1`,
      [viewConfigurationId]
    );
    const row = result.rows[0];
    if (!row) return empty;

    let visualization = row.visualization || null;
    if (visualization && Object.prototype.hasOwnProperty.call(visualization, "builtinDatasetId")) {
      const { builtinDatasetId, ...rest } = visualization; // eslint-disable-line no-unused-vars
      visualization = rest;
    }

    return {
      viewConfigurationId,
      revision: row.revision != null ? Number(row.revision) : 0,
      visualization,
      time: row.time || null,
      camera: row.camera || null,
      updatedAt: row.updated_at || null,
    };
  } catch (err) {
    // Same degrade-rather-than-fail posture as recoverBuiltinDatasetId: a
    // missing migration or a since-deleted view row must not fail the whole
    // join/resync request.
    log.debug(`buildSessionState: lookup failed for view ${viewConfigurationId}: ${err.message}`);
    return empty;
  }
}

/**
 * Build the `lease` descriptor embedded in the join response and in the
 * wsManager.vrLeaseChanged broadcast payload (Phase D1/D2 of the
 * room-scoping/join-correctness/manipulation-authority plan).
 *
 * A lease whose lease_expires_at has already passed is reported as free
 * here even though the row itself isn't cleared until the next acquire
 * (stale reclaim is lazy — see 022_vr_manipulation_lease.sql). A joiner or
 * resync client should see the true current state, not a lease that is
 * mechanically still on the row but functionally expired.
 *
 * @param {object} session - vr_exploration_sessions row (or any object
 *   carrying the five lease_* columns plus revision)
 * @returns {{holderParticipantId:string, holderName:string|null,
 *   expiresAt:string, epoch:number}|null}
 */
function buildLeaseDescriptor(session) {
  if (!session || !session.lease_participant_id || !session.lease_expires_at) {
    return null;
  }
  if (new Date(session.lease_expires_at).getTime() <= Date.now()) {
    return null;
  }
  return {
    holderParticipantId: session.lease_participant_id,
    holderName: session.lease_user_name || null,
    expiresAt: session.lease_expires_at,
    epoch: Number(session.lease_epoch),
  };
}

/**
 * Build the `dataset` descriptor for the join response contract (see
 * POST /sessions/:id/join below) — Phase B scope only. This resolves WHICH
 * dataset the session is showing and how a joiner should load it; the full
 * visualization snapshot (`state` in the contract) is buildSessionState()
 * above.
 *
 * @param {import('pg').Pool} pool
 * @param {object} session - vr_exploration_sessions row
 * @returns {Promise<{id: string|null, kind: 'builtin'|'server', name: string|null}>}
 */
async function buildDatasetDescriptor(pool, session) {
  const uuidId = asUuidOrNull(session.dataset_id);
  if (uuidId) {
    const result = await pool.query(`SELECT filename FROM datasets WHERE id = $1`, [uuidId]);
    return { id: uuidId, kind: "server", name: result.rows[0]?.filename || null };
  }
  // Not a real dataset row — either genuinely no dataset, or a builtin whose
  // client-side key isn't a UUID and was nulled on insert (see asUuidOrNull).
  // Both collapse to 'builtin' here; recoverBuiltinDatasetId resolves the
  // actual key when one exists, and returns null (a legitimately unknown
  // dataset) otherwise.
  const builtinId = await recoverBuiltinDatasetId(pool, session.view_configuration_id);
  return { id: builtinId, kind: "builtin", name: builtinId };
}

// =============================================================================
// SESSION CRUD
// =============================================================================

/**
 * POST /vr/sessions
 * Create a new VR exploration session.
 *
 * The returned row's owner_participant_id (accountUserId#deviceId, 021) is
 * the AUTHORITATIVE host identity — owner_user_id is only the account and
 * cannot distinguish two devices signed into the same account. Client-side
 * consumers should resolve host identity via
 * src/core/vr/vrSessionOwner.js's resolveServerSessionOwnerId(), not by
 * reading owner_user_id directly.
 */
router.post("/sessions", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const {
      viewConfigurationId,
      datasetId,
      projectId,
      roomId,
      selectionType,
      explorationMode,
      vrScale,
      allowJoin,
      allowDesktopParticipants,
      allowDesktopControl,
      regionOfInterest,
      selectionIds,
      deviceId,
      clientSessionKey,
      // Per-dataset identity (Issue 6) — resolveViewSyncKey() on the client,
      // NOT clientSessionKey above (see this route's docstring correction to
      // 021's comment). Drives ux_vr_sessions_room_dataset_active.
      datasetSyncKey,
    } = req.body;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // A VR session belongs to exactly one room — the Y.js doc it needs to
    // ride on (yjsSetup.js binds ydoc to sessionManager.getRoomId()) is
    // room-scoped, so a session with no room can never be joined correctly.
    // New sessions must supply roomId; room_id stays nullable at the schema
    // level only to accommodate rows created before this route required it.
    const access = await resolveRoomAccess(pool, roomId, userId, asUuidOrNull(projectId) || projectId);
    if (!access.ok) {
      return res.status(access.status).json(access.body);
    }

    const userName = getUser(req)?.name || "Anonymous";
    const participantId = buildParticipantId(userId, deviceId);

    // Lazy expiry (Issue 6), scoped to the exact (room, dataset) slot this
    // create would otherwise collide on — a session stuck 'preparing'/
    // 'active' with a dead heartbeat must not force a spurious 23505/
    // adoption below. Only meaningful when a datasetSyncKey was actually
    // supplied: without one, this create can never hit
    // ux_vr_sessions_room_dataset_active in the first place (that index only
    // fires on a non-null dataset_sync_key), so there is nothing to protect.
    if (datasetSyncKey) {
      const reaped = await reapStaleVrSessions(pool, access.room.id, { datasetSyncKey });
      if (wsManager) {
        for (const row of reaped) wsManager.vrSessionEnded(row.room_id, row.id);
      }
    }

    const sessionId = uuidv4();

    let session;
    try {
      // Create session
      const result = await pool.query(
        `INSERT INTO vr_exploration_sessions (
          id, view_configuration_id, dataset_id, project_id, room_id,
          owner_user_id, owner_user_name, owner_participant_id,
          selection_type, default_exploration_mode, default_vr_scale,
          allow_join, allow_desktop_participants, allow_desktop_control,
          region_of_interest, selection_ids,
          status, client_session_key, dataset_sync_key, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
        RETURNING *`,
        [
          sessionId,
          asUuidOrNull(viewConfigurationId),
          asUuidOrNull(datasetId),
          asUuidOrNull(projectId),
          access.room.id, // validated by resolveRoomAccess, not the raw request body value
          userId,
          userName,
          participantId,
          selectionType || "full",
          explorationMode || "fly",
          vrScale || 1.0,
          allowJoin !== false,
          allowDesktopParticipants !== false,
          allowDesktopControl !== false,
          regionOfInterest ? JSON.stringify(regionOfInterest) : null,
          selectionIds ? JSON.stringify(selectionIds) : null,
          "preparing",
          clientSessionKey || null,
          datasetSyncKey || null,
        ]
      );
      session = result.rows[0];
    } catch (insertErr) {
      // One active session per (room, dataset) — ux_vr_sessions_room_dataset_active
      // (023_vr_session_lifecycle.sql). Losing this race adopts the winner
      // instead of erroring: the caller still gets a usable, canonical
      // session id — it's just not the row it asked to create.
      if (insertErr.code === "23505" && insertErr.constraint === "ux_vr_sessions_room_dataset_active") {
        const winner = await pool.query(
          `SELECT * FROM vr_exploration_sessions
            WHERE room_id = $1 AND dataset_sync_key = $2 AND status <> 'ended'
            LIMIT 1`,
          [access.room.id, datasetSyncKey]
        );
        const winnerRow = winner.rows[0];
        if (!winnerRow) {
          // The winner itself vanished between the conflict and this
          // re-select (e.g. reaped or ended concurrently) — a genuine
          // failure, not something adoption can paper over.
          return res.status(409).json({ error: "session-create-conflict" });
        }

        const participantResult = await pool.query(
          `INSERT INTO vr_session_participants (
            id, session_id, account_user_id, participant_id, user_name, mode, joined_at, last_active_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
          ON CONFLICT (session_id, participant_id) DO UPDATE SET last_active_at = NOW()
          RETURNING *`,
          [uuidv4(), winnerRow.id, userId, participantId, userName, "vr-explorer"]
        );

        if (wsManager && winnerRow.room_id) {
          wsManager.vrParticipantJoined(winnerRow.room_id, winnerRow.id, participantResult.rows[0]);
        }

        log.info(`VR session create race lost by ${userName} — adopted ${winnerRow.id}`);
        return res.json({ ...winnerRow, adopted: true });
      }
      throw insertErr;
    }

    // Add owner as first participant
    await pool.query(
      `INSERT INTO vr_session_participants (
        id, session_id, account_user_id, participant_id, user_name, mode, joined_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [uuidv4(), sessionId, userId, participantId, userName, "vr-explorer"]
    );

    // Broadcast to the session's room (see websocket.js's vrSessionCreated
    // — room-scoped, not project-scoped).
    if (wsManager && session.room_id) {
      wsManager.vrSessionCreated(session.room_id, session);
    }

    log.info(`VR session created: ${sessionId} by ${userName}`);

    res.json(session);
  } catch (error) {
    log.error("Failed to create VR session:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
});

/**
 * GET /vr/sessions/:id
 * Get session details
 */
router.get("/sessions/:id", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionResult.rows[0];

    // Legacy rows created before room scoping (room_id null) have no room
    // to check membership against — degrade to the previous unguarded
    // behaviour rather than locking every pre-existing session out.
    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    // Get participants
    const participantsResult = await pool.query(
      `SELECT * FROM vr_session_participants WHERE session_id = $1`,
      [req.params.id]
    );

    // Get snapshots
    const snapshotsResult = await pool.query(
      `SELECT * FROM vr_session_snapshots WHERE session_id = $1 ORDER BY timestamp DESC`,
      [req.params.id]
    );

    res.json({
      ...session,
      participants: participantsResult.rows,
      snapshots: snapshotsResult.rows,
    });
  } catch (error) {
    log.error("Failed to get VR session:", error);
    res.status(500).json({ error: "Failed to get session" });
  }
});

/**
 * GET /vr/sessions
 * List active sessions in a project
 */
router.get("/sessions", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Room-scoped, not project-scoped: a project-wide list let a user in
    // room B see (and, via join, attach to the wrong Y.js doc for) a
    // session that belongs to room A of the same project. This also closes
    // the previous no-auth hole on this route.
    const { roomId } = req.query;
    const access = await resolveRoomAccess(pool, roomId, userId);
    if (!access.ok) {
      return res.status(access.status).json(access.body);
    }

    // Lazy expiry (Issue 6) — unlisting, unscoped by dataset: any stale
    // session in this room is functionally gone, whichever dataset it was
    // exploring.
    const reaped = await reapStaleVrSessions(pool, access.room.id);
    if (wsManager) {
      for (const row of reaped) wsManager.vrSessionEnded(row.room_id, row.id);
    }

    const result = await pool.query(
      `SELECT s.*,
        (SELECT COUNT(*) FROM vr_session_participants WHERE session_id = s.id) as participant_count
      FROM vr_exploration_sessions s
      WHERE s.room_id = $1 AND s.status <> 'ended'
      ORDER BY s.created_at DESC`,
      [access.room.id] // validated by resolveRoomAccess, not the raw query param
    );

    res.json(result.rows);
  } catch (error) {
    log.error("Failed to list VR sessions:", error);
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

/**
 * PUT /vr/sessions/:id
 * Update session settings
 */
router.put("/sessions/:id", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionResult.rows[0];

    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    if (session.owner_user_id !== userId) {
      return res.status(403).json({ error: "Not session owner" });
    }

    // Update allowed fields
    const allowedUpdates = [
      "status",
      "allow_join",
      "allow_desktop_participants",
      "allow_desktop_control",
      "default_exploration_mode",
      "default_vr_scale",
    ];

    const updates = [];
    const values = [];
    let paramCount = 1;

    for (const field of allowedUpdates) {
      const camelField = field.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      if (req.body[camelField] !== undefined) {
        updates.push(`${field} = $${paramCount}`);
        values.push(req.body[camelField]);
        paramCount++;
      }
    }

    if (updates.length === 0) {
      return res.json(session);
    }

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE vr_exploration_sessions SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    // Broadcast update
    if (wsManager && session.room_id) {
      wsManager.vrSessionUpdated(session.room_id, session.id, req.body);
    }

    res.json(result.rows[0]);
  } catch (error) {
    log.error("Failed to update VR session:", error);
    res.status(500).json({ error: "Failed to update session" });
  }
});

/**
 * DELETE /vr/sessions/:id
 * End/delete a session
 */
router.delete("/sessions/:id", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionResult.rows[0];

    // Issue 6: 'ended' is functionally gone, same posture as join/state/
    // lease elsewhere in this file. Without this, a session a concurrent
    // last-participant POST /leave already ended (see that route) would
    // silently re-stamp ended_at and return 200 here instead of telling the
    // caller the session is already gone.
    if (session.status === "ended") {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    if (session.owner_user_id !== userId) {
      return res.status(403).json({ error: "Not session owner" });
    }

    await pool.query(
      `UPDATE vr_exploration_sessions SET status = 'ended', ended_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Broadcast end
    if (wsManager && session.room_id) {
      wsManager.vrSessionEnded(session.room_id, session.id);
    }

    log.info(`VR session ended: ${session.id}`);

    res.json({ success: true });
  } catch (error) {
    log.error("Failed to end VR session:", error);
    res.status(500).json({ error: "Failed to end session" });
  }
});

// =============================================================================
// PARTICIPANT MANAGEMENT
// =============================================================================

/**
 * POST /vr/sessions/:id/join
 * Join a session.
 *
 * Response contract (Phase B/C of the room-scoping/join-correctness plan):
 *   200 { joined, session, participant: {participantId, mode, userName},
 *         dataset: {id, kind, name}, viewConfigurationId,
 *         state, lease }
 * `state` is buildSessionState()'s snapshot (Phase C) — embedded here so a
 * joiner needs no second round trip to GET /sessions/:id/state. `lease` is
 * buildLeaseDescriptor()'s snapshot (Phase D1/D2) — null when unheld or
 * expired, so a joiner never needs a second round trip to learn who (if
 * anyone) currently holds manipulation authority either.
 *
 * Errors: 401 auth-required, 403 not-a-room-member (via resolveRoomAccess),
 * 403 desktop-not-allowed, 404 session-not-found (including status='ended'),
 * 409 cross-room {roomId, roomName}, 409 join-disabled.
 *
 * `session` (the raw row) carries owner_participant_id — the AUTHORITATIVE
 * host identity for the joiner to compare itself against (accountUserId
 * alone, owner_user_id, cannot tell two devices on the same account apart).
 * See src/core/vr/vrSessionOwner.js on the client.
 */
router.post("/sessions/:id/join", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "auth-required" });
    }
    const userName = getUser(req)?.name || "Anonymous";

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }

    const session = sessionResult.rows[0];

    // A row can outlive the session it describes — DELETE /sessions/:id
    // transitions status to 'ended' rather than deleting the row (snapshots
    // and participant history stay queryable). From a joiner's perspective
    // that is exactly "doesn't exist any more".
    if (session.status === "ended") {
      return res.status(404).json({ error: "session-not-found" });
    }

    // Lazy expiry (Issue 6): a session whose heartbeat has gone stale is
    // functionally 'ended' to a joiner even though the row's status hasn't
    // caught up yet — reap it here so joining a zombie 404s honestly instead
    // of attaching to a session nobody will ever heartbeat again.
    if (session.room_id) {
      const reaped = await reapStaleVrSessions(pool, session.room_id, {
        datasetSyncKey: session.dataset_sync_key,
      });
      if (wsManager) {
        for (const row of reaped) wsManager.vrSessionEnded(row.room_id, row.id);
      }
      if (reaped.some((row) => row.id === session.id)) {
        return res.status(404).json({ error: "session-not-found" });
      }
    }

    const { mode, deviceId, roomId } = req.body;

    if (session.room_id) {
      // Membership check first (a genuine non-member gets 403), then a
      // separate check against what the client believes its current room
      // is: someone who *does* have access to the session's room (e.g. a
      // public room + project member) but is currently sitting in a
      // different room in the UI would otherwise attach to the wrong Y.js
      // doc — yjsSetup.js binds ydoc to sessionManager.getRoomId(), the
      // client's *current* room, not the session's room. The friendlier
      // cross-room 409 tells the client which room to switch to instead of
      // a blunt 403.
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
      if (roomId && roomId !== session.room_id) {
        return res.status(409).json({
          error: "cross-room",
          roomId: session.room_id,
          roomName: access.room.name,
        });
      }
    }

    if (!session.allow_join) {
      return res.status(409).json({ error: "join-disabled" });
    }

    const participantId = buildParticipantId(userId, deviceId);

    if (
      mode === "desktop-participant" &&
      !session.allow_desktop_participants
    ) {
      return res.status(403).json({ error: "desktop-not-allowed" });
    }

    // Upsert participant
    const result = await pool.query(
      `INSERT INTO vr_session_participants (
        id, session_id, account_user_id, participant_id, user_name, mode, joined_at, last_active_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (session_id, participant_id) DO UPDATE SET
        mode = $6, last_active_at = NOW()
      RETURNING *`,
      [uuidv4(), req.params.id, userId, participantId, userName, mode || "desktop-observer"]
    );

    const participant = result.rows[0];

    // Broadcast join
    if (wsManager && session.room_id) {
      wsManager.vrParticipantJoined(session.room_id, session.id, participant);
    }

    log.info(
      `User ${userName} joined VR session ${session.id} as ${participant.mode}`
    );

    const dataset = await buildDatasetDescriptor(pool, session);

    res.json({
      joined: true,
      session,
      participant: {
        participantId: participant.participant_id,
        mode: participant.mode,
        userName: participant.user_name,
      },
      dataset,
      viewConfigurationId: session.view_configuration_id,
      state: await buildSessionState(pool, session),
      lease: buildLeaseDescriptor(session), // Phase D1/D2: lease acquisition
    });
  } catch (error) {
    log.error("Failed to join VR session:", error);
    res.status(500).json({ error: "Failed to join session" });
  }
});

/**
 * GET /vr/sessions/:id/state
 * Resync endpoint: returns the same authoritative snapshot embedded in the
 * join response (buildSessionState()), for a client that needs to
 * re-hydrate without a full re-join (e.g. after a Y.js reconnect). Same room
 * guard as the other session-scoped routes.
 */
router.get("/sessions/:id/state", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "auth-required" });
    }

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }

    const session = sessionResult.rows[0];

    // Same "ended is gone" posture as GET /sessions/:id/join.
    if (session.status === "ended") {
      return res.status(404).json({ error: "session-not-found" });
    }

    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    res.json(await buildSessionState(pool, session));
  } catch (error) {
    log.error("Failed to get VR session state:", error);
    res.status(500).json({ error: "Failed to get session state" });
  }
});

/**
 * POST /vr/sessions/:id/heartbeat
 * Session-liveness heartbeat (Issue 6) — distinct from the manipulation
 * lease's own POST .../lease/heartbeat (022_vr_manipulation_lease.sql).
 * Feeds last_heartbeat_at, which reapStaleVrSessions() uses for lazy expiry,
 * and performs the session's ONE 'preparing' -> 'active' transition: only
 * when the caller IS the owner DEVICE (owner_participant_id — composing
 * directly with Issue 5's device-grained host identity), because a joiner's
 * heartbeat proves the joiner is alive, not that the host's VR entry has
 * actually happened.
 *
 * PUT /sessions/:id (above) cannot serve as this heartbeat — it's gated on
 * `session.owner_user_id !== userId` (account-level, and only the owner's
 * ACCOUNT at that), so it 403s every non-owner participant, which is most
 * callers most of the time.
 *
 * Body: { deviceId }
 * 200 { status, lastHeartbeatAt }
 * 404 session-not-found (including status='ended')
 */
router.post("/sessions/:id/heartbeat", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "auth-required" });
    }
    const { deviceId } = req.body;
    const participantId = buildParticipantId(userId, deviceId);

    const sessionResult = await pool.query(
      `SELECT room_id, status FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }
    const session = sessionResult.rows[0];
    if (session.status === "ended") {
      return res.status(404).json({ error: "session-not-found" });
    }
    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    const result = await pool.query(
      `UPDATE vr_exploration_sessions
          SET last_heartbeat_at = NOW(),
              status = CASE WHEN status = 'preparing' AND owner_participant_id = $2
                             THEN 'active' ELSE status END
        WHERE id = $1 AND status <> 'ended'
        RETURNING status, last_heartbeat_at, room_id`,
      [req.params.id, participantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }

    const updated = result.rows[0];

    if (wsManager && updated.room_id && updated.status !== session.status) {
      wsManager.vrSessionUpdated(updated.room_id, req.params.id, { status: updated.status });
    }

    res.json({ status: updated.status, lastHeartbeatAt: updated.last_heartbeat_at });
  } catch (error) {
    log.error("Failed to heartbeat VR session:", error);
    res.status(500).json({ error: "Failed to heartbeat session" });
  }
});

// =============================================================================
// MANIPULATION LEASE (Phase D1/D2)
// =============================================================================
// A manipulation lease is strictly 1:1 with a session and lives as five
// columns on vr_exploration_sessions (022_vr_manipulation_lease.sql), not a
// separate table — see that migration's header for why. All four routes
// below share the same room guard as the other session-scoped routes and
// broadcast wsManager.vrLeaseChanged(roomId, payload) on success. These
// routes are storage + authority-fencing only; the client-side lock
// (src/core/vr/VRManipulationLock.js) that calls them is a separate change.

/**
 * POST /vr/sessions/:id/lease
 * Acquire (or refresh, as the current holder) the manipulation lease.
 *
 * Body: { deviceId, ttlMs? }
 * 200 { holder: {participantId, userName}, expiresAt, epoch, revision }
 * 409 { error: 'lease-held', holder: {participantId, userName}, expiresAt }
 *
 * The UPDATE's WHERE clause is the entire compare-and-swap: it succeeds when
 * the lease is unheld, already held by the same participant (refresh), or
 * expired (lazy stale reclaim — no sweeper job). Two concurrent acquires
 * against the same unheld lease race at the database, not in application
 * code: Postgres serializes the two UPDATEs, the first to commit satisfies
 * the WHERE clause and gets rowCount 1, and the second re-evaluates the
 * WHERE clause against the now-committed row, no longer matches, and gets
 * rowCount 0 — so exactly one caller ever sees 200.
 */
router.post("/sessions/:id/lease", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "auth-required" });
    }
    const fallbackUserName = getUser(req)?.name || "Anonymous";
    const { deviceId, ttlMs } = req.body;
    const participantId = buildParticipantId(userId, deviceId);

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }
    const session = sessionResult.rows[0];
    if (session.status === "ended") {
      return res.status(404).json({ error: "session-not-found" });
    }

    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    // allow_desktop_control gate. This flag has been stored but read by
    // nothing since it was added — a real behaviour change: every existing
    // session defaults it to FALSE, so a desktop-mode participant who could
    // previously acquire the (client-only, fail-open) lock now gets a real
    // 403 here unless the session owner explicitly turns the flag on.
    const participantResult = await pool.query(
      `SELECT mode, user_name FROM vr_session_participants WHERE session_id = $1 AND participant_id = $2`,
      [req.params.id, participantId]
    );
    const participantMode = participantResult.rows[0]?.mode || null;
    if (
      participantMode &&
      participantMode.startsWith("desktop-") &&
      !session.allow_desktop_control
    ) {
      return res.status(403).json({ error: "desktop-control-disabled" });
    }

    const holderUserName = participantResult.rows[0]?.user_name || fallbackUserName;
    const ttl = resolveLeaseTtlMs(ttlMs);

    const acquireResult = await pool.query(
      `UPDATE vr_exploration_sessions
          SET lease_participant_id = $2, lease_user_name = $3,
              lease_expires_at = NOW() + ($4 || ' milliseconds')::interval,
              lease_epoch = lease_epoch + 1, revision = revision + 1
        WHERE id = $1 AND status <> 'ended'
          AND (lease_participant_id IS NULL OR lease_participant_id = $2 OR lease_expires_at < NOW())
        RETURNING *`,
      [req.params.id, participantId, holderUserName, ttl]
    );

    if (acquireResult.rowCount === 0) {
      const current = await pool.query(
        `SELECT lease_participant_id, lease_user_name, lease_expires_at
         FROM vr_exploration_sessions WHERE id = $1`,
        [req.params.id]
      );
      const cur = current.rows[0] || {};
      return res.status(409).json({
        error: "lease-held",
        holder: {
          participantId: cur.lease_participant_id || null,
          userName: cur.lease_user_name || null,
        },
        expiresAt: cur.lease_expires_at || null,
      });
    }

    const updated = acquireResult.rows[0];

    if (wsManager && updated.room_id) {
      wsManager.vrLeaseChanged(updated.room_id, {
        sessionId: updated.id,
        lease: buildLeaseDescriptor(updated),
      });
    }

    log.info(`VR lease acquired: session ${updated.id} by ${participantId} (epoch ${updated.lease_epoch})`);

    res.json({
      holder: { participantId: updated.lease_participant_id, userName: updated.lease_user_name },
      expiresAt: updated.lease_expires_at,
      epoch: Number(updated.lease_epoch),
      revision: Number(updated.revision),
    });
  } catch (error) {
    log.error("Failed to acquire VR manipulation lease:", error);
    res.status(500).json({ error: "Failed to acquire lease" });
  }
});

/**
 * POST /vr/sessions/:id/lease/heartbeat
 * Extend the current holder's lease. lease_epoch is the fencing token: the
 * WHERE clause requires both the caller's participant id AND the epoch they
 * last observed to match the row, so a participant who has been preempted
 * (a newer acquire or an explicit grant elsewhere bumped the epoch) cannot
 * extend a lease that is no longer theirs, even if this request was already
 * in flight when the preemption happened.
 *
 * Body: { deviceId, epoch, ttlMs? }
 * 200 { expiresAt, epoch, revision }
 * 409 { error: 'lease-lost' }
 */
router.post("/sessions/:id/lease/heartbeat", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "auth-required" });
    }
    const { deviceId, epoch, ttlMs } = req.body;
    const epochNum = Number(epoch);
    if (!Number.isFinite(epochNum)) {
      return res.status(400).json({ error: "invalid-epoch" });
    }
    const participantId = buildParticipantId(userId, deviceId);

    const sessionResult = await pool.query(
      `SELECT room_id, status FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }
    const session = sessionResult.rows[0];
    if (session.status === "ended") {
      return res.status(404).json({ error: "session-not-found" });
    }
    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    const ttl = resolveLeaseTtlMs(ttlMs);

    const result = await pool.query(
      `UPDATE vr_exploration_sessions
          SET lease_expires_at = NOW() + ($4 || ' milliseconds')::interval
        WHERE id = $1 AND status <> 'ended'
          AND lease_participant_id = $2 AND lease_epoch = $3
        RETURNING *`,
      [req.params.id, participantId, epochNum, ttl]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: "lease-lost" });
    }

    const updated = result.rows[0];

    if (wsManager && updated.room_id) {
      wsManager.vrLeaseChanged(updated.room_id, {
        sessionId: updated.id,
        lease: buildLeaseDescriptor(updated),
      });
    }

    res.json({
      expiresAt: updated.lease_expires_at,
      epoch: Number(updated.lease_epoch),
      revision: Number(updated.revision),
    });
  } catch (error) {
    log.error("Failed to heartbeat VR manipulation lease:", error);
    res.status(500).json({ error: "Failed to heartbeat lease" });
  }
});

/**
 * DELETE /vr/sessions/:id/lease
 * Release the lease. Authority: the current holder, or the session's
 * owner_participant_id — the account+device grain 021 added specifically so
 * this check isn't fooled by the same account being signed in on two
 * devices (see 021_vr_session_room_scope.sql's comment).
 *
 * Body: { deviceId }
 * 204 (idempotent — releasing an already-unheld lease still succeeds)
 * 403 { error: 'lease-release-forbidden' }
 */
router.delete("/sessions/:id/lease", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "auth-required" });
    }
    const { deviceId } = req.body;
    const participantId = buildParticipantId(userId, deviceId);

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }
    const session = sessionResult.rows[0];
    if (session.status === "ended") {
      return res.status(404).json({ error: "session-not-found" });
    }
    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    const isHolder = session.lease_participant_id === participantId;
    const isOwner = session.owner_participant_id === participantId;
    if (!isHolder && !isOwner) {
      return res.status(403).json({ error: "lease-release-forbidden" });
    }

    const result = await pool.query(
      `UPDATE vr_exploration_sessions
          SET lease_participant_id = NULL, lease_user_name = NULL,
              lease_expires_at = NULL, revision = revision + 1
        WHERE id = $1
        RETURNING *`,
      [req.params.id]
    );

    const updated = result.rows[0];

    if (wsManager && updated.room_id) {
      wsManager.vrLeaseChanged(updated.room_id, {
        sessionId: updated.id,
        lease: null,
      });
    }

    res.status(204).end();
  } catch (error) {
    log.error("Failed to release VR manipulation lease:", error);
    res.status(500).json({ error: "Failed to release lease" });
  }
});

/**
 * POST /vr/sessions/:id/lease/grant
 * Force-transfer the lease to another participant. Authority: the current
 * holder, or the session's owner_participant_id (same grain as DELETE
 * above) — this is the "host can always take back or hand off control"
 * path.
 *
 * Body: { toParticipantId, deviceId, ttlMs? }
 * 200 { holder: {participantId, userName}, expiresAt, epoch, revision }
 * 403 { error: 'lease-grant-forbidden' }
 * 404 { error: 'participant-not-found' } — toParticipantId never joined
 */
router.post("/sessions/:id/lease/grant", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "auth-required" });
    }
    const { deviceId, toParticipantId, ttlMs } = req.body;
    if (!toParticipantId) {
      return res.status(400).json({ error: "missing-target" });
    }
    const participantId = buildParticipantId(userId, deviceId);

    const sessionResult = await pool.query(
      `SELECT * FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }
    const session = sessionResult.rows[0];
    if (session.status === "ended") {
      return res.status(404).json({ error: "session-not-found" });
    }
    if (session.room_id) {
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    const isHolder = session.lease_participant_id === participantId;
    const isOwner = session.owner_participant_id === participantId;
    if (!isHolder && !isOwner) {
      return res.status(403).json({ error: "lease-grant-forbidden" });
    }

    const targetResult = await pool.query(
      `SELECT user_name FROM vr_session_participants WHERE session_id = $1 AND participant_id = $2`,
      [req.params.id, toParticipantId]
    );
    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: "participant-not-found" });
    }
    const targetUserName = targetResult.rows[0].user_name;
    const ttl = resolveLeaseTtlMs(ttlMs);

    const result = await pool.query(
      `UPDATE vr_exploration_sessions
          SET lease_participant_id = $2, lease_user_name = $3,
              lease_expires_at = NOW() + ($4 || ' milliseconds')::interval,
              lease_epoch = lease_epoch + 1, revision = revision + 1
        WHERE id = $1 AND status <> 'ended'
        RETURNING *`,
      [req.params.id, toParticipantId, targetUserName, ttl]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "session-not-found" });
    }

    const updated = result.rows[0];

    if (wsManager && updated.room_id) {
      wsManager.vrLeaseChanged(updated.room_id, {
        sessionId: updated.id,
        lease: buildLeaseDescriptor(updated),
      });
    }

    log.info(`VR lease granted: session ${updated.id} to ${toParticipantId} by ${participantId} (epoch ${updated.lease_epoch})`);

    res.json({
      holder: { participantId: updated.lease_participant_id, userName: updated.lease_user_name },
      expiresAt: updated.lease_expires_at,
      epoch: Number(updated.lease_epoch),
      revision: Number(updated.revision),
    });
  } catch (error) {
    log.error("Failed to grant VR manipulation lease:", error);
    res.status(500).json({ error: "Failed to grant lease" });
  }
});

/**
 * POST /vr/sessions/:id/leave
 * Leave a session. Transactional (Issue 6) — the first transaction this
 * file uses (see server/src/routes/annotations.js's BEGIN/COMMIT/ROLLBACK
 * pattern, mirrored here): the participant delete and the "was that the
 * last participant" count must be atomic, or two participants leaving
 * "simultaneously" could each observe a non-zero remaining count and neither
 * would end the row — a session with a genuinely empty roster would then
 * stay 'preparing'/'active' until lazy-expiry reaping caught it, minutes
 * later, instead of ending promptly. `SELECT ... FOR UPDATE` on the session
 * row serializes concurrent leaves against the same session.
 *
 * Response gains `sessionEnded: boolean`. Ending the session here also
 * clears its lease columns (same as reapStaleVrSessions), or a
 * last-participant leave would strand a dangling manipulation lease nobody
 * can ever release.
 */
router.post("/sessions/:id/leave", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  let client;
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { deviceId } = req.body;
    const participantId = buildParticipantId(userId, deviceId);

    client = await pool.connect();
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT id, room_id, status FROM vr_exploration_sessions WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );

    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      // No row for this id at all — nothing to leave, and nothing to check
      // room access against. Preserve the previous lenient behaviour rather
      // than 404ing on an id that was never registered server-side (e.g. a
      // local vrsession_* id that never reached _tryRegisterSession).
      return res.json({ success: true, sessionEnded: false });
    }

    const session = sessionResult.rows[0];

    if (session.room_id) {
      // resolveRoomAccess reads via `pool`, a separate connection from
      // `client` — a plain read, so no conflict with the open transaction.
      const access = await resolveRoomAccess(pool, session.room_id, userId);
      if (!access.ok) {
        await client.query("ROLLBACK");
        return res.status(access.status).json(access.body);
      }
    }

    await client.query(
      `DELETE FROM vr_session_participants WHERE session_id = $1 AND participant_id = $2`,
      [req.params.id, participantId]
    );

    let sessionEnded = false;
    if (session.status !== "ended") {
      const remaining = await client.query(
        `SELECT COUNT(*)::int AS count FROM vr_session_participants WHERE session_id = $1`,
        [req.params.id]
      );
      if (remaining.rows[0].count === 0) {
        await client.query(
          `UPDATE vr_exploration_sessions
              SET status = 'ended', ended_at = NOW(),
                  lease_participant_id = NULL, lease_user_name = NULL, lease_expires_at = NULL
            WHERE id = $1`,
          [req.params.id]
        );
        sessionEnded = true;
      }
    }

    await client.query("COMMIT");

    if (wsManager && session.room_id) {
      wsManager.vrParticipantLeft(session.room_id, req.params.id, participantId);
      if (sessionEnded) {
        wsManager.vrSessionEnded(session.room_id, req.params.id);
      }
    }

    res.json({ success: true, sessionEnded });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }
    log.error("Failed to leave VR session:", error);
    res.status(500).json({ error: "Failed to leave session" });
  } finally {
    client?.release();
  }
});

/**
 * PUT /vr/sessions/:id/participants/:participantId
 * Update participant state
 */
router.put("/sessions/:id/participants/:participantId", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const accountUserId = getUserId(req);
    if (!accountUserId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const { participantId } = req.params;
    if (
      participantId !== accountUserId &&
      !participantId.startsWith(`${accountUserId}#`)
    ) {
      return res.status(403).json({ error: "Cannot modify another participant" });
    }

    const sessionResult = await pool.query(
      `SELECT room_id FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length > 0 && sessionResult.rows[0].room_id) {
      const access = await resolveRoomAccess(pool, sessionResult.rows[0].room_id, accountUserId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    const allowedUpdates = ["mode", "vr_scale", "scale_visibility"];
    const updates = [];
    const values = [];
    let paramCount = 1;

    for (const field of allowedUpdates) {
      const camelField = field.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      if (req.body[camelField] !== undefined) {
        updates.push(`${field} = $${paramCount}`);
        values.push(req.body[camelField]);
        paramCount++;
      }
    }

    updates.push(`last_active_at = NOW()`);

    values.push(req.params.id, participantId);
    const result = await pool.query(
      `UPDATE vr_session_participants SET ${updates.join(", ")}
      WHERE session_id = $${paramCount} AND participant_id = $${paramCount + 1}
      RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Participant not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    log.error("Failed to update participant:", error);
    res.status(500).json({ error: "Failed to update participant" });
  }
});

// =============================================================================
// SNAPSHOTS
// =============================================================================

/**
 * POST /vr/sessions/:id/snapshots
 * Create a session snapshot
 */
router.post("/sessions/:id/snapshots", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Get session first — needed for the room guard below and for
    // project_id used in the broadcast further down.
    const sessionResult = await pool.query(
      `SELECT project_id, room_id FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length > 0 && sessionResult.rows[0].room_id) {
      const access = await resolveRoomAccess(pool, sessionResult.rows[0].room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    const userName = getUser(req)?.name || "Anonymous";

    const { name, viewSnapshotId, participantStates } = req.body;

    const result = await pool.query(
      `INSERT INTO vr_session_snapshots (
        id, session_id, name, view_snapshot_id,
        created_by, created_by_name, participant_states, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *`,
      [
        uuidv4(),
        req.params.id,
        name || `Snapshot ${new Date().toLocaleTimeString()}`,
        // view_snapshot_id is UUID too and hits the same "invalid input
        // syntax" failure if a non-UUID slips through from the client.
        asUuidOrNull(viewSnapshotId),
        userId,
        userName,
        participantStates ? JSON.stringify(participantStates) : null,
      ]
    );

    const snapshot = result.rows[0];

    // Broadcast snapshot created
    if (sessionResult.rows.length > 0 && wsManager) {
      wsManager.vrSnapshotCreated(
        sessionResult.rows[0].room_id,
        req.params.id,
        snapshot
      );
    }

    res.json(snapshot);
  } catch (error) {
    log.error("Failed to create snapshot:", error);
    res.status(500).json({ error: "Failed to create snapshot" });
  }
});

/**
 * GET /vr/sessions/:id/snapshots
 * List session snapshots
 */
router.get("/sessions/:id/snapshots", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const sessionResult = await pool.query(
      `SELECT room_id FROM vr_exploration_sessions WHERE id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length > 0 && sessionResult.rows[0].room_id) {
      const access = await resolveRoomAccess(pool, sessionResult.rows[0].room_id, userId);
      if (!access.ok) {
        return res.status(access.status).json(access.body);
      }
    }

    const result = await pool.query(
      `SELECT * FROM vr_session_snapshots WHERE session_id = $1 ORDER BY timestamp DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    log.error("Failed to list snapshots:", error);
    res.status(500).json({ error: "Failed to list snapshots" });
  }
});

// =============================================================================
// PREPROCESSING
// =============================================================================

/**
 * GET /vr/preprocessing/:datasetId/status
 * Get preprocessing status for a dataset
 */
router.get("/preprocessing/:datasetId/status", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const status = await vrPreprocessing.getPreprocessingStatus(
      pool,
      req.params.datasetId
    );

    res.json(status);
  } catch (error) {
    log.error("Failed to get preprocessing status:", error);
    res.status(500).json({ error: "Failed to get preprocessing status" });
  }
});

/**
 * GET /vr/preprocessing/:datasetId/ready
 * Check if dataset is ready for VR exploration
 */
router.get("/preprocessing/:datasetId/ready", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Built-in demo datasets (e.g. "builtin-lungs") are client-side-only and
    // have no row in `datasets` — dataset_id is a uuid column, so querying it
    // with a non-UUID id raises Postgres 22P02, which the catch below would
    // otherwise turn into an opaque 500. A bundled demo dataset must never
    // block VR entry, so short-circuit without touching the database.
    if (!asUuidOrNull(req.params.datasetId)) {
      return res.json({
        ready: true,
        required: false,
        status: "not_applicable",
      });
    }

    const readiness = await vrPreprocessing.isReadyForVR(
      pool,
      req.params.datasetId
    );

    res.json(readiness);
  } catch (error) {
    log.error("Failed to check VR readiness:", error);
    res.status(500).json({ error: "Failed to check VR readiness" });
  }
});

/**
 * POST /vr/preprocessing/:datasetId/start
 * Start preprocessing for a dataset
 */
router.post("/preprocessing/:datasetId/start", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const { projectId, force } = req.body;

    const result = await vrPreprocessing.startPreprocessing(
      pool,
      req.params.datasetId,
      {
        userId,
        projectId,
        force: force === true,
      }
    );

    // Broadcast preprocessing started
    if (wsManager && projectId && result.status === "queued") {
      wsManager.broadcastToProject(projectId, {
        type: "vr:preprocessing-started",
        projectId,
        datasetId: req.params.datasetId,
        preprocessingId: result.id,
        operations: result.operations,
        estimatedTime: result.estimatedTime,
        timestamp: new Date().toISOString(),
      });
    }

    log.info(
      `VR preprocessing started for dataset ${req.params.datasetId}: ${result.status}`
    );

    res.json(result);
  } catch (error) {
    log.error("Failed to start preprocessing:", error);
    res.status(500).json({ error: error.message || "Failed to start preprocessing" });
  }
});

/**
 * POST /vr/preprocessing/internal/progress
 * Update preprocessing progress (called by workers)
 */
router.post("/preprocessing/internal/progress", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const { preprocessingId, progress, operation, status } = req.body;

    await vrPreprocessing.updateProgress(pool, preprocessingId, {
      progress,
      operation,
      status,
    });

    // Get preprocessing record for project ID
    const result = await pool.query(
      `SELECT project_id, dataset_id FROM vr_preprocessing WHERE id = $1`,
      [preprocessingId]
    );

    // Broadcast progress update
    if (result.rows.length > 0 && wsManager) {
      const { project_id, dataset_id } = result.rows[0];
      if (project_id) {
        wsManager.broadcastToProject(project_id, {
          type: "vr:preprocessing-progress",
          projectId: project_id,
          datasetId: dataset_id,
          preprocessingId,
          progress,
          operation,
          status,
          timestamp: new Date().toISOString(),
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    log.error("Failed to update preprocessing progress:", error);
    res.status(500).json({ error: "Failed to update progress" });
  }
});

/**
 * POST /vr/preprocessing/internal/complete
 * Mark preprocessing as complete (called by workers)
 */
router.post("/preprocessing/internal/complete", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const { preprocessingId, results } = req.body;

    await vrPreprocessing.completePreprocessing(pool, preprocessingId, results);

    // Get preprocessing record for broadcasting
    const result = await pool.query(
      `SELECT project_id, dataset_id FROM vr_preprocessing WHERE id = $1`,
      [preprocessingId]
    );

    // Broadcast completion
    if (result.rows.length > 0 && wsManager) {
      const { project_id, dataset_id } = result.rows[0];
      if (project_id) {
        wsManager.broadcastToProject(project_id, {
          type: "vr:preprocessing-complete",
          projectId: project_id,
          datasetId: dataset_id,
          preprocessingId,
          results,
          timestamp: new Date().toISOString(),
        });
      }
    }

    log.info(`VR preprocessing complete: ${preprocessingId}`);

    res.json({ success: true });
  } catch (error) {
    log.error("Failed to complete preprocessing:", error);
    res.status(500).json({ error: "Failed to complete preprocessing" });
  }
});

/**
 * POST /vr/preprocessing/internal/failed
 * Mark preprocessing as failed (called by workers)
 */
router.post("/preprocessing/internal/failed", async (req, res) => {
  const pool = req.app.locals.pool;
  const wsManager = req.app.locals.wsManager;

  try {
    const { preprocessingId, error: errorMessage } = req.body;

    await vrPreprocessing.updateProgress(pool, preprocessingId, {
      status: "failed",
      error: errorMessage,
    });

    // Get preprocessing record for broadcasting
    const result = await pool.query(
      `SELECT project_id, dataset_id FROM vr_preprocessing WHERE id = $1`,
      [preprocessingId]
    );

    // Broadcast failure
    if (result.rows.length > 0 && wsManager) {
      const { project_id, dataset_id } = result.rows[0];
      if (project_id) {
        wsManager.broadcastToProject(project_id, {
          type: "vr:preprocessing-failed",
          projectId: project_id,
          datasetId: dataset_id,
          preprocessingId,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        });
      }
    }

    log.error(`VR preprocessing failed: ${preprocessingId} - ${errorMessage}`);

    res.json({ success: true });
  } catch (error) {
    log.error("Failed to mark preprocessing as failed:", error);
    res.status(500).json({ error: "Failed to update status" });
  }
});

module.exports = router;
module.exports.asUuidOrNull = asUuidOrNull;
module.exports.resolveRoomAccess = resolveRoomAccess;
module.exports.buildParticipantId = buildParticipantId;
module.exports.buildDatasetDescriptor = buildDatasetDescriptor;
module.exports.buildSessionState = buildSessionState;
module.exports.buildLeaseDescriptor = buildLeaseDescriptor;
module.exports.LEASE_TTL_DEFAULT_MS = LEASE_TTL_DEFAULT_MS;
module.exports.reapStaleVrSessions = reapStaleVrSessions;
module.exports.REAP_PREPARING_STALE_MS = REAP_PREPARING_STALE_MS;
module.exports.REAP_ACTIVE_STALE_MS = REAP_ACTIVE_STALE_MS;
