// server/src/__tests__/roomLookup.test.js
// Tests for the legacy room->project lookup endpoint (GET /api/rooms/:roomId).
// Integration tests — require TEST_DATABASE_URL.
//
// Run:
//   TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//   DEV_BYPASS_AUTH=true \
//   cd server && npm test -- --testPathPattern "roomLookup" --runInBand

'use strict';

const request = require('supertest');
const express = require('express');
const { createTestPool, SEED } = require('./helpers/dbFixture');

const pool = createTestPool();
const maybeDescribe = pool ? describe : describe.skip;

function createRoomLookupTestApp(pool) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;

  const { optionalAuth } = require('../middleware/auth');
  const roomLookupRouter = require('../routes/roomLookup');
  app.use('/api/rooms', optionalAuth, roomLookupRouter);
  return app;
}

maybeDescribe('GET /api/rooms/:roomId (legacy compat lookup)', () => {
  let app;
  let regularRoomId;
  let dmRoomId;

  beforeAll(async () => {
    app = createRoomLookupTestApp(pool);

    const regular = await pool.query(
      `INSERT INTO rooms (project_id, name, room_type, is_public, created_by)
       VALUES ($1, 'Room Lookup Test Room', 'breakout', true, $2)
       RETURNING id`,
      [SEED.PROJECT_ID, SEED.USER_ADMIN]
    );
    regularRoomId = regular.rows[0].id;

    const dm = await pool.query(
      `INSERT INTO rooms (project_id, name, room_type, is_public, created_by)
       VALUES ($1, 'Room Lookup Test DM', 'dm', false, $2)
       RETURNING id`,
      [SEED.PROJECT_ID, SEED.USER_ADMIN]
    );
    dmRoomId = dm.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM rooms WHERE id = ANY($1::uuid[])`, [
      [regularRoomId, dmRoomId].filter(Boolean),
    ]);
    await pool.end();
  });

  test('200 with project_id for a real non-DM room', async () => {
    const res = await request(app).get(`/api/rooms/${regularRoomId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: regularRoomId,
      project_id: SEED.PROJECT_ID,
      room_type: 'breakout',
    });
  });

  test('404 for an unknown room id', async () => {
    const res = await request(app).get('/api/rooms/00000000-0000-0000-0000-00000000dead');

    expect(res.status).toBe(404);
  });

  test('404 for a DM room — not discoverable via bare id lookup', async () => {
    const res = await request(app).get(`/api/rooms/${dmRoomId}`);

    expect(res.status).toBe(404);
  });

  test('400 for a malformed UUID', async () => {
    const res = await request(app).get('/api/rooms/not-a-uuid');

    expect(res.status).toBe(400);
  });
});
