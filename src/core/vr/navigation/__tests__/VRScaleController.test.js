// Unit tests for the two-hand scale + twist gesture (Apple Vision Pro pinch).
import { describe, it, expect } from "vitest";
import { VRScaleController } from "../VRScaleController.js";

// A gripless (transient-pointer) hand: pinch shows up as triggerPressed, and
// squeezeValue is always 0 — the exact profile that used to make scaling
// impossible before the trigger-based detection. isTransientPointer: true is
// what _isEngaged now uses to route to the trigger-based check (A2a) instead
// of treating this as a tracked controller with squeeze always 0 (never
// engaged).
function pinchHand(pos, pressed = true) {
  return {
    pose: { position: pos },
    triggerPressed: pressed,
    squeezeValue: 0,
    isTransientPointer: true,
  };
}

// A Quest 2 tracked controller: no isTransientPointer, engages via squeeze
// only (grip button), independent of triggerPressed (trigger is the
// object-move gesture on tracked controllers, see VRExplorationManager).
function trackedHand(pos, { squeezeValue = 0, triggerPressed = false } = {}) {
  return {
    pose: { position: pos },
    triggerPressed,
    squeezeValue,
  };
}

function input(left, right) {
  return { controllers: { left, right } };
}

describe("VRScaleController — two-hand pinch gesture", () => {
  it("does not scale or rotate with only one hand pinching", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    const res = c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), null),
      0.016
    );
    expect(res.scaling).toBe(false);
  });

  it("triggers on two pinches even though squeezeValue is 0 (Vision Pro)", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    const res = c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), pinchHand({ x: 0.2, y: 0, z: 0 })),
      0.016
    );
    expect(res.scaling).toBe(true);
    expect(res.rotating).toBe(true);
  });

  it("pulling the hands apart changes scale by the distance ratio", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    // Frame 1: anchor at 0.4 m apart.
    c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), pinchHand({ x: 0.2, y: 0, z: 0 })),
      0.016
    );
    // Frame 2: hands 0.8 m apart (ratio 2) → targetScale = initial / 2 = 0.5.
    // Smoothing is dt-correct exponential (alpha = 1 - e^(-dt/tau)), not a
    // per-frame factor, so the step size is derived from dt rather than
    // hard-coded — that's the whole point of the tau form, and hard-coding
    // the result here would just re-freeze the frame-rate dependence.
    const alpha = 1 - Math.exp(-0.016 / 0.0622);
    const expected = 1 + (0.5 - 1) * alpha;
    const res = c.update(
      input(pinchHand({ x: -0.4, y: 0, z: 0 }), pinchHand({ x: 0.4, y: 0, z: 0 })),
      0.016
    );
    expect(res.newScale).toBeCloseTo(expected, 5);
    expect(ctx.vrScale).toBeCloseTo(expected, 5);
  });

  it("twisting the handlebar accumulates yaw onto vrRotation", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    // Anchor: hands aligned on X (heading atan2(dx=0.4, dz=0) = +π/2).
    c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), pinchHand({ x: 0.2, y: 0, z: 0 })),
      0.016
    );
    // Twist so the vector points along +Z (heading atan2(0, 0.4) = 0):
    // deltaAngle = 0 - π/2 = -π/2.
    const res = c.update(
      input(pinchHand({ x: 0, y: 0, z: -0.2 }), pinchHand({ x: 0, y: 0, z: 0.2 })),
      0.016
    );
    expect(res.newRotation).toBeCloseTo(-Math.PI / 2, 5);
    expect(ctx.vrRotation).toBeCloseTo(-Math.PI / 2, 5);
  });

  it("ends the gesture and stops reporting scaling when a hand releases", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), pinchHand({ x: 0.2, y: 0, z: 0 })),
      0.016
    );
    const res = c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), pinchHand({ x: 0.2, y: 0, z: 0 }, false)),
      0.016
    );
    expect(res.scaling).toBe(false);
    expect(c.isScaling()).toBe(false);
  });
});

describe("VRScaleController — A2a platform gate (tracked controller vs transient pointer)", () => {
  it("does NOT engage when two tracked (non-transient-pointer) controllers pull both triggers with squeezeValue 0", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    const res = c.update(
      input(
        trackedHand({ x: -0.2, y: 0, z: 0 }, { triggerPressed: true, squeezeValue: 0 }),
        trackedHand({ x: 0.2, y: 0, z: 0 }, { triggerPressed: true, squeezeValue: 0 })
      ),
      0.016
    );
    expect(res.scaling).toBe(false);
    expect(c.isScaling()).toBe(false);
  });

  it("engages when two tracked controllers squeeze past gripThreshold (0.7)", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    const res = c.update(
      input(
        trackedHand({ x: -0.2, y: 0, z: 0 }, { squeezeValue: 0.8 }),
        trackedHand({ x: 0.2, y: 0, z: 0 }, { squeezeValue: 0.8 })
      ),
      0.016
    );
    expect(res.scaling).toBe(true);
  });

  it("engages when a transient-pointer source pulls both triggers", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    const res = c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), pinchHand({ x: 0.2, y: 0, z: 0 })),
      0.016
    );
    expect(res.scaling).toBe(true);
  });
});

describe("VRScaleController — A2b squeeze hysteresis", () => {
  it("stays engaged when squeeze drops to 0.5 (below 0.7 engage, above 0.4 release), and ends at 0.3", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);

    // Engage both hands above gripThreshold.
    let res = c.update(
      input(
        trackedHand({ x: -0.2, y: 0, z: 0 }, { squeezeValue: 0.8 }),
        trackedHand({ x: 0.2, y: 0, z: 0 }, { squeezeValue: 0.8 })
      ),
      0.016
    );
    expect(res.scaling).toBe(true);

    // Drop to 0.5 — between release (0.4) and engage (0.7). Should stay engaged.
    res = c.update(
      input(
        trackedHand({ x: -0.2, y: 0, z: 0 }, { squeezeValue: 0.5 }),
        trackedHand({ x: 0.2, y: 0, z: 0 }, { squeezeValue: 0.5 })
      ),
      0.016
    );
    expect(res.scaling).toBe(true);
    expect(c.isScaling()).toBe(true);

    // Drop to 0.3 — below release threshold. Gesture should end.
    res = c.update(
      input(
        trackedHand({ x: -0.2, y: 0, z: 0 }, { squeezeValue: 0.3 }),
        trackedHand({ x: 0.2, y: 0, z: 0 }, { squeezeValue: 0.3 })
      ),
      0.016
    );
    expect(res.scaling).toBe(false);
    expect(c.isScaling()).toBe(false);
  });
});

describe("VRScaleController — A2c incremental twist + separation guards", () => {
  it("accumulates twist past +/-180 degrees monotonically instead of wrapping", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);
    const radius = 0.3; // hand separation well above MIN_TWIST_SEPARATION_M (0.15)

    // Anchor the gesture at theta=0 in the same parameterization used by the
    // sweep below (z-aligned hands => currentAngle = atan2(0, 2r) = 0), so
    // the accumulated rotation directly tracks theta from the start.
    c.update(
      input(
        pinchHand({ x: 0, y: 0, z: -radius }),
        pinchHand({ x: 0, y: 0, z: radius })
      ),
      0.016
    );

    // Sweep the handlebar heading through many small steps, well past a full
    // +/-180 degree turn from the start heading, and confirm the accumulated
    // rotation increases monotonically (no snap-back / sign flip at the seam).
    const steps = 40;
    let prevRotation = 0;
    let sawIncrease = false;
    for (let i = 1; i <= steps; i++) {
      // Sweep angle theta from just past 0 up through > 2*PI worth of
      // heading change (parameterized so consecutive steps are small).
      const theta = (i / steps) * 3 * Math.PI; // 3*PI total sweep
      const x = radius * Math.sin(theta);
      const z = radius * Math.cos(theta);
      const res = c.update(
        input(
          pinchHand({ x: -x, y: 0, z: -z }),
          pinchHand({ x, y: 0, z })
        ),
        0.016
      );
      if (i > 1) {
        expect(res.newRotation).toBeGreaterThan(prevRotation - 0.5); // no full-turn snap-back
        if (res.newRotation > prevRotation) sawIncrease = true;
      }
      prevRotation = res.newRotation;
    }
    // Total accumulated rotation should reflect the full sweep, i.e. exceed
    // a single +/-PI wrap boundary — proof the frozen-baseline wrap is gone.
    expect(Math.abs(prevRotation)).toBeGreaterThan(Math.PI);
    expect(sawIncrease).toBe(true);
  });

  it("hands closer than MIN_TWIST_SEPARATION_M (0.15m) produce no rotation change", () => {
    const ctx = { vrScale: 1, vrRotation: 0 };
    const c = new VRScaleController(ctx);

    // Anchor at a safe separation.
    c.update(
      input(pinchHand({ x: -0.2, y: 0, z: 0 }), pinchHand({ x: 0.2, y: 0, z: 0 })),
      0.016
    );

    // Bring hands to within 0.1m (below the 0.15m twist guard) while also
    // changing heading — rotation must not move even though scale still
    // tracks distance.
    const res = c.update(
      input(pinchHand({ x: -0.05, y: 0, z: 0 }), pinchHand({ x: 0.05, y: 0, z: 0.02 })),
      0.016
    );
    expect(res.newRotation).toBe(0);
    expect(ctx.vrRotation).toBe(0);
  });
});
