// server/src/__tests__/roomDocumentAccess.test.js
// Unit tests for checkRoomDocumentAccess() (repo-root server.js — the
// standalone Y.js WebSocket server), which gates access to Y.js room
// documents. See server.js:1081.
//
// Regression coverage for a real bug: the function used to accept a
// separate, client-supplied `projectId` and trust it on its own whenever
// the primary room-membership check failed. Any authenticated user who
// knew a private room's UUID could pair it with an unrelated project they
// belonged to (`?room=<privateRoomId>&projectId=<anyProjectTheyBelongTo>`)
// and be granted access. The fix removed the `projectId` parameter
// entirely — the room-to-project relationship is now always derived from
// the database (or from roomId's own format for the legacy fallback),
// never from an independently-controlled value.
//
// server.js has no test-friendly exports besides a few additive helpers
// (see the bottom of the file) and starts a real TCP listener + setInterval
// on require, so — like yjsWebsocketServer.test.js — this needs its own
// port and must be run with --forceExit:
//   cd server && npx jest --testPathPattern="roomDocumentAccess" --runInBand --forceExit

'use strict';

process.env.NODE_ENV = 'development';
process.env.DEV_BYPASS_AUTH = 'true';
// Distinct from yjsWebsocketServer.test.js's 19811 so both can run without
// port collisions.
process.env.YJS_PORT = '19812';

jest.mock('../services/yjsPersistence');
const { YjsPersistenceService } = require('../services/yjsPersistence');

const queryMock = jest.fn();
const mockPersistence = {
  pool: { query: queryMock },
  getOrCreateDocument: jest.fn().mockResolvedValue({
    documentState: null,
    snapshotVersion: 1,
    lastUpdateId: null,
  }),
  storeUpdate: jest.fn().mockResolvedValue({ id: 'update-1', sequenceNum: 1 }),
  storeChatMessage: jest.fn().mockResolvedValue({ id: 'chat-1', timestamp: new Date() }),
  scheduleSnapshots: jest.fn(),
  finalSnapshot: jest.fn().mockResolvedValue(undefined),
};
YjsPersistenceService.create.mockReturnValue(mockPersistence);

const { checkRoomDocumentAccess } = require('../../../server.js');

const ROOM_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const PROJECT_A = '33333333-3333-3333-3333-333333333333';

describe('checkRoomDocumentAccess', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test('a room member is allowed and the room real project_id is returned', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ project_id: PROJECT_A }] });
    const result = await checkRoomDocumentAccess(ROOM_ID, USER_ID);
    expect(result).toEqual({ allowed: true, projectId: PROJECT_A });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test('a project member is allowed into a public room in that same project', async () => {
    // Same UNION query covers both "room member" and "public room + project
    // member" — either branch matching returns the room's project_id.
    queryMock.mockResolvedValueOnce({ rows: [{ project_id: PROJECT_A }] });
    const result = await checkRoomDocumentAccess(ROOM_ID, USER_ID);
    expect(result).toEqual({ allowed: true, projectId: PROJECT_A });
  });

  test('regression: a private room the caller is not in is denied, with no way to substitute an unrelated project membership', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // membership/public-room query: no match
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // room exists — it's a real, private room
    const result = await checkRoomDocumentAccess(ROOM_ID, USER_ID);
    expect(result).toEqual({ allowed: false, projectId: null });
    // Must stop after confirming the room exists — never falls through to a
    // project-membership check that an attacker could satisfy with an
    // unrelated project.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  test('legacy bare-UUID room name with no rooms row is allowed via project membership on that same UUID', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // membership/public-room query: no match
      .mockResolvedValueOnce({ rows: [] }) // no `rooms` row for this id
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // project_members match
    const result = await checkRoomDocumentAccess(PROJECT_A, USER_ID);
    expect(result).toEqual({ allowed: true, projectId: PROJECT_A });
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('project_members'),
      [PROJECT_A, USER_ID]
    );
  });

  test('legacy "project:<uuid>" room name is allowed via project membership on the embedded UUID', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // project_members match
    const result = await checkRoomDocumentAccess(`project:${PROJECT_A}`, USER_ID);
    expect(result).toEqual({ allowed: true, projectId: PROJECT_A });
    // "project:<uuid>" never matches the rooms-table UUID column, so only
    // the legacy project_members query runs.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test('no persistence.pool denies access (fail closed, not fail open)', async () => {
    const originalPool = mockPersistence.pool;
    mockPersistence.pool = null;
    try {
      const result = await checkRoomDocumentAccess(ROOM_ID, USER_ID);
      expect(result).toEqual({ allowed: false, projectId: null });
    } finally {
      mockPersistence.pool = originalPool;
    }
  });

  test('a query error denies access (fail closed)', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection reset'));
    const result = await checkRoomDocumentAccess(ROOM_ID, USER_ID);
    expect(result).toEqual({ allowed: false, projectId: null });
  });
});
