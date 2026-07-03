// src/core/instances/types/vtk/__tests__/VTKInstanceHandler.applySharedState.test.js
//
// Verifies the new applySharedState() branches added to close the "panel
// controls never propagate to other viewers" bug: pointSize, lineWidth,
// transform, slice, windowLevel, and widget-toggle diffing. These delegate
// to the real `instanceTools` singleton, so we spy on its methods rather
// than re-testing vtkInstanceTools' own VTK plumbing (covered elsewhere).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VTKInstanceHandler } from "../VTKInstanceHandler.js";
import { instanceTools } from "../vtkInstanceTools.js";

function makeInstanceData(instanceId = "inst-1") {
  return {
    instanceId,
    sceneObjects: {
      actor: {
        getProperty: () => ({
          setOpacity: vi.fn(),
          setRepresentation: vi.fn(),
        }),
      },
      camera: {},
      renderer: { resetCameraClippingRange: vi.fn() },
    },
  };
}

describe("VTKInstanceHandler.applySharedState — new visualization branches", () => {
  let handler;
  let instanceData;

  beforeEach(() => {
    handler = new VTKInstanceHandler();
    instanceData = makeInstanceData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies pointSize and lineWidth via instanceTools", async () => {
    const setPointSize = vi.spyOn(instanceTools, "setPointSize").mockImplementation(() => {});
    const setLineWidth = vi.spyOn(instanceTools, "setLineWidth").mockImplementation(() => {});

    await handler.applySharedState(instanceData, { visualization: { pointSize: 8, lineWidth: 3 } }, "remote-user");

    expect(setPointSize).toHaveBeenCalledWith("inst-1", 8);
    expect(setLineWidth).toHaveBeenCalledWith("inst-1", 3);
  });

  it("applies a full transform triple via instanceTools", async () => {
    const setPosition = vi.spyOn(instanceTools, "setPosition").mockImplementation(() => {});
    const setRotation = vi.spyOn(instanceTools, "setRotation").mockImplementation(() => {});
    const setScale = vi.spyOn(instanceTools, "setScale").mockImplementation(() => {});

    await handler.applySharedState(
      instanceData,
      { visualization: { transform: { position: [1, 2, 3], rotation: [0, 90, 0], scale: [1.5, 1.5, 1.5] } } },
      "remote-user"
    );

    expect(setPosition).toHaveBeenCalledWith("inst-1", 1, 2, 3);
    expect(setRotation).toHaveBeenCalledWith("inst-1", 0, 90, 0);
    expect(setScale).toHaveBeenCalledWith("inst-1", 1.5, 1.5, 1.5);
  });

  it("applies only the transform sub-fields that are present", async () => {
    const setPosition = vi.spyOn(instanceTools, "setPosition").mockImplementation(() => {});
    const setRotation = vi.spyOn(instanceTools, "setRotation").mockImplementation(() => {});

    await handler.applySharedState(
      instanceData,
      { visualization: { transform: { position: [5, 5, 5] } } },
      "remote-user"
    );

    expect(setPosition).toHaveBeenCalledWith("inst-1", 5, 5, 5);
    expect(setRotation).not.toHaveBeenCalled();
  });

  it("applies slice orientation/position via instanceTools", async () => {
    const setSliceOrientation = vi.spyOn(instanceTools, "setSliceOrientation").mockImplementation(() => {});
    const setSlicePosition = vi.spyOn(instanceTools, "setSlicePosition").mockImplementation(() => {});

    await handler.applySharedState(
      instanceData,
      { visualization: { slice: { orientation: "sagittal", position: 42 } } },
      "remote-user"
    );

    expect(setSliceOrientation).toHaveBeenCalledWith("inst-1", "sagittal");
    expect(setSlicePosition).toHaveBeenCalledWith("inst-1", 42);
  });

  it("applies window/level via instanceTools", async () => {
    const setWindowLevel = vi.spyOn(instanceTools, "setWindowLevel").mockImplementation(() => {});

    await handler.applySharedState(
      instanceData,
      { visualization: { windowLevel: { window: 400, level: 40 } } },
      "remote-user"
    );

    expect(setWindowLevel).toHaveBeenCalledWith("inst-1", 400, 40);
  });

  it("sets _isApplyingRemoteState during application and clears it after", async () => {
    let sawFlagSet = false;
    vi.spyOn(instanceTools, "setPointSize").mockImplementation(() => {
      sawFlagSet = handler._isApplyingRemoteState === true;
    });

    await handler.applySharedState(instanceData, { visualization: { pointSize: 4 } }, "remote-user");

    expect(sawFlagSet).toBe(true);
    expect(handler._isApplyingRemoteState).toBe(false);
  });

  describe("widget toggle diffing", () => {
    it("toggles a widget on when remote state says active but local state is off", async () => {
      vi.spyOn(instanceTools, "isWidgetActive").mockReturnValue(false);
      const toggleRuler = vi.spyOn(instanceTools, "toggleRulerMeasurement").mockImplementation(() => {});

      await handler.applySharedState(
        instanceData,
        { widgets: [{ type: "line", active: true }] },
        "remote-user"
      );

      expect(toggleRuler).toHaveBeenCalledWith("inst-1");
    });

    it("does not re-toggle a widget that already matches the remote state", async () => {
      vi.spyOn(instanceTools, "isWidgetActive").mockReturnValue(true);
      const toggleRuler = vi.spyOn(instanceTools, "toggleRulerMeasurement").mockImplementation(() => {});

      await handler.applySharedState(
        instanceData,
        { widgets: [{ type: "line", active: true }] },
        "remote-user"
      );

      expect(toggleRuler).not.toHaveBeenCalled();
    });
  });
});
