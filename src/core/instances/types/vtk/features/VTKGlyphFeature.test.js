import { describe, it, expect, beforeEach, vi } from "vitest";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import {
  VTKGlyphFeature,
  normalizeGlyphConfig,
  isVectorOrientationAvailable,
  isGlyphFeatureAvailable,
  getDisabledGlyphTypes,
} from "./VTKGlyphFeature.js";

function makeSyntheticPolydata(n = 10, { withVector = true, withScalar = true } = {}) {
  const xyz = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    xyz[i * 3] = i;
    xyz[i * 3 + 1] = 0;
    xyz[i * 3 + 2] = 0;
  }
  const points = vtkPoints.newInstance();
  points.setData(xyz, 3);

  const pd = vtkPolyData.newInstance();
  pd.setPoints(points);

  if (withVector) {
    const vecData = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      vecData[i * 3] = 1;
      vecData[i * 3 + 1] = 0;
      vecData[i * 3 + 2] = 0;
    }
    pd.getPointData().addArray(
      vtkDataArray.newInstance({ name: "velocity", numberOfComponents: 3, values: vecData })
    );
  }

  if (withScalar) {
    const scalarData = new Float32Array(n);
    for (let i = 0; i < n; i++) scalarData[i] = i;
    pd.getPointData().addArray(
      vtkDataArray.newInstance({ name: "temperature", numberOfComponents: 1, values: scalarData })
    );
  }

  return pd;
}

function makeMockSceneObjects() {
  const actors = [];
  let visibility = true;
  let pointSize = 1;
  const property = {
    getPointSize: () => pointSize,
    setPointSize: vi.fn((v) => { pointSize = v; }),
  };
  return {
    renderer: {
      addActor: vi.fn((a) => actors.push(a)),
      removeActor: vi.fn((a) => {
        const i = actors.indexOf(a);
        if (i >= 0) actors.splice(i, 1);
      }),
      _actors: actors,
    },
    renderWindow: { render: vi.fn() },
    actor: {
      getVisibility: vi.fn(() => visibility),
      setVisibility: vi.fn((v) => { visibility = v; }),
      getProperty: () => property,
    },
  };
}

describe("normalizeGlyphConfig", () => {
  it("returns safe defaults for an empty/missing config", () => {
    expect(normalizeGlyphConfig({})).toEqual({
      enabled: false,
      glyphType: "arrow",
      scaleFactor: 1.0,
      scalingMode: "magnitude",
      orientationArray: null,
      scaleArray: null,
      colorArray: null,
      colorMode: "solid",
      solidColor: [0.2, 0.4, 0.9],
      density: 1.0,
    });
  });

  it("does not crash on undefined/null input", () => {
    expect(() => normalizeGlyphConfig(undefined)).not.toThrow();
    expect(() => normalizeGlyphConfig(null)).not.toThrow();
    expect(normalizeGlyphConfig(null).glyphType).toBe("arrow");
  });

  it("falls back field-by-field on garbage/out-of-range input", () => {
    const result = normalizeGlyphConfig({
      glyphType: "not-a-type",
      scaleFactor: -5,
      density: 99,
      colorMode: "bogus",
    });
    expect(result.glyphType).toBe("arrow");
    expect(result.scaleFactor).toBe(1.0);
    expect(result.density).toBe(1);
    expect(result.colorMode).toBe("solid");
  });
});

describe("glyph validity helpers", () => {
  it("arrow requires a valid vector array", () => {
    const feature = new VTKGlyphFeature();
    const instanceId = "arrow-validity";
    feature.initialize(instanceId, { sceneObjects: makeMockSceneObjects() });

    const pd = makeSyntheticPolydata(10, { withVector: false, withScalar: true });
    feature.scanAvailableArrays(instanceId, pd);
    const state = feature.getState(instanceId);

    expect(isVectorOrientationAvailable(state.vectorArrays)).toBe(false);
    expect(getDisabledGlyphTypes(state.vectorArrays)).toContain("arrow");
  });

  it("dot glyph does not require vector orientation", () => {
    const feature = new VTKGlyphFeature();
    const instanceId = "dot-validity";
    feature.initialize(instanceId, { sceneObjects: makeMockSceneObjects() });

    const pd = makeSyntheticPolydata(10, { withVector: false, withScalar: true });
    feature.scanAvailableArrays(instanceId, pd);
    const state = feature.getState(instanceId);

    expect(getDisabledGlyphTypes(state.vectorArrays)).not.toContain("dot");

    expect(() => feature.enableGlyphs(instanceId, pd, { glyphType: "dot" })).not.toThrow();
    expect(feature.getState(instanceId).enabled).toBe(true);
  });

  it("missing vector and scalar arrays without hasPoints produces an unsupported/degraded state", () => {
    const feature = new VTKGlyphFeature();
    const instanceId = "degraded";
    feature.initialize(instanceId, { sceneObjects: makeMockSceneObjects() });

    const pd = makeSyntheticPolydata(10, { withVector: false, withScalar: false });
    feature.scanAvailableArrays(instanceId, pd);
    const state = feature.getState(instanceId);

    expect(isGlyphFeatureAvailable(state.vectorArrays, state.scalarArrays)).toBe(false);
  });

  it("a point-only dataset (no vector/scalar arrays) is still glyph-eligible via hasPoints", () => {
    // Constant-scale sphere/dot glyphs need no data array at all — a
    // point-only dataset shouldn't be excluded just because it has no
    // vector/scalar point-data.
    const feature = new VTKGlyphFeature();
    const instanceId = "point-only";
    feature.initialize(instanceId, { sceneObjects: makeMockSceneObjects() });

    const pd = makeSyntheticPolydata(10, { withVector: false, withScalar: false });
    feature.scanAvailableArrays(instanceId, pd);
    const state = feature.getState(instanceId);

    expect(isGlyphFeatureAvailable(state.vectorArrays, state.scalarArrays, pd.getNumberOfPoints() > 0)).toBe(true);
  });
});

describe("VTKGlyphFeature actor lifecycle", () => {
  let feature;
  let sceneObjects;
  let instanceId;

  beforeEach(() => {
    feature = new VTKGlyphFeature();
    sceneObjects = makeMockSceneObjects();
    instanceId = "actor-lifecycle";
    feature.initialize(instanceId, { sceneObjects });
  });

  it("enabling glyphs adds exactly one actor and triggers a render", () => {
    const pd = makeSyntheticPolydata(10);
    feature.enableGlyphs(instanceId, pd);

    expect(sceneObjects.renderer.addActor).toHaveBeenCalledTimes(1);
    expect(sceneObjects.renderWindow.render).toHaveBeenCalled();
    expect(feature.getState(instanceId).enabled).toBe(true);
  });

  it("disabling glyphs removes the actor cleanly", () => {
    const pd = makeSyntheticPolydata(10);
    feature.enableGlyphs(instanceId, pd);
    feature.disableGlyphs(instanceId);

    expect(sceneObjects.renderer.removeActor).toHaveBeenCalledTimes(1);
    expect(sceneObjects.renderer._actors.length).toBe(0);
    expect(feature.getState(instanceId).enabled).toBe(false);
  });

  it("does not touch the original non-glyph actor's visibility on enable, and restores it on disable", () => {
    const pd = makeSyntheticPolydata(10);
    feature.enableGlyphs(instanceId, pd);
    expect(sceneObjects.actor.setVisibility).not.toHaveBeenCalled();

    feature.disableGlyphs(instanceId);
    expect(sceneObjects.actor.setVisibility).toHaveBeenCalledWith(true);
  });

  it("restores the main actor's PRE-glyph visibility and point size on disable, not fixed values", () => {
    // Regression test: disableGlyphs used to unconditionally force
    // visibility=true and point size >=5, which could stomp on
    // threshold/isosurface or user styling that had the actor hidden or
    // sized differently on purpose.
    sceneObjects.actor.setVisibility(false);
    sceneObjects.actor.getProperty().setPointSize(9);

    const pd = makeSyntheticPolydata(10);
    feature.enableGlyphs(instanceId, pd);
    // Enabling glyphs must not touch the main actor at all.
    expect(sceneObjects.actor.getVisibility()).toBe(false);
    expect(sceneObjects.actor.getProperty().getPointSize()).toBe(9);

    feature.disableGlyphs(instanceId);
    expect(sceneObjects.actor.getVisibility()).toBe(false);
    expect(sceneObjects.actor.getProperty().getPointSize()).toBe(9);
  });

  it("re-captures pre-glyph state fresh after a full disable/re-enable cycle", () => {
    const pd = makeSyntheticPolydata(10);
    feature.enableGlyphs(instanceId, pd);
    feature.disableGlyphs(instanceId);

    // State changed while glyphs were off — the NEXT enable should treat
    // this as the new baseline, not the stale one from before.
    sceneObjects.actor.setVisibility(false);
    sceneObjects.actor.getProperty().setPointSize(3);

    feature.enableGlyphs(instanceId, pd);
    feature.disableGlyphs(instanceId);

    expect(sceneObjects.actor.getVisibility()).toBe(false);
    expect(sceneObjects.actor.getProperty().getPointSize()).toBe(3);
  });

  it("changing glyph type does not duplicate actors", () => {
    const pd = makeSyntheticPolydata(10);
    feature.enableGlyphs(instanceId, pd);

    feature.setGlyphType(instanceId, "cone");
    feature.setGlyphType(instanceId, "sphere");
    feature.setGlyphType(instanceId, "dot");

    expect(sceneObjects.renderer.addActor).toHaveBeenCalledTimes(1);
    expect(sceneObjects.renderer._actors.length).toBe(1);
  });

  it("repeated enable/disable toggling leaves no leftover actors", () => {
    const pd = makeSyntheticPolydata(10);
    for (let i = 0; i < 3; i++) {
      feature.enableGlyphs(instanceId, pd);
      feature.disableGlyphs(instanceId);
    }
    expect(sceneObjects.renderer._actors.length).toBe(0);
  });
});

describe("VTKGlyphFeature density/subsample", () => {
  it("reduces the point count fed to the glyph mapper", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "density";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(100);
    feature.enableGlyphs(instanceId, pd);

    const state = feature.instanceStates.get(instanceId);
    const before = state.glyphMapper.getInputData(0).getPoints().getNumberOfPoints();
    expect(before).toBe(100);

    feature.setDensity(instanceId, 0.1);
    const after = state.glyphMapper.getInputData(0).getPoints().getNumberOfPoints();

    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(10, 0);
  });

  it("disposes the previous derived polydata instead of leaking it", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "density-leak";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(100);
    feature.enableGlyphs(instanceId, pd);

    const state = feature.instanceStates.get(instanceId);
    feature.setDensity(instanceId, 0.1);
    const firstDerived = state.derivedPolydata;
    expect(firstDerived).not.toBeNull();

    feature.setDensity(instanceId, 0.5);
    expect(state.derivedPolydata).not.toBe(firstDerived);
  });

  it("setSelectedPoint forces a point that stride-subsampling would otherwise drop to survive", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "density-selected";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(100);
    feature.enableGlyphs(instanceId, pd);
    feature.setDensity(instanceId, 0.1);

    const state = feature.instanceStates.get(instanceId);
    const sourceIdsBefore = Array.from(
      state.derivedPolydata.getPointData().getArrayByName("SourcePointId").getData()
    );
    // Find any point index the deterministic stride-10 sample didn't keep —
    // with ~10 of 100 points kept, plenty of candidates exist.
    const sampledSet = new Set(sourceIdsBefore);
    let notSampled = -1;
    for (let i = 0; i < 100; i++) {
      if (!sampledSet.has(i)) { notSampled = i; break; }
    }
    expect(notSampled).toBeGreaterThanOrEqual(0);

    feature.setSelectedPoint(instanceId, notSampled);

    const sourceIdsAfter = Array.from(
      state.derivedPolydata.getPointData().getArrayByName("SourcePointId").getData()
    );
    expect(sourceIdsAfter).toContain(notSampled);
    // Everything previously sampled must still be present — force-include
    // only ever appends, never displaces.
    for (const id of sourceIdsBefore) expect(sourceIdsAfter).toContain(id);
  });

  it("clearSelectedPoint stops forcing a previously-selected point", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "density-clear-selected";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(100);
    feature.enableGlyphs(instanceId, pd);
    feature.setDensity(instanceId, 0.1);

    const state = feature.instanceStates.get(instanceId);
    const sampledSet = new Set(
      state.derivedPolydata.getPointData().getArrayByName("SourcePointId").getData()
    );
    let notSampled = -1;
    for (let i = 0; i < 100; i++) {
      if (!sampledSet.has(i)) { notSampled = i; break; }
    }
    expect(notSampled).toBeGreaterThanOrEqual(0);

    feature.setSelectedPoint(instanceId, notSampled);
    let sourceIds = Array.from(
      state.derivedPolydata.getPointData().getArrayByName("SourcePointId").getData()
    );
    expect(sourceIds).toContain(notSampled);

    feature.clearSelectedPoint(instanceId);
    sourceIds = Array.from(
      state.derivedPolydata.getPointData().getArrayByName("SourcePointId").getData()
    );
    expect(sourceIds).not.toContain(notSampled);
  });

  it("full density (1.0) uses the base polydata directly (no derived copy)", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "density-full";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(50);
    feature.enableGlyphs(instanceId, pd, { density: 1.0 });

    const state = feature.instanceStates.get(instanceId);
    expect(state.derivedPolydata).toBeNull();
    expect(state.glyphMapper.getInputData(0)).toBe(pd);
  });

  it("preserves active scalars/vectors and records SourcePointId when subsampling", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "density-roles";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(100);
    // addArray alone doesn't assign scalar/vector "role" — explicitly mark
    // which array is active, matching how a real loaded dataset would.
    pd.getPointData().setActiveScalars("temperature");
    pd.getPointData().setActiveVectors("velocity");

    feature.enableGlyphs(instanceId, pd);
    feature.setDensity(instanceId, 0.1);

    const state = feature.instanceStates.get(instanceId);
    const derived = state.derivedPolydata;
    expect(derived).not.toBeNull();

    expect(derived.getPointData().getScalars()?.getName()).toBe("temperature");
    expect(derived.getPointData().getVectors()?.getName()).toBe("velocity");

    const sourcePointId = derived.getPointData().getArrayByName("SourcePointId");
    expect(sourcePointId).not.toBeNull();
    const keepCount = derived.getPoints().getNumberOfPoints();
    expect(sourcePointId.getNumberOfTuples()).toBe(keepCount);
    // Every recorded source index must be a valid, in-range point id.
    const ids = sourcePointId.getData();
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThanOrEqual(0);
      expect(ids[i]).toBeLessThan(100);
    }
  });

  it("stride subsampling does not always pick the first point of each window, but is reproducible", () => {
    // Regression test: a pure fixed stride (always index 0 of each window)
    // systematically favors whatever spatial/structural pattern correlates
    // with point-insertion order. This asserts SOME variation in the
    // within-window offset across windows, and that re-running the same
    // subsample twice yields identical results (collaborators must see the
    // same glyphs for the same dataset+density).
    const feature = new VTKGlyphFeature();
    const pd = makeSyntheticPolydata(1000);

    const first = feature._buildSubsampledPolydata(pd, 0.1);
    const second = feature._buildSubsampledPolydata(pd, 0.1);

    const firstIds = first.getPointData().getArrayByName("SourcePointId").getData();
    const secondIds = second.getPointData().getArrayByName("SourcePointId").getData();

    // Reproducible: same input always yields the same sample.
    expect(Array.from(firstIds)).toEqual(Array.from(secondIds));

    // Not a pure fixed stride: at least one window's offset isn't 0 (i.e.
    // not every kept index is an exact multiple of the stride).
    const stride = Math.round(1 / 0.1);
    const anyNonZeroOffset = Array.from(firstIds).some((id, i) => id !== i * stride);
    expect(anyNonZeroOffset).toBe(true);
  });
});

describe("VTKGlyphFeature declarative config sync", () => {
  it("round-trips config from one instance to another via getConfigForSync/applyRemoteConfig", () => {
    const featureA = new VTKGlyphFeature();
    const sceneObjectsA = makeMockSceneObjects();
    const instanceIdA = "sync-a";
    featureA.initialize(instanceIdA, { sceneObjects: sceneObjectsA });

    const pdA = makeSyntheticPolydata(20);
    featureA.enableGlyphs(instanceIdA, pdA, {
      glyphType: "cone",
      scaleFactor: 2.0,
      density: 0.5,
      colorMode: "solid",
    });

    const synced = featureA.getConfigForSync(instanceIdA);

    const featureB = new VTKGlyphFeature();
    const sceneObjectsB = makeMockSceneObjects();
    const instanceIdB = "sync-b";
    featureB.initialize(instanceIdB, { sceneObjects: sceneObjectsB });
    const pdB = makeSyntheticPolydata(20);

    featureB.applyRemoteConfig(instanceIdB, pdB, synced);
    const stateB = featureB.getState(instanceIdB);

    expect(stateB.glyphType).toBe("cone");
    expect(stateB.scaleFactor).toBe(2.0);
    expect(stateB.density).toBe(0.5);
    expect(stateB.colorMode).toBe("solid");
  });

  it("applyRemoteConfig disables glyphs when enabled is false", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "sync-disable";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(10);
    feature.enableGlyphs(instanceId, pd);
    expect(feature.getState(instanceId).enabled).toBe(true);

    feature.applyRemoteConfig(instanceId, pd, { enabled: false });
    expect(feature.getState(instanceId).enabled).toBe(false);
    expect(sceneObjects.renderer._actors.length).toBe(0);
  });

  it("applyRemoteConfig does not throw when enabling without polydata (degrades safely)", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "sync-no-polydata";
    feature.initialize(instanceId, { sceneObjects });

    expect(() =>
      feature.applyRemoteConfig(instanceId, null, { enabled: true, glyphType: "arrow" })
    ).not.toThrow();
    expect(feature.getState(instanceId).enabled).toBe(false);
  });

  it("applyRemoteConfig does not duplicate actors when config is applied repeatedly", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "sync-repeat";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(10);
    const config = { enabled: true, glyphType: "sphere", scaleFactor: 1.5 };

    feature.applyRemoteConfig(instanceId, pd, config);
    feature.applyRemoteConfig(instanceId, pd, config);
    feature.applyRemoteConfig(instanceId, pd, { ...config, scaleFactor: 2.0 });

    expect(sceneObjects.renderer.addActor).toHaveBeenCalledTimes(1);
    expect(sceneObjects.renderer._actors.length).toBe(1);
  });

  it("passes the correct vtk.js scale-mode enum value to the glyph mapper", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "scale-mode-enum";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(10);
    pd.getPointData().setActiveVectors("velocity");
    feature.enableGlyphs(instanceId, pd, { scalingMode: "components", scaleArray: "velocity" });

    const state = feature.instanceStates.get(instanceId);
    // vtk.js Glyph3DMapper Constants: SCALE_BY_CONSTANT=0, SCALE_BY_MAGNITUDE=1, SCALE_BY_COMPONENTS=2
    expect(state.glyphMapper.getScaleMode()).toBe(2);
  });

  it("applyRemoteConfig round-trips scalingMode/scaleArray while already enabled", () => {
    const feature = new VTKGlyphFeature();
    const sceneObjects = makeMockSceneObjects();
    const instanceId = "sync-scaling-mode";
    feature.initialize(instanceId, { sceneObjects });

    const pd = makeSyntheticPolydata(10);
    pd.getPointData().setActiveVectors("velocity");
    feature.enableGlyphs(instanceId, pd, { scalingMode: "off" });
    expect(feature.getState(instanceId).scalingMode).toBe("off");

    // Already enabled — this must go through the diff branch, not a re-enable.
    feature.applyRemoteConfig(instanceId, pd, {
      enabled: true,
      scalingMode: "magnitude",
      scaleArray: "velocity",
    });

    const state = feature.getState(instanceId);
    expect(state.scalingMode).toBe("magnitude");
    expect(state.scaleArray).toBe("velocity");
    expect(feature.instanceStates.get(instanceId).glyphMapper.getScaleMode()).toBe(1);
    expect(sceneObjects.renderer.addActor).toHaveBeenCalledTimes(1); // no re-enable/duplicate actor
  });
});

describe("scanAvailableArrays color-array exclusion", () => {
  it("does not offer a 3-component RGB color array as a vector/orientation candidate", () => {
    const feature = new VTKGlyphFeature();
    const instanceId = "color-exclusion";
    feature.initialize(instanceId, { sceneObjects: makeMockSceneObjects() });

    const pd = makeSyntheticPolydata(10, { withVector: false, withScalar: false });
    const colorData = new Float32Array(10 * 3);
    for (let i = 0; i < 10; i++) {
      colorData[i * 3] = 1;
      colorData[i * 3 + 1] = 0;
      colorData[i * 3 + 2] = 0;
    }
    pd.getPointData().addArray(
      vtkDataArray.newInstance({ name: "Colors", numberOfComponents: 3, values: colorData })
    );

    feature.scanAvailableArrays(instanceId, pd);
    const state = feature.getState(instanceId);

    expect(state.vectorArrays.map((a) => a.name)).not.toContain("Colors");
  });

  it("still offers a genuine 3-component vector array named something other than a color alias", () => {
    const feature = new VTKGlyphFeature();
    const instanceId = "vector-not-excluded";
    feature.initialize(instanceId, { sceneObjects: makeMockSceneObjects() });

    const pd = makeSyntheticPolydata(10, { withVector: true, withScalar: false });
    feature.scanAvailableArrays(instanceId, pd);
    const state = feature.getState(instanceId);

    expect(state.vectorArrays.map((a) => a.name)).toContain("velocity");
  });
});
