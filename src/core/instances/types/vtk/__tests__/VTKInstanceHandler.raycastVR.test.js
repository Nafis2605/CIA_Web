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

/**
 * As above, but with polys too — required for cell picking, which intersects
 * triangles rather than consulting a picker.
 *
 * @param {number[]} points - flat xyz
 * @param {number[]} polys - vtk connectivity [n, i0, i1, ..., n, ...]
 */
function makeRealActorWithTriangles(points, polys) {
  const actor = makeRealActorWithPoints(points);
  actor.getMapper().getInputData().getPolys().setData(Int32Array.from(polys));
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

/** Data-space z the geometry fixture's quad sits at. */
const QUAD_Z = RAY_ORIGIN_IN_DATA_SPACE[2] - 5;

/**
 * A VR context whose pick target is a REAL quad with real polys, positioned so
 * the default RAY hits it dead centre in data space.
 *
 * Real geometry rather than a mocked picker: picking is now a direct
 * ray/triangle intersection (vr/vrRayPick.js), so a mock would assert nothing
 * about whether a trigger pull actually lands on the mesh — which is precisely
 * the failure that shipped.
 */
function makeGeometryVrContext(overrides = {}) {
  const [cx, cy] = RAY_ORIGIN_IN_DATA_SPACE;
  const actor = makeRealActorWithTriangles(
    [
      cx - 1, cy - 1, QUAD_Z,
      cx + 1, cy - 1, QUAD_Z,
      cx + 1, cy + 1, QUAD_Z,
      cx - 1, cy + 1, QUAD_Z,
    ],
    [3, 0, 1, 2, 3, 0, 2, 3]
  );
  return {
    dataBounds: [cx - 1, cx + 1, cy - 1, cy + 1, QUAD_Z, QUAD_Z],
    vrScale: 2,
    vrOrigin: [10, 20, 30],
    sceneObjects: { renderer: { getActors: () => [actor] }, actor },
    ...overrides,
  };
}

/**
 * Length of the ray raycastVR would cast for this context, i.e. |p2 - p1|.
 *
 * Read from _computeVRPickRayPoints directly. It used to be recovered from the
 * picker mock's call args, but picking no longer goes through a picker — and
 * the ray geometry is the part these tests are actually about.
 */
function pickRayLength(ctx, ray = RAY) {
  const { p1, p2 } = handlerForRay._computeVRPickRayPoints(
    ctx,
    ray.origin,
    ray.direction
  );
  return Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
}

/** Endpoints raycastVR would cast for this context. */
function pickRayPoints(ctx, ray = RAY) {
  const { p1, p2 } = handlerForRay._computeVRPickRayPoints(
    ctx,
    ray.origin,
    ray.direction
  );
  return [p1, p2];
}

/**
 * _computeVRPickRayPoints reads nothing off the instance, so one shared
 * handler is enough for the ray-geometry helpers above.
 */
const handlerForRay = new VTKInstanceHandler();

describe("VTKInstanceHandler.raycastVR", () => {
  let handler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new VTKInstanceHandler();
  });

  it("returns null when nothing is in the ray's path", () => {
    // A pick target with no geometry cannot be hit.
    expect(handler.raycastVR(makeVrContext(), RAY)).toBeNull();
  });

  it("returns a hit with data-space position and normal when a cell is picked", () => {
    const ctx = makeGeometryVrContext();
    const result = handler.raycastVR(ctx, RAY, { selectionMode: "surface" });

    expect(result).toMatchObject({ hit: true });
    expect(result.cellId).toBeGreaterThanOrEqual(0);
    // The quad sits at z = QUAD_Z in data space, centred on the ray.
    expect(result.position.x).toBeCloseTo(RAY_ORIGIN_IN_DATA_SPACE[0], 6);
    expect(result.position.y).toBeCloseTo(RAY_ORIGIN_IN_DATA_SPACE[1], 6);
    expect(result.position.z).toBeCloseTo(QUAD_Z, 6);
    // Facing back down +Z toward the controller.
    expect(Math.abs(result.normal.z)).toBeCloseTo(1, 6);

    // Distance is measured from the ray origin to the hit IN DATA SPACE — both
    // endpoints must be in the same space or this number is meaningless.
    const [ox, oy, oz] = RAY_ORIGIN_IN_DATA_SPACE; // w is not part of the metric
    expect(result.distance).toBeCloseTo(
      Math.hypot(result.position.x - ox, result.position.y - oy, result.position.z - oz)
    );
  });

  it("includes the instance's datasetId in the hit, or null when the instance is unknown", () => {
    const ctx = makeGeometryVrContext();
    ctx.instanceId = "instance-with-dataset";
    handler.instances.set("instance-with-dataset", { datasetId: "ds-42" });

    expect(handler.raycastVR(ctx, RAY).datasetId).toBe("ds-42");
    expect(handler.raycastVR(makeGeometryVrContext(), RAY).datasetId).toBeNull();
  });

  it("reports a MISS after a HIT rather than repeating the previous cell", () => {
    // The old picker-based path needed an explicit picker.initialize() for
    // this, because pick3DPoint skipped the reset that publicAPI.pick does and
    // a miss then reported the PREVIOUS pick's cellId — markers stuck to a
    // stale point. The intersector is stateless, so this holds structurally,
    // but the behaviour is still worth pinning.
    const ctx = makeGeometryVrContext();
    expect(handler.raycastVR(ctx, RAY)).not.toBeNull();
    expect(
      handler.raycastVR(ctx, {
        origin: RAY.origin,
        direction: { x: 0, y: 0, z: 1 }, // now pointing away
      })
    ).toBeNull();
  });

  it("reuses one cached acceleration structure per polydata instead of rebuilding per call", () => {
    const ctx = makeGeometryVrContext();
    const spy = vi.spyOn(handler, "_getPickAccel");

    handler.raycastVR(ctx, RAY);
    handler.raycastVR(ctx, RAY);
    handler.raycastVR(ctx, RAY);

    // raycastVR runs at least once per XR frame (~90 Hz) — rebuilding the
    // triangle grid every call would be steady allocation churn.
    expect(spy).toHaveBeenCalledTimes(3);
    const results = spy.mock.results.map((r) => r.value);
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  describe("ray length", () => {
    it("scales with dataBounds rather than using a fixed magic number", () => {
      // A ray must comfortably cross the dataset it is aimed at; a fixed
      // 1000-unit ray over a small dataset is mostly empty space, and one
      // shorter than a large dataset cannot reach the far side of it.
      const small = makeVrContext({ dataBounds: [0, 0.01, 0, 0.01, 0, 0.01] });
      const large = makeVrContext({ dataBounds: [0, 100, 0, 100, 0, 100] });

      expect(pickRayLength(large)).toBeGreaterThan(pickRayLength(small));
      expect(pickRayLength(small)).not.toBe(1000);
    });

    it("clamps to a usable minimum for degenerate (point-like) bounds", () => {
      expect(
        pickRayLength(makeVrContext({ dataBounds: [0, 0, 0, 0, 0, 0] }))
      ).toBeGreaterThanOrEqual(1);
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

    it("intersects only those targets", () => {
      // Scoping used to be expressed as picker.setPickList(); picking is now a
      // direct intersection, so the equivalent guarantee is that the resolved
      // target list is the only geometry consulted.
      const ctx = makeGeometryVrContext();
      const spy = vi.spyOn(handler, "_pickCellByRayVR");

      const result = handler.raycastVR(ctx, RAY);

      expect(result).not.toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toEqual([ctx.sceneObjects.actor]);
    });
  });

  describe("input normalisation", () => {
    it("accepts an XRRigidTransform, reading forward from its matrix -Z", () => {
      const ctx = makeVrContext();
      // Column-major identity: -Z forward is (-m[8], -m[9], -m[10]) = (0,0,-1).
      const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const result = handler.raycastVR(makeGeometryVrContext(), {
        position: { x: 0, y: 0, z: 0 },
        matrix,
      });

      expect(result).not.toBeNull();
      const [near, far] = pickRayPoints(ctx, {
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: -matrix[8], y: -matrix[9], z: -matrix[10] },
      });
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
      const [p1] = pickRayPoints(ctx, {
        origin: { x: 2, y: 4, z: -6 },
        direction: { x: 0, y: 0, z: -1 },
      });
      expect(p1).toEqual([11, 22, 27, 1.0]); // NOT the raw [2, 4, -6]
    });

    it("produces 4-component homogeneous endpoints (w = 1)", () => {
      // vtkPicker.pick3DPoint forwards these arrays to pick3DInternal WITHOUT
      // appending w (Picker.js:268-284), and pick3DInternal then does
      // vec4.transformMat4 followed by vec3.scale(p, p, 1 / p[3])
      // (Picker.js:103-106). A 3-element array makes w undefined -> NaN
      // everywhere -> getCellId() never leaves -1 -> raycastVR returns null on
      // every call. See the sibling integration test for the end-to-end proof.
      const [p1, p2] = pickRayPoints(makeVrContext());
      expect(p1).toHaveLength(4);
      expect(p2).toHaveLength(4);
      expect(p1[3]).toBe(1.0);
      expect(p2[3]).toBe(1.0);
    });

    it("leaves the ray DIRECTION unscaled — only the origin is transformed", () => {
      // The XR->data map is a uniform scale plus a translation, so a direction
      // maps to d/vrScale, which is the same unit vector. Dividing the
      // direction as well would be a plausible-looking over-correction that
      // silently shortens the ray by a factor of vrScale.
      const ctx = makeVrContext({ vrScale: 4, vrOrigin: [1, 2, 3] });
      const ray = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };
      const [p1, p2] = pickRayPoints(ctx, ray);
      const len = pickRayLength(ctx, ray);
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
    // Aim 0.8 off-centre so exactly one of the quad's four corners is nearest
    // — dead centre is equidistant from all four and the expected id would be
    // arbitrary.
    const OFF = 0.8;
    const OFFSET_RAY = {
      origin: { x: OFF * 2, y: OFF * 2, z: 0 }, // XR metres; vrScale is 2
      direction: { x: 0, y: 0, z: -1 },
    };

    it("resolves the nearest vertex of the hit triangle, and classifies the source actor", () => {
      const ctx = makeGeometryVrContext();
      const result = handler.raycastVR(ctx, OFFSET_RAY);

      // Corner index 2 is (cx+1, cy+1, QUAD_Z) — the nearest to the hit.
      expect(result.pointId).toBe(2);
      expect(result.actorRole).toBe("source");
    });

    it("snaps position to the resolved vertex's own coordinates, preserving the raw hit as surfacePosition", () => {
      // Regression test for the bug where `position` stayed the raw,
      // un-snapped intersection even though `pointId` names a specific
      // vertex — the two silently disagreed.
      const [cx, cy] = RAY_ORIGIN_IN_DATA_SPACE;
      const result = handler.raycastVR(makeGeometryVrContext(), OFFSET_RAY);

      expect(result.surfacePosition.x).toBeCloseTo(cx + OFF, 6);
      expect(result.surfacePosition.y).toBeCloseTo(cy + OFF, 6);
      expect(result.surfacePosition.z).toBeCloseTo(QUAD_Z, 6);

      // ...and position is the corner, which is NOT the surface hit, so a
      // regression back to the raw point is distinguishable.
      expect(result.position.x).toBeCloseTo(cx + 1, 6);
      expect(result.position.y).toBeCloseTo(cy + 1, 6);
      expect(result.position.z).toBeCloseTo(QUAD_Z, 6);
    });

    it("compares positions in a single consistent space (accounts for actor Position)", () => {
      // Regression test: the pre-fix code compared a WORLD-space pick position
      // directly against the polydata's raw LOCAL-space point coordinates.
      // Here the actor is translated +5 on every axis, so the geometry is
      // authored 5 short of where it renders — mixing the two spaces picks the
      // wrong vertex, or misses the actor altogether.
      const [cx, cy] = RAY_ORIGIN_IN_DATA_SPACE;
      const T = 5;
      const actor = makeRealActorWithTriangles(
        [
          cx - 1 - T, cy - 1 - T, QUAD_Z - T,
          cx + 1 - T, cy - 1 - T, QUAD_Z - T,
          cx + 1 - T, cy + 1 - T, QUAD_Z - T,
          cx - 1 - T, cy + 1 - T, QUAD_Z - T,
        ],
        [3, 0, 1, 2, 3, 0, 2, 3]
      );
      actor.setPosition(T, T, T);

      const ctx = {
        dataBounds: [cx - 1, cx + 1, cy - 1, cy + 1, QUAD_Z, QUAD_Z],
        vrScale: 2,
        vrOrigin: [10, 20, 30],
        sceneObjects: { renderer: { getActors: () => [actor] }, actor },
      };

      const result = handler.raycastVR(ctx, OFFSET_RAY);

      expect(result).not.toBeNull();
      expect(result.pointId).toBe(2);
      // Reported in WORLD space — the local corner plus the actor translation.
      expect(result.position.x).toBeCloseTo(cx + 1, 6);
      expect(result.position.y).toBeCloseTo(cy + 1, 6);
      expect(result.position.z).toBeCloseTo(QUAD_Z, 6);
    });

    it("returns pointId -1 with position falling back to the raw surface hit when vertex snapping is skipped", () => {
      const result = handler.raycastVR(makeGeometryVrContext(), OFFSET_RAY, {
        selectionMode: "surface",
      });
      expect(result.pointId).toBe(-1);
      expect(result.position).toEqual(result.surfacePosition);
    });

    it("returns null (not a throw) when the geometry can't be read at all", () => {
      // raycastVR runs inside the XR frame loop's blanket try/catch, so a
      // throw here is invisible except as tools that "do nothing" — the same
      // silent-failure shape this whole file exists to prevent.
      const brokenActor = {
        getPickable: () => true,
        getVisibility: () => true,
        getMapper: () => ({
          getInputData: () => ({
            getPoints: () => {
              throw new Error("boom");
            },
            getPolys: () => ({ getData: () => Int32Array.from([3, 0, 1, 2]) }),
          }),
        }),
      };
      const ctx = {
        dataBounds: [0, 1, 0, 1, 0, 1],
        vrScale: 2,
        vrOrigin: [10, 20, 30],
        sceneObjects: {
          renderer: { getActors: () => [brokenActor] },
          actor: brokenActor,
        },
      };

      expect(() => handler.raycastVR(ctx, OFFSET_RAY)).not.toThrow();
      expect(handler.raycastVR(ctx, OFFSET_RAY)).toBeNull();
    });
  });

  describe("selection modes", () => {
    it("'surface' mode returns the raw hit with pointId -1, skipping vertex-snapping entirely", () => {
      // Geometry that WOULD resolve a real pointId in 'nearestVertex' mode
      // (see the "pointId resolution" tests above) — proves 'surface' mode
      // deliberately skips snapping, not that it merely failed to resolve one.
      const ctx = makeGeometryVrContext();
      const offsetRay = {
        origin: { x: 1.6, y: 1.6, z: 0 },
        direction: { x: 0, y: 0, z: -1 },
      };
      expect(handler.raycastVR(ctx, offsetRay).pointId).toBeGreaterThanOrEqual(0);

      const result = handler.raycastVR(ctx, offsetRay, { selectionMode: "surface" });
      expect(result.hit).toBe(true);
      expect(result.pointId).toBe(-1);
      expect(result.cellId).toBeGreaterThanOrEqual(0);
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
      // Real points but NO polys: a point cloud has nothing to intersect, so
      // cell picking necessarily misses and the zero-cell fallback must take
      // over. _raycastExactPoint then resolves pointId 3 -> [4,5,6].
      const hitActor = makeRealActorWithPoints([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 5, 6,
      ]);
      const ctx = {
        dataBounds: [0, 1, 0, 1, 0, 1],
        vrScale: 2,
        vrOrigin: [10, 20, 30],
        sceneObjects: { renderer: { getActors: () => [hitActor] }, actor: hitActor },
      };

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
      // Same point cloud as the test above, which DOES fall back — the only
      // difference is the mode, so this pins the exclusion rather than a
      // coincidental miss.
      const hitActor = makeRealActorWithPoints([0, 0, 0, 4, 5, 6]);
      const ctx = {
        dataBounds: [0, 1, 0, 1, 0, 1],
        vrScale: 2,
        vrOrigin: [10, 20, 30],
        sceneObjects: { renderer: { getActors: () => [hitActor] }, actor: hitActor },
      };

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

      const spy = vi.spyOn(handler, "_getVRPickTargets");
      handler.raycastVR(ctx, RAY, { excludeDerivedActors: true });

      expect(spy).toHaveBeenCalledWith(ctx, { excludeDerived: true });
      expect(spy.mock.results[0].value).toEqual([ctx.sceneObjects.actor]);
    });
  });
});
