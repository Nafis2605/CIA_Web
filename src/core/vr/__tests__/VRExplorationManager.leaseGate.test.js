// src/core/vr/__tests__/VRExplorationManager.leaseGate.test.js
// Phase D4: _hasManipulationControl's three previously-fail-OPEN branches
// (no lock, non-function canManipulate, a throw) now depend on
// `_leaseRequired` — true ONLY once the active session is confirmed against
// a real server row (see isServerSessionId in VRManipulationLock.js).
//
//  - _leaseRequired === true  (a real server session): those branches fail
//    CLOSED. A session with an obtainable lease and a broken lock is a bug,
//    not "nobody's contesting it".
//  - _leaseRequired === false (no session yet / a local `vrsession_*` id
//    with no server row to lease against): those branches stay fail OPEN,
//    exactly the pre-D4 behaviour — see
//    VRExplorationManager.manipulationGate.test.js, which this extends and
//    must keep passing unmodified in spirit (its ~21 lock-less-context
//    scenarios never set _leaseRequired, so they exercise the default
//    `false` and must stay permissive).
//
// When the lock DOES exist and answers normally, its answer is always
// authoritative regardless of _leaseRequired (a local session still runs
// the original Y.js mutual-exclusion) — covered here too.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() });
  return {
    vr: mkLog(),
    app: mkLog(),
    sync: mkLog(),
    view: mkLog(),
    cursor: mkLog(),
    presence: mkLog(),
    createLogger: () => mkLog(),
  };
});

vi.mock("@Core/vr/VRManager.js", () => ({
  vrManager: { isVRSupported: vi.fn(() => false), on: vi.fn(), off: vi.fn() },
}));
vi.mock("@Core/data/models/VRExplorationSession.js", () => ({
  VRExplorationSession: class {},
  PARTICIPATION_MODE: { VR_EXPLORER: "vr-explorer", DESKTOP_OBSERVER: "desktop-observer" },
  SESSION_STATUS: { ACTIVE: "active" },
  EXPLORATION_MODES: {
    FLY: "fly",
    TELEPORT: "teleport",
    WALK: "walk",
    GRAB: "grab",
    MOVE_OBJECT: "move-object",
  },
}));
vi.mock("@Core/vr/VRParticipantSync.js", () => ({
  VRParticipantSync: vi.fn().mockImplementation(function () {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.rekey = vi.fn();
  }),
}));
vi.mock("@Core/vr/VRSnapshotManager.js", () => ({ VRSnapshotManager: class {} }));
vi.mock("@Core/vr/VRControlManager.js", () => ({
  VRControlManager: vi.fn().mockImplementation(function () {
    this.rekey = vi.fn();
    this.cleanup = vi.fn();
  }),
}));
// Real module — NOT mocked. isServerSessionId (the thing under test's
// wiring) must be the real implementation here.
vi.mock("@Core/vr/navigation/VRNavigationController.js", () => ({
  VRNavigationController: class {},
}));
vi.mock("@Core/instances/workspaceManager.js", () => ({
  workspaceManager: { getInstance: vi.fn(), getInstancesByType: vi.fn(() => []) },
}));
vi.mock("@Init/appInitializer.js", () => ({ getViewConfigurationManager: vi.fn() }));
vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: vi.fn(() => "peer-2"),
  getUserName: vi.fn(() => "Bob"),
  getUserColor: vi.fn(() => "#ff0000"),
  getParticipantId: vi.fn(() => "peer-2"),
  getParticipantName: vi.fn(() => "Bob"),
  isSelfIdentity: vi.fn((id) => id === "peer-2"),
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRAvatars.js", () => ({
  vrAvatarSystem: { initialize: vi.fn(), dispose: vi.fn(), rekey: vi.fn() },
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRSpatialUI.js", () => ({
  vrSpatialUI: { dispose: vi.fn() },
}));
vi.mock("@Core/vr/VRMultiViewGrid.js", () => ({
  vrMultiViewGrid: { disable: vi.fn(), isEnabled: vi.fn(() => false) },
}));
vi.mock("@Services/apiClient.js", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), delete: vi.fn() },
}));
vi.mock("@Core/instances/types/vtk/features/index.js", () => ({
  vtkClippingFeature: { getConfigForSync: vi.fn(() => ({ enabled: true })) },
  vtkSceneFeature: {},
  vtkThresholdFeature: { getConfigForSync: vi.fn() },
  vtkIsosurfaceFeature: { getConfigForSync: vi.fn() },
}));
vi.mock("@Core/instances/types/vtk/features/VTKGlyphFeature.js", () => ({
  vtkGlyphFeature: { getState: vi.fn(), getConfigForSync: vi.fn() },
  isGlyphFeatureAvailable: vi.fn(() => false),
}));
vi.mock("@VTK/vtkInstanceTools.js", () => ({
  instanceTools: { getRepresentation: vi.fn(() => "surface"), setRepresentation: vi.fn() },
}));

const mockPush = vi.fn(() => Promise.resolve());
vi.mock("@Services/visualizationSyncService.js", () => ({
  pushSharedVisualizationUpdate: (...args) => mockPush(...args),
}));

vi.mock("@Collaboration/yjs/yjsSetup.js", () => ({
  yVRSessions: { observe: vi.fn(), unobserve: vi.fn() },
  getVRSessionForView: vi.fn(() => null),
  claimVRSession: vi.fn((_v, r) => r),
  heartbeatVRSession: vi.fn(),
  releaseVRSession: vi.fn(),
  syncManipulatorToYjs: vi.fn(),
  yManipulatorState: new Map(),
  awareness: { setLocalState: vi.fn(), on: vi.fn(), off: vi.fn(), getStates: () => new Map() },
}));

import { vrExplorationManager } from "../VRExplorationManager.js";
import { vrAvatarSystem } from "@Core/instances/types/vtk/vr/VTKVRAvatars.js";
import { apiClient } from "@Services/apiClient.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const LOCAL_ID = "vrsession_local_abc123";

function primeContext() {
  vrExplorationManager._activeContext = {
    instance: {
      viewConfigId: "view-1",
      instanceId: "inst-1",
      instanceData: { polydata: { fake: true } },
    },
    vrContext: { instanceId: "inst-1" },
  };
}

describe("VRExplorationManager — Phase D4 lease-required fail-closed gate", () => {
  beforeEach(() => {
    mockPush.mockClear();
    primeContext();
    vrExplorationManager._manipulationLock = null;
    vrExplorationManager._leaseRequired = false;
  });

  it("fails CLOSED with no lock when the session is a confirmed server session", () => {
    vrExplorationManager._manipulationLock = null;
    vrExplorationManager._leaseRequired = true;

    expect(vrExplorationManager._hasManipulationControl()).toBe(false);
  });

  it("fails CLOSED when canManipulate is not a function, on a confirmed server session", () => {
    vrExplorationManager._manipulationLock = {};
    vrExplorationManager._leaseRequired = true;

    expect(vrExplorationManager._hasManipulationControl()).toBe(false);
  });

  it("fails CLOSED when the lock throws, on a confirmed server session", () => {
    vrExplorationManager._manipulationLock = {
      canManipulate: () => {
        throw new Error("lease read exploded");
      },
    };
    vrExplorationManager._leaseRequired = true;

    expect(vrExplorationManager._hasManipulationControl()).toBe(false);
  });

  it("a blocked patch is refused (not silently applied) once fail-closed", () => {
    vrExplorationManager._manipulationLock = null;
    vrExplorationManager._leaseRequired = true;

    vrExplorationManager._pushVisualizationPatch({ representation: "wireframe" });

    expect(mockPush).not.toHaveBeenCalled();
    expect(vrExplorationManager.getVRNotice()).toMatch(/data control/i);
  });

  it("stays fail OPEN with no lock on a local/unconfirmed session (regression: pre-D4 behaviour)", () => {
    vrExplorationManager._manipulationLock = null;
    vrExplorationManager._leaseRequired = false;

    expect(vrExplorationManager._hasManipulationControl()).toBe(true);
  });

  it("stays fail OPEN when the lock throws on a local/unconfirmed session", () => {
    vrExplorationManager._manipulationLock = {
      canManipulate: () => {
        throw new Error("boom");
      },
    };
    vrExplorationManager._leaseRequired = false;

    expect(vrExplorationManager._hasManipulationControl()).toBe(true);
  });

  it("a real lock's answer is authoritative regardless of _leaseRequired", () => {
    vrExplorationManager._leaseRequired = false;
    vrExplorationManager._manipulationLock = { canManipulate: () => false };
    expect(vrExplorationManager._hasManipulationControl()).toBe(false);

    vrExplorationManager._leaseRequired = true;
    vrExplorationManager._manipulationLock = { canManipulate: () => true };
    expect(vrExplorationManager._hasManipulationControl()).toBe(true);
  });

  it("a non-boolean canManipulate() return reads as NOT manipulable (strict === true)", () => {
    vrExplorationManager._leaseRequired = false;
    vrExplorationManager._manipulationLock = { canManipulate: () => undefined };
    expect(vrExplorationManager._hasManipulationControl()).toBe(false);
  });
});

describe("VRExplorationManager — _leaseRequired wiring at session-id resolution", () => {
  let manipulationLock;

  beforeEach(() => {
    vi.mocked(vrAvatarSystem.rekey).mockReset();
    apiClient.delete.mockReset();
    apiClient.delete.mockResolvedValue({ success: true });

    manipulationLock = { rekey: vi.fn() };
    vrExplorationManager._participantSync = { rekey: vi.fn() };
    vrExplorationManager._controlManager = { rekey: vi.fn() };
    vrExplorationManager._manipulationLock = manipulationLock;
    vrExplorationManager._activeSession = null;
    vrExplorationManager._activeContext = null;
    vrExplorationManager._leaseRequired = false;
  });

  function makeLocalSession(overrides = {}) {
    return {
      id: LOCAL_ID,
      viewConfigurationId: "view-1",
      datasetId: "ds-1",
      projectId: null,
      ownerUserId: "peer-2",
      ownerUserName: "Bob",
      ...overrides,
    };
  }

  it("_reconcileLateRegistration flips _leaseRequired true when the late id is a real server UUID", () => {
    const session = makeLocalSession();
    vrExplorationManager._activeSession = session;
    vrExplorationManager._activeContext = { instance: { datasetId: "ds-1" } };

    vrExplorationManager._reconcileLateRegistration(session, { id: SERVER_ID });

    expect(session.id).toBe(SERVER_ID);
    expect(vrExplorationManager._leaseRequired).toBe(true);
    expect(manipulationLock.rekey).toHaveBeenCalledWith(SERVER_ID);
  });

  it("_reconcileLateRegistration leaves _leaseRequired false if the adopted id is somehow not server-shaped", () => {
    const session = makeLocalSession();
    vrExplorationManager._activeSession = session;
    vrExplorationManager._activeContext = { instance: { datasetId: "ds-1" } };

    vrExplorationManager._reconcileLateRegistration(session, { id: "not-a-uuid" });

    expect(vrExplorationManager._leaseRequired).toBe(false);
  });
});
