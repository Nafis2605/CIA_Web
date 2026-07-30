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
import { VTKInstanceHandler } from "../VTKInstanceHandler.js";

vi.mock("@kitware/vtk.js/Rendering/Core/CellPicker", () => {
  const newInstance = vi.fn(() => ({
    setTolerance: vi.fn(),
    setPickFromList: vi.fn(),
    setPickList: vi.fn(),
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

/** A pickable, visible, mapper-bearing actor (i.e. a legitimate pick target). */
function makeActor({ pickable = true, visible = true, mapper = {} } = {}) {
  return {
    getPickable: () => pickable,
    getVisibility: () => visible,
    getMapper: () => mapper,
  };
}

function makeVrContext({ actors = null, dataBounds = [0, 1, 0, 1, 0, 1] } = {}) {
  const dataActor = makeActor();
  return {
    dataBounds,
    sceneObjects: {
      renderer: { getActors: () => actors ?? [dataActor] },
      actor: dataActor,
    },
  };
}

const RAY = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } };

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
    expect(p1).toEqual([0, 0, 0]);
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
    expect(result.distance).toBeCloseTo(Math.hypot(1, 2, 3));
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
      const smallFar = small._vrPicker.pick3DPoint.mock.calls[0][1];
      handler.raycastVR(large, RAY);
      const largeFar = large._vrPicker.pick3DPoint.mock.calls[0][1];

      expect(Math.abs(largeFar[2])).toBeGreaterThan(Math.abs(smallFar[2]));
      expect(Math.abs(smallFar[2])).not.toBe(1000);
    });

    it("clamps to a usable minimum for degenerate (point-like) bounds", () => {
      const ctx = makeVrContext({ dataBounds: [0, 0, 0, 0, 0, 0] });
      handler.raycastVR(ctx, RAY);

      const far = ctx._vrPicker.pick3DPoint.mock.calls[0][1];
      expect(Math.abs(far[2])).toBeGreaterThanOrEqual(1);
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
      const far = ctx._vrPicker.pick3DPoint.mock.calls[0][1];
      expect(far[2]).toBeLessThan(0); // travelled along -Z
    });

    it("returns null for an unusable ray or missing sceneObjects", () => {
      expect(handler.raycastVR(makeVrContext(), null)).toBeNull();
      expect(handler.raycastVR({}, RAY)).toBeNull();
      expect(handler.raycastVR(makeVrContext(), {})).toBeNull();
    });
  });
});
