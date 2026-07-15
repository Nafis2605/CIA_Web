// src/core/vr/tools/VRAnnotationTool.js
// Annotation tool for VR - place markers and text annotations

import { VRToolInterface } from './VRToolInterface.js';
import { vr as log } from '@Utils/logger.js';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';

// Apparent radius (metres) of a placed-annotation marker sphere, kept constant
// as the world scales via VRToolInterface._apparentScale.
const MARKER_APPARENT_RADIUS_M = 0.015;
const DEFAULT_MARKER_COLOR = [1, 0.5, 0];

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
    this._annotationMode = 'marker'; // 'marker' | 'text' | 'drawing'
    this._pendingLabel = ANNOTATION_LABEL_PRESETS[0];

    // In-headset marker actors, keyed by annotation id. Reconciled against
    // `this._annotations` in render() only when the count changes (dirty
    // check), then rescaled every frame for constant apparent size.
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
    for (const actor of this._markerActors.values()) {
      actor.setScale(s, s, s);
    }
  }

  /**
   * Add actors for new annotations and remove actors for undone ones, keying
   * on annotation id so an add+undo in the same frame still reconciles right.
   * @private
   */
  _reconcileMarkers(renderer) {
    const liveIds = new Set(this._annotations.map((a) => a.id));

    for (const [id, actor] of this._markerActors) {
      if (!liveIds.has(id)) {
        renderer.removeActor(actor);
        actor.delete?.();
        this._markerActors.delete(id);
      }
    }

    for (const annotation of this._annotations) {
      if (this._markerActors.has(annotation.id)) continue;
      const actor = this._createMarkerActor(annotation);
      if (actor) {
        renderer.addActor(actor);
        this._markerActors.set(annotation.id, actor);
      }
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
    if (this._renderer) {
      for (const actor of this._markerActors.values()) {
        this._renderer.removeActor(actor);
        actor.delete?.();
      }
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

    // Thumbstick to cycle annotation types
    const thumbstickX = rightCtrl.thumbstick?.x || 0;
    if (Math.abs(thumbstickX) > 0.8 && !this._lastThumbstickState) {
      if (thumbstickX > 0) {
        this._cycleAnnotationMode(1);
      } else {
        this._cycleAnnotationMode(-1);
      }
      return {
        type: 'annotation-mode-changed',
        data: { mode: this._annotationMode }
      };
    }
    this._lastThumbstickState = Math.abs(thumbstickX) > 0.8;

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
        trigger: `Place ${this._annotationMode}`,
        thumbstick: 'Change annotation type',
        a: 'Undo last',
      },
    };
  }

  _createAnnotation(hit) {
    const annotation = {
      id: `annot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: this._annotationMode,
      position: { ...hit.position },
      normal: hit.normal ? { ...hit.normal } : null,
      timestamp: Date.now(),
      // The currently-selected preset label (see cycleLabel/ANNOTATION_LABEL_PRESETS)
      // applies regardless of marker/text/drawing mode — it's the same
      // underlying "what does this annotation say" concern either way.
      text: this._pendingLabel || '',
      color: this._getAnnotationColor(),
    };

    // Add type-specific data
    switch (this._annotationMode) {
      case 'marker':
        annotation.size = 0.02; // 2cm marker
        break;
      case 'text':
        annotation.fontSize = 0.05;
        break;
      case 'drawing':
        annotation.points = [hit.position];
        annotation.strokeWidth = 0.005;
        break;
    }

    return annotation;
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

  _cycleAnnotationMode(direction) {
    const modes = ['marker', 'text', 'drawing'];
    const currentIndex = modes.indexOf(this._annotationMode);
    const newIndex = (currentIndex + direction + modes.length) % modes.length;
    this._annotationMode = modes[newIndex];
  }

  _getAnnotationColor() {
    // Get user color from context or use default
    return this._context?.vrContext?.userColor || [1, 0.5, 0];
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
   * Get current annotation mode
   */
  getAnnotationMode() {
    return this._annotationMode;
  }

  /**
   * Set annotation mode
   */
  setAnnotationMode(mode) {
    if (['marker', 'text', 'drawing'].includes(mode)) {
      this._annotationMode = mode;
    }
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
