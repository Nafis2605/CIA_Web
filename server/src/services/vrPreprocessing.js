/**
 * VR Preprocessing Service
 *
 * Handles preprocessing of datasets for optimal VR exploration.
 * Uses BullMQ for job queuing and tracks preprocessing status.
 *
 * Preprocessing operations:
 * - LOD (Level of Detail) generation for large meshes
 * - Point cloud optimization (octree generation)
 * - Texture compression for VR
 * - Bounding box and centroid calculation
 */

const { v4: uuidv4 } = require("uuid");
const jobQueue = require("./jobQueue");
const { createLogger } = require("../utils/logger");

const log = createLogger("vr-preprocess");

// Preprocessing thresholds
const THRESHOLDS = {
  // Point counts that trigger preprocessing
  POINTS_HIGH: 10_000_000, // 10M+ points: full preprocessing
  POINTS_MEDIUM: 1_000_000, // 1M+ points: light preprocessing

  // Polygon counts
  POLYGONS_HIGH: 5_000_000, // 5M+ polygons: full LOD
  POLYGONS_MEDIUM: 500_000, // 500K+ polygons: simple LOD

  // File sizes (bytes)
  SIZE_HIGH: 500 * 1024 * 1024, // 500MB+
  SIZE_MEDIUM: 50 * 1024 * 1024, // 50MB+
};

// Preprocessing status enum
const PreprocessingStatus = {
  NOT_NEEDED: "not_needed",
  PENDING: "pending",
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETE: "complete",
  FAILED: "failed",
};

// Preprocessing operations
const PreprocessingOps = {
  LOD_GENERATION: "vr-lod-generation",
  OCTREE_BUILD: "vr-octree-build",
  BOUNDS_CALC: "vr-bounds-calculation",
  TEXTURE_COMPRESS: "vr-texture-compress",
};

/**
 * Check if a dataset needs VR preprocessing
 *
 * @param {Object} dataset - Dataset record from database
 * @param {Object} metadata - Dataset metadata (point count, polygon count, etc.)
 * @returns {Object} Preprocessing requirements
 */
function checkPreprocessingNeeds(dataset, metadata = {}) {
  const needs = {
    required: false,
    operations: [],
    priority: 5,
    estimatedTime: 0,
  };

  // Fall back to the dataset row's OWN columns when no metadata object is
  // supplied. Callers used to pass `dataset.version_metadata`, sourced from a
  // LEFT JOIN on `dataset_versions` — a table that exists in no migration and
  // in no live database, so that join always errored and this function only
  // ever saw an empty metadata object. Every threshold below therefore
  // compared 0 against its limit and `required` was permanently false.
  //
  // `cell_count` is the polygon count for the polydata this app deals in, and
  // `file_size` is the real column name — `size_bytes` does not exist on
  // `datasets` either. The explicit metadata argument still wins, so callers
  // (and tests) that already have richer numbers keep passing them.
  const pointCount = metadata.pointCount ?? dataset.point_count ?? 0;
  const polygonCount = metadata.polygonCount ?? dataset.cell_count ?? 0;
  const fileSize = dataset.size_bytes ?? dataset.file_size ?? 0;

  // Check point cloud preprocessing
  if (pointCount > THRESHOLDS.POINTS_HIGH) {
    needs.required = true;
    needs.operations.push({
      type: PreprocessingOps.OCTREE_BUILD,
      reason: "Large point cloud requires octree",
      priority: 8,
    });
    needs.estimatedTime += 120; // 2 minutes estimate
  } else if (pointCount > THRESHOLDS.POINTS_MEDIUM) {
    needs.required = true;
    needs.operations.push({
      type: PreprocessingOps.OCTREE_BUILD,
      reason: "Medium point cloud benefits from octree",
      priority: 5,
    });
    needs.estimatedTime += 60;
  }

  // Check mesh LOD preprocessing
  if (polygonCount > THRESHOLDS.POLYGONS_HIGH) {
    needs.required = true;
    needs.operations.push({
      type: PreprocessingOps.LOD_GENERATION,
      reason: "Large mesh requires LOD levels",
      priority: 8,
      params: { levels: [1.0, 0.5, 0.25, 0.1] },
    });
    needs.estimatedTime += 180; // 3 minutes
  } else if (polygonCount > THRESHOLDS.POLYGONS_MEDIUM) {
    needs.required = true;
    needs.operations.push({
      type: PreprocessingOps.LOD_GENERATION,
      reason: "Medium mesh benefits from LOD",
      priority: 5,
      params: { levels: [1.0, 0.5, 0.25] },
    });
    needs.estimatedTime += 90;
  }

  // Always calculate bounds for VR (fast operation)
  if (fileSize > 0) {
    needs.operations.push({
      type: PreprocessingOps.BOUNDS_CALC,
      reason: "Bounds needed for VR navigation",
      priority: 3,
    });
    needs.estimatedTime += 10;
  }

  // Set overall priority based on highest operation priority
  if (needs.operations.length > 0) {
    needs.priority = Math.max(...needs.operations.map((op) => op.priority));
  }

  return needs;
}

/**
 * Get preprocessing status for a dataset
 *
 * @param {Object} pool - Database pool
 * @param {string} datasetId - Dataset UUID
 * @returns {Object} Preprocessing status
 */
async function getPreprocessingStatus(pool, datasetId) {
  // Check for existing preprocessing record
  const result = await pool.query(
    `SELECT * FROM vr_preprocessing WHERE dataset_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [datasetId]
  );

  if (result.rows.length === 0) {
    return {
      status: PreprocessingStatus.PENDING,
      progress: 0,
      operations: [],
      message: "Preprocessing not started",
    };
  }

  const record = result.rows[0];
  return {
    id: record.id,
    status: record.status,
    progress: record.progress || 0,
    operations: record.operations || [],
    startedAt: record.started_at,
    completedAt: record.completed_at,
    error: record.error_message,
    resultMetadata: record.result_metadata,
  };
}

/**
 * Start VR preprocessing for a dataset
 *
 * @param {Object} pool - Database pool
 * @param {string} datasetId - Dataset UUID
 * @param {Object} options - Preprocessing options
 * @returns {Object} Preprocessing job info
 */
async function startPreprocessing(pool, datasetId, options = {}) {
  const { userId, projectId, force = false } = options;

  // Get dataset info
  const datasetResult = await pool.query(
    // NOTE: no join to `dataset_versions`. That table does not exist — not in
    // init.sql, not in any migration, not in the running database — so this
    // query raised `relation "dataset_versions" does not exist` on every call.
    // In startPreprocessing that error propagated; in isReadyForVR a try/catch
    // swallowed it and fell back to `required: false`, which is why VR entry
    // still worked while the preprocessing needs it is supposed to compute
    // were silently never computed. Everything checkPreprocessingNeeds()
    // reads (point_count, cell_count, bounds, data_arrays) already lives on
    // `datasets` itself.
    `SELECT d.* FROM datasets d WHERE d.id = $1`,
    [datasetId]
  );

  if (datasetResult.rows.length === 0) {
    throw new Error("Dataset not found");
  }

  const dataset = datasetResult.rows[0];
  const metadata = {};

  // Check if preprocessing already complete (unless force)
  if (!force) {
    const existingStatus = await getPreprocessingStatus(pool, datasetId);
    if (existingStatus.status === PreprocessingStatus.COMPLETE) {
      return {
        alreadyComplete: true,
        ...existingStatus,
      };
    }
    if (
      existingStatus.status === PreprocessingStatus.QUEUED ||
      existingStatus.status === PreprocessingStatus.PROCESSING
    ) {
      return {
        inProgress: true,
        ...existingStatus,
      };
    }
  }

  // Determine preprocessing needs
  const needs = checkPreprocessingNeeds(dataset, metadata);

  if (!needs.required && needs.operations.length === 0) {
    // No preprocessing needed, create a "complete" record
    const result = await pool.query(
      `INSERT INTO vr_preprocessing (
        dataset_id, project_id, requested_by,
        status, progress, operations, result_metadata, completed_at
      ) VALUES ($1, $2, $3, $4, 100, $5, $6, NOW())
      RETURNING *`,
      [
        datasetId,
        projectId,
        userId,
        PreprocessingStatus.NOT_NEEDED,
        JSON.stringify([]),
        JSON.stringify({ reason: "Dataset within VR limits" }),
      ]
    );

    return {
      id: result.rows[0].id,
      status: PreprocessingStatus.NOT_NEEDED,
      message: "Dataset does not require preprocessing for VR",
    };
  }

  // Create preprocessing record
  const preprocessingId = uuidv4();
  await pool.query(
    `INSERT INTO vr_preprocessing (
      id, dataset_id, project_id, requested_by,
      status, progress, operations
    ) VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [
      preprocessingId,
      datasetId,
      projectId,
      userId,
      PreprocessingStatus.QUEUED,
      JSON.stringify(needs.operations),
    ]
  );

  // Queue preprocessing jobs
  for (const op of needs.operations) {
    try {
      await jobQueue.addJob({
        id: `${preprocessingId}-${op.type}`,
        operation: op.type,
        workerType: "vr-preprocessing",
        fileId: datasetId,
        fileStorageKey: dataset.storage_key,
        params: {
          preprocessingId,
          operationType: op.type,
          ...op.params,
        },
        priority: op.priority,
        cacheKey: `vr-preprocess-${datasetId}-${op.type}`,
      });

      log.info(`Queued VR preprocessing: ${op.type} for dataset ${datasetId}`);
    } catch (err) {
      log.error(`Failed to queue preprocessing ${op.type}:`, err);
    }
  }

  return {
    id: preprocessingId,
    status: PreprocessingStatus.QUEUED,
    operations: needs.operations,
    estimatedTime: needs.estimatedTime,
    message: `Queued ${needs.operations.length} preprocessing operation(s)`,
  };
}

/**
 * Update preprocessing progress
 *
 * @param {Object} pool - Database pool
 * @param {string} preprocessingId - Preprocessing job UUID
 * @param {Object} update - Progress update
 */
async function updateProgress(pool, preprocessingId, update) {
  const { progress, operation, status, error } = update;

  let query = "UPDATE vr_preprocessing SET ";
  const updates = [];
  const values = [];
  let paramIndex = 1;

  if (progress !== undefined) {
    updates.push(`progress = $${paramIndex++}`);
    values.push(progress);
  }

  if (status) {
    updates.push(`status = $${paramIndex++}`);
    values.push(status);

    if (status === PreprocessingStatus.PROCESSING) {
      updates.push(`started_at = COALESCE(started_at, NOW())`);
    } else if (
      status === PreprocessingStatus.COMPLETE ||
      status === PreprocessingStatus.FAILED
    ) {
      updates.push(`completed_at = NOW()`);
    }
  }

  if (error) {
    updates.push(`error_message = $${paramIndex++}`);
    values.push(error);
  }

  if (updates.length === 0) return;

  query += updates.join(", ");
  query += ` WHERE id = $${paramIndex}`;
  values.push(preprocessingId);

  await pool.query(query, values);
}

/**
 * Complete preprocessing with results
 *
 * @param {Object} pool - Database pool
 * @param {string} preprocessingId - Preprocessing job UUID
 * @param {Object} results - Preprocessing results
 */
async function completePreprocessing(pool, preprocessingId, results) {
  await pool.query(
    `UPDATE vr_preprocessing SET
      status = $1,
      progress = 100,
      completed_at = NOW(),
      result_metadata = $2
    WHERE id = $3`,
    [PreprocessingStatus.COMPLETE, JSON.stringify(results), preprocessingId]
  );

  log.info(`VR preprocessing complete: ${preprocessingId}`);
}

/**
 * Check if dataset is ready for VR
 *
 * A dataset can be "ready" two different ways:
 *   1. It went through preprocessing and that preprocessing completed
 *      (or was recorded as NOT_NEEDED).
 *   2. It never needed preprocessing in the first place — e.g. a small
 *      dataset that has a `vr_preprocessing` status of PENDING simply
 *      because no one has ever run `startPreprocessing` for it.
 *
 * `getPreprocessingStatus` alone cannot distinguish those two PENDING
 * cases — "never preprocessed because it's tiny" and "never preprocessed
 * but urgently needs it" both come back as `status: PENDING`. So this
 * function additionally loads the dataset row and re-runs
 * `checkPreprocessingNeeds` (the same size-threshold logic
 * `startPreprocessing` uses) to learn whether preprocessing is actually
 * `required` for this dataset.
 *
 * THE LOAD-BEARING RULE: if `required` is false, `ready` is forced to
 * `true` regardless of `status`. Only a dataset where preprocessing is
 * both required AND not yet complete is ever reported as not ready. This
 * is what makes it safe to gate VR entry on this function's result — a
 * naive `status === COMPLETE` check would block every dataset that has
 * simply never been preprocessed, including ones that never needed it.
 *
 * @param {Object} pool - Database pool
 * @param {string} datasetId - Dataset UUID
 * @returns {Object} Readiness status: { ready, required, status, progress,
 *   operations, estimatedTime, resultMetadata, message }
 */
async function isReadyForVR(pool, datasetId) {
  const status = await getPreprocessingStatus(pool, datasetId);

  // Determine whether preprocessing is actually required for this dataset
  // (independent of whether it has ever been run). Best-effort: if the
  // dataset lookup fails for any reason, fall back to `required: false`
  // (the historical/pre-existing behavior) rather than blocking entry.
  let needs = { required: false, operations: [], estimatedTime: 0 };
  try {
    const datasetResult = await pool.query(
      // See startPreprocessing above: `dataset_versions` does not exist.
      // The try/catch around this call meant the resulting error was
      // swallowed and `needs` stayed at its `required: false` default, so
      // this function has never actually computed a preprocessing requirement.
      `SELECT d.* FROM datasets d WHERE d.id = $1`,
      [datasetId]
    );

    if (datasetResult.rows.length > 0) {
      const dataset = datasetResult.rows[0];
      const metadata = {};
      needs = checkPreprocessingNeeds(dataset, metadata);
    }
  } catch (err) {
    log.error(`Failed to determine VR preprocessing needs for ${datasetId}:`, err);
  }

  const statusReady =
    status.status === PreprocessingStatus.COMPLETE ||
    status.status === PreprocessingStatus.NOT_NEEDED;

  // See the load-bearing rule above: `required === false` always wins.
  const ready = needs.required ? statusReady : true;

  // Prefer the operations recorded on the actual preprocessing record
  // (reflects what was/is actually queued or running); fall back to the
  // freshly-computed needs when no record exists yet (e.g. PENDING).
  const operations =
    status.operations && status.operations.length > 0
      ? status.operations
      : needs.operations;

  return {
    ready,
    required: needs.required,
    status: status.status,
    progress: status.progress,
    operations,
    estimatedTime: needs.estimatedTime,
    resultMetadata: status.resultMetadata,
    message: ready
      ? "Dataset ready for VR exploration"
      : `Preprocessing ${status.status}: ${status.progress}%`,
  };
}

module.exports = {
  // Status constants
  PreprocessingStatus,
  PreprocessingOps,
  THRESHOLDS,

  // Functions
  checkPreprocessingNeeds,
  getPreprocessingStatus,
  startPreprocessing,
  updateProgress,
  completePreprocessing,
  isReadyForVR,
};
