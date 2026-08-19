// src/services/__tests__/serverSync.joinRoom.test.js
// VR broadcasts are room-scoped (yjsSetup.js binds the ydoc to
// sessionManager.getRoomId()), but no client ever sent "join:room" —
// serverSync.js only ever sent "join:project". That left
// wsManager.roomChannels permanently empty, so broadcastToRoom (Phase A3)
// would reach zero clients. This pins the fix: join:room is sent after
// auth:success (and re-sent on every reconnect's auth:success), and a
// sessionManager that hasn't initialized yet (getRoomId() throws) doesn't
// take connect() down with it.
import { describe, test, expect, beforeEach, vi } from "vitest";

vi.mock("@Core/config/clientConfig.js", () => ({
  config: {
    apiBaseUrl: "/api",
    defaultSessionId: "test-session",
  },
}));

const mockGetRoomId = vi.fn().mockReturnValue("room-1");
vi.mock("@Core/session/sessionManager.js", () => ({
  sessionManager: {
    getProjectId: vi.fn().mockReturnValue("project-1"),
    getRoomId: (...a) => mockGetRoomId(...a),
    getUserId: vi.fn().mockReturnValue("user-me"),
    setUserInfo: vi.fn(),
  },
}));

vi.mock("@Services/authService.js", () => ({
  authService: { getToken: vi.fn(), onAuthChange: vi.fn() },
}));

vi.mock("@UI/react/store/computeJobStore.js", () => ({
  useComputeJobStore: { getState: vi.fn().mockReturnValue({}) },
}));

vi.mock("@UI/react/store/toastStore.js", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("@Services/syncService.js", () => ({
  getSyncWatermark: vi.fn().mockReturnValue(0),
  saveSyncWatermark: vi.fn(),
  fetchDeltaSince: vi.fn().mockResolvedValue({ events: [] }),
  applyDeltaEvents: vi.fn().mockResolvedValue({ lastAppliedEventId: null }),
}));

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.sent = [];
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

import { serverSync } from "../serverSync.js";

function deliver(message) {
  serverSync._handleMessage(JSON.stringify(message));
}

describe("serverSync — join:room", () => {
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket;
    serverSync._setupDefaultHandlers();
    serverSync.isConnected = false;
    serverSync.reconnectAttempts = 0;
    serverSync.ws = null;
    serverSync._reconnectTimer = null;
    serverSync.pendingProjectId = null;
    serverSync.pendingRoomId = null;
    mockGetRoomId.mockClear();
    mockGetRoomId.mockReturnValue("room-1");
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  test("join:room is sent after auth:success, following join:project", () => {
    serverSync.connect();
    serverSync.ws.readyState = MockWebSocket.OPEN;
    serverSync.ws.onopen();

    deliver({ type: "auth:success", userId: "user-me" });

    const types = serverSync.ws.sent.map((m) => m.type);
    expect(types).toContain("join:project");
    expect(types).toContain("join:room");
    expect(types.indexOf("join:project")).toBeLessThan(types.indexOf("join:room"));

    const roomMsg = serverSync.ws.sent.find((m) => m.type === "join:room");
    expect(roomMsg.roomId).toBe("room-1");
  });

  test("join:room is re-sent on a reconnect's auth:success", () => {
    serverSync.connect();
    serverSync.ws.readyState = MockWebSocket.OPEN;
    serverSync.ws.onopen();
    deliver({ type: "auth:success", userId: "user-me" });
    expect(serverSync.ws.sent.filter((m) => m.type === "join:room")).toHaveLength(1);

    // Simulate reconnect: a new socket opens and re-authenticates.
    serverSync.connect();
    serverSync.ws.readyState = MockWebSocket.OPEN;
    serverSync.ws.onopen();
    deliver({ type: "auth:success", userId: "user-me" });

    expect(serverSync.ws.sent.filter((m) => m.type === "join:room")).toHaveLength(1);
  });

  test("an uninitialized sessionManager (getRoomId throws) does not throw out of connect()", () => {
    mockGetRoomId.mockImplementation(() => {
      throw new Error("Session not initialized - call initializeFromURL() first");
    });

    expect(() => {
      serverSync.connect();
      serverSync.ws.readyState = MockWebSocket.OPEN;
      serverSync.ws.onopen();
    }).not.toThrow();

    expect(serverSync.pendingRoomId).toBeNull();

    deliver({ type: "auth:success", userId: "user-me" });
    const types = serverSync.ws.sent.map((m) => m.type);
    expect(types).not.toContain("join:room");
  });

  test("setRoomId() sets pendingRoomId directly", () => {
    serverSync.setRoomId("room-42");
    expect(serverSync.pendingRoomId).toBe("room-42");
    serverSync.setRoomId(null);
    expect(serverSync.pendingRoomId).toBeNull();
  });

  test("room:joined and room:join-error handlers do not throw", () => {
    expect(() => deliver({ type: "room:joined", roomId: "room-1" })).not.toThrow();
    expect(() => deliver({ type: "room:join-error", error: "Access denied" })).not.toThrow();
  });
});
