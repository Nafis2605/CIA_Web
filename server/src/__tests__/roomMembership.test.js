// server/src/__tests__/roomMembership.test.js
// Tests for membership enforcement on GET /api/projects/:projectId/rooms/:roomId.
// Integration tests — require TEST_DATABASE_URL.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "roomMembership" --runInBand
//
// Uses fresh throwaway projects rather than the seeded default project
// (SEED.PROJECT_ID) — the seeded project's rooms table already has its one
// non-main-room slot occupied by the seeded "Demo Room", and the
// `one_main_room_per_project` unique constraint on (project_id, is_main)
// caps every project at exactly one non-main room, ever (a separate,
// pre-existing schema bug, not something this test works around silently —
// flagged separately). A fresh project's own auto-created Main Room has
// is_main=true, leaving its one is_main=false slot free for this test's room.

'use strict';

const request = require('supertest');
const express = require('express');
const { createTestPool, SEED } = require('./helpers/dbFixture');

const pool = createTestPool();
const maybeDescribe = pool ? describe : describe.skip;

const NON_MEMBER_UUID = '99999999-9999-9999-9999-999999999999';
const SYSTEM_ORG_ID = '00000000-0000-0000-0000-000000000000';

// Mounts with optionalAuth, matching the real production mount
// (server/src/index.js) — unlike `authenticate`, this correctly leaves
// req.user null for a genuinely unauthenticated request instead of always
// defaulting to a dev user.
function createRoomsTestApp(pool) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;

  const { optionalAuth } = require('../middleware/auth');
  const roomsRouter = require('../routes/rooms');
  app.use('/api/projects/:projectId/rooms', optionalAuth, roomsRouter);
  return app;
}

/** Create a throwaway project with the given project_members, and return its id. */
async function createTestProject(pool, slugSuffix, memberUserIds) {
  const proj = await pool.query(
    `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
     VALUES ($1, $2, $3, 'private', $4)
     RETURNING id`,
    [SYSTEM_ORG_ID, `Room Membership Test ${slugSuffix}`, `room-membership-test-${slugSuffix}`, SEED.USER_ADMIN]
  );
  const projectId = proj.rows[0].id;

  for (const userId of memberUserIds) {
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [projectId, userId]
    );
  }

  return projectId;
}

maybeDescribe('GET /api/projects/:projectId/rooms/:roomId (membership enforcement)', () => {
  let app;
  let privateProjectId;
  let privateRoomId;
  let publicProjectId;
  let publicRoomId;

  beforeAll(async () => {
    process.env.DEV_BYPASS_AUTH = 'true';
    process.env.NODE_ENV = 'development';
    app = createRoomsTestApp(pool);

    // Project with a PRIVATE room: Alice and Bob are both project members,
    // but only Alice is added to the room itself.
    privateProjectId = await createTestProject(pool, `private-${Date.now()}`, [
      SEED.USER_ALICE,
      SEED.USER_BOB,
    ]);
    const priv = await pool.query(
      `INSERT INTO rooms (project_id, name, room_type, is_public, created_by)
       VALUES ($1, 'Membership Test Private Room', 'breakout', false, $2)
       RETURNING id`,
      [privateProjectId, SEED.USER_ADMIN]
    );
    privateRoomId = priv.rows[0].id;
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
      [privateRoomId, SEED.USER_ALICE]
    );

    // Project with a PUBLIC room: only Bob is a project member, and is
    // deliberately NOT added to room_members — reachable only via the
    // public-room + project-member branch.
    publicProjectId = await createTestProject(pool, `public-${Date.now()}`, [SEED.USER_BOB]);
    const pub = await pool.query(
      `INSERT INTO rooms (project_id, name, room_type, is_public, created_by)
       VALUES ($1, 'Membership Test Public Room', 'breakout', true, $2)
       RETURNING id`,
      [publicProjectId, SEED.USER_ADMIN]
    );
    publicRoomId = pub.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [
      [privateProjectId, publicProjectId].filter(Boolean),
    ]);
  });

  test('a room member gets 200 for a private room', async () => {
    const res = await request(app)
      .get(`/api/projects/${privateProjectId}/rooms/${privateRoomId}`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(privateRoomId);
    expect(res.body.is_member).toBe(true);
  });

  test('a project member who is NOT a room member gets 404 for a private room', async () => {
    const res = await request(app)
      .get(`/api/projects/${privateProjectId}/rooms/${privateRoomId}`)
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob');

    expect(res.status).toBe(404);
  });

  test('a non-project-member gets 404 for a private room', async () => {
    const res = await request(app)
      .get(`/api/projects/${privateProjectId}/rooms/${privateRoomId}`)
      .set('x-user-id', NON_MEMBER_UUID)
      .set('x-user-name', 'Nobody');

    expect(res.status).toBe(404);
  });

  test('a project member who is NOT a room member gets 200 for a PUBLIC room', async () => {
    const res = await request(app)
      .get(`/api/projects/${publicProjectId}/rooms/${publicRoomId}`)
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(publicRoomId);
    expect(res.body.is_member).toBe(false); // public access, not room membership
  });

  test('a non-project-member gets 404 even for a public room (project membership still required)', async () => {
    const res = await request(app)
      .get(`/api/projects/${publicProjectId}/rooms/${publicRoomId}`)
      .set('x-user-id', NON_MEMBER_UUID)
      .set('x-user-name', 'Nobody');

    expect(res.status).toBe(404);
  });

  test('an unknown roomId returns 404', async () => {
    const res = await request(app)
      .get(`/api/projects/${privateProjectId}/rooms/00000000-0000-0000-0000-00000000dead`)
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice');

    expect(res.status).toBe(404);
  });
});

// Separate describe block: needs DEV_BYPASS_AUTH genuinely off to exercise
// optionalAuth's real (non-dev-bypass) branch, where an unauthenticated
// request correctly resolves req.user = null instead of a dev default. No
// DB row is needed — the route returns 401 before ever querying the DB.
maybeDescribe('GET /api/projects/:projectId/rooms/:roomId (no credentials at all)', () => {
  let app;
  let prevDevBypass;
  let prevNodeEnv;

  beforeAll(() => {
    prevDevBypass = process.env.DEV_BYPASS_AUTH;
    prevNodeEnv = process.env.NODE_ENV;
    process.env.DEV_BYPASS_AUTH = 'false';
    process.env.NODE_ENV = 'production';
    jest.resetModules();

    app = createRoomsTestApp(pool);
  });

  afterAll(() => {
    process.env.DEV_BYPASS_AUTH = prevDevBypass;
    process.env.NODE_ENV = prevNodeEnv;
    jest.resetModules();
  });

  test('returns 401 with no Authorization header and DEV_BYPASS_AUTH off', async () => {
    const res = await request(app).get(
      `/api/projects/${SEED.PROJECT_ID}/rooms/00000000-0000-0000-0000-00000000dead`
    );

    expect(res.status).toBe(401);
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
});
