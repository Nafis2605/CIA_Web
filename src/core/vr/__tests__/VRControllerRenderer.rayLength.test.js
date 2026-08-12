// src/core/vr/__tests__/VRControllerRenderer.rayLength.test.js
// The visible controller laser used to always draw at a fixed 5m length
// regardless of what raycastVR actually hit — so a ray visibly passing
// through the model didn't mean the picker missed, and there was no visual
// feedback about where a trigger pull would register. It now terminates at
// (or short of) the per-hand raycast hit distance, and tints hit vs miss.
import { describe, it, expect, vi } from "vitest";

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

// Forward direction is [-matrix[8], -matrix[9], -matrix[10]]; only those
// three matrix slots matter here — set them so forward is -Z, matching a
// controller aimed straight ahead.
const FORWARD_MINUS_Z_MATRIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function rightHandInput({ triggerPressed = false } = {}) {
  return {
    controllers: {
      right: {
        pose: { position: { x: 0, y: 1.5, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
        targetRay: { position: { x: 0, y: 1.5, z: 0 }, matrix: FORWARD_MINUS_Z_MATRIX },
        targetRayMode: "tracked-pointer",
        triggerPressed,
      },
      left: null,
    },
    hands: {},
  };
}

describe("VRControllerRenderer — ray terminates at the hit distance", () => {
  it("terminates the ray at the hit distance when a hit is supplied (shorter than the max)", () => {
    const raycast = vi.fn(() => ({ hit: true, position: { x: 0, y: 1.5, z: -2 }, distance: 2 }));
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 1, raycast });

    ctrl.update(rightHandInput());

    const [x, y, z] = ctrl._raySources.right.getPoint2();
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1.5);
    expect(z).toBeCloseTo(-2); // NOT the fixed -5
  });

  it("clamps to the fixed max length on a hit farther than the max (never extends the ray)", () => {
    const raycast = vi.fn(() => ({ hit: true, position: { x: 0, y: 1.5, z: -50 }, distance: 50 }));
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 1, raycast });

    ctrl.update(rightHandInput());

    const [, , z] = ctrl._raySources.right.getPoint2();
    expect(z).toBeCloseTo(-5); // clamped to the 5m default max
  });

  it("stays at the fixed max length on a miss", () => {
    const raycast = vi.fn(() => null);
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 1, raycast });

    ctrl.update(rightHandInput());

    const [, , z] = ctrl._raySources.right.getPoint2();
    expect(z).toBeCloseTo(-5);
  });

  it("scales the max length by 1/vrScale, same as before this fix", () => {
    const raycast = vi.fn(() => null);
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 2, raycast });

    ctrl.update(rightHandInput());

    const [, , z] = ctrl._raySources.right.getPoint2();
    expect(z).toBeCloseTo(-2.5); // 5m / vrScale(2)
  });

  it("does not double-apply vrScale to an already-scene-space hit distance", () => {
    // Regression guard for the unit-conversion pitfall: hit.distance is
    // scene-space already: at vrScale=2 with a hit.distance of 1 (scene
    // units), the ray must end at scene z=-1, NOT z=-0.5 (which would result
    // from wrongly dividing hit.distance by vrScale again).
    const raycast = vi.fn(() => ({ hit: true, position: { x: 0, y: 1.5, z: -1 }, distance: 1 }));
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 2, raycast });

    ctrl.update(rightHandInput());

    const [, , z] = ctrl._raySources.right.getPoint2();
    expect(z).toBeCloseTo(-1);
  });

  it("tints the ray with the hit-highlight color on a hit", () => {
    const raycast = vi.fn(() => ({ hit: true, position: { x: 0, y: 1.5, z: -2 }, distance: 2 }));
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 1, raycast });

    ctrl.update(rightHandInput());

    expect(ctrl._pointerRays.right.getProperty().getColor()).toEqual(ctrl._colors.rightHighlight);
  });

  it("keeps the base color on a miss", () => {
    const raycast = vi.fn(() => null);
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 1, raycast });

    ctrl.update(rightHandInput());

    expect(ctrl._pointerRays.right.getProperty().getColor()).toEqual(ctrl._colors.right);
  });

  it("each hand's ray reflects its OWN hit independently", () => {
    const raycast = vi.fn((targetRay) =>
      targetRay.position.x < 0
        ? { hit: true, position: { x: -1, y: 1.5, z: 0 }, distance: 1 }
        : null
    );
    const ctrl = new VRControllerRenderer(makeRenderer(), { vrScale: 1, raycast });

    ctrl.update({
      controllers: {
        left: {
          pose: { position: { x: -1, y: 1.5, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          targetRay: { position: { x: -1, y: 1.5, z: 0 }, matrix: FORWARD_MINUS_Z_MATRIX },
          triggerPressed: false,
        },
        right: {
          pose: { position: { x: 1, y: 1.5, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          targetRay: { position: { x: 1, y: 1.5, z: 0 }, matrix: FORWARD_MINUS_Z_MATRIX },
          triggerPressed: false,
        },
      },
      hands: {},
    });

    expect(ctrl._pointerRays.left.getProperty().getColor()).toEqual(ctrl._colors.leftHighlight);
    expect(ctrl._pointerRays.right.getProperty().getColor()).toEqual(ctrl._colors.right);
    const [, , leftZ] = ctrl._raySources.left.getPoint2();
    const [, , rightZ] = ctrl._raySources.right.getPoint2();
    expect(leftZ).toBeCloseTo(-1); // hit -> z = origin(0) + forward(-1)*distance(1)
    expect(rightZ).toBeCloseTo(-5); // miss -> fixed max
  });
});
