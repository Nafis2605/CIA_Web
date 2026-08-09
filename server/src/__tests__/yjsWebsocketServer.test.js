// server/src/__tests__/yjsWebsocketServer.test.js
// Integration tests for the standalone Y.js WebSocket server (repo-root
// server.js — NOT this Express API). Covers two regressions:
//   C3: a reconnecting client's sync-step-2 replay (offline edits) must be
//       broadcast to other clients and persisted, not silently applied and
//       dropped.
//   C4: a second client connecting while a room is still loading from the
//       database must not observe (or sync against) the empty pre-load doc.
//
// server.js has no module.exports and starts a real TCP listener + a real
// setInterval on require, so this is a black-box test: real `ws` clients
// speak the real Y.js wire protocol against a real (but test-ported) server
// process, with persistence mocked so no Postgres is required.
//
// Run: cd server && npx jest --testPathPattern="yjsWebsocketServer" --runInBand --forceExit
// --runInBand: this test binds a real port and starts a real setInterval —
//   no value in running it in a worker pool alongside unrelated suites.
// --forceExit: required and intentional. server.js has no test-safe shutdown
//   hook (its own SIGINT/SIGTERM handler calls process.exit(0), which must
//   never be invoked from inside a test process), so the listener + interval
//   are left dangling on purpose once assertions are done.

'use strict';

// MUST be set before requiring server.js. server/src/middleware/auth.js
// computes DEV_BYPASS_AUTH once at import time as
// `NODE_ENV === "development" && DEV_BYPASS_AUTH === "true"` — setting both
// here bypasses Keycloak/room-membership checks so the test doesn't need a
// seeded room_members row. server.js's own `require("dotenv").config()`
// won't override these (dotenv never overwrites already-set process.env
// vars), regardless of whether a stray server/.env exists.
process.env.NODE_ENV = 'development';
process.env.DEV_BYPASS_AUTH = 'true';

// A fixed, unusual port — not 9001 (a real dev instance may be running
// there). server.js has no exported handle to introspect an OS-assigned
// (port 0) ephemeral port after the fact.
process.env.YJS_PORT = '19811';

jest.mock('../services/yjsPersistence');
const { YjsPersistenceService } = require('../services/yjsPersistence');

// Controllable mock persistence. getOrCreateDocument's behavior is
// overridden per-test via mockImplementationOnce/mockResolvedValueOnce.
// Deliberately no `.pool` property: refreshActiveRecordings() and (were it
// reached) checkProjectAccess()/checkRoomDocumentAccess() all early-return on
// `!persistence?.pool`, and the latter two are skipped anyway because
// DEV_BYPASS_AUTH short-circuits them.
const mockPersistence = {
  getOrCreateDocument: jest.fn().mockResolvedValue({
    documentState: null,
    snapshotVersion: 1,
    lastUpdateId: null,
  }),
  storeUpdate: jest.fn().mockResolvedValue({ id: 'update-1', sequenceNum: 1 }),
  storeChatMessage: jest.fn().mockResolvedValue({ id: 'chat-1', timestamp: new Date() }),
  scheduleSnapshots: jest.fn(),
  finalSnapshot: jest.fn().mockResolvedValue(undefined),
};
YjsPersistenceService.create.mockReturnValue(mockPersistence);

const WebSocket = require('ws');
const Y = require('yjs');
const { encoding, decoding } = require('lib0');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const PORT = process.env.YJS_PORT;
const WS_URL = `ws://localhost:${PORT}`;

// Requiring this starts the real server (server.listen(PORT, ...)) — must
// happen last, after all env vars and mocks above are in place.
require('../../../server.js');

// A real 'ws' client can receive its unsolicited initial pushes (sync step 1,
// and an awareness update whenever the room already has ANY awareness state)
// before test code gets around to arming a `.once('message', ...)` listener
// for them — 'message' events are not replayed to listeners added after the
// fact. So every socket gets a permanent listener from the moment it's
// constructed, queuing anything nobody's waiting for yet; `nextMessage()`
// drains the queue first and only falls back to waiting for a fresh event.
function connect(roomName) {
  const ws = new WebSocket(`${WS_URL}/?room=${roomName}`);
  const queue = [];
  let waiter = null;
  ws.on('message', (data) => {
    const bytes = new Uint8Array(data);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(bytes);
    } else {
      queue.push(bytes);
    }
  });
  ws.nextMessage = (timeoutMs = 3000) => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        waiter = null;
        reject(new Error('WS message timeout'));
      }, timeoutMs);
      waiter = (bytes) => {
        clearTimeout(t);
        resolve(bytes);
      };
    });
  };
  // Drain every already-queued/soon-to-arrive unsolicited message (sync step
  // 1, and an awareness push whenever the room already has awareness state)
  // until a short quiet window passes with nothing left — robust to however
  // many the server happens to send, rather than assuming an exact count.
  ws.drainInitial = async (quietMs = 300) => {
    for (;;) {
      try {
        await ws.nextMessage(quietMs);
      } catch {
        return;
      }
    }
  };
  return ws;
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function sendSyncStep1(ws, doc = new Y.Doc()) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
}

describe('Y.js WebSocket server — sync propagation', () => {
  // jest.clearAllMocks() clears call history but preserves the base
  // mockResolvedValue implementations set above at module load — using
  // resetAllMocks here would also wipe those implementations.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a sync-step-2 message from a reconnecting client is broadcast and persisted (C3)', async () => {
    const room = `c3-test-${Date.now()}`;

    // Client B: an ordinary already-connected participant who should observe
    // the reconnecting client's replayed offline edits.
    const clientB = connect(room);
    await waitOpen(clientB);
    // Drain B's initial unsolicited pushes (sync step 1, and an awareness
    // push once this room has any awareness state) before arming the
    // listener for the broadcast we actually care about.
    await clientB.drainInitial();

    // "Client A's" offline edits, made to a separate Y.Doc while disconnected.
    const offlineDoc = new Y.Doc();
    offlineDoc.getMap('visualizationState').set('camera', { x: 1, y: 2, z: 3 });

    // A NEW socket, standing in for client A's resumed session, sends those
    // edits as a real sync-step-2 message (exactly what a reconnecting
    // y-websocket client sends first).
    const clientAReconnect = connect(room);
    await waitOpen(clientAReconnect);
    await clientAReconnect.drainInitial(); // drain its own initial pushes

    const broadcastPromise = clientB.nextMessage();

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep2(encoder, offlineDoc);
    clientAReconnect.send(encoding.toUint8Array(encoder));

    const raw = await broadcastPromise;

    // Decode what B received and confirm it's a real update B can apply.
    const decoder = decoding.createDecoder(raw);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
    const mirror = new Y.Doc();
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), mirror, null);
    expect(mirror.getMap('visualizationState').get('camera')).toEqual({ x: 1, y: 2, z: 3 });

    // Persistence path was exercised (proves storeUpdate/detectUpdateOrigin ran).
    // Room.storeUpdate calls persistence.storeUpdate(roomId, update, origin, userId, clientId).
    expect(mockPersistence.storeUpdate).toHaveBeenCalled();
    const [, , origin] = mockPersistence.storeUpdate.mock.calls.at(-1);
    expect(origin).toBe('document'); // visualizationState is a durable root

    clientB.close();
    clientAReconnect.close();
  });

  test('a second client cannot observe a still-loading room (C4)', async () => {
    const room = `c4-test-${Date.now()}`;

    const seedDoc = new Y.Doc();
    seedDoc.getMap('visualizationState').set('loadedFromDb', true);
    const seededState = Buffer.from(Y.encodeStateAsUpdate(seedDoc));

    let releaseLoad;
    const loadGate = new Promise((resolve) => {
      releaseLoad = resolve;
    });
    mockPersistence.getOrCreateDocument.mockImplementationOnce(async () => {
      await loadGate; // held open until the test calls releaseLoad()
      return { documentState: seededState, snapshotVersion: 2, lastUpdateId: null };
    });

    // Client A triggers room creation + the (currently gated) load.
    const clientA = connect(room);
    await waitOpen(clientA);

    // Client B connects while the load is still pending.
    const clientB = connect(room);
    await waitOpen(clientB);

    // Neither client should receive anything yet — both are blocked on
    // readyPromise before room.clients.add()/sendSyncStep1() ever run.
    const gotEarlyMessage = await clientB.nextMessage(300).then(() => true).catch(() => false);
    expect(gotEarlyMessage).toBe(false);

    releaseLoad();

    // Once load completes, both connections proceed; client B gets the
    // server's unsolicited pushes (sync step 1, and possibly an awareness
    // push), containing the loaded content. Drain everything unsolicited
    // before asking for anything ourselves.
    const pushed = await clientB.nextMessage();
    const decoder = decoding.createDecoder(pushed);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
    await clientB.drainInitial();

    // Round-trip: B now asks the server (its own empty-vector step1) for
    // everything it's missing, proving room.doc really holds the loaded state.
    const replyPromise = clientB.nextMessage();
    sendSyncStep1(clientB);
    const reply = await replyPromise;
    const replyDecoder = decoding.createDecoder(reply);
    expect(decoding.readVarUint(replyDecoder)).toBe(MESSAGE_SYNC);
    const mirror = new Y.Doc();
    syncProtocol.readSyncMessage(replyDecoder, encoding.createEncoder(), mirror, null);
    expect(mirror.getMap('visualizationState').get('loadedFromDb')).toBe(true);

    // Exactly one load happened for this room — client B's concurrent call
    // did NOT trigger (or race) a second getOrCreateDocument call.
    expect(mockPersistence.getOrCreateDocument).toHaveBeenCalledTimes(1);

    // The DB-hydration update was broadcast-but-not-persisted (DB_LOAD_ORIGIN).
    expect(mockPersistence.storeUpdate).not.toHaveBeenCalled();

    clientA.close();
    clientB.close();
  });

  test("disconnect removes and broadcasts exactly the disconnecting client's awareness ID, not room.doc.clientID (C5)", async () => {
    const room = `c5-test-${Date.now()}`;

    const clientB = connect(room);
    await waitOpen(clientB);
    await clientB.drainInitial();

    const clientA = connect(room);
    await waitOpen(clientA);
    await clientA.drainInitial();

    // Client A announces its own awareness state, exactly as a real
    // y-websocket provider does on connect — this is what populates
    // socket.awarenessClientIds server-side for A's connection.
    const aDoc = new Y.Doc();
    const aAwareness = new awarenessProtocol.Awareness(aDoc);
    aAwareness.setLocalState({ user: { name: 'Alice' } });

    const announcePromise = clientB.nextMessage();
    const announceEncoder = encoding.createEncoder();
    encoding.writeVarUint(announceEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      announceEncoder,
      awarenessProtocol.encodeAwarenessUpdate(aAwareness, [aAwareness.clientID])
    );
    clientA.send(encoding.toUint8Array(announceEncoder));

    // Drain B's copy of A's announcement before arming the next listener.
    await announcePromise;

    // Disconnect A — the server must remove and broadcast EXACTLY
    // aAwareness.clientID, never the room's own (unrelated) room.doc.clientID.
    const removalPromise = clientB.nextMessage();
    clientA.close();
    const removed = await removalPromise;

    const removedDecoder = decoding.createDecoder(removed);
    expect(decoding.readVarUint(removedDecoder)).toBe(MESSAGE_AWARENESS);
    const payload = decoding.readVarUint8Array(removedDecoder);
    const payloadDecoder = decoding.createDecoder(payload);

    expect(decoding.readVarUint(payloadDecoder)).toBe(1); // exactly one client removed
    const removedClientId = decoding.readVarUint(payloadDecoder);
    decoding.readVarUint(payloadDecoder); // clock — not asserted
    const removedState = decoding.readVarString(payloadDecoder);

    expect(removedClientId).toBe(aAwareness.clientID);
    expect(removedState).toBe('null'); // JSON-encoded null = "this client is gone"

    clientB.close();
  });
});
