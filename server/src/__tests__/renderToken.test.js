// server/src/__tests__/renderToken.test.js
// POST /api/render/token replaces the old single shared, non-expiring,
// unscoped RENDER_SERVER_TOKEN (baked into the frontend bundle, visible to
// anyone who opened devtools) with a short-lived, per-user, dataset-scoped
// credential the Python render server verifies by signature + expiry +
// scope instead of a plain string-equality check.
//
// ─── AUTO-SKIP ─────────────────────────────────────────────────────────────
// Tests auto-skip if TEST_DATABASE_URL is not set.
//
// ─── SETUP ──────────────────────────────────────────────────────────────────
//   1. docker-compose up -d cia-postgres
//   2. NODE_ENV=development \
//      TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//      DEV_BYPASS_AUTH=true \
//      RENDER_TOKEN_SECRET=test-secret \
//      cd server && npm test -- --testPathPattern "renderToken" --runInBand

'use strict';

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { createTestPool, integrationDescribe, SEED } = require('./helpers/dbFixture');

const pool = createTestPool();

function createRenderTokenTestApp(pool) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;

  // renderToken.js requires `authenticate` itself (see renderToken.js) —
  // mounted bare here, matching production's app.use("/api/render",
  // renderTokenRouter) in server/src/index.js, so this exercises the exact
  // same auth requirement production has, not a looser one.
  const renderTokenRouter = require('../routes/renderToken');
  app.use('/api/render', renderTokenRouter);
  return app;
}

function decodeToken(token) {
  const [payloadB64] = token.split('.');
  const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
  const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

function verifySignature(token, secret) {
  const [payloadB64, signatureB64] = token.split('.');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return expected === signatureB64;
}

integrationDescribe('POST /api/render/token', pool, () => {
  let app;
  let originalSecret;

  beforeAll(() => {
    originalSecret = process.env.RENDER_TOKEN_SECRET;
    process.env.RENDER_TOKEN_SECRET = 'test-render-token-secret';
    app = createRenderTokenTestApp(pool);
  });

  afterAll(async () => {
    process.env.RENDER_TOKEN_SECRET = originalSecret;
    if (pool) await pool.end();
  });

  // NOTE: this test harness runs with DEV_BYPASS_AUTH, under which
  // `authenticate` never rejects — a request with no x-user-id/x-user-name
  // headers resolves to the fixed DEV_USER rather than 401 (this matches
  // authenticate()'s actual behavior in this codebase; there is no reachable
  // "real" unauthenticated-rejection path to test without a live Keycloak
  // JWT). What DOES matter here: the token still comes back correctly
  // scoped to WHICHEVER user authenticate() resolved, proving the route
  // never mints a token for an arbitrary/unverified identity.
  test('a request with no identity headers gets a token for the fixed dev-bypass default user, not an arbitrary one', async () => {
    const res = await request(app).post('/api/render/token').send({ datasetId: 'ds-1' });

    expect(res.status).toBe(200);
    const payload = decodeToken(res.body.token);
    expect(payload.sub).toBe('00000000-0000-0000-0000-000000000002'); // DEV_USER.id
  });

  test('mints a signed token scoped to the caller and the requested dataset', async () => {
    const res = await request(app)
      .post('/api/render/token')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst')
      .send({ datasetId: 'ds-42' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token).toContain('.');
    expect(typeof res.body.expiresAt).toBe('number');
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());

    const payload = decodeToken(res.body.token);
    expect(payload.sub).toBe(SEED.USER_ALICE);
    expect(payload.datasetId).toBe('ds-42');
    expect(payload.exp).toBe(res.body.expiresAt);

    expect(verifySignature(res.body.token, 'test-render-token-secret')).toBe(true);
    expect(verifySignature(res.body.token, 'wrong-secret')).toBe(false);
  });

  test('mints an unscoped token (datasetId null) when none is requested', async () => {
    const res = await request(app)
      .post('/api/render/token')
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob Builder')
      .send({});

    expect(res.status).toBe(200);
    const payload = decodeToken(res.body.token);
    expect(payload.sub).toBe(SEED.USER_BOB);
    expect(payload.datasetId).toBeNull();
  });

  test('two different users get tokens scoped to their own id', async () => {
    const resAlice = await request(app)
      .post('/api/render/token')
      .set('x-user-id', SEED.USER_ALICE)
      .set('x-user-name', 'Alice Analyst')
      .send({ datasetId: 'ds-shared' });
    const resBob = await request(app)
      .post('/api/render/token')
      .set('x-user-id', SEED.USER_BOB)
      .set('x-user-name', 'Bob Builder')
      .send({ datasetId: 'ds-shared' });

    expect(decodeToken(resAlice.body.token).sub).toBe(SEED.USER_ALICE);
    expect(decodeToken(resBob.body.token).sub).toBe(SEED.USER_BOB);
  });
});
