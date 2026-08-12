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
// Also covers the follow-up fix: broadcastToWorkspace used to delegate
// straight to broadcastToProject, sending workspace-scoped events (private
// ViewGroup data) to every member of the parent PROJECT, not just members of
// the specific workspace. It now filters recipients by workspace membership
// (via checkWorkspaceAccess, keyed off each socket's userId) before sending.
//
// Pure unit test (no DB/WS server needed) — exercises the new method
// directly against a mocked `pool`/`rooms`/checkWorkspaceAccess, since a
// full integration test would need a live WebSocket client attached to
// assert delivery.

'use strict';

jest.mock('../middleware/auth', () => ({
  DEV_BYPASS_AUTH: false,
  verifyJwtToken: jest.fn(),
  checkWorkspaceAccess: jest.fn(),
}));

const { checkWorkspaceAccess } = require('../middleware/auth');
const wsManager = require('../services/websocket');

describe('WebSocketManager.broadcastToWorkspace', () => {
  let originalPool;
  let originalRooms;

  beforeEach(() => {
    originalPool = wsManager.pool;
    originalRooms = wsManager.rooms;
    wsManager.rooms = new Map();
    checkWorkspaceAccess.mockReset();
  });

  afterEach(() => {
    wsManager.pool = originalPool;
    wsManager.rooms = originalRooms;
  });

  test('is a function (regression guard for the missing-method bug)', () => {
    expect(typeof wsManager.broadcastToWorkspace).toBe('function');
  });

  test('resolves the workspace\'s project and broadcasts {type, ...payload} to sockets whose user has workspace access', async () => {
    const projectId = 'project-123';
    const workspaceId = 'workspace-456';
    const fakeSocket = { readyState: 1 /* WebSocket.OPEN */, userId: 'user-1', send: jest.fn() };
    wsManager.rooms.set(projectId, new Set([fakeSocket]));
    wsManager.pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ project_id: projectId }] }),
    };
    checkWorkspaceAccess.mockResolvedValue({ allowed: true, role: 'owner' });

    await wsManager.broadcastToWorkspace(workspaceId, 'viewgroup:created', {
      viewGroup: { id: 'vg-1' },
    });

    expect(wsManager.pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT project_id FROM workspaces WHERE id = $1'),
      [workspaceId]
    );
    expect(checkWorkspaceAccess).toHaveBeenCalledWith(wsManager.pool, workspaceId, 'user-1');
    expect(fakeSocket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fakeSocket.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: 'viewgroup:created', viewGroup: { id: 'vg-1' } });
  });

  test('does NOT deliver to a project-room socket whose user lacks access to this workspace', async () => {
    const projectId = 'project-123';
    const workspaceId = 'workspace-456';
    const memberSocket = { readyState: 1, userId: 'member-user', send: jest.fn() };
    const outsiderSocket = { readyState: 1, userId: 'outsider-user', send: jest.fn() };
    wsManager.rooms.set(projectId, new Set([memberSocket, outsiderSocket]));
    wsManager.pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ project_id: projectId }] }),
    };
    checkWorkspaceAccess.mockImplementation(async (_pool, _workspaceId, userId) => ({
      allowed: userId === 'member-user',
      role: userId === 'member-user' ? 'editor' : null,
    }));

    await wsManager.broadcastToWorkspace(workspaceId, 'viewgroup:updated', {
      viewGroup: { id: 'vg-1' },
    });

    expect(memberSocket.send).toHaveBeenCalledTimes(1);
    expect(outsiderSocket.send).not.toHaveBeenCalled();
  });

  test('skips sockets with no userId (unauthenticated) without throwing', async () => {
    const projectId = 'project-123';
    const anonSocket = { readyState: 1, send: jest.fn() }; // no userId
    wsManager.rooms.set(projectId, new Set([anonSocket]));
    wsManager.pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ project_id: projectId }] }),
    };

    await expect(
      wsManager.broadcastToWorkspace('workspace-456', 'viewgroup:created', {})
    ).resolves.toBeUndefined();
    expect(anonSocket.send).not.toHaveBeenCalled();
    expect(checkWorkspaceAccess).not.toHaveBeenCalled();
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
