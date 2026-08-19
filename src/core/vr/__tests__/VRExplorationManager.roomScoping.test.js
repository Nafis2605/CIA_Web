// src/core/vr/__tests__/VRExplorationManager.roomScoping.test.js
// Phase A room scoping made roomId required on POST /vr/sessions
// (resolveRoomAccess() in server/src/routes/vr.js 400s without one), but
// _tryRegisterSession() never sent it — every registration was silently
// falling back to a local id (the .catch swallows the 400). These pin the
// fix directly at the unit under test: the POST body carries roomId when one
// resolves, and _tryRegisterSession skips the POST entirely (rather than
// firing a request guaranteed to 400) when sessionManager.getRoomId() can't
// resolve one yet.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRoomId = vi.fn();

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
vi.mock("@Core/session/sessionManager.js", () => ({
  sessionManager: {
    getRoomId: (...args) => mockGetRoomId(...args),
    getProjectId: vi.fn(() => "project-1"),
  },
}));

import { vrExplorationManager } from "../VRExplorationManager.js";
import { apiClient } from "@Services/apiClient.js";

describe("VRExplorationManager._tryRegisterSession — room scoping", () => {
  beforeEach(() => {
    apiClient.post.mockReset();
    apiClient.delete.mockReset?.();
    mockGetRoomId.mockReset();
  });

  function makeLocalSession(overrides = {}) {
    return {
      id: `vrsession_${Date.now()}_local`,
      viewConfigurationId: "view-1",
      datasetId: "ds-1",
      projectId: "project-1",
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

  it("includes roomId in the POST /vr/sessions body when sessionManager resolves one", async () => {
    mockGetRoomId.mockReturnValue("room-1");
    apiClient.post.mockResolvedValueOnce({ id: "server-session-1" });

    const session = makeLocalSession();
    const result = await vrExplorationManager._tryRegisterSession(session, 1500);

    expect(result).toEqual({ id: "server-session-1" });
    expect(apiClient.post).toHaveBeenCalledWith(
      "/vr/sessions",
      expect.objectContaining({ roomId: "room-1" })
    );
  });

  it("does not POST at all when no room resolves (getRoomId returns falsy)", async () => {
    mockGetRoomId.mockReturnValue(null);

    const session = makeLocalSession();
    const result = await vrExplorationManager._tryRegisterSession(session, 1500);

    expect(result).toBeNull();
    expect(apiClient.post).not.toHaveBeenCalled();
    // Local-id fallback is preserved — the session keeps its client-minted id.
    expect(session.id).toMatch(/^vrsession_/);
  });

  it("does not POST when sessionManager.getRoomId() throws (session not yet initialized)", async () => {
    mockGetRoomId.mockImplementation(() => {
      throw new Error("Session not initialized - call initializeFromURL() first");
    });

    const session = makeLocalSession();
    const result = await vrExplorationManager._tryRegisterSession(session, 1500);

    expect(result).toBeNull();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
