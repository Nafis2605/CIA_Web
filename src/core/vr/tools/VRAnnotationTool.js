// src/core/vr/tools/VRAnnotationTool.js
// Annotation tool for VR - place markers and text annotations

import { VRToolInterface } from './VRToolInterface.js';
import { vr as log } from '@Utils/logger.js';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import { VRTextBillboard } from '@Core/vr/ui/VRTextBillboard.js';

// Apparent radius (metres) of a placed-annotation marker sphere, kept constant
// as the world scales via VRToolInterface._apparentScale.
const MARKER_APPARENT_RADIUS_M = 0.015;
const LABEL_APPARENT_HEIGHT_M = 0.02;
const DEFAULT_MARKER_COLOR = [1, 0.5, 0];
const LABEL_TEXT_COLOR = '#ffffff';
const LABEL_BACKGROUND = 'rgba(28,18,6,0.82)';

/**
 * Marker colours, cycled by the contextual "Color" button.
 *
 * This replaced an "annotation mode" cycle (marker/text/drawing) that changed
 * only stored metadata: render() drew a sphere regardless of mode, and
 * 'drawing' produced a one-element point list with no stroke accumulation. So
 * cycling mode changed nothing you could see. Colour is a small thing that is
 * actually visible, and it already flows through metadata.color into
 * _createMarkerActor and on to persistence.
 * @type {ReadonlyArray<{name:string, rgb:number[]}>}
 */
export const ANNOTATION_COLORS = Object.freeze([
  { name: 'Orange', rgb: [1, 0.5, 0] },
  { name: 'Red', rgb: [0.95, 0.25, 0.25] },
  { name: 'Green', rgb: [0.3, 0.85, 0.4] },
  { name: 'Blue', rgb: [0.35, 0.6, 1] },
  { name: 'Violet', rgb: [0.72, 0.45, 0.95] },
]);

// The only text-entry mechanism available in VR: a fixed set of preset
// labels cycled by the spatial menu's "Label" button
// (VRExplorationManager.cycleAnnotationLabel). Free-text isn't viable here —
// WebXR's dom-overlay feature (which would let a virtual keyboard render)
// is not supported inside immersive-vr sessions on Quest Browser or
// visionOS Safari, and voice input is command-grammar only, not free
// transcription (see src/services/voice/).
export const ANNOTATION_LABEL_PRESETS = Object.freeze([
  'Note',
  'Anomaly',
  'Check this',
  'Max',
  'Min',
]);

export class VRAnnotationTool extends VRToolInterface {
  constructor() {
    super({
      id: 'annotate',
      name: 'Annotate',
      icon: 'message-circle',
      category: 'collaboration',
    });

    this._annotations = [];
    this._pendingAnnotation = null;
    this._pendingLabel = ANNOTATION_LABEL_PRESETS[0];
    this._colorIndex = 0;

    // In-headset visuals, keyed by annotation id: { actor, label }. Reconciled
    // against `this._annotations` in render() only when the count changes
    // (dirty check), then rescaled every frame for constant apparent size.
    this._markerActors = new Map();
    this._renderer = null;
    this._lastRenderedCount = -1;
  }

  async activate(context) {
    await super.activate(context);
    log.debug('Annotation tool activated');
  }

  async deactivate() {
    await super.deactivate();
    this._pendingAnnotation = null;
    this._clearMarkers();
  }

  /**
   * Draw one small sphere marker per placed annotation. Lazily creates actors
   * (dirty-checked on annotation count so geometry isn't rebuilt every frame)
   * and rescales them each frame so they hold a constant apparent size as the
   * world zooms.
   * @param {Object} renderer - VTK VR scene renderer
   */
  render(renderer) {
    if (!renderer) return;
    this._renderer = renderer;

    // Rebuild the actor set only when the annotation collection changed.
    if (this._annotations.length !== this._lastRenderedCount) {
      this._reconcileMarkers(renderer);
      this._lastRenderedCount = this._annotations.length;
    }

    // Constant apparent size regardless of world scale.
    const s = this._apparentScale(MARKER_APPARENT_RADIUS_M);
    const labelScale = this._apparentScale(LABEL_APPARENT_HEIGHT_M);
    // Float the label clear of the marker sphere it belongs to.
    const lift = (MARKER_APPARENT_RADIUS_M * 2) / this._getVrScale();

    for (const annotation of this._annotations) {
      const entry = this._markerActors.get(annotation.id);
      if (!entry) continue;

      entry.actor.setScale(s, s, s);

      if (entry.label) {
        const p = annotation.position || {};
        entry.label
          .setPosition(p.x || 0, (p.y || 0) + lift, p.z || 0)
          .setScale(labelScale)
          .faceCamera(renderer)
          .setVisible(true);
      }
    }
  }

  /**
   * Add actors for new annotations and remove actors for undone ones, keying
   * on annotation id so an add+undo in the same frame still reconciles right.
   * @private
   */
  _reconcileMarkers(renderer) {
    const liveIds = new Set(this._annotations.map((a) => a.id));

    for (const [id, entry] of this._markerActors) {
      if (!liveIds.has(id)) {
        renderer.removeActor(entry.actor);
        entry.actor.delete?.();
        entry.label?.dispose();
        this._markerActors.delete(id);
      }
    }

    for (const annotation of this._annotations) {
      if (this._markerActors.has(annotation.id)) continue;
      const actor = this._createMarkerActor(annotation);
      if (!actor) continue;
      renderer.addActor(actor);

      // The preset label is the ONLY text an annotation can carry in VR
      // (WebXR's dom-overlay is unsupported in immersive-vr on both target
      // headsets, so there is no keyboard). Rendering it is what makes an
      // annotation say something rather than just mark a spot.
      let label = null;
      if (annotation.text) {
        label = new VRTextBillboard({
          text: annotation.text,
          worldHeight: LABEL_APPARENT_HEIGHT_M,
          color: LABEL_TEXT_COLOR,
          background: LABEL_BACKGROUND,
        }).attach(renderer);
      }

      this._markerActors.set(annotation.id, { actor, label });
    }
  }

  /** @private */
  _createMarkerActor(annotation) {
    const source = vtkSphereSource.newInstance({
      radius: 1.0, // scaled per-frame via _apparentScale
      phiResolution: 12,
      thetaResolution: 12,
    });

    const mapper = vtkMapper.newInstance();
    mapper.setInputConnection(source.getOutputPort());

    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);

    const color = Array.isArray(annotation.color)
      ? annotation.color
      : DEFAULT_MARKER_COLOR;
    const property = actor.getProperty();
    property.setColor(...color);
    property.setLighting(false);

    actor.setPickable(false); // never intercept tool/teleport raycasts

    // annotation.position is already data/scene space ({x,y,z}).
    const p = annotation.position || {};
    actor.setPosition(p.x || 0, p.y || 0, p.z || 0);

    return actor;
  }

  /** @private Remove all marker actors from the renderer they were added to. */
  _clearMarkers() {
    for (const entry of this._markerActors.values()) {
      if (this._renderer) {
        this._renderer.removeActor(entry.actor);
        entry.actor.delete?.();
      }
      entry.label?.dispose();
    }
    this._markerActors.clear();
    this._lastRenderedCount = -1;
    this._renderer = null;
  }

  handleInput(inputState, frame) {
    const { controllers } = inputState;
    const rightCtrl = controllers.right;

    if (!rightCtrl) return null;

    // Rising-edge detection: update _lastTriggerState unconditionally,
    // BEFORE acting on it, so a held trigger places exactly once per pull
    // rather than once per frame (~90Hz) — the previous version updated
    // this only on the branch that didn't place, so a successful
    // placement's early return skipped the update and re-armed itself
    // every single frame the trigger stayed down.
    const triggerPressed = !!rightCtrl.triggerPressed;
    const triggerRisingEdge = triggerPressed && !this._lastTriggerState;
    this._lastTriggerState = triggerPressed;

    if (triggerRisingEdge) {
      const hit = this._performRaycast(rightCtrl, frame);

      if (hit) {
        const annotation = this._createAnnotation(hit);
        this._annotations.push(annotation);

        return {
          type: 'annotation-created',
          data: annotation
        };
      }
    }

    // The thumbstick used to cycle annotation "mode" here. That is gone: it
    // changed only stored metadata (render() drew a sphere regardless), and the
    // thumbstick is hardcoded inert for Vision Pro transient pointers anyway,
    // so it was a Quest-only control for a no-op. Label and Color live on the
    // menu's contextual row, where both headsets can reach them.

    // A button to undo last annotation
    if (rightCtrl.buttons?.a && !this._lastAButtonState) {
      const undone = this.undoLast();
      if (undone) {
        this._lastAButtonState = true;
        return undone;
      }
    }
    this._lastAButtonState = rightCtrl.buttons?.a || false;

    return null;
  }

  /**
   * Remove the most recently placed annotation (shared by the A-button and the
   * spatial menu's Undo button).
   * @returns {Object|null} annotation-removed action, or null if none left
   */
  undoLast() {
    if (this._annotations.length === 0) return null;
    const removed = this._annotations.pop();
    return { type: 'annotation-removed', data: removed };
  }

  getControllerHints() {
    return {
      left: {},
      right: {
        trigger: 'Place marker',
        a: 'Undo last',
      },
    };
  }

  /**
   * Advance to the next marker colour (wrapping). Backs the contextual "Color"
   * button, which replaced the old mode cycle.
   * @returns {string} the newly-selected colour name
   */
  cycleColor() {
    this._colorIndex = (this._colorIndex + 1) % ANNOTATION_COLORS.length;
    return ANNOTATION_COLORS[this._colorIndex].name;
  }

  /** @returns {string} the current colour's name */
  getPendingColorName() {
    return ANNOTATION_COLORS[this._colorIndex].name;
  }

  _createAnnotation(hit) {
    return {
      id: `annot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      // Always 'marker'. The old 'text' and 'drawing' modes are gone: the
      // preset label now renders for EVERY annotation (which is what 'text'
      // was reaching for), and 'drawing' never accumulated a stroke — it
      // stored a one-element point list and drew the same sphere. Real
      // freehand drawing needs trigger-held point accumulation, a polydata
      // stroke actor, a new persisted type, and desktop rendering support; it
      // is a separate feature, not a mode flag.
      type: 'marker',
      position: { ...hit.position },
      normal: hit.normal ? { ...hit.normal } : null,
      timestamp: Date.now(),
      // The currently-selected preset label — the only text an annotation can
      // carry in VR (see ANNOTATION_LABEL_PRESETS).
      text: this._pendingLabel || '',
      color: this._getAnnotationColor(),
      size: 0.02, // 2cm marker
    };
  }

  /**
   * Advance to the next preset label (wrapping). Called from the spatial
   * menu's "Label" button.
   * @returns {string} the newly-selected label
   */
  cycleLabel() {
    const idx = ANNOTATION_LABEL_PRESETS.indexOf(this._pendingLabel);
    this._pendingLabel =
      ANNOTATION_LABEL_PRESETS[(idx + 1) % ANNOTATION_LABEL_PRESETS.length];
    return this._pendingLabel;
  }

  /** @returns {string} the label the next placed annotation will carry */
  getPendingLabel() {
    return this._pendingLabel;
  }

  /**
   * The colour the next placed annotation will carry. The explicitly-cycled
   * colour wins; otherwise fall back to the participant's own session colour so
   * annotations stay attributable at a glance in a shared session.
   * @private
   */
  _getAnnotationColor() {
    if (this._colorIndex > 0) return ANNOTATION_COLORS[this._colorIndex].rgb;
    return this._context?.vrContext?.userColor || DEFAULT_MARKER_COLOR;
  }

  _performRaycast(controller, frame) {
    if (!controller?.targetRay) return null;

    return this._context.handler.raycastVR?.(
      this._context.vrContext,
      controller.targetRay
    );
  }

  /**
   * Get all annotations
   */
  getAnnotations() {
    return this._annotations;
  }

  /**
   * Remove an annotation
   */
  removeAnnotation(annotationId) {
    const index = this._annotations.findIndex(a => a.id === annotationId);
    if (index !== -1) {
      this._annotations.splice(index, 1);
    }
  }

  /**
   * Clear all annotations
   */
  clearAnnotations() {
    this._annotations = [];
  }

  /**
   * Update annotation text (for voice input)
   */
  updateAnnotationText(annotationId, text) {
    const annotation = this._annotations.find(a => a.id === annotationId);
    if (annotation) {
      annotation.text = text;
    }
  }
}

export default VRAnnotationTool;
