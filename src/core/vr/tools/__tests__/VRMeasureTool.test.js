// src/core/vr/tools/__tests__/VRMeasureTool.test.js
// Covers the in-headset measurement visuals (R5): placing two points builds a
// line actor (plus endpoint spheres + distance label) in the renderer, and
// deactivate tears them all down. Uses real vtk.js source/mapper/actor
// construction (jsdom-safe) with a fake spy renderer, mirroring
// VRControllerRenderer.reticle.test.js / VREnvironment.test.js.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRMeasureTool } from "../VRMeasureTool.js";

function makeSpyRenderer() {
  const actors = [];
  return {
    actors,
    addActor: vi.fn((a) => actors.push(a)),
    removeActor: vi.fn((a) => {
      const i = actors.indexOf(a);
      if (i >= 0) actors.splice(i, 1);
    }),
  };
}

function makeInputState({ triggerPressed = false } = {}) {
  return {
    controllers: {
      right: {
        targetRay: { position: { x: 0, y: 0, z: 0 }, matrix: new Array(16).fill(0) },
        triggerPressed,
        thumbstick: { x: 0, y: 0 },
        buttons: {},
      },
    },
  };
}

describe("VRMeasureTool — measurement rendering", () => {
  let tool;
  let renderer;
  let raycastVR;

  beforeEach(async () => {
    tool = new VRMeasureTool();
    renderer = makeSpyRenderer();
    raycastVR = vi
      .fn()
      .mockReturnValueOnce({ position: { x: 0, y: 0, z: 0 } }) // start
      .mockReturnValue({ position: { x: 3, y: 4, z: 0 } }); // end + previews
    await tool.activate({
      handler: { raycastVR },
      vrContext: { vrScale: 2 },
    });
  });

  function placeStart() {
    tool._lastTriggerState = false;
    return tool.handleInput(makeInputState({ triggerPressed: true }), {});
  }
  function placeEnd() {
    tool._lastTriggerState = false;
    return tool.handleInput(makeInputState({ triggerPressed: true }), {});
  }

  it("adds line + endpoint + label actors once two points are placed", () => {
    const startAction = placeStart();
    expect(startAction).toMatchObject({ type: "measurement-start-placed" });

    const endAction = placeEnd();
    expect(endAction).toMatchObject({ type: "measurement-created" });
    expect(endAction.data.distance).toBeCloseTo(5); // 3-4-5 triangle

    tool.render(renderer);

    // start sphere, end sphere, line, label = 4 actors added
    expect(renderer.addActor).toHaveBeenCalledTimes(4);
    expect(renderer.actors.length).toBe(4);
    // The line actor is visible once both points exist.
    expect(tool._lineActor.getVisibility()).toBe(true);
  });

  it("only shows the start sphere while the end point is still pending", () => {
    placeStart();
    tool.render(renderer);

    expect(tool._startActor.getVisibility()).toBe(true);
    expect(tool._lineActor.getVisibility()).toBe(false);
    expect(tool._endActor.getVisibility()).toBe(false);
  });

  it("removes all measurement actors on deactivate (reset)", async () => {
    placeStart();
    placeEnd();
    tool.render(renderer);
    expect(renderer.actors.length).toBe(4);

    await tool.deactivate();
    expect(renderer.removeActor).toHaveBeenCalledTimes(4);
    expect(renderer.actors.length).toBe(0);
    expect(tool._lineActor).toBeNull();
  });

  it("scales endpoint spheres for constant apparent size (base / vrScale)", () => {
    placeStart();
    placeEnd();
    tool.render(renderer);
    // ENDPOINT_APPARENT_RADIUS_M (0.012) / vrScale (2) = 0.006
    expect(tool._startActor.getScale()[0]).toBeCloseTo(0.006);
  });
});
