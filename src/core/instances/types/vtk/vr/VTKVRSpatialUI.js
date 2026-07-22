// ----------------------------------------------------------------------------
// VR Spatial UI - in-scene tool menu for immersive WebXR sessions
// ----------------------------------------------------------------------------
//
// WHY IN-SCENE (NOT DOM)
// WebXR immersive sessions on Safari/visionOS and most browsers do NOT render
// the page DOM, so the React VRWristMenu is invisible once the headset is on.
// To let a user pick tools / toggle isolation / leave VR without removing the
// headset, the menu is drawn as VTK geometry inside the same scene the data
// lives in — a head-anchored quad panel with one button cell per action.
//
// The DOM VRWristMenu remains the pre-session / 2D fallback. Both read the same
// source of truth (VRExplorationManager via VRSpatialMenuModel), so they can
// never disagree.
//
// ANCHORING
// The panel floats ~1.2 m in front of the head at a slight downward tilt so it
// doesn't block the data. It re-anchors lazily: it only follows the head once
// the head has drifted past a comfort threshold, so it feels world-stable while
// you inspect but comes back when you turn to look for it.
//
// SELECTION
//  - Controller ray: the target ray is intersected with the panel plane; a
//    persistent hover highlight tracks the pointed button, and a rising-edge
//    trigger commits the tap.
//  - Vision Pro transient-pointer (gaze + pinch): there is no persistent hover
//    ray, so there is no hover highlight; a pinch (select) at the gaze target
//    intersects the panel and commits directly (tap-select).
//
// This file is the thin VTK layer; all layout / hit-region math / action
// dispatch lives in VRSpatialMenuModel (pure, unit-tested).

import { vr as log } from "@Utils/logger.js";
import { VRSpatialMenuModel } from "@Core/vr/VRSpatialMenuModel.js";

import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkPlaneSource from "@kitware/vtk.js/Filters/Sources/PlaneSource";
import vtkVectorText from "@kitware/vtk.js/Rendering/Core/VectorText";

// Physical panel size in meters (WebXR world units before vrScale). Height
// covers three button rows (0.14m each, matching the original single-row
// size) — bump by 0.14 if VR_MENU_BUTTONS ever grows another row.
const PANEL_WIDTH = 0.6;
const PANEL_HEIGHT = 0.42;
// Distance in front of head, and downward tilt so it clears the dataset.
const PANEL_DISTANCE = 1.2;
const PANEL_DROP = 0.35; // how far below eye-line the panel center sits
// Lazy re-anchor: only chase the head after it drifts this far (meters).
const REANCHOR_DISTANCE = 0.5;

const COLOR_IDLE = [0.14, 0.16, 0.22];
const COLOR_HOVER = [0.24, 0.42, 0.62];
const COLOR_ACTIVE = [0.16, 0.52, 0.5];
const COLOR_LABEL = [0.95, 0.96, 1.0];
const COLOR_STATUS = [0.7, 0.76, 0.85];

// Text labels (vtkVectorText): character height in meters, and how far the
// text floats in front of its button quad so it never z-fights.
const LABEL_CHAR_HEIGHT = 0.018;
const LABEL_LIFT = 0.003;
// vtkVectorText's glyphs are ~0.7 units wide per character at unit height;
// used to approximate the text width for centering.
const LABEL_CHAR_ASPECT = 0.7;

// Status line: sits just above the panel's top edge.
const STATUS_CHAR_HEIGHT = 0.02;
const STATUS_MARGIN = 0.03;

/**
 * VRSpatialUI — renders the in-session tool panel and routes ray taps back
 * through VRSpatialMenuModel → VRExplorationManager.
 *
 * Lifecycle: initialize(renderer, manager) → per-frame update(inputState) →
 * dispose(). Show/hide is bound to VR session start/end through the model.
 */
export class VRSpatialUI {
  constructor() {
    this._renderer = null;
    this._model = null;
    this._buttonActors = new Map(); // buttonId → { actor, region }
    this._panelAnchor = null; // { center:[x,y,z], right:[..], up:[..], normal:[..] }
    this._lastHeadPos = null;
    this._lastSelectPressed = false;
    this._hoverButtonId = null;
    // Status line (dataset / scale / nav mode) — a single dynamic label kept
    // separate from the static button labels since its text changes.
    this._statusSource = null;
    this._statusActor = null;
    this._lastStatusText = null;
    // XR→data affine (dataPos = xrPos/vrScale + vrOrigin). All panel geometry
    // and hit-testing is computed in physical (XR) metres; these convert the
    // final actor placements into the data-space renderer the VR camera draws,
    // so the panel appears at a fixed physical size/distance regardless of how
    // the dataset is zoomed. Mirrors VREnvironment's per-actor transform.
    this._vrScale = 1.0;
    this._vrOrigin = [0, 0, 0];
  }

  /**
   * Map a physical (XR) point to the data-space coordinate the VR camera
   * renders: dataPos = xrPos/vrScale + vrOrigin.
   * @private
   */
  _toData(p) {
    const s = this._vrScale || 1.0;
    const o = this._vrOrigin || [0, 0, 0];
    return [p[0] / s + o[0], p[1] / s + o[1], p[2] / s + o[2]];
  }

  /**
   * @param {object} renderer - VTK.js renderer (vrContext.sceneObjects.renderer)
   * @param {object} manager  - VRExplorationManager (source of truth)
   */
  initialize(renderer, manager) {
    // Idempotency guard: if a previous VR session's teardown ever failed to
    // call dispose() (e.g. an earlier sub-manager's dispose() threw before
    // leaveSession() reached this one), stale button/label actors would
    // still be sitting in this same long-lived renderer. Disposing first
    // guarantees at most one menu panel ever exists, self-healing any leak
    // instead of stacking a duplicate set of "blue rectangles" on top.
    if (this._renderer) this.dispose();
    this._renderer = renderer;
    this._model = new VRSpatialMenuModel(manager);
    this._model.onSessionStart();
    this._buildActors();
    log.info("VR spatial UI initialized");
  }

  /** The pure model, exposed for wiring/inspection. */
  getModel() {
    return this._model;
  }

  // ===========================================================================
  // GEOMETRY
  // ===========================================================================

  _buildActors() {
    if (!this._renderer || !this._model) return;
    for (const region of this._model.getButtonLayout()) {
      const actor = this._createButtonActor();
      const label = this._createLabelActor(region.label);
      this._buttonActors.set(region.id, { actor, region, labelActor: label });
      this._renderer.addActor(actor);
      if (label) this._renderer.addActor(label);
    }
    this._buildStatusLabel();
  }

  /** @private */
  _buildStatusLabel() {
    try {
      const source = vtkVectorText.newInstance();
      source.setText("");
      const mapper = vtkMapper.newInstance();
      mapper.setInputConnection(source.getOutputPort());
      const actor = vtkActor.newInstance();
      actor.setMapper(mapper);
      actor.getProperty().setColor(...COLOR_STATUS);
      actor.getProperty().setLighting(false);
      actor.setVisibility(false);
      actor.setPickable(false);
      this._statusSource = source;
      this._statusActor = actor;
      this._renderer.addActor(actor);
    } catch (err) {
      log.warn(`VR menu status label failed: ${err?.message}`);
    }
  }

  _createButtonActor() {
    const plane = vtkPlaneSource.newInstance({
      xResolution: 1,
      yResolution: 1,
    });
    const mapper = vtkMapper.newInstance();
    mapper.setInputConnection(plane.getOutputPort());
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    actor.getProperty().setColor(...COLOR_IDLE);
    actor.getProperty().setLighting(false);
    actor.setVisibility(false);
    // Menu chrome must never be picked by the data-space tools.
    actor.setPickable(false);
    return actor;
  }

  /**
   * 3D text label for a button (vtkVectorText polydata → actor). Returns null
   * on failure — the button stays usable as an unlabeled quad.
   * @private
   */
  _createLabelActor(text) {
    try {
      const source = vtkVectorText.newInstance();
      source.setText(text || "");
      const mapper = vtkMapper.newInstance();
      mapper.setInputConnection(source.getOutputPort());
      const actor = vtkActor.newInstance();
      actor.setMapper(mapper);
      actor.getProperty().setColor(...COLOR_LABEL);
      actor.getProperty().setLighting(false);
      actor.setVisibility(false);
      actor.setPickable(false);
      return actor;
    } catch (err) {
      log.warn(`VR menu label failed for "${text}": ${err?.message}`);
      return null;
    }
  }

  // ===========================================================================
  // PER-FRAME UPDATE
  // ===========================================================================

  /**
   * @param {object} inputState - from VRExplorationManager._gatherInputState():
   *   { headPose:{position,orientation}, controllers:{ right:{ targetRay,
   *     triggerPressed, ... } } }
   * @returns {{hovering:boolean, buttonId:string|null, hand:string}|null}
   *   Input-arbitration result for the frame loop: whether the pointer is over
   *   a menu button (so its pinch should NOT also drive nav/tools) and which
   *   hand did the picking. Returns null when the menu is not initialized /
   *   not visible / has no input — the frame loop treats that as "no menu
   *   interaction this frame".
   */
  update(inputState, transform) {
    if (!this._model?.isVisible() || !inputState) return null;

    // Latch the current XR→data transform so _layoutButtons/_layoutStatus can
    // place the panel in the data-space renderer at a fixed physical size.
    if (transform) {
      this._vrScale = transform.vrScale || 1.0;
      this._vrOrigin = transform.vrOrigin || [0, 0, 0];
    }

    // Keep highlights aligned with the manager (tool may have changed via the
    // DOM menu, isolation via the B-button).
    this._model.syncFromManager();

    this._updateAnchor(inputState.headPose);
    this._layoutButtons();
    this._layoutStatus();

    const ray = this._pickRay(inputState);
    const hit = ray ? this._intersectPanel(ray.origin, ray.direction) : null;
    this._hoverButtonId = hit ? this._model.hitTest(hit.u, hit.v)?.id ?? null : null;

    // Rising-edge select (trigger on controllers, pinch on transient-pointer).
    const selectPressed = this._isSelectPressed(inputState);
    if (selectPressed && !this._lastSelectPressed && this._hoverButtonId) {
      this._model.activate(this._hoverButtonId);
    }
    this._lastSelectPressed = selectPressed;

    this._applyColors();

    // The picking hand mirrors _pickRay's preference (right, else left).
    const hand = inputState.controllers?.right ? "right" : "left";
    return { hovering: !!this._hoverButtonId, buttonId: this._hoverButtonId ?? null, hand };
  }

  /**
   * Head-anchored placement with lazy re-anchor: recompute the panel frame
   * only when the head has moved past REANCHOR_DISTANCE from where the panel
   * was last placed, so it stays world-stable during close inspection.
   * @private
   */
  _updateAnchor(headPose) {
    if (!headPose?.position) return;
    const p = headPose.position;
    const headPos = [p.x, p.y, p.z];

    if (this._panelAnchor && this._lastHeadPos) {
      const dx = headPos[0] - this._lastHeadPos[0];
      const dy = headPos[1] - this._lastHeadPos[1];
      const dz = headPos[2] - this._lastHeadPos[2];
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) < REANCHOR_DISTANCE) {
        return; // still comfortable; leave the panel where it is
      }
    }

    // Forward from head orientation (-Z), flattened to horizontal so the panel
    // doesn't pitch wildly when the user looks up/down.
    const fwd = this._orientationForward(headPose.orientation);
    let fx = fwd[0];
    let fz = fwd[2];
    const flen = Math.hypot(fx, fz) || 1;
    fx /= flen;
    fz /= flen;

    const center = [
      headPos[0] + fx * PANEL_DISTANCE,
      headPos[1] - PANEL_DROP,
      headPos[2] + fz * PANEL_DISTANCE,
    ];
    // Panel basis: right = fwd × worldUp, up = worldUp (kept upright for reading)
    const right = [fz, 0, -fx]; // horizontal, perpendicular to forward
    const up = [0, 1, 0];
    const normal = [-fx, 0, -fz]; // faces back toward the head

    this._panelAnchor = { center, right, up, normal };
    this._lastHeadPos = headPos;
  }

  /**
   * Position each button quad inside the panel frame from its UV region.
   * @private
   */
  _layoutButtons() {
    const a = this._panelAnchor;
    if (!a) return;
    const { center, right, up } = a;

    // Yaw the quads/labels so they face the same way the panel normal points
    // (plane/text geometry natively faces +Z). The data-space renderer only
    // scales + translates relative to physical space (no world rotation), so
    // this yaw is unchanged; positions/sizes are converted below.
    const yawDeg = (Math.atan2(a.normal[0], a.normal[2]) * 180) / Math.PI;
    const inv = 1 / (this._vrScale || 1.0);

    for (const { actor, region, labelActor } of this._buttonActors.values()) {
      // UV center → offset from panel center, in meters
      const ou = (region.cu - 0.5) * PANEL_WIDTH;
      const ov = (region.cv - 0.5) * PANEL_HEIGHT;
      const cx = center[0] + right[0] * ou + up[0] * ov;
      const cy = center[1] + right[1] * ou + up[1] * ov;
      const cz = center[2] + right[2] * ou + up[2] * ov;
      actor.setPosition(...this._toData([cx, cy, cz]));
      actor.setOrientation(0, yawDeg, 0);

      // Scale unit plane to cell size (plane source spans [-0.5,0.5]), then by
      // 1/vrScale so it renders at its authored physical size in data space.
      const w = (region.u1 - region.u0) * PANEL_WIDTH;
      const h = (region.v1 - region.v0) * PANEL_HEIGHT;
      actor.setScale(w * inv, h * inv, inv);
      actor.setVisibility(true);

      if (labelActor) {
        // Center the text on the cell: vtkVectorText anchors at its left
        // baseline, so back up by half the approximate text width and half a
        // character height, then lift slightly off the quad along the normal.
        const s = LABEL_CHAR_HEIGHT;
        const halfTextW = 0.5 * region.label.length * s * LABEL_CHAR_ASPECT;
        labelActor.setPosition(
          ...this._toData([
            cx - right[0] * halfTextW + a.normal[0] * LABEL_LIFT,
            cy - s * 0.5 + a.normal[1] * LABEL_LIFT,
            cz - right[2] * halfTextW + a.normal[2] * LABEL_LIFT,
          ])
        );
        labelActor.setOrientation(0, yawDeg, 0);
        labelActor.setScale(s * inv, s * inv, s * inv);
        labelActor.setVisibility(true);
      }
    }
  }

  /**
   * Position the dataset/scale/nav-mode status line just above the panel's
   * top edge. Text is only re-set on vtkVectorText when it actually changes
   * (dirty-checked) — rebuilding the glyph polydata every frame would be
   * wasteful for a value that's usually static between input events.
   * @private
   */
  _layoutStatus() {
    const a = this._panelAnchor;
    if (!a || !this._statusActor || !this._statusSource) return;

    const text = this._model.getStatusLine();
    if (text !== this._lastStatusText) {
      this._statusSource.setText(text);
      this._lastStatusText = text;
    }
    if (!text) {
      this._statusActor.setVisibility(false);
      return;
    }

    const { center, right, up } = a;
    const yawDeg = (Math.atan2(a.normal[0], a.normal[2]) * 180) / Math.PI;

    const s = STATUS_CHAR_HEIGHT;
    const topEdgeOv = 0.5 * PANEL_HEIGHT;
    const ov = topEdgeOv + STATUS_MARGIN + s * 0.5;
    const halfTextW = 0.5 * text.length * s * LABEL_CHAR_ASPECT;

    const cx = center[0] + up[0] * ov;
    const cy = center[1] + up[1] * ov;
    const cz = center[2] + up[2] * ov;

    const inv = 1 / (this._vrScale || 1.0);
    this._statusActor.setPosition(
      ...this._toData([
        cx - right[0] * halfTextW + a.normal[0] * LABEL_LIFT,
        cy - s * 0.5 + a.normal[1] * LABEL_LIFT,
        cz - right[2] * halfTextW + a.normal[2] * LABEL_LIFT,
      ])
    );
    this._statusActor.setOrientation(0, yawDeg, 0);
    this._statusActor.setScale(s * inv, s * inv, s * inv);
    this._statusActor.setVisibility(true);
  }

  _applyColors() {
    const states = new Map(this._model.getButtonStates().map((s) => [s.id, s.active]));
    for (const [id, { actor }] of this._buttonActors) {
      let color = COLOR_IDLE;
      if (states.get(id)) color = COLOR_ACTIVE;
      else if (id === this._hoverButtonId) color = COLOR_HOVER;
      actor.getProperty().setColor(...color);
    }
  }

  // ===========================================================================
  // RAY / INTERSECTION MATH
  // ===========================================================================

  /**
   * Extract a pickable ray from input. Prefers the right controller's target
   * ray (also the Vision Pro transient-pointer path, which _gatherInputState
   * maps onto controllers.right). Returns { origin:[x,y,z], direction:[x,y,z] }
   * or null.
   * @private
   */
  _pickRay(inputState) {
    const ctrl = inputState.controllers?.right || inputState.controllers?.left;
    const tr = ctrl?.targetRay;
    if (!tr) return null;
    const origin = tr.position;
    if (!origin) return null;
    // XRRigidTransform: forward is -Z of its matrix (column-major).
    let direction;
    if (tr.matrix) {
      direction = [-tr.matrix[8], -tr.matrix[9], -tr.matrix[10]];
    } else if (tr.orientation) {
      direction = this._orientationForward(tr.orientation);
    } else {
      return null;
    }
    return { origin: [origin.x, origin.y, origin.z], direction };
  }

  _isSelectPressed(inputState) {
    const ctrl = inputState.controllers?.right || inputState.controllers?.left;
    return !!ctrl?.triggerPressed;
  }

  /**
   * Ray/panel-plane intersection, returning the (u,v) hit in panel space or
   * null (miss, behind, or outside the quad). Panel space: u along +right,
   * v along +up, both in [0,1] across the panel rect.
   * @private
   */
  _intersectPanel(origin, direction) {
    const a = this._panelAnchor;
    if (!a) return null;
    const { center, right, up, normal } = a;

    const denom = this._dot(direction, normal);
    if (Math.abs(denom) < 1e-6) return null; // parallel

    const diff = [center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]];
    const t = this._dot(diff, normal) / denom;
    if (t < 0) return null; // behind the ray

    const hit = [
      origin[0] + direction[0] * t,
      origin[1] + direction[1] * t,
      origin[2] + direction[2] * t,
    ];
    const local = [hit[0] - center[0], hit[1] - center[1], hit[2] - center[2]];

    // Project onto panel axes → meters from center → [0,1] fraction.
    const mu = this._dot(local, right);
    const mv = this._dot(local, up);
    const u = mu / PANEL_WIDTH + 0.5;
    const v = mv / PANEL_HEIGHT + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { u, v, t };
  }

  /** Forward (-Z) vector of a quaternion {x,y,z,w}. @private */
  _orientationForward(q) {
    if (!q) return [0, 0, -1];
    const { x, y, z, w } = q;
    // Rotate (0,0,-1) by q.
    return [
      -2 * (x * z + w * y),
      -2 * (y * z - w * x),
      -(1 - 2 * (x * x + y * y)),
    ];
  }

  _dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  // ===========================================================================
  // TEARDOWN
  // ===========================================================================

  /** Called on VR session end / instance teardown. */
  dispose() {
    if (this._model) this._model.onSessionEnd();
    if (this._renderer) {
      for (const { actor, labelActor } of this._buttonActors.values()) {
        this._renderer.removeActor(actor);
        if (labelActor) this._renderer.removeActor(labelActor);
      }
      if (this._statusActor) this._renderer.removeActor(this._statusActor);
    }
    this._buttonActors.clear();
    this._panelAnchor = null;
    this._lastHeadPos = null;
    this._hoverButtonId = null;
    this._lastSelectPressed = false;
    this._statusSource = null;
    this._statusActor = null;
    this._lastStatusText = null;
    this._renderer = null;
    this._model = null;
    log.debug("VR spatial UI disposed");
  }
}

// Singleton for VRExplorationManager to drive per-session.
export const vrSpatialUI = new VRSpatialUI();
export default vrSpatialUI;
