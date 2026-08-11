// server/src/__tests__/bundledDatasetAnnotations.test.js
// Phase 3, item G: bundled/built-in VTP datasets (public/vtp_files/manifest.json,
// e.g. "builtin-lungs") get a real, stable server-side UUID row
// (migrations/020_bundled_dataset_ids.sql) so their annotations flow through
// the EXISTING authorization/storage path with no special-casing. This
// confirms the full loop: GET /api/files/builtin resolves the manifest key
// to its UUID, and POST /api/annotations with that UUID succeeds via
// authorizeDatasetAccess's existing public-fallback rule (a dataset with no
// file_project_access rows and a non-null public_path is accessible to
// everyone) — no new authorization code path, just confirming bundled
// datasets now reach the one that already exists.
//
// ─── AUTO-SKIP ─────────────────────────────────────────────────────────────
// Tests auto-skip if TEST_DATABASE_URL is not set.
//
// ─── SETUP ──────────────────────────────────────────────────────────────────
//   1. docker-compose up -d cia-postgres
//   2. ./server/database/run-migration.sh migrations/020_bundled_dataset_ids.sql
//      (or: docker exec -i cia-postgres psql -U ciauser -d cia_analytics \
//           < server/database/migrations/020_bundled_dataset_ids.sql)
//   3. NODE_ENV=development \
//      TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//      DEV_BYPASS_AUTH=true \
//      cd server && npm test -- --testPathPattern "bundledDatasetAnnotations" --runInBand

'use strict';

const request = require('supertest');
const express = require('express');
const { createTestPool, integrationDescribe, SEED } = require('./helpers/dbFixture');

const pool = createTestPool();

function createBundledTestApp(pool) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;
  app.locals.wsManager = {
    annotationCreated: () => {},
    annotationUpdated: () => {},
    broadcastToProject: () => {},
  };

  const { authenticate } = require('../middleware/auth');
  const filesRouter = require('../routes/files');
  const annotationsRouter = require('../routes/annotations');

  app.use('/api/files', authenticate, filesRouter);
  app.use('/api/annotations', authenticate, annotationsRouter);
  return app;
}

integrationDescribe('Bundled dataset annotation authorization', pool, () => {
  let app;

  beforeAll(() => {
    app = createBundledTestApp(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  test('GET /api/files/builtin resolves every seeded manifest key to a UUID', async () => {
    const res = await request(app)
      .get('/api/files/builtin')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.datasets)).toBe(true);
    const lungs = res.body.datasets.find((d) => d.builtin_key === 'builtin-lungs');
    expect(lungs).toBeDefined();
    expect(lungs.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(lungs.public_path).toBe('/vtp_files/Lungs.vtp');
  });

  test('the resolved UUID is accessible to ANY authenticated user via the public-fallback rule', async () => {
    const listRes = await request(app)
      .get('/api/files/builtin')
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob Builder');
    const lungsId = listRes.body.datasets.find((d) => d.builtin_key === 'builtin-lungs').id;

    // Bob is a member of no project and has no relation to this dataset
    // beyond it being a bundled, public asset.
    const createRes = await request(app)
      .post('/api/annotations')
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob Builder')
      .send({ fileId: lungsId, type: 'note', coordinates: [1, 2, 3] });

    expect(createRes.status).toBe(201);

    await pool.query('DELETE FROM annotations WHERE id = $1', [createRes.body.annotation.id]);
  });
});
