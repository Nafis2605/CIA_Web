// src/core/vr/tools/__tests__/VRAnnotationTool.test.js
// Covers: preset-label cycling (the only VR text-entry mechanism — no
// virtual keyboard, no free-text voice) and that placed annotations carry
// the currently-selected label instead of the old hardcoded 'Note'.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

// VRAnnotationTool now reads the local user's display name for a placed
// pin's label — mock the whole module rather than adding a "presence" logger
// channel, matching the pattern in AvatarNetworkSync.pointer.test.js.
vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserName: vi.fn(() => "Alice"),
}));

import { VRAnnotationTool, ANNOTATION_LABEL_PRESETS } from "../VRAnnotationTool.js";
import { vtkGlyphFeature } from "@VTK/features/VTKGlyphFeature";

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

  it("requests excludeDerivedActors and carries pointId/cellId/actorRole from the hit onto the draft", () => {
    const raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
      pointId: 42,
      cellId: 7,
      actorRole: "source",
    }));
    tool._context.handler.raycastVR = raycastVR;

    const pending = tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(raycastVR).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { excludeDerivedActors: true }
    );
    expect(pending.data.pointId).toBe(42);
    expect(pending.data.cellId).toBe(7);
    expect(pending.data.pickActorRole).toBe("source");
  });

  it("defaults pointId/cellId/pickActorRole to null when the hit carried none", () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      normal: null,
    }));

    const pending = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(pending.data.pointId).toBeNull();
    expect(pending.data.cellId).toBeNull();
    expect(pending.data.pickActorRole).toBeNull();
  });

  it("resolves localPosition from the hit actor's polydata for a resolvable source-role pick", () => {
    const fakeActor = {
      getMapper: () => ({
        getInputData: () => ({
          getPoints: () => ({
            getData: () => new Float64Array([0, 0, 0, 0.1, 0.2, 0.3, 9, 9, 9]),
          }),
        }),
      }),
    };
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
      pointId: 1,
      cellId: 7,
      actorRole: "source",
      actor: fakeActor,
    }));

    const pending = tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(pending.data.localPosition).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
  });

  it("does not resolve localPosition for a glyph/threshold/isosurface (derived-actor) pick", () => {
    const fakeActor = {
      getMapper: () => ({
        getInputData: () => ({
          getPoints: () => ({ getData: () => new Float32Array([0.1, 0.2, 0.3]) }),
        }),
      }),
    };
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
      pointId: 0,
      cellId: 7,
      actorRole: "glyph",
      actor: fakeActor,
    }));

    const pending = tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(pending.data.localPosition).toBeNull();
  });

  it("does not resolve localPosition when pointId is unresolved (-1 or null)", () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 1, z: 0 },
      pointId: -1,
      cellId: -1,
      actorRole: "source",
      actor: { getMapper: () => ({ getInputData: () => ({ getPoints: () => ({ getData: () => [] }) }) }) },
    }));

    const pending = tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(pending.data.localPosition).toBeNull();
  });

  it("placing an annotation carries the currently-selected label, not a hardcoded placeholder", () => {
    tool.cycleLabel(); // -> ANNOTATION_LABEL_PRESETS[1] ("Anomaly")
    const pending = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(pending).toMatchObject({ type: "annotation-pending" });
    const action = tool.confirmDraft();
    expect(action).toMatchObject({ type: "annotation-created" });
    expect(action.data.text).toBe(ANNOTATION_LABEL_PRESETS[1]);
  });

  it("carries whichever preset label is selected, with no 'Note' placeholder", () => {
    tool.cycleLabel();
    tool.cycleLabel(); // -> ANNOTATION_LABEL_PRESETS[2] ("Check this")
    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    const action = tool.confirmDraft();
    expect(action.data.text).toBe(ANNOTATION_LABEL_PRESETS[2]);
    expect(action.data.text).not.toBe("Note");
  });

  it("always creates a 'marker' — text/drawing modes were cosmetic and are gone", () => {
    // render() drew the same sphere for every mode, and 'drawing' stored a
    // one-element point list with no stroke accumulation, so cycling mode
    // changed stored metadata and nothing else.
    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    const action = tool.confirmDraft();
    expect(action.data.type).toBe("marker");
    expect(tool.setAnnotationMode).toBeUndefined();
    expect(tool.cycleMode).toBeUndefined();
  });

  it("cycles marker colour, which is visible unlike the old mode cycle", () => {
    const first = tool.getPendingColorName();
    const second = tool.cycleColor();
    expect(second).not.toBe(first);

    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    const action = tool.confirmDraft();
    expect(Array.isArray(action.data.color)).toBe(true);
  });

  it("rising-edge trigger only places once per press", () => {
    const input = makeInputState({ triggerPressed: true });
    const first = tool.handleInput(input, {});
    const second = tool.handleInput(input, {});
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("recognizes a second pinch as a fresh rising edge when the controller disappears between presses (Vision Pro release)", () => {
    // Gripless/transient-pointer input (Apple Vision Pro) only reports a
    // controller in inputState.controllers.right while a pinch is physically
    // held — release makes it vanish entirely, unlike a tracked controller
    // (Quest) whose object persists with triggerPressed: false. handleInput
    // must treat that disappearance as "released" and reset its rising-edge
    // latch, not stay stuck from the last press it saw.
    const pending = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(pending).toMatchObject({ type: "annotation-pending" });
    tool.confirmDraft();

    // Release: the transient-pointer source disappears (not merely
    // triggerPressed: false) — simulate a couple of frames of this, and also
    // let the tool's own _suppressUntilRelease window (set by confirmDraft)
    // observe the release the same way.
    tool.handleInput({ controllers: {} }, {});
    tool.handleInput({ controllers: {} }, {});

    // A fresh pinch must be recognized as a new rising edge.
    const secondPending = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(secondPending).toMatchObject({ type: "annotation-pending" });
  });
});

// ---------------------------------------------------------------------------
// Glyph-density "keep this point visible" hint (source-surface picks only —
// a glyph/threshold/isosurface pointId isn't a source-dataset index).
// ---------------------------------------------------------------------------
describe("VRAnnotationTool — glyph selection hint", () => {
  let tool;
  const instanceId = "instance-1";

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(vtkGlyphFeature, "setSelectedPoint").mockImplementation(() => {});
    vi.spyOn(vtkGlyphFeature, "clearSelectedPoint").mockImplementation(() => {});
    tool = new VRAnnotationTool();
    await tool.activate({
      handler: { raycastVR: vi.fn() },
      vrContext: { instanceId },
    });
  });

  it("pins the source point when a draft opens against a source-surface pick", () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      pointId: 42,
      actorRole: "source",
    }));

    tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(vtkGlyphFeature.setSelectedPoint).toHaveBeenCalledWith(instanceId, 42);
  });

  it("does not pin a point for a derived-actor (glyph/threshold/isosurface) pick", () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      pointId: 42,
      actorRole: "glyph",
    }));

    tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(vtkGlyphFeature.setSelectedPoint).not.toHaveBeenCalled();
    expect(vtkGlyphFeature.clearSelectedPoint).toHaveBeenCalledWith(instanceId);
  });

  it("releases the pin when the draft is confirmed", () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      pointId: 42,
      actorRole: "source",
    }));
    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    vtkGlyphFeature.clearSelectedPoint.mockClear();

    tool.confirmDraft();

    expect(vtkGlyphFeature.clearSelectedPoint).toHaveBeenCalledWith(instanceId);
  });

  it("releases the pin when the draft is cancelled", () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 2, z: 3 },
      pointId: 42,
      actorRole: "source",
    }));
    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    vtkGlyphFeature.clearSelectedPoint.mockClear();

    tool.cancelDraft();

    expect(vtkGlyphFeature.clearSelectedPoint).toHaveBeenCalledWith(instanceId);
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

  // Trigger fixes a point (annotation-pending); confirmDraft() is the Save
  // key's action. Together they replicate the old one-shot "place" behaviour
  // for tests that don't care about the in-between draft state.
  function place() {
    const pending = tool.handleInput(
      makeInputState({ triggerPressed: true }),
      {}
    );
    if (!pending) return pending;
    return tool.confirmDraft();
  }

  it("builds a marker AND a label per placed annotation", () => {
    // The label is the point: an annotation carrying "Anomaly" should SAY so
    // in-headset. Under vtkVectorText it rendered as invisible geometry.
    place();
    // Re-arm for a second placement: confirmDraft() set
    // _suppressUntilRelease, which (by design) requires an observed trigger
    // release before the next rising edge is honoured — simulate that
    // release directly rather than routing a whole extra handleInput frame.
    // _lastTriggerState is now keyed per-hand (see VRAnnotationTool.js);
    // these tests default to the right hand (makeInputState only sets
    // controllers.right).
    tool._lastTriggerState.right = false;
    tool._suppressUntilRelease = false;
    place();

    tool.render(renderer);

    expect(tool._markerActors.size).toBe(2);
    for (const entry of tool._markerActors.values()) {
      expect(entry.actor).toBeTruthy();
      expect(entry.label).toBeTruthy();
    }
  });

  it("renders the preset label text, plus the local user's name, on the billboard", () => {
    tool.cycleLabel(); // -> "Anomaly"
    place();
    tool.render(renderer);

    const entry = [...tool._markerActors.values()][0];
    // Own-echo/local-optimistic marker: authorName came from getUserName()
    // (mocked to "Alice" in this file), matching what confirmDraft's
    // _createAnnotation() actually stores.
    expect(entry.label.getText()).toBe(`${tool.getPendingLabel()} — Alice`);
  });

  it("does not rebuild actors when the annotation count is unchanged", () => {
    place();
    tool.render(renderer);
    const afterFirst = renderer.addActor.mock.calls.length;

    tool.render(renderer); // no new annotations
    expect(renderer.addActor.mock.calls.length).toBe(afterFirst);
  });

  it("scales markers for constant apparent size (baseRadius / vrScale)", () => {
    place();
    tool.render(renderer);
    // MARKER_APPARENT_RADIUS_M (0.015) / vrScale (2) = 0.0075
    const entry = [...tool._markerActors.values()][0];
    expect(entry.actor.getScale()[0]).toBeCloseTo(0.0075);
  });

  it("removes every actor on deactivate — the renderer is shared with desktop", async () => {
    place();
    tool.render(renderer);
    expect(renderer.actors.length).toBeGreaterThan(0);

    await tool.deactivate();

    expect(renderer.actors.length).toBe(0);
    expect(tool._markerActors.size).toBe(0);
  });

  it("removes the marker AND its label when the annotation is undone", () => {
    place();
    tool.render(renderer);
    expect(renderer.actors.length).toBeGreaterThan(0);

    tool.undoLast();
    tool.render(renderer); // reconcile against the now-empty set

    expect(renderer.actors.length).toBe(0);
    expect(tool._markerActors.size).toBe(0);
  });
});
