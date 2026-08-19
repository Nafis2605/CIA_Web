// src/core/vr/__tests__/VRExplorationManager.gestureRollback.test.js
// Phase D5: beginManipulationGesture/endManipulationGesture wrap a shared-data
// gesture (menu tap, drag, throttled value change) so the permission read AND
// the pre-gesture snapshot both happen BEFORE the local mutation, with a
// rollback path (via VTKInstanceHandler.applySharedState, reusing its
// _beginApplyingRemoteState/_endApplyingRemoteState loop guard) for when the
// answer turns out to be no.
//
// Covers the three things the plan calls out as load-bearing:
//  1. begin() captures the aggregate snapshot BEFORE any local mutation.
//  2. A rejected acquire (canManipulate() false) rolls back via
//     applySharedState with exactly that pre-gesture snapshot.
//  3. The _deferHeavy path (setRepresentation) captures BEFORE deferral —
//     not inside the deferred callback, which would read state AFTER the
//     local mutation already ran.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

vi.mock("@Core/vr/VRManager.js", () => ({
  vrManager: { isVRSupported: vi.fn(() => false), on: vi.fn(), off: vi.fn() },
}));
vi.mock("@Core/data/models/VRExplorationSession.js", () => ({
  VRExplorationSession: class {},
  PARTICIPATION_MODE: { VR_EXPLORER: "vr-explorer", DESKTOP_OBSERVER: "desktop-observer" },
  SESSION_STATUS: { ACTIVE: "active" },
  EXPLORATION_MODES: { FLY: "fly", TELEPORT: "teleport", WALK: "walk", GRAB: "grab", MOVE_OBJECT: "move-object" },
}));
vi.mock("@Core/vr/VRParticipantSync.js", () => ({ VRParticipantSync: class {} }));
vi.mock("@Core/vr/tools/VRToolManager.js", () => ({ VRToolManager: class {} }));
vi.mock("@Core/vr/VRSnapshotManager.js", () => ({ VRSnapshotManager: class {} }));
vi.mock("@Core/vr/VRControlManager.js", () => ({ VRControlManager: class {} }));
vi.mock("@Core/vr/VRManipulationLock.js", () => ({
  VRManipulationLock: class {},
  isServerSessionId: (id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id),
}));
vi.mock("@Core/vr/navigation/VRNavigationController.js", () => ({ VRNavigationController: class {} }));
vi.mock("@Core/instances/workspaceManager.js", () => ({
  workspaceManager: { getInstance: vi.fn(), getInstancesByType: vi.fn(() => []) },
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
  vrAvatarSystem: { initialize: vi.fn(), dispose: vi.fn() },
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
  vtkThresholdFeature: { getConfigForSync: vi.fn(), getState: vi.fn(), toggleThreshold: vi.fn(), setMode: vi.fn(), selectArray: vi.fn() },
  vtkIsosurfaceFeature: { getConfigForSync: vi.fn() },
}));
vi.mock("@Core/instances/types/vtk/features/VTKGlyphFeature.js", () => ({
  vtkGlyphFeature: { getState: vi.fn(), getConfigForSync: vi.fn() },
  isGlyphFeatureAvailable: vi.fn(() => false),
}));
vi.mock("@VTK/vtkInstanceTools.js", () => ({
  instanceTools: {
    getRepresentation: vi.fn(() => "surface"),
    setRepresentation: vi.fn(),
    getPosition: vi.fn(() => [0, 0, 0]),
    getRotation: vi.fn(() => [0, 0, 0]),
    getScale: vi.fn(() => [1, 1, 1]),
  },
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

// The rollback snapshot source (Phase C3) — mocked here for a deterministic,
// distinguishable fake snapshot rather than exercising the real per-feature
// reads (covered by vtkStateAggregator.roundtrip.test.js).
const mockAggregate = vi.fn();
vi.mock("@Core/instances/types/vtk/vtkStateAggregator.js", () => ({
  aggregateVTKVisualizationState: (...args) => mockAggregate(...args),
}));

import { vrExplorationManager } from "../VRExplorationManager.js";
import { instanceTools } from "@VTK/vtkInstanceTools.js";
import { vtkThresholdFeature } from "@Core/instances/types/vtk/features/index.js";

function primeContext(applySharedState = vi.fn(() => Promise.resolve())) {
  const handler = { applySharedState };
  vrExplorationManager._activeContext = {
    instance: {
      viewConfigId: "view-1",
      instanceId: "inst-1",
      instanceData: { polydata: { fake: true } },
    },
    vrContext: { instanceId: "inst-1" },
    handler,
  };
  return handler;
}

describe("VRExplorationManager — Phase D5 gesture begin/end + rollback", () => {
  let handler;

  beforeEach(() => {
    mockPush.mockClear();
    mockAggregate.mockReset();
    mockAggregate.mockReturnValue({ pointSize: 42 });
    handler = primeContext();
    vrExplorationManager._manipulationLock = null;
    vrExplorationManager._leaseRequired = false;
    vrExplorationManager._gestureSnapshot = null;
    vrExplorationManager._gestureOpId = null;
    vrExplorationManager._transformGestureActive = false;
    vrExplorationManager._clipGestureActive = false;
    vrExplorationManager._throttledGestureActive = false;
    vrExplorationManager._deferredWork = [];
    vrExplorationManager._pendingWorkLabel = null;
    vi.mocked(instanceTools.setRepresentation).mockClear();
    vi.mocked(instanceTools.getPosition).mockReturnValue([0, 0, 0]);
    vi.mocked(instanceTools.getRotation).mockReturnValue([0, 0, 0]);
    vi.mocked(instanceTools.getScale).mockReturnValue([1, 1, 1]);
  });

  describe("beginManipulationGesture / endManipulationGesture", () => {
    it("captures the aggregate snapshot BEFORE any local mutation, and mints an opId", async () => {
      vrExplorationManager._manipulationLock = { canManipulate: () => true, heartbeat: vi.fn() };

      const ok = await vrExplorationManager.beginManipulationGesture("transform", { instanceId: "inst-1" });

      expect(ok).toBe(true);
      expect(mockAggregate).toHaveBeenCalledWith("inst-1", { polydata: { fake: true } });
      expect(vrExplorationManager._gestureSnapshot).toMatchObject({
        kind: "transform",
        instanceId: "inst-1",
        state: { pointSize: 42 },
      });
      expect(vrExplorationManager._gestureOpId).toEqual(expect.any(String));
      expect(vrExplorationManager._gestureOpId).toMatch(/^user-1_transform_/);
    });

    it("a rejected gesture (no manipulation control) rolls back via applySharedState with the pre-gesture snapshot", async () => {
      vrExplorationManager._manipulationLock = {
        canManipulate: () => false,
        heartbeat: vi.fn(),
        getHolder: () => ({ holderUserId: "host-1", holderUserName: "Alice" }),
      };
      mockAggregate.mockReturnValue({ clipBox: { enabled: true } });

      const ok = await vrExplorationManager.beginManipulationGesture("clipBox", { instanceId: "inst-1" });

      expect(ok).toBe(false);
      expect(handler.applySharedState).toHaveBeenCalledWith(
        { polydata: { fake: true } },
        { visualization: { clipBox: { enabled: true } } },
        "__rollback__"
      );
      // Refusal is reported, not silent — see VRExplorationManager's
      // manipulation-gate design.
      expect(vrExplorationManager.getVRNotice()).toMatch(/Clip/);
      expect(vrExplorationManager.getVRNotice()).toMatch(/Alice/);
      // Bookkeeping cleared — a stale snapshot/opId must not leak into
      // whatever gesture starts next.
      expect(vrExplorationManager._gestureSnapshot).toBeNull();
      expect(vrExplorationManager._gestureOpId).toBeNull();
    });

    it("endManipulationGesture(kind, {committed:false}) rolls back an explicitly aborted gesture", async () => {
      vrExplorationManager._manipulationLock = { canManipulate: () => true, heartbeat: vi.fn() };
      mockAggregate.mockReturnValue({ threshold: { min: 0, max: 1 } });

      await vrExplorationManager.beginManipulationGesture("threshold", { instanceId: "inst-1" });
      expect(handler.applySharedState).not.toHaveBeenCalled();

      vrExplorationManager.endManipulationGesture("threshold", { committed: false });

      expect(handler.applySharedState).toHaveBeenCalledWith(
        { polydata: { fake: true } },
        { visualization: { threshold: { min: 0, max: 1 } } },
        "__rollback__"
      );
      expect(vrExplorationManager._gestureSnapshot).toBeNull();
    });

    it("endManipulationGesture on a committed gesture never rolls back", async () => {
      vrExplorationManager._manipulationLock = { canManipulate: () => true, heartbeat: vi.fn() };

      await vrExplorationManager.beginManipulationGesture("transform", { instanceId: "inst-1" });
      vrExplorationManager.endManipulationGesture("transform");

      expect(handler.applySharedState).not.toHaveBeenCalled();
      expect(vrExplorationManager._gestureSnapshot).toBeNull();
      expect(vrExplorationManager._gestureOpId).toBeNull();
    });

    it("endManipulationGesture no-ops for a kind that doesn't match the open gesture", async () => {
      vrExplorationManager._manipulationLock = { canManipulate: () => true, heartbeat: vi.fn() };
      await vrExplorationManager.beginManipulationGesture("transform", { instanceId: "inst-1" });

      vrExplorationManager.endManipulationGesture("clipBox", { committed: false });

      // The 'transform' gesture is untouched — no rollback, bookkeeping intact.
      expect(handler.applySharedState).not.toHaveBeenCalled();
      expect(vrExplorationManager._gestureSnapshot).toMatchObject({ kind: "transform" });
    });
  });

  describe("_deferHeavy ordering (setRepresentation / cycleRepresentation)", () => {
    it("captures the snapshot before _deferHeavy schedules, not inside the deferred callback", () => {
      vrExplorationManager._manipulationLock = { canManipulate: () => true, heartbeat: vi.fn() };

      let sawMutationAlreadyApplied = null;
      mockAggregate.mockImplementation(() => {
        sawMutationAlreadyApplied = instanceTools.setRepresentation.mock.calls.length > 0;
        return { representation: "surface" };
      });

      const result = vrExplorationManager.setRepresentation("wireframe");

      expect(result).toBe("wireframe");
      // The snapshot read already happened (synchronously, before _deferHeavy
      // scheduled anything) — proven by the mutation NOT having run yet.
      expect(mockAggregate).toHaveBeenCalledTimes(1);
      expect(sawMutationAlreadyApplied).toBe(false);
      expect(instanceTools.setRepresentation).not.toHaveBeenCalled();

      vrExplorationManager._drainDeferredWork();

      expect(instanceTools.setRepresentation).toHaveBeenCalledWith("inst-1", "wireframe");
      expect(mockPush).toHaveBeenCalledWith(
        "view-1",
        { representation: "wireframe" },
        "view-1",
        expect.objectContaining({ actorId: "user-1" })
      );
      // Gesture closed cleanly on commit.
      expect(vrExplorationManager._gestureSnapshot).toBeNull();
    });

    it("a refused setRepresentation never enqueues the deferred mutation at all", () => {
      vrExplorationManager._manipulationLock = {
        canManipulate: () => false,
        heartbeat: vi.fn(),
        getHolder: () => ({ holderUserId: "host-1", holderUserName: "Alice" }),
      };

      const result = vrExplorationManager.setRepresentation("wireframe");

      expect(result).toBeNull();
      expect(vrExplorationManager._deferredWork).toHaveLength(0);
      expect(instanceTools.setRepresentation).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("toggleThresholdFilter rolls back cleanly when the local feature mutation itself throws", () => {
      vrExplorationManager._manipulationLock = { canManipulate: () => true, heartbeat: vi.fn() };
      vtkThresholdFeature.getState.mockReturnValue({ availableArrays: ["temperature"] });
      vtkThresholdFeature.toggleThreshold.mockImplementation(() => {
        throw new Error("vtk exploded");
      });

      vrExplorationManager.toggleThresholdFilter();
      vrExplorationManager._drainDeferredWork();

      // The gesture is torn down (committed:false path) rather than left
      // open forever after the deferred task's own try/catch swallows the
      // throw.
      expect(vrExplorationManager._gestureSnapshot).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe("_pushObjectTransformPatch (grab) — begin on first non-final frame only", () => {
    it("does not re-acquire on every per-frame push, and ends exactly once on release", async () => {
      vrExplorationManager._manipulationLock = { canManipulate: () => true, heartbeat: vi.fn() };
      let beginCount = 0;
      mockAggregate.mockImplementation(() => {
        beginCount += 1;
        return { transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } };
      });

      // Non-final drag frames — throttle is 50ms, so advance the clock-free
      // path by resetting _lastObjTransformSentAt between calls.
      vrExplorationManager._pushObjectTransformPatch(false);
      vrExplorationManager._lastObjTransformSentAt = 0;
      vrExplorationManager._pushObjectTransformPatch(false);
      vrExplorationManager._lastObjTransformSentAt = 0;
      vrExplorationManager._pushObjectTransformPatch(false);

      // Only the FIRST non-final frame began a gesture.
      expect(beginCount).toBe(1);
      expect(vrExplorationManager._transformGestureActive).toBe(true);

      const opIdDuringGesture = vrExplorationManager._gestureOpId;
      expect(opIdDuringGesture).toEqual(expect.any(String));

      // Every push during the gesture carries the SAME opId (dedupe).
      for (const call of mockPush.mock.calls) {
        expect(call[3]).toMatchObject({ opId: opIdDuringGesture });
      }

      // Release.
      vrExplorationManager._pushObjectTransformPatch(true);

      expect(vrExplorationManager._transformGestureActive).toBe(false);
      expect(vrExplorationManager._gestureSnapshot).toBeNull();
      expect(vrExplorationManager._gestureOpId).toBeNull();
    });
  });
});
