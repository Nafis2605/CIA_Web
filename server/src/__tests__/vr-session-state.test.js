// server/src/__tests__/vr-session-state.test.js
// Phase C of the VR room-scoping/join-correctness plan: buildSessionState()
// and GET /vr/sessions/:id/state — the authoritative visualization/time/
// camera snapshot a joiner applies BEFORE replaying Y.js (see
// src/collaboration/yjs/__tests__/yjsObservers.replay.test.js for the client
// side of that ordering).
//
// Integration tests — require TEST_DATABASE_URL, DB-gated auto-skip.
// UNVERIFIED: Docker/Postgres was not available while this file was written,
// so these tests have not actually been run against a live database.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vr-session-state" --runInBand

'use strict';

const request = require('supertest');
const { createTestPool, SEED } = require('./helpers/dbFixture');
const { createTestApp } = require('./helpers/testApp');

const pool = createTestPool();
const maybeDescribe = pool ? describe : describe.skip;

const SYSTEM_ORG_ID = '00000000-0000-0000-0000-000000000000';

function aliceHeaders() {
  return { 'x-user-id': SEED.USER_ALICE, 'x-user-name': 'Alice' };
}
function bobHeaders() {
  return { 'x-user-id': SEED.USER_BOB, 'x-user-name': 'Bob' };
}

maybeDescribe('buildSessionState() / GET /api/vr/sessions/:id/state (Phase C)', () => {
  let app;
  let projectId;
  let roomId;
  let datasetId;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_BYPASS_AUTH = 'true';
    app = createTestApp(pool);

    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, $2, $3, 'private', $4)
       RETURNING id`,
      [SYSTEM_ORG_ID, `VR Session State Test ${Date.now()}`, `vr-session-state-test-${Date.now()}`, SEED.USER_ADMIN]
    );
    projectId = proj.rows[0].id;

    for (const userId of [SEED.USER_ALICE, SEED.USER_BOB]) {
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [projectId, userId]
      );
    }

    const main = await pool.query(
      `SELECT id FROM rooms WHERE project_id = $1 AND is_main = true`,
      [projectId]
    );
    roomId = main.rows[0].id;

    const ds = await pool.query(
      `INSERT INTO datasets (organization_id, filename, file_type, file_size, status)
       VALUES ($1, 'session-state-test.vtp', 'vtp', 100, 'ready')
       RETURNING id`,
      [SYSTEM_ORG_ID]
    );
    datasetId = ds.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM datasets WHERE id = $1`, [datasetId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  async function createSession(overrides = {}) {
    const res = await request(app)
      .post('/api/vr/sessions')
      .set(aliceHeaders())
      .send({ projectId, roomId, deviceId: 'alice-dev', ...overrides });
    expect(res.status).toBe(200);
    return res.body;
  }

  test('a session with no view_configuration_id returns revision 0 and null visualization', async () => {
    const session = await createSession({ deviceId: 'alice-dev-no-view' });
    expect(session.view_configuration_id).toBeNull();

    const res = await request(app)
      .get(`/api/vr/sessions/${session.id}/state`)
      .set(aliceHeaders());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      viewConfigurationId: null,
      revision: 0,
      visualization: null,
      time: null,
      camera: null,
      updatedAt: null,
    });
  });

  test('a view with persisted visualization/time/camera round-trips through GET /state', async () => {
    const visualization = { opacity: 0.6, representation: 'wireframe', pointSize: 4 };
    const time = { currentStep: 3, playing: false };
    const camera = { position: [1, 2, 3], focalPoint: [0, 0, 0] };

    const view = await pool.query(
      `INSERT INTO view_configurations (
         project_id, dataset_id, name, owner_user_id, owner_user_name,
         visualization, time, camera
       ) VALUES ($1, $2, 'Session State View', $3, 'Alice', $4::jsonb, $5::jsonb, $6::jsonb)
       RETURNING id, revision`,
      [projectId, datasetId, SEED.USER_ALICE, JSON.stringify(visualization), JSON.stringify(time), JSON.stringify(camera)]
    );
    const viewConfigurationId = view.rows[0].id;
    const expectedRevision = Number(view.rows[0].revision);

    const session = await createSession({ datasetId, viewConfigurationId, deviceId: 'alice-dev-full-state' });

    const res = await request(app)
      .get(`/api/vr/sessions/${session.id}/state`)
      .set(bobHeaders());

    expect(res.status).toBe(200);
    expect(res.body.viewConfigurationId).toBe(viewConfigurationId);
    expect(res.body.revision).toBe(expectedRevision);
    expect(res.body.visualization).toEqual(visualization);
    expect(res.body.time).toEqual(time);
    expect(res.body.camera).toEqual(camera);
    expect(res.body.updatedAt).toBeTruthy();

    await pool.query(`DELETE FROM view_configurations WHERE id = $1`, [viewConfigurationId]);
  });

  test('builtinDatasetId is stripped from state.visualization but recoverBuiltinDatasetId still resolves it via join', async () => {
    const view = await pool.query(
      `INSERT INTO view_configurations (project_id, dataset_id, name, owner_user_id, owner_user_name, visualization)
       VALUES ($1, NULL, 'Builtin Session State View', $2, 'Alice', $3::jsonb)
       RETURNING id`,
      [projectId, SEED.USER_ALICE, JSON.stringify({ builtinDatasetId: 'builtin-lungs', opacity: 0.8 })]
    );
    const viewConfigurationId = view.rows[0].id;

    const session = await createSession({ datasetId: 'builtin-lungs', viewConfigurationId, deviceId: 'alice-dev-builtin-state' });

    const stateRes = await request(app)
      .get(`/api/vr/sessions/${session.id}/state`)
      .set(bobHeaders());
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.visualization).toEqual({ opacity: 0.8 });
    expect(stateRes.body.visualization.builtinDatasetId).toBeUndefined();

    // The join response embeds the identical object AND still resolves
    // dataset.id from the same column via recoverBuiltinDatasetId — proves
    // the two consumers of view_configurations.visualization don't conflict.
    const joinRes = await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set(bobHeaders())
      .send({ mode: 'desktop-observer', deviceId: 'bob-dev-builtin-state', roomId });
    expect(joinRes.status).toBe(200);
    expect(joinRes.body.dataset).toEqual({ id: 'builtin-lungs', kind: 'builtin', name: 'builtin-lungs' });
    expect(joinRes.body.state.visualization).toEqual({ opacity: 0.8 });

    await pool.query(`DELETE FROM view_configurations WHERE id = $1`, [viewConfigurationId]);
  });

  test('GET /state on an ended session returns 404 session-not-found', async () => {
    const session = await createSession({ deviceId: 'alice-dev-state-end' });
    const end = await request(app)
      .delete(`/api/vr/sessions/${session.id}`)
      .set(aliceHeaders());
    expect(end.status).toBe(200);

    const res = await request(app)
      .get(`/api/vr/sessions/${session.id}/state`)
      .set(bobHeaders());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('session-not-found');
  });

});

// Separate describe block, same reasoning as vr-join-contract.test.js's
// "no credentials at all" block: DEV_BYPASS_AUTH (auth.js) is read into a
// module-level constant at require time, so genuinely exercising the
// non-bypass 401 branch needs jest.resetModules() to force auth.js to
// re-evaluate it — toggling the env var alone after the module is already
// cached (as the main describe block above does) has no effect. Under
// DEV_BYPASS_AUTH with no x-user-id header, getUserId() falls back to the
// default dev user instead of returning null, so this can't be exercised
// from inside that block.
maybeDescribe('GET /api/vr/sessions/:id/state — no credentials at all', () => {
  let app;
  let prevDevBypass;
  let prevNodeEnv;

  beforeAll(() => {
    prevDevBypass = process.env.DEV_BYPASS_AUTH;
    prevNodeEnv = process.env.NODE_ENV;
    process.env.DEV_BYPASS_AUTH = 'false';
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    app = createTestApp(pool, { devBypassAuth: false });
  });

  afterAll(() => {
    process.env.DEV_BYPASS_AUTH = prevDevBypass;
    process.env.NODE_ENV = prevNodeEnv;
    jest.resetModules();
  });

  test('returns 401 auth-required with no Authorization header', async () => {
    const res = await request(app).get('/api/vr/sessions/00000000-0000-0000-0000-00000000dead/state');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth-required');
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
});
