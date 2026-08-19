// server/src/__tests__/vr-join-contract.test.js
// Phase B of the VR room-scoping/join-correctness plan: POST
// /vr/sessions/:id/join returns a structured contract (joined, session,
// participant, dataset, viewConfigurationId, state, lease) instead of the
// bare participant row Phase A left it returning, and documents the error
// codes a joiner needs to distinguish (session-not-found including 'ended',
// desktop-not-allowed, join-disabled) on top of the room-scoping codes A2
// already added (not-a-room-member, cross-room).
//
// Integration tests — require TEST_DATABASE_URL, DB-gated auto-skip.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vr-join-contract" --runInBand

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

maybeDescribe('POST /api/vr/sessions/:id/join — response contract (Phase B)', () => {
  let app;
  let projectId;
  let roomId;
  let datasetId;

  beforeAll(async () => {
    // Same DEV_BYPASS_AUTH + NODE_ENV workaround as vr-room-scope.test.js —
    // see its header comment for why both are required together.
    process.env.NODE_ENV = 'development';
    process.env.DEV_BYPASS_AUTH = 'true';
    app = createTestApp(pool);

    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, $2, $3, 'private', $4)
       RETURNING id`,
      [SYSTEM_ORG_ID, `VR Join Contract Test ${Date.now()}`, `vr-join-contract-test-${Date.now()}`, SEED.USER_ADMIN]
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
       VALUES ($1, 'join-contract-test.vtp', 'vtp', 100, 'ready')
       RETURNING id`,
      [SYSTEM_ORG_ID]
    );
    datasetId = ds.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM datasets WHERE id = $1`, [datasetId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    // pool.end() deferred to the file-level afterAll below — the
    // no-credentials describe block runs after this one and doesn't need a
    // live pool, but ending it here would be needlessly order-dependent.
  });

  async function createSession(overrides = {}) {
    const res = await request(app)
      .post('/api/vr/sessions')
      .set(aliceHeaders())
      .send({ projectId, roomId, deviceId: 'alice-dev', ...overrides });
    expect(res.status).toBe(200);
    return res.body;
  }

  test('a real-dataset session returns dataset:{kind:"server", id, name} and echoes viewConfigurationId', async () => {
    const view = await pool.query(
      `INSERT INTO view_configurations (project_id, dataset_id, name, owner_user_id, owner_user_name)
       VALUES ($1, $2, 'Join Contract View', $3, 'Alice')
       RETURNING id`,
      [projectId, datasetId, SEED.USER_ALICE]
    );
    const viewConfigurationId = view.rows[0].id;

    const session = await createSession({ datasetId, viewConfigurationId });

    const res = await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set(bobHeaders())
      .send({ mode: 'desktop-observer', deviceId: 'bob-dev', roomId });

    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(true);
    expect(res.body.session.id).toBe(session.id);
    expect(res.body.participant).toEqual({
      participantId: `${SEED.USER_BOB}#bob-dev`,
      mode: 'desktop-observer',
      userName: 'Bob',
    });
    expect(res.body.dataset).toEqual({ id: datasetId, kind: 'server', name: 'join-contract-test.vtp' });
    expect(res.body.viewConfigurationId).toBe(viewConfigurationId);
    // Phase C: buildSessionState() embedded — a freshly-created view has no
    // visualization/time/camera written yet, but does carry the schema
    // default revision (1).
    expect(res.body.state).toEqual({
      viewConfigurationId,
      revision: 1,
      visualization: null,
      time: null,
      camera: null,
      updatedAt: expect.any(String),
    });
    // Not built until Phase D lands.
    expect(res.body.lease).toBeNull();

    await pool.query(`DELETE FROM view_configurations WHERE id = $1`, [viewConfigurationId]);
  });

  test('a builtin-dataset session recovers dataset.id from view_configurations.visualization.builtinDatasetId', async () => {
    const view = await pool.query(
      `INSERT INTO view_configurations (project_id, dataset_id, name, owner_user_id, owner_user_name, visualization)
       VALUES ($1, NULL, 'Builtin Join Contract View', $2, 'Alice', $3::jsonb)
       RETURNING id`,
      [projectId, SEED.USER_ALICE, JSON.stringify({ builtinDatasetId: 'builtin-lungs' })]
    );
    const viewConfigurationId = view.rows[0].id;

    // datasetId sent as the non-UUID builtin key — asUuidOrNull() nulls it in
    // the session row itself (POST /sessions — pre-existing Phase A/prior
    // behavior), which is exactly the case this recovery path exists for.
    const session = await createSession({ datasetId: 'builtin-lungs', viewConfigurationId });
    expect(session.dataset_id).toBeNull();

    const res = await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set(bobHeaders())
      .send({ mode: 'desktop-observer', deviceId: 'bob-dev-2', roomId });

    expect(res.status).toBe(200);
    expect(res.body.dataset).toEqual({ id: 'builtin-lungs', kind: 'builtin', name: 'builtin-lungs' });
    // buildSessionState() strips the builtinDatasetId bookkeeping key out of
    // `visualization` — it must never round-trip into a joiner's applied
    // visualization state (see buildSessionState's docstring).
    expect(res.body.state.visualization).toEqual({});
    expect(res.body.state.revision).toBe(1);

    await pool.query(`DELETE FROM view_configurations WHERE id = $1`, [viewConfigurationId]);
  });

  test('joining an ended session returns 404 session-not-found, not the generic "not found"', async () => {
    const session = await createSession({ deviceId: 'alice-dev-end' });
    const end = await request(app)
      .delete(`/api/vr/sessions/${session.id}`)
      .set(aliceHeaders());
    expect(end.status).toBe(200);

    const res = await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set(bobHeaders())
      .send({ mode: 'desktop-observer', deviceId: 'bob-dev-3', roomId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('session-not-found');
  });

  test('a nonexistent session id returns 404 session-not-found', async () => {
    const res = await request(app)
      .post('/api/vr/sessions/00000000-0000-0000-0000-00000000dead/join')
      .set(bobHeaders())
      .send({ mode: 'desktop-observer', deviceId: 'bob-dev-4', roomId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('session-not-found');
  });

  test('joining a session with allow_join=false returns 409 join-disabled', async () => {
    const create = await request(app)
      .post('/api/vr/sessions')
      .set(aliceHeaders())
      .send({ projectId, roomId, deviceId: 'alice-dev-join-off', allowJoin: false });
    expect(create.status).toBe(200);
    expect(create.body.allow_join).toBe(false);

    const res = await request(app)
      .post(`/api/vr/sessions/${create.body.id}/join`)
      .set(bobHeaders())
      .send({ mode: 'desktop-observer', deviceId: 'bob-dev-5', roomId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('join-disabled');
  });

  test('a desktop-participant join when allow_desktop_participants=false returns 403 desktop-not-allowed', async () => {
    const create = await request(app)
      .post('/api/vr/sessions')
      .set(aliceHeaders())
      .send({ projectId, roomId, deviceId: 'alice-dev-desktop-off', allowDesktopParticipants: false });
    expect(create.status).toBe(200);
    expect(create.body.allow_desktop_participants).toBe(false);

    const res = await request(app)
      .post(`/api/vr/sessions/${create.body.id}/join`)
      .set(bobHeaders())
      .send({ mode: 'desktop-participant', deviceId: 'bob-dev-6', roomId });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('desktop-not-allowed');
  });

});

// Separate describe block, same reasoning as vrSessionIdentity.test.js's
// "no credentials at all" block: DEV_BYPASS_AUTH (auth.js) is read into a
// module-level constant at require time, so genuinely exercising the
// non-bypass branch needs jest.resetModules() to force auth.js to
// re-evaluate it against env vars set beforehand — toggling the env var
// alone after the module is already cached (as the main describe block
// above does, via createTestApp) has no effect.
maybeDescribe('POST /api/vr/sessions/:id/join — no credentials at all', () => {
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
    const res = await request(app)
      .post('/api/vr/sessions/00000000-0000-0000-0000-00000000dead/join')
      .send({ mode: 'desktop-observer' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth-required');
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
});
