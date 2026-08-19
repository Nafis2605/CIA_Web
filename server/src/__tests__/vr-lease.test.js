// server/src/__tests__/vr-lease.test.js
// Phase D1/D2 of the room-scoping/join-correctness/manipulation-authority
// plan: the manipulation lease is five columns on vr_exploration_sessions
// (022_vr_manipulation_lease.sql) plus four routes in server/src/routes/vr.js
// — POST .../lease (acquire/refresh), POST .../lease/heartbeat, DELETE
// .../lease (release), POST .../lease/grant (force-transfer). lease_epoch is
// the fencing token that stops a preempted holder from extending a lease
// that is no longer theirs.
//
// Integration tests — require TEST_DATABASE_URL, DB-gated auto-skip.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vr-lease" --runInBand

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

maybeDescribe('VR sessions — manipulation lease (Phase D1/D2)', () => {
  let app;
  let projectId;
  let roomId;

  beforeAll(async () => {
    // Same NODE_ENV/DEV_BYPASS_AUTH combination requirement as
    // vr-room-scope.test.js and roomMembership.test.js — DEV_BYPASS_AUTH
    // alone is not enough under Jest's default NODE_ENV=test.
    process.env.NODE_ENV = 'development';
    process.env.DEV_BYPASS_AUTH = 'true';
    app = createTestApp(pool);

    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, $2, $3, 'private', $4)
       RETURNING id`,
      [SYSTEM_ORG_ID, `VR Lease Test ${Date.now()}`, `vr-lease-test-${Date.now()}`, SEED.USER_ADMIN]
    );
    projectId = proj.rows[0].id;

    for (const userId of [SEED.USER_ALICE, SEED.USER_BOB]) {
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [projectId, userId]
      );
    }

    // The project's creation trigger already inserted a public Main Room;
    // Alice and Bob get access to it via "public room + project member",
    // same as vr-room-scope.test.js.
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

  async function createSession(ownerHeaders, deviceId, extra = {}) {
    const res = await request(app)
      .post('/api/vr/sessions')
      .set(ownerHeaders)
      .send({ projectId, roomId, deviceId, ...extra });
    expect(res.status).toBe(200);
    return res.body;
  }

  async function joinSession(sessionId, headers, mode, deviceId) {
    const res = await request(app)
      .post(`/api/vr/sessions/${sessionId}/join`)
      .set(headers)
      .send({ mode, deviceId, roomId });
    expect(res.status).toBe(200);
    return res.body;
  }

  // Deterministic stand-in for "wait past ttlMs" — writes lease_expires_at
  // directly into the past rather than sleeping in the test, which would be
  // both slow and (at short TTLs) flaky.
  async function forceExpireLease(sessionId) {
    await pool.query(
      `UPDATE vr_exploration_sessions SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [sessionId]
    );
  }

  describe('POST /sessions/:id/lease — acquire', () => {
    test('two concurrent acquires against an unheld lease: exactly one 200, one 409', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev1');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-a');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-a');

      const [aliceRes, bobRes] = await Promise.all([
        request(app)
          .post(`/api/vr/sessions/${session.id}/lease`)
          .set(aliceHeaders())
          .send({ deviceId: 'alice-dev-a' }),
        request(app)
          .post(`/api/vr/sessions/${session.id}/lease`)
          .set(bobHeaders())
          .send({ deviceId: 'bob-dev-a' }),
      ]);

      const statuses = [aliceRes.status, bobRes.status].sort();
      expect(statuses).toEqual([200, 409]);

      const winner = aliceRes.status === 200 ? aliceRes : bobRes;
      const loser = aliceRes.status === 200 ? bobRes : aliceRes;

      expect(winner.body.epoch).toBe(1);
      expect(winner.body.revision).toBe(1);
      expect(loser.body.error).toBe('lease-held');
      expect(loser.body.holder.participantId).toBe(winner.body.holder.participantId);
    });

    test('the current holder re-acquiring (refresh) succeeds and bumps the epoch', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev2');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-b');

      const first = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-b' });
      expect(first.status).toBe(200);
      expect(first.body.epoch).toBe(1);

      const second = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-b' });
      expect(second.status).toBe(200);
      expect(second.body.epoch).toBe(2);
    });

    test('an expired lease is reclaimable by a second participant', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev3');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-c');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-c');

      const acquired = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-c' });
      expect(acquired.status).toBe(200);

      await forceExpireLease(session.id);

      const reclaimed = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-dev-c' });
      expect(reclaimed.status).toBe(200);
      expect(reclaimed.body.holder.participantId).toBe(`${SEED.USER_BOB}#bob-dev-c`);
      expect(reclaimed.body.epoch).toBe(2);
    });

    test('allow_desktop_control=false denies a desktop-mode participant with 403', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev4', {
        allowDesktopControl: false,
      });
      await joinSession(session.id, bobHeaders(), 'desktop-participant', 'bob-desktop-dev');

      const res = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-desktop-dev' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('desktop-control-disabled');
    });

    test('allow_desktop_control=true allows a desktop-mode participant to acquire', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev5', {
        allowDesktopControl: true,
      });
      await joinSession(session.id, bobHeaders(), 'desktop-participant', 'bob-desktop-dev2');

      const res = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-desktop-dev2' });

      expect(res.status).toBe(200);
    });

    test('a vr-explorer participant is unaffected by allow_desktop_control=false', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev6', {
        allowDesktopControl: false,
      });
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-vr-dev');

      const res = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-vr-dev' });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /sessions/:id/lease/heartbeat', () => {
    test('heartbeat with a stale epoch returns 409 lease-lost', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev7');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-d');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-d');

      const acquired = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-d' });
      expect(acquired.status).toBe(200);
      const staleEpoch = acquired.body.epoch;

      // Bob preempts by force-expiring and re-acquiring — a real client
      // would instead just wait out the TTL, but forcing it keeps the test
      // fast and deterministic. This bumps lease_epoch, which is the whole
      // point: Alice's next heartbeat must be rejected because it still
      // carries the pre-preemption epoch.
      await forceExpireLease(session.id);
      const preempt = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-dev-d' });
      expect(preempt.status).toBe(200);
      expect(preempt.body.epoch).toBe(staleEpoch + 1);

      const heartbeat = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease/heartbeat`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-d', epoch: staleEpoch });

      expect(heartbeat.status).toBe(409);
      expect(heartbeat.body.error).toBe('lease-lost');
    });

    test('heartbeat with the current epoch extends the lease and returns 200', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev8');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-e');

      const acquired = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-e' });
      expect(acquired.status).toBe(200);

      const heartbeat = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease/heartbeat`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-e', epoch: acquired.body.epoch });

      expect(heartbeat.status).toBe(200);
      expect(heartbeat.body.epoch).toBe(acquired.body.epoch);
      expect(new Date(heartbeat.body.expiresAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe('DELETE /sessions/:id/lease — release', () => {
    test('a participant who is neither holder nor owner cannot release', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev9');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-f');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-f');

      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-f' });

      const res = await request(app)
        .delete(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-dev-f' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('lease-release-forbidden');
    });

    test('the current holder can release their own lease', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev10');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-g');
      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-g' });

      const res = await request(app)
        .delete(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-g' });

      expect(res.status).toBe(204);
    });

    test('the session owner (owner_participant_id) can release even when not the current holder', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev11');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-g');
      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-dev-g' });

      // Alice created the session with deviceId 'alice-owner-dev11', so her
      // owner_participant_id composite is built from that same device id.
      const res = await request(app)
        .delete(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-owner-dev11' });

      expect(res.status).toBe(204);
    });
  });

  describe('POST /sessions/:id/lease/grant', () => {
    test('the current holder can grant to another participant', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev12');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-h');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-h');

      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-h' });

      const grant = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease/grant`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-h', toParticipantId: `${SEED.USER_BOB}#bob-dev-h` });

      expect(grant.status).toBe(200);
      expect(grant.body.holder.participantId).toBe(`${SEED.USER_BOB}#bob-dev-h`);
      expect(grant.body.epoch).toBe(2); // 1 from acquire, 2 from grant
    });

    test('a participant who is neither holder nor owner cannot grant', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev13');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-i');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-i');
      // A second Bob device — a participant with no lease authority at all.
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-i2');

      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-i' });

      const res = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease/grant`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-dev-i2', toParticipantId: `${SEED.USER_BOB}#bob-dev-i` });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('lease-grant-forbidden');
    });

    test('the session owner can grant even when not the current holder', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev14');
      await joinSession(session.id, bobHeaders(), 'vr-explorer', 'bob-dev-j');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-j');

      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(bobHeaders())
        .send({ deviceId: 'bob-dev-j' });

      const grant = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease/grant`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-owner-dev14', toParticipantId: `${SEED.USER_ALICE}#alice-dev-j` });

      expect(grant.status).toBe(200);
      expect(grant.body.holder.participantId).toBe(`${SEED.USER_ALICE}#alice-dev-j`);
    });

    test('granting to a participant who never joined returns 404', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev15');
      await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-k');
      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-k' });

      const res = await request(app)
        .post(`/api/vr/sessions/${session.id}/lease/grant`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-k', toParticipantId: `${SEED.USER_BOB}#never-joined` });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('participant-not-found');
    });
  });

  describe('join response embeds the lease (Phase B/C contract)', () => {
    test('lease is null when unheld, then reflects the holder after acquire', async () => {
      const session = await createSession(aliceHeaders(), 'alice-owner-dev16');

      const firstJoin = await joinSession(session.id, aliceHeaders(), 'vr-explorer', 'alice-dev-l');
      expect(firstJoin.lease).toBeNull();

      await request(app)
        .post(`/api/vr/sessions/${session.id}/lease`)
        .set(aliceHeaders())
        .send({ deviceId: 'alice-dev-l' });

      const secondJoin = await joinSession(session.id, bobHeaders(), 'vr-observer', 'bob-dev-l');
      expect(secondJoin.lease).not.toBeNull();
      expect(secondJoin.lease.holderParticipantId).toBe(`${SEED.USER_ALICE}#alice-dev-l`);
      expect(secondJoin.lease.epoch).toBe(1);
    });
  });
});
