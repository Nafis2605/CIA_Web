// src/collaboration/yjs/yjsSetup.test.js
// Documents the actual presence-collision behavior of each map:
//   - yCursors is keyed by whatever id the caller passes. Two writes under one
//     id overwrite a single entry — which is why VR presence now passes a
//     per-DEVICE participant id rather than the account id.
//   - yAvatars is keyed by participant id, so two devices on one account are
//     two entries.
//   - Camera/visualization are keyed by viewId, echo-guarded by per-tab
//     clientId, and now also carry a cross-client syncKey.
// No real WebSocket connection is made.

import { describe, test, expect, vi, beforeEach } from 'vitest';

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

import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import {
  ydoc,
  yCursors,
  yCameras,
  yAvatars,
  yVisualizationState,
  yActiveDataset,
  syncCursorToYjs,
  syncCameraToYjs,
  syncAvatarToYjs,
  syncVisualizationToYjs,
  syncActiveDatasetToYjs,
  initializeYjsProvider,
} from './yjsSetup.js';
import { teardownAllObservers } from './yjsObservers.js';

describe('cursor presence (yCursors) — keyed by userId', () => {
  beforeEach(() => {
    yCursors.clear();
  });

  test('two distinct users produce two distinct cursor entries', () => {
    syncCursorToYjs('user-alice', { position: { x: 1, y: 1 } });
    syncCursorToYjs('user-bob', { position: { x: 2, y: 2 } });

    expect(yCursors.size).toBe(2);
    expect(yCursors.get('user-alice').position).toEqual({ x: 1, y: 1 });
    expect(yCursors.get('user-bob').position).toEqual({ x: 2, y: 2 });
  });

  test('one id written twice overwrites a single entry (why presence keys per device)', () => {
    syncCursorToYjs('user-shared', { position: { x: 1, y: 1 } });
    syncCursorToYjs('user-shared', { position: { x: 9, y: 9 } });

    expect(yCursors.size).toBe(1);
    expect(yCursors.get('user-shared').position).toEqual({ x: 9, y: 9 });
  });
});

describe('avatar presence (yAvatars) — keyed per DEVICE, not per account', () => {
  beforeEach(() => {
    yAvatars.clear();
  });

  // The regression this whole change exists for: two headsets signed into ONE
  // account used to write the same yAvatars key, so the map held a single
  // entry that each device's observer then skipped as its own — connected,
  // but permanently invisible to each other.
  test('two devices on one account occupy two entries', () => {
    syncAvatarToYjs('acct-1#device-a', { displayName: 'Fahim (Quest 3 a41f)' });
    syncAvatarToYjs('acct-1#device-b', { displayName: 'Fahim (Quest 3 90c2)' });

    expect(yAvatars.size).toBe(2);
    expect(yAvatars.get('acct-1#device-a').displayName).toBe('Fahim (Quest 3 a41f)');
    expect(yAvatars.get('acct-1#device-b').displayName).toBe('Fahim (Quest 3 90c2)');
  });

  test('the same device rewriting its entry still collapses to one', () => {
    syncAvatarToYjs('acct-1#device-a', { displayName: 'Fahim', isSpeaking: false });
    syncAvatarToYjs('acct-1#device-a', { displayName: 'Fahim', isSpeaking: true });

    expect(yAvatars.size).toBe(1);
    expect(yAvatars.get('acct-1#device-a').isSpeaking).toBe(true);
  });
});

describe('camera presence (yCameras) — keyed by viewId, echo-guarded by clientId', () => {
  beforeEach(() => {
    yCameras.clear();
  });

  test('camera update is keyed by viewId and tagged with this tab clientId', () => {
    syncCameraToYjs('view-1', 'user-alice', { position: [0, 0, 1] });

    const entry = yCameras.get('view-1');
    expect(entry.camera).toEqual({ position: [0, 0, 1] });
    expect(entry.userId).toBe('user-alice');
    expect(entry.clientId).toBe(ydoc.clientID);
  });

  test('same-user multi-tab camera updates still key by viewId, not userId', () => {
    syncCameraToYjs('view-1', 'user-shared', { position: [0, 0, 1] });
    syncCameraToYjs('view-2', 'user-shared', { position: [1, 1, 1] });

    expect(yCameras.size).toBe(2);
    expect(yCameras.get('view-1').camera.position).toEqual([0, 0, 1]);
    expect(yCameras.get('view-2').camera.position).toEqual([1, 1, 1]);
  });

  test('the syncKey rides along so peers with a different viewId can match', () => {
    syncCameraToYjs('view-1', 'user-alice', { position: [0, 0, 1] }, 'dataset-1');
    expect(yCameras.get('view-1').syncKey).toBe('dataset-1');
  });
});

describe('visualization state (yVisualizationState) — nested Y.Map per field (H7)', () => {
  beforeEach(() => {
    yVisualizationState.clear();
  });

  test('stores the syncKey alongside the sender-local viewId, in a nested Y.Map', () => {
    syncVisualizationToYjs('view-1', 'user-alice', { opacity: 0.5 }, 'dataset-1');

    const entry = yVisualizationState.get('view-1');
    expect(entry).toBeInstanceOf(Y.Map);
    expect(entry.get('visualization')).toBeInstanceOf(Y.Map);
    expect(entry.get('visualization').toJSON()).toEqual({ opacity: 0.5 });
    expect(entry.get('syncKey')).toBe('dataset-1');
    expect(entry.get('clientId')).toBe(ydoc.clientID);
  });

  test('partial patches merge, and the syncKey survives the merge', () => {
    syncVisualizationToYjs('view-1', 'user-alice', { opacity: 0.5 }, 'dataset-1');
    syncVisualizationToYjs('view-1', 'user-alice', { representation: 'points' }, 'dataset-1');

    const entry = yVisualizationState.get('view-1');
    expect(entry.get('visualization').toJSON()).toEqual({ opacity: 0.5, representation: 'points' });
    expect(entry.get('syncKey')).toBe('dataset-1');
  });

  test('omitting the syncKey is allowed and records null', () => {
    syncVisualizationToYjs('view-1', 'user-alice', { opacity: 0.5 });
    expect(yVisualizationState.get('view-1').get('syncKey')).toBeNull();
  });

  // H7: the bug this whole nested-map structure exists to fix — two clients
  // patching DIFFERENT fields must not clobber each other, even though both
  // read/wrote against the same viewId "concurrently" (here: back-to-back,
  // simulating the write ordering without needing two real Y.Docs — the
  // per-field CRDT merge is what's under test, not network interleaving).
  test('two disjoint-field patches on the same viewId both survive', () => {
    syncVisualizationToYjs('view-1', 'user-alice', { opacity: 0.9 }, 'dataset-1');
    syncVisualizationToYjs('view-1', 'user-bob', { representation: 'wireframe' }, 'dataset-1');

    const visualization = yVisualizationState.get('view-1').get('visualization').toJSON();
    expect(visualization).toEqual({ opacity: 0.9, representation: 'wireframe' });
  });
});

describe('active dataset (yActiveDataset) — collision-resistant version (H7)', () => {
  beforeEach(() => {
    yActiveDataset.clear();
  });

  // Not "always distinct" — Date.now() has millisecond granularity, so two
  // synchronous back-to-back calls in the same test CAN land on the same ms.
  // What matters (and what the racy incrementing counter got wrong) is that
  // version is derived WITHOUT reading the previous value, so two concurrent
  // writers can never compute the same "next" version from a shared stale
  // read — and the later write always wins outright, with no lost update
  // masked behind a matching version number.
  test('version does not depend on reading the previous value, and the later write wins', () => {
    syncActiveDatasetToYjs('room-1', 'user-alice', { datasetId: 'ds-1' });
    const v1 = yActiveDataset.get('room-1').version;
    expect(typeof v1).toBe('number');

    syncActiveDatasetToYjs('room-1', 'user-bob', { datasetId: 'ds-2' });
    const v2 = yActiveDataset.get('room-1').version;

    expect(v2).toBeGreaterThanOrEqual(v1);
    expect(yActiveDataset.get('room-1').datasetId).toBe('ds-2');
  });

  test('stores updatedBy and clientId for the writer', () => {
    syncActiveDatasetToYjs('room-1', 'user-alice', { datasetId: 'ds-1' });
    const record = yActiveDataset.get('room-1');
    expect(record.updatedBy).toBe('user-alice');
    expect(record.clientId).toBe(ydoc.clientID);
  });
});

describe('provider "sync" event reconnect handling — initializeAllObservers must stay idempotent', () => {
  // initializeYjsProvider() is guarded against re-creating the provider
  // (`if (_provider) return _provider;`), so it only actually runs once for
  // this whole file — this describe block owns that one call.
  test('the "sync" event firing twice (reconnect) does not duplicate observer registration', async () => {
    await initializeYjsProvider();

    const providerInstance = WebsocketProvider.mock.results[0].value;
    const [, syncHandler] = providerInstance.on.mock.calls.find(
      ([event]) => event === 'sync'
    );

    teardownAllObservers();
    const observeSpy = vi.spyOn(yCursors, 'observe');

    // y-websocket fires "sync" on every successful (re)sync, not just the
    // first connection — this simulates a reconnect refiring it.
    syncHandler(true);
    syncHandler(true);

    await vi.waitFor(() => {
      expect(observeSpy).toHaveBeenCalledTimes(1);
    });

    observeSpy.mockRestore();
  });
});
