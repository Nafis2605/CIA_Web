// server/src/__tests__/viewgroupsLinksReconciliationMount.test.js
//
// server/src/index.js used to mount viewgroupsRouter (a single Express
// Router whose routes already embed their own '/links/...' and
// '/views/:viewId/...' prefixes) AGAIN at '/api/links' and '/api/views' —
// producing double-prefixed live paths ('/api/links/links/view',
// '/api/views/views/:viewId/reconciliation-status') that never matched what
// the client (src/core/data/managers/ViewGroupManager.js) actually calls,
// so every one of these routes 404'd. The fix splits viewgroups.js into
// three routers (CRUD, viewLinksRouter, reconciliationRouter) with prefixes
// stripped, and mounts each at its own dedicated path — this test builds an
// app that mirrors index.js's real mount structure and proves each
// previously-404ing route now resolves to OUR handler (not Express's
// catch-all "no route matched" 404) by checking for our handler's specific
// JSON error shape on an unresolvable id, which only a matched route can
// produce.
//
// ─── AUTO-SKIP ─────────────────────────────────────────────────────────────
// Tests auto-skip if TEST_DATABASE_URL is not set.
//
// ─── SETUP ──────────────────────────────────────────────────────────────────
//   1. docker-compose up -d cia-postgres
//   2. NODE_ENV=development \
//      TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//      DEV_BYPASS_AUTH=true \
//      cd server && npm test -- --testPathPattern "viewgroupsLinksReconciliationMount" --runInBand

'use strict';

const request = require('supertest');
const express = require('express');
const { createTestPool, integrationDescribe, SEED } = require('./helpers/dbFixture');

const pool = createTestPool();

function createMountTestApp(pool) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;
  app.locals.wsManager = {
    broadcastToWorkspace: () => {},
    broadcastToProject: () => {},
  };

  const { authenticate } = require('../middleware/auth');
  const viewgroupsRouter = require('../routes/viewgroups');
  const workspacesRouter = require('../routes/workspaces');

  // Mirrors server/src/index.js's real mount structure: the CRUD router at
  // /api/viewgroups (+ workspace-nested), and the two split-out routers at
  // /api/links and /api/views — the exact structure that was broken before
  // this fix (previously the SAME combined router was reused at all four
  // mounts, double-prefixing the link/reconciliation routes). workspacesRouter
  // is mounted too so the roundtrip suite below can fetch/create a real
  // personal workspace (same as viewgroupsWorkspaceMount.test.js).
  app.use('/api/workspaces/:workspaceId/viewgroups', authenticate, viewgroupsRouter);
  app.use('/api/viewgroups', authenticate, viewgroupsRouter);
  app.use('/api/links', authenticate, viewgroupsRouter.viewLinksRouter);
  app.use('/api/views', authenticate, viewgroupsRouter.reconciliationRouter);
  app.use('/api/workspaces', authenticate, workspacesRouter);
  return app;
}

// Closes the pool once, after BOTH describe blocks below have finished —
// they share the same module-level `pool` (declared once for the whole
// file), so closing it in the first block's own afterAll would break the
// second block's beforeAll/tests, which run afterward in the same file.
afterAll(async () => {
  if (pool) await pool.end();
});

integrationDescribe('viewgroups link/reconciliation route mounting', pool, () => {
  let app;

  beforeAll(() => {
    app = createMountTestApp(pool);
  });

  // Express's own "no route matched" 404 is a plain-text/HTML response with
  // no JSON body — distinguishable from OUR handlers' JSON 404s, which only
  // fire once a route has actually matched and executed. Asserting the
  // JSON shape is proof the route resolved, not just that *a* 404 came back.
  function expectHandlerNotFound(res, expectedError) {
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expectedError });
  }

  test('POST /api/links/view resolves to the handler (not double-prefixed)', async () => {
    const res = await request(app)
      .post('/api/links/view')
      .set('x-user-id', SEED.USER_ALICE)
      .send({
        sourceViewId: '00000000-0000-0000-0000-000000000000',
        targetViewId: '00000000-0000-0000-0000-000000000001',
        property: 'camera',
      });
    expectHandlerNotFound(res, 'Source view not found');
  });

  test('DELETE /api/links/view/:id resolves to the handler', async () => {
    const res = await request(app)
      .delete('/api/links/view/00000000-0000-0000-0000-000000000000')
      .set('x-user-id', SEED.USER_ALICE);
    expectHandlerNotFound(res, 'View link not found');
  });

  test('PATCH /api/links/view/:id resolves to the handler (previously did not exist at all)', async () => {
    const res = await request(app)
      .patch('/api/links/view/00000000-0000-0000-0000-000000000000')
      .set('x-user-id', SEED.USER_ALICE)
      .send({ mode: 'follow' });
    expectHandlerNotFound(res, 'View link not found');
  });

  test('POST /api/links/viewgroup resolves to the handler', async () => {
    const res = await request(app)
      .post('/api/links/viewgroup')
      .set('x-user-id', SEED.USER_ALICE)
      .send({ originatorGroupId: '00000000-0000-0000-0000-000000000000', targetGroupId: '00000000-0000-0000-0000-000000000000' });
    expectHandlerNotFound(res, 'ViewGroup not found');
  });

  test('DELETE /api/links/viewgroup/:id resolves to the handler', async () => {
    const res = await request(app)
      .delete('/api/links/viewgroup/00000000-0000-0000-0000-000000000000')
      .set('x-user-id', SEED.USER_ALICE);
    expectHandlerNotFound(res, 'ViewGroup link not found');
  });

  test('GET /api/views/:viewId/reconciliation-status resolves to the handler', async () => {
    const res = await request(app)
      .get('/api/views/00000000-0000-0000-0000-000000000000/reconciliation-status')
      .set('x-user-id', SEED.USER_ALICE);
    expectHandlerNotFound(res, 'View not found');
  });

  test('POST /api/views/:viewId/reconcile resolves to the handler', async () => {
    const res = await request(app)
      .post('/api/views/00000000-0000-0000-0000-000000000000/reconcile')
      .set('x-user-id', SEED.USER_ALICE)
      .send({ linkId: '00000000-0000-0000-0000-000000000000', action: 'keep_mine' });
    expectHandlerNotFound(res, 'View not found');
  });

  test('POST /api/views/:viewId/mark-diverged resolves to the handler', async () => {
    const res = await request(app)
      .post('/api/views/00000000-0000-0000-0000-000000000000/mark-diverged')
      .set('x-user-id', SEED.USER_ALICE)
      .send({ property: 'camera' });
    expectHandlerNotFound(res, 'View not found');
  });

  test('POST /api/views/:viewId/activity resolves to the handler', async () => {
    const res = await request(app)
      .post('/api/views/00000000-0000-0000-0000-000000000000/activity')
      .set('x-user-id', SEED.USER_ALICE)
      .send({ active: true });
    expectHandlerNotFound(res, 'View not found');
  });

  test('GET /api/views/:viewId/is-active resolves to the handler', async () => {
    const res = await request(app)
      .get('/api/views/00000000-0000-0000-0000-000000000000/is-active')
      .set('x-user-id', SEED.USER_ALICE);
    expectHandlerNotFound(res, 'View not found');
  });

  test('CRUD routes at /api/viewgroups are unaffected by the split', async () => {
    const res = await request(app)
      .get('/api/viewgroups/00000000-0000-0000-0000-000000000000')
      .set('x-user-id', SEED.USER_ALICE);
    expectHandlerNotFound(res, 'ViewGroup not found');
  });

  test('unscoped GET /api/viewgroups (no workspaceId or projectId) is rejected with 400, not a data leak', async () => {
    const res = await request(app)
      .get('/api/viewgroups')
      .set('x-user-id', SEED.USER_ALICE);
    expect(res.status).toBe(400);
  });
});

// Full happy-path roundtrip against real fixture rows — proves the
// resolveViewWorkspaceId fix (view_configurations.view_group_id ->
// viewgroups.workspace_id, not the nonexistent vc.canvas_id path the
// original code used) actually resolves a workspace and lets these routes
// succeed end-to-end, not just 404 cleanly on missing data.
integrationDescribe('viewgroups link/reconciliation routes — full roundtrip', pool, () => {
  let app;
  let workspaceId;
  let viewGroupId;
  let sourceViewId;
  let targetViewId;
  let linkId;

  beforeAll(async () => {
    app = createMountTestApp(pool);

    const wsRes = await request(app)
      .get('/api/workspaces/personal')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst');
    workspaceId = wsRes.body.id;
    expect(workspaceId).toBeTruthy();

    const vgRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/viewgroups`)
      .set('x-user-id', SEED.USER_ALICE)
      .send({ name: 'Roundtrip test group' });
    expect(vgRes.status).toBe(201);
    viewGroupId = vgRes.body.id;

    const viewRows = await pool.query(
      `INSERT INTO view_configurations (project_id, view_group_id, name, owner_user_id)
       VALUES ($1, $2, 'Source view', $3), ($1, $2, 'Target view', $3)
       RETURNING id`,
      [SEED.PROJECT_ID, viewGroupId, SEED.USER_ALICE]
    );
    [sourceViewId, targetViewId] = viewRows.rows.map((r) => r.id);
  });

  afterAll(async () => {
    if (sourceViewId || targetViewId) {
      await pool.query('DELETE FROM view_configurations WHERE id = ANY($1::uuid[])', [
        [sourceViewId, targetViewId].filter(Boolean),
      ]);
    }
    if (viewGroupId) await pool.query('DELETE FROM viewgroups WHERE id = $1', [viewGroupId]);
  });

  test('creates a view-to-view link', async () => {
    const res = await request(app)
      .post('/api/links/view')
      .set('x-user-id', SEED.USER_ALICE)
      .send({ sourceViewId, targetViewId, property: 'camera', mode: 'follow' });

    expect(res.status).toBe(201);
    expect(res.body.link.sourceViewId).toBe(sourceViewId);
    expect(res.body.link.targetViewId).toBe(targetViewId);
    linkId = res.body.link.id;
  });

  test('PATCH updates the link mode', async () => {
    const res = await request(app)
      .patch(`/api/links/view/${linkId}`)
      .set('x-user-id', SEED.USER_ALICE)
      .send({ mode: 'sync' });

    expect(res.status).toBe(200);
    expect(res.body.link.mode).toBe('sync');

    // Restore 'follow' — the mark-diverged test below only marks 'follow'
    // links as diverged (mirrors real app semantics: you can't diverge from
    // a leader you're not following), and later tests in this suite expect
    // that mode.
    const restoreRes = await request(app)
      .patch(`/api/links/view/${linkId}`)
      .set('x-user-id', SEED.USER_ALICE)
      .send({ mode: 'follow' });
    expect(restoreRes.status).toBe(200);
  });

  test('mark-diverged then reconciliation-status reports it, then reconcile clears it', async () => {
    const markRes = await request(app)
      .post(`/api/views/${sourceViewId}/mark-diverged`)
      .set('x-user-id', SEED.USER_ALICE)
      .send({ property: 'camera' });
    expect(markRes.status).toBe(200);

    const statusRes = await request(app)
      .get(`/api/views/${sourceViewId}/reconciliation-status`)
      .set('x-user-id', SEED.USER_ALICE);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.needsReconciliation).toBe(true);
    expect(statusRes.body.divergedLinks).toHaveLength(1);
    expect(statusRes.body.divergedLinks[0].linkId).toBe(linkId);

    const reconcileRes = await request(app)
      .post(`/api/views/${sourceViewId}/reconcile`)
      .set('x-user-id', SEED.USER_ALICE)
      .send({ linkId, action: 'sync_to_leader' });
    expect(reconcileRes.status).toBe(200);

    const statusAfter = await request(app)
      .get(`/api/views/${sourceViewId}/reconciliation-status`)
      .set('x-user-id', SEED.USER_ALICE);
    expect(statusAfter.body.needsReconciliation).toBe(false);
  });

  test('reconcile rejects a linkId that does not belong to the given viewId', async () => {
    const res = await request(app)
      .post(`/api/views/${targetViewId}/reconcile`) // linkId belongs to sourceViewId, not targetViewId
      .set('x-user-id', SEED.USER_ALICE)
      .send({ linkId, action: 'keep_mine' });
    expect(res.status).toBe(404);
  });

  test('activity + is-active roundtrip', async () => {
    const startRes = await request(app)
      .post(`/api/views/${sourceViewId}/activity`)
      .set('x-user-id', SEED.USER_ALICE)
      .send({ active: true });
    expect(startRes.status).toBe(200);

    const isActiveRes = await request(app)
      .get(`/api/views/${sourceViewId}/is-active`)
      .set('x-user-id', SEED.USER_ALICE);
    expect(isActiveRes.status).toBe(200);
    expect(isActiveRes.body.isActive).toBe(true);
  });

  test('DELETE removes the view-to-view link', async () => {
    const res = await request(app)
      .delete(`/api/links/view/${linkId}`)
      .set('x-user-id', SEED.USER_ALICE);
    expect(res.status).toBe(204);
  });
});
