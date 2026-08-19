// server/src/__tests__/vr-room-scope.test.js
// Phase A of the VR room-scoping plan: a VR exploration session belongs to
// exactly one room, not just a project. Before this, GET/POST/join on
// /api/vr/sessions had no room-membership check at all, so a user in room B
// could list and join a session that actually lived in room A — the server
// would record them as a participant, but their Y.js doc (bound to
// sessionManager.getRoomId()) is a completely different document.
//
// Integration tests — require TEST_DATABASE_URL, DB-gated auto-skip.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vr-room-scope" --runInBand
//
// Fixture topology (one throwaway project, to work within the
// one_main_room_per_project UNIQUE(project_id, is_main) constraint — see
// roomMembership.test.js's comment; a project can have at most 2 rooms: the
// auto-created Main Room (is_main=true, is_public=true by column default)
// plus exactly one more (is_main=false)):
//   - Room MAIN  (auto-created, public)  — Alice + Bob are project members;
//     neither is explicitly added to room_members, so access to MAIN comes
//     only from "public room + project member".
//   - Room PRIVATE (manually created, is_public=false) — only Alice is
//     added to room_members. Bob is a project member but has no access to
//     PRIVATE at all.

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

maybeDescribe('VR sessions — room scoping (Phase A)', () => {
  let app;
  let projectId;
  let roomMainId;
  let roomPrivateId;
  let otherProjectId;
  let otherProjectRoomId;

  beforeAll(async () => {
    // DEV_BYPASS_AUTH (auth.js) is gated on NODE_ENV === 'development' AND
    // DEV_BYPASS_AUTH === 'true' together. Jest defaults NODE_ENV to 'test',
    // so DEV_BYPASS_AUTH=true alone (as run per this file's header comment,
    // matching CLAUDE.md's documented integration-test invocation) is not
    // enough — without also forcing NODE_ENV here, optionalAuth/authenticate
    // fall through to their non-bypass branches and x-user-id/x-user-name
    // are silently ignored. roomMembership.test.js hits the same gap and
    // works around it the same way.
    process.env.NODE_ENV = 'development';
    process.env.DEV_BYPASS_AUTH = 'true';
    app = createTestApp(pool);

    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, $2, $3, 'private', $4)
       RETURNING id`,
      [SYSTEM_ORG_ID, `VR Room Scope Test ${Date.now()}`, `vr-room-scope-test-${Date.now()}`, SEED.USER_ADMIN]
    );
    projectId = proj.rows[0].id;

    for (const userId of [SEED.USER_ALICE, SEED.USER_BOB]) {
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [projectId, userId]
      );
    }

    // The project's own creation trigger already inserted a public Main Room.
    const main = await pool.query(
      `SELECT id FROM rooms WHERE project_id = $1 AND is_main = true`,
      [projectId]
    );
    roomMainId = main.rows[0].id;

    const priv = await pool.query(
      `INSERT INTO rooms (project_id, name, room_type, is_public, is_main, created_by)
       VALUES ($1, 'VR Scope Test Private Room', 'breakout', false, false, $2)
       RETURNING id`,
      [projectId, SEED.USER_ADMIN]
    );
    roomPrivateId = priv.rows[0].id;
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
      [roomPrivateId, SEED.USER_ALICE]
    );

    // A second, unrelated project — its own auto-created Main Room, with
    // Alice added directly to room_members (independent of project
    // membership) so she has real access to the room. Used only to prove
    // the room-project-mismatch guard: a roomId that IS accessible but
    // belongs to a DIFFERENT project than the one named in the request.
    const other = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, $2, $3, 'private', $4)
       RETURNING id`,
      [SYSTEM_ORG_ID, `VR Room Scope Mismatch Test ${Date.now()}`, `vr-room-scope-mismatch-test-${Date.now()}`, SEED.USER_ADMIN]
    );
    otherProjectId = other.rows[0].id;
    const otherMain = await pool.query(
      `SELECT id FROM rooms WHERE project_id = $1 AND is_main = true`,
      [otherProjectId]
    );
    otherProjectRoomId = otherMain.rows[0].id;
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
      [otherProjectRoomId, SEED.USER_ALICE]
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [
      [projectId, otherProjectId].filter(Boolean),
    ]);
    await pool.end();
  });

  describe('POST /api/vr/sessions', () => {
    test('requires roomId in the body', async () => {
      const res = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, deviceId: 'alice-dev' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing-room');
    });

    test('rejects a room the caller has no access to', async () => {
      const res = await request(app)
        .post('/api/vr/sessions')
        .set(bobHeaders())
        .send({ projectId, roomId: roomPrivateId, deviceId: 'bob-dev' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('not-a-room-member');
    });

    test('a malformed (non-UUID) roomId returns 400 invalid-room, not a 500 from Postgres', async () => {
      // roomId binds into a `uuid` column inside resolveRoomAccess — without
      // up-front validation this reaches Postgres as-is and raises 22P02
      // invalid input syntax, which the route's generic catch turns into an
      // opaque 500. asUuidOrNull() must catch it first and return a distinct
      // code from the missing-roomId case above.
      const res = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: 'not-a-uuid', deviceId: 'alice-dev' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid-room');
    });

    test('rejects a roomId that belongs to a different project than the one named in the request', async () => {
      // Alice has real access to otherProjectRoomId, so this exercises the
      // room-project-mismatch branch specifically, not the membership branch.
      const res = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: otherProjectRoomId, deviceId: 'alice-dev' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('room-project-mismatch');
    });

    test('a room member can create a session, and room_id/owner_participant_id are persisted', async () => {
      const res = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: roomPrivateId, deviceId: 'alice-dev' });

      expect(res.status).toBe(200);
      expect(res.body.room_id).toBe(roomPrivateId);
      expect(res.body.owner_participant_id).toBe(`${SEED.USER_ALICE}#alice-dev`);
    });

    test('two different rooms creating sessions with the same clientSessionKey both succeed (H3/finding #2)', async () => {
      const clientSessionKey = `shared-key-${Date.now()}`;

      const inPrivate = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: roomPrivateId, deviceId: 'alice-dev', clientSessionKey });
      expect(inPrivate.status).toBe(200);

      const inMain = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: roomMainId, deviceId: 'alice-dev', clientSessionKey });
      expect(inMain.status).toBe(200);
      expect(inMain.body.id).not.toBe(inPrivate.body.id);

      // Sanity check the OTHER half of the fix: the SAME room reusing the
      // same key still collides (uniqueness narrowed to per-room, not
      // removed outright).
      const dupeInMain = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: roomMainId, deviceId: 'alice-dev', clientSessionKey });
      expect(dupeInMain.status).toBe(500);
    });
  });

  describe('GET /api/vr/sessions/:id and /api/vr/sessions (list)', () => {
    let privateSessionId;
    let mainSessionId;

    beforeAll(async () => {
      const priv = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: roomPrivateId, deviceId: 'alice-dev-2' });
      privateSessionId = priv.body.id;

      const main = await request(app)
        .post('/api/vr/sessions')
        .set(bobHeaders())
        .send({ projectId, roomId: roomMainId, deviceId: 'bob-dev-2' });
      mainSessionId = main.body.id;
    });

    test('non-member gets 403 on GET /sessions/:id for a private-room session', async () => {
      const res = await request(app)
        .get(`/api/vr/sessions/${privateSessionId}`)
        .set(bobHeaders());

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('not-a-room-member');
    });

    test('room member gets 200 on GET /sessions/:id', async () => {
      const res = await request(app)
        .get(`/api/vr/sessions/${privateSessionId}`)
        .set(aliceHeaders());

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(privateSessionId);
    });

    test('GET /sessions requires a roomId query param', async () => {
      const res = await request(app).get('/api/vr/sessions').set(aliceHeaders());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing-room');
    });

    test('non-member gets 403 on GET /sessions?roomId=<private room>', async () => {
      const res = await request(app)
        .get(`/api/vr/sessions?roomId=${roomPrivateId}`)
        .set(bobHeaders());

      expect(res.status).toBe(403);
    });

    test('list returns only sessions belonging to the requested room', async () => {
      const privList = await request(app)
        .get(`/api/vr/sessions?roomId=${roomPrivateId}`)
        .set(aliceHeaders());
      expect(privList.status).toBe(200);
      const privIds = privList.body.map((s) => s.id);
      expect(privIds).toContain(privateSessionId);
      expect(privIds).not.toContain(mainSessionId);

      const mainList = await request(app)
        .get(`/api/vr/sessions?roomId=${roomMainId}`)
        .set(bobHeaders());
      expect(mainList.status).toBe(200);
      const mainIds = mainList.body.map((s) => s.id);
      expect(mainIds).toContain(mainSessionId);
      expect(mainIds).not.toContain(privateSessionId);
    });
  });

  describe('POST /api/vr/sessions/:id/join', () => {
    let privateSessionId;
    let mainSessionId;

    beforeAll(async () => {
      const priv = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: roomPrivateId, deviceId: 'alice-dev-3' });
      privateSessionId = priv.body.id;

      const main = await request(app)
        .post('/api/vr/sessions')
        .set(aliceHeaders())
        .send({ projectId, roomId: roomMainId, deviceId: 'alice-dev-4' });
      mainSessionId = main.body.id;
    });

    test('non-member (no access to the session\'s room at all) gets 403, not "joined as observer"', async () => {
      const res = await request(app)
        .post(`/api/vr/sessions/${privateSessionId}/join`)
        .set(bobHeaders())
        .send({ mode: 'desktop-observer', deviceId: 'bob-dev-3', roomId: roomMainId });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('not-a-room-member');
    });

    test('a member of a different room joining a session by id gets 409 cross-room', async () => {
      // Bob has access to roomMain (public room + project member) — the
      // session he's trying to join — but his client-side "current room"
      // (roomId in the body) is roomPrivate, so the guard is satisfied but
      // the room match is not: this is the cross-room case, not the plain
      // membership-denied case above.
      const res = await request(app)
        .post(`/api/vr/sessions/${mainSessionId}/join`)
        .set(bobHeaders())
        .send({ mode: 'desktop-observer', deviceId: 'bob-dev-4', roomId: roomPrivateId });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('cross-room');
      expect(res.body.roomId).toBe(roomMainId);
      expect(res.body.roomName).toBeTruthy();
    });

    test('joining with the matching roomId succeeds normally', async () => {
      const res = await request(app)
        .post(`/api/vr/sessions/${mainSessionId}/join`)
        .set(bobHeaders())
        .send({ mode: 'desktop-observer', deviceId: 'bob-dev-5', roomId: roomMainId });

      expect(res.status).toBe(200);
      // Phase B join response contract: participant fields moved under
      // `participant`, no longer echoed at the top level (see vr.js's
      // POST /sessions/:id/join contract comment).
      expect(res.body.joined).toBe(true);
      expect(res.body.participant.mode).toBe('desktop-observer');
    });
  });
});
