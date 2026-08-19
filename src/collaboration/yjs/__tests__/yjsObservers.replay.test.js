// src/collaboration/yjs/__tests__/yjsObservers.replay.test.js
// Phase C2 of the VR room-scoping/join-correctness plan: late-join
// hydration. initializeVisualizationObserver/initializeCameraObserver are
// delta-only — .observeDeep()/.observe() only ever fire on a CHANGE, so
// anything written to yVisualizationState/yCameras before a client's
// observer attached is otherwise invisible to it. replayVisualizationState/
// replayCameraState/hydrateFromYjs close that gap by reading whatever is
// CURRENTLY stored and pushing it through the exact same
// visualizationChangeCallbacks/cameraChangeCallbacks fan-out the live
// observers use — no second code path interprets a stored entry.
//
// Pinned here:
//  - replay fans out through the same callbacks the observer uses
//  - self-echo (this connection's own write) is skipped, same as the observer
//  - a legacy non-Y.Map entry is skipped, same as the observer
//  - minRevision suppresses an entry explicitly stamped at or below it
//  - an UNSTAMPED entry (no revision field) is NOT suppressed by minRevision
//    — see _emitVisualizationEntry's docstring in yjsObservers.js for why
//    "unstamped counts as newer than the snapshot" was chosen over
//    "unstamped counts as stale": the alternative would silently drop a
//    live editor's in-flight change on every late-joiner hydration.

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

describe('yjsObservers replay (late-join hydration)', () => {
  let yVisualizationState, yCameras, ydoc, syncVisualizationToYjs, syncCameraToYjs;
  let replayVisualizationState, replayCameraState, hydrateFromYjs;
  let onVisualizationChange, onCameraChange, initializeVisualizationObserver, initializeCameraObserver;
  let teardownAllObservers;

  beforeEach(async () => {
    vi.resetModules();
    const setup = await import('../yjsSetup.js');
    const observers = await import('../yjsObservers.js');

    yVisualizationState = setup.yVisualizationState;
    yCameras = setup.yCameras;
    ydoc = setup.ydoc;
    syncVisualizationToYjs = setup.syncVisualizationToYjs;
    syncCameraToYjs = setup.syncCameraToYjs;

    replayVisualizationState = observers.replayVisualizationState;
    replayCameraState = observers.replayCameraState;
    hydrateFromYjs = observers.hydrateFromYjs;
    onVisualizationChange = observers.onVisualizationChange;
    onCameraChange = observers.onCameraChange;
    initializeVisualizationObserver = observers.initializeVisualizationObserver;
    initializeCameraObserver = observers.initializeCameraObserver;
    teardownAllObservers = observers.teardownAllObservers;

    yVisualizationState.clear();
    yCameras.clear();
    teardownAllObservers();
  });

  /** Write a REMOTE (different clientID) visualization entry, merged in like a real incoming Y.js update. */
  function writeRemoteVisualizationEntry(viewId, { visualization, userId = 'user-remote', syncKey = 'dataset-1', revision } = {}) {
    const remoteDoc = new Y.Doc();
    const remoteMap = remoteDoc.getMap('visualizationState');
    const entry = new Y.Map();
    const vizMap = new Y.Map();
    for (const [k, v] of Object.entries(visualization || {})) vizMap.set(k, v);
    entry.set('visualization', vizMap);
    entry.set('userId', userId);
    entry.set('syncKey', syncKey);
    entry.set('clientId', remoteDoc.clientID);
    if (revision !== undefined) entry.set('revision', revision);
    remoteMap.set(viewId, entry);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));
  }

  function writeRemoteCameraEntry(viewId, { camera, userId = 'user-remote', syncKey = 'dataset-1' } = {}) {
    const remoteDoc = new Y.Doc();
    const remoteMap = remoteDoc.getMap('cameras');
    remoteMap.set(viewId, { camera, userId, syncKey, clientId: remoteDoc.clientID });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));
  }

  describe('replayVisualizationState', () => {
    test('replays a pre-existing remote entry through the same callback the observer uses', () => {
      writeRemoteVisualizationEntry('view-1', { visualization: { opacity: 0.5 } });

      // No observer attached — proves replay does not depend on the live
      // observer having been installed first (the whole point of hydration).
      const cb = vi.fn();
      onVisualizationChange(cb);

      const count = replayVisualizationState();

      expect(count).toBe(1);
      expect(cb).toHaveBeenCalledTimes(1);
      const payload = cb.mock.calls[0][0];
      expect(payload.viewId).toBe('view-1');
      expect(payload.visualization).toEqual({ opacity: 0.5 });
      expect(payload.userId).toBe('user-remote');
      expect(payload.syncKey).toBe('dataset-1');
    });

    test('fans out through the SAME callback array a live observer uses', () => {
      const cleanup = initializeVisualizationObserver();
      const cb = vi.fn();
      onVisualizationChange(cb);

      writeRemoteVisualizationEntry('view-1', { visualization: { opacity: 0.4 } });
      // The observer already delivered this one (it was written AFTER attach).
      expect(cb).toHaveBeenCalledTimes(1);
      cb.mockClear();

      // Replaying the same still-present entry reuses the identical callback
      // registry — not a parallel one — so it fires again through the exact
      // same subscribers.
      const count = replayVisualizationState();
      expect(count).toBe(1);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].visualization).toEqual({ opacity: 0.4 });

      cleanup();
    });

    test('self-echo (this connection´s own write) is skipped, same as the observer', () => {
      // syncVisualizationToYjs stamps clientId: ydoc.clientID — this IS "our"
      // connection from the replay's point of view.
      syncVisualizationToYjs('view-self', 'test-user', { opacity: 0.9 }, 'dataset-1');

      const cb = vi.fn();
      onVisualizationChange(cb);

      const count = replayVisualizationState();

      expect(count).toBe(0);
      expect(cb).not.toHaveBeenCalled();
    });

    test('a legacy non-Y.Map entry is skipped, not thrown', () => {
      yVisualizationState.set('view-legacy', {
        visualization: { opacity: 0.3 },
        userId: 'user-old',
        clientId: 'some-other-client',
      });

      const cb = vi.fn();
      onVisualizationChange(cb);

      expect(() => replayVisualizationState()).not.toThrow();
      expect(replayVisualizationState()).toBe(0);
      expect(cb).not.toHaveBeenCalled();
    });

    test('minRevision suppresses an entry explicitly stamped at or below it', () => {
      writeRemoteVisualizationEntry('view-rev', { visualization: { opacity: 0.7 }, revision: 5 });

      const cb = vi.fn();
      onVisualizationChange(cb);

      // Stale relative to a revision-5 (or newer) server snapshot.
      expect(replayVisualizationState(null, { minRevision: 5 })).toBe(0);
      expect(replayVisualizationState(null, { minRevision: 9 })).toBe(0);
      expect(cb).not.toHaveBeenCalled();

      // Newer than the snapshot — must survive.
      expect(replayVisualizationState(null, { minRevision: 4 })).toBe(1);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].visualization).toEqual({ opacity: 0.7 });
    });

    test('an UNSTAMPED entry (no revision field) is treated as newer than the snapshot, not suppressed', () => {
      // No `revision` passed — mirrors a write from a share mode with
      // nothing to persist to, or a pre-deployment writer.
      writeRemoteVisualizationEntry('view-unstamped', { visualization: { opacity: 0.2 } });

      const cb = vi.fn();
      onVisualizationChange(cb);

      const count = replayVisualizationState(null, { minRevision: 100 });

      expect(count).toBe(1);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].visualization).toEqual({ opacity: 0.2 });
    });

    test('an explicit viewIds filter only replays the listed entries', () => {
      writeRemoteVisualizationEntry('view-a', { visualization: { opacity: 0.1 } });
      writeRemoteVisualizationEntry('view-b', { visualization: { opacity: 0.2 } });

      const cb = vi.fn();
      onVisualizationChange(cb);

      const count = replayVisualizationState(['view-a']);

      expect(count).toBe(1);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].viewId).toBe('view-a');
    });
  });

  describe('replayCameraState', () => {
    test('replays a pre-existing remote camera entry through the same callback the observer uses', () => {
      writeRemoteCameraEntry('view-1', { camera: { position: [1, 2, 3] } });

      const cb = vi.fn();
      onCameraChange(cb);

      const count = replayCameraState();

      expect(count).toBe(1);
      expect(cb).toHaveBeenCalledTimes(1);
      const payload = cb.mock.calls[0][0];
      expect(payload.viewId).toBe('view-1');
      expect(payload.camera).toEqual({ position: [1, 2, 3] });
      expect(payload.userId).toBe('user-remote');
    });

    test('fans out through the SAME callback array a live camera observer uses', () => {
      const cleanup = initializeCameraObserver();
      const cb = vi.fn();
      onCameraChange(cb);

      writeRemoteCameraEntry('view-1', { camera: { position: [4, 5, 6] } });
      expect(cb).toHaveBeenCalledTimes(1);
      cb.mockClear();

      const count = replayCameraState();
      expect(count).toBe(1);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].camera).toEqual({ position: [4, 5, 6] });

      cleanup();
    });

    test('self-echo is skipped', () => {
      syncCameraToYjs('view-self', 'test-user', { position: [0, 0, 0] }, 'dataset-1');

      const cb = vi.fn();
      onCameraChange(cb);

      expect(replayCameraState()).toBe(0);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('hydrateFromYjs', () => {
    test('replays both visualization and camera state and returns their counts', () => {
      writeRemoteVisualizationEntry('view-1', { visualization: { opacity: 0.5 } });
      writeRemoteCameraEntry('view-1', { camera: { position: [1, 1, 1] } });

      const vizCb = vi.fn();
      const cameraCb = vi.fn();
      onVisualizationChange(vizCb);
      onCameraChange(cameraCb);

      const result = hydrateFromYjs();

      expect(result).toEqual({ visualization: 1, camera: 1 });
      expect(vizCb).toHaveBeenCalledTimes(1);
      expect(cameraCb).toHaveBeenCalledTimes(1);
    });

    test('threads minRevision through to the visualization replay only', () => {
      writeRemoteVisualizationEntry('view-1', { visualization: { opacity: 0.5 }, revision: 10 });
      writeRemoteCameraEntry('view-1', { camera: { position: [1, 1, 1] } });

      const vizCb = vi.fn();
      const cameraCb = vi.fn();
      onVisualizationChange(vizCb);
      onCameraChange(cameraCb);

      const result = hydrateFromYjs({ minRevision: 10 });

      // Visualization suppressed as stale; camera (no revision concept) still applies.
      expect(result).toEqual({ visualization: 0, camera: 1 });
      expect(vizCb).not.toHaveBeenCalled();
      expect(cameraCb).toHaveBeenCalledTimes(1);
    });
  });
});
