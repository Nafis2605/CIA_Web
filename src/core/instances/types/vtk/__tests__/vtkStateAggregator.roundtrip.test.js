// src/core/instances/types/vtk/__tests__/vtkStateAggregator.roundtrip.test.js
//
// Covers vtkStateAggregator.js: the read side that closes the gap between
// VTKInstanceHandler.applySharedState() (can apply a rich visualization state) and
// _getCurrentVTKState() (previously only produced camera + opacity/representation +
// reduction). We spy on the real singletons the aggregator imports — instanceTools and
// the four getConfigForSync()-based features plus vtkScalarColoringFeature — rather than
// re-testing each feature's own internal computation (covered by their own
// `*.sync.test.js` files and VTKInstanceHandler.applySharedState.test.js).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  aggregateVTKVisualizationState,
  VTK_STATE_SOURCES,
} from "../vtkStateAggregator.js";
import { instanceTools } from "../vtkInstanceTools.js";
import { vtkScalarColoringFeature } from "../features/VTKScalarColoringFeature.js";
import { vtkGlyphFeature } from "../features/VTKGlyphFeature.js";
import { vtkThresholdFeature } from "../features/VTKThresholdFeature.js";
import { vtkSliceFeature } from "../features/VTKSliceFeature.js";
import { vtkClippingFeature, normalizeClippingConfig } from "../features/VTKClippingFeature.js";
import { VTKInstanceHandler } from "../VTKInstanceHandler.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VTK_STATE_SOURCES — declarative table completeness", () => {
  it("declares exactly the keys applySharedState() knows how to consume beyond opacity/representation/reduction", () => {
    const keys = VTK_STATE_SOURCES.map((s) => s.key).sort();
    expect(keys).toEqual(
      [
        "activeArray",
        "activeArrayType",
        "clipBox",
        "colormap",
        "glyph",
        "lineWidth",
        "pointSize",
        "slice",
        "slicePlane",
        "threshold",
        "transform",
        "windowLevel",
      ].sort()
    );
  });

  it("only marks activeArray as allowNull — the sole key where applySharedState treats null as meaningful", () => {
    const nullable = VTK_STATE_SOURCES.filter((s) => s.allowNull).map((s) => s.key);
    expect(nullable).toEqual(["activeArray"]);
  });
});

describe("aggregateVTKVisualizationState — per-key round trip", () => {
  const instanceId = "inst-agg";

  it("pointSize round-trips through instanceTools.getPointSize", () => {
    vi.spyOn(instanceTools, "getPointSize").mockReturnValue(8);
    const state = aggregateVTKVisualizationState(instanceId, {});
    expect(state.pointSize).toBe(8);
  });

  it("lineWidth round-trips through instanceTools.getLineWidth", () => {
    vi.spyOn(instanceTools, "getLineWidth").mockReturnValue(3);
    const state = aggregateVTKVisualizationState(instanceId, {});
    expect(state.lineWidth).toBe(3);
  });

  it("transform round-trips position/rotation/scale together, in the shape applySharedState expects", () => {
    vi.spyOn(instanceTools, "getPosition").mockReturnValue([1, 2, 3]);
    vi.spyOn(instanceTools, "getRotation").mockReturnValue([0, 90, 0]);
    vi.spyOn(instanceTools, "getScale").mockReturnValue([1.5, 1.5, 1.5]);

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.transform).toEqual({
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale: [1.5, 1.5, 1.5],
    });
  });

  it("slice (legacy orientation/position) round-trips through instanceTools", () => {
    vi.spyOn(instanceTools, "getSliceOrientation").mockReturnValue("sagittal");
    vi.spyOn(instanceTools, "getSlicePosition").mockReturnValue(42);

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.slice).toEqual({ orientation: "sagittal", position: 42 });
  });

  it("windowLevel round-trips through instanceTools.getWindowLevel", () => {
    vi.spyOn(instanceTools, "getWindowLevel").mockReturnValue({ window: 400, level: 40 });
    const state = aggregateVTKVisualizationState(instanceId, {});
    expect(state.windowLevel).toEqual({ window: 400, level: 40 });
  });

  it("colormap and activeArray/activeArrayType round-trip through vtkScalarColoringFeature.getState", () => {
    vi.spyOn(vtkScalarColoringFeature, "getState").mockReturnValue({
      enabled: true,
      colormap: "plasma",
      activeArray: "pressure",
      activeArrayType: "cell",
    });

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.colormap).toBe("plasma");
    expect(state.activeArray).toBe("pressure");
    expect(state.activeArrayType).toBe("cell");
  });

  it("activeArray sends an explicit null when scalar coloring is disabled, instead of omitting the key", () => {
    // Mirrors VTKScalarColoringFeature.disableScalarColoring(), which resets
    // state.activeArray back to null (VTKScalarColoringFeature.js:323-324).
    // applySharedState() reads `activeArray === null` as "turn scalar coloring off"
    // (VTKInstanceHandler.js:4419) — an omitted key would silently fail to propagate
    // a peer's decision to disable coloring.
    vi.spyOn(vtkScalarColoringFeature, "getState").mockReturnValue({
      enabled: false,
      colormap: "viridis",
      activeArray: null,
      activeArrayType: "point",
    });

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect("activeArray" in state).toBe(true);
    expect(state.activeArray).toBeNull();
  });

  it("omits colormap/activeArrayType but still sends an explicit activeArray:null when scalar coloring was never initialized for this instance", () => {
    // getState() returns null here (feature never initialized for this instanceId), so
    // colormap/activeArrayType have nothing to read and are correctly omitted (`?.`
    // yields undefined). activeArray uses `?? null` specifically so this case still
    // reports "no active array" rather than silently omitting it — "never touched
    // scalar coloring" and "explicitly disabled" are the same fact from a remote
    // peer's point of view (no array is currently colored), so both must produce the
    // same null-disables-coloring signal applySharedState acts on.
    vi.spyOn(vtkScalarColoringFeature, "getState").mockReturnValue(null);

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect("colormap" in state).toBe(false);
    expect("activeArrayType" in state).toBe(false);
    expect("activeArray" in state).toBe(true);
    expect(state.activeArray).toBeNull();
  });

  it("glyph round-trips through vtkGlyphFeature.getConfigForSync exactly, unmodified", () => {
    const config = {
      enabled: true,
      glyphType: "arrow",
      scaleFactor: 1.2,
      scalingMode: "uniform",
      orientationArray: "velocity",
      scaleArray: null,
      colorArray: null,
      colorMode: "solid",
      solidColor: [1, 0, 0],
      density: 0.5,
    };
    vi.spyOn(vtkGlyphFeature, "getConfigForSync").mockReturnValue(config);

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.glyph).toBe(config);
  });

  it("threshold round-trips through vtkThresholdFeature.getConfigForSync exactly, unmodified", () => {
    const config = { enabled: true, mode: "between", minValue: 0.2, maxValue: 0.8, selectedArray: "pressure" };
    vi.spyOn(vtkThresholdFeature, "getConfigForSync").mockReturnValue(config);

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.threshold).toBe(config);
  });

  it("slicePlane round-trips through vtkSliceFeature.getConfigForSync exactly, unmodified, and is distinct from the legacy `slice` key", () => {
    const config = { enabled: true, sliceMode: 2, sliceIndex: 10, windowWidth: 400, windowLevel: 200, interpolate: true };
    vi.spyOn(vtkSliceFeature, "getConfigForSync").mockReturnValue(config);
    vi.spyOn(instanceTools, "getSliceOrientation").mockReturnValue("axial");
    vi.spyOn(instanceTools, "getSlicePosition").mockReturnValue(50);

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.slicePlane).toBe(config);
    expect(state.slice).toEqual({ orientation: "axial", position: 50 });
    expect(state.slicePlane).not.toBe(state.slice);
  });

  it("clipBox round-trips through vtkClippingFeature.getConfigForSync exactly, unmodified", () => {
    const config = normalizeClippingConfig({
      enabled: true,
      inverted: true,
      planePreset: "z",
      plane: { origin: [1, 1, 1], normal: [0, 0, 1] },
    });
    vi.spyOn(vtkClippingFeature, "getConfigForSync").mockReturnValue(config);

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.clipBox).toBe(config);
  });

  it("clipBox produced by aggregateVTKVisualizationState is genuinely consumable by the real applyRemoteConfig", () => {
    // A deeper round trip than the mock-equality checks above: drive the feature's
    // *real* enableClipping/setPlanePreset/invertClipping through a manual clip plane,
    // read it back via the aggregator, and feed that straight back into the real
    // applyRemoteConfig — confirming the aggregate is literally what the consumer wants,
    // not just what we told the mock to return.
    const id = "inst-clip-roundtrip";
    vtkClippingFeature.instanceStates.set(id, {
      enabled: false,
      widgetVisible: true,
      inverted: false,
      planePreset: "x",
      sceneObjects: {
        mapper: {
          getInputData: () => null,
          removeAllClippingPlanes: vi.fn(),
          addClippingPlane: vi.fn(),
        },
        renderWindow: { render: vi.fn() },
      },
      widgetManager: null,
      bounds: null,
      center: [0, 0, 0],
      manualClipPlane: null,
    });

    try {
      vtkClippingFeature.enableClipping(id, { manual: true });
      vtkClippingFeature.invertClipping(id);

      const aggregated = aggregateVTKVisualizationState(id, {});
      expect(aggregated.clipBox.enabled).toBe(true);
      expect(aggregated.clipBox.inverted).toBe(true);

      // Feed the aggregate back through the real consumer — must not throw, and must
      // leave the feature in a state matching what was aggregated (idempotent apply).
      expect(() => vtkClippingFeature.applyRemoteConfig(id, aggregated.clipBox)).not.toThrow();
      expect(vtkClippingFeature.getConfigForSync(id)).toEqual(aggregated.clipBox);
    } finally {
      vtkClippingFeature.instanceStates.delete(id);
    }
  });
});

describe("aggregateVTKVisualizationState — resilience to a throwing source", () => {
  const instanceId = "inst-throw";

  it("a throwing feature read does not abort the aggregate or lose the other keys", () => {
    vi.spyOn(instanceTools, "getPointSize").mockReturnValue(8);
    vi.spyOn(instanceTools, "getLineWidth").mockReturnValue(3);
    vi.spyOn(vtkGlyphFeature, "getConfigForSync").mockImplementation(() => {
      throw new Error("boom");
    });
    vi.spyOn(vtkThresholdFeature, "getConfigForSync").mockReturnValue({ enabled: false });

    const state = aggregateVTKVisualizationState(instanceId, {});

    expect(state.pointSize).toBe(8);
    expect(state.lineWidth).toBe(3);
    expect(state.threshold).toEqual({ enabled: false });
    expect("glyph" in state).toBe(false);
  });

  it("every source throwing still returns an object rather than throwing itself", () => {
    // Force every real source to throw by breaking their underlying dependencies.
    vi.spyOn(instanceTools, "getPointSize").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(instanceTools, "getLineWidth").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(instanceTools, "getPosition").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(instanceTools, "getSliceOrientation").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(instanceTools, "getWindowLevel").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(vtkScalarColoringFeature, "getState").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(vtkGlyphFeature, "getConfigForSync").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(vtkThresholdFeature, "getConfigForSync").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(vtkSliceFeature, "getConfigForSync").mockImplementation(() => { throw new Error("x"); });
    vi.spyOn(vtkClippingFeature, "getConfigForSync").mockImplementation(() => { throw new Error("x"); });

    expect(() => aggregateVTKVisualizationState(instanceId, {})).not.toThrow();
    expect(aggregateVTKVisualizationState(instanceId, {})).toEqual({});
  });
});

describe("VTKInstanceHandler._getCurrentVTKState — now includes the previously-dropped filter keys", () => {
  let handler;

  beforeEach(() => {
    handler = new VTKInstanceHandler();
  });

  function makeInstanceData(instanceId = "inst-full") {
    return {
      instanceId,
      sceneObjects: {
        camera: {
          getPosition: () => [0, 0, 10],
          getFocalPoint: () => [0, 0, 0],
          getViewUp: () => [0, 1, 0],
          getParallelScale: () => 1,
          getClippingRange: () => [0.1, 100],
          getViewAngle: () => 30,
        },
        actor: {
          getProperty: () => ({
            getOpacity: () => 1,
            getRepresentation: () => 2,
          }),
        },
      },
    };
  }

  it("still reports camera, opacity, representation, and reduction exactly as before", () => {
    const instanceData = makeInstanceData();
    vi.spyOn(handler.reductionFeature, "getState").mockReturnValue(null);

    const state = handler._getCurrentVTKState(instanceData);

    expect(state.camera).toEqual({
      position: [0, 0, 10],
      focalPoint: [0, 0, 0],
      viewUp: [0, 1, 0],
      parallelScale: 1,
      clippingRange: [0.1, 100],
      viewAngle: 30,
    });
    expect(state.visualization.opacity).toBe(1);
    expect(state.visualization.representation).toBe(2);
    expect(state.reduction).toBeUndefined();
  });

  it("now also includes filter keys _getCurrentVTKState previously dropped entirely", () => {
    const instanceData = makeInstanceData();
    vi.spyOn(handler.reductionFeature, "getState").mockReturnValue(null);
    vi.spyOn(instanceTools, "getPointSize").mockReturnValue(6);
    vi.spyOn(instanceTools, "getLineWidth").mockReturnValue(4);
    vi.spyOn(vtkThresholdFeature, "getConfigForSync").mockReturnValue({
      enabled: true,
      mode: "between",
      minValue: 0.1,
      maxValue: 0.9,
      selectedArray: "pressure",
    });
    vi.spyOn(vtkClippingFeature, "getConfigForSync").mockReturnValue(
      normalizeClippingConfig({ enabled: true, inverted: false, planePreset: "y", plane: null })
    );

    const state = handler._getCurrentVTKState(instanceData);

    expect(state.visualization.pointSize).toBe(6);
    expect(state.visualization.lineWidth).toBe(4);
    expect(state.visualization.threshold).toEqual({
      enabled: true,
      mode: "between",
      minValue: 0.1,
      maxValue: 0.9,
      selectedArray: "pressure",
    });
    expect(state.visualization.clipBox).toEqual({
      enabled: true,
      inverted: false,
      planePreset: "y",
      plane: null,
    });
    // opacity/representation from the pre-existing code path are still present alongside
    // the newly-aggregated keys.
    expect(state.visualization.opacity).toBe(1);
    expect(state.visualization.representation).toBe(2);
  });

  it("returns {} when instanceData has no sceneObjects (unchanged guard behavior)", () => {
    expect(handler._getCurrentVTKState({})).toEqual({});
  });
});
