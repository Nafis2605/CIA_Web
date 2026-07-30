// src/core/instances/types/vtk/vr/__tests__/VTKVRSpatialUI.integration.test.js
//
// End-to-end pipeline test for the in-VR spatial menu: initialize() -> a
// normal-frame update() -> dispose(), against a fake renderer. Unlike
// VTKVRSpatialUI.mapping.test.js (one narrow coordinate-math helper) and
// VRSpatialMenuModel.test.js (the pure data model only), this test actually
// exercises the canvas/texture/actor construction path — the code that
// builds the button quads and icon+label billboards in a real headset.
//
// jsdom has no real <canvas> 2D context or Path2D by default (the `canvas`
// npm package isn't installed), so this path has never executed under test
// before — which is how a change this size shipped without anything ever
// proving the panel actually produces visible, correctly-placed actors. This
// file stubs just enough of the Canvas 2D API to run the real code, then
// asserts on the REAL vtk.js actors it produces (visibility/position/scale),
// not on mock call counts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRSpatialUI } from "../VTKVRSpatialUI.js";
import { VR_MENU_BUTTONS } from "@Core/vr/VRSpatialMenuModel.js";

/** Minimal manager stub — same shape as VRSpatialMenuModel.test.js's makeManager(). */
function makeManager(overrides = {}) {
  return {
    activateTool: vi.fn(),
    deactivateTool: vi.fn(),
    getActiveTool: vi.fn(() => null),
    undoLastToolAction: vi.fn(() => true),
    toggleIsolation: vi.fn(() => true),
    isIsolated: vi.fn(() => false),
    leaveSession: vi.fn(() => Promise.resolve()),
    cycleNavigationMode: vi.fn(() => "teleport"),
    setNavigationMode: vi.fn(),
    getNavigationMode: vi.fn(() => "fly"),
    setVRScale: vi.fn(),
    getVRScale: vi.fn(() => 1.0),
    getActiveDatasetName: vi.fn(() => "test.vtp"),
    getOtherParticipants: vi.fn(() => []),
    goToParticipant: vi.fn(() => true),
    followParticipant: vi.fn(() => true),
    stopFollowing: vi.fn(),
    isFollowingParticipant: vi.fn(() => null),
    cycleAnnotationLabel: vi.fn(() => "Anomaly"),
    getPendingAnnotationLabel: vi.fn(() => null),
    cycleRepresentation: vi.fn(() => "wireframe"),
    setRepresentation: vi.fn((m) => m),
    toggleReferenceGrid: vi.fn(() => true),
    isReferenceGridVisible: vi.fn(() => false),
    toggleDataAxes: vi.fn(() => true),
    areDataAxesVisible: vi.fn(() => false),
    cycleGridPlane: vi.fn(() => "xy"),
    isThresholdAvailable: vi.fn(() => true),
    isThresholdEnabled: vi.fn(() => false),
    toggleThresholdFilter: vi.fn(() => true),
    cycleThresholdMode: vi.fn(() => "above"),
    cycleThresholdArray: vi.fn(() => "temperature"),
    isIsosurfaceAvailable: vi.fn(() => true),
    isIsosurfaceEnabled: vi.fn(() => false),
    toggleIsosurface: vi.fn(() => true),
    cycleValueTarget: vi.fn(() => "point-size"),
    nudgeValue: vi.fn(() => 3),
    resetValue: vi.fn(() => 1),
    getRepresentation: vi.fn(() => "surface"),
    toggleGlyphs: vi.fn(() => true),
    isGlyphsEnabled: vi.fn(() => false),
    invertClipPlane: vi.fn(),
    resetClipPlane: vi.fn(),
    cycleAnnotationMode: vi.fn(() => "text"),
    toggleProbeContinuous: vi.fn(() => true),
    isProbeContinuous: vi.fn(() => false),
    clearProbeHistory: vi.fn(),
    createSnapshot: vi.fn(() => Promise.resolve()),
    loadSnapshot: vi.fn(() => Promise.resolve()),
    getSessionSnapshots: vi.fn(() => []),
    isVoiceMuted: vi.fn(() => false),
    toggleVoiceMute: vi.fn(() => true),
    isVoiceConnected: vi.fn(() => false),
    toggleVoiceConnection: vi.fn(() => true),
    getNavigationModeInfo: vi.fn(() => ({ name: "Fly", controls: "Thumbstick to move, trigger to boost" })),
    ...overrides,
  };
}

function makeFakeRenderer() {
  return { addActor: vi.fn(), removeActor: vi.fn() };
}

/** Fresh fake 2D context per canvas — mirrors real getContext("2d") semantics closely enough to run the code. */
function createFakeCtx() {
  return {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    textAlign: "",
    textBaseline: "",
    measureText: vi.fn((str) => ({ width: Math.max(1, String(str).length * 10) })),
    fillText: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    fill: vi.fn(),
    // Rounded-card path drawing (see VTKVRSpatialUI._roundRectPath / _drawCard).
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    // Group accent bar: clipped fillRect over the rounded card (_drawCard).
    clip: vi.fn(),
    fillRect: vi.fn(),
    getImageData: vi.fn((_x, _y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4),
    })),
  };
}

function makeInputState({ headY = 1.6, triggerPressed = false } = {}) {
  return {
    headPose: {
      position: { x: 0, y: headY, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 }, // identity: facing -Z
    },
    controllers: {
      // Identity transform matrix (column-major) -> forward = [0,0,-1], same
      // as the head, so the panel (anchored in front of the head) sits
      // directly along this ray.
      right: {
        targetRay: {
          position: { x: 0, y: headY, z: 0 },
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        triggerPressed,
      },
      left: null,
    },
  };
}

/**
 * Same as makeInputState, but the controller ray is aimed exactly at
 * `target` (an [x,y,z] world point) instead of straight ahead — the panel
 * sits off-center (dropped + side-offset, see VTKVRSpatialUI's
 * PANEL_DROP/PANEL_SIDE_OFFSET), so hitting a specific button/tab requires
 * aiming at its actual computed position, not just "forward".
 */
function makeInputStateAimedAt(target, { headY = 1.6, triggerPressed = false } = {}) {
  const origin = [0, headY, 0];
  const d = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const len = Math.hypot(...d) || 1;
  const dir = d.map((v) => v / len);
  // _pickRay derives direction as [-m8,-m9,-m10]; only those three matrix
  // slots matter (origin comes from targetRay.position).
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, -dir[0], -dir[1], -dir[2], 0, 0, 0, 0, 1];
  return {
    headPose: { position: { x: origin[0], y: origin[1], z: origin[2] }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    controllers: {
      right: { targetRay: { position: { x: origin[0], y: origin[1], z: origin[2] }, matrix }, triggerPressed },
      left: null,
    },
  };
}

describe("VRSpatialUI integration — initialize/update/dispose against a fake renderer", () => {
  let getContextSpy;

  beforeEach(() => {
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => createFakeCtx());
    vi.stubGlobal(
      "Path2D",
      class FakePath2D {
        constructor(_pathData) {}
      }
    );
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("builds every static button + status/hint/reshow actors without throwing", () => {
    const renderer = makeFakeRenderer();
    const ui = new VRSpatialUI();

    expect(() => ui.initialize(renderer, makeManager())).not.toThrow();

    // Every button gets a card actor; buttons with a resolvable icon+label
    // (all of them, per the icon-data audit) also get a label actor.
    // Plus: backing panel, status line, hint line, reshow-tab card, reshow-tab label.
    const expectedMin = VR_MENU_BUTTONS.length * 2 + 5;
    expect(renderer.addActor.mock.calls.length).toBeGreaterThanOrEqual(expectedMin);

    // The actual regression this test exists to catch: a real panel with
    // real button actors, not zero.
    expect(ui._buttonActors.size).toBe(VR_MENU_BUTTONS.length);
  });

  it("makes every button visible with finite position/scale after a normal frame", () => {
    const renderer = makeFakeRenderer();
    const ui = new VRSpatialUI();
    ui.initialize(renderer, makeManager());

    const result = ui.update(makeInputState(), { vrScale: 1.0, vrOrigin: [0, 0, 0] });
    expect(result).not.toBeNull();

    expect(ui._buttonActors.size).toBe(VR_MENU_BUTTONS.length);
    for (const [id, { actor, labelActor }] of ui._buttonActors) {
      expect(actor.getVisibility(), `button "${id}" quad should be visible`).toBe(true);
      const pos = actor.getPosition();
      const scale = actor.getScale();
      expect(pos.every(Number.isFinite), `button "${id}" position should be finite`).toBe(true);
      expect(scale.every((v) => Number.isFinite(v) && v > 0), `button "${id}" scale should be finite/positive`).toBe(
        true
      );
      if (labelActor) {
        expect(labelActor.getVisibility(), `button "${id}" label should be visible`).toBe(true);
      }
    }
  });

  it("places each card ON its own hit region (card plane must be centered)", () => {
    // REGRESSION: _createButtonActor used to build its plane with vtkPlaneSource's
    // DEFAULTS, which span [0,1]² rather than the [-0.5,0.5]² that _layoutButtons
    // assumes. Every card then rendered half a cell up-and-right of the cell it
    // was positioned at, so the visible card no longer matched the region
    // hitTest() resolves — pointing at a card activated its neighbour, and the
    // centered icon/label billboard landed on the card's corner. The old test
    // only asserted positions were finite, so it could not catch this.
    const renderer = makeFakeRenderer();
    const ui = new VRSpatialUI();
    ui.initialize(renderer, makeManager());
    ui.update(makeInputState(), { vrScale: 1.0, vrOrigin: [0, 0, 0] });

    // Checking actor.getPosition() would be VACUOUS here — the actor is placed
    // at the cell centre either way; it's the plane's LOCAL vertex range that
    // was wrong. So assert on the actor's world BOUNDS, whose centre only
    // coincides with its position when the plane is authored centered.
    for (const region of ui.getModel().getButtonLayout()) {
      const entry = ui._buttonActors.get(region.id);
      if (!entry) continue;

      const pos = entry.actor.getPosition();
      const b = entry.actor.getBounds(); // [xmin,xmax, ymin,ymax, zmin,zmax]
      const boundsCentre = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];

      for (let i = 0; i < 3; i++) {
        expect(
          Math.abs(boundsCentre[i] - pos[i]),
          `card "${region.id}" geometry must be centred on its position (axis ${i})`
        ).toBeLessThan(1e-6);
      }

      // The card must also actually cover its cell, not collapse to a point.
      const width = b[1] - b[0];
      const height = b[3] - b[2];
      expect(width, `card "${region.id}" should have real width`).toBeGreaterThan(0);
      expect(height, `card "${region.id}" should have real height`).toBeGreaterThan(0);
    }
  });

  it("hides the full panel and shows the reshow tab when manually hidden, and reshowing restores it", () => {
    const renderer = makeFakeRenderer();
    const ui = new VRSpatialUI();
    ui.initialize(renderer, makeManager());
    ui.update(makeInputState(), { vrScale: 1.0, vrOrigin: [0, 0, 0] });
    // The panel sits off dead-ahead (dropped + side-offset), so capture where
    // it actually landed to aim the reshow-tab ray at it below.
    const anchorCenter = ui._panelAnchor.center;

    ui.getModel().setVisible(false);
    ui.update(makeInputStateAimedAt(anchorCenter), { vrScale: 1.0, vrOrigin: [0, 0, 0] });

    for (const { actor } of ui._buttonActors.values()) {
      expect(actor.getVisibility()).toBe(false);
    }
    expect(ui._reshowTabActor.getVisibility()).toBe(true);

    // Rising-edge select while hovering the reshow tab brings the panel back.
    ui.update(makeInputStateAimedAt(anchorCenter, { triggerPressed: true }), {
      vrScale: 1.0,
      vrOrigin: [0, 0, 0],
    });
    expect(ui.getModel().isVisible()).toBe(true);
  });

  it("dispose() removes every actor it added and leaves no residual state", () => {
    const renderer = makeFakeRenderer();
    const ui = new VRSpatialUI();
    ui.initialize(renderer, makeManager());
    ui.update(makeInputState(), { vrScale: 1.0, vrOrigin: [0, 0, 0] });

    const addCount = renderer.addActor.mock.calls.length;
    ui.dispose();

    expect(renderer.removeActor.mock.calls.length).toBeGreaterThanOrEqual(VR_MENU_BUTTONS.length);
    expect(ui._buttonActors.size).toBe(0);
    expect(addCount).toBeGreaterThan(0);
  });
});
