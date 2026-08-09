// server/src/__tests__/ws-app-ws-alias.test.js
// H16: webpack's dev server proxies /app-ws -> the API server's real /ws
// path (mounted at a different name there only because webpack-dev-server's
// own HMR socket already owns /ws). The production Express server has no
// equivalent proxy, so a relative-URL production deployment (frontend and
// API served from the same origin/process) couldn't reach the live
// broadcast socket at all. The fix makes the SAME WebSocketManager accept
// upgrades at both /ws and /app-ws directly, since it's already the same
// process — no new network hop needed.
//
// DB-independent: only the upgrade-path routing is under test here, not
// authenticated broadcast behavior, so this runs without TEST_DATABASE_URL.

'use strict';

const http = require('http');
const WebSocket = require('ws');
const wsManager = require('../services/websocket');

function waitForOpenAndMessage(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error(`Timed out waiting for a message from ${url}`));
    }, timeoutMs);

    client.on('message', (data) => {
      clearTimeout(timer);
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        client.close();
        reject(err);
        return;
      }
      client.close();
      resolve(msg);
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('WebSocketManager /app-ws production alias (H16)', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    wsManager.initialize(server, null);
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    wsManager.shutdown();
    await new Promise((resolve) => server.close(resolve));
  });

  test('connecting to /ws receives the connected welcome message', async () => {
    const msg = await waitForOpenAndMessage(`ws://localhost:${port}/ws`);
    expect(msg.type).toBe('connected');
  });

  test('connecting to /app-ws also receives the connected welcome message (the alias)', async () => {
    const msg = await waitForOpenAndMessage(`ws://localhost:${port}/app-ws`);
    expect(msg.type).toBe('connected');
  });

  test('connecting to an unrelated path is rejected instead of hanging', async () => {
    await expect(
      waitForOpenAndMessage(`ws://localhost:${port}/not-a-real-path`, 1500)
    ).rejects.toThrow();
  });
});
