// server/src/__tests__/vr-session-lifecycle.test.js
// Issue 6 of Round 2 (session lifecycle): nothing previously transitioned a
// session past 'preparing', nothing ended it when the last participant left,
// and a losing client in the create-race never cleaned up its own orphaned
// row — GET /sessions listed every session ever created. This exercises the
// three pieces that fix that: the (room, dataset_sync_key) unique index +
// create-race adoption on POST /sessions, POST /sessions/:id/heartbeat's
// 'preparing' -> 'active' transition, POST /sessions/:id/leave's
// last-participant-ends-session transaction, and reapStaleVrSessions()'s
// lazy expiry.
//
// Integration tests — require TEST_DATABASE_URL, DB-gated auto-skip.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vr-session-lifecycle" --runInBand

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

maybeDescribe('VR sessions — lifecycle (Issue 6)', () => {
  let app;
  let projectId;
  let roomId;

  beforeAll(async () => {
    // Same NODE_ENV/DEV_BYPASS_AUTH combination requirement as
    // vr-room-scope.test.js / vr-lease.test.js — DEV_BYPASS_AUTH alone is
    // not enough under Jest's default NODE_ENV=test.
    process.env.NODE_ENV = 'development';
    process.env.DEV_BYPASS_AUTH = 'true';
    app = createTestApp(pool);

    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, $2, $3, 'private', $4)
       RETURNING id`,
      [SYSTEM_ORG_ID, `VR Lifecycle Test ${Date.now()}`, `vr-lifecycle-test-${Date.now()}`, SEED.USER_ADMIN]
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
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await pool.end();
  });

  async function createSession(headers, deviceId, extra = {}) {
    return request(app)
      .post('/api/vr/sessions')
      .set(headers)
      .send({ projectId, roomId, deviceId, ...extra });
  }

  describe('POST /sessions — one active session per (room, dataset)', () => {
    test('two creates with the same datasetSyncKey: the second adopts the first, one row total', async () => {
      const datasetSyncKey = `ds-adopt-${Date.now()}`;

      const first = await createSession(aliceHeaders(), 'alice-dev-1', { datasetSyncKey });
      expect(first.status).toBe(200);
      expect(first.body.adopted).toBeFalsy();

      const second = await createSession(bobHeaders(), 'bob-dev-1', { datasetSyncKey });
      expect(second.status).toBe(200);
      expect(second.body.adopted).toBe(true);
      expect(second.body.id).toBe(first.body.id);

      const rows = await pool.query(
        `SELECT id, status FROM vr_exploration_sessions
          WHERE room_id = $1 AND dataset_sync_key = $2 AND status <> 'ended'`,
        [roomId, datasetSyncKey]
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].id).toBe(first.body.id);

      // Bob's adoption upserted him as a participant on the WINNING row.
      const participants = await pool.query(
        `SELECT participant_id FROM vr_session_participants WHERE session_id = $1`,
        [first.body.id]
      );
      expect(participants.rows.map((r) => r.participant_id)).toContain(`${SEED.USER_BOB}#bob-dev-1`);
    });

    test('two creates with different datasetSyncKeys both succeed as separate rows', async () => {
      const keyA = `ds-distinct-a-${Date.now()}`;
      const keyB = `ds-distinct-b-${Date.now()}`;

      const first = await createSession(aliceHeaders(), 'alice-dev-2', { datasetSyncKey: keyA });
      const second = await createSession(aliceHeaders(), 'alice-dev-3', { datasetSyncKey: keyB });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.adopted).toBeFalsy();
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe('POST /sessions/:id/heartbeat', () => {
    test("flips 'preparing' -> 'active' for the owner device, but not for a joiner", async () => {
      const datasetSyncKey = `ds-heartbeat-${Date.now()}`;
      const created = await createSession(aliceHeaders(), 'alice-owner-dev', { datasetSyncKey });
      expect(created.status).toBe(200);
      expect(created.body.status).toBe('preparing');
      const sessionId = created.body.id;

      const join = await request(app)
        .post(`/api/vr/sessions/${sessionId}/join`)
        .set(bobHeaders())
        .send({ mode: 'vr-explorer', deviceId: 'bob-joiner-dev', roomId });
      expect(join.status).toBe(200);

      // The joiner's heartbeat must NOT flip status.
      const joinerHeartbeat = await request(app)
        .post(`/api/vr/sessions/${sessionId}/heartbeat`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-joiner-dev' });
      expect(joinerHeartbeat.status).toBe(200);
      expect(joinerHeartbeat.body.status).toBe('preparing');

      // The owner DEVICE's heartbeat (matching owner_participant_id exactly
      // — Issue 5's device grain) performs the transition.
      const ownerHeartbeat = await request(app)
        .post(`/api/vr/sessions/${sessionId}/heartbeat`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-owner-dev' });
      expect(ownerHeartbeat.status).toBe(200);
      expect(ownerHeartbeat.body.status).toBe('active');
      expect(ownerHeartbeat.body.lastHeartbeatAt).toBeTruthy();

      const row = await pool.query(`SELECT status FROM vr_exploration_sessions WHERE id = $1`, [sessionId]);
      expect(row.rows[0].status).toBe('active');
    });

    test('404s a session that does not exist', async () => {
      const res = await request(app)
        .post(`/api/vr/sessions/00000000-0000-0000-0000-000000000099/heartbeat`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-owner-dev' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /sessions/:id/leave — last participant ends the session', () => {
    test('the last participant leaving ends the session (status=ended, sessionEnded:true)', async () => {
      const datasetSyncKey = `ds-leave-${Date.now()}`;
      const created = await createSession(aliceHeaders(), 'alice-solo-dev', { datasetSyncKey });
      expect(created.status).toBe(200);
      const sessionId = created.body.id;

      const leave = await request(app)
        .post(`/api/vr/sessions/${sessionId}/leave`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-solo-dev' });

      expect(leave.status).toBe(200);
      expect(leave.body.success).toBe(true);
      expect(leave.body.sessionEnded).toBe(true);

      const row = await pool.query(
        `SELECT status, ended_at FROM vr_exploration_sessions WHERE id = $1`,
        [sessionId]
      );
      expect(row.rows[0].status).toBe('ended');
      expect(row.rows[0].ended_at).toBeTruthy();
    });

    test('leaving with other participants still present does not end the session', async () => {
      const datasetSyncKey = `ds-leave-multi-${Date.now()}`;
      const created = await createSession(aliceHeaders(), 'alice-multi-dev', { datasetSyncKey });
      const sessionId = created.body.id;

      await request(app)
        .post(`/api/vr/sessions/${sessionId}/join`)
        .set(bobHeaders())
        .send({ mode: 'vr-explorer', deviceId: 'bob-multi-dev', roomId });

      const leave = await request(app)
        .post(`/api/vr/sessions/${sessionId}/leave`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-multi-dev' });

      expect(leave.status).toBe(200);
      expect(leave.body.sessionEnded).toBe(false);

      const row = await pool.query(`SELECT status FROM vr_exploration_sessions WHERE id = $1`, [sessionId]);
      expect(row.rows[0].status).not.toBe('ended');

      // Clean up the remaining participant so this session doesn't affect
      // other tests' room-wide GET /sessions listings.
      await request(app)
        .post(`/api/vr/sessions/${sessionId}/leave`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-multi-dev' });
    });
  });

  describe('lazy expiry — reapStaleVrSessions', () => {
    test('a session aged past the staleness threshold vanishes from GET /sessions and is ended in the DB', async () => {
      const datasetSyncKey = `ds-stale-${Date.now()}`;
      const created = await createSession(aliceHeaders(), 'alice-stale-dev', { datasetSyncKey });
      expect(created.status).toBe(200);
      const sessionId = created.body.id;

      // Deterministic stand-in for "wait past the reap threshold" — ages the
      // row directly rather than sleeping in the test (slow and flaky at
      // real thresholds of 90s/120s). 5 minutes clears BOTH the 'preparing'
      // (90s) and 'active' (120s) thresholds regardless of which state this
      // row is in.
      await pool.query(
        `UPDATE vr_exploration_sessions SET created_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
        [sessionId]
      );

      const list = await request(app)
        .get(`/api/vr/sessions?roomId=${roomId}`)
        .set(aliceHeaders());
      expect(list.status).toBe(200);
      expect(list.body.map((s) => s.id)).not.toContain(sessionId);

      const row = await pool.query(
        `SELECT status, ended_at FROM vr_exploration_sessions WHERE id = $1`,
        [sessionId]
      );
      expect(row.rows[0].status).toBe('ended');
      expect(row.rows[0].ended_at).toBeTruthy();
    });

    test('joining a reaped (zombie) session 404s honestly instead of attaching to a dead session', async () => {
      const datasetSyncKey = `ds-stale-join-${Date.now()}`;
      const created = await createSession(aliceHeaders(), 'alice-stale-join-dev', { datasetSyncKey });
      const sessionId = created.body.id;

      await pool.query(
        `UPDATE vr_exploration_sessions SET created_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
        [sessionId]
      );

      const join = await request(app)
        .post(`/api/vr/sessions/${sessionId}/join`)
        .set(bobHeaders())
        .send({ mode: 'desktop-observer', deviceId: 'bob-stale-join-dev', roomId });

      expect(join.status).toBe(404);
      expect(join.body.error).toBe('session-not-found');
    });
  });
});
