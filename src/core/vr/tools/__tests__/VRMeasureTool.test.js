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
import { vtkGlyphFeature } from "@VTK/features/VTKGlyphFeature";

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

function makeController(triggerPressed) {
  return {
    targetRay: { position: { x: 0, y: 0, z: 0 }, matrix: new Array(16).fill(0) },
    triggerPressed,
    thumbstick: { x: 0, y: 0 },
    buttons: {},
  };
}

function makeInputState({ triggerPressed = false, hand = "right" } = {}) {
  return {
    controllers: { [hand]: makeController(triggerPressed) },
    // Mirrors what VRExplorationManager._resolveActivePointerHand puts on the
    // input state each frame.
    activePointerHand: hand,
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
    tool._lastTriggerState = { left: false, right: false };
    return tool.handleInput(makeInputState({ triggerPressed: true }), {});
  }
  function placeEnd() {
    tool._lastTriggerState = { left: false, right: false };
    return tool.handleInput(makeInputState({ triggerPressed: true }), {});
  }

  it("builds a point marker, a segment line and a distance label for a pair", () => {
    const startAction = placeStart();
    expect(startAction).toMatchObject({ type: "measurement-start-placed" });

    const endAction = placeEnd();
    expect(endAction).toMatchObject({ type: "measurement-created" });
    expect(endAction.data.distance).toBeCloseTo(5); // 3-4-5 triangle

    tool.render(renderer);

    expect(tool.getPoints().length).toBe(2);
    expect(tool.getMeasurements().length).toBe(1);
    expect(tool._segmentActors[0].actor.getVisibility()).toBe(true);
    expect(tool._segmentActors[0].label.getText()).toContain("5.000");
  });

  it("requests excludeDerivedActors and carries pointId/cellId/actorRole from each hit into the segment", () => {
    raycastVR
      .mockReset()
      .mockReturnValueOnce({ position: { x: 0, y: 0, z: 0 }, pointId: 1, cellId: 10, actorRole: "source" })
      .mockReturnValue({ position: { x: 3, y: 4, z: 0 }, pointId: 2, cellId: 11, actorRole: "glyph" });

    placeStart();
    const endAction = placeEnd();

    expect(raycastVR).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { excludeDerivedActors: true }
    );
    expect(endAction.data.startPoint).toMatchObject({ pointId: 1, cellId: 10, pickActorRole: "source" });
    expect(endAction.data.endPoint).toMatchObject({ pointId: 2, cellId: 11, pickActorRole: "glyph" });
  });

  it("defaults pointId/cellId/pickActorRole to null when a hit carries none", () => {
    raycastVR
      .mockReset()
      .mockReturnValue({ position: { x: 0, y: 0, z: 0 } });

    placeStart();
    const endAction = placeEnd();

    expect(endAction.data.startPoint.pointId).toBeNull();
    expect(endAction.data.endPoint.pickActorRole).toBeNull();
  });

  it("shows only the point marker while the segment is still open", () => {
    placeStart();
    tool.render(renderer);

    expect(tool._pointActors.length).toBe(1);
    expect(tool._pointActors[0].getVisibility()).toBe(true);
    expect(tool._segmentActors.length).toBe(0);
  });

  it("removes every actor on deactivate (shared renderer — a leak breaks desktop)", async () => {
    placeStart();
    placeEnd();
    tool.render(renderer);
    expect(renderer.actors.length).toBeGreaterThan(0);

    await tool.deactivate();

    expect(renderer.actors.length).toBe(0);
    expect(tool._pointActors.length).toBe(0);
    expect(tool._segmentActors.length).toBe(0);
    expect(tool._totalLabel).toBeNull();
  });

  it("scales point markers for constant apparent size (base / vrScale)", () => {
    placeStart();
    placeEnd();
    tool.render(renderer);
    // ENDPOINT_APPARENT_RADIUS_M (0.012) / vrScale (2) = 0.006
    expect(tool._pointActors[0].getScale()[0]).toBeCloseTo(0.006);
  });

  it("recognizes a second pinch as a fresh rising edge when the controller disappears between presses (Vision Pro release)", () => {
    // Gripless/transient-pointer input (Apple Vision Pro) only reports a
    // controller in inputState.controllers.right while a pinch is physically
    // held — release makes it vanish entirely, unlike a tracked controller
    // (Quest) whose object persists with triggerPressed: false. Deliberately
    // does NOT manually reset _lastTriggerState (unlike placeStart/placeEnd
    // above) so the release itself is what has to clear the latch.
    const startAction = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(startAction).toMatchObject({ type: "measurement-start-placed" });

    // Release: the transient-pointer source disappears entirely.
    tool.handleInput({ controllers: {} }, {});

    const endAction = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(endAction).toMatchObject({ type: "measurement-created" });
  });

  it("places from the LEFT hand when that is the active pointer", () => {
    // Regression guard. This tool read inputState.controllers.right
    // unconditionally, so left-handed measurement was silently impossible —
    // and on Vision Pro, where a gripless pinch is assigned to whichever hand
    // slot is free, a second simultaneous pinch lands in 'left' and was
    // dropped entirely. VRAnnotationTool already honoured
    // _resolveActivePointerHand; measure did not.
    const action = tool.handleInput(
      makeInputState({ triggerPressed: true, hand: "left" }),
      {}
    );
    expect(action).toMatchObject({ type: "measurement-start-placed" });
  });

  it("latches the trigger per hand, so one hand's release cannot re-arm the other", () => {
    // A single scalar latch cross-talks: releasing the left trigger cleared
    // the flag the right hand was holding, so a held right trigger re-armed
    // and placed again every frame.
    tool.handleInput(makeInputState({ triggerPressed: true, hand: "right" }), {});

    // Left hand taps and releases while the right trigger is still held.
    tool.handleInput(makeInputState({ triggerPressed: true, hand: "left" }), {});
    tool.handleInput(makeInputState({ triggerPressed: false, hand: "left" }), {});

    // The right hand never released, so this must NOT read as a new press.
    const repeat = tool.handleInput(
      makeInputState({ triggerPressed: true, hand: "right" }),
      {}
    );
    expect(repeat).toBeNull();
  });

  it("getMeasurementState reports idle when the tool is not active", async () => {
    // `if (!this.isActive)` (no call) is a bound-method reference, always
    // truthy, so this branch never took — the status line reported
    // 'placing-start' even for a deactivated tool with no points. `isActive()`
    // is the real check (VRToolInterface.js).
    await tool.deactivate();
    expect(tool.getMeasurementState()).toBe("idle");
  });

  it("getMeasurementState reflects point count once active", () => {
    expect(tool.getMeasurementState()).toBe("placing-start");
    placeStart();
    expect(tool.getMeasurementState()).toBe("placing-end");
  });
});

describe("VRMeasureTool — chained polyline", () => {
  let tool;
  let renderer;

  /** Raycast that walks a fixed list of points, one per trigger pull. */
  function makeToolAt(points) {
    const t = new VRMeasureTool();
    let i = 0;
    const raycastVR = vi.fn(() => ({ position: points[Math.min(i, points.length - 1)] }));
    t.activate({ handler: { raycastVR }, vrContext: { vrScale: 1 } });
    t._advance = () => { i += 1; };
    return t;
  }

  function tap(t) {
    t._lastTriggerState = { left: false, right: false };
    const r = t.handleInput(makeInputState({ triggerPressed: true }), {});
    t._advance();
    return r;
  }

  beforeEach(() => {
    renderer = makeSpyRenderer();
    // A path along +X: 0 -> 1 -> 3 -> 6, i.e. segments of 1, 2 and 3.
    tool = makeToolAt([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 6, y: 0, z: 0 },
    ]);
  });

  it("continues from the previous point instead of starting a fresh pair", () => {
    tap(tool); // 0
    tap(tool); // 1  -> segment 0->1
    tap(tool); // 3  -> segment 1->3

    const segs = tool.getMeasurements();
    expect(segs.length).toBe(2);
    // The crux of chaining: segment 2 STARTS where segment 1 ended.
    expect(segs[1].startPoint).toMatchObject(segs[0].endPoint);
    expect(segs[0].distance).toBeCloseTo(1);
    expect(segs[1].distance).toBeCloseTo(2);
  });

  it("reports a running total across every segment", () => {
    tap(tool); tap(tool); tap(tool); tap(tool);

    expect(tool.getMeasurements().length).toBe(3);
    expect(tool.getTotal()).toBeCloseTo(6); // 1 + 2 + 3
  });

  it("shows the total only once there is more than one segment", () => {
    tap(tool); tap(tool);
    tool.render(renderer);
    expect(tool._totalLabel.getActor().getVisibility()).toBe(false);

    tap(tool);
    tool.render(renderer);
    expect(tool._totalLabel.getActor().getVisibility()).toBe(true);
    expect(tool._totalLabel.getText()).toContain("3.000");
  });

  it("undo pops ONE point and returns the segment it removed", () => {
    tap(tool); tap(tool); tap(tool);
    expect(tool.getPoints().length).toBe(3);

    const undone = tool.undoLast();
    expect(undone).toMatchObject({ type: "measurement-removed" });
    expect(undone.data.distance).toBeCloseTo(2);
    expect(tool.getPoints().length).toBe(2);
    expect(tool.getMeasurements().length).toBe(1);
  });

  it("undo tombstones the removed segment with _deleted, mirroring annotation undo", () => {
    tap(tool); tap(tool);

    const undone = tool.undoLast();
    expect(undone.data._deleted).toBe(true);
  });

  it("undo of a lone start point cancels rather than removing a segment", () => {
    tap(tool);
    expect(tool.undoLast()).toMatchObject({ type: "measurement-cancelled" });
    expect(tool.getPoints().length).toBe(0);
  });

  it("undo on an empty path is a no-op", () => {
    expect(tool.undoLast()).toBeNull();
  });

  it("releases actors as the path shrinks", () => {
    tap(tool); tap(tool); tap(tool);
    tool.render(renderer);
    const peak = renderer.actors.length;

    tool.undoLast();
    tool.render(renderer);

    expect(renderer.actors.length).toBeLessThan(peak);
    expect(tool._pointActors.length).toBe(2);
    expect(tool._segmentActors.length).toBe(1);
  });

  it("newPath archives the current path and starts clean", () => {
    tap(tool); tap(tool); tap(tool);

    const done = tool.newPath();
    expect(done).toMatchObject({ type: "measurement-path-completed" });
    expect(done.data.segments.length).toBe(2);
    expect(done.data.total).toBeCloseTo(3);

    expect(tool.getPoints().length).toBe(0);
    expect(tool.getMeasurements().length).toBe(0);
    expect(tool.getPaths().length).toBe(1);
  });

  it("newPath on an empty path is a no-op", () => {
    expect(tool.newPath()).toBeNull();
  });

  it("emits a payload shaped for _persistVRMeasurement, unchanged by chaining", () => {
    tap(tool);
    const action = tap(tool);

    // VRExplorationManager._persistVRMeasurement reads exactly these fields,
    // which is why chaining needed no persistence changes.
    expect(action.data).toMatchObject({
      id: expect.any(String),
      startPoint: { x: 0, y: 0, z: 0 },
      endPoint: { x: 1, y: 0, z: 0 },
      unit: "units",
    });
    expect(action.data.distance).toBeCloseTo(1);
  });

  it("does NOT emit a preview action every frame", () => {
    // The old tool returned a `measurement-preview` action per frame — a
    // dispatch and a log line at 90 Hz that no handler consumed.
    tap(tool);
    for (let i = 0; i < 6; i++) {
      const r = tool.handleInput(makeInputState({ triggerPressed: false }), {});
      expect(r).toBeNull();
    }
  });

  it("caps the path length rather than growing actors without bound", () => {
    for (let i = 0; i < 70; i++) tap(tool);
    expect(tool.getPoints().length).toBeLessThanOrEqual(64);
  });
});

// ---------------------------------------------------------------------------
// Glyph-density "keep this point visible" hint (source-surface picks only —
// a glyph/threshold/isosurface pointId isn't a source-dataset index).
// ---------------------------------------------------------------------------
describe("VRMeasureTool — glyph selection hint", () => {
  let tool;
  const instanceId = "instance-1";

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(vtkGlyphFeature, "setSelectedPoint").mockImplementation(() => {});
    vi.spyOn(vtkGlyphFeature, "clearSelectedPoint").mockImplementation(() => {});
    tool = new VRMeasureTool();
    await tool.activate({
      handler: { raycastVR: vi.fn() },
      vrContext: { instanceId, vrScale: 1 },
    });
  });

  it("pins the source point when the active chain endpoint is a source-surface pick", () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 0, z: 0 },
      pointId: 7,
      actorRole: "source",
    }));

    tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(vtkGlyphFeature.setSelectedPoint).toHaveBeenCalledWith(instanceId, 7);
  });

  it("moves the pin to the previous point on undo, or clears it when the path empties", () => {
    let i = 0;
    const points = [
      { x: 0, y: 0, z: 0, pointId: 1 },
      { x: 1, y: 0, z: 0, pointId: 2 },
    ];
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: points[i],
      pointId: points[i].pointId,
      actorRole: "source",
    }));

    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    i = 1;
    tool._lastTriggerState = { left: false, right: false };
    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(vtkGlyphFeature.setSelectedPoint).toHaveBeenLastCalledWith(instanceId, 2);

    tool.undoLast();
    expect(vtkGlyphFeature.setSelectedPoint).toHaveBeenLastCalledWith(instanceId, 1);

    tool.undoLast();
    expect(vtkGlyphFeature.clearSelectedPoint).toHaveBeenCalledWith(instanceId);
  });

  it("clears the pin on newPath and on deactivate", async () => {
    tool._context.handler.raycastVR = vi.fn(() => ({
      position: { x: 1, y: 0, z: 0 },
      pointId: 7,
      actorRole: "source",
    }));
    tool.handleInput(makeInputState({ triggerPressed: true }), {});
    vtkGlyphFeature.clearSelectedPoint.mockClear();

    tool.newPath();
    expect(vtkGlyphFeature.clearSelectedPoint).toHaveBeenCalledWith(instanceId);

    vtkGlyphFeature.clearSelectedPoint.mockClear();
    await tool.deactivate();
    expect(vtkGlyphFeature.clearSelectedPoint).toHaveBeenCalledWith(instanceId);
  });
});
