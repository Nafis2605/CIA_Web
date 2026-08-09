// src/collaboration/yjs/__tests__/collaborationViewRegistry.test.js
// H5: collaborationViewId is a new, genuinely shared per-view identity,
// distinct from viewConfigId (minted per-client) and datasetId (shared by
// content). Claimed the first time any client resolves a dataset-based
// syncKey with no existing record; every later client for that syncKey
// adopts the existing id. Modeled directly on vrSessionRegistry.test.js's
// coverage of claimVRSession. No real WebSocket connection is made.

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
  yCollaborationViews,
  getCollaborationViewId,
  claimCollaborationViewId,
} from '../yjsSetup.js';

describe('collaboration view registry (yCollaborationViews) — keyed by dataset-based syncKey', () => {
  beforeEach(() => {
    yCollaborationViews.clear();
  });

  test('claimCollaborationViewId mints and writes an id when the slot is empty', () => {
    const id = claimCollaborationViewId('dataset-1', 'alice');

    expect(id).toBeTruthy();
    expect(yCollaborationViews.get('dataset-1').collaborationViewId).toBe(id);
    expect(yCollaborationViews.get('dataset-1').mintedBy).toBe('alice');
  });

  test('a later claim for the same syncKey adopts the existing id, not a new one', () => {
    const first = claimCollaborationViewId('dataset-1', 'alice');
    const second = claimCollaborationViewId('dataset-1', 'bob');

    expect(second).toBe(first);
    expect(yCollaborationViews.get('dataset-1').mintedBy).toBe('alice'); // unchanged
  });

  test('different syncKeys get different ids', () => {
    const a = claimCollaborationViewId('dataset-1', 'alice');
    const b = claimCollaborationViewId('dataset-2', 'alice');

    expect(a).not.toBe(b);
  });

  test('claimCollaborationViewId returns null for a falsy syncKey', () => {
    expect(claimCollaborationViewId(null, 'alice')).toBeNull();
    expect(claimCollaborationViewId(undefined, 'alice')).toBeNull();
  });

  test('getCollaborationViewId returns the claimed id', () => {
    const id = claimCollaborationViewId('dataset-1', 'alice');
    expect(getCollaborationViewId('dataset-1')).toBe(id);
  });

  test('getCollaborationViewId returns null when nothing has claimed the key yet', () => {
    expect(getCollaborationViewId('dataset-unclaimed')).toBeNull();
    expect(getCollaborationViewId(null)).toBeNull();
  });
});
