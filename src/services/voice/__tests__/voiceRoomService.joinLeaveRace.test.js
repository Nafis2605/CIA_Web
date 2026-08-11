// src/services/voice/__tests__/voiceRoomService.joinLeaveRace.test.js
// A fast leave-then-rejoin (or two call sites — e.g. the VR spatial menu and
// the bottom voice bar — triggering near-simultaneously) used to race:
// leaveRoom() awaiting room.disconnect() while a concurrent joinRoom()
// replaced `this.room` with a new instance, and leaveRoom's trailing
// `this.room = null` then wiped out that new, live room with no handle left
// to it. This pins the fix: every joinRoom()/leaveRoom() call is serialized
// through a single op chain, so they never run concurrently.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { ws: mkLog(), vr: mkLog(), app: mkLog(), sync: mkLog(), createLogger: () => mkLog() };
});

vi.mock("@Core/config/clientConfig.js", () => ({
  config: {
    liveKitTokenUrl: "/livekit-token",
    liveKitUrl: "ws://localhost:7880",
  },
}));

vi.mock("@Services/authService.js", () => ({
  authService: { getAccessToken: vi.fn().mockResolvedValue("access-token") },
}));

vi.mock("@Utils/resolveHttpUrl.js", () => ({
  resolveHttpUrl: (url) => `http://localhost${url}`,
}));

vi.mock("@Core/session/sessionManager.js", () => ({
  sessionManager: { getRoomId: vi.fn().mockReturnValue("room-1") },
}));

vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getParticipantId: vi.fn().mockReturnValue("participant-1"),
}));

// Deferred, externally-resolvable connect/disconnect so tests can control
// exactly when each in-flight operation "completes" and interleave them.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

let roomInstances = [];
class FakeRoom {
  constructor() {
    this.id = roomInstances.length;
    this.participants = new Map();
    this.localParticipant = {
      sid: `local-${this.id}`,
      identity: `local-${this.id}`,
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    };
    this._connectDeferred = deferred();
    this._disconnectDeferred = deferred();
    roomInstances.push(this);
  }
  on() {}
  connect() {
    return this._connectDeferred.promise;
  }
  disconnect() {
    return this._disconnectDeferred.promise;
  }
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: new Proxy({}, { get: () => "event" }),
  Track: { Source: {} },
  ConnectionState: new Proxy({}, { get: () => "state" }),
}));

beforeEach(() => {
  roomInstances = [];
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ token: "fake-jwt" }),
  });
  global.window = global.window || {};
  if (!global.window.dispatchEvent) {
    global.window.dispatchEvent = vi.fn();
    global.window.CustomEvent = class {
      constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
    };
  } else {
    vi.spyOn(window, "dispatchEvent").mockImplementation(() => true);
  }
});

// getToken() chains authService.getAccessToken() -> fetch() -> .json()
// before joinRoom ever reaches `new Room(...)` — several microtask hops a
// single `await Promise.resolve()` won't clear.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("voiceRoomService — join/leave race", () => {
  it("a leaveRoom() awaiting disconnect() does not stomp a concurrently-joined newer room", async () => {
    const { voiceRoomService, VoiceConnectionState } = await import("../voiceRoomService.js");

    // 1. Join room A and let it fully connect.
    const joinA = voiceRoomService.joinRoom("room-A", "Alice");
    await flush();
    roomInstances[0]._connectDeferred.resolve();
    await joinA;
    const roomA = voiceRoomService.room;
    expect(roomA).toBe(roomInstances[0]);
    expect(voiceRoomService.connectionState).toBe(VoiceConnectionState.CONNECTED);

    // 2. Start leaving room A (disconnect() not yet resolved — simulates the
    // in-flight window the real race exploited) and, "concurrently", start
    // joining room B.
    const leavePromise = voiceRoomService.leaveRoom();
    const joinB = voiceRoomService.joinRoom("room-B", "Alice");

    // 3. Let leaveRoom's disconnect() resolve now — with serialization, join
    // B hasn't even started yet (it's queued behind leaveRoom), so this only
    // affects room A.
    roomInstances[0]._disconnectDeferred.resolve();
    await leavePromise;

    // 4. Now joinB's connect() can run.
    await flush();
    expect(roomInstances.length).toBe(2); // room B was created only after leave finished
    roomInstances[1]._connectDeferred.resolve();
    await joinB;

    // Room B must be the final, live room — never nulled out by leaveRoom's
    // (already-finished) cleanup of room A.
    expect(voiceRoomService.room).toBe(roomInstances[1]);
    expect(voiceRoomService.connectionState).toBe(VoiceConnectionState.CONNECTED);
    expect(voiceRoomService.currentRoomName).toBe("room-B");
  });

  it("two overlapping joinRoom() calls do not orphan the first room's connection", async () => {
    const { voiceRoomService, VoiceConnectionState } = await import("../voiceRoomService.js");
    voiceRoomService.room = null;
    voiceRoomService.connectionState = VoiceConnectionState.DISCONNECTED;
    voiceRoomService.currentRoomName = null;
    voiceRoomService._opChain = Promise.resolve();
    roomInstances = [];

    // Two joins fired back-to-back, before the first's token fetch/connect
    // resolves (e.g. VR menu button + voice bar both triggering joinRoom).
    const join1 = voiceRoomService.joinRoom("room-X", "Alice");
    const join2 = voiceRoomService.joinRoom("room-Y", "Alice");

    await flush();
    // With serialization, only the FIRST room should exist yet — the second
    // join is still queued behind the first.
    expect(roomInstances.length).toBe(1);
    roomInstances[0]._connectDeferred.resolve();
    await join1;

    // join2 now starts: sees CONNECTED, so it leaves room X first (awaiting
    // its disconnect()) before creating room Y — room Y must not appear yet.
    await flush();
    expect(roomInstances.length).toBe(1);
    roomInstances[0]._disconnectDeferred.resolve();

    await flush();
    expect(roomInstances.length).toBe(2);
    roomInstances[1]._connectDeferred.resolve();
    await join2;

    expect(voiceRoomService.room).toBe(roomInstances[1]);
    expect(voiceRoomService.currentRoomName).toBe("room-Y");
  });
});
