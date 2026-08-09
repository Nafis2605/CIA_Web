// src/collaboration/yjs/__tests__/yjsObservers.visualizationMerge.test.js
// H7: syncVisualizationToYjs used to read-merge-write a PLAIN OBJECT, so two
// clients patching different fields concurrently could have one field
// silently clobbered by Y.js's whole-value last-writer-wins arbitration. The
// fix nests each field in its own Y.Map so Y.js merges at the per-key level.
//
// Two things are pinned here:
//  1. The raw CRDT property, using two independent Y.Docs synced via
//     Y.applyUpdate/Y.encodeStateAsUpdate (the standard multi-client Yjs
//     test pattern) — proves the data structure itself merges correctly,
//     independent of this repo's module wiring.
//  2. The observer wiring (initializeVisualizationObserver), using the real
//     module singleton — proves a remote nested-map change reaches
//     onVisualizationChange callbacks as a plain JS object, and that a
//     legacy pre-migration plain-object entry doesn't crash the observer.

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

describe('two independent Y.Docs — nested Y.Map merges disjoint-field patches (raw CRDT property)', () => {
  function writeVizPatch(doc, viewId, patch) {
    const map = doc.getMap('visualizationState');
    let entry = map.get(viewId);
    if (!(entry instanceof Y.Map)) {
      entry = new Y.Map();
      map.set(viewId, entry);
    }
    let vizMap = entry.get('visualization');
    if (!(vizMap instanceof Y.Map)) {
      vizMap = new Y.Map();
      entry.set('visualization', vizMap);
    }
    for (const [key, value] of Object.entries(patch)) vizMap.set(key, value);
  }

  test('disjoint-field patches from two docs both survive after a two-way sync', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    // Shared baseline, as if both clients had already loaded the same state.
    writeVizPatch(docA, 'view-1', { opacity: 0.5, representation: 'surface' });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Concurrent, DIFFERENT-field patches — neither side has seen the
    // other's change yet (the exact race the bug report described).
    writeVizPatch(docA, 'view-1', { opacity: 0.9 });
    writeVizPatch(docB, 'view-1', { representation: 'wireframe' });

    // Two-way sync.
    const updateFromA = Y.encodeStateAsUpdate(docA);
    const updateFromB = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(docB, updateFromA);
    Y.applyUpdate(docA, updateFromB);

    const resultA = docA.getMap('visualizationState').get('view-1').get('visualization').toJSON();
    const resultB = docB.getMap('visualizationState').get('view-1').get('visualization').toJSON();

    // Both fields present on BOTH sides — neither client's change was lost.
    expect(resultA).toEqual({ opacity: 0.9, representation: 'wireframe' });
    expect(resultB).toEqual({ opacity: 0.9, representation: 'wireframe' });
  });
});

describe('initializeVisualizationObserver — module-singleton wiring', () => {
  let yVisualizationState, ydoc, initializeVisualizationObserver, onVisualizationChange, teardownAllObservers;

  beforeEach(async () => {
    vi.resetModules();
    const setup = await import('../yjsSetup.js');
    const observers = await import('../yjsObservers.js');
    yVisualizationState = setup.yVisualizationState;
    ydoc = setup.ydoc;
    initializeVisualizationObserver = observers.initializeVisualizationObserver;
    onVisualizationChange = observers.onVisualizationChange;
    teardownAllObservers = observers.teardownAllObservers;
    yVisualizationState.clear();
    teardownAllObservers();
  });

  test('a remote nested-map change reaches the callback as a plain JS object', () => {
    const cleanup = initializeVisualizationObserver();
    const cb = vi.fn();
    onVisualizationChange(cb);

    // Simulate a REMOTE write: build the entry on a separate doc (different
    // clientID) and merge it in, exactly like a real incoming Y.js update.
    const remoteDoc = new Y.Doc();
    const remoteMap = remoteDoc.getMap('visualizationState');
    const entry = new Y.Map();
    const vizMap = new Y.Map();
    vizMap.set('opacity', 0.7);
    entry.set('visualization', vizMap);
    entry.set('userId', 'user-remote');
    entry.set('syncKey', 'dataset-1');
    entry.set('clientId', remoteDoc.clientID);
    remoteMap.set('view-1', entry);

    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    expect(cb).toHaveBeenCalledTimes(1);
    const payload = cb.mock.calls[0][0];
    expect(payload.viewId).toBe('view-1');
    expect(payload.visualization).toEqual({ opacity: 0.7 });
    expect(payload.userId).toBe('user-remote');

    cleanup();
  });

  test('a legacy plain-object entry (pre-migration) is skipped, not thrown', () => {
    const cleanup = initializeVisualizationObserver();
    const cb = vi.fn();
    onVisualizationChange(cb);

    expect(() => {
      // Old shape: a plain object, not a Y.Map — as a value persisted before
      // this migration would still be, until the next write overwrites it.
      yVisualizationState.set('view-legacy', {
        visualization: { opacity: 0.3 },
        userId: 'user-old',
        clientId: 'some-other-client',
      });
    }).not.toThrow();

    expect(cb).not.toHaveBeenCalled();
    cleanup();
  });

  test('a second field patched later (not just entry creation) still reaches the callback', () => {
    const cleanup = initializeVisualizationObserver();
    const cb = vi.fn();
    onVisualizationChange(cb);

    const remoteDoc = new Y.Doc();
    const remoteMap = remoteDoc.getMap('visualizationState');
    const entry = new Y.Map();
    const vizMap = new Y.Map();
    vizMap.set('opacity', 0.4);
    entry.set('visualization', vizMap);
    entry.set('clientId', remoteDoc.clientID);
    remoteMap.set('view-2', entry);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));
    cb.mockClear();

    // Patch an EXISTING nested entry in place (no top-level .set on
    // yVisualizationState) — this is what a real second syncVisualizationToYjs
    // call for the same viewId does, and what observeDeep (not observe) is
    // needed to catch.
    remoteDoc.getMap('visualizationState').get('view-2').get('visualization').set('representation', 'points');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].visualization).toEqual({ opacity: 0.4, representation: 'points' });

    cleanup();
  });
});
