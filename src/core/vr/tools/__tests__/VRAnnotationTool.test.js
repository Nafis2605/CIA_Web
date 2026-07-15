// src/core/vr/tools/__tests__/VRAnnotationTool.test.js
// Covers: preset-label cycling (the only VR text-entry mechanism — no
// virtual keyboard, no free-text voice) and that placed annotations carry
// the currently-selected label instead of the old hardcoded 'Note'.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRAnnotationTool, ANNOTATION_LABEL_PRESETS } from "../VRAnnotationTool.js";

function makeInputState({ triggerPressed = false, thumbstickX = 0 } = {}) {
  return {
    controllers: {
      right: {
        targetRay: { position: { x: 0, y: 0, z: 0 }, matrix: new Array(16).fill(0) },
        triggerPressed,
        thumbstick: { x: thumbstickX, y: 0 },
        buttons: { a: false },
      },
    },
  };
}

describe("VRAnnotationTool — preset label", () => {
  let tool;
  beforeEach(async () => {
    tool = new VRAnnotationTool();
    await tool.activate({
      handler: { raycastVR: vi.fn(() => ({ position: { x: 1, y: 2, z: 3 }, normal: { x: 0, y: 1, z: 0 } })) },
      vrContext: {},
    });
  });

  it("defaults to the first preset", () => {
    expect(tool.getPendingLabel()).toBe(ANNOTATION_LABEL_PRESETS[0]);
  });

  it("cycleLabel advances through all presets and wraps", () => {
    const seen = [tool.getPendingLabel()];
    for (let i = 0; i < ANNOTATION_LABEL_PRESETS.length; i++) {
      seen.push(tool.cycleLabel());
    }
    expect(seen).toEqual([...ANNOTATION_LABEL_PRESETS, ANNOTATION_LABEL_PRESETS[0]]);
  });

  it("placing an annotation carries the currently-selected label, not a hardcoded placeholder", () => {
    tool.cycleLabel(); // -> ANNOTATION_LABEL_PRESETS[1] ("Anomaly")
    const action = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(action).toMatchObject({ type: "annotation-created" });
    expect(action.data.text).toBe(ANNOTATION_LABEL_PRESETS[1]);
  });

  it("works the same for 'text' mode — no more 'Note' placeholder", () => {
    tool.setAnnotationMode("text");
    tool.cycleLabel();
    tool.cycleLabel(); // -> ANNOTATION_LABEL_PRESETS[2] ("Check this")
    const action = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(action.data.text).toBe(ANNOTATION_LABEL_PRESETS[2]);
    expect(action.data.text).not.toBe("Note");
  });

  it("rising-edge trigger only places once per press", () => {
    const input = makeInputState({ triggerPressed: true });
    const first = tool.handleInput(input, {});
    const second = tool.handleInput(input, {});
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// In-headset marker visuals (R5). Uses real vtk.js source/mapper/actor
// construction (jsdom-safe, no WebGL context) with a fake spy renderer, the
// same approach as VRControllerRenderer.reticle.test.js / VREnvironment.test.js.
// ---------------------------------------------------------------------------
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

describe("VRAnnotationTool — marker rendering", () => {
  let tool;
  let renderer;

  beforeEach(async () => {
    tool = new VRAnnotationTool();
    renderer = makeSpyRenderer();
    await tool.activate({
      handler: {
        raycastVR: vi.fn(() => ({
          position: { x: 1, y: 2, z: 3 },
          normal: { x: 0, y: 1, z: 0 },
        })),
      },
      vrContext: { vrScale: 2 },
    });
  });

  function place() {
    return tool.handleInput(
      makeInputState({ triggerPressed: true }),
      {}
    );
  }

  it("adds one actor per placed annotation on render", () => {
    place();
    tool._lastTriggerState = false; // re-arm trigger for a second placement
    place();

    tool.render(renderer);

    expect(renderer.addActor).toHaveBeenCalledTimes(2);
    expect(renderer.actors.length).toBe(2);
  });

  it("does not rebuild actors when the annotation count is unchanged", () => {
    place();
    tool.render(renderer);
    expect(renderer.addActor).toHaveBeenCalledTimes(1);

    tool.render(renderer); // no new annotations
    expect(renderer.addActor).toHaveBeenCalledTimes(1); // still just one
  });

  it("scales markers for constant apparent size (baseRadius / vrScale)", () => {
    place();
    tool.render(renderer);
    // MARKER_APPARENT_RADIUS_M (0.015) / vrScale (2) = 0.0075
    expect(renderer.actors[0].getScale()[0]).toBeCloseTo(0.0075);
  });

  it("removes all marker actors on deactivate", async () => {
    place();
    tool.render(renderer);
    expect(renderer.actors.length).toBe(1);

    await tool.deactivate();
    expect(renderer.removeActor).toHaveBeenCalledTimes(1);
    expect(renderer.actors.length).toBe(0);
  });

  it("removes the marker when its annotation is undone", () => {
    place();
    tool.render(renderer);
    expect(renderer.actors.length).toBe(1);

    tool.undoLast();
    tool.render(renderer); // reconcile against the now-empty set
    expect(renderer.removeActor).toHaveBeenCalledTimes(1);
    expect(renderer.actors.length).toBe(0);
  });
});
