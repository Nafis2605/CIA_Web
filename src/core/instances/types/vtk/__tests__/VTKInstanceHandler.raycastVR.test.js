// src/core/instances/types/vtk/__tests__/VTKInstanceHandler.raycastVR.test.js
//
// Covers raycastVR, the single world-space picking entry point every VR tool
// depends on (measure, annotate, probe, teleport, and the Vision Pro gaze
// reticle all funnel through it).
//
// This file exists because raycastVR was silently broken in a way no test
// caught: it called `picker.pick(p1, p2, renderer)`, but vtk.js's pick() takes
// TWO args and its first is a DISPLAY/pixel coordinate — so a world point was
// being read as pixels and an array was being passed as the renderer, throwing
// inside renderer.getActiveCamera(). It then branched on pick()'s return value,
// which is always undefined. Every trigger pull in VR threw into the frame
// loop's blanket try/catch, every frame, with no visible symptom beyond tools
// that "did nothing". The tests below pin each of those failure modes.
//
// vtkCellPicker is mocked at the module seam so the assertions can be about
// which picker API we call and how we read it back, with no GL context.
import { describe, it, expect, beforeEach, vi } from "vitest";
import vtkCellPicker from "@kitware/vtk.js/Rendering/Core/CellPicker";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import { vtkGlyphFeature } from "@VTK/features/VTKGlyphFeature";
import { vtkThresholdFeature } from "@VTK/features/VTKThresholdFeature";
import { VTKInstanceHandler } from "../VTKInstanceHandler.js";

// Real vtk.js actor/mapper/polydata, matching VTKInstanceHandler.probeVR.test.js's
// pattern — needed for the actor-transform regression tests below, since a mock
// getMatrix() would hide exactly the forward-vs-inverse transform mistakes this
// class of bug is made of.
function makeRealActorWithPoints(points) {
  const pts = vtkPoints.newInstance();
  pts.setData(new Float64Array(points), 3);
  const polyData = vtkPolyData.newInstance();
  polyData.setPoints(pts);
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(polyData);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  return actor;
}

vi.mock("@kitware/vtk.js/Rendering/Core/CellPicker", () => {
  const newInstance = vi.fn(() => ({
    setTolerance: vi.fn(),
    setPickFromList: vi.fn(),
    setPickList: vi.fn(),
    // Real vtkCellPicker overrides publicAPI.initialize to reset cellId
    // (CellPicker.js:113-116). raycastVR must call it explicitly because
    // pick3DPoint does not — see the note at its call site.
    initialize: vi.fn(),
    pick: vi.fn(),
    pick3DPoint: vi.fn(),
    getCellId: vi.fn(() => 42),
    getPickPosition: vi.fn(() => [1, 2, 3]),
    getPickNormal: vi.fn(() => [0, 1, 0]),
    getActors: vi.fn(() => []),
    delete: vi.fn(),
  }));
  return { default: { newInstance } };
});

vi.mock("@kitware/vtk.js/Rendering/Core/PointPicker", () => {
  // Defaults to a MISS ([] actors, pointId -1) — tests that want a hit set
  // getActors/getPointId/getPickPosition explicitly, matching the CellPicker
  // mock's convention above.
  const newInstance = vi.fn(() => ({
    setTolerance: vi.fn(),
    setPickFromList: vi.fn(),
    setPickList: vi.fn(),
    initialize: vi.fn(),
    pick3DPoint: vi.fn(),
    getPointId: vi.fn(() => -1),
    getPickPosition: vi.fn(() => [0, 0, 0]),
    getActors: vi.fn(() => []),
    delete: vi.fn(),
  }));
  return { default: { newInstance } };
});

/** A pickable, visible, mapper-bearing actor (i.e. a legitimate pick target). */
function makeActor({ pickable = true, visible = true, mapper = {} } = {}) {
  return {
    getPickable: () => pickable,
    getVisibility: () => visible,
    getMapper: () => mapper,
  };
}

// vrScale/vrOrigin default to NON-IDENTITY on purpose. VR here remaps the
// CAMERA and leaves actors in data space, so a pick ray given in XR metres
// must be mapped through `dataPos = xrPos / vrScale + vrOrigin` first. With
// the identity transform these tests used to imply (scale 1, origin at zero),
// that mapping is a no-op and a missing conversion is mathematically
// invisible — which is exactly how raycastVR shipped picking in the wrong
// space. A real session never has identity here: _applyInitialPlacement
// auto-fits the dataset on entry.
function makeVrContext({
  actors = null,
  dataBounds = [0, 1, 0, 1, 0, 1],
  vrScale = 2,
  vrOrigin = [10, 20, 30],
} = {}) {
  const dataActor = makeActor();
  return {
    dataBounds,
    vrScale,
    vrOrigin,
    sceneObjects: {
      renderer: { getActors: () => actors ?? [dataActor] },
      actor: dataActor,
    },
  };
}

const RAY = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };

// Data-space image of RAY's origin under makeVrContext's default transform.
// FOUR components: vtkPicker.pick3DPoint does not append a homogeneous w of
// its own (Picker.js:268-284, unlike publicAPI.pick at :263-264), and
// pick3DInternal divides by p[3] (:105-106) — a 3-element array yields NaN and
// silently kills every VR pick.
const RAY_ORIGIN_IN_DATA_SPACE = [10, 20, 30, 1.0];

/** Length of the ray handed to the picker, i.e. |p2 - p1|. */
function pickRayLength(picker) {
  const [p1, p2] = picker.pick3DPoint.mock.calls[0];
  return Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
}

describe("VTKInstanceHandler.raycastVR", () => {
  let handler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new VTKInstanceHandler();
  });

  it("uses the world-space pick3DPoint API, not the display-space pick()", () => {
    const ctx = makeVrContext();
    handler.raycastVR(ctx, RAY);

    const picker = ctx._vrPicker;
    expect(picker.pick3DPoint).toHaveBeenCalledTimes(1);
    expect(picker.pick).not.toHaveBeenCalled();

    // (p1World, p2World, renderer) — the renderer must be the 3rd arg, not the
    // 2nd (the old signature passed the far point where the renderer belonged).
    const [p1, p2, renderer] = picker.pick3DPoint.mock.calls[0];
    expect(p1).toEqual(RAY_ORIGIN_IN_DATA_SPACE);
    expect(Array.isArray(p2)).toBe(true);
    expect(renderer).toBe(ctx.sceneObjects.renderer);
  });

  it("returns null when the picker reports no cell", () => {
    const ctx = makeVrContext();
    handler.raycastVR(ctx, RAY); // prime the cached picker
    ctx._vrPicker.getCellId.mockReturnValue(-1);

    expect(handler.raycastVR(ctx, RAY)).toBeNull();
  });

  it("returns a hit with data-space position and normal when a cell is picked", () => {
    const result = handler.raycastVR(makeVrContext(), RAY);

    expect(result).toMatchObject({
      hit: true,
      position: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
      cellId: 42,
    });
    // Distance is measured from the ray origin to the hit IN DATA SPACE — both
    // endpoints must be in the same space or this number is meaningless.
    const [ox, oy, oz] = RAY_ORIGIN_IN_DATA_SPACE; // w is not part of the metric
    expect(result.distance).toBeCloseTo(Math.hypot(1 - ox, 2 - oy, 3 - oz));
  });

  it("includes the instance's datasetId in the hit, or null when the instance is unknown", () => {
    const ctx = makeVrContext();
    ctx.instanceId = "instance-with-dataset";
    handler.instances.set("instance-with-dataset", { datasetId: "ds-42" });

    const result = handler.raycastVR(ctx, RAY);
    expect(result.datasetId).toBe("ds-42");

    const ctxNoInstance = makeVrContext();
    expect(handler.raycastVR(ctxNoInstance, RAY).datasetId).toBeNull();
  });

  it("does not branch on pick3DPoint's return value (it always returns undefined)", () => {
    const ctx = makeVrContext();
    handler.raycastVR(ctx, RAY);
    ctx._vrPicker.pick3DPoint.mockReturnValue(undefined);

    // getCellId() still reports a hit, so a hit must still come back.
    expect(handler.raycastVR(ctx, RAY)).not.toBeNull();
  });

  it("reuses one cached picker per VR context instead of allocating per call", () => {
    const ctx = makeVrContext();
    handler.raycastVR(ctx, RAY);
    handler.raycastVR(ctx, RAY);
    handler.raycastVR(ctx, RAY);

    // raycastVR runs at least once per XR frame (~90 Hz) — a fresh picker each
    // call would be steady allocation churn.
    expect(vtkCellPicker.newInstance).toHaveBeenCalledTimes(1);
  });

  describe("ray length", () => {
    it("scales with dataBounds rather than using a fixed magic number", () => {
      // CellPicker compares candidates with `t <= tMin + tolerance`, where t is
      // parametric along p1->p2. A fixed 1000-unit ray over a small dataset
      // collapses the real hit spread toward t=0 and picks the WRONG cell.
      const small = makeVrContext({ dataBounds: [0, 0.01, 0, 0.01, 0, 0.01] });
      const large = makeVrContext({ dataBounds: [0, 100, 0, 100, 0, 100] });

      handler.raycastVR(small, RAY);
      handler.raycastVR(large, RAY);

      // Measured as |p2 - p1| rather than a raw coordinate: the ray no longer
      // starts at the origin (it starts at the data-space image of the
      // controller), so a bare component is a position, not a length.
      expect(pickRayLength(large._vrPicker)).toBeGreaterThan(
        pickRayLength(small._vrPicker)
      );
      expect(pickRayLength(small._vrPicker)).not.toBe(1000);
    });

    it("clamps to a usable minimum for degenerate (point-like) bounds", () => {
      const ctx = makeVrContext({ dataBounds: [0, 0, 0, 0, 0, 0] });
      handler.raycastVR(ctx, RAY);

      expect(pickRayLength(ctx._vrPicker)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("_getVRPickTargets", () => {
    it("excludes non-pickable, invisible, and mapper-less actors", () => {
      const good = makeActor();
      const ctx = makeVrContext({
        actors: [
          good,
          makeActor({ pickable: false }), // menu chrome, environment, avatars
          makeActor({ visible: false }),
          makeActor({ mapper: null }),
        ],
      });

      expect(handler._getVRPickTargets(ctx)).toEqual([good]);
    });

    it("does NOT hardcode the primary actor — derived filter actors stay pickable", () => {
      // VTKThresholdFeature and VTKIsosurfaceFeature HIDE sceneObjects.actor and
      // add their own derived actor. Hardcoding [sceneObjects.actor] would make
      // every VR tool go blind the moment either filter is switched on.
      const ctx = makeVrContext();
      const derived = makeActor();
      ctx.sceneObjects.actor.getVisibility = () => false;
      ctx.sceneObjects.renderer.getActors = () => [
        ctx.sceneObjects.actor,
        derived,
      ];

      expect(handler._getVRPickTargets(ctx)).toEqual([derived]);
    });

    it("falls back to the primary actor when nothing qualifies", () => {
      const ctx = makeVrContext({ actors: [] });
      expect(handler._getVRPickTargets(ctx)).toEqual([ctx.sceneObjects.actor]);
    });

    it("scopes the picker to those targets", () => {
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY);

      expect(ctx._vrPicker.setPickFromList).toHaveBeenCalledWith(true);
      expect(ctx._vrPicker.setPickList).toHaveBeenCalledWith([
        ctx.sceneObjects.actor,
      ]);
    });
  });

  describe("input normalisation", () => {
    it("accepts an XRRigidTransform, reading forward from its matrix -Z", () => {
      const ctx = makeVrContext();
      // Column-major identity: -Z forward is (-m[8], -m[9], -m[10]) = (0,0,-1).
      const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const result = handler.raycastVR(ctx, {
        position: { x: 0, y: 0, z: 0 },
        matrix,
      });

      expect(result).not.toBeNull();
      const [near, far] = ctx._vrPicker.pick3DPoint.mock.calls[0];
      expect(far[2]).toBeLessThan(near[2]); // travelled along -Z from the origin
    });

    it("maps the XR-space ray origin into data space before picking", () => {
      // THE regression this file most needs. VR remaps the camera and leaves
      // actors in data space, so the controller's XR-metre origin has to go
      // through `dataPos = xrPos / vrScale + vrOrigin` (vrPlaneMath's
      // mapXRPointToData, the same helper VRClipBoxTool already uses) before
      // it can be intersected against geometry. Picking with the raw XR point
      // starts the ray nowhere near the dataset, so getCellId() reports -1 and
      // EVERY VR tool — annotate, measure, probe, and the pointer reticle —
      // silently does nothing, with no error to show for it.
      const ctx = makeVrContext({ vrScale: 2, vrOrigin: [10, 20, 30] });
      handler.raycastVR(ctx, {
        origin: { x: 2, y: 4, z: -6 },
        direction: { x: 0, y: 0, z: -1 },
      });

      const [p1] = ctx._vrPicker.pick3DPoint.mock.calls[0];
      expect(p1).toEqual([11, 22, 27, 1.0]); // NOT the raw [2, 4, -6]
    });

    it("passes 4-component homogeneous endpoints (w = 1) to the picker", () => {
      // vtkPicker.pick3DPoint forwards these arrays to pick3DInternal WITHOUT
      // appending w (Picker.js:268-284), and pick3DInternal then does
      // vec4.transformMat4 followed by vec3.scale(p, p, 1 / p[3])
      // (Picker.js:103-106). A 3-element array makes w undefined -> NaN
      // everywhere -> getCellId() never leaves -1 -> raycastVR returns null on
      // every call. See the sibling integration test for the end-to-end proof.
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY);

      const [p1, p2] = ctx._vrPicker.pick3DPoint.mock.calls[0];
      expect(p1).toHaveLength(4);
      expect(p2).toHaveLength(4);
      expect(p1[3]).toBe(1.0);
      expect(p2[3]).toBe(1.0);
    });

    it("resets picker state before each pick so a miss cannot report a stale cell", () => {
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY);
      expect(ctx._vrPicker.initialize).toHaveBeenCalled();
    });

    it("leaves the ray DIRECTION unscaled — only the origin is transformed", () => {
      // The XR->data map is a uniform scale plus a translation, so a direction
      // maps to d/vrScale, which is the same unit vector. Dividing the
      // direction as well would be a plausible-looking over-correction that
      // silently shortens the ray by a factor of vrScale.
      const ctx = makeVrContext({ vrScale: 4, vrOrigin: [1, 2, 3] });
      handler.raycastVR(ctx, {
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: -1 },
      });

      const [p1, p2] = ctx._vrPicker.pick3DPoint.mock.calls[0];
      const len = pickRayLength(ctx._vrPicker);
      const unit = [
        (p2[0] - p1[0]) / len,
        (p2[1] - p1[1]) / len,
        (p2[2] - p1[2]) / len,
      ];
      expect(unit[0]).toBeCloseTo(0);
      expect(unit[1]).toBeCloseTo(0);
      expect(unit[2]).toBeCloseTo(-1);

      // And the length still comes from the dataset's own bounds, undivided.
      expect(len).toBeCloseTo(Math.hypot(1, 1, 1) * 4);
    });

    it("returns null for an unusable ray or missing sceneObjects", () => {
      expect(handler.raycastVR(makeVrContext(), null)).toBeNull();
      expect(handler.raycastVR({}, RAY)).toBeNull();
      expect(handler.raycastVR(makeVrContext(), {})).toBeNull();
    });
  });

  describe("pointId resolution", () => {
    it("resolves the nearest candidate point within the hit cell, and classifies the source actor", () => {
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY); // prime the cached picker

      // Three candidate points for the "hit" cell; (1,0,0) is nearest to the
      // mocked pick position [1,2,3] (dist2=13 vs 14 and 194).
      const fakePolyData = {
        getCellPoints: () => ({ cellType: 5, cellPointIds: [0, 1, 2] }),
        getPoints: () => ({
          getData: () => new Float32Array([0, 0, 0, 1, 0, 0, 10, 10, 10]),
        }),
      };
      const hitActor = ctx.sceneObjects.actor;
      hitActor.getMapper = () => ({ getInputData: () => fakePolyData });
      ctx._vrPicker.getActors.mockReturnValue([hitActor]);

      const result = handler.raycastVR(ctx, RAY);
      expect(result.pointId).toBe(1);
      expect(result.actorRole).toBe("source");
    });

    it("snaps position to the resolved vertex's own coordinates, preserving the raw hit as surfacePosition", () => {
      // Regression test for the bug where `position` stayed the raw,
      // un-snapped cell-picker intersection even though `pointId` names a
      // specific vertex — the two silently disagreed. Mocked pick position
      // is [1,2,3] (CellPicker mock default); candidate id 1 at (1,2,2) is
      // nearest (dist2=1) but is NOT the pick position itself, so a
      // regression back to the raw surface point is distinguishable.
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY); // prime the cached picker

      const fakePolyData = {
        getCellPoints: () => ({ cellType: 5, cellPointIds: [0, 1, 2] }),
        getPoints: () => ({
          getData: () => new Float32Array([0, 0, 0, 1, 2, 2, 10, 10, 10]),
        }),
      };
      const hitActor = ctx.sceneObjects.actor; // no getMatrix -> identity transform
      hitActor.getMapper = () => ({ getInputData: () => fakePolyData });
      ctx._vrPicker.getActors.mockReturnValue([hitActor]);

      const result = handler.raycastVR(ctx, RAY);
      expect(result.pointId).toBe(1);
      expect(result.position).toEqual({ x: 1, y: 2, z: 2 });
      expect(result.surfacePosition).toEqual({ x: 1, y: 2, z: 3 });
    });

    it("compares the WORLD-space pick position against candidates in a single consistent space (accounts for actor Position)", () => {
      // Regression test: the pre-fix code compared `position` (WORLD-space,
      // from vtkCellPicker.getPickPosition()) directly against the
      // polydata's raw LOCAL-space point coordinates. Here the actor is
      // translated +5 on X/Y/Z, so comparing un-transformed would pick the
      // WRONG candidate (id 2, (10,10,10), dist2=66) instead of the true
      // nearest (id 1, (1,0,0) + translation = (6,5,5), dist2=0).
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY); // prime the cached picker

      const fakePolyData = {
        getCellPoints: () => ({ cellType: 5, cellPointIds: [0, 1, 2] }),
        getPoints: () => ({
          getData: () => new Float32Array([0, 0, 0, 1, 0, 0, 10, 10, 10]),
        }),
      };
      const actor = vtkActor.newInstance();
      actor.setPosition(5, 5, 5);
      actor.setMapper({ getInputData: () => fakePolyData });
      ctx._vrPicker.getActors.mockReturnValue([actor]);
      ctx._vrPicker.getPickPosition.mockReturnValue([6, 5, 5]);

      const result = handler.raycastVR(ctx, RAY);
      expect(result.pointId).toBe(1);
      // Forward transform of the resolved vertex (1,0,0) through the same
      // +5/+5/+5 actor translation used above.
      expect(result.position).toEqual({ x: 6, y: 5, z: 5 });
    });

    it("returns pointId -1 when the actor's polydata can't be resolved, and position falls back to the raw surface hit", () => {
      const ctx = makeVrContext();
      const result = handler.raycastVR(ctx, RAY);
      expect(result.pointId).toBe(-1);
      expect(result.position).toEqual(result.surfacePosition);
    });

    it("returns pointId -1 (not a throw) when getCellPoints itself throws", () => {
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY);

      const throwingPolyData = {
        getCellPoints: () => {
          throw new Error("boom");
        },
        getPoints: () => ({ getData: () => new Float32Array() }),
      };
      const hitActor = ctx.sceneObjects.actor;
      hitActor.getMapper = () => ({ getInputData: () => throwingPolyData });
      ctx._vrPicker.getActors.mockReturnValue([hitActor]);

      const result = handler.raycastVR(ctx, RAY);
      expect(result.pointId).toBe(-1);
    });
  });

  describe("selection modes", () => {
    it("'surface' mode returns the raw hit with pointId -1, skipping vertex-snapping entirely", () => {
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY); // prime the cached picker

      // A polydata that WOULD resolve a real pointId in 'nearestVertex' mode
      // (see the "pointId resolution" tests above) — proves 'surface' mode
      // deliberately skips this, not that it merely failed to resolve one.
      const fakePolyData = {
        getCellPoints: () => ({ cellType: 5, cellPointIds: [0, 1, 2] }),
        getPoints: () => ({
          getData: () => new Float32Array([0, 0, 0, 1, 0, 0, 10, 10, 10]),
        }),
      };
      const hitActor = ctx.sceneObjects.actor;
      hitActor.getMapper = () => ({ getInputData: () => fakePolyData });
      ctx._vrPicker.getActors.mockReturnValue([hitActor]);

      const result = handler.raycastVR(ctx, RAY, { selectionMode: "surface" });
      expect(result.hit).toBe(true);
      expect(result.pointId).toBe(-1);
      expect(result.cellId).toBe(42);
      // No vertex was resolved (pointId -1), so position must NOT be
      // snapped — it stays the raw surface intersection, same as surfacePosition.
      expect(result.position).toEqual(result.surfacePosition);
    });

    it("'exactPoint' mode bypasses the cell picker entirely and uses vtkPointPicker", () => {
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" });

      expect(ctx._vrPicker).toBeUndefined(); // cell picker never created
      const pointPicker = ctx._vrPointPicker;
      expect(pointPicker.pick3DPoint).toHaveBeenCalledTimes(1);
    });

    it("'exactPoint' mode returns null on a miss (empty actors list) regardless of a stale pointId", () => {
      const ctx = makeVrContext();
      handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" }); // prime cache
      // Simulate vtk.js's real quirk: pointId isn't reset on a miss, only
      // getActors() reliably reflects "nothing found this call".
      ctx._vrPointPicker.getPointId.mockReturnValue(7);
      ctx._vrPointPicker.getActors.mockReturnValue([]);

      expect(handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" })).toBeNull();
    });

    it("'exactPoint' mode returns a hit shaped like the cell-picker path, with cellId -1", () => {
      const ctx = makeVrContext();
      const hitActor = ctx.sceneObjects.actor;
      // vtkPointPicker's real getPickPosition() is never populated by
      // pick3DPoint() (see _raycastExactPoint's comment) — production code
      // resolves position from pointId + the actor's own polydata instead,
      // so the mock must supply that, not a canned getPickPosition() value.
      hitActor.getMapper = () => ({
        getInputData: () => ({
          getPoints: () => ({
            getNumberOfPoints: () => 6,
            getData: () => new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]),
          }),
        }),
      });
      handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" }); // prime cache
      ctx._vrPointPicker.getActors.mockReturnValue([hitActor]);
      ctx._vrPointPicker.getPointId.mockReturnValue(5); // -> coords[15..17] = [1,2,3]

      const result = handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" });
      expect(result).toMatchObject({
        hit: true,
        position: { x: 1, y: 2, z: 3 },
        cellId: -1,
        pointId: 5,
        actorRole: "source",
      });
    });

    it("automatically falls back to exactPoint when the cell picker misses against a cell-less (point-cloud) target", () => {
      const ctx = makeVrContext();
      const hitActor = ctx.sceneObjects.actor;
      // Zero cells (so raycastVR's zero-cell fallback triggers) but real
      // points, so _raycastExactPoint's polydata-based position resolution
      // has something to resolve pointId 3 -> [4,5,6] against.
      hitActor.getMapper = () => ({
        getInputData: () => ({
          getNumberOfCells: () => 0,
          getPoints: () => ({
            getNumberOfPoints: () => 4,
            getData: () => new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 5, 6]),
          }),
        }),
      });

      handler.raycastVR(ctx, RAY); // creates _vrPicker (default mock: cellId=42, a hit)
      ctx._vrPicker.getCellId.mockReturnValue(-1); // now force a miss

      // This call takes the miss -> zero-cell -> exactPoint fallback branch,
      // which lazily creates _vrPointPicker for the first time.
      handler.raycastVR(ctx, RAY);
      ctx._vrPointPicker.getActors.mockReturnValue([hitActor]);
      ctx._vrPointPicker.getPointId.mockReturnValue(3); // -> coords[9..11] = [4,5,6]

      const result = handler.raycastVR(ctx, RAY); // default 'nearestVertex' mode
      expect(result).toMatchObject({
        hit: true,
        position: { x: 4, y: 5, z: 6 },
        pointId: 3,
        cellId: -1,
      });
    });

    it("resolves the exact-point position in WORLD space via the actor's matrix, not raw local coordinates", () => {
      // Regression test for the bug where _raycastExactPoint read
      // picker.getPickPosition() — which vtkPointPicker never populates on a
      // pick3DPoint() hit — instead of resolving the picked point itself.
      // A local point at the origin on an actor translated +10 on X must
      // come back as WORLD (10, 0, 0), not local (0, 0, 0) and not the
      // picker's stale [0, 0, 0] default.
      const ctx = makeVrContext();
      const actor = makeRealActorWithPoints([0, 0, 0]);
      actor.setPosition(10, 0, 0);

      handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" }); // prime cache
      ctx._vrPointPicker.getActors.mockReturnValue([actor]);
      ctx._vrPointPicker.getPointId.mockReturnValue(0);

      const result = handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" });
      expect(result).not.toBeNull();
      expect(result.position.x).toBeCloseTo(10);
      expect(result.position.y).toBeCloseTo(0);
      expect(result.position.z).toBeCloseTo(0);
    });

    it("returns null for 'exactPoint' when the resolved pointId can't be mapped to a real point", () => {
      const ctx = makeVrContext();
      const hitActor = ctx.sceneObjects.actor;
      hitActor.getMapper = () => ({
        getInputData: () => ({
          getPoints: () => ({ getNumberOfPoints: () => 2, getData: () => new Float32Array([0, 0, 0, 1, 1, 1]) }),
        }),
      });
      handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" }); // prime cache
      ctx._vrPointPicker.getActors.mockReturnValue([hitActor]);
      ctx._vrPointPicker.getPointId.mockReturnValue(7); // out of range (only 2 points)

      expect(handler.raycastVR(ctx, RAY, { selectionMode: "exactPoint" })).toBeNull();
    });

    it("does NOT fall back to exactPoint in 'surface' mode", () => {
      const ctx = makeVrContext();
      const pointCloudPolyData = { getNumberOfCells: () => 0 };
      const hitActor = ctx.sceneObjects.actor;
      hitActor.getMapper = () => ({ getInputData: () => pointCloudPolyData });

      handler.raycastVR(ctx, RAY); // creates _vrPicker
      ctx._vrPicker.getCellId.mockReturnValue(-1);

      expect(handler.raycastVR(ctx, RAY, { selectionMode: "surface" })).toBeNull();
    });
  });

  describe("actor classification and derived-actor pick filtering", () => {
    const instanceId = "raycast-classify-instance";

    beforeEach(() => {
      vtkGlyphFeature.instanceStates.delete(instanceId);
      vtkThresholdFeature.instanceStates.delete(instanceId);
    });

    it("_classifyVRActor identifies the source, a glyph actor, and an unrecognized actor", () => {
      const ctx = makeVrContext();
      ctx.instanceId = instanceId;
      const glyphActor = makeActor();
      const strangerActor = makeActor();
      vtkGlyphFeature.instanceStates.set(instanceId, { glyphActor });

      expect(handler._classifyVRActor(ctx, ctx.sceneObjects.actor)).toBe("source");
      expect(handler._classifyVRActor(ctx, glyphActor)).toBe("glyph");
      expect(handler._classifyVRActor(ctx, strangerActor)).toBe("unknown");
      expect(handler._classifyVRActor(ctx, null)).toBeNull();
    });

    it("_getVRPickTargets({excludeDerived: true}) excludes classified derived actors", () => {
      const ctx = makeVrContext();
      ctx.instanceId = instanceId;
      const glyphActor = makeActor();
      const thresholdActor = makeActor();
      vtkGlyphFeature.instanceStates.set(instanceId, { glyphActor });
      vtkThresholdFeature.instanceStates.set(instanceId, { thresholdActor });
      ctx.sceneObjects.renderer.getActors = () => [
        ctx.sceneObjects.actor,
        glyphActor,
        thresholdActor,
      ];

      const targets = handler._getVRPickTargets(ctx, { excludeDerived: true });
      expect(targets).toEqual([ctx.sceneObjects.actor]);
    });

    it("falls back to the unrestricted list if excluding derived actors would leave nothing pickable", () => {
      const ctx = makeVrContext();
      ctx.instanceId = instanceId;
      const glyphActor = makeActor();
      vtkGlyphFeature.instanceStates.set(instanceId, { glyphActor });
      // Source actor is hidden (e.g. threshold/isosurface toggled it off) —
      // only the glyph actor is actually pickable.
      ctx.sceneObjects.actor.getVisibility = () => false;
      ctx.sceneObjects.renderer.getActors = () => [ctx.sceneObjects.actor, glyphActor];

      const targets = handler._getVRPickTargets(ctx, { excludeDerived: true });
      expect(targets).toEqual([glyphActor]); // never goes pick-blind
    });

    it("raycastVR threads excludeDerivedActors through to _getVRPickTargets", () => {
      const ctx = makeVrContext();
      ctx.instanceId = instanceId;
      const glyphActor = makeActor();
      vtkGlyphFeature.instanceStates.set(instanceId, { glyphActor });
      ctx.sceneObjects.renderer.getActors = () => [ctx.sceneObjects.actor, glyphActor];

      handler.raycastVR(ctx, RAY, { excludeDerivedActors: true });
      expect(ctx._vrPicker.setPickList).toHaveBeenCalledWith([ctx.sceneObjects.actor]);
    });
  });
});
