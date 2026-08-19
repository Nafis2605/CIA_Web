// server/src/__tests__/vr-preprocessing-ready.test.js
// Issue 7 (Round 2, VR rendering architecture): GET
// /vr/preprocessing/:datasetId/ready was the one VR route in this file with
// no getUserId(req) 401 guard, and it 500'd on a non-UUID/builtin dataset id
// (e.g. "builtin-lungs") because dataset_id is a uuid column and Postgres
// raises 22P02 on the cast — the generic catch turned that into an opaque
// 500. A bundled demo dataset must never block VR entry, so a non-UUID id
// now short-circuits to {ready:true, required:false, status:'not_applicable'}
// without touching the database at all (see asUuidOrNull in
// server/src/routes/vr.js, the same guard resolveRoomAccess already uses for
// this exact class of problem).
//
// Integration tests — require TEST_DATABASE_URL, DB-gated auto-skip.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "vr-preprocessing-ready" --runInBand

'use strict';

const request = require('supertest');
const { createTestPool, SEED } = require('./helpers/dbFixture');
const { createTestApp } = require('./helpers/testApp');

const pool = createTestPool();
const maybeDescribe = pool ? describe : describe.skip;

function aliceHeaders() {
  return { 'x-user-id': SEED.USER_ALICE, 'x-user-name': 'Alice' };
}

maybeDescribe('GET /api/vr/preprocessing/:datasetId/ready', () => {
  let app;

  beforeAll(() => {
    // Same DEV_BYPASS_AUTH + NODE_ENV workaround as vr-room-scope.test.js —
    // see its header comment for why both are required together.
    process.env.NODE_ENV = 'development';
    process.env.DEV_BYPASS_AUTH = 'true';
    app = createTestApp(pool);
  });

  test('returns {ready:true, required:false, status:not_applicable} for a non-UUID/builtin dataset id, without touching the DB', async () => {
    const res = await request(app)
      .get('/api/vr/preprocessing/builtin-lungs/ready')
      .set(aliceHeaders());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: true,
      required: false,
      status: 'not_applicable',
    });
  });

  test('returns the same short-circuit for any other non-UUID placeholder id', async () => {
    const res = await request(app)
      .get('/api/vr/preprocessing/not-a-real-uuid/ready')
      .set(aliceHeaders());

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.required).toBe(false);
  });

  test('a well-formed but nonexistent dataset UUID reaches isReadyForVR (not the short-circuit) and still answers, not 500s', async () => {
    const res = await request(app)
      .get('/api/vr/preprocessing/00000000-0000-4000-8000-000000000000/ready')
      .set(aliceHeaders());

    // Whatever isReadyForVR's exact contract is for an unknown id, it must
    // not be an opaque 500 from an unguarded Postgres error.
    expect(res.status).not.toBe(500);
  });
});

// Separate describe block, same reasoning as vrSessionIdentity.test.js's /
// vr-join-contract.test.js's "no credentials at all" block: DEV_BYPASS_AUTH
// (auth.js) is read into a module-level constant at require time, so
// genuinely exercising the non-bypass branch needs jest.resetModules() to
// force auth.js to re-evaluate it against env vars set beforehand.
maybeDescribe('GET /api/vr/preprocessing/:datasetId/ready — no credentials at all', () => {
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

  test('returns 401 with no auth header', async () => {
    const res = await request(app).get('/api/vr/preprocessing/builtin-lungs/ready');

    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
});
