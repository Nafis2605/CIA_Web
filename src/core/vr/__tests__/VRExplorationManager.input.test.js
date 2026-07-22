// src/core/vr/__tests__/VRExplorationManager.input.test.js
// Vision Pro Safari exposes "transient-pointer" input sources (gaze + pinch):
// no gripSpace, often no gamepad, handedness may be "none". These must still
// produce controller state so VR tools work on Vision Pro.
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
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRAvatars.js", () => ({
  vrAvatarSystem: { initialize: vi.fn(), dispose: vi.fn(), update: vi.fn() },
}));

import { vrExplorationManager } from "../VRExplorationManager.js";

const TRANSFORM = { position: { x: 0, y: 1.5, z: 0 }, matrix: new Array(16).fill(0) };

function makeFrame(inputSources, poseFor = () => ({ transform: TRANSFORM })) {
  return {
    session: { inputSources },
    getViewerPose: vi.fn(() => null),
    getPose: vi.fn((space) => poseFor(space)),
  };
}

describe("VRExplorationManager._gatherInputState — transient-pointer support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces right-hand controller state from a gripless 'none' handed source", () => {
    const source = {
      handedness: "none",
      targetRayMode: "transient-pointer",
      targetRaySpace: {},
      gripSpace: null,
      gamepad: null,
      hand: null,
    };
    mockVrManager.isSelectPressed.mockReturnValue(true);

    const frame = makeFrame([source]);
    const state = vrExplorationManager._gatherInputState(frame, {});

    expect(state.controllers.right).toBeTruthy();
    expect(state.controllers.right.targetRay).toBe(TRANSFORM);
    expect(state.controllers.right.triggerPressed).toBe(true);
    expect(state.controllers.right.targetRayMode).toBe("transient-pointer");
    expect(state.controllers.right.isTransientPointer).toBe(true);
  });

  it("does not overwrite a tracked controller with a transient pointer for the same hand", () => {
    const tracked = {
      handedness: "right",
      targetRaySpace: {},
      gripSpace: {},
      gamepad: { buttons: [{ pressed: true, value: 1 }], axes: [] },
      hand: null,
    };
    const transient = {
      handedness: "none",
      targetRayMode: "transient-pointer",
      targetRaySpace: {},
      gripSpace: null,
      gamepad: null,
      hand: null,
    };

    const frame = makeFrame([tracked, transient]);
    const state = vrExplorationManager._gatherInputState(frame, {});

    // The tracked controller (with gamepad) wins
    expect(state.controllers.right.gamepad).toBe(tracked.gamepad);
    expect(state.controllers.right.triggerPressed).toBe(true);
    expect(state.controllers.right.isTransientPointer).toBe(false);
  });

  it("still reads gamepad-based trigger for grip controllers, ORed with select state", () => {
    const source = {
      handedness: "left",
      targetRaySpace: {},
      gripSpace: {},
      gamepad: { buttons: [{ pressed: false, value: 0 }], axes: [] },
      hand: null,
    };
    mockVrManager.isSelectPressed.mockReturnValue(true);

    const frame = makeFrame([source]);
    const state = vrExplorationManager._gatherInputState(frame, {});

    expect(state.controllers.left.triggerPressed).toBe(true);
    expect(state.controllers.left.isTransientPointer).toBe(false);
  });

  it("skips hand-tracking sources and sources without poses", () => {
    const handSource = { handedness: "left", hand: {}, targetRaySpace: {} };
    const noPose = {
      handedness: "none",
      targetRayMode: "transient-pointer",
      targetRaySpace: {},
      gripSpace: null,
      hand: null,
    };

    const frame = makeFrame([handSource, noPose], () => null);
    const state = vrExplorationManager._gatherInputState(frame, {});

    expect(state.controllers.left).toBeNull();
    expect(state.controllers.right).toBeNull();
  });
});

describe("VRExplorationManager._onFrame — one-shot gripless navigation-mode switch", () => {
  const GRIPLESS_SOURCE = {
    handedness: "none",
    targetRayMode: "transient-pointer",
    targetRaySpace: {},
    gripSpace: null,
    gamepad: null,
    hand: null,
  };
  const TRACKED_SOURCE = {
    handedness: "right",
    targetRaySpace: {},
    gripSpace: {},
    gamepad: { buttons: [{ pressed: false, value: 0 }], axes: [] },
    hand: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vrExplorationManager._inputProfileDetected = false;
    vrExplorationManager._activeContext = { handler: {}, vrContext: {} };
    vrExplorationManager._navigationController = {
      getMode: vi.fn(() => "fly"),
      setMode: vi.fn(),
      update: vi.fn(() => ({ vrScale: null, position: null })),
    };
  });

  afterEach(() => {
    vrExplorationManager._activeContext = null;
    vrExplorationManager._navigationController = null;
    vrExplorationManager._inputProfileDetected = false;
  });

  it("switches the default fly mode to grab on the first frame that is gripless-only", () => {
    const frame = makeFrame([GRIPLESS_SOURCE]);

    vrExplorationManager._onFrame({ time: 0, deltaTime: 16, frame, viewerPose: null });

    expect(vrExplorationManager._navigationController.setMode).toHaveBeenCalledTimes(1);
    expect(vrExplorationManager._navigationController.setMode).toHaveBeenCalledWith("grab");
    expect(vrExplorationManager._inputProfileDetected).toBe(true);
  });

  it("does not switch again on a second frame (fires at most once per session)", () => {
    const frame = makeFrame([GRIPLESS_SOURCE]);

    vrExplorationManager._onFrame({ time: 0, deltaTime: 16, frame, viewerPose: null });
    expect(vrExplorationManager._navigationController.setMode).toHaveBeenCalledTimes(1);

    vrExplorationManager._navigationController.setMode.mockClear();
    vrExplorationManager._onFrame({ time: 16, deltaTime: 16, frame, viewerPose: null });

    expect(vrExplorationManager._navigationController.setMode).not.toHaveBeenCalled();
  });

  it("does not switch when a tracked (non-gripless) controller is present", () => {
    const frame = makeFrame([TRACKED_SOURCE]);

    vrExplorationManager._onFrame({ time: 0, deltaTime: 16, frame, viewerPose: null });

    expect(vrExplorationManager._navigationController.setMode).not.toHaveBeenCalled();
    expect(vrExplorationManager._inputProfileDetected).toBe(true);
  });

  it("does not switch when the current mode is already not fly", () => {
    vrExplorationManager._navigationController.getMode = vi.fn(() => "teleport");
    const frame = makeFrame([GRIPLESS_SOURCE]);

    vrExplorationManager._onFrame({ time: 0, deltaTime: 16, frame, viewerPose: null });

    expect(vrExplorationManager._navigationController.setMode).not.toHaveBeenCalled();
    expect(vrExplorationManager._inputProfileDetected).toBe(true);
  });

  it("does not detect the input profile on a frame with no controllers at all", () => {
    const frame = makeFrame([]);

    vrExplorationManager._onFrame({ time: 0, deltaTime: 16, frame, viewerPose: null });

    expect(vrExplorationManager._inputProfileDetected).toBe(false);
    expect(vrExplorationManager._navigationController.setMode).not.toHaveBeenCalled();
  });
});
