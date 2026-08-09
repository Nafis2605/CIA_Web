// src/core/vr/__tests__/VRControlManager.test.js
// Session-id binding for desktop-to-VR control handoff: the Y.js map is
// bound once in the constructor (`vr-control-<sessionId>`), so rekey() must
// correctly move it when a VR session-claim race resolves against us.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

const { mockYMaps } = vi.hoisted(() => ({ mockYMaps: new Map() }));
vi.mock("@Collaboration/yjs/yjsSetup.js", () => ({
  ydoc: {
    getMap: (name) => {
      if (!mockYMaps.has(name)) {
        const store = new Map();
        mockYMaps.set(name, {
          _store: store,
          get: (k) => store.get(k),
          set: (k, v) => store.set(k, v),
          delete: (k) => store.delete(k),
          forEach: (fn) => store.forEach((v, k) => fn(v, k)),
          observe: vi.fn(),
          unobserve: vi.fn(),
        });
      }
      return mockYMaps.get(name);
    },
  },
}));

vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getParticipantId: vi.fn(() => "local-user"),
  getParticipantName: vi.fn(() => "Local"),
}));

import { VRControlManager } from "../VRControlManager.js";

function makeTarget() {
  return { isVR: () => true, isBeingControlled: () => false };
}

function makeSession(id) {
  return {
    id,
    requireControlApproval: true,
    getParticipant: vi.fn(() => makeTarget()),
    establishControl: vi.fn(),
    declineControlRequest: vi.fn(),
    releaseControl: vi.fn(),
  };
}

describe("VRControlManager", () => {
  beforeEach(() => {
    mockYMaps.clear();
  });

  it("binds to the initial session id's map at construction", () => {
    const session = makeSession("session-a");
    const manager = new VRControlManager(session);

    expect(manager._yControlRequests).toBe(mockYMaps.get("vr-control-session-a"));
    expect(manager._boundSessionId).toBe("session-a");
  });

  describe("rekey", () => {
    it("ignores falsy or already-bound ids", () => {
      const session = makeSession("session-a");
      const manager = new VRControlManager(session);
      const mapBefore = manager._yControlRequests;

      manager.rekey(null);
      manager.rekey(undefined);
      manager.rekey("");
      manager.rekey("session-a"); // already bound — must be a no-op

      expect(manager._yControlRequests).toBe(mapBefore);
    });

    it("is not fooled when the caller mutates session.id before calling rekey (the convergence-handler race)", async () => {
      const session = makeSession("session-a");
      const manager = new VRControlManager(session);

      await manager.requestControl("peer-1");
      expect(mockYMaps.get("vr-control-session-a")._store.size).toBe(1);

      // Reproduce VRExplorationManager._watchVRSessionConvergence's exact
      // order: mutate the SHARED session object BEFORE calling rekey.
      session.id = "session-winner";
      manager.rekey("session-winner");

      expect(manager._yControlRequests).toBe(mockYMaps.get("vr-control-session-winner"));

      await manager.requestControl("peer-2");
      expect(mockYMaps.get("vr-control-session-winner")._store.size).toBe(1);
      // The pre-rekey request is left behind, untouched, in the old map.
      expect(mockYMaps.get("vr-control-session-a")._store.size).toBe(1);
    });
  });
});
