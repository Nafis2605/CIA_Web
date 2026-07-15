// src/core/vr/navigation/__tests__/VRGrabMode.test.js
// Grab locomotion: pinch-and-drag pulls the data around by shifting vrOrigin.
// The grabbed data point must track the hand exactly, so the origin moves by
// -delta/vrScale (see the sign derivation in VRGrabMode.js).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRGrabMode } from "../VRGrabMode.js";

/** Build an input state with a right-hand pose + trigger. */
function rightHand(x, y, z, pressed) {
  return {
    controllers: {
      left: null,
      right: { pose: { position: { x, y, z } }, triggerPressed: pressed },
    },
  };
}

describe("VRGrabMode", () => {
  let ctx;
  let mode;

  beforeEach(() => {
    ctx = { vrScale: 1.0, vrOrigin: [0, 0, 0] };
    mode = new VRGrabMode(ctx);
  });

  it("does nothing without a controller", () => {
    const r = mode.update({ controllers: {} });
    expect(r.position).toBeNull();
    expect(r.grabEnded).toBeFalsy();
    expect(mode.isGrabbing()).toBe(false);
  });

  it("no locomotion before the pinch (idle)", () => {
    const r = mode.update(rightHand(0, 0, 0, false));
    expect(r.position).toBeNull();
    expect(mode.isGrabbing()).toBe(false);
  });

  it("rising edge anchors the grab; first frame does not move the origin", () => {
    ctx.vrOrigin = [10, 10, 10];
    const r = mode.update(rightHand(1, 2, 3, true));
    expect(mode.isGrabbing()).toBe(true);
    expect(r.position).toEqual({ x: 10, y: 10, z: 10 });
  });

  it("drag shifts vrOrigin by -delta/scale (scale = 1) so the grabbed point tracks the hand", () => {
    mode.update(rightHand(0, 0, 0, true)); // anchor at origin [0,0,0]
    // Pull the hand toward the chest (+z) and sideways/up a little.
    const r = mode.update(rightHand(0.5, 0.25, 0.5, true));
    expect(r.position.x).toBeCloseTo(-0.5, 6);
    expect(r.position.y).toBeCloseTo(-0.25, 6);
    expect(r.position.z).toBeCloseTo(-0.5, 6);
  });

  it("full 3-axis drag from a non-zero start origin", () => {
    ctx.vrOrigin = [10, 10, 10];
    mode.update(rightHand(1, 2, 3, true)); // anchor: hand (1,2,3), origin [10,10,10]
    const r = mode.update(rightHand(1.5, 2.25, 3.5, true)); // delta (0.5,0.25,0.5)
    expect(r.position.x).toBeCloseTo(9.5, 6);
    expect(r.position.y).toBeCloseTo(9.75, 6);
    expect(r.position.z).toBeCloseTo(9.5, 6);
  });

  it("vrScale = 2 halves the origin delta (gesture stays 1:1 in physical space)", () => {
    ctx.vrScale = 2.0;
    mode.update(rightHand(0, 0, 0, true)); // anchor
    const r = mode.update(rightHand(0, 0, 1, true)); // delta.z = 1
    expect(r.position.z).toBeCloseTo(-0.5, 6); // -1 / 2
  });

  it("falling edge ends the grab, emits grabEnded once, and holds the last pose", () => {
    mode.update(rightHand(0, 0, 0, true));
    const dragged = mode.update(rightHand(0, 0, 1, true)); // origin.z = -1
    expect(dragged.position.z).toBeCloseTo(-1, 6);

    const released = mode.update(rightHand(0, 0, 1, false));
    expect(released.grabEnded).toBe(true);
    expect(released.position.z).toBeCloseTo(-1, 6); // last computed origin
    expect(mode.isGrabbing()).toBe(false);

    // A subsequent idle frame is a plain no-op (grabEnded fires only once).
    const after = mode.update(rightHand(0, 0, 1, false));
    expect(after.grabEnded).toBeFalsy();
    expect(after.position).toBeNull();
  });

  it("pose loss while grabbing ends the grab (grabEnded, hold last)", () => {
    mode.update(rightHand(0, 0, 0, true));
    mode.update(rightHand(0, 0, 2, true)); // origin.z = -2
    // Trigger still 'pressed' but the hand pose vanished.
    const r = mode.update({ controllers: { right: { triggerPressed: true } } });
    expect(r.grabEnded).toBe(true);
    expect(r.position.z).toBeCloseTo(-2, 6);
    expect(mode.isGrabbing()).toBe(false);
  });

  it("re-anchors after a suppressed frame instead of jumping", () => {
    mode.update(rightHand(0, 0, 0, true)); // anchor: hand (0,0,0), origin [0,0,0]
    mode.update(rightHand(0, 0, 1, true)); // origin.z = -1

    // Two-hand scale suppressed this frame; meanwhile vrOrigin/scale moved.
    mode.onFrameSkipped();
    ctx.vrOrigin = [5, 5, 5];

    // Resume with the hand somewhere new: must re-anchor to (0,0,2)/[5,5,5],
    // NOT continue from the stale anchor (which would give z = -2).
    const reanchored = mode.update(rightHand(0, 0, 2, true));
    expect(reanchored.position).toEqual({ x: 5, y: 5, z: 5 });

    // Continuing from the re-anchored state drags normally again.
    const r = mode.update(rightHand(0, 0, 3, true)); // delta.z = 1 from re-anchor
    expect(r.position.z).toBeCloseTo(4, 6); // 5 - 1
  });

  it("falls back to the left hand when the right has no pose", () => {
    const input = {
      controllers: {
        right: { triggerPressed: true }, // no pose
        left: { pose: { position: { x: 0, y: 0, z: 0 } }, triggerPressed: true },
      },
    };
    const r = mode.update(input);
    expect(mode.isGrabbing()).toBe(true);
    expect(r.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("reset() drops all grab state", () => {
    mode.update(rightHand(0, 0, 0, true));
    expect(mode.isGrabbing()).toBe(true);
    mode.reset();
    expect(mode.isGrabbing()).toBe(false);
  });
});
