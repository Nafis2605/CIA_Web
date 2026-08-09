// server/src/__tests__/annotationBroadcastPayload.test.js
// H9: the annotation-deletion broadcast was missing the syncEventId field
// that create/update broadcasts already carry, so a client had no sequence
// number to advance its gap-recovery watermark on delete. Unit-level (no DB,
// no live WebSocket server — the manager's constructor is side-effect-free
// until .initialize() is called) — spies on broadcastToProject to inspect
// the payload shape each broadcast method actually sends.

'use strict';

const wsManager = require('../services/websocket');

describe('WebSocketManager annotation broadcast payload shape', () => {
  let broadcastSpy;

  beforeEach(() => {
    broadcastSpy = jest.spyOn(wsManager, 'broadcastToProject').mockImplementation(() => {});
  });

  afterEach(() => {
    broadcastSpy.mockRestore();
  });

  test('annotationCreated includes syncEventId and actorUserId', () => {
    wsManager.annotationCreated('project-1', 'file-1', { id: 'ann-1' }, 42n, 'user-1');

    const [, payload] = broadcastSpy.mock.calls[0];
    expect(payload.syncEventId).toBe('42');
    expect(payload.actorUserId).toBe('user-1');
  });

  test('annotationUpdated includes syncEventId and actorUserId', () => {
    wsManager.annotationUpdated('project-1', 'file-1', { id: 'ann-1', revision: 2 }, 43n, 'user-1');

    const [, payload] = broadcastSpy.mock.calls[0];
    expect(payload.syncEventId).toBe('43');
    expect(payload.actorUserId).toBe('user-1');
  });

  test('annotationDeleted now also includes syncEventId and actorUserId, matching created/updated', () => {
    wsManager.annotationDeleted('project-1', 'file-1', 'ann-1', 44n, 'user-1');

    const [, payload] = broadcastSpy.mock.calls[0];
    expect(payload.type).toBe('annotation:deleted');
    expect(payload.annotationId).toBe('ann-1');
    expect(payload.syncEventId).toBe('44');
    expect(payload.actorUserId).toBe('user-1');
  });

  test('annotationDeleted defaults syncEventId/actorUserId to null when omitted', () => {
    wsManager.annotationDeleted('project-1', 'file-1', 'ann-1');

    const [, payload] = broadcastSpy.mock.calls[0];
    expect(payload.syncEventId).toBeNull();
    expect(payload.actorUserId).toBeNull();
  });
});
