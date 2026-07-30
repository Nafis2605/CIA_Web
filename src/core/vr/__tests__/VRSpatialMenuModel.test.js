// src/core/vr/__tests__/VRSpatialMenuModel.test.js
// Logic-layer tests for the in-VR spatial tool menu: button layout / hit
// regions, action dispatch (button id → manager call), and show/hide on VR
// session start/end. The VTK rendering is intentionally not exercised here —
// VTKVRSpatialUI is a thin geometry wrapper over this model.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRSpatialMenuModel, VR_MENU_BUTTONS, VR_MENU_CONTEXTUAL_BUTTONS } from "../VRSpatialMenuModel.js";

/** Minimal manager stub matching the methods the model calls. */
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

describe("VRSpatialMenuModel — layout & hit testing", () => {
  let model;
  beforeEach(() => {
    model = new VRSpatialMenuModel(makeManager());
  });

  it("lays out one non-overlapping cell per button, within [0,1] on both axes", () => {
    const layout = model.getButtonLayout();
    expect(layout).toHaveLength(VR_MENU_BUTTONS.length);

    for (const r of layout) {
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1);
      expect(r.u0).toBeLessThan(r.u1);
      expect(r.v0).toBeGreaterThanOrEqual(0);
      expect(r.v1).toBeLessThanOrEqual(1);
      expect(r.v0).toBeLessThan(r.v1);
    }
  });

  it("within each row, cells are strictly increasing and non-overlapping left→right", () => {
    const byRow = new Map();
    for (const r of model.getButtonLayout()) {
      if (!byRow.has(r.row)) byRow.set(r.row, []);
      byRow.get(r.row).push(r);
    }
    for (const cells of byRow.values()) {
      for (let i = 1; i < cells.length; i++) {
        expect(cells[i].u0).toBeGreaterThan(cells[i - 1].u1);
      }
    }
  });

  it("rows are stacked top-to-bottom without overlapping v-ranges", () => {
    const rowIds = [...new Set(model.getButtonLayout().map((r) => r.row))].sort((a, b) => a - b);
    for (const rowId of rowIds) {
      const cells = model.getButtonLayout().filter((r) => r.row === rowId);
      const v0 = cells[0].v0;
      const v1 = cells[0].v1;
      for (const c of cells) {
        expect(c.v0).toBe(v0);
        expect(c.v1).toBe(v1);
      }
      // v runs along +up, and the FIRST declared row renders at the TOP, so a
      // higher row index sits strictly BELOW a lower one.
      const higherRow = model.getButtonLayout().find((r) => r.row === rowId + 1);
      if (higherRow) {
        expect(higherRow.v1).toBeLessThanOrEqual(v0 + 1e-9);
      }
    }
  });

  it("hitTest maps a cell center back to that button", () => {
    for (const r of model.getButtonLayout()) {
      const hit = model.hitTest(r.cu, r.cv);
      expect(hit?.id).toBe(r.id);
    }
  });

  it("hitTest returns null off-panel, in gaps, and for non-finite input", () => {
    expect(model.hitTest(-0.1, 0.5)).toBeNull();
    expect(model.hitTest(0.5, 1.2)).toBeNull();
    expect(model.hitTest(NaN, 0.5)).toBeNull();
    // A point in the vertical padding band (below v0) is a miss
    const r = model.getButtonLayout()[0];
    expect(model.hitTest(r.cu, r.v0 - 0.01)).toBeNull();
  });

  it("top row (row 0) starts with annotate; the last (bottom) row ends with exit", () => {
    const layout = model.getButtonLayout();
    const row0 = layout.filter((r) => r.row === 0);
    expect(row0[0].id).toBe("annotate");

    const maxRow = Math.max(...layout.map((r) => r.row));
    const topRow = layout.filter((r) => r.row === maxRow);
    expect(topRow[topRow.length - 1].id).toBe("exit");
  });
});

describe("VRSpatialMenuModel — action dispatch", () => {
  let manager;
  let model;
  beforeEach(() => {
    manager = makeManager();
    model = new VRSpatialMenuModel(manager);
  });

  it("tapping a tool activates it; tapping again deactivates (toggle)", () => {
    const r1 = model.activate("annotate");
    expect(r1).toMatchObject({ handled: true, action: "tool-activated", toolId: "annotate" });
    expect(manager.activateTool).toHaveBeenCalledWith("annotate");
    expect(model.getActiveToolId()).toBe("annotate");

    const r2 = model.activate("annotate");
    expect(r2).toMatchObject({ handled: true, action: "tool-deactivated", toolId: null });
    expect(manager.deactivateTool).toHaveBeenCalledTimes(1);
    expect(model.getActiveToolId()).toBeNull();
  });

  it("switching tools deactivates the old and activates the new", () => {
    model.activate("annotate");
    manager.activateTool.mockClear();
    const r = model.activate("measure");
    expect(r.toolId).toBe("measure");
    expect(manager.activateTool).toHaveBeenCalledWith("measure");
    expect(model.getActiveToolId()).toBe("measure");
  });

  it("undo routes through manager.undoLastToolAction", () => {
    const r = model.activate("undo");
    expect(manager.undoLastToolAction).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "undo", undone: true });
  });

  it("isolation toggle routes through manager.toggleIsolation (B-button path)", () => {
    manager.toggleIsolation.mockReturnValueOnce(true);
    const r = model.activate("isolation");
    expect(manager.toggleIsolation).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "isolation-toggled", isolated: true });
    expect(model.isIsolated()).toBe(true);
  });

  it("exit calls manager.leaveSession", () => {
    const r = model.activate("exit");
    expect(manager.leaveSession).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "exit" });
  });

  it("nav-mode cycles via manager.cycleNavigationMode", () => {
    manager.cycleNavigationMode.mockReturnValueOnce("walk");
    const r = model.activate("nav-mode");
    expect(manager.cycleNavigationMode).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "nav-mode-changed", mode: "walk" });
  });

  it("Move enters grab mode from teleport via manager.setNavigationMode", () => {
    manager.getNavigationMode.mockReturnValue("teleport");
    const r = model.activate("move");
    expect(manager.setNavigationMode).toHaveBeenCalledWith("grab");
    expect(r).toMatchObject({ handled: true, action: "nav-mode-set", mode: "grab" });
  });

  it("Move toggles back to fly when grab is already active", () => {
    // Untoggling returns to "fly" — the neutral mode where the trigger stays
    // free for tools/menu. It used to fall back to "teleport", which silently
    // handed the trigger to teleport aiming; teleport is now its own button.
    manager.getNavigationMode.mockReturnValue("grab");
    const r = model.activate("move");
    expect(manager.setNavigationMode).toHaveBeenCalledWith("fly");
    expect(r).toMatchObject({ handled: true, action: "nav-mode-set", mode: "fly" });
  });

  it("Teleport is a real selectable mode", () => {
    manager.getNavigationMode.mockReturnValue("fly");
    const r = model.activate("teleport");
    expect(manager.setNavigationMode).toHaveBeenCalledWith("teleport");
    expect(r).toMatchObject({ handled: true, action: "nav-mode-set", mode: "teleport" });
  });

  it("scale presets call manager.setVRScale with the button's fixed value", () => {
    const r = model.activate("scale-detail");
    expect(manager.setVRScale).toHaveBeenCalledWith(10.0);
    expect(r).toMatchObject({ handled: true, action: "scale-changed", scaleValue: 10.0, buttonId: "scale-detail" });
  });

  it("goto-participant cycles through getOtherParticipants and calls manager.goToParticipant", () => {
    manager.getOtherParticipants.mockReturnValue([
      { odUserId: "u1", userName: "Alice" },
      { odUserId: "u2", userName: "Bob" },
    ]);
    const r1 = model.activate("goto-participant");
    expect(manager.goToParticipant).toHaveBeenCalledWith("u1");
    expect(r1).toMatchObject({ handled: true, action: "goto-participant", userId: "u1", ok: true });

    const r2 = model.activate("goto-participant");
    expect(manager.goToParticipant).toHaveBeenCalledWith("u2");
    expect(r2.userId).toBe("u2");

    // Wraps back to the first participant
    const r3 = model.activate("goto-participant");
    expect(r3.userId).toBe("u1");
  });

  it("goto-participant is a safe no-op with nobody else in the session", () => {
    manager.getOtherParticipants.mockReturnValue([]);
    const r = model.activate("goto-participant");
    expect(r).toMatchObject({ handled: true, action: "goto-participant", ok: false, reason: "no-participants" });
    expect(manager.goToParticipant).not.toHaveBeenCalled();
  });

  it("follow-participant follows the next participant, then toggles off on a second tap", () => {
    manager.getOtherParticipants.mockReturnValue([{ odUserId: "u1", userName: "Alice" }]);

    const r1 = model.activate("follow-participant");
    expect(manager.followParticipant).toHaveBeenCalledWith("u1");
    expect(r1).toMatchObject({ handled: true, action: "follow-participant", following: "u1" });

    manager.isFollowingParticipant.mockReturnValue("u1");
    const r2 = model.activate("follow-participant");
    expect(manager.stopFollowing).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ handled: true, action: "follow-participant", following: null });
  });

  // annotation-label is CONTEXTUAL to the annotate tool now (it only means
  // anything while annotating), so it is only present in the layout — and
  // therefore only activatable — while that tool is active.
  it("annotation-label cycles via manager.cycleAnnotationLabel", () => {
    model.activate("annotate");
    const r = model.activate("annotation-label");
    expect(manager.cycleAnnotationLabel).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "annotation-label-changed", label: "Anomaly" });
  });

  it("annotation-label is a safe no-op when no tool supports labels", () => {
    model.activate("annotate");
    manager.cycleAnnotationLabel.mockReturnValue(null);
    const r = model.activate("annotation-label");
    expect(r).toMatchObject({ handled: true, action: "annotation-label-changed", label: null, reason: "no-active-tool" });
  });

  it("annotation-label is absent from the layout unless annotate is active", () => {
    expect(model.getButtonLayout().some((b) => b.id === "annotation-label")).toBe(false);
    model.activate("annotate");
    expect(model.getButtonLayout().some((b) => b.id === "annotation-label")).toBe(true);
  });

  it("representation button cycles via manager.cycleRepresentation", () => {
    const r = model.activate("representation");
    expect(manager.cycleRepresentation).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "representation-changed", mode: "wireframe" });
  });

  it("representation is a safe no-op without an active dataset", () => {
    manager.cycleRepresentation.mockReturnValue(null);
    const r = model.activate("representation");
    expect(r).toMatchObject({ handled: true, action: "representation-changed", mode: null });
  });

  it("glyphs button toggles via manager.toggleGlyphs", () => {
    const r1 = model.activate("glyphs");
    expect(manager.toggleGlyphs).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ handled: true, action: "glyphs-toggled", enabled: true });

    manager.toggleGlyphs.mockReturnValue(false);
    const r2 = model.activate("glyphs");
    expect(r2).toMatchObject({ handled: true, action: "glyphs-toggled", enabled: false });
  });

  it("walk is a direct nav-mode-set button, same semantics as move", () => {
    manager.getNavigationMode.mockReturnValue("teleport");
    const r = model.activate("walk");
    expect(manager.setNavigationMode).toHaveBeenCalledWith("walk");
    expect(r).toMatchObject({ handled: true, action: "nav-mode-set", mode: "walk" });
  });

  it("snapshot-save routes through manager.createSnapshot", () => {
    const r = model.activate("snapshot-save");
    expect(manager.createSnapshot).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "snapshot-saved" });
  });

  it("snapshot-save swallows a rejected createSnapshot promise", () => {
    const rejecting = makeManager({ createSnapshot: vi.fn(() => Promise.reject(new Error("x"))) });
    const m = new VRSpatialMenuModel(rejecting);
    expect(() => m.activate("snapshot-save")).not.toThrow();
  });

  it("snapshot-load cycles through getSessionSnapshots and calls manager.loadSnapshot", () => {
    manager.getSessionSnapshots.mockReturnValue([{ id: "s1" }, { id: "s2" }]);
    const r1 = model.activate("snapshot-load");
    expect(manager.loadSnapshot).toHaveBeenCalledWith("s1");
    expect(r1).toMatchObject({ handled: true, action: "snapshot-load", snapshotId: "s1", ok: true });

    const r2 = model.activate("snapshot-load");
    expect(manager.loadSnapshot).toHaveBeenCalledWith("s2");
    expect(r2.snapshotId).toBe("s2");

    // Wraps back to the first snapshot
    const r3 = model.activate("snapshot-load");
    expect(r3.snapshotId).toBe("s1");
  });

  it("snapshot-load is a safe no-op with nothing saved", () => {
    manager.getSessionSnapshots.mockReturnValue([]);
    const r = model.activate("snapshot-load");
    expect(r).toMatchObject({ handled: true, action: "snapshot-load", ok: false, reason: "no-snapshots" });
    expect(manager.loadSnapshot).not.toHaveBeenCalled();
  });

  it("voice-mute toggles via manager.toggleVoiceMute", () => {
    const r = model.activate("voice-mute");
    expect(manager.toggleVoiceMute).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "voice-mute-toggled", muted: true });
  });

  it("voice-join toggles via manager.toggleVoiceConnection", () => {
    const r = model.activate("voice-join");
    expect(manager.toggleVoiceConnection).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "voice-connection-toggled", connected: true });
  });

  it("hide-menu sets visibility false directly, without calling the manager", () => {
    model.onSessionStart();
    expect(model.isVisible()).toBe(true);
    const r = model.activate("hide-menu");
    expect(r).toEqual({ handled: true, action: "menu-hidden" });
    expect(model.isVisible()).toBe(false);
    // Local UI chrome — must not touch any manager method.
    expect(manager.leaveSession).not.toHaveBeenCalled();
    expect(manager.activateTool).not.toHaveBeenCalled();
  });

  it("unknown button id is a no-op", () => {
    const r = model.activate("nope");
    expect(r).toEqual({ handled: false });
    expect(manager.activateTool).not.toHaveBeenCalled();
  });

  it("tolerates a manager missing methods (partial mock, no active session)", () => {
    const bare = new VRSpatialMenuModel({});
    expect(() => bare.activate("annotate")).not.toThrow();
    expect(() => bare.activate("undo")).not.toThrow();
    expect(() => bare.activate("isolation")).not.toThrow();
    expect(() => bare.activate("exit")).not.toThrow();
  });

  it("swallows a rejected leaveSession promise", () => {
    const rejecting = makeManager({ leaveSession: vi.fn(() => Promise.reject(new Error("x"))) });
    const m = new VRSpatialMenuModel(rejecting);
    expect(() => m.activate("exit")).not.toThrow();
  });
});

describe("VRSpatialMenuModel — show/hide on session lifecycle", () => {
  let manager;
  let model;
  beforeEach(() => {
    manager = makeManager();
    model = new VRSpatialMenuModel(manager);
  });

  it("is hidden until a session starts, and hidden again after it ends", () => {
    expect(model.isVisible()).toBe(false);
    model.onSessionStart();
    expect(model.isVisible()).toBe(true);
    model.onSessionEnd();
    expect(model.isVisible()).toBe(false);
  });

  it("onSessionStart pulls active tool + isolation state from the manager", () => {
    manager.getActiveTool.mockReturnValue({ id: "measure" });
    manager.isIsolated.mockReturnValue(true);
    model.onSessionStart();
    expect(model.getActiveToolId()).toBe("measure");
    expect(model.isIsolated()).toBe(true);
  });

  it("onSessionEnd clears transient highlight state", () => {
    manager.getActiveTool.mockReturnValue({ id: "annotate" });
    model.onSessionStart();
    model.onSessionEnd();
    expect(model.getActiveToolId()).toBeNull();
    expect(model.isIsolated()).toBe(false);
  });
});

describe("VRSpatialMenuModel — state reflection for render layer", () => {
  it("getButtonStates marks the active tool and isolation as active", () => {
    const manager = makeManager({
      getActiveTool: vi.fn(() => ({ id: "measure" })),
      isIsolated: vi.fn(() => true),
    });
    const model = new VRSpatialMenuModel(manager);
    model.syncFromManager();

    const states = Object.fromEntries(model.getButtonStates().map((s) => [s.id, s.active]));
    expect(states.measure).toBe(true);
    expect(states.annotate).toBe(false);
    expect(states.isolation).toBe(true);
    expect(states.undo).toBe(false);
    expect(states.exit).toBe(false);
  });

  it("syncFromManager treats a null active tool as nothing selected", () => {
    const model = new VRSpatialMenuModel(makeManager({ getActiveTool: vi.fn(() => null) }));
    model.syncFromManager();
    expect(model.getActiveToolId()).toBeNull();
  });

  it("getButtonStates marks the current scale preset as active", () => {
    const manager = makeManager({ getVRScale: vi.fn(() => 10.0) });
    const model = new VRSpatialMenuModel(manager);
    const states = Object.fromEntries(model.getButtonStates().map((s) => [s.id, s.active]));
    expect(states["scale-detail"]).toBe(true);
    expect(states["scale-normal"]).toBe(false);
    expect(states["scale-overview"]).toBe(false);
  });

  it("getButtonStates marks the Move button active when grab mode is on", () => {
    const active = new VRSpatialMenuModel(makeManager({ getNavigationMode: vi.fn(() => "grab") }));
    const off = new VRSpatialMenuModel(makeManager({ getNavigationMode: vi.fn(() => "teleport") }));
    expect(Object.fromEntries(active.getButtonStates().map((s) => [s.id, s.active])).move).toBe(true);
    expect(Object.fromEntries(off.getButtonStates().map((s) => [s.id, s.active])).move).toBe(false);
  });

  it("getButtonStates marks non-surface representation and enabled glyphs as active", () => {
    const manager = makeManager({
      getRepresentation: vi.fn(() => "wireframe"),
      isGlyphsEnabled: vi.fn(() => true),
    });
    const model = new VRSpatialMenuModel(manager);
    const states = Object.fromEntries(model.getButtonStates().map((s) => [s.id, s.active]));
    expect(states.representation).toBe(true);
    expect(states.glyphs).toBe(true);
  });

  it("getButtonStates leaves representation/glyphs inactive at defaults", () => {
    const model = new VRSpatialMenuModel(makeManager());
    const states = Object.fromEntries(model.getButtonStates().map((s) => [s.id, s.active]));
    expect(states.representation).toBe(false);
    expect(states.glyphs).toBe(false);
  });
});

describe("VRSpatialMenuModel — status line", () => {
  it("combines dataset name, scale, and nav mode", () => {
    const manager = makeManager({
      getActiveDatasetName: vi.fn(() => "skull.vtp"),
      getVRScale: vi.fn(() => 10.0),
      getNavigationMode: vi.fn(() => "teleport"),
    });
    const model = new VRSpatialMenuModel(manager);
    expect(model.getStatusLine()).toBe("skull.vtp  •  10x  •  Teleport");
  });

  it("falls back gracefully when the manager has no data", () => {
    const model = new VRSpatialMenuModel({});
    expect(() => model.getStatusLine()).not.toThrow();
    expect(model.getStatusLine()).toBe("Dataset");
  });

  it("formats sub-1.0 scale as a ratio", () => {
    const manager = makeManager({ getVRScale: vi.fn(() => 0.1), getNavigationMode: vi.fn(() => "fly") });
    const model = new VRSpatialMenuModel(manager);
    expect(model.getStatusLine()).toContain("1:10.0");
  });

  it("appends who's being followed", () => {
    const manager = makeManager({
      isFollowingParticipant: vi.fn(() => "u1"),
      getOtherParticipants: vi.fn(() => [{ odUserId: "u1", userName: "Alice" }]),
    });
    const model = new VRSpatialMenuModel(manager);
    expect(model.getStatusLine()).toContain("Following Alice");
  });

  it("appends the pending annotation label while the annotate tool is active", () => {
    const manager = makeManager({
      getActiveTool: vi.fn(() => ({ id: "annotate" })),
      getPendingAnnotationLabel: vi.fn(() => "Max"),
    });
    const model = new VRSpatialMenuModel(manager);
    model.syncFromManager();
    expect(model.getStatusLine()).toContain("Label: Max");
  });

  it("omits the label suffix when a different tool (or no tool) is active", () => {
    const manager = makeManager({
      getActiveTool: vi.fn(() => ({ id: "measure" })),
      getPendingAnnotationLabel: vi.fn(() => "Max"),
    });
    const model = new VRSpatialMenuModel(manager);
    model.syncFromManager();
    expect(model.getStatusLine()).not.toContain("Label:");
  });
});

describe("VRSpatialMenuModel — contextual row", () => {
  let manager;
  let model;
  beforeEach(() => {
    manager = makeManager();
    model = new VRSpatialMenuModel(manager);
  });

  it("adds no extra buttons when no tool, or a tool without contextual buttons (measure), is active", () => {
    expect(model.getButtonLayout()).toHaveLength(VR_MENU_BUTTONS.length);

    model.activate("measure");
    expect(model.getButtonLayout()).toHaveLength(VR_MENU_BUTTONS.length);
  });

  it("appends exactly the matching tool's contextual buttons as one extra row above TOOLS", () => {
    model.activate("clip");
    const layout = model.getButtonLayout();
    const clipContextual = VR_MENU_CONTEXTUAL_BUTTONS.filter((b) => b.contextTool === "clip");
    expect(layout).toHaveLength(VR_MENU_BUTTONS.length + clipContextual.length);

    // The contextual strip sits one row BEFORE the first static row, so it
    // renders directly above TOOLS — next to the tool whose options it holds.
    const minStaticRow = Math.min(...VR_MENU_BUTTONS.map((b) => b.row));
    const contextualRow = layout.filter((r) => r.row === minStaticRow - 1);
    expect(contextualRow.map((b) => b.id).sort()).toEqual(["clip-invert", "clip-reset"]);
  });

  it("annotate's contextual row is Mode + Label; probe's is Continuous + Clear", () => {
    model.activate("annotate");
    let ids = model.getButtonLayout().filter((b) => b.contextTool === "annotate").map((b) => b.id);
    expect(ids.sort()).toEqual(["annotation-label", "annotation-mode"]);

    model.activate("annotate"); // deactivate
    model.activate("probe");
    ids = model.getButtonLayout().filter((b) => b.contextTool === "probe").map((b) => b.id);
    expect(ids.sort()).toEqual(["probe-clear", "probe-continuous"]);
  });

  it("contextual row disappears when the tool deactivates, and its buttons become unhittable", () => {
    model.activate("clip");
    expect(model.getButtonLayout()).toHaveLength(VR_MENU_BUTTONS.length + 2);

    model.activate("clip"); // toggle off
    expect(model.getButtonLayout()).toHaveLength(VR_MENU_BUTTONS.length);
    const r = model.activate("clip-invert");
    expect(r).toEqual({ handled: false });
  });

  it("contextual row disappears when switching to a different tool", () => {
    model.activate("clip");
    expect(model.getButtonLayout().some((b) => b.id === "clip-invert")).toBe(true);

    model.activate("measure"); // switches active tool
    expect(model.getButtonLayout().some((b) => b.id === "clip-invert")).toBe(false);
  });

  it("clip-invert/clip-reset route through the manager", () => {
    model.activate("clip");
    const r1 = model.activate("clip-invert");
    expect(manager.invertClipPlane).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ handled: true, action: "clip-inverted" });

    const r2 = model.activate("clip-reset");
    expect(manager.resetClipPlane).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ handled: true, action: "clip-reset" });
  });

  it("annotation-mode routes through manager.cycleAnnotationMode", () => {
    model.activate("annotate");
    const r = model.activate("annotation-mode");
    expect(manager.cycleAnnotationMode).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ handled: true, action: "annotation-mode-changed", mode: "text" });
  });

  it("probe-continuous/probe-clear route through the manager", () => {
    model.activate("probe");
    const r1 = model.activate("probe-continuous");
    expect(manager.toggleProbeContinuous).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ handled: true, action: "probe-continuous-toggled", enabled: true });

    const r2 = model.activate("probe-clear");
    expect(manager.clearProbeHistory).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ handled: true, action: "probe-history-cleared" });
  });

  it("getButtonStates reflects probe-continuous active state while probe is active", () => {
    manager.isProbeContinuous.mockReturnValue(true);
    model.activate("probe");
    const states = Object.fromEntries(model.getButtonStates().map((s) => [s.id, s.active]));
    expect(states["probe-continuous"]).toBe(true);
  });
});

describe("VRSpatialMenuModel — hint line", () => {
  it("shows the active tool's control summary", () => {
    const model = new VRSpatialMenuModel(makeManager());
    model.activate("clip");
    expect(model.getHintLine()).toBe("Grip+drag to aim, A to invert, B to reset");
  });

  it("falls back to the current nav mode's controls when no tool is active", () => {
    const manager = makeManager({
      getNavigationModeInfo: vi.fn(() => ({ name: "Teleport", controls: "Hold thumbstick to aim, release to teleport" })),
    });
    const model = new VRSpatialMenuModel(manager);
    expect(model.getHintLine()).toBe("Hold thumbstick to aim, release to teleport");
  });

  it("never throws with a manager missing getNavigationModeInfo", () => {
    const model = new VRSpatialMenuModel({});
    expect(() => model.getHintLine()).not.toThrow();
    expect(model.getHintLine()).toBe("");
  });
});
