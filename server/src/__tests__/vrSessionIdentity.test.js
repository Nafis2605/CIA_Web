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
  let roomId;
  const createdSessionIds = [];

  beforeAll(async () => {
    process.env.DEV_BYPASS_AUTH = 'true';
    process.env.NODE_ENV = 'development';
    app = createVrTestApp(pool);

    // Room scoping (021_vr_session_room_scope.sql / Phase A) — POST
    // /sessions now requires roomId. The seeded project's public Main Room
    // works for both Alice and Bob (SEED project_members) without needing
    // any room_members rows of its own.
    const room = await pool.query(
      `SELECT id FROM rooms WHERE project_id = $1 AND is_main = true`,
      [SEED.PROJECT_ID]
    );
    roomId = room.rows[0].id;
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
      .send({ projectId: SEED.PROJECT_ID, roomId });
    expect(res.status).toBe(200);
    createdSessionIds.push(res.body.id);
    return res.body;
  }

  test('POST /sessions sets owner_user_id from verified identity, not a raw header echo', async () => {
    const session = await createSession(SEED.USER_ALICE, 'Alice');
    expect(session.owner_user_id).toBe(SEED.USER_ALICE);
    expect(session.owner_user_name).toBe('Alice');
  });

  // Issue 5 (device-grained host identity): owner_user_id alone cannot tell
  // two devices signed into the SAME account apart. owner_participant_id
  // (021_vr_session_room_scope.sql) is the accountUserId#deviceId composite
  // that VRExplorationManager's resolveServerSessionOwnerId prefers — these
  // two tests confirm the server actually populates and returns it, on both
  // the create and the join response, which is the entire premise the
  // client-side fix depends on.
  test('POST /sessions sets owner_participant_id from the composite account+device id', async () => {
    const res = await request(app)
      .post('/api/vr/sessions')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ projectId: SEED.PROJECT_ID, roomId, deviceId: 'device-alice-headset' });
    expect(res.status).toBe(200);
    createdSessionIds.push(res.body.id);

    expect(res.body.owner_participant_id).toBe(`${SEED.USER_ALICE}#device-alice-headset`);
    // Still present and unchanged — owner_participant_id is additive, not a
    // replacement.
    expect(res.body.owner_user_id).toBe(SEED.USER_ALICE);
  });

  test('POST /sessions/:id/join: the join response\'s embedded session carries owner_participant_id too', async () => {
    const created = await request(app)
      .post('/api/vr/sessions')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ projectId: SEED.PROJECT_ID, roomId, deviceId: 'device-alice-headset' });
    expect(created.status).toBe(200);
    createdSessionIds.push(created.body.id);

    // A second device on the SAME account joins — the scenario the whole fix
    // exists for. The join response's `session` field is the raw row (see
    // vr.js's join contract comment), so it must carry the SAME
    // owner_participant_id the create response did, identifying device A
    // (not device B, the joiner) as host.
    const join = await request(app)
      .post(`/api/vr/sessions/${created.body.id}/join`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice')
      .send({ mode: 'vr-explorer', deviceId: 'device-alice-laptop' });

    expect(join.status).toBe(200);
    expect(join.body.session.owner_participant_id).toBe(
      `${SEED.USER_ALICE}#device-alice-headset`
    );
    expect(join.body.session.owner_participant_id).not.toBe(
      join.body.participant.participantId
    );
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

    // Phase B join response contract nests participant fields under
    // `participant` (see vr.js's POST /sessions/:id/join contract comment)
    // and no longer echoes account_user_id there at all — that check moves
    // to the full participant rows fetched via GET below.
    expect(join1.body.participant.participantId).not.toBe(join2.body.participant.participantId);

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
    expect(second.body.participant.mode).toBe('vr-explorer');

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
