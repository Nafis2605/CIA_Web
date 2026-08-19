// src/core/vr/__tests__/VRExplorationManager.sessionConvergence.realManagers.test.js
// End-to-end reproduction of the rekey no-op bug (see VRExplorationManager.js
// _watchVRSessionConvergence). Unlike sessionConvergence.test.js, this file
// does NOT mock VRParticipantSync/VRControlManager/VRManipulationLock — the
// real classes run through the real convergence handler against the real
// (in-memory) Y.js doc, so a broken guard — comparing against the shared,
// already-mutated session.id instead of an independently-tracked bound id —
// shows up as data staying orphaned in the losing session's maps.
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
  vrSpatialUI: { initialize: vi.fn(), dispose: vi.fn(), hitTest: vi.fn(), layout: vi.fn() },
}));
vi.mock("@Core/vr/VRMultiViewGrid.js", () => ({
  vrMultiViewGrid: { disable: vi.fn(), isEnabled: vi.fn(() => false) },
}));
vi.mock("@Services/apiClient.js", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), delete: vi.fn() },
}));
// _tryRegisterSession now requires a resolved roomId before it will POST
// (see VRExplorationManager.js) — a real, un-initialized sessionManager
// singleton would make getRoomId() throw and startExploration() would skip
// registration entirely, which is not what this file is testing. Stub a
// resolved room so registration proceeds as before.
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
import { yVRSessions, ydoc } from "@Collaboration/yjs/yjsSetup.js";

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

describe("VRExplorationManager — session convergence with REAL sub-managers", () => {
  beforeEach(async () => {
    yVRSessions.clear();
    apiClient.post.mockReset();
    apiClient.post.mockResolvedValue({ id: "server-session-1" });

    vrExplorationManager._offVRSessionObserver?.();
    vrExplorationManager._offVRSessionObserver = null;
    vrExplorationManager._activeSession = null;
    vrExplorationManager._activeContext = null;
    vrExplorationManager._participantSync = null;
    vrExplorationManager._controlManager = null;
    vrExplorationManager._manipulationLock = null;
    vrExplorationManager._lastVRSessionHeartbeat = 0;
  });

  it("REAL managers correctly migrate their Y.js maps when the claim race resolves against us", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-1", "inst-1"));
    const session = await vrExplorationManager.startExploration("inst-1", {});
    const ourId = session.id;

    const participantSync = vrExplorationManager._participantSync;
    const manipulationLock = vrExplorationManager._manipulationLock;

    // Populate live state under the LOSING id before the race resolves.
    participantSync.updateLocalState({ headPose: { position: { x: 1, y: 2, z: 3 } } });
    manipulationLock.claimAsHost();

    expect(ydoc.getMap(`vr-participants-${ourId}`).has("user-1")).toBe(true);
    expect(ydoc.getMap(`vr-manipulation-${ourId}`).get("holder")?.holderUserId).toBe("user-1");

    // Competing write lands — exactly _watchVRSessionConvergence's trigger.
    yVRSessions.set("ds-1", {
      sessionId: "vrsession_winner",
      viewConfigurationId: "ds-1",
      hostUserId: "user-2",
      hostUserName: "Other User",
      datasetId: "ds-1",
      projectId: null,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      participantCount: 1,
    });

    expect(session.id).toBe("vrsession_winner");

    // The losing maps must be vacated — this is exactly what the guard bug
    // prevented: every rekey() short-circuited because session.id was
    // already the winning id by the time the guard checked it.
    expect(ydoc.getMap(`vr-participants-${ourId}`).has("user-1")).toBe(false);
    expect(ydoc.getMap(`vr-manipulation-${ourId}`).get("holder")).toBeUndefined();

    // Subsequent writes must land under the WINNING id, proving each manager
    // actually re-bound rather than silently short-circuiting on its guard.
    participantSync._lastUpdateTime = 0; // bypass the pose throttle for this immediate second write
    participantSync.updateLocalState({ headPose: { position: { x: 9, y: 9, z: 9 } } });
    expect(ydoc.getMap("vr-participants-vrsession_winner").has("user-1")).toBe(true);

    // We're no longer host post-rekey (the winning record's hostUserId is
    // "user-2"), so claimAsHost() would correctly refuse — that's real
    // behavior, not a rekey defect. The structural proof that
    // VRManipulationLock actually re-bound is that its live map reference now
    // IS the winning map, the same thing rekey's own unit test asserts.
    expect(manipulationLock._yLock).toBe(ydoc.getMap("vr-manipulation-vrsession_winner"));

    // Clean up so this test's data doesn't leak into others in the same file.
    ydoc.getMap(`vr-participants-${ourId}`).delete("user-1");
    ydoc.getMap("vr-participants-vrsession_winner").delete("user-1");
  });
});
