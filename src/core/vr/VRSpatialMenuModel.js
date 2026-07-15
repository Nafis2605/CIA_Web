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
 *   - "tool":           toggles a VR tool (annotate/measure/clip) via the manager
 *   - "action":         a one-shot command (undo)
 *   - "toggle":         a stateful toggle (isolation/grid) reflected from manager
 *   - "nav-mode":       cycles the locomotion mode (fly/teleport/walk)
 *   - "nav-mode-set":   toggles a specific locomotion mode on/off (grab)
 *   - "scale":          jumps to a fixed vrScale preset
 *   - "representation": cycles surface→wireframe→points (same as desktop menu)
 *   - "glyph-toggle":   toggles vector/scalar glyphs (same as desktop menu)
 *   - "exit":           leave the VR session
 * @type {ReadonlyArray<{id:string,label:string,icon:string,kind:string,toolId?:string,scaleValue?:number,row:number}>}
 */
export const VR_MENU_BUTTONS = Object.freeze([
  // Row 0 (bottom): tools, undo, isolation, grid, exit. annotate stays first
  // and exit stays last (VTKVRSpatialUI and tests rely on that ordering).
  { id: "annotate", label: "Annotate", icon: "edit", kind: "tool", toolId: "annotate", row: 0 },
  { id: "measure", label: "Measure", icon: "ruler", kind: "tool", toolId: "measure", row: 0 },
  { id: "clip", label: "Clip", icon: "crop", kind: "tool", toolId: "clip", row: 0 },
  { id: "undo", label: "Undo", icon: "rotateCcw", kind: "action", row: 0 },
  { id: "isolation", label: "Isolate", icon: "expand", kind: "toggle", row: 0 },
  { id: "grid", label: "Grid", icon: "layoutGrid", kind: "toggle", row: 0 },
  { id: "exit", label: "Exit VR", icon: "doorOpen", kind: "exit", row: 0 },
  // Row 1 (above row 0): locomotion mode, scale presets, and appearance
  // controls (representation cycle + glyph toggle — the same desktop
  // implementations, so VR and desktop stay consistent). scaleValue matches
  // VRScaleController's corrected preset numbers (small=overview, large=detail).
  { id: "nav-mode", label: "Nav", icon: "compass", kind: "nav-mode", row: 1 },
  // Toggles "grab" locomotion (pinch-and-drag to pull the data closer / push it
  // away). Tapping again while active drops back to teleport.
  { id: "move", label: "Move", icon: "move", kind: "nav-mode-set", mode: "grab", row: 1 },
  { id: "scale-overview", label: "Overview", icon: "minimize", kind: "scale", scaleValue: 0.1, row: 1 },
  { id: "scale-normal", label: "Normal", icon: "square", kind: "scale", scaleValue: 1.0, row: 1 },
  { id: "scale-detail", label: "Detail", icon: "maximize", kind: "scale", scaleValue: 10.0, row: 1 },
  { id: "representation", label: "Style", icon: "cube", kind: "representation", row: 1 },
  { id: "glyphs", label: "Glyphs", icon: "arrowUpRight", kind: "glyph-toggle", row: 1 },
  // Row 2 (top): collaborators + annotation label. Collaborators cycle
  // through other session participants rather than a full per-user list
  // (keeps the fixed-cell UV grid simple) — every tap still does something
  // real, just "next collaborator" instead of "this specific collaborator".
  { id: "goto-participant", label: "Go To", icon: "target", kind: "goto-participant", row: 2 },
  { id: "follow-participant", label: "Follow", icon: "user", kind: "follow-participant", row: 2 },
  // Cycles the annotate tool's pending preset label — the only VR
  // text-entry mechanism (see ANNOTATION_LABEL_PRESETS in VRAnnotationTool.js).
  { id: "annotation-label", label: "Label", icon: "tag", kind: "annotation-label", row: 2 },
]);

// Fraction of each cell's width/height left as inner padding (per side).
const CELL_PADDING = 0.06;

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
    // Cycle position through getOtherParticipants() for the Go To/Follow
    // buttons — see _pickNextParticipant.
    this._participantCycleIndex = -1;
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
   * @returns {Array<{id:string,label:string,icon:string,kind:string,
   *   toolId?:string, row:number, u0:number,u1:number,v0:number,v1:number,
   *   cu:number,cv:number}>} cu/cv = cell center (for placing labels/icons)
   */
  getButtonLayout() {
    const rows = new Map();
    for (const btn of VR_MENU_BUTTONS) {
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
      const vBase = rowIndex * rowH;

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
    const btn = VR_MENU_BUTTONS.find((b) => b.id === buttonId);
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
      case "glyph-toggle":
        return this._toggleGlyphs();
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
   * Toggles a specific locomotion mode (grab). Tapping the Move button when
   * grab is already active drops back to teleport, so the one button both
   * enters and leaves "pull the data around" mode. Uses the same
   * VRExplorationManager.setNavigationMode the launch modal's dropdown drives.
   * @private
   */
  _setNavMode(mode) {
    const current = this._call("getNavigationMode");
    const next = current === mode ? "teleport" : mode;
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

  /** Toggles glyphs via the same desktop VTKGlyphFeature (VRExplorationManager.toggleGlyphs). */
  _toggleGlyphs() {
    const enabled = !!this._call("toggleGlyphs");
    return { handled: true, action: "glyphs-toggled", enabled };
  }

  _activateTool(toolId) {
    // Toggle semantics: tapping the already-active tool turns it off, so the
    // user can drop back to plain navigation without a separate "none" button.
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
    let enabled = this._gridEnabled;
    if (typeof this._manager?.toggleGridMode === "function") {
      // toggleGridMode returns the new enabled state (true/false)
      enabled = this._manager.toggleGridMode();
    } else {
      enabled = !this._gridEnabled;
    }
    this._gridEnabled = !!enabled;
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
    this._participantCycleIndex = -1;
    return this._visible;
  }

  isVisible() {
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
    const active = this._manager?.getActiveTool?.();
    // getActiveTool() returns a tool instance (with .id) or null/undefined.
    this._activeToolId = active?.id ?? null;

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
   * @returns {Array<{id:string, active:boolean}>}
   */
  getButtonStates() {
    return VR_MENU_BUTTONS.map((btn) => {
      let active = false;
      if (btn.kind === "tool") active = this._activeToolId === btn.toolId;
      else if (btn.id === "isolation") active = this._isolated;
      else if (btn.id === "grid") active = this._gridEnabled;
      else if (btn.kind === "scale") active = this._call("getVRScale") === btn.scaleValue;
      else if (btn.kind === "nav-mode-set") active = this._call("getNavigationMode") === btn.mode;
      else if (btn.id === "follow-participant") active = !!this._call("isFollowingParticipant");
      else if (btn.kind === "representation") {
        const mode = this._call("getRepresentation");
        active = !!mode && mode !== "surface";
      } else if (btn.kind === "glyph-toggle") active = !!this._call("isGlyphsEnabled");
      return { id: btn.id, active };
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
}

export default VRSpatialMenuModel;
