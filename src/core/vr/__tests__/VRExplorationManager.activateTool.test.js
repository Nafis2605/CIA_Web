// src/core/vr/__tests__/VRExplorationManager.activateTool.test.js
// Covers the tool-activation race: VRExplorationManager.activateTool used to
// fire-and-forget VRToolManager's genuinely-async activateTool, so
// 'toolActivated' fired before activation actually completed and a rejection
// was silently swallowed. See VRSpatialMenuModel's TOOL_SYNC_HOLD_MS comment
// for the symptom this caused (menu highlight flicker) that this fix removes
// the root cause of.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

const mockVrManager = {
  isVRSupported: vi.fn(() => false),
  isSelectPressed: vi.fn(() => false),
  getReferenceSpace: vi.fn(() => ({})),
  on: vi.fn(),
  off: vi.fn(),
};
vi.mock("@Core/vr/VRManager.js", () => ({
  get vrManager() {
    return mockVrManager;
  },
}));

vi.mock("@Core/data/models/VRExplorationSession.js", () => ({
  VRExplorationSession: class {},
  PARTICIPATION_MODE: { VR_EXPLORER: "vr-explorer", DESKTOP_OBSERVER: "desktop-observer" },
  SESSION_STATUS: { ACTIVE: "active" },
  EXPLORATION_MODES: { FLY: "fly", TELEPORT: "teleport", WALK: "walk", SCALE: "scale", GRAB: "grab" },
}));
vi.mock("@Core/vr/VRParticipantSync.js", () => ({ VRParticipantSync: class {} }));
vi.mock("@Core/vr/tools/VRToolManager.js", () => ({ VRToolManager: class {} }));
vi.mock("@Core/vr/VRSnapshotManager.js", () => ({ VRSnapshotManager: class {} }));
vi.mock("@Core/vr/VRControlManager.js", () => ({ VRControlManager: class {} }));
vi.mock("@Core/vr/navigation/VRNavigationController.js", () => ({
  VRNavigationController: class {},
}));
vi.mock("@Core/instances/workspaceManager.js", () => ({
  workspaceManager: { getInstance: vi.fn() },
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
  vrAvatarSystem: { initialize: vi.fn(), dispose: vi.fn(), update: vi.fn() },
}));

import { vrExplorationManager } from "../VRExplorationManager.js";

describe("VRExplorationManager.activateTool — async completion", () => {
  let originalToolManager;

  beforeEach(() => {
    vi.clearAllMocks();
    originalToolManager = vrExplorationManager._toolManager;
  });

  afterEach(() => {
    vrExplorationManager._toolManager = originalToolManager;
  });

  it("does not emit toolActivated until the manager's async activateTool resolves", async () => {
    let resolveFn;
    const pending = new Promise((resolve) => {
      resolveFn = resolve;
    });
    vrExplorationManager._toolManager = { activateTool: vi.fn(() => pending) };

    const activated = vi.fn();
    vrExplorationManager.on("toolActivated", activated);

    const call = vrExplorationManager.activateTool("annotate");
    // Not resolved yet — must not have emitted.
    expect(activated).not.toHaveBeenCalled();

    resolveFn();
    await call;

    expect(activated).toHaveBeenCalledWith({ toolId: "annotate" });
  });

  it("emits toolActivationFailed (not toolActivated) and does not throw when activation rejects", async () => {
    vrExplorationManager._toolManager = {
      activateTool: vi.fn(() => Promise.reject(new Error("boom"))),
    };

    const activated = vi.fn();
    const failed = vi.fn();
    vrExplorationManager.on("toolActivated", activated);
    vrExplorationManager.on("toolActivationFailed", failed);

    await expect(vrExplorationManager.activateTool("measure")).resolves.not.toThrow();

    expect(activated).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith({ toolId: "measure", error: "boom" });
  });

  it("is a no-op when there is no tool manager", async () => {
    vrExplorationManager._toolManager = null;
    await expect(vrExplorationManager.activateTool("annotate")).resolves.toBeUndefined();
  });
});
