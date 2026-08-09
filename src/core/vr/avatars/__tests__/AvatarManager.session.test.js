// src/core/vr/avatars/__tests__/AvatarManager.session.test.js
// Session identity across a VR session-claim race.
//
// THE DEFECT: AvatarManager cached `session.id` into `_sessionId` at
// initialize() time. When two headsets claim the same session simultaneously,
// VRExplorationManager re-keys the pose/control/lock managers and mutates
// `session.id` — but the cached copy stayed on the LOSING id. Since that id is
// both stamped on outgoing presence and compared against incoming presence, the
// two headsets then rejected each other's metadata symmetrically. Poses kept
// flowing (those had re-keyed), so the session looked healthy while each user
// saw the other as a grey avatar named with 8 hex characters, permanently.
//
// The fix reads the id live off the session object AvatarExplorationManager
// mutates, so it can never drift again.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), createLogger: () => mkLog() };
});

vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserColor: vi.fn(() => "#ff0000"),
  getParticipantId: vi.fn(() => "acct-1#device-a"),
  getParticipantName: vi.fn(() => "Me (Quest 3 a41f)"),
}));

// The controllers own VTK actors; stub them to plain recorders.
vi.mock("../LocalAvatarController.js", () => ({
  LocalAvatarController: class {
    update() {}
    getLatestPose() {
      return null;
    }
    dispose() {}
  },
}));

const { remoteInstances } = vi.hoisted(() => ({ remoteInstances: [] }));
vi.mock("../RemoteAvatarController.js", () => ({
  RemoteAvatarController: class {
    constructor(opts) {
      Object.assign(this, opts);
      remoteInstances.push(this);
    }
    initialize() {}
    receivePose() {}
    receivePresence(p) {
      this.presence = p;
    }
    setDisplayName(n) {
      this.displayName = n;
    }
    setColor(c) {
      this.color = c;
    }
    setAvatarUrl() {}
    update() {}
    dispose() {}
  },
}));

vi.mock("../VRMAvatar.js", () => ({ VRMAvatar: class {} }));

// Capture the presence payloads AvatarManager sends, and let tests drive the
// inbound callback the real AvatarNetworkSync would invoke.
const { sentPresence, networkHandles } = vi.hoisted(() => ({
  sentPresence: [],
  networkHandles: {},
}));
vi.mock("../AvatarNetworkSync.js", () => ({
  AvatarNetworkSync: class {
    onRemotePose(cb) {
      networkHandles.pose = cb;
    }
    onRemotePresence(cb) {
      networkHandles.presence = cb;
    }
    onRemoteLeave(cb) {
      networkHandles.leave = cb;
    }
    initialize() {}
    sendLocalPresence(state) {
      sentPresence.push(state);
    }
    dispose() {}
  },
}));

import { AvatarManager } from "../AvatarManager.js";

/** The mutable session object VRExplorationManager hands over and later mutates. */
function makeSession(id) {
  return { id, participants: [] };
}

describe("AvatarManager — session identity", () => {
  /** @type {AvatarManager} */
  let manager;
  let session;

  beforeEach(() => {
    sentPresence.length = 0;
    remoteInstances.length = 0;
    session = makeSession("vrsession_loser");
    manager = new AvatarManager();
    manager.initialize({}, session, { vrScale: 1, vrOrigin: [0, 0, 0] });
  });

  it("stamps the current session id on outgoing presence", () => {
    expect(sentPresence.at(-1)).toMatchObject({ sessionId: "vrsession_loser" });
  });

  it("accepts a peer in the same session and rejects one in another", () => {
    networkHandles.presence("remote-1", {
      displayName: "Alice",
      color: "#00ff00",
      sessionId: "vrsession_loser",
    });
    expect(remoteInstances.map((r) => r.userId)).toContain("remote-1");

    networkHandles.presence("stranger-1", {
      displayName: "Bob",
      color: "#0000ff",
      sessionId: "some_other_session",
    });
    expect(remoteInstances.map((r) => r.userId)).not.toContain("stranger-1");
  });

  it("still accepts a peer that sends no sessionId at all", () => {
    // Only a POSITIVE mismatch rejects — an older peer must not vanish.
    networkHandles.presence("remote-legacy", { displayName: "Carol", color: "#ffffff" });
    expect(remoteInstances.map((r) => r.userId)).toContain("remote-legacy");
  });

  describe("after the claim race resolves against us", () => {
    beforeEach(() => {
      // Exactly what VRExplorationManager._watchVRSessionConvergence does:
      // mutate the shared session object, THEN re-key.
      session.id = "vrsession_winner";
      manager.rekey("vrsession_winner");
    });

    it("re-broadcasts presence under the winning id", () => {
      expect(sentPresence.at(-1)).toMatchObject({ sessionId: "vrsession_winner" });
    });

    // The inbound half of the same bug: the winner's presence used to be
    // rejected because our filter still held the losing id.
    it("now accepts a peer in the WINNING session", () => {
      networkHandles.presence("remote-1", {
        displayName: "Alice",
        color: "#00ff00",
        sessionId: "vrsession_winner",
      });
      expect(remoteInstances.map((r) => r.userId)).toContain("remote-1");
    });

    it("now rejects a peer still in the losing session", () => {
      networkHandles.presence("stale-1", {
        displayName: "Ghost",
        color: "#888888",
        sessionId: "vrsession_loser",
      });
      expect(remoteInstances.map((r) => r.userId)).not.toContain("stale-1");
    });

    it("does not re-broadcast when re-keyed to the id it already announced", () => {
      const before = sentPresence.length;
      manager.rekey("vrsession_winner");
      expect(sentPresence.length).toBe(before);
    });

    it("ignores an empty re-key", () => {
      const before = sentPresence.length;
      manager.rekey(null);
      manager.rekey(undefined);
      manager.rekey("");
      expect(sentPresence.length).toBe(before);
    });
  });

  it("reports no session id once disposed", () => {
    manager.dispose();
    expect(manager.sessionId).toBeNull();
  });
});
