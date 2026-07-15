// src/core/vr/tools/VRProbeTool.js
// Data probe tool for VR - inspect data values at positions
//
// SCOPE: intentionally session-local. Probing is transient inspection — probe
// results are neither persisted nor broadcast to collaborators (unlike
// annotations/measurements, which persist, or clip boxes, which sync).

import { VRToolInterface } from './VRToolInterface.js';
import { vr as log } from '@Utils/logger.js';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkVectorText from '@kitware/vtk.js/Rendering/Core/VectorText';

const MARKER_APPARENT_RADIUS_M = 0.012;
const LABEL_APPARENT_HEIGHT_M = 0.02;
const MARKER_COLOR = [0.2, 0.9, 0.4];
const LABEL_COLOR = [0.1, 0.1, 0.1];

export class VRProbeTool extends VRToolInterface {
  constructor() {
    super({
      id: 'probe',
      name: 'Probe',
      icon: 'crosshair',
      category: 'analysis',
    });

    this._probeHistory = [];
    this._currentProbe = null;
    this._continuousMode = false;
    this._maxHistorySize = 50;

    // In-headset visuals (created lazily in render()).
    this._renderer = null;
    this._markerActor = null;
    this._markerSource = null;
    this._labelActor = null;
    this._labelSource = null;
    this._labelText = null; // dirty-check for vtkVectorText.setText
  }

  async activate(context) {
    await super.activate(context);
    log.debug('Probe tool activated');
  }

  async deactivate() {
    await super.deactivate();
    this._currentProbe = null;
    this._clearVisuals();
  }

  /**
   * Draw a marker sphere at the current probe point plus a vtkVectorText label
   * showing the probed value(s). Hidden when there is no current probe.
   * @param {Object} renderer - VTK VR scene renderer
   */
  render(renderer) {
    if (!renderer) return;
    this._renderer = renderer;

    const probe = this._currentProbe;
    const pos = probe?.position;
    if (!probe || !pos) {
      this._setVisible(false);
      return;
    }

    this._ensureActors(renderer);

    const ms = this._apparentScale(MARKER_APPARENT_RADIUS_M);
    if (this._markerActor) {
      this._markerActor.setPosition(pos.x, pos.y, pos.z);
      this._markerActor.setScale(ms, ms, ms);
      this._markerActor.setVisibility(true);
    }

    if (this._labelActor) {
      const text = this._formatProbeText(probe.data);
      if (text !== this._labelText && this._labelSource) {
        this._labelSource.setText(text);
        this._labelText = text;
      }
      // Float the label slightly above the marker.
      const lift = MARKER_APPARENT_RADIUS_M / this._getVrScale();
      this._labelActor.setPosition(pos.x, pos.y + lift, pos.z);
      const ls = this._apparentScale(LABEL_APPARENT_HEIGHT_M);
      this._labelActor.setScale(ls, ls, ls);
      this._labelActor.setVisibility(true);
    }
  }

  /**
   * Build a short one-line summary of the probe data for the 3D label.
   * @private
   */
  _formatProbeText(data) {
    if (!data) return 'no data';
    if (data.values && typeof data.values === 'object') {
      const parts = Object.entries(data.values).map(([name, v]) => {
        const val = Array.isArray(v)
          ? v.map((n) => (typeof n === 'number' ? n.toFixed(2) : n)).join(', ')
          : typeof v === 'number'
          ? v.toFixed(3)
          : v;
        return `${name}: ${val}`;
      });
      if (parts.length) return parts.join('  ');
    }
    if (data.value !== null && data.value !== undefined) {
      const name = data.arrayName || 'value';
      const val =
        typeof data.value === 'number' ? data.value.toFixed(3) : data.value;
      return `${name}: ${val}`;
    }
    return 'no data';
  }

  /** @private Lazily build the marker + label actors once. */
  _ensureActors(renderer) {
    if (!this._markerSource) {
      this._markerSource = vtkSphereSource.newInstance({
        radius: 1.0,
        phiResolution: 12,
        thetaResolution: 12,
      });
      const mapper = vtkMapper.newInstance();
      mapper.setInputConnection(this._markerSource.getOutputPort());
      const actor = vtkActor.newInstance();
      actor.setMapper(mapper);
      actor.getProperty().setColor(...MARKER_COLOR);
      actor.getProperty().setLighting(false);
      actor.setPickable(false);
      actor.setVisibility(false);
      this._markerActor = actor;
      renderer.addActor(actor);
    }
    if (!this._labelActor) {
      try {
        this._labelSource = vtkVectorText.newInstance();
        this._labelSource.setText('');
        const mapper = vtkMapper.newInstance();
        mapper.setInputConnection(this._labelSource.getOutputPort());
        const actor = vtkActor.newInstance();
        actor.setMapper(mapper);
        actor.getProperty().setColor(...LABEL_COLOR);
        actor.getProperty().setLighting(false);
        actor.setPickable(false);
        actor.setVisibility(false);
        this._labelActor = actor;
        renderer.addActor(actor);
      } catch (err) {
        log.warn(`VR probe label unavailable: ${err?.message}`);
        this._labelSource = null;
        this._labelActor = null;
      }
    }
  }

  /** @private */
  _setVisible(visible) {
    this._markerActor?.setVisibility(visible);
    this._labelActor?.setVisibility(visible);
  }

  /** @private Remove all visual actors from the renderer they were added to. */
  _clearVisuals() {
    const r = this._renderer;
    if (r) {
      for (const actor of [this._markerActor, this._labelActor]) {
        if (actor) {
          r.removeActor(actor);
          actor.delete?.();
        }
      }
    }
    this._markerActor = this._markerSource = null;
    this._labelActor = this._labelSource = null;
    this._labelText = null;
    this._renderer = null;
  }

  handleInput(inputState, frame) {
    const { controllers } = inputState;
    const rightCtrl = controllers.right;

    if (!rightCtrl) return null;

    // Continuous probing while trigger held
    if (this._continuousMode && rightCtrl.triggerValue > 0.5) {
      const hit = this._performRaycast(rightCtrl, frame);
      if (hit) {
        const probeData = this._probeAtPosition(hit.position);
        this._currentProbe = {
          position: { ...hit.position },
          data: probeData,
          timestamp: Date.now(),
        };

        return {
          type: 'probe-continuous',
          data: this._currentProbe
        };
      }
    }

    // Single probe on trigger press. Rising-edge detection: update
    // _lastTriggerState unconditionally BEFORE acting on it — the old
    // placement below returns early on success, so updating this after the
    // if-block never ran and re-armed itself every frame the trigger
    // stayed down (same bug fixed in VRAnnotationTool/VRMeasureTool).
    const triggerPressed = !!rightCtrl.triggerPressed;
    const triggerRisingEdge = triggerPressed && !this._lastTriggerState;
    this._lastTriggerState = triggerPressed;

    if (triggerRisingEdge) {
      const hit = this._performRaycast(rightCtrl, frame);

      if (hit) {
        const probeData = this._probeAtPosition(hit.position);

        const probe = {
          id: `probe_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          position: { ...hit.position },
          normal: hit.normal ? { ...hit.normal } : null,
          data: probeData,
          timestamp: Date.now(),
        };

        this._currentProbe = probe;
        this._addToHistory(probe);

        return {
          type: 'probe-created',
          data: probe
        };
      }
    }

    // A button to toggle continuous mode
    if (rightCtrl.buttons?.a && !this._lastAButtonState) {
      this._continuousMode = !this._continuousMode;
      this._lastAButtonState = true;

      return {
        type: 'probe-mode-changed',
        data: { continuous: this._continuousMode }
      };
    }
    this._lastAButtonState = rightCtrl.buttons?.a || false;

    // B button to clear history
    if (rightCtrl.buttons?.b && !this._lastBButtonState) {
      this._probeHistory = [];
      this._currentProbe = null;
      this._lastBButtonState = true;

      return { type: 'probe-history-cleared' };
    }
    this._lastBButtonState = rightCtrl.buttons?.b || false;

    // Thumbstick to navigate history
    const thumbstickY = rightCtrl.thumbstick?.y || 0;
    if (Math.abs(thumbstickY) > 0.8 && !this._lastThumbstickState && this._probeHistory.length > 0) {
      const currentIndex = this._currentProbe
        ? this._probeHistory.findIndex(p => p.id === this._currentProbe.id)
        : -1;

      let newIndex;
      if (thumbstickY > 0) {
        newIndex = currentIndex < this._probeHistory.length - 1 ? currentIndex + 1 : 0;
      } else {
        newIndex = currentIndex > 0 ? currentIndex - 1 : this._probeHistory.length - 1;
      }

      this._currentProbe = this._probeHistory[newIndex];
      this._lastThumbstickState = true;

      return {
        type: 'probe-history-navigated',
        data: this._currentProbe
      };
    }
    if (Math.abs(thumbstickY) < 0.3) {
      this._lastThumbstickState = false;
    }

    return null;
  }

  getControllerHints() {
    return {
      left: {},
      right: {
        trigger: this._continuousMode ? 'Probe (hold)' : 'Probe',
        thumbstick: 'Navigate history',
        a: this._continuousMode ? 'Single mode' : 'Continuous mode',
        b: 'Clear history',
      },
    };
  }

  _probeAtPosition(position) {
    // Delegate to handler to get actual data values
    const probeResult = this._context.handler.probeDataVR?.(
      this._context.vrContext,
      position
    );

    if (probeResult) {
      return probeResult;
    }

    // Fallback data
    return {
      position: { ...position },
      value: null,
      arrayName: null,
      pointId: null,
      cellId: null,
    };
  }

  _performRaycast(controller, frame) {
    if (!controller?.targetRay) return null;

    return this._context.handler.raycastVR?.(
      this._context.vrContext,
      controller.targetRay
    );
  }

  _addToHistory(probe) {
    this._probeHistory.push(probe);

    // Trim history if too long
    if (this._probeHistory.length > this._maxHistorySize) {
      this._probeHistory.shift();
    }
  }

  /**
   * Get current probe
   */
  getCurrentProbe() {
    return this._currentProbe;
  }

  /**
   * Get probe history
   */
  getProbeHistory() {
    return this._probeHistory;
  }

  /**
   * Check if in continuous mode
   */
  isContinuousMode() {
    return this._continuousMode;
  }

  /**
   * Set continuous mode
   */
  setContinuousMode(enabled) {
    this._continuousMode = enabled;
  }

  /**
   * Clear probe history
   */
  clearHistory() {
    this._probeHistory = [];
    this._currentProbe = null;
  }

  /**
   * Export probe history for analysis
   */
  exportHistory() {
    return this._probeHistory.map(probe => ({
      id: probe.id,
      position: probe.position,
      data: probe.data,
      timestamp: probe.timestamp,
    }));
  }
}

export default VRProbeTool;
