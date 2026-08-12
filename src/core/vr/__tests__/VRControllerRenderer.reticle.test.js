// src/core/vr/__tests__/VRControllerRenderer.reticle.test.js
// Hit-point reticle: shows at the raycast hit for ANY controller input type,
// hides on miss / missing raycast. Used to be Vision Pro (transient-pointer)
// only, on the assumption that a tracked controller's persistent ray line was
// "feedback enough" — it isn't, since that ray is drawn at a fixed length
// regardless of whether the raycast actually hits anything. A Quest user had
// no way to tell "will my trigger register here" before pulling it.
//
// Reticles are per-hand (see VRControllerRenderer.js's _reticles/
// _reticleSources maps): each hand's dot comes from THAT hand's own raycast,
// not a single shared reticle biased toward whichever hand used to win an
// old right-then-left preference.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRControllerRenderer } from "../VRControllerRenderer.js";

function makeRenderer() {
  const actors = [];
  return {
    addActor: vi.fn((a) => actors.push(a)),
    removeActor: vi.fn((a) => {
      const i = actors.indexOf(a);
      if (i >= 0) actors.splice(i, 1);
    }),
    _actors: actors,
  };
}

function transientInput(overrides = {}) {
  return {
    controllers: {
      right: {
        pose: {
          position: { x: 0, y: 1.5, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
        targetRay: { position: { x: 0, y: 1.5, z: 0 }, matrix: null },
        targetRayMode: "transient-pointer",
        triggerPressed: false,
        ...overrides,
      },
      left: null,
    },
    hands: {},
  };
}

/** Both hands tracked, each with its own controller/targetRay. */
function twoHandInput({ leftOverrides = {}, rightOverrides = {} } = {}) {
  return {
    controllers: {
      left: {
        pose: { position: { x: -1, y: 1.5, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
        targetRay: { position: { x: -1, y: 1.5, z: 0 }, matrix: null },
        targetRayMode: "tracked-pointer",
        triggerPressed: false,
        ...leftOverrides,
      },
      right: {
        pose: { position: { x: 1, y: 1.5, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
        targetRay: { position: { x: 1, y: 1.5, z: 0 }, matrix: null },
        targetRayMode: "tracked-pointer",
        triggerPressed: false,
        ...rightOverrides,
      },
    },
    hands: {},
  };
}

describe("VRControllerRenderer gaze reticle", () => {
  let renderer;

  beforeEach(() => {
    renderer = makeRenderer();
  });

  it("shows the reticle at the raycast hit for transient-pointer input", () => {
    const raycast = vi.fn(() => ({ hit: true, position: { x: 1, y: 2, z: 3 } }));
    const ctrl = new VRControllerRenderer(renderer, { vrScale: 1, raycast });

    ctrl.update(transientInput());

    expect(raycast).toHaveBeenCalled();
    expect(ctrl._reticles.right).not.toBeNull();
    expect(ctrl._reticles.right.getVisibility()).toBe(true);
    expect(ctrl._reticles.right.getPosition()).toEqual([1, 2, 3]);
  });

  it("hides the reticle on a raycast miss", () => {
    const raycast = vi.fn(() => null);
    const ctrl = new VRControllerRenderer(renderer, { vrScale: 1, raycast });

    ctrl.update(transientInput());
    expect(ctrl._reticles.right?.getVisibility() ?? false).toBe(false);
  });

  it("also shows the reticle at the raycast hit for tracked-pointer (Quest) controllers", () => {
    const raycast = vi.fn(() => ({ hit: true, position: { x: 1, y: 2, z: 3 } }));
    const ctrl = new VRControllerRenderer(renderer, { vrScale: 1, raycast });

    ctrl.update(transientInput({ targetRayMode: "tracked-pointer" }));

    expect(raycast).toHaveBeenCalled();
    expect(ctrl._reticles.right).not.toBeNull();
    expect(ctrl._reticles.right.getVisibility()).toBe(true);
    expect(ctrl._reticles.right.getPosition()).toEqual([1, 2, 3]);
  });

  it("hides the reticle on a raycast miss for a tracked-pointer controller too", () => {
    const raycast = vi.fn(() => null);
    const ctrl = new VRControllerRenderer(renderer, { vrScale: 1, raycast });

    ctrl.update(transientInput({ targetRayMode: "tracked-pointer" }));
    expect(ctrl._reticles.right?.getVisibility() ?? false).toBe(false);
  });

  it("does nothing without an injected raycast", () => {
    const ctrl = new VRControllerRenderer(renderer, { vrScale: 1 });
    expect(() => ctrl.update(transientInput())).not.toThrow();
    expect(ctrl._reticles.right).toBeNull();
  });

  it("scales the reticle by 1/vrScale and survives a throwing raycast", () => {
    const raycast = vi
      .fn()
      .mockImplementationOnce(() => ({ hit: true, position: { x: 0, y: 0, z: 0 } }))
      .mockImplementationOnce(() => {
        throw new Error("picker exploded");
      });
    const ctrl = new VRControllerRenderer(renderer, { vrScale: 2, raycast });

    ctrl.update(transientInput());
    expect(ctrl._reticles.right.getScale()[0]).toBeCloseTo(0.005);

    expect(() => ctrl.update(transientInput())).not.toThrow();
    expect(ctrl._reticles.right.getVisibility()).toBe(false);
  });

  it("dispose removes the reticle actor", () => {
    const raycast = vi.fn(() => ({ hit: true, position: { x: 0, y: 0, z: 0 } }));
    const ctrl = new VRControllerRenderer(renderer, { vrScale: 1, raycast });
    ctrl.update(transientInput());
    const reticle = ctrl._reticles.right;

    ctrl.dispose();
    expect(renderer.removeActor).toHaveBeenCalledWith(reticle);
    expect(ctrl._reticles.right).toBeNull();
  });

  describe("per-hand independence", () => {
    it("shows both hands' dots at their own hand's hit when both hit different points", () => {
      const raycast = vi.fn((targetRay) => {
        // Distinguish by origin x: left controller is at x=-1, right at x=1.
        return targetRay.position.x < 0
          ? { hit: true, position: { x: -5, y: 0, z: 0 } }
          : { hit: true, position: { x: 5, y: 0, z: 0 } };
      });
      const ctrl = new VRControllerRenderer(renderer, { vrScale: 1, raycast });

      ctrl.update(twoHandInput());

      expect(ctrl._reticles.left.getVisibility()).toBe(true);
      expect(ctrl._reticles.left.getPosition()).toEqual([-5, 0, 0]);
      expect(ctrl._reticles.right.getVisibility()).toBe(true);
      expect(ctrl._reticles.right.getPosition()).toEqual([5, 0, 0]);
    });

    it("shows only the hitting hand's dot when one hand hits and the other misses", () => {
      const raycast = vi.fn((targetRay) =>
        targetRay.position.x < 0 ? { hit: true, position: { x: -5, y: 0, z: 0 } } : null
      );
      const ctrl = new VRControllerRenderer(renderer, { vrScale: 1, raycast });

      ctrl.update(twoHandInput());

      expect(ctrl._reticles.left.getVisibility()).toBe(true);
      expect(ctrl._reticles.right?.getVisibility() ?? false).toBe(false);
    });
  });
});
