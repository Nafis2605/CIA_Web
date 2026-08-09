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
  WebsocketProvider: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('@Core/config/clientConfig.js', () => ({
  default: { devBypassAuth: true, yjsWebSocketUrl: 'ws://localhost:9001' },
}));

vi.mock('@Core/session/sessionManager', () => ({
  sessionManager: {
    getRoomId: vi.fn(() => 'test-room'),
    getUserId: vi.fn(() => 'test-user'),
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
}));

vi.mock('@Utils/logger.js', () => ({
  sync: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  ydoc,
  yCursors,
  yCameras,
  yAvatars,
  yVisualizationState,
  syncCursorToYjs,
  syncCameraToYjs,
  syncAvatarToYjs,
  syncVisualizationToYjs,
} from './yjsSetup.js';

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

describe('visualization state (yVisualizationState) — carries the cross-client syncKey', () => {
  beforeEach(() => {
    yVisualizationState.clear();
  });

  test('stores the syncKey alongside the sender-local viewId', () => {
    syncVisualizationToYjs('view-1', 'user-alice', { opacity: 0.5 }, 'dataset-1');

    const entry = yVisualizationState.get('view-1');
    expect(entry.visualization).toEqual({ opacity: 0.5 });
    expect(entry.syncKey).toBe('dataset-1');
    expect(entry.clientId).toBe(ydoc.clientID);
  });

  test('partial patches merge, and the syncKey survives the merge', () => {
    syncVisualizationToYjs('view-1', 'user-alice', { opacity: 0.5 }, 'dataset-1');
    syncVisualizationToYjs('view-1', 'user-alice', { representation: 'points' }, 'dataset-1');

    const entry = yVisualizationState.get('view-1');
    expect(entry.visualization).toEqual({ opacity: 0.5, representation: 'points' });
    expect(entry.syncKey).toBe('dataset-1');
  });

  test('omitting the syncKey is allowed and records null', () => {
    syncVisualizationToYjs('view-1', 'user-alice', { opacity: 0.5 });
    expect(yVisualizationState.get('view-1').syncKey).toBeNull();
  });
});
