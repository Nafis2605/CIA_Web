// Unit tests for the two-hand scale + twist gesture (Apple Vision Pro pinch).
import { describe, it, expect } from "vitest";
import { VRScaleController } from "../VRScaleController.js";

// A gripless (transient-pointer) hand: pinch shows up as triggerPressed, and
// squeezeValue is always 0 — the exact profile that used to make scaling
// impossible before the trigger-based detection.
function pinchHand(pos, pressed = true) {
  return {
    pose: { position: pos },
    triggerPressed: pressed,
    squeezeValue: 0,
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
    // With default smoothing 0.8, one step moves 20% of the way: 1 + (0.5-1)*0.2.
    const res = c.update(
      input(pinchHand({ x: -0.4, y: 0, z: 0 }), pinchHand({ x: 0.4, y: 0, z: 0 })),
      0.016
    );
    expect(res.newScale).toBeCloseTo(0.9, 5);
    expect(ctx.vrScale).toBeCloseTo(0.9, 5);
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
