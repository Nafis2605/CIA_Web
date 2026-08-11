// server/src/routes/annotations.js
// Annotation management routes for v2.0 server-authority architecture
// Supports versioning, branching, and visibility controls

const express = require("express");
const router = express.Router();
const { getUser, checkProjectAccess } = require("../middleware/auth");
const { writeSyncEvent, buildSnapshot } = require("../services/syncEventService");
const { diffObjects } = require("../utils/jsonDiff");
const { isValidUUID } = require("../middleware/validateUUID");
const { createLogger } = require("../utils/logger");

const log = createLogger("annotations");

// ============================================================================
// ANNOTATION ENDPOINTS
// ============================================================================

/**
 * GET /api/annotations
 * List annotations with filters
 */
router.get("/", async (req, res, next) => {
  try {
    const user = getUser(req);
    const { pool } = req.app.locals;
    const {
      fileId,
      projectId,
      branchId,
      type,
      visibility,
      status = "active",
      limit = 100,
      offset = 0,
    } = req.query;

    // Every real caller scopes by dataset or project — an unscoped list would
    // have no way to authorize which datasets'/projects' annotations the
    // caller may see at all.
    if (!fileId && !projectId) {
      return res.status(400).json({ error: "fileId or projectId is required" });
    }

    // Filter by file (built-in datasets use non-UUID ids like "builtin-lungs"
    // and never have server-side annotations, so short-circuit to empty)
    if (fileId && !isValidUUID(fileId)) {
      return res.json({ annotations: [], count: 0, limit: parseInt(limit), offset: parseInt(offset) });
    }

    let query = `
      SELECT a.*,
             u.email as creator_email,
             d.filename as file_name
      FROM annotations a
      LEFT JOIN users u ON a.created_by = u.id
      LEFT JOIN datasets d ON a.dataset_id = d.id
      WHERE a.status = $1
    `;
    const values = [status];
    let paramIndex = 2;

    if (fileId) {
      const auth = await authorizeDatasetAccess(pool, fileId, user?.id);
      if (!auth) {
        return res.status(404).json({ error: "File not found" });
      }
      if (!auth.authorized) {
        return res.status(403).json({ error: "Not authorized to view annotations for this file" });
      }
      query += ` AND a.dataset_id = $${paramIndex++}`;
      values.push(fileId);
    } else {
      // Scoped by projectId alone: verify project access, then restrict to
      // that project's own datasets (annotations has no project_id column).
      if (!(await checkProjectAccess(pool, projectId, user?.id))) {
        return res.status(403).json({ error: "Not authorized to view annotations for this project" });
      }
      query += ` AND a.dataset_id IN (SELECT file_id FROM file_project_access WHERE project_id = $${paramIndex++})`;
      values.push(projectId);
    }

    // Filter by branch
    if (branchId) {
      query += ` AND a.branch_id = $${paramIndex++}`;
      values.push(branchId);
    }

    // Filter by type
    if (type) {
      query += ` AND a.type = $${paramIndex++}`;
      values.push(type);
    }

    // Default: show public + user's private annotations. An explicit
    // `visibility` filter narrows this further — it must never REPLACE the
    // base restriction, or `?visibility=private` would return every user's
    // private annotations, not just the caller's own.
    query += ` AND (a.visibility = 'public' OR a.created_by = $${paramIndex++})`;
    values.push(user?.id);
    if (visibility) {
      query += ` AND a.visibility = $${paramIndex++}`;
      values.push(visibility);
    }

    query += ` ORDER BY a.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    values.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, values);

    res.json({
      annotations: result.rows,
      count: result.rows.length,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/annotations/:id
 * Get single annotation details
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = getUser(req);
    const { pool } = req.app.locals;

    const result = await pool.query(
      `
      SELECT a.*,
             u.email as creator_email,
             d.filename as file_name
      FROM annotations a
      LEFT JOIN users u ON a.created_by = u.id
      LEFT JOIN datasets d ON a.dataset_id = d.id
      WHERE a.id = $1
    `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Annotation not found" });
    }

    const annotation = result.rows[0];

    // 404, not 403 — don't confirm existence of an inaccessible annotation.
    const auth = await authorizeDatasetAccess(pool, annotation.dataset_id, user?.id);
    if (!auth?.authorized) {
      return res.status(404).json({ error: "Annotation not found" });
    }
    if (annotation.visibility !== "public" && annotation.created_by !== user?.id) {
      return res.status(404).json({ error: "Annotation not found" });
    }

    res.json({ annotation });
  } catch (error) {
    next(error);
  }
});

// Clients may omit projectId when creating an annotation (the VR path and the
// desktop useAnnotations hook both do) — without resolving broadcast targets
// from file_project_access the way DELETE already does, those annotations are
// created but never broadcast, and only show up for other users on refetch.
//
// Deliberately does NOT seed the result with a caller-supplied projectId
// (H15): that value is never validated, so trusting it here would let an
// otherwise-legitimate creator smuggle in an unrelated project and leak the
// new annotation to that project's members. Broadcast targets come from
// file_project_access alone, same as DELETE already does.
async function resolveBroadcastProjects(pool, fileId) {
  const projectIds = new Set();
  try {
    const result = await pool.query(
      "SELECT project_id FROM file_project_access WHERE file_id = $1",
      [fileId]
    );
    for (const row of result.rows) {
      if (row.project_id) {
        projectIds.add(row.project_id);
      }
    }
  } catch (err) {
    // Non-fatal: the annotation is already committed. Worst case it just
    // doesn't broadcast until the next refetch.
    log.warn("resolveBroadcastProjects: file_project_access lookup failed", err);
  }
  return projectIds;
}

/**
 * Whether `userId` may read/create/modify annotations on `fileId`. Never
 * trusts a client-supplied projectId (which can be omitted or spoofed — see
 * H15). Authorization is derived from the file's OWN project associations
 * (file_project_access, the same source resolveBroadcastProjects reads) —
 * membership (or public-project access, via checkProjectAccess) in ANY of
 * them grants access. A file with no project association at all falls back
 * to ownership/public-dataset access, matching the same rule files.js's own
 * listing query already uses (uploaded_by = user OR public_path).
 * Returns null if the file doesn't exist/isn't active, so callers can tell
 * "not found" apart from "not authorized".
 */
async function authorizeDatasetAccess(pool, fileId, userId) {
  const fileResult = await pool.query(
    "SELECT id, organization_id, uploaded_by, public_path FROM datasets WHERE id = $1 AND status = 'active'",
    [fileId]
  );
  const file = fileResult.rows[0];
  if (!file) return null;

  const projectRows = await pool.query(
    "SELECT project_id FROM file_project_access WHERE file_id = $1",
    [fileId]
  );

  let authorized = false;
  if (projectRows.rows.length === 0) {
    authorized = file.public_path != null || file.uploaded_by === userId;
  } else {
    for (const { project_id } of projectRows.rows) {
      if (await checkProjectAccess(pool, project_id, userId)) {
        authorized = true;
        break;
      }
    }
  }
  return { file, authorized };
}

/**
 * POST /api/annotations
 * Create a new annotation
 */
router.post("/", async (req, res, next) => {
  const { pool, wsManager } = req.app.locals;

  try {
    const user = getUser(req);
    const {
      fileId,
      projectId,
      branchId,
      type,
      coordinates,
      position,
      normal,
      text,
      properties,
      metadata,
      visibility = "public",
    } = req.body;

    if (!fileId || !type || !coordinates) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["fileId", "type", "coordinates"],
      });
    }

    // Verify the file exists AND that the caller may annotate it — derived
    // server-side from the file's real project ownership, never from the
    // (omittable, spoofable) request body projectId (see H15).
    const auth = await authorizeDatasetAccess(pool, fileId, user?.id);
    if (!auth) {
      return res.status(404).json({ error: "File not found" });
    }
    if (!auth.authorized) {
      return res.status(403).json({ error: "Not authorized to annotate this file" });
    }

    const orgId = auth.file.organization_id;

    // Get current file version if not specified
    let fileVersionId = req.body.fileVersionId;
    if (!fileVersionId) {
      const versionResult = await pool.query(
        "SELECT current_version_id FROM datasets WHERE id = $1",
        [fileId]
      );
      fileVersionId = versionResult.rows[0]?.current_version_id;
    }

    // Insert annotation
    // Note: Database schema uses 'position' for coordinates and 'content' for properties
    // Position is DOUBLE PRECISION[3] (PostgreSQL array), pass array directly - no JSON.stringify
    const positionValue = coordinates || position || null;

    let annotation;
    let syncEvent = null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `
        INSERT INTO annotations (
          dataset_id, file_version_id, branch_id, type,
          position, normal, text,
          content, metadata, visibility,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `,
        [
          fileId,
          fileVersionId,
          branchId || null,
          type,
          positionValue,
          normal || null,
          text || null,
          properties ? JSON.stringify(properties) : null,
          metadata ? JSON.stringify(metadata) : "{}",
          visibility,
          user.id,
        ]
      );

      annotation = result.rows[0];

      // Resolve workspace_id via dataset → project → workspace
      let workspaceId = null;
      try {
        const ws = await client.query(
          `SELECT w.id FROM workspaces w
           JOIN file_project_access fpa ON fpa.project_id = w.project_id
           WHERE fpa.file_id = $1 LIMIT 1`,
          [fileId]
        );
        workspaceId = ws.rows[0]?.id || null;
      } catch (_) { /* non-fatal */ }

      syncEvent = await writeSyncEvent(client, {
        workspaceId,
        entityType: "annotation",
        entityId: annotation.id,
        operation: "create",
        baseRevision: null,
        nextRevision: Number(annotation.revision),
        snapshot: buildSnapshot(annotation),
        patch: null,
        actorUserId: user.id,
        correlationId: null,
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      client.release();
      throw err;
    }
    client.release();

    // Resolve every project that can see this file — projectId is often
    // omitted (VR path, desktop useAnnotations hook), so we can't rely on it
    // alone to know who to tell. Must run on pool (not client) after release,
    // so a lookup failure can never roll back the already-committed insert.
    const broadcastProjectIds = await resolveBroadcastProjects(pool, fileId);
    // Server-derived project first — the request body's projectId is never
    // trusted for this (see H15); only used as a last-resort audit label
    // when the file has no project association at all to derive from.
    const auditProjectId = [...broadcastProjectIds][0] || projectId || null;

    // Audit log
    if (req.audit) {
      await req.audit({
        action: "annotation:create",
        orgId,
        projectId: auditProjectId,
        entityType: "annotation",
        entityId: annotation.id,
        after: { type, fileId, visibility },
      });
    }

    // Broadcast to every project that can see this file
    if (wsManager) {
      for (const pid of broadcastProjectIds) {
        wsManager.annotationCreated(
          pid,
          fileId,
          annotation,
          syncEvent?.id,
          user.id
        );
      }
    }

    res.status(201).json({
      success: true,
      annotation,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/annotations/:id
 * Update an annotation
 */
router.put("/:id", async (req, res, next) => {
  const { pool, wsManager } = req.app.locals;

  try {
    const { id } = req.params;
    const user = getUser(req);
    const actorUserId = user?.id || req.headers["x-user-id"] || null;
    const { base_revision, force_overwrite, ...updates } = req.body;
    const correlationId = req.headers["x-correlation-id"] || null;

    // Only the creator may update an annotation
    const creatorCheck = await pool.query(
      `SELECT created_by FROM annotations WHERE id = $1`,
      [id]
    );
    if (!creatorCheck.rows.length) {
      return res.status(404).json({ error: "Annotation not found" });
    }
    if (creatorCheck.rows[0].created_by !== actorUserId) {
      return res.status(403).json({ error: "Only the annotation creator may update it" });
    }

    // Build dynamic update query
    const allowedFields = [
      "type",
      "position",
      "normal",
      "text",
      "content",
      "metadata",
      "visibility",
      "locked",
    ];

    const fieldMapping = {
      coordinates: "position",
      properties: "content",
      visible: "visibility",
    };

    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      const requestField = Object.keys(fieldMapping).find(
        (k) => fieldMapping[k] === field
      );
      const updateValue =
        updates[field] !== undefined
          ? updates[field]
          : requestField !== undefined
          ? updates[requestField]
          : undefined;

      if (updateValue !== undefined) {
        let value = updateValue;
        if (
          ["content", "metadata"].includes(field) &&
          typeof value === "object"
        ) {
          value = JSON.stringify(value);
        }
        setClauses.push(`${field} = $${paramIndex++}`);
        values.push(value);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // Increment revision and track actor
    setClauses.push(`revision = revision + 1`);
    setClauses.push(`updated_at = NOW()`);
    setClauses.push(`updated_by = $${paramIndex++}`);
    values.push(actorUserId);

    const hasRevisionCheck = base_revision != null && !force_overwrite;
    let whereClause = `id = $${paramIndex++}`;
    values.push(id);
    if (hasRevisionCheck) {
      whereClause += ` AND revision = $${paramIndex++}`;
      values.push(Number(base_revision));
    }

    const client = await pool.connect();
    let annotation;
    let syncEvent;
    let oldStateForPatch = null;

    try {
      await client.query("BEGIN");

      // Fetch old state for patch computation.
      // OCC writes: guaranteed correct base. LWW writes: best-effort within transaction.
      const oldResult = await client.query("SELECT * FROM annotations WHERE id = $1", [id]);
      oldStateForPatch = oldResult.rows[0] || null;

      const result = await client.query(
        `UPDATE annotations SET ${setClauses.join(", ")} WHERE ${whereClause} RETURNING *`,
        values
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        client.release();

        if (hasRevisionCheck) {
          const current = await pool.query(
            "SELECT * FROM annotations WHERE id = $1",
            [id]
          );
          if (current.rows.length === 0) {
            return res.status(404).json({ error: "Annotation not found" });
          }
          const cur = current.rows[0];
          return res.status(409).json({
            error: "conflict",
            entityType: "annotation",
            entityId: id,
            clientBaseRevision: Number(base_revision),
            serverRevision: Number(cur.revision),
            serverObject: cur,
            updatedBy: cur.updated_by || null,
            updatedAt: cur.updated_at,
          });
        }

        return res.status(404).json({ error: "Annotation not found" });
      }

      annotation = result.rows[0];

      // Resolve workspace_id via dataset → project → workspace
      let workspaceId = null;
      try {
        const ws = await client.query(
          `SELECT w.id FROM workspaces w
           JOIN file_project_access fpa ON fpa.project_id = w.project_id
           WHERE fpa.file_id = $1 LIMIT 1`,
          [annotation.dataset_id]
        );
        workspaceId = ws.rows[0]?.id || null;
      } catch (_) { /* non-fatal */ }

      const snapshotData = buildSnapshot(annotation);
      let patchData = null;
      if (oldStateForPatch) {
        const ops = diffObjects(buildSnapshot(oldStateForPatch), snapshotData);
        patchData = ops.length > 0 ? ops : null;
      }

      const operation = force_overwrite ? "conflict_resolved" : "update";
      syncEvent = await writeSyncEvent(client, {
        workspaceId,
        entityType: "annotation",
        entityId: id,
        operation,
        baseRevision: base_revision != null ? Number(base_revision) : null,
        nextRevision: Number(annotation.revision),
        snapshot: snapshotData,
        patch: patchData,
        actorUserId,
        correlationId,
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      client.release();
      throw err;
    }

    client.release();

    // Audit log
    if (req.audit) {
      await req.audit({
        action: "annotation:update",
        entityType: "annotation",
        entityId: id,
        before: { id },
        after: { type: annotation.type, text: annotation.text },
      });
    }

    // Broadcast update
    if (wsManager) {
      const projects = await pool.query(
        "SELECT project_id FROM file_project_access WHERE file_id = $1",
        [annotation.dataset_id]
      );
      for (const row of projects.rows) {
        wsManager.annotationUpdated(
          row.project_id,
          annotation.dataset_id,
          annotation,
          syncEvent?.id,
          actorUserId
        );
      }
    }

    res.json({
      success: true,
      annotation,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/annotations/:id
 * Soft delete an annotation
 */
router.delete("/:id", async (req, res, next) => {
  const { pool, wsManager } = req.app.locals;

  try {
    const { id } = req.params;
    const user = getUser(req);

    // Get annotation info
    const existing = await pool.query(
      "SELECT * FROM annotations WHERE id = $1",
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Annotation not found" });
    }

    const annotation = existing.rows[0];

    // Only the creator may delete an annotation
    if (annotation.created_by !== user?.id) {
      return res.status(403).json({ error: "Only the annotation creator may delete it" });
    }

    // Soft delete + sync event in one transaction so delta hydration sees deletes
    let syncEvent = null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE annotations SET status = 'archived', updated_at = NOW() WHERE id = $1",
        [id]
      );

      let workspaceId = null;
      try {
        const ws = await client.query(
          `SELECT w.id FROM workspaces w
           JOIN file_project_access fpa ON fpa.project_id = w.project_id
           WHERE fpa.file_id = $1 LIMIT 1`,
          [annotation.dataset_id]
        );
        workspaceId = ws.rows[0]?.id || null;
      } catch (_) { /* non-fatal */ }

      syncEvent = await writeSyncEvent(client, {
        workspaceId,
        entityType: "annotation",
        entityId: id,
        operation: "delete",
        baseRevision: Number(annotation.revision) || null,
        nextRevision: Number(annotation.revision) || 1,
        snapshot: null,
        patch: null,
        actorUserId: user?.id || null,
        correlationId: null,
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      client.release();
      throw err;
    }
    client.release();

    // Audit log
    if (req.audit) {
      await req.audit({
        action: "annotation:delete",
        entityType: "annotation",
        entityId: id,
        before: { type: annotation.type, status: annotation.status },
        after: { status: "archived" },
      });
    }

    // Broadcast deletion
    if (wsManager) {
      const projects = await pool.query(
        "SELECT project_id FROM file_project_access WHERE file_id = $1",
        [annotation.dataset_id]
      );

      for (const row of projects.rows) {
        wsManager.annotationDeleted(row.project_id, annotation.dataset_id, id, syncEvent?.id, user?.id);
      }
    }

    res.json({ success: true, message: "Annotation deleted" });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/annotations/batch
 * Create multiple annotations at once
 */
router.post("/batch", async (req, res, next) => {
  const { pool, wsManager } = req.app.locals;
  const client = await pool.connect();

  try {
    const user = getUser(req);
    const { annotations, projectId } = req.body;

    if (!Array.isArray(annotations) || annotations.length === 0) {
      return res.status(400).json({ error: "annotations array required" });
    }

    if (annotations.length > 100) {
      return res
        .status(400)
        .json({ error: "Maximum 100 annotations per batch" });
    }

    await client.query("BEGIN");

    const created = [];
    // Per-file authorization cache — a batch can span multiple files, and
    // each one is checked independently server-side, never relying on the
    // shared top-level projectId (which the caller can omit — see H15).
    const fileAuthCache = new Map(); // fileId -> boolean

    for (const ann of annotations) {
      const {
        fileId,
        branchId,
        type,
        coordinates,
        position,
        normal,
        text,
        properties,
        metadata,
        visibility = "public",
      } = ann;

      if (!fileId || !type || !coordinates) {
        continue; // Skip invalid annotations
      }

      if (!fileAuthCache.has(fileId)) {
        const auth = await authorizeDatasetAccess(pool, fileId, user?.id);
        fileAuthCache.set(fileId, !!auth?.authorized);
      }
      if (!fileAuthCache.get(fileId)) {
        continue; // Skip: not authorized to annotate this file
      }

      const result = await client.query(
        `
        INSERT INTO annotations (
          dataset_id, branch_id, type,
          position, normal, text,
          content, metadata, visibility,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `,
        [
          fileId,
          branchId || null,
          type,
          coordinates || position || null, // Pass array directly for DOUBLE PRECISION[3]
          normal || null,
          text || null,
          properties ? JSON.stringify(properties) : null,
          metadata ? JSON.stringify(metadata) : "{}",
          visibility,
          user.id,
        ]
      );

      created.push(result.rows[0]);
    }

    await client.query("COMMIT");

    // Audit log for batch
    if (req.audit) {
      await req.audit({
        action: "annotation:batch_create",
        projectId,
        entityType: "annotation",
        entityId: null,
        details: { count: created.length },
      });
    }

    // Broadcast every created annotation to every project that can see its
    // file. A batch can span multiple files, so cache resolved project ids
    // per fileId to avoid re-querying file_project_access for repeats.
    if (wsManager) {
      const projectIdsByFile = new Map();
      for (const annotation of created) {
        const fid = annotation.dataset_id;
        if (!projectIdsByFile.has(fid)) {
          projectIdsByFile.set(fid, await resolveBroadcastProjects(pool, fid));
        }
        for (const pid of projectIdsByFile.get(fid)) {
          wsManager.annotationCreated(pid, fid, annotation);
        }
      }
    }

    res.status(201).json({
      success: true,
      created: created.length,
      skipped: annotations.length - created.length,
      annotations: created,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

/**
 * POST /api/annotations/:id/migrate
 * Migrate annotation to a new file version (handles coordinate changes)
 */
router.post("/:id/migrate", async (req, res, next) => {
  const { pool } = req.app.locals;

  try {
    const { id } = req.params;
    const user = getUser(req);
    const { targetVersionId, newCoordinates, status = "migrated" } = req.body;

    if (!targetVersionId) {
      return res.status(400).json({ error: "targetVersionId required" });
    }

    // Get original annotation
    const original = await pool.query(
      "SELECT * FROM annotations WHERE id = $1",
      [id]
    );

    if (original.rows.length === 0) {
      return res.status(404).json({ error: "Annotation not found" });
    }

    const sourceAnnotation = original.rows[0];

    // Only the creator may migrate an annotation (mirrors PUT/DELETE's
    // creator-only checks above).
    if (sourceAnnotation.created_by !== user?.id) {
      return res.status(403).json({ error: "Only the annotation creator may migrate it" });
    }

    // Re-verify the creator still has access to the dataset (project access
    // may have been revoked since the annotation was created).
    const auth = await authorizeDatasetAccess(pool, sourceAnnotation.dataset_id, user.id);
    if (!auth?.authorized) {
      return res.status(403).json({ error: "Not authorized to migrate annotations for this dataset" });
    }

    // The target version must belong to the SAME dataset as the source
    // annotation — otherwise a caller could re-point an annotation onto an
    // unrelated dataset's version history.
    const versionCheck = await pool.query(
      "SELECT id FROM file_versions WHERE id = $1 AND file_id = $2",
      [targetVersionId, sourceAnnotation.dataset_id]
    );
    if (versionCheck.rows.length === 0) {
      return res.status(400).json({ error: "targetVersionId does not belong to this annotation's dataset" });
    }

    // Create migrated copy
    // Note: Database schema uses 'position' for coordinates and 'content' for properties
    // Position is DOUBLE PRECISION[3] (PostgreSQL array), pass array directly
    const result = await pool.query(
      `
      INSERT INTO annotations (
        dataset_id, file_version_id, branch_id, type,
        position, normal, text,
        content, metadata, visibility,
        created_by,
        migrated_from
      )
      SELECT
        dataset_id, $2, branch_id, type,
        $3, normal, text,
        content, metadata, visibility,
        created_by,
        $1
      FROM annotations WHERE id = $1
      RETURNING *
    `,
      [
        id,
        targetVersionId,
        newCoordinates || sourceAnnotation.position, // Pass array directly
      ]
    );

    // Mark original as migrated
    await pool.query("UPDATE annotations SET status = $2 WHERE id = $1", [
      id,
      status,
    ]);

    res.json({
      success: true,
      original: { id, status },
      migrated: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.resolveBroadcastProjects = resolveBroadcastProjects;
