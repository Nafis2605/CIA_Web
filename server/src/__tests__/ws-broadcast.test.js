// server/src/__tests__/ws-broadcast.test.js
// Real WebSocket broadcast integration test.
//
// Verifies that:
//   1. An accepted persistent-state mutation causes a WS broadcast to subscribed clients.
//   2. The broadcast payload contains syncEventId, revision, actorUserId, timestamp.
//   3. A client NOT subscribed to the project does NOT receive the broadcast.
//
// ─── AUTO-SKIP ─────────────────────────────────────────────────────────────
// Tests auto-skip if TEST_DATABASE_URL is not set.  No failure is reported.
//
// ─── SETUP ──────────────────────────────────────────────────────────────────
//   1. docker-compose up -d cia-postgres
//   2. ./server/database/run-migration.sh migrations/014_dr1_sync_hardening.sql
//   3. TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//      DEV_BYPASS_AUTH=true \
//      cd server && npm test -- --testPathPattern "ws-broadcast" --runInBand

'use strict';

// Must be set before requiring ../services/websocket below — it pulls in
// ../middleware/auth, and auth.js's DEV_BYPASS_AUTH is a module-load-time
// constant gated on NODE_ENV === 'development' (Jest defaults NODE_ENV to
// 'test'). The pre-existing tests in this file only exercise routes mounted
// with `authenticate`, whose non-bypass fallback also happens to resolve to
// DEV_USER, so they passed either way — but the VR room-scope test added
// below hits routes mounted with `optionalAuth` (matching the real
// production mount), which under non-bypass requires a real Bearer JWT and
// would 401 on the x-user-id/x-user-name headers used throughout this file.
// See vr-sessions-uuid.test.js / roomMembership.test.js for the same fix.
process.env.NODE_ENV = 'development';
process.env.DEV_BYPASS_AUTH = 'true';

const http = require('http');
const WebSocket = require('ws');
const request = require('supertest');
const {
  createTestPool,
  SEED,
  DEV_AUTH_HEADERS,
  cleanupViews,
  cleanupSyncEvents,
} = require('./helpers/dbFixture');
const { createTestApp } = require('./helpers/testApp');
// Import singleton — we'll call initialize() on it
const wsManager = require('../services/websocket');

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Wait for a WS message matching `predicate` with a timeout.
 * Rejects cleanly if no matching message arrives within timeoutMs.
 */
function waitForMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`WS message timeout after ${timeoutMs}ms`)),
      timeoutMs
    );

    function onMessage(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }

    ws.on('message', onMessage);
  });
}

/**
 * Authenticate and join a project room.
 * Returns a promise that resolves when 'project:joined' is received.
 *
 * Must be called with a freshly-created `ws`, BEFORE awaiting its 'open'
 * event separately — the server sends its "connected" welcome message
 * synchronously as soon as the WS upgrade completes (see websocket.js's
 * `this.wss.on("connection", ...)`), which can race ahead of a caller that
 * does `await new Promise(ws.once('open', resolve))` first and only THEN
 * attaches a 'message' listener: on a loaded event loop (e.g. right after
 * other supertest requests against the same app) that gap is enough for
 * "connected" to arrive and be silently dropped — the listener that would
 * have consumed it doesn't exist yet — hanging every step after it forever.
 * Attaching the listener here handles 'open' implicitly (nothing needed
 * before "connected" can arrive anyway) and closes the race.
 */
function authenticateAndJoin(ws, port, projectId) {
  return new Promise((resolve, reject) => {
    let step = 'connected';

    function onMessage(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch {
        ws.off('message', onMessage);
        return reject(new Error('Invalid JSON from WS server'));
      }

      if (step === 'connected' && msg.type === 'connected') {
        step = 'auth';
        ws.send(JSON.stringify({
          type: 'auth',
          userId: SEED.USER_ADMIN,
          userEmail: 'admin@cia-web.local',
          userName: 'CIA Admin',
        }));
      } else if (step === 'auth' && msg.type === 'auth:success') {
        step = 'join';
        ws.send(JSON.stringify({ type: 'join:project', projectId }));
      } else if (step === 'join' && msg.type === 'project:joined') {
        ws.off('message', onMessage);
        resolve();
      } else if (msg.type === 'auth:error' || msg.type === 'project:join-error') {
        ws.off('message', onMessage);
        reject(new Error(`WS setup failed at step ${step}: ${msg.error}`));
      }
    }

    ws.on('message', onMessage);
    ws.once('error', reject);
  });
}

/**
 * Authenticate and join a ROOM channel (not a project room) — the
 * counterpart to authenticateAndJoin() above, for the VR room-scoped
 * broadcast tests below. Mirrors serverSync.js's own auth:success ->
 * join:room sequence (Phase A1). Same "attach the listener immediately,
 * don't await 'open' separately first" requirement as authenticateAndJoin —
 * see its comment.
 */
function authenticateAndJoinRoom(ws, roomId) {
  return new Promise((resolve, reject) => {
    // Unlike waitForMessage(), a raw multi-step handshake with no matching
    // reply left the returned promise stuck forever instead of failing the
    // test — this timeout turns a silent hang into a clear error.
    const timer = setTimeout(
      () => reject(new Error(`authenticateAndJoinRoom(${roomId}) timed out`)),
      8000
    );
    let step = 'connected';

    function onMessage(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch {
        ws.off('message', onMessage);
        return reject(new Error('Invalid JSON from WS server'));
      }

      if (step === 'connected' && msg.type === 'connected') {
        step = 'auth';
        ws.send(JSON.stringify({
          type: 'auth',
          userId: SEED.USER_ADMIN,
          userEmail: 'admin@cia-web.local',
          userName: 'CIA Admin',
        }));
      } else if (step === 'auth' && msg.type === 'auth:success') {
        step = 'join';
        ws.send(JSON.stringify({ type: 'join:room', roomId }));
      } else if (step === 'join' && msg.type === 'room:joined') {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      } else if (msg.type === 'auth:error' || msg.type === 'room:join-error') {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(new Error(`WS room-join failed at step ${step}: ${msg.error}`));
      }
    }

    ws.on('message', onMessage);
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================================================
// TEST SUITE
// ============================================================================

const pool = createTestPool();
const maybeDescribe = pool ? describe : describe.skip;

maybeDescribe('WebSocket broadcast — integration (requires DB)', () => {
  let server;
  let app;
  let port;
  let testViewId;
  let startEventId = 0;
  const createdViewIds = [];

  beforeAll(async () => {
    // Record event baseline for cleanup
    const evResult = await pool.query(
      'SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM sync_events'
    );
    startEventId = Number(evResult.rows[0].max_id);

    // Create Express app + mount real wsManager on a random port
    app = createTestApp(pool);
    server = http.createServer(app);

    // Initialize the real WebSocket manager (attached to server, with DB pool for access checks)
    wsManager.initialize(server, pool);
    // Override the no-op wsManager in app.locals with the real one
    app.locals.wsManager = wsManager;

    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;

    // Create a test view to use in tests
    const dsResult = await pool.query(
      `SELECT id FROM datasets WHERE status = 'active' LIMIT 1`
    );
    if (!dsResult.rows.length) {
      console.warn('[ws-broadcast] No active dataset found — skipping view creation');
      return;
    }
    const fileId = dsResult.rows[0].id;

    const branchResult = await pool.query(
      `SELECT id FROM project_branches WHERE project_id = $1 AND name = 'main' LIMIT 1`,
      [SEED.PROJECT_ID]
    );
    const branchId = branchResult.rows[0]?.id || null;

    const res = await request(app)
      .post('/api/views')
      .set(DEV_AUTH_HEADERS)
      .send({
        fileId,
        projectId: SEED.PROJECT_ID,
        branchId,
        name: `WS Broadcast Test View ${Date.now()}`,
        visibility: 'private',
      });

    if (res.status === 201) {
      testViewId = res.body.view.id;
      createdViewIds.push(testViewId);
    }
  });

  afterAll(async () => {
    // Clean up test data
    await cleanupViews(pool, createdViewIds);
    await cleanupSyncEvents(pool, startEventId);

    // Shut down WS and HTTP server. NOT pool.end() here — `pool` is a
    // module-level singleton shared with the VR room-scoping suite added
    // below, which runs after this describe block's afterAll; closing it
    // here would fail that suite's beforeAll with "Cannot use a pool after
    // calling end on the pool". Closed once, file-wide, at the bottom.
    wsManager.shutdown();
    await new Promise((resolve) => server.close(resolve));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: accepted mutation broadcasts view:updated with correct metadata
  // ─────────────────────────────────────────────────────────────────────────
  test('accepted view update broadcasts view:updated with syncEventId and revision', async () => {
    if (!testViewId) {
      console.warn('[ws-broadcast] No test view — skipping broadcast test');
      return;
    }

    // Do NOT await 'open' separately before this — see authenticateAndJoin's
    // comment on why that races the server's synchronous "connected" send.
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await authenticateAndJoin(ws, port, SEED.PROJECT_ID);

    // Get current revision
    const viewRes = await request(app)
      .get(`/api/views/${testViewId}`)
      .set(DEV_AUTH_HEADERS);
    expect(viewRes.status).toBe(200);
    const currentRevision = Number(viewRes.body.view.revision);

    // Fire mutation and listen for WS broadcast concurrently
    const [putRes, broadcastMsg] = await Promise.all([
      request(app)
        .put(`/api/views/${testViewId}`)
        .set(DEV_AUTH_HEADERS)
        .send({ name: 'WS Broadcast Updated', base_revision: currentRevision }),
      waitForMessage(ws, (m) => m.type === 'view:updated' && m.view?.id === testViewId),
    ]);

    expect(putRes.status).toBe(200);

    // Payload assertions
    expect(broadcastMsg.type).toBe('view:updated');
    expect(broadcastMsg.view).toBeDefined();
    expect(broadcastMsg.view.id).toBe(testViewId);
    expect(Number(broadcastMsg.view.revision)).toBe(currentRevision + 1);
    expect(broadcastMsg.syncEventId).toBeTruthy();
    expect(typeof broadcastMsg.syncEventId).toBe('string');
    expect(broadcastMsg.actorUserId).toBe(SEED.USER_ADMIN);
    expect(broadcastMsg.timestamp).toBeTruthy();
    expect(broadcastMsg.projectId).toBe(SEED.PROJECT_ID);

    ws.close();
    await new Promise((resolve) => ws.once('close', resolve));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: client not in the project room does NOT receive the broadcast
  // ─────────────────────────────────────────────────────────────────────────
  test('client not subscribed to project does not receive view:updated', async () => {
    if (!testViewId) return;

    // Connect a WS client but do NOT join any project
    const isolatedWs = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((resolve, reject) => {
      isolatedWs.once('open', resolve);
      isolatedWs.once('error', reject);
    });

    const received = [];
    isolatedWs.on('message', (data) => {
      try { received.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });

    // Trigger a mutation (view:updated will be broadcast to project room)
    const viewRes = await request(app)
      .get(`/api/views/${testViewId}`)
      .set(DEV_AUTH_HEADERS);
    await request(app)
      .put(`/api/views/${testViewId}`)
      .set(DEV_AUTH_HEADERS)
      .send({ name: 'Isolation Test', base_revision: Number(viewRes.body.view.revision) });

    // Give a short window for any rogue broadcast to arrive
    await new Promise((resolve) => setTimeout(resolve, 200));

    const viewUpdates = received.filter((m) => m.type === 'view:updated');
    expect(viewUpdates).toHaveLength(0);

    isolatedWs.close();
    await new Promise((resolve) => isolatedWs.once('close', resolve));
  });
});

// ============================================================================
// SUITE: VR broadcasts are ROOM-scoped, not project-scoped (Phase A3)
// ============================================================================
// Pins the websocket.js vr* helper rewrite: they now call broadcastToRoom
// (with the session's room_id), not broadcastToProject. A client in a
// different room of the SAME project must not receive the broadcast, even
// though before this it would have (wsManager.rooms is keyed by project).
// Also pins the :823 payload bug fix — participant.od_user_id has been
// undefined since 019_vr_participant_device_identity.sql renamed that
// column; participantId/accountUserId are the real fields now, with
// odUserId kept only as a deprecated alias.
maybeDescribe('VR broadcasts — room scoping (Phase A3, requires DB)', () => {
  let server;
  let app;
  let port;
  let vrProjectId;
  let roomAId;
  let roomBId;

  beforeAll(async () => {
    app = createTestApp(pool);
    server = http.createServer(app);
    wsManager.initialize(server, pool);
    app.locals.wsManager = wsManager;
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;

    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ('00000000-0000-0000-0000-000000000000', $1, $2, 'private', $3)
       RETURNING id`,
      [`WS VR Room Scope Test ${Date.now()}`, `ws-vr-room-scope-test-${Date.now()}`, SEED.USER_ADMIN]
    );
    vrProjectId = proj.rows[0].id;
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT DO NOTHING`,
      [vrProjectId, SEED.USER_ADMIN]
    );

    // Main Room is auto-created (public by column default) by the project
    // insert trigger; one_main_room_per_project caps this project at
    // exactly one more room (see roomMembership.test.js's comment), which
    // is all a second, isolated room needs here.
    const main = await pool.query(
      `SELECT id FROM rooms WHERE project_id = $1 AND is_main = true`,
      [vrProjectId]
    );
    roomAId = main.rows[0].id;
    const roomB = await pool.query(
      `INSERT INTO rooms (project_id, name, room_type, is_public, is_main, created_by)
       VALUES ($1, 'Room B', 'breakout', true, false, $2)
       RETURNING id`,
      [vrProjectId, SEED.USER_ADMIN]
    );
    roomBId = roomB.rows[0].id;
  });

  afterAll(async () => {
    if (vrProjectId) {
      await pool.query(`DELETE FROM projects WHERE id = $1`, [vrProjectId]);
    }
    wsManager.shutdown();
    await new Promise((resolve) => server.close(resolve));
  });

  test('a socket in room A receives vr:participant-joined; a socket in room B of the same project does not; participantId is defined', async () => {
    // Do NOT await 'open' separately before authenticateAndJoinRoom — see
    // authenticateAndJoin's comment on why that races the server's
    // synchronous "connected" send.
    const wsA = new WebSocket(`ws://localhost:${port}/ws`);
    await authenticateAndJoinRoom(wsA, roomAId);

    const wsB = new WebSocket(`ws://localhost:${port}/ws`);
    await authenticateAndJoinRoom(wsB, roomBId);

    const receivedB = [];
    wsB.on('message', (data) => {
      try { receivedB.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });

    const sessionRes = await request(app)
      .post('/api/vr/sessions')
      .set(DEV_AUTH_HEADERS)
      .send({ projectId: vrProjectId, roomId: roomAId, deviceId: 'ws-broadcast-owner-device' });
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.room_id).toBe(roomAId);

    const [joinRes, broadcastMsg] = await Promise.all([
      request(app)
        .post(`/api/vr/sessions/${sessionRes.body.id}/join`)
        .set(DEV_AUTH_HEADERS)
        .send({ mode: 'desktop-observer', deviceId: 'ws-broadcast-joiner-device', roomId: roomAId }),
      waitForMessage(wsA, (m) => m.type === 'vr:participant-joined'),
    ]);
    expect(joinRes.status).toBe(200);

    // Payload assertions — the :823 bug fix.
    expect(broadcastMsg.roomId).toBe(roomAId);
    expect(broadcastMsg.participant.participantId).toBeTruthy();
    expect(broadcastMsg.participant.participantId).toBe(
      `${SEED.USER_ADMIN}#ws-broadcast-joiner-device`
    );
    expect(broadcastMsg.participant.accountUserId).toBe(SEED.USER_ADMIN);
    // Deprecated alias still present for one release (VRExplorationManager
    // still reads p.odUserId) — no longer undefined like the old
    // od_user_id-keyed payload.
    expect(broadcastMsg.participant.odUserId).toBe(SEED.USER_ADMIN);

    // Give a short window for any rogue broadcast to reach room B.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const bJoins = receivedB.filter((m) => m.type === 'vr:participant-joined');
    expect(bJoins).toHaveLength(0);

    wsA.close();
    wsB.close();
    await Promise.all([
      new Promise((resolve) => wsA.once('close', resolve)),
      new Promise((resolve) => wsB.once('close', resolve)),
    ]);
  });
});

// File-wide teardown for the `pool` singleton shared by both describe
// blocks above — see the comment on the first suite's afterAll for why this
// isn't closed there instead.
afterAll(async () => {
  if (!pool) return;
  await pool.end();
});
