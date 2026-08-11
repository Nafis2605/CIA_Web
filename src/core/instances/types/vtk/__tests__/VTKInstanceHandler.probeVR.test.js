// src/core/instances/types/vtk/__tests__/VTKInstanceHandler.probeVR.test.js
//
// Covers probeDataVR (R5 probe tool support): nearest-point lookup over the
// instance polydata + point-data array value extraction, graceful null when
// there is no polydata/points, and — since the fix — the actor's FULL
// composed transform being inverted before probing (not just a tracked yaw
// scalar) via a real vtk.js vtkPointLocator/vtkMatrixBuilder. Uses REAL
// vtk.js polydata/points/actor objects (matching VTKGlyphFeature.test.js's
// pattern) rather than duck-typed fakes, deliberately: vtkPointLocator needs
// real getBounds()/getPoints().getPoint() support, and a mock would hide
// exactly the forward-vs-inverse transform mistakes this class of bug is
// made of.
import { describe, it, expect, beforeEach } from "vitest";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import { buildYawPivotMatrix } from "@Core/vr/tools/vrPlaneMath.js";
import { VTKInstanceHandler } from "../VTKInstanceHandler.js";

function makePolyData(points, arrays = []) {
  const pts = vtkPoints.newInstance();
  pts.setData(new Float64Array(points), 3);

  const pd = vtkPolyData.newInstance();
  pd.setPoints(pts);

  for (const a of arrays) {
    pd.getPointData().addArray(
      vtkDataArray.newInstance({ name: a.name, numberOfComponents: a.comps, values: a.data })
    );
  }
  return pd;
}

function makeActorWithPolyData(polyData) {
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(polyData);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  return actor;
}

function makeVrContext(actor) {
  return {
    sceneObjects: {
      actor,
      mapper: actor.getMapper(),
    },
  };
}

describe("VTKInstanceHandler.probeDataVR", () => {
  let handler;

  beforeEach(() => {
    handler = new VTKInstanceHandler();
  });

  it("returns the nearest point id, distance, position and scalar value", () => {
    // three points along X; one scalar array "temperature"
    const points = [0, 0, 0, 1, 0, 0, 2, 0, 0];
    const arrays = [{ name: "temperature", comps: 1, data: [10, 20, 30] }];
    const actor = makeActorWithPolyData(makePolyData(points, arrays));
    const ctx = makeVrContext(actor);

    const result = handler.probeDataVR(ctx, { x: 0.9, y: 0.05, z: 0 });

    expect(result).not.toBeNull();
    expect(result.pointId).toBe(1); // (1,0,0) is nearest to (0.9,0.05,0)
    expect(result.position).toEqual([1, 0, 0]);
    expect(result.values.temperature).toBe(20);
    expect(result.distance).toBeCloseTo(Math.hypot(0.1, 0.05, 0));
  });

  it("extracts multi-component array values as an array", () => {
    const points = [0, 0, 0, 5, 5, 5];
    const arrays = [{ name: "velocity", comps: 3, data: [1, 2, 3, 4, 5, 6] }];
    const actor = makeActorWithPolyData(makePolyData(points, arrays));
    const ctx = makeVrContext(actor);

    const result = handler.probeDataVR(ctx, { x: 5, y: 5, z: 5 });
    expect(result.pointId).toBe(1);
    expect(result.values.velocity).toEqual([4, 5, 6]);
  });

  it("accepts an array-form position", () => {
    const points = [0, 0, 0, 10, 0, 0];
    const actor = makeActorWithPolyData(makePolyData(points, []));
    const ctx = makeVrContext(actor);
    const result = handler.probeDataVR(ctx, [9, 0, 0]);
    expect(result.pointId).toBe(1);
  });

  it("returns null when there is no polydata", () => {
    const mapper = vtkMapper.newInstance();
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    const ctx = makeVrContext(actor);
    expect(handler.probeDataVR(ctx, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it("returns null when the polydata has no points", () => {
    const actor = makeActorWithPolyData(makePolyData([], []));
    const ctx = makeVrContext(actor);
    expect(handler.probeDataVR(ctx, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it("returns null when vrContext/sceneObjects is missing", () => {
    expect(handler.probeDataVR(null, { x: 0, y: 0, z: 0 })).toBeNull();
    expect(handler.probeDataVR({}, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  describe("full actor transform inversion (not just yaw)", () => {
    it("accounts for a translation (Position) the actor carries", () => {
      // A single point at the local origin; the actor is translated +10 on X.
      // A world-space query at (10,0,0) must map back to local (0,0,0).
      const actor = makeActorWithPolyData(makePolyData([0, 0, 0]));
      actor.setPosition(10, 0, 0);
      const ctx = makeVrContext(actor);

      const result = handler.probeDataVR(ctx, { x: 10, y: 0, z: 0 });
      expect(result).not.toBeNull();
      expect(result.pointId).toBe(0);
      expect(result.distance).toBeCloseTo(0);
    });

    it("accounts for a VR-yaw UserMatrix the same way the old yaw-only hack did", () => {
      // Point at local (1, 0, 0). Apply the SAME yaw matrix
      // _applyVRDataRotation itself uses (buildYawPivotMatrix) via
      // setUserMatrix — for buildYawPivotMatrix's rotation direction, local
      // (1,0,0) lands at world (cos(angle), 0, -sin(angle)) (verified against
      // vtk.js's own forward transform, not hand-derived). Probing at that
      // world position must resolve back to the same local point.
      const actor = makeActorWithPolyData(makePolyData([1, 0, 0]));
      const angle = Math.PI / 2;
      actor.setUserMatrix(buildYawPivotMatrix(angle, [0, 0, 0]));
      const ctx = makeVrContext(actor);

      const worldX = Math.cos(angle);
      const worldZ = -Math.sin(angle);
      const result = handler.probeDataVR(ctx, { x: worldX, y: 0, z: worldZ });
      expect(result).not.toBeNull();
      expect(result.pointId).toBe(0);
      expect(result.distance).toBeCloseTo(0);
    });
  });

  it("probes the passed actor's polydata, not the primary sceneObjects actor", () => {
    // Primary actor has a point far from the query; a SECOND (e.g. glyph)
    // actor has a point right at the query position.
    const primaryActor = makeActorWithPolyData(makePolyData([100, 100, 100]));
    const otherActor = makeActorWithPolyData(makePolyData([0, 0, 0]));
    const ctx = makeVrContext(primaryActor);

    const result = handler.probeDataVR(ctx, { x: 0, y: 0, z: 0 }, otherActor);
    expect(result).not.toBeNull();
    expect(result.distance).toBeCloseTo(0);
  });

  it("caches one locator per actor and rebuilds only when the polydata reference changes", () => {
    const polyData = makePolyData([0, 0, 0, 1, 0, 0]);
    const actor = makeActorWithPolyData(polyData);
    const ctx = makeVrContext(actor);

    handler.probeDataVR(ctx, { x: 0, y: 0, z: 0 });
    const firstEntry = ctx._vrPointLocators.get(actor);
    expect(firstEntry).toBeDefined();

    handler.probeDataVR(ctx, { x: 1, y: 0, z: 0 });
    expect(ctx._vrPointLocators.get(actor)).toBe(firstEntry); // same cached locator

    // Swap in a new polydata (e.g. density change) — must rebuild.
    const newPolyData = makePolyData([5, 5, 5]);
    actor.getMapper().setInputData(newPolyData);
    handler.probeDataVR(ctx, { x: 5, y: 5, z: 5 });
    expect(ctx._vrPointLocators.get(actor)).not.toBe(firstEntry);
  });
});
