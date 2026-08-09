// src/core/vr/__tests__/VRExplorationManager.registrationReconciliation.test.js
// H3: _tryRegisterSession() races its POST /vr/sessions against a 1.5s
// timeout via Promise.race, which does not cancel the loser. Previously, if
// the timeout won, the POST's eventual resolution was simply dropped —
// silently orphaning a real server row nobody's Y.js state ever pointed to.
// These tests exercise _reconcileLateRegistration(), which now runs whenever
// that POST resolves, whether or not it won the race.
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
vi.mock("@Core/vr/VRParticipantSync.js", () => ({
  VRParticipantSync: vi.fn().mockImplementation(function () {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.updateLocalState = vi.fn();
    this.rekey = vi.fn();
  }),
}));
vi.mock("@Core/vr/VRControlManager.js", () => ({
  VRControlManager: vi.fn().mockImplementation(function () {
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
vi.mock("@Core/identity/deviceIdentity.js", () => ({
  getDeviceId: vi.fn(() => "device-1"),
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
import { apiClient } from "@Services/apiClient.js";
import { yVRSessions, getVRSessionForView } from "@Collaboration/yjs/yjsSetup.js";
import { vrAvatarSystem } from "@Core/instances/types/vtk/vr/VTKVRAvatars.js";

/** A deferred promise the test controls the resolution timing of. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("VRExplorationManager — late VR session registration reconciliation (H3)", () => {
  let participantSync;
  let controlManager;
  let manipulationLock;

  beforeEach(() => {
    yVRSessions.clear();
    apiClient.post.mockReset();
    apiClient.delete.mockReset();
    apiClient.delete.mockResolvedValue({ success: true });
    vi.mocked(vrAvatarSystem.rekey).mockReset();

    participantSync = { rekey: vi.fn() };
    controlManager = { rekey: vi.fn() };
    manipulationLock = { rekey: vi.fn() };

    vrExplorationManager._participantSync = participantSync;
    vrExplorationManager._controlManager = controlManager;
    vrExplorationManager._manipulationLock = manipulationLock;
    vrExplorationManager._activeSession = null;
    vrExplorationManager._activeContext = null;
  });

  function makeLocalSession(overrides = {}) {
    return {
      id: `vrsession_${Date.now()}_local`,
      viewConfigurationId: "view-1",
      datasetId: "ds-1",
      projectId: null,
      explorationMode: "fly",
      vrScale: 1,
      allowJoin: true,
      allowDesktopParticipants: true,
      allowDesktopControl: false,
      ownerUserId: "user-1",
      ownerUserName: "Tester",
      ...overrides,
    };
  }

  it("adopts the server id and rekeys every session-scoped subsystem when the POST resolves late but the session is still active", async () => {
    const { promise, resolve } = deferred();
    apiClient.post.mockReturnValueOnce(promise);

    const session = makeLocalSession();
    vrExplorationManager._activeSession = session;
    vrExplorationManager._activeContext = { instance: { datasetId: "ds-1" } };
    const localId = session.id;

    // Timeout (20ms) wins the race — the POST is still pending.
    const result = await vrExplorationManager._tryRegisterSession(session, 20);
    expect(result).toBeNull();
    expect(session.id).toBe(localId); // unchanged — still on the local id

    // The POST now completes late, with the server's own generated id.
    resolve({ id: "server-real-id" });
    await promise;
    // Flush the .then() reconciliation microtask chained onto `promise`.
    await Promise.resolve();
    await Promise.resolve();

    expect(session.id).toBe("server-real-id");
    expect(participantSync.rekey).toHaveBeenCalledWith("server-real-id");
    expect(controlManager.rekey).toHaveBeenCalledWith("server-real-id");
    expect(manipulationLock.rekey).toHaveBeenCalledWith("server-real-id");
    expect(vrAvatarSystem.rekey).toHaveBeenCalledWith("server-real-id");
    expect(getVRSessionForView("ds-1")?.sessionId).toBe("server-real-id");
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it("ends the orphaned server session instead of adopting it when the client has already left by the time the POST resolves", async () => {
    const { promise, resolve } = deferred();
    apiClient.post.mockReturnValueOnce(promise);

    const session = makeLocalSession();
    vrExplorationManager._activeSession = session;

    const result = await vrExplorationManager._tryRegisterSession(session, 20);
    expect(result).toBeNull();

    // The user left VR (or a Y.js convergence race re-keyed them elsewhere)
    // before the late response arrived.
    vrExplorationManager._activeSession = null;

    resolve({ id: "server-real-id" });
    await promise;
    await Promise.resolve();
    await Promise.resolve();

    // Never adopted — we've moved on.
    expect(session.id).not.toBe("server-real-id");
    expect(participantSync.rekey).not.toHaveBeenCalled();
    expect(vrAvatarSystem.rekey).not.toHaveBeenCalled();
    expect(apiClient.delete).toHaveBeenCalledWith("/vr/sessions/server-real-id");
  });

  it("fast path (POST wins the race) never triggers reconciliation, even before _activeSession is set", async () => {
    apiClient.post.mockResolvedValueOnce({ id: "server-fast-id" });

    const session = makeLocalSession();
    // Deliberately NOT set as _activeSession yet — in the real flow,
    // startExploration only assigns _activeSession after _tryRegisterSession
    // returns (sub-managers are constructed in between). Reconciliation must
    // not run in this branch at all; if it did, "not yet active" would look
    // identical to "already left", and it would wrongly delete the session
    // it just created.
    vrExplorationManager._activeSession = null;

    const result = await vrExplorationManager._tryRegisterSession(session, 1500);
    expect(result).toEqual({ id: "server-fast-id" });

    await Promise.resolve();
    await Promise.resolve();

    expect(participantSync.rekey).not.toHaveBeenCalled();
    expect(vrAvatarSystem.rekey).not.toHaveBeenCalled();
    expect(apiClient.delete).not.toHaveBeenCalled();
  });
});
