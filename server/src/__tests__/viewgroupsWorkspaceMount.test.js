// server/src/__tests__/viewgroupsWorkspaceMount.test.js
// POST /api/workspaces/:workspaceId/viewgroups used to 500 on every call
// ("null value in column \"workspace_id\" ... violates not-null
// constraint") because the route was registered as
// `router.post(['/', '/workspaces/:workspaceId/viewgroups'], handler)` —
// an array of two path patterns on one router.post() call. Proven via an
// isolated Express repro: with mergeParams: true but an ARRAY of patterns,
// the parent mount's :workspaceId param does not merge into req.params for
// the '/' pattern (the one that actually matches once the parent mount has
// already consumed /workspaces/:workspaceId/viewgroups) — req.params comes
// back {}. This is exactly the kind of route-mounting bug a handler-level
// unit test can't see; it needs a real Express app + real HTTP request
// through the actual mount structure production uses.
//
// ─── AUTO-SKIP ─────────────────────────────────────────────────────────────
// Tests auto-skip if TEST_DATABASE_URL is not set.
//
// ─── SETUP ──────────────────────────────────────────────────────────────────
//   1. docker-compose up -d cia-postgres
//   2. NODE_ENV=development \
//      TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//      DEV_BYPASS_AUTH=true \
//      cd server && npm test -- --testPathPattern "viewgroupsWorkspaceMount" --runInBand

'use strict';

const request = require('supertest');
const express = require('express');
const { createTestPool, integrationDescribe, SEED } = require('./helpers/dbFixture');

const pool = createTestPool();

function createViewGroupsMountTestApp(pool) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;
  app.locals.wsManager = {
    broadcastToWorkspace: () => {},
    broadcastToProject: () => {},
  };

  const { authenticate } = require('../middleware/auth');
  const workspacesRouter = require('../routes/workspaces');
  const viewgroupsRouter = require('../routes/viewgroups');

  // Mirrors server/src/index.js's exact mount points AND registration
  // order (the more specific /api/workspaces/:workspaceId/viewgroups mount
  // before the bare /api/workspaces one) — the bug only shows up through
  // this specific mount, not by calling the handler directly.
  app.use('/api/workspaces/:workspaceId/viewgroups', authenticate, viewgroupsRouter);
  app.use('/api/viewgroups', authenticate, viewgroupsRouter);
  app.use('/api/workspaces', authenticate, workspacesRouter);
  return app;
}

integrationDescribe('POST /api/workspaces/:workspaceId/viewgroups mount', pool, () => {
  let app;
  let workspaceId;
  const createdViewGroupIds = [];

  beforeAll(async () => {
    app = createViewGroupsMountTestApp(pool);
    const res = await request(app)
      .get('/api/workspaces/personal')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst');
    workspaceId = res.body.id;
    expect(workspaceId).toBeTruthy();
  });

  afterAll(async () => {
    if (createdViewGroupIds.length) {
      await pool.query('DELETE FROM viewgroups WHERE id = ANY($1)', [createdViewGroupIds]);
    }
    // pool is shared with the second describe block below (module scope) —
    // it closes the pool in its own afterAll instead.
  });

  test('creates a ViewGroup with workspaceId correctly merged from the mount path', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/viewgroups`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst')
      .send({ name: 'Test Group' });

    expect(res.status).toBe(201);
    expect(res.body.workspaceId).toBe(workspaceId);
    expect(res.body.name).toBe('Test Group');
    createdViewGroupIds.push(res.body.id);
  });

  test('the row actually lands in Postgres under the mount-derived workspace_id, not NULL', async () => {
    const createRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/viewgroups`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst')
      .send({ name: 'Persisted Group' });
    expect(createRes.status).toBe(201);
    createdViewGroupIds.push(createRes.body.id);

    const row = await pool.query('SELECT workspace_id FROM viewgroups WHERE id = $1', [
      createRes.body.id,
    ]);
    expect(row.rows[0].workspace_id).toBe(workspaceId);
  });
});

// GET /api/workspaces/:workspaceId/viewgroups (list) and GET
// /api/viewgroups/:id (by id) both used to 500 with `column vc.view_type
// does not exist` — their per-ViewGroup "get views" query selected
// `vc.view_type`, a column that has never existed on view_configurations
// (confirmed: not in server/database/init.sql or any migration; a view's
// "type" — e.g. 'vtk-slice' — is derived client-side from the live VTK
// instance and never persisted server-side). Postgres rejects an unknown
// column at query-parse time, so this 500ed even for a ViewGroup with zero
// views — reproduced live via the running app's "Load a dataset" flow,
// which calls this same listing route right after creating a ViewGroup.
integrationDescribe('GET viewgroups routes (view_type column bug)', pool, () => {
  let app;
  let workspaceId;
  let viewGroupId;

  beforeAll(async () => {
    app = createViewGroupsMountTestApp(pool);
    const wsRes = await request(app)
      .get('/api/workspaces/personal')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst');
    workspaceId = wsRes.body.id;
    expect(workspaceId).toBeTruthy();

    const createRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/viewgroups`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst')
      .send({ name: 'GET-route regression group' });
    expect(createRes.status).toBe(201);
    viewGroupId = createRes.body.id;
  });

  afterAll(async () => {
    if (viewGroupId) {
      await pool.query('DELETE FROM viewgroups WHERE id = $1', [viewGroupId]);
    }
    if (pool) await pool.end();
  });

  test('list route no longer 500s and returns the created group with a null viewType', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/viewgroups`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst');

    expect(res.status).toBe(200);
    const group = res.body.viewGroups.find((vg) => vg.id === viewGroupId);
    expect(group).toBeTruthy();
    expect(group.views).toEqual([]);
  });

  test('get-by-id route no longer 500s', async () => {
    const res = await request(app)
      .get(`/api/viewgroups/${viewGroupId}`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst');

    expect(res.status).toBe(200);
    expect(res.body.viewGroup.id).toBe(viewGroupId);
    expect(res.body.viewGroup.views).toEqual([]);
  });
});
