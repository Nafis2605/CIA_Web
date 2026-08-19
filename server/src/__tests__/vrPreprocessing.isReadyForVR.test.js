// server/src/__tests__/vrPreprocessing.isReadyForVR.test.js
//
// Unit tests for vrPreprocessing.isReadyForVR().
//
// Pure unit tests — no live database. The `pool` argument is a hand-rolled
// fake whose `query()` is a jest.fn() that inspects the SQL text and
// returns canned rows, mirroring the two queries isReadyForVR issues:
//   1. SELECT ... FROM vr_preprocessing WHERE dataset_id = $1  (status)
//   2. SELECT d.*, dv.metadata ... FROM datasets d ...          (needs)
//
// Run: npx jest server/src/__tests__/vrPreprocessing.isReadyForVR.test.js

const {
  isReadyForVR,
  PreprocessingStatus,
} = require("../services/vrPreprocessing");

/**
 * Build a fake pg Pool whose query() routes based on the SQL text.
 *
 * @param {Object} opts
 * @param {Object|null} opts.preprocessingRow - row returned for the
 *   vr_preprocessing lookup, or null for "no record" (PENDING).
 * @param {Object|null} opts.datasetRow - row returned for the datasets
 *   join lookup, or null for "dataset not found".
 */
function makeFakePool({ preprocessingRow = null, datasetRow = null } = {}) {
  return {
    query: jest.fn((sql) => {
      if (sql.includes("FROM vr_preprocessing")) {
        return Promise.resolve({
          rows: preprocessingRow ? [preprocessingRow] : [],
        });
      }
      if (sql.includes("FROM datasets")) {
        return Promise.resolve({
          rows: datasetRow ? [datasetRow] : [],
        });
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    }),
  };
}

describe("isReadyForVR", () => {
  test("small dataset (required:false) with no preprocessing record (PENDING) is ready", async () => {
    const pool = makeFakePool({
      preprocessingRow: null,
      // REAL `datasets` column names. These fixtures used to carry
      // `size_bytes` and a `version_metadata` JSON blob from a
      // `dataset_versions` join — none of which exist in the schema, which is
      // why isReadyForVR silently computed `required: false` for every
      // dataset in production while these tests passed.
      datasetRow: {
        id: "small-dataset",
        file_size: 1024,
        point_count: 100,
        cell_count: 200,
      },
    });

    const result = await isReadyForVR(pool, "small-dataset");

    expect(result.status).toBe(PreprocessingStatus.PENDING);
    expect(result.required).toBe(false);
    expect(result.ready).toBe(true);
  });

  test("large dataset (required:true) with no preprocessing record (PENDING) is not ready and lists operations", async () => {
    const pool = makeFakePool({
      preprocessingRow: null,
      datasetRow: {
        id: "large-dataset",
        file_size: 600 * 1024 * 1024,
        point_count: 20_000_000,
        cell_count: 8_000_000,
      },
    });

    const result = await isReadyForVR(pool, "large-dataset");

    expect(result.status).toBe(PreprocessingStatus.PENDING);
    expect(result.required).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.estimatedTime).toBeGreaterThan(0);
  });

  test("large dataset (required:true) with COMPLETE preprocessing record is ready", async () => {
    const pool = makeFakePool({
      preprocessingRow: {
        id: "job-1",
        status: PreprocessingStatus.COMPLETE,
        progress: 100,
        operations: [{ type: "vr-lod-generation" }],
        result_metadata: { lodLevels: 4 },
      },
      datasetRow: {
        id: "large-dataset",
        file_size: 600 * 1024 * 1024,
        point_count: 20_000_000,
        cell_count: 8_000_000,
      },
    });

    const result = await isReadyForVR(pool, "large-dataset");

    expect(result.status).toBe(PreprocessingStatus.COMPLETE);
    expect(result.required).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.operations).toEqual([{ type: "vr-lod-generation" }]);
  });

  test("falls back to required:false (ready) when the dataset lookup fails", async () => {
    const pool = {
      query: jest.fn((sql) => {
        if (sql.includes("FROM vr_preprocessing")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.reject(new Error("connection lost"));
      }),
    };

    const result = await isReadyForVR(pool, "some-dataset");

    expect(result.status).toBe(PreprocessingStatus.PENDING);
    expect(result.required).toBe(false);
    expect(result.ready).toBe(true);
  });
});
