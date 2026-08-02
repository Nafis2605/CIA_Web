// src/core/vr/navigation/__tests__/VRFlyMode.test.js
// Regression coverage for the two composing sign errors that made the fly
// joystick move the user the wrong way:
//   1. `_getMovementInput` used to negate the (already-deadzoned) thumbstick
//      Y axis into z. WebXR axes[3] is already negative on a forward push,
//      and WebXR "forward" is -Z, so the value should pass through
//      unnegated.
//   2. `_transformByOrientation` hand-rolled Ry(-yaw) instead of the repo's
//      shared Ry(+yaw) convention (vrPlaneMath.yawRotateVector).
// Also covers: the per-axis deadzone rejecting off-axis diagonal pushes
// (replaced with a radial deadzone), and frame-rate-independent velocity
// smoothing (replaced per-frame smoothing with an exponential dt-correct
// form).
import { describe, it, expect, vi } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRFlyMode } from "../VRFlyMode.js";

/** Pure yaw quaternion for angle t (radians), Y-up. */
function yawQuat(t) {
  return { x: 0, y: Math.sin(t / 2), z: 0, w: Math.cos(t / 2) };
}

function makeFly(options = {}) {
  const vrContext = { vrScale: 1.0, vrOrigin: [0, 0, 0] };
  const fly = new VRFlyMode(vrContext, options);
  fly.activate();
  return { fly, vrContext };
}

/** Left-controller input with a given thumbstick and head yaw. */
function stickInput(yaw, { x = 0, y = 0 } = {}) {
  return {
    headPose: { orientation: yawQuat(yaw) },
    controllers: {
      left: {
        thumbstick: { x, y },
        buttons: { a: false, b: false },
        squeezeValue: 0,
      },
    },
  };
}

/**
 * Run several frames, feeding the returned ABSOLUTE position back into
 * vrContext.vrOrigin each frame — exactly what VRExplorationManager._onFrame
 * does in production (see VRFlyMode.update's doc comment: it returns
 * vrOrigin + this-frame's delta only, not an internally-accumulated
 * position). Without writing the result back as the next frame's origin,
 * position would never accumulate across frames — each call would just
 * re-add a single frame's delta to the same starting origin.
 * Returns the final absolute position.
 */
function runFrames(fly, vrContext, input, frames, dt) {
  let result;
  for (let i = 0; i < frames; i++) {
    result = fly.update(input, {}, dt);
    vrContext.vrOrigin = [result.position.x, result.position.y, result.position.z];
  }
  return result.position;
}

describe("VRFlyMode — thumbstick sign + orientation transform", () => {
  it("yaw 0, stick forward (y=-1) => movement along -Z, ~zero X", () => {
    const { fly, vrContext } = makeFly();
    const finalPos = runFrames(fly, vrContext, stickInput(0, { y: -1 }), 20, 0.016);
    expect(finalPos.z).toBeLessThan(0);
    expect(finalPos.x).toBeCloseTo(0, 6);
  });

  it("yaw +PI/2, stick forward (y=-1) => movement along -X", () => {
    const { fly, vrContext } = makeFly();
    const finalPos = runFrames(fly, vrContext, stickInput(Math.PI / 2, { y: -1 }), 20, 0.016);
    expect(finalPos.x).toBeLessThan(0);
  });

  it("yaw 0, stick right (x=+1) => movement along +X, ~zero Z", () => {
    const { fly, vrContext } = makeFly();
    const finalPos = runFrames(fly, vrContext, stickInput(0, { x: 1 }), 20, 0.016);
    expect(finalPos.x).toBeGreaterThan(0);
    expect(finalPos.z).toBeCloseTo(0, 6);
  });

  // NOTE: per the shared Ry(+yaw) convention used by _transformByOrientation
  // (vrPlaneMath.yawRotateVector — see its doc comment, which verifies
  // yawRotateVector([1,0,0], Math.PI/2) === [0,0,-1]), a +X strafe rotated by
  // yaw=+PI/2 lands on -Z, not +Z. This is the mathematically consistent
  // result given the code in items 1-2 of the plan (confirmed by the
  // yaw=0/forward and yaw=+PI/2/forward cases above, which use the same
  // transform) — flagged in the report as a discrepancy against the task's
  // draft test description, which stated +Z.
  it("yaw +PI/2, stick right (x=+1) => movement along -Z", () => {
    const { fly, vrContext } = makeFly();
    const finalPos = runFrames(fly, vrContext, stickInput(Math.PI / 2, { x: 1 }), 20, 0.016);
    expect(finalPos.z).toBeLessThan(0);
  });

  it("radial deadzone: diagonal push (0.14, 0.14) with deadzone 0.15 now moves (hypot 0.198 > 0.15)", () => {
    const { fly } = makeFly({ deadzone: 0.15 });
    const input = fly._getMovementInput({
      thumbstick: { x: 0.14, y: 0.14 },
      buttons: {},
      squeezeValue: 0,
    });
    // Old per-axis deadzone rejected this entirely (both axes < 0.15).
    expect(input.x).not.toBe(0);
    expect(input.z).not.toBe(0);
    // Continuity: just above the deadzone boundary, the rescaled magnitude
    // should be small, not snapped to ~full value.
    const mag = Math.hypot(input.x, input.z);
    expect(mag).toBeGreaterThan(0);
    expect(mag).toBeLessThan(0.1);
  });

  it("a sub-threshold push (0.05, 0.05, hypot ~0.07 < deadzone) still produces no movement", () => {
    const { fly } = makeFly({ deadzone: 0.15 });
    const input = fly._getMovementInput({
      thumbstick: { x: 0.05, y: 0.05 },
      buttons: {},
      squeezeValue: 0,
    });
    expect(input.x).toBe(0);
    expect(input.z).toBe(0);
  });

  it("A1 regression guard: a worn-stick diagonal rest (0.12, 0.12), hypot ~0.1697, produces EXACTLY zero movement at deadzone 0.2", () => {
    const { fly } = makeFly();
    const input = fly._getMovementInput({
      thumbstick: { x: 0.12, y: 0.12 },
      buttons: {},
      squeezeValue: 0,
    });
    expect(input.x).toBe(0);
    expect(input.z).toBe(0);
  });

  it("A1: a clearly-intentional push (0.5, 0.5) still moves at deadzone 0.2", () => {
    const { fly } = makeFly();
    const input = fly._getMovementInput({
      thumbstick: { x: 0.5, y: 0.5 },
      buttons: {},
      squeezeValue: 0,
    });
    expect(input.x).toBeGreaterThan(0);
    expect(input.z).toBeGreaterThan(0);
  });

  it("dt-invariance: integrating constant input for 1s at 1/72s vs 1/90s steps yields displacement within ~2%", () => {
    const { fly: fly72, vrContext: ctx72 } = makeFly();
    const { fly: fly90, vrContext: ctx90 } = makeFly();

    const steps72 = 72;
    const steps90 = 90;

    const pos72 = runFrames(fly72, ctx72, stickInput(0, { y: -1 }), steps72, 1 / 72);
    const pos90 = runFrames(fly90, ctx90, stickInput(0, { y: -1 }), steps90, 1 / 90);

    const disp72 = Math.abs(pos72.z);
    const disp90 = Math.abs(pos90.z);

    expect(disp72).toBeGreaterThan(0);
    expect(disp90).toBeGreaterThan(0);
    const ratio = disp72 / disp90;
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.02);
  });
});

describe("VRFlyMode — A8 idle deadband", () => {
  it("with zero stick input, after enough frames the returned position becomes null and update() does not throw", () => {
    const { fly, vrContext } = makeFly();
    const zeroInput = stickInput(0, { x: 0, y: 0 });

    let result;
    // First frame or two may still report a tiny non-null position while the
    // (already-zero-targeted) velocity decays across the idle threshold; run
    // enough frames for it to settle to exactly zero and return null.
    for (let i = 0; i < 30; i++) {
      expect(() => {
        result = fly.update(zeroInput, {}, 0.016);
      }).not.toThrow();
      if (result.position === null) break;
      vrContext.vrOrigin = [result.position.x, result.position.y, result.position.z];
    }

    expect(result.position).toBeNull();
    expect(result.orientation).toBeNull();
    expect(result.isBoosting).toBe(false);
    expect(result.speed).toBe(0);
  });

  it("releasing the stick after moving eventually settles to a null position (velocity decays through the idle threshold)", () => {
    const { fly, vrContext } = makeFly();

    // Get moving.
    for (let i = 0; i < 10; i++) {
      const result = fly.update(stickInput(0, { y: -1 }), {}, 0.016);
      vrContext.vrOrigin = [result.position.x, result.position.y, result.position.z];
    }

    // Release the stick and let velocity decay to exactly zero.
    let result;
    const zeroInput = stickInput(0, { x: 0, y: 0 });
    for (let i = 0; i < 200; i++) {
      result = fly.update(zeroInput, {}, 0.016);
      if (result.position === null) break;
      vrContext.vrOrigin = [result.position.x, result.position.y, result.position.z];
    }

    expect(result.position).toBeNull();
  });
});
