// src/core/vr/__tests__/VRExplorationManager.hostIdentity.test.js
// Issue 5 (device-grained host identity). The JOIN path (config.serverSession
// in startExploration) used to assign session.ownerUserId from the bare
// owner_user_id column. Two devices signed into the SAME account both then
// passed isSelfIdentity(session.ownerUserId) — an account-level compare — so
// the JOINING device (not just the real host) could also call claimAsHost()
// and seize the manipulation lease, badge itself as host in its own
// presence, and — via the roster's EXACT userId===hostId compare — never
// actually show the real host in the roster (a bare account id never equals
// anyone's composite odUserId).
//
// resolveServerSessionOwnerId (src/core/vr/vrSessionOwner.js) fixes this at
// startExploration's single assignment point by preferring
// owner_participant_id (the accountUserId#deviceId composite migration 021
// added) over the bare owner_user_id. This file is the end-to-end
// reproduction: device B joins a session hosted by device A on the SAME
// account, and must not behave as host.
//
// Uses the REAL VRExplorationSession/VRParticipantSync/VRControlManager/
// VRManipulationLock classes against the real (in-memory) Y.js doc — same
// posture as VRExplorationManager.sessionConvergence.realManagers.test.js —
// because the bug lives in how these real classes read session.ownerUserId,
// not in any mock's approximation of them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  vrManager: {
    isVRSupported: vi.fn(() => true),
    on: vi.fn(() => () => {}),
    off: vi.fn(),
    enterVR: vi.fn(async () => {}),
    getSession: vi.fn(() => ({})),
    getXRLayer: vi.fn(() => ({})),
    getReferenceSpace: vi.fn(() => ({})),
    exitVR: vi.fn(async () => {}),
  },
}));
vi.mock("@Core/vr/tools/VRToolManager.js", () => ({
  VRToolManager: class {
    cleanup() {}
  },
}));
vi.mock("@Core/vr/VRSnapshotManager.js", () => ({
  VRSnapshotManager: class {
    cleanup() {}
  },
}));
vi.mock("@Core/vr/navigation/VRNavigationController.js", () => ({
  VRNavigationController: class {
    setWorldGrabEngagement() {}
    cleanup() {}
  },
}));
vi.mock("@Core/instances/workspaceManager.js", () => ({
  workspaceManager: { getInstance: vi.fn(), getInstanceByViewConfigId: vi.fn() },
}));
vi.mock("@Init/appInitializer.js", () => ({
  getViewConfigurationManager: vi.fn(),
}));

// Device B — the JOINER on the same account as the host (device A,
// "acct#devA"). Deliberately NOT the trivial `id === mockUserId()` pattern
// some other test files use for isSelfIdentity: that would make a composite
// host id from device A silently equal a bare compare and hide the exact bug
// this file exists to catch. Mirrors the real contract in
// src/collaboration/presence/userManagement.js: a composite id (contains
// '#') must match getParticipantId() EXACTLY; a bare id matches on the
// account only.
vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: vi.fn(() => "acct"),
  getUserName: vi.fn(() => "Tester"),
  getUserColor: vi.fn(() => "#ff0000"),
  getParticipantId: vi.fn(() => "acct#devB"),
  getParticipantName: vi.fn(() => "Tester (devB)"),
  isSelfIdentity: vi.fn((id) => {
    if (!id) return false;
    const value = String(id);
    if (value.includes("#")) return value === "acct#devB";
    return value === "acct";
  }),
}));
vi.mock("@Core/identity/deviceIdentity.js", () => ({
  getDeviceId: vi.fn(() => "devB"),
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRAvatars.js", () => ({
  vrAvatarSystem: { initialize: vi.fn(), dispose: vi.fn(), update: vi.fn(), rekey: vi.fn() },
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRSpatialUI.js", () => ({
  vrSpatialUI: { initialize: vi.fn(), dispose: vi.fn(), hitTest: vi.fn(), layout: vi.fn() },
}));
vi.mock("@Core/vr/VRMultiViewGrid.js", () => ({
  vrMultiViewGrid: { disable: vi.fn(), isEnabled: vi.fn(() => false) },
}));
vi.mock("@Services/apiClient.js", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), delete: vi.fn() },
}));
vi.mock("@Core/session/sessionManager.js", () => ({
  sessionManager: {
    getRoomId: vi.fn(() => "room-1"),
    getProjectId: vi.fn(() => "project-1"),
  },
}));
vi.mock("@Core/instances/types/vtk/features/index.js", () => ({
  vtkClippingFeature: { getConfigForSync: vi.fn() },
  vtkSceneFeature: {},
  vtkThresholdFeature: { getConfigForSync: vi.fn() },
  vtkIsosurfaceFeature: { getConfigForSync: vi.fn() },
}));
vi.mock("@Core/instances/types/vtk/features/VTKGlyphFeature.js", () => ({
  vtkGlyphFeature: { getState: vi.fn(), getConfigForSync: vi.fn() },
  isGlyphFeatureAvailable: vi.fn(() => false),
}));
vi.mock("@VTK/vtkInstanceTools.js", () => ({
  instanceTools: { getRepresentation: vi.fn(), setRepresentation: vi.fn() },
}));
vi.mock("@Services/visualizationSyncService.js", () => ({
  pushSharedVisualizationUpdate: vi.fn(),
}));

import { vrExplorationManager } from "../VRExplorationManager.js";
import { workspaceManager } from "@Core/instances/workspaceManager.js";
import { apiClient } from "@Services/apiClient.js";
import { yVRSessions } from "@Collaboration/yjs/yjsSetup.js";
import { presenceSystem } from "@Collaboration/presence/presenceSystem.js";
import { VRManipulationLock } from "@Core/vr/VRManipulationLock.js";

// UUID-shaped so isServerSessionId() (VRManipulationLock.js) recognizes this
// as a real server session — the device-grain gate this file also exercises
// only ever applies to server sessions.
const SERVER_ID = "aaaaaaaa-1111-4111-8111-111111111111";

function makeInstance(viewConfigId, instanceId, datasetId = "ds-1") {
  const handler = {
    supportsVRExploration: vi.fn(() => true),
    getWebGLContext: vi.fn(() => ({})),
    enterVRExploration: vi.fn(async () => ({})),
  };
  return {
    instanceId,
    handler,
    viewConfigId,
    instanceData: {
      dataset: datasetId ? { id: datasetId } : null,
      projectId: null,
      hasData: true,
    },
  };
}

describe("VRExplorationManager — device-grained host identity on join (Issue 5)", () => {
  let claimAsHostSpy;
  let setVRPresenceSpy;

  beforeEach(() => {
    yVRSessions.clear();
    apiClient.post.mockReset();

    vrExplorationManager._offVRSessionObserver?.();
    vrExplorationManager._offVRSessionObserver = null;
    vrExplorationManager._activeSession = null;
    vrExplorationManager._activeContext = null;
    vrExplorationManager._participantSync = null;
    vrExplorationManager._controlManager = null;
    vrExplorationManager._manipulationLock = null;
    vrExplorationManager._lastVRSessionHeartbeat = 0;

    claimAsHostSpy = vi.spyOn(VRManipulationLock.prototype, "claimAsHost");
    setVRPresenceSpy = vi.spyOn(presenceSystem, "setVRPresence");
  });

  afterEach(() => {
    claimAsHostSpy.mockRestore();
    setVRPresenceSpy.mockRestore();
  });

  it("a joining device on the SAME account as the host does not claim host authority", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-1", "inst-1"));

    const session = await vrExplorationManager.startExploration("inst-1", {
      serverSession: {
        id: SERVER_ID,
        owner_user_id: "acct", // same account as the joiner (getUserId() === "acct")
        owner_user_name: "Alice",
        owner_participant_id: "acct#devA", // migration 021 — device A, NOT devB
      },
    });

    // The core assignment fix: ownerUserId is device-grained (owner_participant_id),
    // not the bare account id — so THIS device (devB) correctly reads as "not host".
    expect(session.ownerUserId).toBe("acct#devA");

    // claimAsHost() must never even be attempted — startExploration's own
    // isSelfIdentity(session.ownerUserId) gate is what stops it here, before
    // VRManipulationLock's defense-in-depth device-grain gate
    // (_isHostAtDeviceGrain, for legacy bare-id rows) would even be reached.
    expect(claimAsHostSpy).not.toHaveBeenCalled();
    expect(vrExplorationManager._manipulationLock.getHolder()).toBeNull();

    // Presence badge must say "participant", not "host".
    expect(setVRPresenceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ vrRole: "participant" })
    );

    // Roster: a real join always upserts the OTHER device's participant row
    // via VRParticipantSync's Y.js awareness observer (see
    // VRParticipantSync._handleParticipantUpdate) once device A's pose/
    // presence packet arrives. Calling the same upsert this manager's own
    // sync handler calls is the direct way to assert the roster's isHost
    // read without standing up a second live Y.js peer in this test.
    session.upsertParticipant("acct#devA", "Alice", "#123456", "vr-explorer");
    const roster = vrExplorationManager.getSessionRoster();

    const hostRow = roster.find((r) => r.userId === "acct#devA");
    expect(hostRow).toBeDefined();
    expect(hostRow.isHost).toBe(true);

    const selfRow = roster.find((r) => r.userId === "acct#devB");
    expect(selfRow).toBeDefined();
    expect(selfRow.isHost).toBe(false);
    expect(selfRow.isSelf).toBe(true);
  });
});
