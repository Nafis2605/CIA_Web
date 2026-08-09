// src/core/session/__tests__/sessionManager.test.js
// Unit tests for SessionManager project+room resolution and async validation.
// No PostgreSQL required — fetch is mocked.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock config before importing SessionManager ──────────────────────────

vi.mock('@Core/config/clientConfig.js', () => ({
  config: { defaultSessionId: 'default-session-id', defaultProjectId: 'default-project-id' },
}));

vi.mock('@Utils/logger.js', () => ({
  auth: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ─── Import after mocks ───────────────────────────────────────────────────

// We import the class by re-instantiating for isolation
// The module exports a singleton, so we test the behavior by resetting state
import { sessionManager } from '../sessionManager.js';

// ─── Test constants ───────────────────────────────────────────────────────

const PROJECT_ID = 'proj-111';
const ROOM_UUID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MAIN_ROOM  = { id: 'main-room-id', name: 'Main Room', is_main: true, room_type: 'main' };

// ─── Helpers ──────────────────────────────────────────────────────────────

function setLocation(pathname, search = '') {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { pathname, search, href: `https://localhost${pathname}${search}` },
  });
}

function resetSessionManager() {
  sessionManager.projectId = null;
  sessionManager.roomId = null;
  sessionManager.roomName = null;
  sessionManager._cachedToken = null;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SessionManager._resolveProjectAndRoomFromURL()', () => {
  beforeEach(() => {
    resetSessionManager();
    localStorage.clear();
  });

  test('1. canonical URL path takes highest priority', () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    localStorage.setItem('cia_last_project', 'stored-project');
    localStorage.setItem('cia_last_room', 'stored-room');

    const result = sessionManager._resolveProjectAndRoomFromURL();
    expect(result).toEqual({ projectId: PROJECT_ID, roomId: ROOM_UUID, isLegacy: false });
  });

  test('2. legacy URL path (no project prefix) is recognized as legacy', () => {
    setLocation(`/rooms/${ROOM_UUID}`);
    localStorage.setItem('cia_last_room', 'stored-room');

    const result = sessionManager._resolveProjectAndRoomFromURL();
    expect(result).toEqual({ projectId: null, roomId: ROOM_UUID, isLegacy: true });
  });

  test('3. canonical query params (?project=&room=)', () => {
    setLocation('/', `?project=${PROJECT_ID}&room=${ROOM_UUID}`);

    const result = sessionManager._resolveProjectAndRoomFromURL();
    expect(result).toEqual({ projectId: PROJECT_ID, roomId: ROOM_UUID, isLegacy: false });
  });

  test('4. legacy query param (?room= only) is recognized as legacy', () => {
    setLocation('/', `?room=${ROOM_UUID}`);

    const result = sessionManager._resolveProjectAndRoomFromURL();
    expect(result).toEqual({ projectId: null, roomId: ROOM_UUID, isLegacy: true });
  });

  test('5. paired localStorage (cia_last_project + cia_last_room)', () => {
    setLocation('/');
    localStorage.setItem('cia_last_project', PROJECT_ID);
    localStorage.setItem('cia_last_room', 'stored-room-id');

    const result = sessionManager._resolveProjectAndRoomFromURL();
    expect(result).toEqual({ projectId: PROJECT_ID, roomId: 'stored-room-id', isLegacy: false });
  });

  test('6. legacy localStorage (cia_last_room only) is recognized as legacy', () => {
    setLocation('/');
    localStorage.setItem('cia_last_room', 'stored-room-id');

    const result = sessionManager._resolveProjectAndRoomFromURL();
    expect(result).toEqual({ projectId: null, roomId: 'stored-room-id', isLegacy: true });
  });

  test('7. default falls back to config.defaultProjectId + defaultSessionId', () => {
    setLocation('/');
    localStorage.clear();

    const result = sessionManager._resolveProjectAndRoomFromURL();
    expect(result).toEqual({
      projectId: 'default-project-id',
      roomId: 'default-session-id',
      isLegacy: false,
    });
  });
});

describe('SessionManager.initializeFromURL() (sync, legacy primitive)', () => {
  beforeEach(() => {
    resetSessionManager();
    localStorage.clear();
  });

  test('sets roomId from canonical URL path, does not touch projectId', () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    const id = sessionManager.initializeFromURL();
    expect(id).toBe(ROOM_UUID);
    expect(sessionManager.roomId).toBe(ROOM_UUID);
    expect(sessionManager.projectId).toBeNull();
  });

  test('sets roomId from legacy URL path', () => {
    setLocation(`/rooms/${ROOM_UUID}`);
    const id = sessionManager.initializeFromURL();
    expect(id).toBe(ROOM_UUID);
  });
});

describe('SessionManager.initializeFromURLAsync()', () => {
  let fetchMock;

  beforeEach(() => {
    resetSessionManager();
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('canonical URL: validates room via API and persists project+room on 200', async () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    fetchMock.mockResolvedValueOnce({ ok: true });

    const id = await sessionManager.initializeFromURLAsync();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`,
      expect.any(Object)
    );
    expect(id).toBe(ROOM_UUID);
    expect(sessionManager.roomId).toBe(ROOM_UUID);
    expect(sessionManager.projectId).toBe(PROJECT_ID);
    expect(localStorage.getItem('cia_last_project')).toBe(PROJECT_ID);
    expect(localStorage.getItem('cia_last_room')).toBe(ROOM_UUID);
  });

  test('canonicalizes the URL after successful validation when path differs', async () => {
    setLocation('/', `?project=${PROJECT_ID}&room=${ROOM_UUID}`);
    fetchMock.mockResolvedValueOnce({ ok: true });

    await sessionManager.initializeFromURLAsync();

    expect(window.history.replaceState).toHaveBeenCalledWith(
      {},
      '',
      `/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`
    );
  });

  test('canonicalization strips resolved project/room query params but keeps other params', async () => {
    setLocation('/', `?project=${PROJECT_ID}&room=${ROOM_UUID}&utm_source=email`);
    fetchMock.mockResolvedValueOnce({ ok: true });

    await sessionManager.initializeFromURLAsync();

    expect(window.history.replaceState).toHaveBeenCalledWith(
      {},
      '',
      `/projects/${PROJECT_ID}/rooms/${ROOM_UUID}?utm_source=email`
    );
  });

  test('does not canonicalize when the path already matches', async () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    fetchMock.mockResolvedValueOnce({ ok: true });

    await sessionManager.initializeFromURLAsync();

    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  test('falls back to main room and does NOT persist on 404', async () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([MAIN_ROOM]),
    });

    const id = await sessionManager.initializeFromURLAsync();

    expect(id).toBe(MAIN_ROOM.id);
    expect(sessionManager.roomId).toBe(MAIN_ROOM.id);
    expect(sessionManager.projectId).toBe(PROJECT_ID);
    // localStorage must NOT be set to the unauthorized room
    expect(localStorage.getItem('cia_last_room')).toBeNull();
    expect(localStorage.getItem('cia_last_project')).toBeNull();
  });

  test('falls back to main room and does NOT persist on 403', async () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([MAIN_ROOM]),
    });

    const id = await sessionManager.initializeFromURLAsync();

    expect(id).toBe(MAIN_ROOM.id);
    expect(localStorage.getItem('cia_last_room')).toBeNull();
  });

  test('falls back to the safe default (does NOT trust the URL) when fetch throws (offline)', async () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const id = await sessionManager.initializeFromURLAsync();

    // A network error can't verify the URL-resolved project/room at all —
    // trusting it would let a crafted link be silently accepted whenever the
    // network happens to be down. Use the static default instead.
    expect(id).toBe('default-session-id');
    expect(sessionManager.roomId).toBe('default-session-id');
    expect(sessionManager.projectId).toBe('default-project-id');
    // Only the one (failed) fetch attempt — no second network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('proceeds optimistically on 401 (no auth token yet) without falling back or persisting', async () => {
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    const id = await sessionManager.initializeFromURLAsync();

    // Not a rejection — this runs before auth exists, so 401 is inconclusive,
    // not a denial. revalidateAccess() is what actually enforces access.
    expect(id).toBe(ROOM_UUID);
    expect(sessionManager.roomId).toBe(ROOM_UUID);
    expect(sessionManager.projectId).toBe(PROJECT_ID);
    expect(localStorage.getItem('cia_last_room')).toBeNull();
    expect(localStorage.getItem('cia_last_project')).toBeNull();
    // No fallback-lookup call — a 401 doesn't trigger _fetchMainRoom.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('default (no URL/localStorage) still validates against the API', async () => {
    setLocation('/');
    localStorage.clear();
    fetchMock.mockResolvedValueOnce({ ok: true });

    const id = await sessionManager.initializeFromURLAsync();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/default-project-id/rooms/default-session-id',
      expect.any(Object)
    );
    expect(id).toBe('default-session-id');
    expect(sessionManager.projectId).toBe('default-project-id');
  });

  describe('legacy link resolution', () => {
    test('legacy URL resolves via /api/rooms/:roomId, then validates normally', async () => {
      setLocation(`/rooms/${ROOM_UUID}`);
      // 1st fetch: legacy lookup succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: ROOM_UUID, project_id: PROJECT_ID }),
      });
      // 2nd fetch: normal room-access validation succeeds
      fetchMock.mockResolvedValueOnce({ ok: true });

      const id = await sessionManager.initializeFromURLAsync();

      expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/rooms/${ROOM_UUID}`, expect.any(Object));
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `/api/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`,
        expect.any(Object)
      );
      expect(id).toBe(ROOM_UUID);
      expect(sessionManager.projectId).toBe(PROJECT_ID);
      expect(localStorage.getItem('cia_last_project')).toBe(PROJECT_ID);
    });

    test('legacy URL that cannot be resolved (404) falls back to default project main room', async () => {
      setLocation(`/rooms/${ROOM_UUID}`);
      // 1st fetch: legacy lookup fails
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      // 2nd fetch: main room list for the default project
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([MAIN_ROOM]),
      });

      const id = await sessionManager.initializeFromURLAsync();

      expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/rooms/${ROOM_UUID}`, expect.any(Object));
      expect(id).toBe(MAIN_ROOM.id);
      expect(sessionManager.projectId).toBe('default-project-id');
      // Only 2 fetches — no third "validate the fallback room" call
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('legacy URL resolution network error falls back to default project main room', async () => {
      setLocation(`/rooms/${ROOM_UUID}`);
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([MAIN_ROOM]),
      });

      const id = await sessionManager.initializeFromURLAsync();

      expect(id).toBe(MAIN_ROOM.id);
      expect(sessionManager.projectId).toBe('default-project-id');
    });
  });
});

describe('SessionManager.revalidateAccess()', () => {
  let fetchMock;

  beforeEach(() => {
    resetSessionManager();
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    setLocation(`/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('no-ops when projectId/roomId are not yet resolved', async () => {
    const changed = await sessionManager.revalidateAccess();
    expect(changed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns false and leaves the room alone when still accessible (200)', async () => {
    sessionManager.projectId = PROJECT_ID;
    sessionManager.roomId = ROOM_UUID;
    fetchMock.mockResolvedValueOnce({ ok: true });

    const changed = await sessionManager.revalidateAccess();

    expect(changed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${PROJECT_ID}/rooms/${ROOM_UUID}`,
      expect.any(Object)
    );
    expect(sessionManager.roomId).toBe(ROOM_UUID);
  });

  test('falls back to the main room and returns true when access is actually denied', async () => {
    sessionManager.projectId = PROJECT_ID;
    sessionManager.roomId = ROOM_UUID;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([MAIN_ROOM]),
    });

    const changed = await sessionManager.revalidateAccess();

    expect(changed).toBe(true);
    expect(sessionManager.roomId).toBe(MAIN_ROOM.id);
    expect(localStorage.getItem('cia_last_project')).toBe(PROJECT_ID);
    expect(localStorage.getItem('cia_last_room')).toBe(MAIN_ROOM.id);
    expect(window.history.replaceState).toHaveBeenCalled();
  });

  test('returns false when the fallback room resolves to the same room already held', async () => {
    sessionManager.projectId = PROJECT_ID;
    sessionManager.roomId = MAIN_ROOM.id;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([MAIN_ROOM]),
    });

    const changed = await sessionManager.revalidateAccess();
    expect(changed).toBe(false);
  });

  test('returns false without throwing on a network error', async () => {
    sessionManager.projectId = PROJECT_ID;
    sessionManager.roomId = ROOM_UUID;
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(sessionManager.revalidateAccess()).resolves.toBe(false);
    expect(sessionManager.roomId).toBe(ROOM_UUID); // left as-is
  });
});

describe('SessionManager.getProjectId()', () => {
  beforeEach(() => {
    resetSessionManager();
  });

  test('returns the resolved projectId once set', () => {
    sessionManager.projectId = PROJECT_ID;
    expect(sessionManager.getProjectId()).toBe(PROJECT_ID);
  });

  test('falls back to config.defaultProjectId when unresolved — does not throw', () => {
    expect(sessionManager.getProjectId()).toBe('default-project-id');
  });
});

describe('SessionManager.switchRoom()', () => {
  let reloadMock;

  beforeEach(() => {
    resetSessionManager();
    localStorage.clear();
    vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
    reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { pathname: '/', search: '', href: 'https://localhost/', reload: reloadMock },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('defaults to the current project when none is passed', () => {
    sessionManager.projectId = PROJECT_ID;
    sessionManager.switchRoom('new-room-id');

    expect(window.history.pushState).toHaveBeenCalledWith(
      {},
      '',
      `/projects/${PROJECT_ID}/rooms/new-room-id`
    );
    expect(localStorage.getItem('cia_last_project')).toBe(PROJECT_ID);
    expect(localStorage.getItem('cia_last_room')).toBe('new-room-id');
  });

  test('uses an explicit projectId override when passed', () => {
    sessionManager.projectId = PROJECT_ID;
    sessionManager.switchRoom('new-room-id', 'other-project');

    expect(window.history.pushState).toHaveBeenCalledWith(
      {},
      '',
      '/projects/other-project/rooms/new-room-id'
    );
  });

  test('falls back to config.defaultProjectId when neither current nor explicit project is known', () => {
    sessionManager.projectId = null;
    sessionManager.switchRoom('new-room-id');

    expect(window.history.pushState).toHaveBeenCalledWith(
      {},
      '',
      '/projects/default-project-id/rooms/new-room-id'
    );
  });
});

describe('SessionManager auth token handling', () => {
  test('setToken/getToken round-trips', () => {
    sessionManager.setToken('my-token');
    expect(sessionManager.getToken()).toBe('my-token');
  });

  test('clearSession wipes token and projectId', () => {
    sessionManager.projectId = PROJECT_ID;
    sessionManager.setToken('tok');
    sessionManager.clearSession();
    expect(sessionManager.getToken()).toBeNull();
    expect(sessionManager.projectId).toBeNull();
  });
});
