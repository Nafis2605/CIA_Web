// src/core/vr/avatars/__tests__/AvatarNetworkSync.pointer.test.js
// _toPose used to hardcode `pointer: { visible: false }`, which is why remote
// pointer rays never rendered in VR no matter what the sender broadcast.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

const { mockSyncAvatar, mockYAvatars } = vi.hoisted(() => ({
  mockSyncAvatar: vi.fn(),
  mockYAvatars: { observe: vi.fn(), unobserve: vi.fn(), get: vi.fn() },
}));
vi.mock("@Collaboration/yjs/yjsSetup.js", () => ({
  yAvatars: mockYAvatars,
  syncAvatarToYjs: (...args) => mockSyncAvatar(...args),
}));

vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: vi.fn(() => "local-user"),
}));

import { AvatarNetworkSync } from "../AvatarNetworkSync.js";

const HEAD = { position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };

function makeData(overrides = {}) {
  return {
    odUserId: "remote-1",
    headPose: HEAD,
    timestamp: 1234,
    vrScale: 2,
    vrOrigin: [1, 0, 1],
    ...overrides,
  };
}

describe("AvatarNetworkSync._toPose — pointer + surface hit", () => {
  /** @type {AvatarNetworkSync} */
  let sync;

  beforeEach(() => {
    mockSyncAvatar.mockClear();
    sync = new AvatarNetworkSync();
  });

  it("maps a wire pointer through to the avatar pose", () => {
    const pose = sync._toPose(
      makeData({
        pointer: {
          origin: { x: 0.1, y: 1.4, z: -0.2 },
          direction: { x: 0, y: 0, z: -1 },
          hand: "left",
          visible: true,
        },
      })
    );

    expect(pose.pointer).toEqual({
      origin: { x: 0.1, y: 1.4, z: -0.2 },
      direction: { x: 0, y: 0, z: -1 },
      hand: "left",
      visible: true,
    });
  });

  it("defaults the hand to right and keeps visible true when the sender omitted the flag", () => {
    const pose = sync._toPose(
      makeData({
        pointer: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } },
      })
    );

    expect(pose.pointer.hand).toBe("right");
    expect(pose.pointer.visible).toBe(true);
  });

  it("reports the pointer invisible unless BOTH origin and direction are present", () => {
    const noPointer = sync._toPose(makeData());
    expect(noPointer.pointer).toEqual({ origin: null, direction: null, visible: false });

    const originOnly = sync._toPose(
      makeData({ pointer: { origin: { x: 0, y: 0, z: 0 }, direction: null } })
    );
    expect(originOnly.pointer.visible).toBe(false);

    const directionOnly = sync._toPose(
      makeData({ pointer: { origin: null, direction: { x: 0, y: 0, z: -1 } } })
    );
    expect(directionOnly.pointer.visible).toBe(false);
  });

  it("passes pointerHit through as a sibling field (it is data space, not XR space)", () => {
    const hit = { x: 5, y: 6, z: 7 };
    const pose = sync._toPose(
      makeData({
        pointer: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } },
        pointerHit: hit,
      })
    );

    expect(pose.pointerHit).toEqual(hit);
    // Explicitly NOT folded into pointer — RemoteAvatarController._toScenePose
    // transforms pointer.origin but must leave pointerHit alone.
    expect(pose.pointer.hit).toBeUndefined();
  });

  it("carries the sender's own transform alongside, unchanged by the pointer work", () => {
    const pose = sync._toPose(makeData({ pointerHit: { x: 1, y: 1, z: 1 } }));
    expect(pose.vrScale).toBe(2);
    expect(pose.vrOrigin).toEqual([1, 0, 1]);
    expect(pose.pointerHit).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("defaults pointerHit to null when absent", () => {
    expect(sync._toPose(makeData()).pointerHit).toBeNull();
  });
});

describe("AvatarNetworkSync.sendLocalPresence — session scoping", () => {
  beforeEach(() => {
    mockSyncAvatar.mockClear();
  });

  it("carries sessionId so room-global yAvatars entries can be filtered by session", () => {
    const sync = new AvatarNetworkSync();
    sync.initialize();
    sync.sendLocalPresence({
      displayName: "Alice",
      color: "hsl(210, 70%, 60%)",
      sessionId: "vrsession_a",
    });

    expect(mockSyncAvatar).toHaveBeenCalledWith(
      "local-user",
      expect.objectContaining({ sessionId: "vrsession_a" })
    );
  });

  it("sends null rather than undefined when there is no session id", () => {
    const sync = new AvatarNetworkSync();
    sync.initialize();
    sync.sendLocalPresence({ displayName: "Alice", color: "#ff0000" });

    expect(mockSyncAvatar).toHaveBeenCalledWith(
      "local-user",
      expect.objectContaining({ sessionId: null })
    );
  });
});
