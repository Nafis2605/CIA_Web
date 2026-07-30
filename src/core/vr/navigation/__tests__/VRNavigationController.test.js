// src/core/vr/navigation/__tests__/VRNavigationController.test.js
// Regression coverage for the always-on layered navigation model:
//   - fly is ACTIVATED at construction (it used to be dead — update() returned
//     null every frame because _isActive stayed false)
//   - fly is called with the real (inputState, frame, deltaTime) signature
//   - WALK ground-locks vertical movement
//   - snap turn debounces on the right-stick X flick
//   - object-move is suppressed while world-grabbing
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

// VRObjectMoveMode pulls in the VTK instance tools at module load; stub it so
// the controller can be constructed in a jsdom unit test.
vi.mock("@VTK/vtkInstanceTools.js", () => ({
  instanceTools: { getPosition: vi.fn(() => [0, 0, 0]), setPosition: vi.fn() },
}));

import { VRNavigationController } from "../VRNavigationController.js";
import { EXPLORATION_MODES } from "@Core/data/models/VRExplorationSession.js";

function makeController(overrides = {}) {
  const session = { defaultExplorationMode: EXPLORATION_MODES.FLY };
  const vrContext = { vrScale: 1.0, vrOrigin: [0, 0, 0], vrRotation: 0, instanceId: "inst-1" };
  const vrManager = { applySnapTurn: vi.fn() };
  const controller = new VRNavigationController(session, vrContext, { vrManager, ...overrides });
  return { controller, vrContext, vrManager };
}

/** Input with a left thumbstick (locomotion) and optional buttons/pose. */
function leftStick({ x = 0, y = 0, a = false } = {}) {
  return {
    headPose: { orientation: { x: 0, y: 0, z: 0, w: 1 } },
    controllers: {
      left: { pose: { position: { x: 0, y: 1.5, z: 0 } }, thumbstick: { x, y }, buttons: { a, b: false }, squeezeValue: 0 },
      right: null,
    },
  };
}

describe("VRNavigationController — layered always-on model", () => {
  it("activates the fly layer at construction so locomotion runs", () => {
    const { controller } = makeController();
    expect(controller._flyMode._isActive).toBe(true);
  });

  it("moves vrOrigin when the left stick is pushed (fly is reachable)", () => {
    const { controller } = makeController();
    // Push forward for several frames (velocity smoothing ramps up).
    let result;
    for (let i = 0; i < 10; i++) {
      result = controller.update(leftStick({ y: -1 }), {}, 0.016);
    }
    expect(result.position).not.toBeNull();
    // Some horizontal movement accumulated (z axis, forward/back).
    const moved = Math.abs(result.position.z) + Math.abs(result.position.x);
    expect(moved).toBeGreaterThan(0);
  });

  it("returns no movement when the stick is centered (deadzone)", () => {
    const { controller } = makeController();
    const result = controller.update(leftStick({ x: 0, y: 0 }), {}, 0.016);
    // Fly returns the current origin unchanged (no drift from a centered stick).
    expect(result.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("WALK mode locks vertical movement; FLY allows it", () => {
    // Vertical input comes from the A button (see VRFlyMode._getMovementInput).
    const flyC = makeController().controller;
    let flyResult;
    for (let i = 0; i < 10; i++) flyResult = flyC.update(leftStick({ a: true }), {}, 0.016);
    expect(Math.abs(flyResult.position.y)).toBeGreaterThan(0);

    const walkC = makeController().controller;
    walkC.setMode(EXPLORATION_MODES.WALK);
    let walkResult;
    for (let i = 0; i < 10; i++) walkResult = walkC.update(leftStick({ a: true }), {}, 0.016);
    expect(walkResult.position.y).toBeCloseTo(0, 6);
  });

  it("snap-turns once per flick and re-arms after the stick returns to center", () => {
    const { controller, vrManager } = makeController();
    const flick = {
      headPose: { orientation: { x: 0, y: 0, z: 0, w: 1 } },
      controllers: { left: null, right: { pose: { position: { x: 0, y: 1.5, z: 0 } }, thumbstick: { x: 0.9, y: 0 } } },
    };
    const center = {
      headPose: { orientation: { x: 0, y: 0, z: 0, w: 1 } },
      controllers: { left: null, right: { pose: { position: { x: 0, y: 1.5, z: 0 } }, thumbstick: { x: 0, y: 0 } } },
    };

    controller.update(flick, {}, 0.016);
    controller.update(flick, {}, 0.016); // held — must NOT re-fire
    expect(vrManager.applySnapTurn).toHaveBeenCalledTimes(1);
    expect(vrManager.applySnapTurn).toHaveBeenCalledWith(1);

    controller.update(center, {}, 0.016); // re-arm
    controller.update(flick, {}, 0.016); // second flick fires again
    expect(vrManager.applySnapTurn).toHaveBeenCalledTimes(2);
  });

  // The selected mode decides what the TRIGGER does. Object-move used to run on
  // ANY free trigger regardless of mode, so the dataset could be dragged by
  // accident at any time and the Move/Move Obj buttons changed nothing.
  function triggerHeld() {
    return {
      headPose: { orientation: { x: 0, y: 0, z: 0, w: 1 } },
      controllers: {
        left: null,
        right: {
          pose: { position: { x: 0, y: 1.5, z: 0 } },
          targetRay: { position: { x: 0, y: 1.5, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
          triggerPressed: true,
          squeezeValue: 0,
          thumbstick: { x: 0, y: 0 },
        },
      },
    };
  }

  it("trigger drives object-move ONLY in MOVE_OBJECT mode", () => {
    const { controller } = makeController();
    // Mirror production: VRExplorationManager binds world-grab to GRIP, so the
    // trigger is free to drive the mode layer. With the default (trigger)
    // predicate the trigger would engage world-grab and suppress it.
    controller.setWorldGrabEngagement((h) => (h?.squeezeValue || 0) > 0.7);
    const spy = vi.spyOn(controller._objectMove, "update");

    controller.setMode(EXPLORATION_MODES.FLY);
    controller.update(triggerHeld(), {}, 0.016);
    expect(spy, "FLY must leave the trigger free for tools/menu").not.toHaveBeenCalled();

    controller.setMode(EXPLORATION_MODES.MOVE_OBJECT);
    controller.update(triggerHeld(), {}, 0.016);
    expect(spy).toHaveBeenCalled();
  });

  it("trigger drives teleport ONLY in TELEPORT mode, and arms _enableTeleport", () => {
    const { controller } = makeController();
    // Mirror production: VRExplorationManager binds world-grab to GRIP, so the
    // trigger is free to drive the mode layer. With the default (trigger)
    // predicate the trigger would engage world-grab and suppress it.
    controller.setWorldGrabEngagement((h) => (h?.squeezeValue || 0) > 0.7);
    const spy = vi.spyOn(controller._teleportMode, "update");

    controller.setMode(EXPLORATION_MODES.WALK);
    expect(controller._enableTeleport).toBe(false);
    controller.update(triggerHeld(), {}, 0.016);
    expect(spy).not.toHaveBeenCalled();

    // Previously _enableTeleport came only from a constructor option the
    // manager never passed, so teleport could never run at all.
    controller.setMode(EXPLORATION_MODES.TELEPORT);
    expect(controller._enableTeleport).toBe(true);
    controller.update(triggerHeld(), {}, 0.016);
    expect(spy).toHaveBeenCalled();
  });

  it("suppresses object-move while world-grabbing (grip owns the frame)", () => {
    const { controller } = makeController();
    // World-grab engages on grip (squeeze); object-move on trigger.
    controller.setWorldGrabEngagement((h) => (h?.squeezeValue || 0) > 0.7);
    const objSpy = vi.spyOn(controller._objectMove, "update");
    const skipSpy = vi.spyOn(controller._objectMove, "onFrameSkipped");

    const gripAndTrigger = {
      headPose: { orientation: { x: 0, y: 0, z: 0, w: 1 } },
      controllers: {
        left: null,
        right: { pose: { position: { x: 0, y: 1.5, z: 0 } }, squeezeValue: 1, triggerPressed: true, thumbstick: { x: 0, y: 0 } },
      },
    };
    controller.update(gripAndTrigger, {}, 0.016); // rising edge — starts grab
    controller.update(gripAndTrigger, {}, 0.016); // grabbing

    expect(controller._worldGrab.isGrabbing()).toBe(true);
    expect(objSpy).not.toHaveBeenCalled();
    expect(skipSpy).toHaveBeenCalled();
  });
});
