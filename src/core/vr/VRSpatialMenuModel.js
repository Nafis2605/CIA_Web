// src/core/vr/VRSpatialMenuModel.js
// ----------------------------------------------------------------------------
// VR Spatial Menu Model — pure layout + hit-test + action-dispatch logic
// ----------------------------------------------------------------------------
//
// WHY THIS EXISTS
// WebXR immersive sessions (Safari/visionOS and most browsers) do NOT render
// the DOM, so a React component like VRWristMenu is invisible in-headset. The
// guaranteed in-session UI is therefore drawn as in-scene VTK geometry by
// VTKVRSpatialUI. This module is the geometry-free brain of that panel:
//
//   - button layout (id → local-space rect on the panel quad)
//   - hit testing (a UV point on the panel → which button, if any)
//   - action dispatch (button id → a call on the injected manager surface)
//   - show/hide bookkeeping keyed on VR session start/end
//   - selected-tool / isolation reflection so the panel never disagrees with
//     the manager (single source of truth = VRExplorationManager state)
//
// It holds NO React and NO VTK references — everything visual/stateful lives
// behind the `manager` surface injected at construction. That keeps it unit
// testable in jsdom and keeps core/ free of UI deps.
//
// COORDINATE CONVENTION
// The panel is a unit quad in "panel UV" space: u ∈ [0,1] left→right,
// v ∈ [0,1] bottom→top. Buttons are laid out in one or more equal-width
// horizontal rows, stacked bottom→top by ascending `row` index (row 0 is the
// bottom row). VTKVRSpatialUI maps this UV space onto a world-space quad
// anchored in front of the head; the raycast hit it feeds back in is already
// reduced to a (u, v) pair, so this module stays free of 3D math.

import { vr as log } from "@Utils/logger.js";

/**
 * Button descriptors, left→right within each row, rows bottom→top. `kind`
 * drives dispatch:
 *   - "tool":              toggles a VR tool (annotate/measure/clip/probe) via the manager
 *   - "action":            a one-shot command (undo)
 *   - "toggle":            a stateful toggle (isolation/grid) reflected from manager
 *   - "nav-mode":          cycles the locomotion mode (fly/teleport/walk)
 *   - "nav-mode-set":      toggles a specific locomotion mode on/off (grab/walk)
 *   - "scale":             jumps to a fixed vrScale preset
 *   - "representation":    cycles surface→wireframe→points (same as desktop menu)
 *   - "glyph-toggle":      toggles vector/scalar glyphs (same as desktop menu)
 *   - "snapshot-save":     quick-saves a session snapshot
 *   - "snapshot-load":     cycles to the next saved snapshot and loads it
 *   - "voice-mute":        toggles the local participant's voice mute state
 *   - "voice-join":        joins/leaves the session's voice room
 *   - "toggle-visibility": hides the panel (local UI chrome, no manager call)
 *   - "exit":              leave the VR session
 * @type {ReadonlyArray<{id:string,label:string,icon:string,kind:string,toolId?:string,scaleValue?:number,mode?:string,row:number}>}
 */
export const VR_MENU_BUTTONS = Object.freeze([
  // ---- Row 0 — TOOLS: create / measure / inspect on the data ---------------
  // annotate stays first (VTKVRSpatialUI/tests rely on row 0 starting with it).
  { id: "annotate", label: "Annotate", icon: "edit", kind: "tool", toolId: "annotate", row: 0, group: "TOOLS" },
  { id: "measure", label: "Measure", icon: "ruler", kind: "tool", toolId: "measure", row: 0, group: "TOOLS" },
  { id: "clip", label: "Clip", icon: "crop", kind: "tool", toolId: "clip", row: 0, group: "TOOLS" },
  { id: "probe", label: "Probe", icon: "crosshair", kind: "tool", toolId: "probe", row: 0, group: "TOOLS" },
  { id: "undo", label: "Undo", icon: "rotateCcw", kind: "action", row: 0, group: "TOOLS" },

  // ---- Row 1 — MOVE: locomotion + object manipulation ----------------------
  // These are mutually exclusive modes. The selected mode decides what the
  // TRIGGER does; grip always pulls the world and the left stick always moves
  // (see VRNavigationController.update's layered model).
  { id: "nav-mode", label: "Nav", icon: "compass", kind: "nav-mode", row: 1, group: "MOVE" },
  // "grab": trigger stays free (tools/menu); grip pulls the world.
  { id: "move", label: "Move", icon: "move", kind: "nav-mode-set", mode: "grab", row: 1, group: "MOVE" },
  // "move-object": trigger drags the ACTIVE dataset's transform for every
  // collaborator (shared), not just the local view.
  { id: "move-object", label: "Move Obj", icon: "transform", kind: "nav-mode-set", mode: "move-object", row: 1, group: "MOVE" },
  { id: "walk", label: "Walk", icon: "footprints", kind: "nav-mode-set", mode: "walk", row: 1, group: "MOVE" },
  // "teleport": trigger aims the arc and commits on release.
  { id: "teleport", label: "Teleport", icon: "zap", kind: "nav-mode-set", mode: "teleport", row: 1, group: "MOVE" },

  // ---- Row 2 — VIEW: scale + appearance ------------------------------------
  // scaleValue matches VRScaleController's preset numbers (small=overview,
  // large=detail); representation/glyphs reuse the desktop implementations so
  // VR and desktop stay consistent.
  { id: "scale-overview", label: "Overview", icon: "minimize", kind: "scale", scaleValue: 0.1, row: 2, group: "VIEW" },
  { id: "scale-normal", label: "Normal", icon: "square", kind: "scale", scaleValue: 1.0, row: 2, group: "VIEW" },
  { id: "scale-detail", label: "Detail", icon: "maximize", kind: "scale", scaleValue: 10.0, row: 2, group: "VIEW" },
  // Two drawers replace what used to be a single blind "Style" cycling button.
  // Cycling gave no way to see which representation was live (and its highlight
  // was "active if not surface", so wireframe and points looked identical), and
  // there was nowhere to put threshold/isosurface at all. See VR_MENU_DRAWERS.
  { id: "appearance", label: "Style", icon: "cube", kind: "drawer", drawerId: "appearance", row: 2, group: "VIEW" },
  { id: "filters", label: "Filters", icon: "filter", kind: "drawer", drawerId: "filters", row: 2, group: "VIEW" },
  { id: "glyphs", label: "Glyphs", icon: "arrowUpRight", kind: "glyph-toggle", row: 2, group: "VIEW" },

  // ---- Row 3 — SCENE: what is shown, and saving/restoring it ---------------
  { id: "isolation", label: "Isolate", icon: "fullscreen", kind: "toggle", row: 3, group: "SCENE" },
  // Labelled "Views", not "Grid": this lays out your OTHER open views in space
  // (VRMultiViewGrid) and has nothing to do with a reference grid. The id stays
  // "grid" so _toggleGrid/isGridModeEnabled/getButtonStates and the existing
  // tests keep working — only the user-facing label was ever wrong.
  { id: "grid", label: "Views", icon: "layoutGrid", kind: "toggle", row: 3, group: "SCENE" },
  { id: "ref-grid", label: "Grid", icon: "grid", kind: "scene-grid", row: 3, group: "SCENE" },
  { id: "axes", label: "Axes", icon: "axis3d", kind: "scene-axes", row: 3, group: "SCENE" },
  { id: "snapshot-save", label: "Save", icon: "save", kind: "snapshot-save", row: 3, group: "SCENE" },
  { id: "snapshot-load", label: "Load", icon: "folderOpen", kind: "snapshot-load", row: 3, group: "SCENE" },

  // ---- Row 4 — SESSION: other people, voice, and leaving -------------------
  // Go To/Follow cycle through other session participants rather than a full
  // per-user list (keeps the fixed-cell UV grid simple) — every tap still does
  // something real, just "next collaborator" instead of "this specific one".
  // exit stays last (VTKVRSpatialUI/tests rely on the last row ending with it).
  { id: "goto-participant", label: "Go To", icon: "target", kind: "goto-participant", row: 4, group: "SESSION" },
  { id: "follow-participant", label: "Follow", icon: "user", kind: "follow-participant", row: 4, group: "SESSION" },
  { id: "voice-join", label: "Voice", icon: "headsetMic", kind: "voice-join", row: 4, group: "SESSION" },
  { id: "voice-mute", label: "Mute", icon: "mic", kind: "voice-mute", row: 4, group: "SESSION" },
  { id: "hide-menu", label: "Hide", icon: "eyeOff", kind: "toggle-visibility", row: 4, group: "SESSION" },
  { id: "exit", label: "Exit VR", icon: "doorOpen", kind: "exit", row: 4, group: "SESSION" },
]);

/**
 * The shared numeric stepper row, instantiated into every drawer.
 *
 * Kept as a factory rather than a constant so each drawer gets its own frozen
 * copies (with its own `drawerRow`) while the ids and kinds stay identical —
 * one set of handlers, one active target, regardless of which drawer is open.
 *
 * @param {number} drawerRow - which row within the drawer these occupy
 * @returns {Array<object>}
 */
function STEPPER_ROW_TEMPLATE(drawerRow) {
  return [
    { id: "value-target", label: "Target", icon: "target", kind: "value-target", drawerRow, group: "VIEW" },
    { id: "value-dec", label: "−", icon: "minus", kind: "value-nudge", steps: -1, drawerRow, group: "VIEW" },
    { id: "value-inc", label: "+", icon: "plus", kind: "value-nudge", steps: 1, drawerRow, group: "VIEW" },
    { id: "value-reset", label: "Reset", icon: "restore", kind: "value-reset", drawerRow, group: "VIEW" },
  ];
}

/**
 * Drawers: extra button rows that appear above the static grid while their
 * parent button is open, and vanish when it closes. Exactly one drawer may be
 * open at a time — that mutual exclusion is what bounds the panel's height.
 *
 * The `value-*` stepper row is DELIBERATELY shared by both drawers (same ids,
 * same kinds, one set of handlers). One stepper retargeted via `value-target`
 * serves every numeric parameter — point size, line width, threshold bounds,
 * isovalue, opacity — instead of each growing its own control. That is what
 * makes these fit on the panel at all.
 *
 * Why buttons and not a thumbstick: `_gatherInputState` hardcodes
 * `thumbstick:{x:0,y:0}`, `squeezePressed:false` and `buttons:{a:false,b:false}`
 * for Vision Pro transient pointers, so a thumbstick-driven value control
 * simply would not exist there. Discrete taps use the trigger/pinch — the only
 * input guaranteed on both Quest and Vision Pro.
 *
 * @type {Readonly<Object<string, ReadonlyArray<object>>>}
 */
export const VR_MENU_DRAWERS = Object.freeze({
  appearance: Object.freeze([
    { id: "rep-surface", label: "Surface", icon: "square", kind: "representation-set", mode: "surface", drawerRow: 0, group: "VIEW" },
    { id: "rep-wireframe", label: "Wire", icon: "grid", kind: "representation-set", mode: "wireframe", drawerRow: 0, group: "VIEW" },
    { id: "rep-points", label: "Points", icon: "dotsHorizontal", kind: "representation-set", mode: "points", drawerRow: 0, group: "VIEW" },
    { id: "grid-plane", label: "Plane", icon: "layers", kind: "grid-plane", drawerRow: 0, group: "VIEW" },
    ...STEPPER_ROW_TEMPLATE(1),
  ]),
  filters: Object.freeze([
    { id: "threshold-toggle", label: "Threshold", icon: "filter", kind: "threshold-toggle", drawerRow: 0, group: "VIEW" },
    { id: "threshold-mode", label: "Mode", icon: "sliders", kind: "threshold-mode", drawerRow: 0, group: "VIEW" },
    { id: "threshold-array", label: "Array", icon: "database", kind: "threshold-array", drawerRow: 0, group: "VIEW" },
    { id: "iso-toggle", label: "Isosurface", icon: "layers", kind: "iso-toggle", drawerRow: 0, group: "VIEW" },
    ...STEPPER_ROW_TEMPLATE(1),
  ]),
});

/**
 * Ordered activity groups, one per static row (top → bottom). Drives the
 * per-group card border accent and the row labels drawn on the backing panel
 * (see VTKVRSpatialUI), so the grouping is visible in-headset rather than only
 * implied by position.
 * @type {ReadonlyArray<string>}
 */
export const VR_MENU_GROUPS = Object.freeze([
  "TOOLS",
  "MOVE",
  "VIEW",
  "SCENE",
  "SESSION",
]);

/**
 * Contextual buttons: only appear (as an extra row above the static rows)
 * while the matching tool (`contextTool`) is active. Measure gets no entry —
 * the global "Undo" button already cancels an in-progress measurement or
 * removes the last completed one (see VRMeasureTool.undoLast), so a redundant
 * Cancel button would just duplicate it.
 * @type {ReadonlyArray<{id:string,label:string,icon:string,kind:string,contextTool:string}>}
 */
export const VR_MENU_CONTEXTUAL_BUTTONS = Object.freeze([
  // Measure builds a CHAINED path: each pick continues from the last. "New
  // Path" is how you start a disconnected measurement somewhere else without
  // undoing everything. Undo still pops one point at a time.
  { id: "measure-new-path", label: "New Path", icon: "plus", kind: "measure-new-path", contextTool: "measure", group: "TOOLS" },
  { id: "clip-invert", label: "Invert", icon: "flipHorizontal", kind: "clip-invert", contextTool: "clip", group: "TOOLS" },
  // Snap the cut to a principal axis. Matters most on Vision Pro, where there
  // is no grip to brace against while free-aiming a plane by hand.
  { id: "clip-axis", label: "Axis", icon: "axis3d", kind: "clip-axis", contextTool: "clip", group: "TOOLS" },
  { id: "clip-reset", label: "Reset", icon: "restore", kind: "clip-reset", contextTool: "clip", group: "TOOLS" },
  // Replaced an "annotation mode" cycle (marker/text/drawing) that changed only
  // stored metadata — every mode drew the same sphere. Colour is small but
  // actually visible, and already flows through to persistence.
  { id: "annotation-color", label: "Color", icon: "palette", kind: "annotation-color", contextTool: "annotate", group: "TOOLS" },
  // Cycles the annotate tool's pending preset label — the only VR text-entry
  // mechanism (see ANNOTATION_LABEL_PRESETS in VRAnnotationTool.js). Contextual
  // rather than static: it is meaningless unless the annotate tool is active,
  // and moving it here freed its grid slot for the Teleport mode button.
  { id: "annotation-label", label: "Label", icon: "tag", kind: "annotation-label", contextTool: "annotate", group: "TOOLS" },
  { id: "probe-continuous", label: "Continuous", icon: "sync", kind: "probe-continuous", contextTool: "probe", group: "TOOLS" },
  { id: "probe-clear", label: "Clear", icon: "trash", kind: "probe-clear", contextTool: "probe", group: "TOOLS" },
]);

// Fraction of each cell's width/height left as inner padding (per side).
const CELL_PADDING = 0.06;

// How long a local tool tap is trusted over the manager's reported active tool.
// Covers the async activate/deactivate round-trip (see syncFromManager).
const TOOL_SYNC_HOLD_MS = 250;

/**
 * VRSpatialMenuModel
 *
 * @param {object} manager - Injected manager surface (VRExplorationManager).
 *   Only the methods used below are required; each call is guarded so a
 *   partial mock (or a manager without an active session) never throws.
 */
export class VRSpatialMenuModel {
  constructor(manager) {
    this._manager = manager || null;
    this._visible = false;
    // Local mirror of the active tool id, kept in sync via syncFromManager()
    // and updated optimistically on tap so highlight feedback is immediate.
    this._activeToolId = null;
    this._isolated = false;
    this._gridEnabled = false;
    // Which drawer (if any) is expanded. At most one at a time — that mutual
    // exclusion is what bounds the panel's height (see VR_MENU_DRAWERS).
    this._openDrawerId = null;
    // Cycle position through getOtherParticipants() for the Go To/Follow
    // buttons — see _pickNextParticipant.
    this._participantCycleIndex = -1;
    // Cycle position through getSessionSnapshots() for the Load button — see
    // _loadNextSnapshot. Same "cycle to next X" pattern as participants.
    this._snapshotCycleIndex = -1;
    // Timestamp of the last local tool tap, so syncFromManager() can briefly
    // trust the optimistic _activeToolId over the manager's lagging async
    // getActiveTool(). Null when there is no tap to honour.
    this._toolTapAtMs = null;
  }

  // ===========================================================================
  // LAYOUT
  // ===========================================================================

  /**
   * Compute button hit regions in panel-UV space (u,v ∈ [0,1]).
   * Buttons are grouped by `row` (row 0 = bottom), each row laid out as an
   * equal-width horizontal strip, rows stacked bottom→top. Returned rects
   * are inset by CELL_PADDING so adjacent buttons/rows don't share an edge
   * (avoids ambiguous hits). With a single row this reduces to exactly the
   * original one-row layout.
   *
   * When a tool with contextual buttons (VR_MENU_CONTEXTUAL_BUTTONS) is
   * active, its buttons are appended as one extra row above the static rows
   * — so the panel grows by exactly one row while a contextual tool is
   * active, and shrinks back the moment it deactivates.
   *
   * @returns {Array<{id:string,label:string,icon:string,kind:string,
   *   toolId?:string, row:number, u0:number,u1:number,v0:number,v1:number,
   *   cu:number,cv:number}>} cu/cv = cell center (for placing labels/icons)
   */
  getButtonLayout() {
    const contextual = VR_MENU_CONTEXTUAL_BUTTONS.filter(
      (b) => b.contextTool === this._activeToolId
    );
    const drawer = this._openDrawerId
      ? VR_MENU_DRAWERS[this._openDrawerId] || []
      : [];

    // Extra rows stack ABOVE the static grid, assigned negative row indices
    // (which sort before every static row and, with the top-down v inversion
    // below, render upward toward eye level). Drawer rows go nearest the static
    // grid — right under the drawer button that opened them — and the
    // contextual row sits above those, next to the tool whose options it holds.
    //
    // Grouping drawer buttons by their own `drawerRow` first keeps a
    // multi-row drawer's internal order intact no matter how many rows it has.
    const extraRows = [];
    if (drawer.length) {
      const byDrawerRow = new Map();
      for (const btn of drawer) {
        const r = btn.drawerRow ?? 0;
        if (!byDrawerRow.has(r)) byDrawerRow.set(r, []);
        byDrawerRow.get(r).push(btn);
      }
      // Descending, because extraRows are assigned progressively MORE negative
      // rows (-1, -2, ...) and more-negative renders higher up the panel. Put
      // the drawer's own row 0 LAST here and it lands topmost, so a drawer
      // reads top-down in its declared order — same as the static grid does.
      const drawerRowIds = [...byDrawerRow.keys()].sort((a, b) => b - a);
      for (const r of drawerRowIds) extraRows.push(byDrawerRow.get(r));
    }
    if (contextual.length) extraRows.push(contextual);

    let allButtons = VR_MENU_BUTTONS;
    if (extraRows.length) {
      const minStaticRow = Math.min(...VR_MENU_BUTTONS.map((b) => b.row ?? 0));
      allButtons = [
        ...VR_MENU_BUTTONS,
        ...extraRows.flatMap((buttons, i) =>
          buttons.map((b) => ({ ...b, row: minStaticRow - 1 - i }))
        ),
      ];
    }

    const rows = new Map();
    for (const btn of allButtons) {
      const rowId = btn.row ?? 0;
      if (!rows.has(rowId)) rows.set(rowId, []);
      rows.get(rowId).push(btn);
    }
    const rowIds = [...rows.keys()].sort((a, b) => a - b);
    const rowH = 1 / rowIds.length;

    const layout = [];
    rowIds.forEach((rowId, rowIndex) => {
      const buttons = rows.get(rowId);
      const n = buttons.length;
      const cellW = 1 / n;
      const padU = cellW * CELL_PADDING;
      const padV = rowH * CELL_PADDING;
      // v runs along +up, so the LAST row index must sit at v=0 for the FIRST
      // declared row to render at the TOP. Without this inversion the panel
      // read bottom-up (tools at the floor, session controls at eye level),
      // the opposite of the declaration order and of how the groups read.
      const vBase = (rowIds.length - 1 - rowIndex) * rowH;

      buttons.forEach((btn, i) => {
        const u0 = i * cellW + padU;
        const u1 = (i + 1) * cellW - padU;
        const v0 = vBase + padV;
        const v1 = vBase + rowH - padV;
        layout.push({
          ...btn,
          u0,
          u1,
          v0,
          v1,
          cu: (u0 + u1) / 2,
          cv: (v0 + v1) / 2,
        });
      });
    });
    return layout;
  }

  // ===========================================================================
  // HIT TESTING
  // ===========================================================================

  /**
   * Which button (if any) a panel-UV point lands on.
   * Out-of-range or non-finite input returns null (a miss), never throws.
   *
   * @param {number} u - horizontal fraction across the panel [0,1]
   * @param {number} v - vertical fraction up the panel [0,1]
   * @returns {object|null} the layout entry hit, or null
   */
  hitTest(u, v) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    for (const region of this.getButtonLayout()) {
      if (u >= region.u0 && u <= region.u1 && v >= region.v0 && v <= region.v1) {
        return region;
      }
    }
    return null;
  }

  // ===========================================================================
  // ACTION DISPATCH
  // ===========================================================================

  /**
   * Dispatch the action for a button id against the injected manager.
   * Returns a small result object describing what happened (handy for tests
   * and for the render layer to update highlights) rather than throwing on a
   * missing/absent manager method.
   *
   * Single source of truth: tool selection goes through
   * manager.activateTool/deactivateTool, isolation through
   * manager.toggleIsolation (same path as the B-button), undo emits the same
   * annotation-removed action the A-button uses, and exit calls leaveSession.
   *
   * @param {string} buttonId
   * @returns {{handled:boolean, action?:string, toolId?:string|null,
   *   isolated?:boolean}}
   */
  activate(buttonId) {
    // Look up against the CURRENT layout (static + active-contextual), not the
    // frozen static constant, so contextual buttons are dispatchable while
    // their tool is active, and a stale id from a since-deactivated tool
    // safely falls through to the "unknown button" no-op below.
    const btn = this.getButtonLayout().find((b) => b.id === buttonId);
    if (!btn) {
      log.warn(`VRSpatialMenu: unknown button "${buttonId}"`);
      return { handled: false };
    }

    switch (btn.kind) {
      case "tool":
        return this._activateTool(btn.toolId);
      case "action":
        // Currently only "undo"
        return this._undo();
      case "toggle":
        return btn.id === "grid" ? this._toggleGrid() : this._toggleIsolation();
      case "drawer":
        return this._toggleDrawer(btn.drawerId);
      case "nav-mode":
        return this._cycleNavMode();
      case "nav-mode-set":
        return this._setNavMode(btn.mode);
      case "scale":
        return this._setScale(btn.scaleValue, btn.id);
      case "goto-participant":
        return this._gotoNextParticipant();
      case "follow-participant":
        return this._toggleFollowNextParticipant();
      case "annotation-label":
        return this._cycleAnnotationLabel();
      case "representation":
        return this._cycleRepresentation();
      case "representation-set":
        return this._setRepresentation(btn.mode);
      case "glyph-toggle":
        return this._toggleGlyphs();
      // --- Scene chrome (data reference grid + labelled axes) ---------------
      case "scene-grid":
        return this._toggleReferenceGrid();
      case "scene-axes":
        return this._toggleDataAxes();
      case "grid-plane":
        return this._cycleGridPlane();
      // --- Filters ----------------------------------------------------------
      case "threshold-toggle":
        return this._toggleThreshold();
      case "threshold-mode":
        return this._cycleThresholdMode();
      case "threshold-array":
        return this._cycleThresholdArray();
      case "iso-toggle":
        return this._toggleIsosurface();
      // --- Shared numeric stepper (see VR_MENU_DRAWERS) ----------------------
      case "value-target":
        return this._cycleValueTarget();
      case "value-nudge":
        return this._nudgeValue(btn.steps);
      case "value-reset":
        return this._resetValue();
      case "measure-new-path":
        return this._measureNewPath();
      case "clip-axis":
        return this._cycleClipAxis();
      case "clip-invert":
        return this._invertClipPlane();
      case "clip-reset":
        return this._resetClipPlane();
      case "annotation-color":
        return this._cycleAnnotationColor();
      case "probe-continuous":
        return this._toggleProbeContinuous();
      case "probe-clear":
        return this._clearProbeHistory();
      case "snapshot-save":
        return this._saveSnapshot();
      case "snapshot-load":
        return this._loadNextSnapshot();
      case "voice-mute":
        return this._toggleVoiceMute();
      case "voice-join":
        return this._toggleVoiceConnection();
      case "toggle-visibility":
        return this._hideMenu();
      case "exit":
        return this._exit();
      default:
        return { handled: false };
    }
  }

  /**
   * Cycles fly → teleport → walk via the same VRNavigationController the
   * launch modal's dropdown drives (VRExplorationManager.cycleNavigationMode).
   */
  _cycleNavMode() {
    const mode = this._call("cycleNavigationMode");
    return { handled: true, action: "nav-mode-changed", mode: mode ?? null };
  }

  /**
   * Toggles a specific locomotion mode (grab / move-object / walk / teleport).
   * Tapping the button of the ALREADY-active mode drops back to "fly" — the
   * neutral default where the left stick flies, grip pulls the world, and the
   * trigger stays free for tools and the menu. (It used to fall back to
   * "teleport", which silently parked the user in a mode whose trigger is
   * captured by teleport aiming; teleport is now its own explicit button.)
   * Uses the same VRExplorationManager.setNavigationMode the launch modal's
   * dropdown drives.
   * @private
   */
  _setNavMode(mode) {
    const current = this._call("getNavigationMode");
    const next = current === mode ? "fly" : mode;
    this._call("setNavigationMode", next);
    return { handled: true, action: "nav-mode-set", mode: next };
  }

  /** Jumps directly to a fixed vrScale (VRExplorationManager.setVRScale). */
  _setScale(scaleValue, buttonId) {
    this._call("setVRScale", scaleValue);
    return { handled: true, action: "scale-changed", scaleValue, buttonId };
  }

  /**
   * Advances to the next other participant (wrapping), for both Go To and
   * Follow — a stable cycle order so repeated taps step through everyone
   * rather than jumping around.
   * @private
   */
  _pickNextParticipant() {
    const others = this._call("getOtherParticipants") || [];
    if (!others.length) return null;
    this._participantCycleIndex = (this._participantCycleIndex + 1) % others.length;
    return others[this._participantCycleIndex]?.odUserId ?? null;
  }

  _gotoNextParticipant() {
    const userId = this._pickNextParticipant();
    if (!userId) {
      return { handled: true, action: "goto-participant", ok: false, reason: "no-participants" };
    }
    const ok = !!this._call("goToParticipant", userId);
    return { handled: true, action: "goto-participant", userId, ok };
  }

  /** Toggles off if already following anyone; otherwise follows the next participant. */
  _toggleFollowNextParticipant() {
    if (this._call("isFollowingParticipant")) {
      this._call("stopFollowing");
      return { handled: true, action: "follow-participant", following: null };
    }
    const userId = this._pickNextParticipant();
    if (!userId) {
      return { handled: true, action: "follow-participant", following: null, reason: "no-participants" };
    }
    this._call("followParticipant", userId);
    return { handled: true, action: "follow-participant", following: userId };
  }

  /** Advances the active tool's pending preset annotation label (see VRAnnotationTool.cycleLabel). */
  _cycleAnnotationLabel() {
    const label = this._call("cycleAnnotationLabel");
    if (label == null) {
      return { handled: true, action: "annotation-label-changed", label: null, reason: "no-active-tool" };
    }
    return { handled: true, action: "annotation-label-changed", label };
  }

  /**
   * Cycles surface → wireframe → points through the same desktop
   * implementation (VRExplorationManager.cycleRepresentation → instanceTools),
   * so a VR tap and a desktop menu click are indistinguishable to collaborators.
   */
  _cycleRepresentation() {
    const mode = this._call("cycleRepresentation");
    return { handled: true, action: "representation-changed", mode: mode ?? null };
  }

  /**
   * Set one specific representation (the Appearance drawer's Surface/Wire/
   * Points buttons), rather than blind-cycling. Cycling gave no way to see
   * which mode was live, and its highlight was "active if not surface" — so
   * wireframe and points were indistinguishable on the panel.
   * @param {'surface'|'wireframe'|'points'} mode
   * @private
   */
  _setRepresentation(mode) {
    const applied = this._call("setRepresentation", mode);
    return {
      handled: true,
      action: "representation-changed",
      mode: applied === undefined ? mode : applied ?? null,
    };
  }

  /**
   * Toggle the data reference grid. Distinct from the "Views" button, which
   * toggles VRMultiViewGrid (other open views laid out in space).
   * @private
   */
  _toggleReferenceGrid() {
    const visible = this._call("toggleReferenceGrid");
    return { handled: true, action: "reference-grid-toggled", visible: !!visible };
  }

  /** Toggle the labelled data axes. @private */
  _toggleDataAxes() {
    const visible = this._call("toggleDataAxes");
    return { handled: true, action: "data-axes-toggled", visible: !!visible };
  }

  /** Cycle the reference grid's plane (xz -> xy -> yz). @private */
  _cycleGridPlane() {
    const plane = this._call("cycleGridPlane");
    return { handled: true, action: "grid-plane-changed", plane: plane ?? null };
  }

  /**
   * Toggle the threshold filter. Reports `available:false` rather than
   * pretending to work when the dataset has no scalar arrays to threshold on —
   * the render layer dims the card so a tap that cannot do anything at least
   * says so (same reasoning as the Views button's "no-other-views").
   * @private
   */
  _toggleThreshold() {
    if (this._call("isThresholdAvailable") === false) {
      return { handled: false, action: "threshold-toggled", available: false };
    }
    const enabled = this._call("toggleThresholdFilter");
    return { handled: true, action: "threshold-toggled", enabled: !!enabled, available: true };
  }

  /** Cycle threshold mode (between -> above -> below). @private */
  _cycleThresholdMode() {
    const mode = this._call("cycleThresholdMode");
    return { handled: true, action: "threshold-mode-changed", mode: mode ?? null };
  }

  /** Cycle which scalar array the threshold acts on. @private */
  _cycleThresholdArray() {
    const arrayName = this._call("cycleThresholdArray");
    return { handled: true, action: "threshold-array-changed", arrayName: arrayName ?? null };
  }

  /**
   * Toggle isosurface extraction. Requires volume/image data, so it is inert
   * (and dimmed) for plain polydata.
   * @private
   */
  _toggleIsosurface() {
    if (this._call("isIsosurfaceAvailable") === false) {
      return { handled: false, action: "isosurface-toggled", available: false };
    }
    const enabled = this._call("toggleIsosurface");
    return { handled: true, action: "isosurface-toggled", enabled: !!enabled, available: true };
  }

  /** Retarget the shared stepper to the next editable value. @private */
  _cycleValueTarget() {
    const target = this._call("cycleValueTarget");
    return { handled: true, action: "value-target-changed", targetId: target ?? null };
  }

  /**
   * Step the active numeric target up or down.
   * @param {number} steps - signed step count (+1 / -1)
   * @private
   */
  _nudgeValue(steps) {
    const value = this._call("nudgeValue", steps);
    return { handled: true, action: "value-nudged", steps, value: value ?? null };
  }

  /** Restore the active numeric target to its default. @private */
  _resetValue() {
    const value = this._call("resetValue");
    return { handled: true, action: "value-reset", value: value ?? null };
  }

  /** Cycle the clip plane's axis constraint (free -> X -> Y -> Z). @private */
  _cycleClipAxis() {
    const axis = this._call("cycleClipAxis");
    return { handled: true, action: "clip-axis-changed", axis: axis ?? null };
  }

  /** Archive the active measurement path and start a fresh one. @private */
  _measureNewPath() {
    const path = this._call("startNewMeasurementPath");
    return { handled: true, action: "measure-new-path", path: path ?? null };
  }

  /** Toggles glyphs via the same desktop VTKGlyphFeature (VRExplorationManager.toggleGlyphs). */
  _toggleGlyphs() {
    const enabled = !!this._call("toggleGlyphs");
    return { handled: true, action: "glyphs-toggled", enabled };
  }

  /** Inverts the active Clip tool's plane direction (VRExplorationManager.invertClipPlane). */
  _invertClipPlane() {
    this._call("invertClipPlane");
    return { handled: true, action: "clip-inverted" };
  }

  /** Resets the active Clip tool's plane (VRExplorationManager.resetClipPlane). */
  _resetClipPlane() {
    this._call("resetClipPlane");
    return { handled: true, action: "clip-reset" };
  }

  /** Cycles the active Annotate tool's placement mode: marker → text → drawing. */
  _cycleAnnotationColor() {
    const color = this._call("cycleAnnotationColor");
    return { handled: true, action: "annotation-color-changed", color: color ?? null };
  }

  /** Toggles the active Probe tool's continuous-sampling mode. */
  _toggleProbeContinuous() {
    const enabled = !!this._call("toggleProbeContinuous");
    return { handled: true, action: "probe-continuous-toggled", enabled };
  }

  /** Clears the active Probe tool's sample history. */
  _clearProbeHistory() {
    this._call("clearProbeHistory");
    return { handled: true, action: "probe-history-cleared" };
  }

  /**
   * Quick-saves a VR session snapshot (VRExplorationManager.createSnapshot).
   * Fire-and-forget like _exit() — createSnapshot is async, but dispatch must
   * return synchronously.
   * @private
   */
  _saveSnapshot() {
    try {
      const r = this._call("createSnapshot");
      if (r && typeof r.catch === "function") {
        r.catch((err) => log.warn("VR snapshot save failed:", err?.message));
      }
    } catch (err) {
      log.warn("VR snapshot save threw:", err?.message);
    }
    return { handled: true, action: "snapshot-saved" };
  }

  /**
   * Cycles to the next saved session snapshot and loads it — mirrors
   * _pickNextParticipant's "cycle to next X" pattern since there's no
   * per-item picker UI in VR.
   * @private
   */
  _loadNextSnapshot() {
    const snapshots = this._call("getSessionSnapshots") || [];
    if (!snapshots.length) {
      return { handled: true, action: "snapshot-load", ok: false, reason: "no-snapshots" };
    }
    this._snapshotCycleIndex = (this._snapshotCycleIndex + 1) % snapshots.length;
    const snap = snapshots[this._snapshotCycleIndex];
    try {
      const r = this._call("loadSnapshot", snap?.id);
      if (r && typeof r.catch === "function") {
        r.catch((err) => log.warn("VR snapshot load failed:", err?.message));
      }
    } catch (err) {
      log.warn("VR snapshot load threw:", err?.message);
    }
    return { handled: true, action: "snapshot-load", snapshotId: snap?.id ?? null, ok: true };
  }

  /** Toggles the local participant's voice mute state (voiceRoomService via manager). */
  _toggleVoiceMute() {
    const muted = !!this._call("toggleVoiceMute");
    return { handled: true, action: "voice-mute-toggled", muted };
  }

  /** Joins or leaves the session's voice room (voiceRoomService via manager). */
  _toggleVoiceConnection() {
    const connected = !!this._call("toggleVoiceConnection");
    return { handled: true, action: "voice-connection-toggled", connected };
  }

  /**
   * Open/close a drawer. Local UI chrome only — no manager call.
   *
   * Tapping the open drawer closes it; tapping a different one switches to it.
   * Opening is exclusive by construction (a single `_openDrawerId`, not a set),
   * which is what caps the panel at a comfortable height: 5 static rows + at
   * most 2 drawer rows + at most 1 contextual row.
   *
   * @param {string} drawerId - key into VR_MENU_DRAWERS
   * @returns {{handled:boolean, action:string, drawerId:string|null, open:boolean}}
   * @private
   */
  _toggleDrawer(drawerId) {
    if (!drawerId || !VR_MENU_DRAWERS[drawerId]) {
      log.warn(`VRSpatialMenu: unknown drawer "${drawerId}"`);
      return { handled: false, action: "drawer-toggled", drawerId: null, open: false };
    }
    const open = this._openDrawerId !== drawerId;
    this._openDrawerId = open ? drawerId : null;
    return { handled: true, action: "drawer-toggled", drawerId, open };
  }

  /** @returns {string|null} the open drawer's id, or null */
  getOpenDrawerId() {
    return this._openDrawerId;
  }

  /**
   * Hides the panel. Local UI chrome, NOT manager state — unlike every other
   * button, this does not go through this._call(). VTKVRSpatialUI shows a
   * tiny always-on "reshow tab" (using the same hit-test machinery as the
   * full panel) to bring it back; see VTKVRSpatialUI._updateReshowTab.
   * @private
   */
  _hideMenu() {
    this._visible = false;
    return { handled: true, action: "menu-hidden" };
  }

  _activateTool(toolId) {
    // Toggle semantics: tapping the already-active tool turns it off, so the
    // user can drop back to plain navigation without a separate "none" button.
    // Stamp the tap so syncFromManager() honours this optimistic value while
    // the manager's async tool switch settles (see TOOL_SYNC_HOLD_MS).
    this._toolTapAtMs = Date.now();
    if (this._activeToolId === toolId) {
      this._call("deactivateTool");
      this._activeToolId = null;
      return { handled: true, action: "tool-deactivated", toolId: null };
    }
    this._call("activateTool", toolId);
    this._activeToolId = toolId;
    return { handled: true, action: "tool-activated", toolId };
  }

  _undo() {
    // Routes to the same tool-level undo the controller A-button drives, so
    // there is one undo path (and persistence/broadcast stays consistent).
    const undone = this._call("undoLastToolAction");
    return { handled: true, action: "undo", undone: undone === true };
  }

  _toggleIsolation() {
    let isolated = this._isolated;
    if (typeof this._manager?.toggleIsolation === "function") {
      // toggleIsolation returns the new isolated state (true/false)
      isolated = this._manager.toggleIsolation();
    } else {
      isolated = !this._isolated;
    }
    this._isolated = !!isolated;
    return { handled: true, action: "isolation-toggled", isolated: this._isolated };
  }

  _toggleGrid() {
    const wasEnabled = this._gridEnabled;
    let enabled = this._gridEnabled;
    if (typeof this._manager?.toggleGridMode === "function") {
      // toggleGridMode returns the new enabled state (true/false)
      enabled = this._manager.toggleGridMode();
    } else {
      enabled = !this._gridEnabled;
    }
    this._gridEnabled = !!enabled;

    // Asking to turn the grid ON and still getting `false` back means there was
    // nothing to show — the grid renders OTHER open VTK views, so with a single
    // dataset open it silently did nothing. Report why, the same way
    // snapshot-load and goto-participant do, so the hint line can say so
    // instead of the button just refusing to light.
    if (!wasEnabled && !this._gridEnabled) {
      return {
        handled: true,
        action: "grid-toggled",
        gridEnabled: false,
        reason: "no-other-views",
      };
    }
    return { handled: true, action: "grid-toggled", gridEnabled: this._gridEnabled };
  }

  _exit() {
    // leaveSession is async; fire-and-forget — the panel is torn down by the
    // subsequent session-end signal, not by this promise resolving.
    try {
      const r = this._manager?.leaveSession?.();
      if (r && typeof r.catch === "function") {
        r.catch((err) => log.warn("VR exit failed:", err?.message));
      }
    } catch (err) {
      log.warn("VR exit threw:", err?.message);
    }
    return { handled: true, action: "exit" };
  }

  _call(method, ...args) {
    const fn = this._manager?.[method];
    if (typeof fn === "function") {
      try {
        return fn.apply(this._manager, args);
      } catch (err) {
        log.warn(`VRSpatialMenu: manager.${method} threw:`, err?.message);
      }
    }
    return undefined;
  }

  // ===========================================================================
  // SHOW / HIDE  (driven by VR session lifecycle)
  // ===========================================================================

  /** Called on VR session start. Panel becomes visible and re-syncs state. */
  onSessionStart() {
    this._visible = true;
    this.syncFromManager();
    return this._visible;
  }

  /** Called on VR session end. Panel hides and forgets transient state. */
  onSessionEnd() {
    this._visible = false;
    this._activeToolId = null;
    this._isolated = false;
    this._gridEnabled = false;
    this._openDrawerId = null;
    this._participantCycleIndex = -1;
    this._snapshotCycleIndex = -1;
    this._toolTapAtMs = null;
    return this._visible;
  }

  isVisible() {
    return this._visible;
  }

  /**
   * Manually show/hide the panel (the "Hide" button / reshow tab). Distinct
   * from onSessionStart/onSessionEnd's lifecycle-driven visibility — a manual
   * hide does not persist across sessions; onSessionStart always resets to
   * visible, which is the simplest, least-surprising default.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this._visible = !!visible;
    return this._visible;
  }

  // ===========================================================================
  // STATE REFLECTION (keep panel == manager)
  // ===========================================================================

  /**
   * Pull authoritative state from the manager so the panel highlights match
   * whatever the manager actually has active (e.g. a tool activated by the
   * DOM wrist menu, or isolation entered via the B-button). Safe to call any
   * time; missing manager methods are treated as "nothing active".
   */
  syncFromManager() {
    // Optimistic-hold window. VRExplorationManager.activateTool() drives the
    // ASYNC VRToolManager.activateTool without awaiting it (the old tool's
    // deactivate() is awaited first), so getActiveTool() keeps reporting the
    // PREVIOUS tool for a frame or more after a tap. Since this runs every
    // frame, it used to stomp the optimistic _activeToolId set on tap and then
    // flip back once the promise settled — visibly flickering the highlight and
    // tearing down/rebuilding the contextual row's actors on every tool press.
    // Within the window we trust the local tap; after it, the manager wins.
    const holding =
      this._toolTapAtMs != null &&
      Date.now() - this._toolTapAtMs < TOOL_SYNC_HOLD_MS;

    if (!holding) {
      const active = this._manager?.getActiveTool?.();
      // getActiveTool() returns a tool instance (with .id) or null/undefined.
      this._activeToolId = active?.id ?? null;
      this._toolTapAtMs = null;
    }

    if (typeof this._manager?.isIsolated === "function") {
      this._isolated = !!this._manager.isIsolated();
    }
    if (typeof this._manager?.isGridModeEnabled === "function") {
      this._gridEnabled = !!this._manager.isGridModeEnabled();
    }
    return {
      activeToolId: this._activeToolId,
      isolated: this._isolated,
      gridEnabled: this._gridEnabled,
    };
  }

  getActiveToolId() {
    return this._activeToolId;
  }

  isIsolated() {
    return this._isolated;
  }

  /**
   * Render-time button states for the geometry layer: which button is the
   * active tool and whether isolation is on, so it can tint/highlight them.
   * Iterates getButtonLayout() (not the static constant) so contextual-row
   * buttons get highlighting for free while their tool is active.
   * @returns {Array<{id:string, active:boolean}>}
   */
  getButtonStates() {
    return this.getButtonLayout().map((btn) => {
      let active = false;
      // `disabled` means "this button cannot do anything right now" (no scalar
      // arrays to threshold, no volume to isosurface). The render layer dims
      // the card, so a tap that no-ops at least looks like it will.
      let disabled = false;
      if (btn.kind === "tool") active = this._activeToolId === btn.toolId;
      else if (btn.kind === "drawer") active = this._openDrawerId === btn.drawerId;
      else if (btn.id === "isolation") active = this._isolated;
      else if (btn.id === "grid") active = this._gridEnabled;
      // Relative tolerance, not ===. Two-hand pinch mutates vrScale
      // continuously, so exact equality made all three presets go dark after
      // any zoom gesture and only relight on a pixel-perfect preset tap.
      else if (btn.kind === "scale") {
        const scale = this._call("getVRScale");
        active =
          typeof scale === "number" &&
          Number.isFinite(scale) &&
          Math.abs(scale - btn.scaleValue) <= btn.scaleValue * 0.02;
      }
      else if (btn.kind === "nav-mode-set") active = this._call("getNavigationMode") === btn.mode;
      else if (btn.id === "follow-participant") active = !!this._call("isFollowingParticipant");
      else if (btn.kind === "representation") {
        const mode = this._call("getRepresentation");
        active = !!mode && mode !== "surface";
      }
      // Exact match, unlike the legacy cycling button above: each of
      // Surface/Wire/Points lights only for its own mode, so the panel finally
      // shows WHICH representation is live.
      else if (btn.kind === "representation-set") {
        active = this._call("getRepresentation") === btn.mode;
      }
      else if (btn.kind === "scene-grid") active = !!this._call("isReferenceGridVisible");
      else if (btn.kind === "scene-axes") active = !!this._call("areDataAxesVisible");
      else if (btn.kind === "threshold-toggle") {
        active = !!this._call("isThresholdEnabled");
        disabled = this._call("isThresholdAvailable") === false;
      } else if (btn.kind === "iso-toggle") {
        active = !!this._call("isIsosurfaceEnabled");
        disabled = this._call("isIsosurfaceAvailable") === false;
      }
      // Threshold sub-controls are meaningless while threshold is off.
      else if (btn.kind === "threshold-mode" || btn.kind === "threshold-array") {
        disabled = !this._call("isThresholdEnabled");
      }
      else if (btn.kind === "glyph-toggle") active = !!this._call("isGlyphsEnabled");
      else if (btn.kind === "probe-continuous") active = !!this._call("isProbeContinuous");
      // Only meaningful once connected: voiceRoomService.isMuted initialises to
      // TRUE before any room is joined, which lit the Mute button from the
      // moment VR started even though nothing was muted (nor mutable — its
      // toggle early-returns while disconnected).
      else if (btn.kind === "voice-mute") {
        active = !!this._call("isVoiceConnected") && !!this._call("isVoiceMuted");
      }
      else if (btn.kind === "voice-join") active = !!this._call("isVoiceConnected");
      // clip-invert/clip-reset/annotation-mode/snapshot-save/snapshot-load/
      // toggle-visibility and the value-* stepper are momentary actions —
      // never highlighted.
      return { id: btn.id, active, disabled };
    });
  }

  // ===========================================================================
  // STATUS LINE
  // ===========================================================================

  /**
   * A single text line for the geometry layer to render above the button
   * rows: dataset name, current scale, and locomotion mode. Never throws —
   * missing manager data just yields a shorter/blanker line.
   * @returns {string}
   */
  getStatusLine() {
    const name = this._call("getActiveDatasetName") || "Dataset";
    const navMode = this._call("getNavigationMode");
    const scale = this._call("getVRScale");

    const parts = [name];
    if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) {
      parts.push(this._formatScale(scale));
    }
    if (typeof navMode === "string" && navMode.length) {
      parts.push(navMode[0].toUpperCase() + navMode.slice(1));
    }

    const followedId = this._call("isFollowingParticipant");
    if (followedId) {
      const others = this._call("getOtherParticipants") || [];
      const target = others.find((p) => p.odUserId === followedId);
      parts.push(`Following ${target?.userName || followedId}`);
    }

    if (this._activeToolId === "annotate") {
      const pendingLabel = this._call("getPendingAnnotationLabel");
      if (pendingLabel) parts.push(`Label: ${pendingLabel}`);
    }

    return parts.join("  •  ");
  }

  /** @private */
  _formatScale(scale) {
    if (scale >= 1) {
      return `${scale % 1 === 0 ? scale.toFixed(0) : scale.toFixed(1)}x`;
    }
    return `1:${(1 / scale).toFixed(1)}`;
  }

  // ===========================================================================
  // HINT LINE — "how do I interact with this right now"
  // ===========================================================================

  /**
   * A single "how do I use this" line for the geometry layer to render below
   * the button grid — separate from getStatusLine() (session state: dataset/
   * scale/mode/following) so the two don't get concatenated into one
   * unreadably long canvas-texture line. While a tool is active, shows that
   * tool's control summary; otherwise shows the current locomotion mode's
   * controls (VRNavigationController.NAVIGATION_MODE_INFO, surfaced via
   * VRExplorationManager.getNavigationModeInfo() — previously written but
   * never called from anywhere in the UI). Never throws; missing manager data
   * just yields an empty line.
   * @returns {string}
   */
  getHintLine() {
    if (this._activeToolId) {
      const toolHints = {
        clip: "Grip+drag to aim, A to invert, B to reset",
        // No thumbstick reference: it is hardcoded inert for Vision Pro
        // transient pointers, and the mode cycle it drove is gone. Label and
        // Color are on the contextual row, reachable on both headsets.
        annotate: "Trigger to place · Label/Color on the menu · Undo removes the last",
        // Chained: each pick continues the path from the last point. No
        // B-button reference — Vision Pro has no A/B, so Undo/New Path on the
        // menu are the only controls guaranteed on both headsets.
        measure: "Trigger to add points · Undo removes the last one",
        probe: "Trigger to probe, A for continuous, B to clear, thumbstick to browse history",
      };
      return toolHints[this._activeToolId] || "";
    }
    const info = this._call("getNavigationModeInfo");
    return info?.controls || "";
  }
}

export default VRSpatialMenuModel;
