// src/core/vr/__tests__/VRExplorationManager.joinResolve.test.js
// Phase B of the room-scoping/join-correctness plan: joinSession() used to
// resolve a local instance ONLY via getInstanceByViewConfigId(view_configuration_id),
// which — by construction — can never match a peer, since every client
// mints its OWN ViewConfiguration when it opens a dataset (see the comment
// on _resolveSessionKey in VRExplorationManager.js). It also swallowed every
// join failure (401/403/404 included) behind a blanket try/catch. These pin
// the fix: _resolveOrLoadInstanceForSession's step 2 (sync-key match) finds
// a peer's differently-id'd view, a hard 4xx is reported as NOT joined
// (rather than silently downgraded to "observer"), and an auto-load neither
// invents a second load path nor auto-enters VR (it would burn the WebXR
// user-activation gesture the auto-load itself just spent).
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
  workspaceManager: {
    getInstance: vi.fn(),
    getInstanceByViewConfigId: vi.fn(() => null),
    getInstancesByType: vi.fn(() => []),
  },
}));
vi.mock("@Init/appInitializer.js", () => ({
  getViewConfigurationManager: vi.fn(),
  getDatasetManager: vi.fn(),
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
vi.mock("@Services/ViewLifecycleService.js", () => ({
  viewLifecycleService: { createAndPlaceView: vi.fn() },
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
    getRoomId: vi.fn(() => "room-1"),
    getProjectId: vi.fn(() => "project-1"),
  },
}));

import { vrExplorationManager } from "../VRExplorationManager.js";
import { workspaceManager } from "@Core/instances/workspaceManager.js";
import { apiClient } from "@Services/apiClient.js";
import { viewLifecycleService } from "@Services/ViewLifecycleService.js";
import { getDatasetManager } from "@Init/appInitializer.js";
import { PARTICIPATION_MODE } from "@Core/data/models/VRExplorationSession.js";

function makeInstance(viewConfigId, instanceId, datasetId) {
  return {
    instanceId,
    type: "vtk",
    viewConfigId,
    instanceData: { dataset: datasetId ? { id: datasetId } : null, hasData: true },
  };
}

describe("VRExplorationManager — join resolution (Phase B)", () => {
  beforeEach(() => {
    apiClient.post.mockReset();
    workspaceManager.getInstance.mockReset();
    workspaceManager.getInstanceByViewConfigId.mockReset();
    workspaceManager.getInstanceByViewConfigId.mockReturnValue(null);
    workspaceManager.getInstancesByType.mockReset();
    workspaceManager.getInstancesByType.mockReturnValue([]);
    viewLifecycleService.createAndPlaceView.mockReset();
    getDatasetManager.mockReset();

    vrExplorationManager._offVRSessionObserver?.();
    vrExplorationManager._offVRSessionObserver = null;
    vrExplorationManager._activeSession = null;
    vrExplorationManager._activeContext = null;
    vrExplorationManager._participantSync = null;
    vrExplorationManager._controlManager = null;
  });

  describe("_resolveOrLoadInstanceForSession", () => {
    it("resolves a peer's view via the sync key when viewConfigId differs (step 2)", async () => {
      // The host's session carries ITS OWN viewConfigId ("host-view") — this
      // client never has that id locally (every client mints its own — see
      // the file's own comment on _resolveSessionKey). What IS common is the
      // dataset id, which is what step 2 (instanceMatchesViewUpdate) matches on.
      const peerInstance = makeInstance("my-own-view", "inst-peer", "ds-shared");
      workspaceManager.getInstancesByType.mockReturnValue([peerInstance]);

      const sessionRecord = { id: "s1", view_configuration_id: "host-view", dataset_id: "ds-shared" };
      const joinResponse = {
        viewConfigurationId: "host-view",
        dataset: { id: "ds-shared", kind: "server", name: "Shared Dataset" },
      };

      const result = await vrExplorationManager._resolveOrLoadInstanceForSession(sessionRecord, joinResponse);

      expect(result.instance).toBe(peerInstance);
      expect(result.loaded).toBe(false);
      // getInstanceByViewConfigId was tried first (step 1) and correctly
      // found nothing — step 2 is what actually resolved it.
      expect(workspaceManager.getInstanceByViewConfigId).toHaveBeenCalledWith("host-view");
    });

    it("prefers an exact view_configuration_id match (step 1) over the sync key", async () => {
      const exactInstance = makeInstance("shared-view", "inst-exact", "ds-1");
      workspaceManager.getInstanceByViewConfigId.mockImplementation((id) =>
        id === "shared-view" ? exactInstance : null
      );
      // A decoy that WOULD match on sync key too — step 1 must win first.
      const decoy = makeInstance("other-view", "inst-decoy", "ds-1");
      workspaceManager.getInstancesByType.mockReturnValue([decoy]);

      const sessionRecord = { id: "s1", view_configuration_id: "shared-view", dataset_id: "ds-1" };
      const result = await vrExplorationManager._resolveOrLoadInstanceForSession(sessionRecord, null);

      expect(result.instance).toBe(exactInstance);
      expect(result.loaded).toBe(false);
    });

    it("returns 'awaiting-join-response' when called before the join POST resolves, without attempting auto-load", async () => {
      const sessionRecord = { id: "s1", view_configuration_id: "host-view", dataset_id: "ds-none-local" };
      const result = await vrExplorationManager._resolveOrLoadInstanceForSession(sessionRecord, null);

      expect(result.instance).toBeNull();
      expect(result.reason).toBe("awaiting-join-response");
      expect(viewLifecycleService.createAndPlaceView).not.toHaveBeenCalled();
    });
  });

  describe("joinSession", () => {
    it("a 403 (not-a-room-member) does NOT report joined — no fallthrough to 'joined as observer'", async () => {
      const apiError = Object.assign(new Error("not-a-room-member"), {
        status: 403,
        details: { error: "not-a-room-member" },
      });
      apiClient.post.mockRejectedValue(apiError);

      const sessionRecord = { id: "s1", view_configuration_id: "host-view", dataset_id: "ds-1" };
      const result = await vrExplorationManager.joinSession(sessionRecord, PARTICIPATION_MODE.DESKTOP_OBSERVER);

      expect(result.joined).toBe(false);
      expect(result.error).toBe("not-a-room-member");
    });

    it("a 409 cross-room does NOT report joined, even in VR mode with no local instance", async () => {
      const apiError = Object.assign(new Error("cross-room"), {
        status: 409,
        details: { error: "cross-room", roomId: "room-A", roomName: "Room A" },
      });
      apiClient.post.mockRejectedValue(apiError);

      const sessionRecord = { id: "s1", view_configuration_id: "host-view", dataset_id: "ds-1" };
      const result = await vrExplorationManager.joinSession(sessionRecord, PARTICIPATION_MODE.VR_EXPLORER);

      expect(result.joined).toBe(false);
      expect(result.error).toBe("cross-room");
      expect(result.detail.roomName).toBe("Room A");
      // Must not have fallen through into instance resolution/VR entry at all.
      expect(viewLifecycleService.createAndPlaceView).not.toHaveBeenCalled();
    });

    it("auto-load calls createAndPlaceView exactly once and does NOT auto-enter VR", async () => {
      // Nothing resolvable locally at all — forces step 3 (auto-load).
      workspaceManager.getInstanceByViewConfigId.mockReturnValue(null);
      workspaceManager.getInstancesByType.mockReturnValue([]);

      let registered = false;
      const dm = {
        getDataset: vi.fn(() => (registered ? { id: "ds-auto" } : null)),
        fetchDatasetById: vi.fn(async () => {
          registered = true;
          return { id: "ds-auto" };
        }),
      };
      getDatasetManager.mockReturnValue(dm);

      const autoLoadedInstance = makeInstance("new-view-id", "inst-auto", "ds-auto");
      // After createAndPlaceView "places" the new view, a lookup by ITS id
      // must resolve to the freshly created instance.
      workspaceManager.getInstanceByViewConfigId.mockImplementation((id) =>
        id === "new-view-id" ? autoLoadedInstance : null
      );
      viewLifecycleService.createAndPlaceView.mockResolvedValue({
        view: { id: "new-view-id" },
        placement: {},
      });

      apiClient.post.mockResolvedValue({
        joined: true,
        session: { id: "s1" },
        participant: { participantId: "user-1#device-1", mode: "vr-explorer", userName: "Tester" },
        dataset: { id: "ds-auto", kind: "server", name: "Auto Dataset" },
        viewConfigurationId: "host-view-not-open-here",
        state: null,
        lease: null,
      });

      const startExplorationSpy = vi.spyOn(vrExplorationManager, "startExploration");

      const sessionRecord = {
        id: "s1",
        view_configuration_id: "host-view-not-open-here",
        dataset_id: "ds-auto",
        default_exploration_mode: "fly",
        default_vr_scale: 1,
      };
      const result = await vrExplorationManager.joinSession(sessionRecord, PARTICIPATION_MODE.VR_EXPLORER);

      expect(viewLifecycleService.createAndPlaceView).toHaveBeenCalledTimes(1);
      expect(viewLifecycleService.createAndPlaceView).toHaveBeenCalledWith("ds-auto");
      expect(startExplorationSpy).not.toHaveBeenCalled();
      expect(result.joined).toBe(true);
      expect(result.vrEntered).toBe(false);
      expect(result.reason).toBe("ready-press-enter");
      expect(result.instanceId).toBe("inst-auto");

      startExplorationSpy.mockRestore();
    });
  });
});
