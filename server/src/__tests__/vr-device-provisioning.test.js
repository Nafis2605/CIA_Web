// server/src/__tests__/vr-device-provisioning.test.js
//
// THE regression guard for the bug that made VR collaboration impossible.
//
// Real headsets do not authenticate as one of the five seeded dev UUIDs. In
// dev-bypass mode each browser profile mints its own persistent per-device
// identity (src/core/identity/deviceIdentity.js getDeviceId()) and sends it as
// x-user-id, and apiClient._getDevUserHeaders() sends x-user-name alongside it.
//
// ensureDevUser() inserted a `users` row for that identity and nothing else —
// no project_members, no room_members. Meanwhile the two newest guards read
// membership directly, with no DEV_BYPASS_AUTH short-circuit (unlike every
// other guard in auth.js, e.g. checkProjectMembership, which returns
// {allowed:true} outright):
//
//   * resolveRoomAccess()          server/src/routes/vr.js  — all /api/vr/*
//   * wsManager._checkRoomAccess() server/src/services/websocket.js — join:room
//
// So every headset got 403 not-a-room-member on every VR call, and
// `room:join-error: Access denied` on the WebSocket. The WS denial is the
// quiet half: the socket is never added to wsManager.roomChannels, so
// broadcastToRoom() hits `if (!channel) return;` and EVERY vr:* broadcast —
// session-created, participant-joined, lease-changed — reaches nobody. Two
// headsets in the same room could not see each other, and no error surfaced
// anywhere a user would look.
//
// The observable symptom in the database: room_members had 0 rows, ever, and
// no vr_exploration_session had ever had more than one participant.
//
// Integration tests — require TEST_DATABASE_URL, DB-gated auto-skip.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vr-device-provisioning" --runInBand

'use strict';

// BEFORE any require of the auth middleware. auth.js computes DEV_BYPASS_AUTH
// as a module-level const at import time, gated on NODE_ENV === 'development'
// AND DEV_BYPASS_AUTH === 'true' together — and Jest defaults NODE_ENV to
// 'test'. Setting these inside beforeAll is too late once anything in this
// file requires auth.js at module scope, which is why every request here came
// back 401.
process.env.NODE_ENV = 'development';
process.env.DEV_BYPASS_AUTH = 'true';

const request = require('supertest');
const { createTestPool, SEED } = require('./helpers/dbFixture');
const { createTestApp } = require('./helpers/testApp');
const { ensureDevPublicRoomMembership } = require('../middleware/auth');

const pool = createTestPool();
const maybeDescribe = pool ? describe : describe.skip;

const SYSTEM_ORG_ID = '00000000-0000-0000-0000-000000000000';

/** A fresh, never-before-seen per-device identity, exactly as a headset sends it. */
function newDeviceHeaders(label) {
  // v4-shaped, matching deviceIdentity.getDeviceId()'s UUID_RE — the server
  // rejects anything else before it ever reaches the provisioning path.
  const id = `${Date.now().toString(16).padStart(8, '0').slice(-8)}-0000-4000-8000-${String(
    Math.floor(Math.random() * 1e12)
  )
    .padStart(12, '0')
    .slice(-12)}`;
  return { 'x-user-id': id, 'x-user-name': label };
}

maybeDescribe('VR — per-device identity provisioning', () => {
  let app;
  let projectId;
  let roomMainId;

  beforeAll(async () => {
    app = createTestApp(pool);

    const stamp = Date.now();
    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, $2, $3, 'private', $4)
       RETURNING id`,
      [
        SYSTEM_ORG_ID,
        `VR Device Provisioning ${stamp}`,
        `vr-device-provisioning-${stamp}`,
        SEED.USER_ADMIN,
      ]
    );
    projectId = proj.rows[0].id;

    // Main Room is auto-created by trigger, public by column default.
    const room = await pool.query(
      `SELECT id FROM rooms WHERE project_id = $1 AND is_main = true`,
      [projectId]
    );
    roomMainId = room.rows[0].id;
  });

  afterAll(async () => {
    if (projectId) {
      await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
    await pool.end();
  });

  it('grants a brand-new device identity access to a public room on its first request', async () => {
    const headers = newDeviceHeaders('Quest 3 test');

    // The exact call a joining headset makes to discover the host's session.
    // This returned 403 not-a-room-member for every real device.
    const res = await request(app)
      .get(`/api/vr/sessions?roomId=${roomMainId}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('writes a room_members row — and deliberately NOT a project_members row', async () => {
    const headers = newDeviceHeaders('Vision Pro test');
    const deviceId = headers['x-user-id'];

    await request(app).get(`/api/vr/sessions?roomId=${roomMainId}`).set(headers);

    // room_members is what resolveRoomAccess and _checkRoomAccess read, and
    // what member lists and rosters read — so the room stops looking empty
    // while people are demonstrably in it.
    const roomMember = await pool.query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomMainId, deviceId]
    );
    expect(roomMember.rowCount).toBe(1);

    // Project membership is NOT granted. An earlier version of this fix
    // inserted project_members for every project, which fixed VR but made
    // "not a project member" impossible to express under dev bypass and broke
    // the room-membership enforcement tests in roomMembership.test.js. Room
    // access is the narrowest grant that actually unblocks two headsets.
    const projectMember = await pool.query(
      `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, deviceId]
    );
    expect(projectMember.rowCount).toBe(0);
  });

  it('does NOT grant access to a private room', async () => {
    // Provisioning is scoped to public rooms. A private room still requires a
    // real invite — this must not become a blanket "dev bypass sees all".
    const priv = await pool.query(
      `INSERT INTO rooms (project_id, name, room_type, is_public, is_main, created_by)
       VALUES ($1, 'Private', 'breakout', false, false,
               '00000000-0000-0000-0000-000000000001')
       RETURNING id`,
      [projectId]
    );
    const privateRoomId = priv.rows[0].id;

    const headers = newDeviceHeaders('Quest 2 test');
    const res = await request(app)
      .get(`/api/vr/sessions?roomId=${privateRoomId}`)
      .set(headers);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'not-a-room-member' });
  });

  it('two different devices both reach the same room — the two-headset case', async () => {
    // The actual user-facing scenario: two headsets open the same room link.
    // Both must be able to list sessions in it, or neither can ever discover
    // the other's VR session.
    const headsetA = newDeviceHeaders('Headset A');
    const headsetB = newDeviceHeaders('Headset B');

    const [resA, resB] = await Promise.all([
      request(app).get(`/api/vr/sessions?roomId=${roomMainId}`).set(headsetA),
      request(app).get(`/api/vr/sessions?roomId=${roomMainId}`).set(headsetB),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(headsetA['x-user-id']).not.toBe(headsetB['x-user-id']);
  });

  it('works for an identity that has never made an HTTP request (the WebSocket path)', async () => {
    // wsManager._checkRoomAccess reaches this helper directly, with no Express
    // request behind it — so ensureDevUser has never run for that identity and
    // there is no users row. room_members.user_id is a FK to users.id, so the
    // insert used to fail, the room join was refused, and NOTHING retried: the
    // socket stayed out of wsManager.roomChannels for the rest of the session
    // and every vr:* broadcast was silently dropped. A headset's serverSync
    // socket routinely connects before its first API call, so this is the
    // normal ordering, not an edge case.
    const deviceId = newDeviceHeaders('WS-first device')['x-user-id'];

    const before = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [deviceId]);
    expect(before.rowCount).toBe(0);

    const granted = await ensureDevPublicRoomMembership(pool, roomMainId, deviceId);
    expect(granted).toBe(true);

    const member = await pool.query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomMainId, deviceId]
    );
    expect(member.rowCount).toBe(1);
  });

  it('is idempotent — repeated requests do not duplicate membership rows', async () => {
    const headers = newDeviceHeaders('Repeat test');
    const deviceId = headers['x-user-id'];

    for (let i = 0; i < 3; i++) {
      await request(app).get(`/api/vr/sessions?roomId=${roomMainId}`).set(headers);
    }

    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomMainId, deviceId]
    );
    expect(rows.rows[0].n).toBe(1);
  });
});
