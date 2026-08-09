// src/collaboration/yjs/__tests__/yjsObservers.activeDatasetOverride.test.js
// H7: syncActiveDatasetToYjs is last-writer-wins on the whole value, which is
// correct for an exclusive "active dataset" selection — but the losing
// client used to get zero signal that its selection didn't stick. The fix
// uses Y.js's built-in oldValue (carried on 'update'/'delete' YMapEvent
// changes) to detect, with no extra bookkeeping, when THIS client's own
// very-recent write was raced out by another client's concurrent write.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

vi.mock('y-websocket', () => ({
  WebsocketProvider: vi.fn().mockImplementation(function () {
    return { on: vi.fn() };
  }),
}));

vi.mock('@Core/config/clientConfig.js', () => ({
  default: { devBypassAuth: true, yjsWebSocketUrl: 'ws://localhost:9001' },
}));

vi.mock('@Core/session/sessionManager', () => ({
  sessionManager: {
    getRoomId: vi.fn(() => 'test-room'),
    getUserId: vi.fn(() => 'test-user'),
    getProjectId: vi.fn(() => 'test-project'),
  },
}));

vi.mock('@Services/authService.js', () => ({
  authService: {
    getUser: vi.fn(() => ({ id: 'test-user', name: 'Test User' })),
    getAccessToken: vi.fn(async () => null),
  },
}));

vi.mock('@Collaboration/presence/userManagement.js', () => ({
  getUserId: vi.fn(() => 'test-user'),
  getParticipantId: vi.fn(() => 'test-user#device-1'),
}));

vi.mock('@Utils/logger.js', () => ({
  sync: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe('initializeActiveDatasetObserver — overroteLocalSelection detection', () => {
  let yActiveDataset, ydoc, syncActiveDatasetToYjs, initializeActiveDatasetObserver, onActiveDatasetChange, teardownAllObservers;

  beforeEach(async () => {
    vi.resetModules();
    const setup = await import('../yjsSetup.js');
    const observers = await import('../yjsObservers.js');
    yActiveDataset = setup.yActiveDataset;
    ydoc = setup.ydoc;
    syncActiveDatasetToYjs = setup.syncActiveDatasetToYjs;
    initializeActiveDatasetObserver = observers.initializeActiveDatasetObserver;
    onActiveDatasetChange = observers.onActiveDatasetChange;
    teardownAllObservers = observers.teardownAllObservers;
    yActiveDataset.clear();
    teardownAllObservers();
  });

  test('a client\'s own write superseded shortly after by another client yields overroteLocalSelection: true', () => {
    const cleanup = initializeActiveDatasetObserver();
    const cb = vi.fn();
    onActiveDatasetChange(cb);

    // Our own local write.
    syncActiveDatasetToYjs('room-1', 'user-me', { datasetId: 'ds-mine' });

    // A remote client's write races ours out — synced to our state FIRST
    // (so its write is causally after ours, like a real message that lands
    // moments later) and built on a separate doc/clientID.
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(ydoc));
    remoteDoc.getMap('activeDataset').set('room-1', {
      datasetId: 'ds-theirs',
      version: Date.now(),
      updatedBy: 'user-other',
      updatedAt: Date.now(),
      clientId: remoteDoc.clientID,
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    expect(cb).toHaveBeenCalledTimes(1);
    const payload = cb.mock.calls[0][0];
    expect(payload.datasetId).toBe('ds-theirs');
    expect(payload.overroteLocalSelection).toBe(true);

    cleanup();
  });

  test('a normal (non-racing) remote dataset switch yields overroteLocalSelection: false', () => {
    const cleanup = initializeActiveDatasetObserver();
    const cb = vi.fn();
    onActiveDatasetChange(cb);

    // No prior local write for this room — first entry ever, written by someone else.
    const remoteDoc = new Y.Doc();
    remoteDoc.getMap('activeDataset').set('room-1', {
      datasetId: 'ds-theirs',
      version: Date.now(),
      updatedBy: 'user-other',
      updatedAt: Date.now(),
      clientId: remoteDoc.clientID,
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].overroteLocalSelection).toBe(false);

    cleanup();
  });

  test('a remote switch that follows another REMOTE write (not ours) is not flagged as overriding us', () => {
    const cleanup = initializeActiveDatasetObserver();
    const cb = vi.fn();
    onActiveDatasetChange(cb);

    const remoteDoc = new Y.Doc();
    remoteDoc.getMap('activeDataset').set('room-1', {
      datasetId: 'ds-first',
      version: 1,
      updatedBy: 'user-a',
      updatedAt: Date.now(),
      clientId: remoteDoc.clientID,
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));
    cb.mockClear();

    remoteDoc.getMap('activeDataset').set('room-1', {
      datasetId: 'ds-second',
      version: 2,
      updatedBy: 'user-b',
      updatedAt: Date.now(),
      clientId: remoteDoc.clientID,
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].overroteLocalSelection).toBe(false);

    cleanup();
  });
});
