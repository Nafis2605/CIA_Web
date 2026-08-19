// src/core/vr/__tests__/VRExplorationManager.preprocessingGate.test.js
// Issue 7 (Round 2, VR rendering architecture): startExploration must ask the
// server whether a dataset's LOD/octree preprocessing (vrPreprocessing.js) is
// done BEFORE registering a session, so a blocked entry never creates a
// server row that would become an Issue-6 zombie. See
// VRExplorationManager._checkVRPreprocessingReadiness and
// docs/vr-rendering-architecture.md for the boundary this enforces.
//
// Deliberately fails OPEN on a failed readiness fetch itself (opposite of the
// Phase D manipulation lease's fail-CLOSED posture — see
// VRExplorationManager.leaseGate.test.js) since a stale readiness check only
// costs frame rate, not correctness.
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

// REAL VRExplorationSession/VRParticipantSync/VRControlManager (not stubbed
// as bare classes) — startExploration's convergence logic (session id
// adoption vs fresh registration) needs their actual id-tracking behavior,
// same as VRExplorationManager.sessionConvergence.test.js.
vi.mock("@Core/vr/VRParticipantSync.js", () => ({
  VRParticipantSync: vi.fn().mockImplementation(function (session) {
    this._session = session;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.updateLocalState = vi.fn();
    this.rekey = vi.fn();
    this.getJoinOrder = vi.fn(() => []);
  }),
}));
vi.mock("@Core/vr/VRControlManager.js", () => ({
  VRControlManager: vi.fn().mockImplementation(function (session) {
    this._session = session;
    this.cleanup = vi.fn();
    this.rekey = vi.fn();
  }),
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
// _tryRegisterSession requires a resolved roomId before it will POST — stub a
// resolved room so registration proceeds (same as sessionConvergence.test.js).
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
import { vrAvatarSystem } from "@Core/instances/types/vtk/vr/VTKVRAvatars.js";

// A real UUID — the gate treats anything else (builtin ids, local
// placeholders) as "nothing to check" and skips straight past. See
// isValidDatasetUUID in VRExplorationManager.js.
const DATASET_ID = "aaaaaaaa-1111-4111-8111-111111111111";

function makeInstance(viewConfigId, instanceId, datasetId = DATASET_ID) {
  const handler = {
    supportsVRExploration: vi.fn(() => true),
    getWebGLContext: vi.fn(() => ({})),
    enterVRExploration: vi.fn(async () => ({})), // vrContext with no sceneObjects
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

describe("VRExplorationManager — Issue 7 VR preprocessing readiness gate", () => {
  beforeEach(() => {
    yVRSessions.clear();
    apiClient.post.mockReset();
    apiClient.get.mockReset();
    apiClient.delete.mockReset();
    apiClient.delete.mockResolvedValue({ success: true });
    vi.mocked(vrAvatarSystem.rekey).mockReset();

    vrExplorationManager._offVRSessionObserver?.();
    vrExplorationManager._offVRSessionObserver = null;
    vrExplorationManager._activeSession = null;
    vrExplorationManager._activeContext = null;
    vrExplorationManager._participantSync = null;
    vrExplorationManager._controlManager = null;
    vrExplorationManager._lastVRSessionHeartbeat = 0;
    vrExplorationManager._lastServerSessionHeartbeat = 0;
    vrExplorationManager._registeredServerSessionId = null;
  });

  it("required:true && ready:false throws BEFORE any /vr/sessions POST is issued", async () => {
    apiClient.get.mockResolvedValueOnce({
      ready: false,
      required: true,
      status: "processing",
      progress: 40,
      estimatedTime: 300,
    });
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-1", "inst-1"));

    await expect(vrExplorationManager.startExploration("inst-1", {})).rejects.toThrow(
      /preprocessing.*processing.*40%/is
    );

    expect(apiClient.get).toHaveBeenCalledWith(`/vr/preprocessing/${DATASET_ID}/ready`);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("names status, progress and a rounded-minutes estimate in the thrown message", async () => {
    apiClient.get.mockResolvedValueOnce({
      ready: false,
      required: true,
      status: "pending",
      progress: 0,
      estimatedTime: 125, // 125s -> ceil(125/60) = 3 min
    });
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-1b", "inst-1b"));

    await expect(vrExplorationManager.startExploration("inst-1b", {})).rejects.toThrow(
      /pending \(0%\).*3 min/is
    );
  });

  it("required:false proceeds normally, regardless of status", async () => {
    apiClient.get.mockResolvedValueOnce({ ready: true, required: false, status: "not_applicable" });
    apiClient.post.mockResolvedValueOnce({ id: "server-session-1" });
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-2", "inst-2"));

    const session = await vrExplorationManager.startExploration("inst-2", {});

    expect(session.id).toBe("server-session-1");
    expect(apiClient.post).toHaveBeenCalledWith("/vr/sessions", expect.objectContaining({ viewConfigurationId: "view-2" }));
  });

  it("fails OPEN when the /ready fetch rejects — proceeds rather than throwing", async () => {
    apiClient.get.mockRejectedValueOnce(new Error("network down"));
    apiClient.post.mockResolvedValueOnce({ id: "server-session-2" });
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-3", "inst-3"));

    const session = await vrExplorationManager.startExploration("inst-3", {});

    expect(session.id).toBe("server-session-2");
    expect(apiClient.post).toHaveBeenCalled();
  });

  it("fails OPEN when the /ready response is unparseable/malformed", async () => {
    apiClient.get.mockResolvedValueOnce(undefined);
    apiClient.post.mockResolvedValueOnce({ id: "server-session-2b" });
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-3b", "inst-3b"));

    const session = await vrExplorationManager.startExploration("inst-3b", {});

    expect(session.id).toBe("server-session-2b");
  });

  it("config.serverSession present bypasses the check entirely (joiner follows the host)", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-4", "inst-4"));

    const session = await vrExplorationManager.startExploration("inst-4", {
      serverSession: { id: "existing-server-session", owner_user_id: "user-1", owner_user_name: "Tester" },
    });

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(session.id).toBe("existing-server-session");
    // A join adopts the host's id outright — it never re-registers.
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("config.skipPreprocessingCheck:true bypasses the check", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-5", "inst-5"));
    apiClient.post.mockResolvedValueOnce({ id: "server-session-3" });

    const session = await vrExplorationManager.startExploration("inst-5", {
      skipPreprocessingCheck: true,
    });

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(session.id).toBe("server-session-3");
    expect(apiClient.post).toHaveBeenCalled();
  });

  it("a non-UUID/builtin dataset id skips the check without hitting the network", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-6", "inst-6", "builtin-lungs"));
    apiClient.post.mockResolvedValueOnce({ id: "server-session-4" });

    const session = await vrExplorationManager.startExploration("inst-6", {});

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(session.id).toBe("server-session-4");
  });

  it("an absent dataset id skips the check without hitting the network", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-7", "inst-7", null));
    apiClient.post.mockResolvedValueOnce({ id: "server-session-5" });

    const session = await vrExplorationManager.startExploration("inst-7", {});

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(session.id).toBe("server-session-5");
  });
});
