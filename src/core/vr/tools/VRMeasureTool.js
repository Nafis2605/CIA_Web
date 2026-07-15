// src/core/vr/tools/VRMeasureTool.js
// Distance measurement tool for VR

import { VRToolInterface } from './VRToolInterface.js';
import { vr as log } from '@Utils/logger.js';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkLineSource from '@kitware/vtk.js/Filters/Sources/LineSource';
import vtkVectorText from '@kitware/vtk.js/Rendering/Core/VectorText';

const ENDPOINT_APPARENT_RADIUS_M = 0.012;
const LABEL_APPARENT_HEIGHT_M = 0.02;
const LINE_COLOR = [1.0, 0.85, 0.2];
const ENDPOINT_COLOR = [1.0, 0.6, 0.1];
const LABEL_COLOR = [0.1, 0.1, 0.1];

export class VRMeasureTool extends VRToolInterface {
  constructor() {
    super({
      id: 'measure',
      name: 'Measure',
      icon: 'ruler',
      category: 'analysis',
    });

    this._measurements = [];
    this._activeMeasurement = null;
    this._measurementState = 'idle'; // 'idle' | 'placing-start' | 'placing-end'

    // In-headset visuals (created lazily in render()).
    this._renderer = null;
    this._lineActor = null;
    this._lineSource = null;
    this._startActor = null;
    this._startSource = null;
    this._endActor = null;
    this._endSource = null;
    this._labelActor = null;
    this._labelSource = null;
    this._labelText = null; // dirty-check for vtkVectorText.setText
  }

  async activate(context) {
    await super.activate(context);
    this._measurementState = 'placing-start';
    log.debug('Measure tool activated');
  }

  async deactivate() {
    await super.deactivate();
    this._measurementState = 'idle';
    this._activeMeasurement = null;
    this._clearVisuals();
  }

  /**
   * Draw the current measurement (the one being placed, or the most recently
   * completed): a line between the two endpoints, a sphere at each endpoint,
   * and a vtkVectorText label showing the distance. When only a start point
   * exists, just the start sphere shows. Actors are created lazily on first
   * render and reused across frames.
   * @param {Object} renderer - VTK VR scene renderer
   */
  render(renderer) {
    if (!renderer) return;
    this._renderer = renderer;

    const m = this._currentVisual();
    if (!m || !m.startPoint) {
      this._setVisible(false);
      return;
    }

    this._ensureActors(renderer);

    const sphereScale = this._apparentScale(ENDPOINT_APPARENT_RADIUS_M);
    const start = m.startPoint;

    // Start endpoint always shown when a measurement exists.
    if (this._startActor) {
      this._startActor.setPosition(start.x, start.y, start.z);
      this._startActor.setScale(sphereScale, sphereScale, sphereScale);
      this._startActor.setVisibility(true);
    }

    const end = m.endPoint;
    const hasEnd = !!end;

    if (this._lineActor && this._lineSource) {
      if (hasEnd) {
        this._lineSource.setPoint1(start.x, start.y, start.z);
        this._lineSource.setPoint2(end.x, end.y, end.z);
      }
      this._lineActor.setVisibility(hasEnd);
    }

    if (this._endActor) {
      if (hasEnd) {
        this._endActor.setPosition(end.x, end.y, end.z);
        this._endActor.setScale(sphereScale, sphereScale, sphereScale);
      }
      this._endActor.setVisibility(hasEnd);
    }

    if (this._labelActor) {
      if (hasEnd) {
        const dist =
          typeof m.distance === 'number'
            ? m.distance
            : this._calculateDistance(start, end);
        const text = `${dist.toFixed(3)} ${m.unit || 'units'}`;
        if (text !== this._labelText && this._labelSource) {
          this._labelSource.setText(text);
          this._labelText = text;
        }
        // Float the label at the segment midpoint.
        this._labelActor.setPosition(
          (start.x + end.x) / 2,
          (start.y + end.y) / 2,
          (start.z + end.z) / 2
        );
        const ls = this._apparentScale(LABEL_APPARENT_HEIGHT_M);
        this._labelActor.setScale(ls, ls, ls);
      }
      this._labelActor.setVisibility(hasEnd);
    }
  }

  /**
   * The measurement to visualize: the in-progress one if placing, else the
   * most recently completed.
   * @private
   */
  _currentVisual() {
    if (this._activeMeasurement) return this._activeMeasurement;
    if (this._measurements.length > 0) {
      return this._measurements[this._measurements.length - 1];
    }
    return null;
  }

  /** @private Lazily build the line/endpoint/label actors once. */
  _ensureActors(renderer) {
    if (!this._startSource) {
      this._startSource = vtkSphereSource.newInstance({
        radius: 1.0,
        phiResolution: 12,
        thetaResolution: 12,
      });
      this._startActor = this._makeActor(this._startSource, ENDPOINT_COLOR);
      renderer.addActor(this._startActor);
    }
    if (!this._endSource) {
      this._endSource = vtkSphereSource.newInstance({
        radius: 1.0,
        phiResolution: 12,
        thetaResolution: 12,
      });
      this._endActor = this._makeActor(this._endSource, ENDPOINT_COLOR);
      renderer.addActor(this._endActor);
    }
    if (!this._lineSource) {
      this._lineSource = vtkLineSource.newInstance({
        point1: [0, 0, 0],
        point2: [0, 0, 0],
      });
      this._lineActor = this._makeActor(this._lineSource, LINE_COLOR);
      this._lineActor.getProperty().setLineWidth(3);
      renderer.addActor(this._lineActor);
    }
    if (!this._labelActor) {
      // vtkVectorText can fail on some builds — keep the rest usable if so.
      try {
        this._labelSource = vtkVectorText.newInstance();
        this._labelSource.setText('');
        this._labelActor = this._makeActor(this._labelSource, LABEL_COLOR);
        renderer.addActor(this._labelActor);
      } catch (err) {
        log.warn(`VR measure label unavailable: ${err?.message}`);
        this._labelSource = null;
        this._labelActor = null;
      }
    }
  }

  /** @private */
  _makeActor(source, color) {
    const mapper = vtkMapper.newInstance();
    mapper.setInputConnection(source.getOutputPort());
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    actor.getProperty().setColor(...color);
    actor.getProperty().setLighting(false);
    actor.setPickable(false);
    actor.setVisibility(false);
    return actor;
  }

  /** @private */
  _setVisible(visible) {
    this._startActor?.setVisibility(visible);
    this._endActor?.setVisibility(visible);
    this._lineActor?.setVisibility(visible);
    this._labelActor?.setVisibility(visible);
  }

  /** @private Remove all visual actors from the renderer they were added to. */
  _clearVisuals() {
    const r = this._renderer;
    if (r) {
      for (const actor of [
        this._startActor,
        this._endActor,
        this._lineActor,
        this._labelActor,
      ]) {
        if (actor) {
          r.removeActor(actor);
          actor.delete?.();
        }
      }
    }
    this._startActor = this._startSource = null;
    this._endActor = this._endSource = null;
    this._lineActor = this._lineSource = null;
    this._labelActor = this._labelSource = null;
    this._labelText = null;
    this._renderer = null;
  }

  handleInput(inputState, frame) {
    const { controllers } = inputState;
    const rightCtrl = controllers.right;

    if (!rightCtrl) return null;

    // Rising-edge detection: update _lastTriggerState unconditionally,
    // BEFORE acting on it — both placement branches below return early, so
    // updating this after the if-block (as before) never ran on a
    // successful placement and re-armed itself every frame the trigger
    // stayed down (see VRAnnotationTool.handleInput for the same fix).
    const triggerPressed = !!rightCtrl.triggerPressed;
    const triggerRisingEdge = triggerPressed && !this._lastTriggerState;
    this._lastTriggerState = triggerPressed;

    // Trigger to place measurement points
    if (triggerRisingEdge) {
      const hit = this._performRaycast(rightCtrl, frame);

      if (hit) {
        if (this._measurementState === 'placing-start') {
          // Start new measurement
          this._activeMeasurement = {
            id: `measure_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            startPoint: { ...hit.position },
            endPoint: null,
            distance: 0,
            unit: 'units',
          };
          this._measurementState = 'placing-end';

          return {
            type: 'measurement-start-placed',
            data: this._activeMeasurement
          };

        } else if (this._measurementState === 'placing-end') {
          // Complete measurement
          this._activeMeasurement.endPoint = { ...hit.position };
          this._activeMeasurement.distance = this._calculateDistance(
            this._activeMeasurement.startPoint,
            this._activeMeasurement.endPoint
          );

          this._measurements.push(this._activeMeasurement);

          const completedMeasurement = { ...this._activeMeasurement };

          // Reset for next measurement
          this._activeMeasurement = null;
          this._measurementState = 'placing-start';

          return {
            type: 'measurement-created',
            data: completedMeasurement
          };
        }
      }
    }

    // B button to cancel current measurement
    if (rightCtrl.buttons?.b && this._measurementState === 'placing-end') {
      this._activeMeasurement = null;
      this._measurementState = 'placing-start';
      return { type: 'measurement-cancelled' };
    }

    // Update preview line if placing end point
    if (this._measurementState === 'placing-end' && this._activeMeasurement) {
      const hit = this._performRaycast(rightCtrl, frame);
      if (hit) {
        const previewDistance = this._calculateDistance(
          this._activeMeasurement.startPoint,
          hit.position
        );
        return {
          type: 'measurement-preview',
          data: {
            startPoint: this._activeMeasurement.startPoint,
            endPoint: hit.position,
            distance: previewDistance,
          }
        };
      }
    }

    return null;
  }

  getControllerHints() {
    const hints = {
      left: {},
      right: {
        trigger: this._measurementState === 'placing-start'
          ? 'Place start point'
          : 'Place end point',
      },
    };

    if (this._measurementState === 'placing-end') {
      hints.right.b = 'Cancel';
    }

    return hints;
  }

  /**
   * Undo the last measurement action (shared by the B-button cancel flow and
   * the spatial menu's Undo button). If a measurement is mid-placement, cancel
   * it; otherwise pop the most recently completed one.
   * @returns {Object|null} a tool action, or null if there is nothing to undo
   */
  undoLast() {
    if (this._measurementState === 'placing-end' && this._activeMeasurement) {
      this._activeMeasurement = null;
      this._measurementState = 'placing-start';
      return { type: 'measurement-cancelled' };
    }
    if (this._measurements.length > 0) {
      const removed = this._measurements.pop();
      return { type: 'measurement-removed', data: removed };
    }
    return null;
  }

  _calculateDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _performRaycast(controller, frame) {
    if (!controller?.targetRay) return null;

    return this._context.handler.raycastVR?.(
      this._context.vrContext,
      controller.targetRay
    );
  }

  /**
   * Get all measurements
   */
  getMeasurements() {
    return this._measurements;
  }

  /**
   * Remove a measurement
   */
  removeMeasurement(measurementId) {
    const index = this._measurements.findIndex(m => m.id === measurementId);
    if (index !== -1) {
      this._measurements.splice(index, 1);
    }
  }

  /**
   * Clear all measurements
   */
  clearMeasurements() {
    this._measurements = [];
  }

  /**
   * Get current measurement state
   */
  getMeasurementState() {
    return this._measurementState;
  }
}

export default VRMeasureTool;
