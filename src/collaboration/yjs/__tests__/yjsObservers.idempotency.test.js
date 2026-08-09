// src/collaboration/yjs/__tests__/yjsObservers.idempotency.test.js
// initializeAllObservers() used to be called once from yjsSetup.js's
// provider.on("sync", ...) listener (which refires on every reconnect) AND
// once from appInitializer.js's Phase 2 Step 4 — with no guard, each call
// stacked another full set of .observe() callbacks onto the same Y.Maps
// permanently. This pins the fix: re-entrant calls are no-ops, and
// teardownAllObservers() actually unobserves everything.
// No real WebSocket connection is made (mirrors yjsSetup.test.js).

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
  getParticipantId: vi.fn(() => 'test-user#device-1'),
}));

vi.mock('@Utils/logger.js', () => ({
  sync: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { yCursors, syncCursorToYjs } from '../yjsSetup.js';
import { initializeAllObservers, teardownAllObservers, onCursorChange } from '../yjsObservers.js';

describe('Y.js observer idempotency (initializeAllObservers / teardownAllObservers)', () => {
  beforeEach(() => {
    yCursors.clear();
    teardownAllObservers();
  });

  test('calling initializeAllObservers twice only registers one underlying observer', () => {
    const observeSpy = vi.spyOn(yCursors, 'observe');

    initializeAllObservers();
    initializeAllObservers(); // simulates a reconnect refiring "sync"

    expect(observeSpy).toHaveBeenCalledTimes(1);
    observeSpy.mockRestore();
  });

  test('a change dispatched after multiple init calls only invokes callbacks once per change', () => {
    initializeAllObservers();
    initializeAllObservers();
    initializeAllObservers();

    const cb = vi.fn();
    onCursorChange(cb);

    syncCursorToYjs('user-remote', { position: { x: 1, y: 1 } });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('teardownAllObservers unobserves everything and allows a clean re-init', () => {
    initializeAllObservers();

    const unobserveSpy = vi.spyOn(yCursors, 'unobserve');
    teardownAllObservers();
    expect(unobserveSpy).toHaveBeenCalledTimes(1);
    unobserveSpy.mockRestore();

    // Re-init after teardown must register exactly one observer again, not zero.
    const observeSpy = vi.spyOn(yCursors, 'observe');
    initializeAllObservers();
    expect(observeSpy).toHaveBeenCalledTimes(1);
    observeSpy.mockRestore();
  });

  test('teardownAllObservers stops delivering further changes', () => {
    initializeAllObservers();

    const cb = vi.fn();
    onCursorChange(cb);

    teardownAllObservers();
    syncCursorToYjs('user-remote', { position: { x: 5, y: 5 } });

    expect(cb).not.toHaveBeenCalled();
  });
});
