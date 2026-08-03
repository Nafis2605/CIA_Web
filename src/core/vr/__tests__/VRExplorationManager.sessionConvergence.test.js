// src/core/vr/__tests__/VRExplorationManager.sessionConvergence.test.js
// Session convergence (Phase 1): a second "Enter VR" tap on the same view
// must adopt the FIRST tap's Y.js session id instead of minting its own —
// otherwise VRParticipantSync opens a different `vr-participants-<id>` map
// and the two users never see each other. Uses the REAL VRExplorationSession
// and the REAL yjsSetup registry (claimVRSession/getVRSessionForView) so the
// adoption logic in startExploration is exercised end to end; only the VR
// sub-systems that touch WebXR/VTK are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockParticipantSyncInstances, mockControlManagerInstances } = vi.hoisted(() => ({
  mockParticipantSyncInstances: [],
  mockControlManagerInstances: [],
}));

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() });
  return {
    vr: mkLog(),
    app: mkLog(),
    sync: mkLog(),
    view: mkLog(),
    cursor: mkLog(),
    // startExploration/leaveSession publish VR state through presenceSystem,
    // which logs on the `presence` channel.
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

// REAL VRExplorationSession — session convergence needs its actual id/
// ownerUserId/participants behavior, unlike other VRExplorationManager test
// files that stub it as `class {}`.

vi.mock("@Core/vr/VRParticipantSync.js", () => ({
  VRParticipantSync: vi.fn().mockImplementation(function (session) {
    this._session = session;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.updateLocalState = vi.fn();
    this.rekey = vi.fn((newSessionId) => {
      this._session.id = newSessionId;
    });
    mockParticipantSyncInstances.push(this);
  }),
}));

vi.mock("@Core/vr/VRControlManager.js", () => ({
  VRControlManager: vi.fn().mockImplementation(function (session) {
    this._session = session;
    this.cleanup = vi.fn();
    this.rekey = vi.fn((newSessionId) => {
      this._session.id = newSessionId;
    });
    mockControlManagerInstances.push(this);
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
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRAvatars.js", () => ({
  vrAvatarSystem: { initialize: vi.fn(), dispose: vi.fn(), update: vi.fn() },
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
import { yVRSessions, getVRSessionForView } from "@Collaboration/yjs/yjsSetup.js";

function makeInstance(viewConfigId, instanceId) {
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
      dataset: { id: "ds-1" },
      projectId: null,
      hasData: true,
    },
  };
}

describe("VRExplorationManager — session convergence (Y.js vr-sessions registry)", () => {
  beforeEach(async () => {
    yVRSessions.clear();
    mockParticipantSyncInstances.length = 0;
    mockControlManagerInstances.length = 0;
    apiClient.post.mockReset();
    apiClient.post.mockResolvedValue({ id: "server-session-1" });

    // Reset the singleton's state — leaveSession() isn't exercised here, and
    // these tests deliberately call startExploration() more than once on the
    // same manager instance to simulate independent "taps".
    vrExplorationManager._offVRSessionObserver?.();
    vrExplorationManager._offVRSessionObserver = null;
    vrExplorationManager._activeSession = null;
    vrExplorationManager._activeContext = null;
    vrExplorationManager._participantSync = null;
    vrExplorationManager._controlManager = null;
    vrExplorationManager._lastVRSessionHeartbeat = 0;
  });

  it("a second startExploration on the same view adopts the existing sessionId and does not re-register with the server", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-1", "inst-1"));

    const first = await vrExplorationManager.startExploration("inst-1", {});

    expect(first.id).toBe("server-session-1");
    expect(apiClient.post).toHaveBeenCalledWith(
      "/vr/sessions",
      expect.objectContaining({ viewConfigurationId: "view-1" })
    );
    expect(getVRSessionForView("view-1")?.sessionId).toBe("server-session-1");

    apiClient.post.mockClear();

    // Second "tap" on the same view — a different instance object (as a
    // fresh workspaceManager lookup would return), same viewConfigId.
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-1", "inst-2"));

    const second = await vrExplorationManager.startExploration("inst-2", {});

    expect(second.id).toBe("server-session-1"); // adopted, not minted fresh
    expect(second.ownerUserId).toBe("user-1"); // host from the registry record
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("re-keys participantSync and controlManager when the claim race resolves against us", async () => {
    workspaceManager.getInstance.mockReturnValueOnce(makeInstance("view-1", "inst-1"));

    const session = await vrExplorationManager.startExploration("inst-1", {});
    const ourId = session.id;

    // Simulate a competing client's write landing AFTER our own claim
    // resolved locally (see claimVRSession's docstring in yjsSetup.js) — the
    // post-claim observer (_watchVRSessionConvergence) is still attached at
    // this point (its ~3s window hasn't elapsed).
    const winningRecord = {
      sessionId: "vrsession_winner",
      viewConfigurationId: "view-1",
      hostUserId: "user-2",
      hostUserName: "Other User",
      datasetId: "ds-1",
      projectId: null,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      participantCount: 1,
    };
    yVRSessions.set("view-1", winningRecord);

    expect(session.id).toBe("vrsession_winner");
    expect(session.id).not.toBe(ourId);
    expect(session.ownerUserId).toBe("user-2");

    const participantSync = mockParticipantSyncInstances[mockParticipantSyncInstances.length - 1];
    const controlManager = mockControlManagerInstances[mockControlManagerInstances.length - 1];
    expect(participantSync.rekey).toHaveBeenCalledWith("vrsession_winner");
    expect(controlManager.rekey).toHaveBeenCalledWith("vrsession_winner");
  });
});
