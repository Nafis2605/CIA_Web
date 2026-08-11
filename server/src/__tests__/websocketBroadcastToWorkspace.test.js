// server/src/__tests__/websocketBroadcastToWorkspace.test.js
// wsManager.broadcastToWorkspace(workspaceId, type, payload) is called at 7
// sites in server/src/routes/viewgroups.js (viewgroup create/delete/
// duplicate, view-link create/delete, vg-link create/delete) but the method
// never existed on WebSocketManager — every one of those calls threw
// `TypeError: wsManager.broadcastToWorkspace is not a function`, turning an
// otherwise-successful write into a 500 the instant it tried to notify
// collaborators. Reproduced live: POST /api/workspaces/:id/viewgroups
// against the running API returned 500 with exactly this error after an
// unrelated mergeParams routing bug in the same handler was fixed.
//
// Pure unit test (no DB/WS server needed) — exercises the new method
// directly against a mocked `pool` and `rooms`, since a full integration
// test would need a live WebSocket client attached to assert delivery.

'use strict';

const wsManager = require('../services/websocket');

describe('WebSocketManager.broadcastToWorkspace', () => {
  let originalPool;
  let originalRooms;

  beforeEach(() => {
    originalPool = wsManager.pool;
    originalRooms = wsManager.rooms;
    wsManager.rooms = new Map();
  });

  afterEach(() => {
    wsManager.pool = originalPool;
    wsManager.rooms = originalRooms;
  });

  test('is a function (regression guard for the missing-method bug)', () => {
    expect(typeof wsManager.broadcastToWorkspace).toBe('function');
  });

  test('resolves the workspace\'s project and broadcasts {type, ...payload} to it', async () => {
    const projectId = 'project-123';
    const workspaceId = 'workspace-456';
    const fakeSocket = { readyState: 1 /* WebSocket.OPEN */, send: jest.fn() };
    wsManager.rooms.set(projectId, new Set([fakeSocket]));
    wsManager.pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ project_id: projectId }] }),
    };

    await wsManager.broadcastToWorkspace(workspaceId, 'viewgroup:created', {
      viewGroup: { id: 'vg-1' },
    });

    expect(wsManager.pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT project_id FROM workspaces WHERE id = $1'),
      [workspaceId]
    );
    expect(fakeSocket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fakeSocket.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: 'viewgroup:created', viewGroup: { id: 'vg-1' } });
  });

  test('silently no-ops for a personal workspace (project_id IS NULL)', async () => {
    wsManager.pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ project_id: null }] }),
    };

    await expect(
      wsManager.broadcastToWorkspace('personal-workspace-1', 'viewgroup:deleted', {
        viewGroupId: 'vg-1',
      })
    ).resolves.toBeUndefined();
  });

  test('swallows a DB error instead of throwing (broadcast is best-effort)', async () => {
    wsManager.pool = {
      query: jest.fn().mockRejectedValue(new Error('connection lost')),
    };

    await expect(
      wsManager.broadcastToWorkspace('workspace-456', 'viewgroup:created', {})
    ).resolves.toBeUndefined();
  });

  test('no-ops when pool is unavailable', async () => {
    wsManager.pool = null;
    await expect(
      wsManager.broadcastToWorkspace('workspace-456', 'viewgroup:created', {})
    ).resolves.toBeUndefined();
  });
});
