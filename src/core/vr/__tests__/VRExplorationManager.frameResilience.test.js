// src/core/vr/__tests__/VRExplorationManager.frameResilience.test.js
// _safeFrameStep — the guard that keeps a single throwing frame step from
// taking presence down with it.
//
// THE DEFECT: _onFrame wrapped ~20 steps in ONE try/catch. The participant pose
// broadcast sits about two-thirds down, behind navigation, tools, follow and
// isolation — so a throw in any of those jumped to the outer catch and skipped
// the broadcast, the avatar update and the handler's draw. Because the cause is
// per-frame state it repeated every frame, so the peer's avatar froze
// permanently while this headset carried on rendering a healthy-looking
// session. The error was deduped to a single line, on a logger level that a
// headset suppresses by default — so there was nothing to see either.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

vi.mock("@Core/vr/VRManager.js", () => ({
  vrManager: { isVRSupported: vi.fn(() => false), on: vi.fn(), off: vi.fn() },
}));
vi.mock("@Core/data/models/VRExplorationSession.js", () => ({
  VRExplorationSession: class {},
  PARTICIPATION_MODE: { VR_EXPLORER: "vr-explorer", DESKTOP_OBSERVER: "desktop-observer" },
  SESSION_STATUS: { ACTIVE: "active" },
  EXPLORATION_MODES: { FLY: "fly", TELEPORT: "teleport", WALK: "walk" },
}));
vi.mock("@Core/vr/VRParticipantSync.js", () => ({ VRParticipantSync: class {} }));
vi.mock("@Core/vr/tools/VRToolManager.js", () => ({ VRToolManager: class {} }));
vi.mock("@Core/vr/VRSnapshotManager.js", () => ({ VRSnapshotManager: class {} }));
vi.mock("@Core/vr/VRControlManager.js", () => ({ VRControlManager: class {} }));
vi.mock("@Core/vr/navigation/VRNavigationController.js", () => ({
  VRNavigationController: class {},
}));
vi.mock("@Core/instances/workspaceManager.js", () => ({
  workspaceManager: { getInstance: vi.fn(), getInstancesByType: vi.fn(() => []) },
}));
vi.mock("@Init/appInitializer.js", () => ({ getViewConfigurationManager: vi.fn() }));
vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: vi.fn(() => "user-1"),
  getUserName: vi.fn(() => "Tester"),
  getUserColor: vi.fn(() => "#ff0000"),
  getParticipantId: vi.fn(() => "user-1"),
  getParticipantName: vi.fn(() => "Tester"),
  isSelfIdentity: vi.fn((id) => id === "user-1"),
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRAvatars.js", () => ({
  vrAvatarSystem: { initialize: vi.fn(), dispose: vi.fn(), update: vi.fn(), rekey: vi.fn() },
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRSpatialUI.js", () => ({
  vrSpatialUI: { dispose: vi.fn(), hitTest: vi.fn(), layout: vi.fn() },
}));
vi.mock("@Core/vr/VRMultiViewGrid.js", () => ({
  vrMultiViewGrid: { disable: vi.fn(), isEnabled: vi.fn(() => false) },
}));
vi.mock("@Services/apiClient.js", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), delete: vi.fn() },
}));
vi.mock("@Services/visualizationSyncService.js", () => ({
  pushSharedVisualizationUpdate: vi.fn(),
}));

import { vrExplorationManager } from "../VRExplorationManager.js";
import { vr as log } from "@Utils/logger.js";

describe("VRExplorationManager._safeFrameStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vrExplorationManager._resetFrameErrorState();
  });

  it("returns the step's value when it succeeds", () => {
    expect(vrExplorationManager._safeFrameStep("ok", () => 42)).toBe(42);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("swallows a throw, returns undefined, and logs once", () => {
    const result = vrExplorationManager._safeFrameStep("navigation", () => {
      throw new Error("nav exploded");
    });

    expect(result).toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain("navigation");
    expect(log.error.mock.calls[0][0]).toContain("nav exploded");
  });

  it("does not re-log the same failure at frame rate", () => {
    // A per-frame throw would otherwise emit ~90 lines/second and bury itself.
    for (let i = 0; i < 100; i++) {
      vrExplorationManager._safeFrameStep("navigation", () => {
        throw new Error("nav exploded");
      });
    }
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  // Dedupe is per LABEL, not global: the old single-signature dedupe meant a
  // persistent fault in one step masked a later fault in a different one.
  it("still reports a DIFFERENT step failing while one is already spamming", () => {
    vrExplorationManager._safeFrameStep("navigation", () => {
      throw new Error("boom");
    });
    vrExplorationManager._safeFrameStep("tools", () => {
      throw new Error("boom");
    });

    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error.mock.calls[1][0]).toContain("tools");
  });

  it("reports the same step failing for a NEW reason", () => {
    vrExplorationManager._safeFrameStep("tools", () => {
      throw new Error("first cause");
    });
    vrExplorationManager._safeFrameStep("tools", () => {
      throw new Error("second cause");
    });

    expect(log.error).toHaveBeenCalledTimes(2);
  });

  // The dedupe state used to be write-only: never initialised, never cleared.
  // A fault that recurred in a later session of the same page load logged
  // nothing at all, because its signature was still marked as "seen".
  it("logs again after the state is reset for a new session", () => {
    const boom = () => {
      throw new Error("same fault");
    };

    vrExplorationManager._safeFrameStep("tools", boom);
    expect(log.error).toHaveBeenCalledTimes(1);

    vrExplorationManager._safeFrameStep("tools", boom);
    expect(log.error).toHaveBeenCalledTimes(1); // suppressed, same session

    vrExplorationManager._resetFrameErrorState();
    vrExplorationManager._safeFrameStep("tools", boom);
    expect(log.error).toHaveBeenCalledTimes(2); // new session, reported again
  });

  it("lets a later step run after an earlier one throws", () => {
    // The whole point: navigation blowing up must not cost the presence
    // broadcast that runs after it.
    const broadcast = vi.fn();

    vrExplorationManager._safeFrameStep("navigation", () => {
      throw new Error("nav exploded");
    });
    vrExplorationManager._safeFrameStep("participant-broadcast", broadcast);

    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
