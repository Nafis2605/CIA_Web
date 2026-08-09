// src/core/instances/__tests__/workspaceManager.viewSync.test.js
// End-to-end routing of an inbound Y.js visualization/camera update onto local
// instances — the receiving half of the cross-client sync fix.
//
// THE DEFECT: two headsets on the same dataset each mint their own
// ViewConfiguration, so the sender's viewId matches no local instance. The old
// `instance.viewConfigId !== viewId` guard therefore skipped every instance and
// the patch was dropped without a single log line.

import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() });
  return {
    instance: mkLog(),
    logInfo: vi.fn(),
    logSuccess: vi.fn(),
    logError: vi.fn(),
    createLogger: () => mkLog(),
  };
});

vi.mock("@Utils/idGenerator.js", () => ({
  generateInstanceId: vi.fn(() => "inst-generated"),
}));

vi.mock("@Core/instances/types/instanceTypesInit.js", () => ({
  getHandlerForType: vi.fn(() => null),
}));

vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: vi.fn(() => "user-1"),
}));

// Camera sharing on by default; a test flips it to prove the personal-camera
// gate still short-circuits before any of the new matching runs.
const mockIsCameraShared = vi.fn(() => true);
vi.mock("@Core/session/cameraSharePolicy.js", () => ({
  default: {
    isCameraShared: (...a) => mockIsCameraShared(...a),
    getFollowOverride: vi.fn(() => false),
  },
}));

vi.mock("@Init/appInitializer.js", () => ({
  getDatasetManager: vi.fn(() => null),
  getViewConfigurationManager: vi.fn(() => null),
}));

vi.mock("@Collaboration/yjs/yjsObservers.js", () => ({
  onCameraChange: vi.fn(),
  onVisualizationChange: vi.fn(),
  onManipulatorChange: vi.fn(),
  onActiveDatasetChange: vi.fn(),
}));

import { workspaceManager } from "../workspaceManager.js";
import { instance as log } from "@Utils/logger.js";

/**
 * Register a local instance directly, bypassing createInstance's DOM work.
 * @returns {{ applySharedState: import('vitest').Mock }} the instance's handler
 */
function addInstance({ instanceId, viewConfigId, datasetId }) {
  const applySharedState = vi.fn();
  workspaceManager.instances.set(instanceId, {
    instanceId,
    viewConfigId,
    datasetId,
    handler: { applySharedState },
    instanceData: { instanceId, viewConfigId, datasetId, dataset: { id: datasetId } },
  });
  return { applySharedState };
}

describe("workspaceManager — inbound view update routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceManager.instances.clear();
    // The unroutable-update warning is time-throttled and the manager is a
    // singleton, so its dedupe map has to be cleared between tests.
    workspaceManager._unroutableWarnedAt.clear();
    mockIsCameraShared.mockReturnValue(true);
  });

  describe("visualization", () => {
    test("applies a peer's patch when the dataset matches but the view id does not", () => {
      // Headset B, viewing dataset-1 through its OWN ViewConfiguration.
      const { applySharedState } = addInstance({
        instanceId: "inst-b",
        viewConfigId: "view-b",
        datasetId: "dataset-1",
      });

      // Headset A published under view-a with the shared dataset key.
      workspaceManager._handleYjsVisualizationUpdate(
        "view-a",
        { representation: "wireframe" },
        "user-a",
        "dataset-1"
      );

      expect(applySharedState).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: "inst-b" }),
        { visualization: { representation: "wireframe" } },
        "user-a"
      );
    });

    test("ignores a patch for a different dataset", () => {
      const { applySharedState } = addInstance({
        instanceId: "inst-b",
        viewConfigId: "view-b",
        datasetId: "dataset-1",
      });

      workspaceManager._handleYjsVisualizationUpdate(
        "view-a",
        { representation: "wireframe" },
        "user-a",
        "dataset-2"
      );

      expect(applySharedState).not.toHaveBeenCalled();
    });

    // REGRESSION: the desktop path that already worked — clients sharing one
    // saved ViewConfiguration — must be untouched.
    test("still applies on an identical viewConfigId", () => {
      const { applySharedState } = addInstance({
        instanceId: "inst-b",
        viewConfigId: "view-shared",
        datasetId: "dataset-1",
      });

      workspaceManager._handleYjsVisualizationUpdate(
        "view-shared",
        { opacity: 0.5 },
        "user-a",
        "dataset-1"
      );

      expect(applySharedState).toHaveBeenCalledTimes(1);
    });

    // An older peer that predates the syncKey still reaches instances that
    // share its view id, rather than being dropped entirely.
    test("falls back to viewConfigId matching when the sender sent no syncKey", () => {
      const { applySharedState } = addInstance({
        instanceId: "inst-b",
        viewConfigId: "view-shared",
        datasetId: "dataset-1",
      });

      workspaceManager._handleYjsVisualizationUpdate("view-shared", { opacity: 0.5 }, "user-a");

      expect(applySharedState).toHaveBeenCalledTimes(1);
    });

    test("fans out to every local instance showing the dataset", () => {
      const a = addInstance({ instanceId: "inst-1", viewConfigId: "view-1", datasetId: "dataset-1" });
      const b = addInstance({ instanceId: "inst-2", viewConfigId: "view-2", datasetId: "dataset-1" });
      const other = addInstance({ instanceId: "inst-3", viewConfigId: "view-3", datasetId: "dataset-9" });

      workspaceManager._handleYjsVisualizationUpdate(
        "view-remote",
        { colormap: "viridis" },
        "user-a",
        "dataset-1"
      );

      expect(a.applySharedState).toHaveBeenCalledTimes(1);
      expect(b.applySharedState).toHaveBeenCalledTimes(1);
      expect(other.applySharedState).not.toHaveBeenCalled();
    });
  });

  describe("unroutable updates", () => {
    // The silent-drop path. Before this warning there was no way at all to
    // distinguish "the peer never sent anything" from "it arrived and matched
    // nothing" — the loop just completed with zero iterations.
    test("warns when an update matches no local instance", () => {
      addInstance({ instanceId: "inst-b", viewConfigId: "view-b", datasetId: "dataset-1" });

      workspaceManager._handleYjsVisualizationUpdate(
        "view-a",
        { opacity: 0.5 },
        "user-a",
        "dataset-OTHER"
      );

      expect(log.warn).toHaveBeenCalledTimes(1);
      const message = log.warn.mock.calls[0][0];
      expect(message).toContain("dataset-OTHER"); // what arrived
      expect(message).toContain("dataset-1"); // what we have locally
    });

    test("does not warn when the update was applied", () => {
      addInstance({ instanceId: "inst-b", viewConfigId: "view-b", datasetId: "dataset-1" });

      workspaceManager._handleYjsVisualizationUpdate(
        "view-a",
        { opacity: 0.5 },
        "user-a",
        "dataset-1"
      );

      expect(log.warn).not.toHaveBeenCalled();
    });

    // This channel runs at slider rate; an unthrottled warn emits ~20/sec and
    // buries the signal it exists to provide.
    test("throttles repeats of the same mismatch", () => {
      addInstance({ instanceId: "inst-b", viewConfigId: "view-b", datasetId: "dataset-1" });

      for (let i = 0; i < 50; i++) {
        workspaceManager._handleYjsVisualizationUpdate(
          "view-a",
          { opacity: i / 50 },
          "user-a",
          "dataset-OTHER"
        );
      }

      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    test("reports a different mismatch even while one is throttled", () => {
      addInstance({ instanceId: "inst-b", viewConfigId: "view-b", datasetId: "dataset-1" });

      workspaceManager._handleYjsVisualizationUpdate("view-a", {}, "user-a", "dataset-X");
      workspaceManager._handleYjsVisualizationUpdate("view-a", {}, "user-a", "dataset-Y");

      expect(log.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe("camera", () => {
    test("applies a peer's camera when the dataset matches but the view id does not", () => {
      const { applySharedState } = addInstance({
        instanceId: "inst-b",
        viewConfigId: "view-b",
        datasetId: "dataset-1",
      });

      workspaceManager._handleYjsCameraUpdate(
        "view-a",
        { position: [0, 0, 5] },
        "user-a",
        "dataset-1"
      );

      expect(applySharedState).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: "inst-b" }),
        { camera: { position: [0, 0, 5] } },
        "user-a"
      );
    });

    test("personal-camera mode still suppresses remote cameras entirely", () => {
      mockIsCameraShared.mockReturnValue(false);
      const { applySharedState } = addInstance({
        instanceId: "inst-b",
        viewConfigId: "view-b",
        datasetId: "dataset-1",
      });

      workspaceManager._handleYjsCameraUpdate(
        "view-a",
        { position: [0, 0, 5] },
        "user-a",
        "dataset-1"
      );

      expect(applySharedState).not.toHaveBeenCalled();
    });
  });
});
