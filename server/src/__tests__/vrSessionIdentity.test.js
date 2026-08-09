// server/src/__tests__/vrSessionIdentity.test.js
// Tests for H1 (verified identity, not x-user-id/x-user-name headers as
// owner/creator identity) and H2 (per-device participant rows) on
// server/src/routes/vr.js. Integration tests — require TEST_DATABASE_URL.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vrSessionIdentity" --runInBand

'use strict';

const request = require('supertest');
const express = require('express');
const { createTestPool, SEED } = require('./helpers/dbFixture');

const pool = createTestPool();
const maybeDescribe = pool ? describe : describe.skip;

// Mounts with optionalAuth, matching the real production mount
// (server/src/index.js: app.use("/api/vr", optionalAuth, vrRouter)).
function createVrTestApp(pool) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;

  const { optionalAuth } = require('../middleware/auth');
  const vrRouter = require('../routes/vr');
  app.use('/api/vr', optionalAuth, vrRouter);
  return app;
}

maybeDescribe('VR session identity (H1 + H2)', () => {
  let app;
  const createdSessionIds = [];

  beforeAll(() => {
    process.env.DEV_BYPASS_AUTH = 'true';
    process.env.NODE_ENV = 'development';
    app = createVrTestApp(pool);
  });

  afterAll(async () => {
    if (!pool) return;
    if (createdSessionIds.length) {
      await pool.query(
        `DELETE FROM vr_exploration_sessions WHERE id = ANY($1::uuid[])`,
        [createdSessionIds]
      );
    }
  });

  async function createSession(userId, userName) {
    const res = await request(app)
      .post('/api/vr/sessions')
      .set('x-user-id', userId)
      .set('x-user-name', userName)
      .send({ projectId: SEED.PROJECT_ID });
    expect(res.status).toBe(200);
    createdSessionIds.push(res.body.id);
    return res.body;
  }

  test('POST /sessions sets owner_user_id from verified identity, not a raw header echo', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');
    expect(session.owner_user_id).toBe(SEED.USER_ALICE);
    expect(session.owner_user_name).toBe('Alice');
  });

  test('PUT /sessions/:id: a caller cannot spoof ownership via x-user-id to bypass the owner check', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');

    // Bob is a different verified identity — must be rejected regardless of
    // what he claims via headers.
    const res = await request(app)
      .put(`/api/vr/sessions/${session.id}`)
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob')
      .send({ status: 'active' });

    expect(res.status).toBe(403);
  });

  test('DELETE /sessions/:id: non-owner is rejected', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');

    const res = await request(app)
      .delete(`/api/vr/sessions/${session.id}`)
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob');

    expect(res.status).toBe(403);
  });

  test('DELETE /sessions/:id: the real owner succeeds', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');

    const res = await request(app)
      .delete(`/api/vr/sessions/${session.id}`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice');

    expect(res.status).toBe(200);
  });

  test('POST /sessions/:id/join: two devices on the same account produce two participant rows', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');

    const join1 = await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer', deviceId: 'device-desktop' });
    expect(join1.status).toBe(200);

    const join2 = await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer', deviceId: 'device-visionpro' });
    expect(join2.status).toBe(200);

    expect(join1.body.participant_id).not.toBe(join2.body.participant_id);
    expect(join1.body.account_user_id).toBe(SEED.USER_ALICE);
    expect(join2.body.account_user_id).toBe(SEED.USER_ALICE);

    const detail = await request(app)
      .get(`/api/vr/sessions/${session.id}`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice');

    // Owner-as-first-participant (from creation) + the two joins above.
    const aliceRows = detail.body.participants.filter(
      (p) => p.account_user_id === SEED.USER_ALICE
    );
    expect(aliceRows.length).toBe(3);
  });

  test('POST /sessions/:id/join: same account+device joining twice upserts, does not duplicate', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');

    await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'desktop-observer', deviceId: 'device-desktop' });

    const second = await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer', deviceId: 'device-desktop' });
    expect(second.status).toBe(200);
    expect(second.body.mode).toBe('vr-explorer');

    const detail = await request(app)
      .get(`/api/vr/sessions/${session.id}`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice');
    const deviceRows = detail.body.participants.filter(
      (p) => p.participant_id === `${SEED.USER_ALICE}#device-desktop`
    );
    expect(deviceRows.length).toBe(1);
  });

  test('POST /sessions/:id/leave only removes the calling device\'s participant row', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');

    await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer', deviceId: 'device-desktop' });
    await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer', deviceId: 'device-visionpro' });

    const leave = await request(app)
      .post(`/api/vr/sessions/${session.id}/leave`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ deviceId: 'device-desktop' });
    expect(leave.status).toBe(200);

    const detail = await request(app)
      .get(`/api/vr/sessions/${session.id}`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice');
    const remaining = detail.body.participants.map((p) => p.participant_id);
    expect(remaining).not.toContain(`${SEED.USER_ALICE}#device-desktop`);
    expect(remaining).toContain(`${SEED.USER_ALICE}#device-visionpro`);
  });

  test('PUT /sessions/:id/participants/:participantId: caller cannot modify another participant', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');
    await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob')
      .send({ mode: 'desktop-observer', deviceId: 'device-bob' });

    const res = await request(app)
      .put(`/api/vr/sessions/${session.id}/participants/${SEED.USER_BOB}%23device-bob`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer' });

    expect(res.status).toBe(403);
  });

  test('PUT /sessions/:id/participants/:participantId: caller can modify their own device row', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');
    await request(app)
      .post(`/api/vr/sessions/${session.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'desktop-observer', deviceId: 'device-desktop' });

    const res = await request(app)
      .put(`/api/vr/sessions/${session.id}/participants/${SEED.USER_ALICE}%23device-desktop`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('vr-explorer');
  });
});

// Separate describe block: needs DEV_BYPASS_AUTH genuinely off to exercise
// optionalAuth's real (non-dev-bypass) branch, where an unauthenticated
// request correctly resolves req.user = null. No DB row is needed — every
// one of these routes now returns 401 before ever querying the DB.
maybeDescribe('VR session identity (no credentials at all)', () => {
  let app;
  let prevDevBypass;
  let prevNodeEnv;

  beforeAll(() => {
    prevDevBypass = process.env.DEV_BYPASS_AUTH;
    prevNodeEnv = process.env.NODE_ENV;
    process.env.DEV_BYPASS_AUTH = 'false';
    process.env.NODE_ENV = 'production';
    jest.resetModules();

    app = createVrTestApp(pool);
  });

  afterAll(() => {
    process.env.DEV_BYPASS_AUTH = prevDevBypass;
    process.env.NODE_ENV = prevNodeEnv;
    jest.resetModules();
  });

  test('POST /sessions returns 401 with no Authorization header', async () => {
    const res = await request(app).post('/api/vr/sessions').send({ projectId: SEED.PROJECT_ID });
    expect(res.status).toBe(401);
  });

  test('POST /sessions/:id/join returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/api/vr/sessions/00000000-0000-0000-0000-00000000dead/join')
      .send({ mode: 'vr-explorer' });
    expect(res.status).toBe(401);
  });

  test('POST /sessions/:id/leave returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/api/vr/sessions/00000000-0000-0000-0000-00000000dead/leave')
      .send({});
    expect(res.status).toBe(401);
  });

  test('PUT /sessions/:id returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .put('/api/vr/sessions/00000000-0000-0000-0000-00000000dead')
      .send({ status: 'active' });
    expect(res.status).toBe(401);
  });

  test('DELETE /sessions/:id returns 401 with no Authorization header', async () => {
    const res = await request(app).delete(
      '/api/vr/sessions/00000000-0000-0000-0000-00000000dead'
    );
    expect(res.status).toBe(401);
  });

  test('POST /sessions/:id/snapshots returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/api/vr/sessions/00000000-0000-0000-0000-00000000dead/snapshots')
      .send({});
    expect(res.status).toBe(401);
  });

  test('PUT /sessions/:id/participants/:participantId returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .put('/api/vr/sessions/00000000-0000-0000-0000-00000000dead/participants/anyone')
      .send({ mode: 'vr-explorer' });
    expect(res.status).toBe(401);
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
});
