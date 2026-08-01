// src/core/vr/navigation/VRScaleController.js
// Handles VR scale changes via two-hand pinch gesture

import { vr as log } from "@Utils/logger.js";

export class VRScaleController {
  constructor(vrContext, options = {}) {
    this._vrContext = vrContext;
    this._options = {
      minScale: 0.01, // Minimum scale (100x zoom in)
      maxScale: 100.0, // Maximum scale (100x zoom out)
      scaleSensitivity: 1.0, // How fast scale changes
      // Exponential smoothing time constant (seconds) — dt-correct, unlike a
      // per-frame smoothing factor (see _handleTwoHandGesture). -(1/72)/
      // Math.log(0.8) matches the feel of the old smoothing:0.8 at 72 Hz.
      smoothingTau: 0.0622,
      gripThreshold: 0.7, // Grip value to consider "gripping"
      ...options,
    };

    // Current scale
    this._scale = vrContext.vrScale || 1.0;

    // Gesture state
    this._isScaling = false;
    this._initialGripDistance = null;
    this._initialScale = null;
    this._initialAngle = null;
    this._initialRotation = null;
  }

  /**
   * True when a hand is "engaged" for the two-hand gesture: a pinch
   * (triggerPressed) on Apple Vision Pro's gripless transient-pointer — whose
   * squeezeValue is always 0 — or a grip squeeze on tracked controllers.
   * @private
   */
  _isEngaged(controller) {
    if (!controller) return false;
    return (
      controller.triggerPressed === true ||
      (controller.squeezeValue || 0) > this._options.gripThreshold
    );
  }

  /**
   * Update scale + twist controller based on input.
   *
   * Two hands engaged simultaneously drives the "handlebar" gesture: the
   * distance between the hands controls scale (spread apart = zoom out) and
   * their relative heading controls yaw rotation (twist = spin the dataset on
   * a turntable). Triggering on pinch (not squeeze) is what makes this work on
   * Vision Pro, where squeezeValue is always 0.
   *
   * @param {Object} inputState - Controller input state
   * @param {number} deltaTime - Time since last frame
   * @returns {Object} { scaling, newScale, rotating, newRotation }
   */
  update(inputState, deltaTime) {
    const leftController = inputState.controllers?.left;
    const rightController = inputState.controllers?.right;

    if (this._isEngaged(leftController) && this._isEngaged(rightController)) {
      return this._handleTwoHandGesture(
        leftController,
        rightController,
        deltaTime
      );
    } else if (this._isScaling) {
      this._endGesture();
    }

    return { scaling: false, newScale: this._scale, rotating: false };
  }

  /**
   * Handle active two-hand scale + twist gesture.
   * @private
   */
  _handleTwoHandGesture(leftController, rightController, deltaTime) {
    const leftPos = leftController.pose?.position;
    const rightPos = rightController.pose?.position;

    if (!leftPos || !rightPos) {
      return { scaling: false, newScale: this._scale, rotating: false };
    }

    const currentDistance = this._calculateDistance(leftPos, rightPos);
    // Heading of the hand-to-hand vector in the horizontal (XZ) plane — the
    // "handlebar" angle. Twisting the wrists changes it and rotates the model.
    const currentAngle = Math.atan2(
      rightPos.x - leftPos.x,
      rightPos.z - leftPos.z
    );

    if (!this._isScaling) {
      this._startGesture(currentDistance, currentAngle);
      return {
        scaling: true,
        newScale: this._scale,
        rotating: true,
        newRotation: this._vrContext.vrRotation || 0,
      };
    }

    // --- Scale from distance ratio (pulling apart zooms out) ---
    // Exponential decay toward targetScale with a fixed time constant (tau),
    // so the ramp feels the same regardless of frame rate. A per-frame
    // smoothing factor (the old `smoothing: 0.8` applied every frame,
    // independent of deltaTime) converges faster at higher Hz.
    const distanceRatio = currentDistance / this._initialGripDistance;
    const targetScale = this._initialScale / distanceRatio;
    const alpha = 1 - Math.exp(-deltaTime / this._options.smoothingTau);
    const scaledTarget =
      this._scale +
      (targetScale - this._scale) * this._options.scaleSensitivity * alpha;
    this._scale = Math.max(
      this._options.minScale,
      Math.min(this._options.maxScale, scaledTarget)
    );
    this._vrContext.vrScale = this._scale;

    // --- Yaw from the change in handlebar angle ---
    // Flip the sign here if the twist feels reversed on-device.
    const deltaAngle = this._normalizeAngle(currentAngle - this._initialAngle);
    const newRotation = this._initialRotation + deltaAngle;
    this._vrContext.vrRotation = newRotation;

    return {
      scaling: true,
      newScale: this._scale,
      rotating: true,
      newRotation,
    };
  }

  /**
   * Wrap an angle delta into (-π, π] so a twist never jumps a full turn.
   * @private
   */
  _normalizeAngle(a) {
    let x = a;
    while (x > Math.PI) x -= 2 * Math.PI;
    while (x <= -Math.PI) x += 2 * Math.PI;
    return x;
  }

  /**
   * Start the two-hand gesture — anchor both the scale and rotation baselines.
   * @private
   */
  _startGesture(initialDistance, initialAngle) {
    this._isScaling = true;
    this._initialGripDistance = initialDistance;
    this._initialScale = this._scale;
    this._initialAngle = initialAngle;
    this._initialRotation = this._vrContext.vrRotation || 0;
    log.debug("Two-hand gesture started", {
      initialDistance,
      initialScale: this._scale,
      initialRotation: this._initialRotation,
    });
  }

  /**
   * End the two-hand gesture.
   * @private
   */
  _endGesture() {
    this._isScaling = false;
    this._initialGripDistance = null;
    this._initialScale = null;
    this._initialAngle = null;
    this._initialRotation = null;
    log.debug("Two-hand gesture ended", {
      finalScale: this._scale,
      finalRotation: this._vrContext.vrRotation,
    });
  }

  /**
   * Calculate distance between two positions
   * @private
   */
  _calculateDistance(pos1, pos2) {
    const dx = pos2.x - pos1.x;
    const dy = pos2.y - pos1.y;
    const dz = pos2.z - pos1.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Get current scale
   */
  getScale() {
    return this._scale;
  }

  /**
   * Set scale directly
   */
  setScale(scale) {
    this._scale = Math.max(
      this._options.minScale,
      Math.min(this._options.maxScale, scale)
    );
    this._vrContext.vrScale = this._scale;
  }

  /**
   * Get minimum scale
   */
  getMinScale() {
    return this._options.minScale;
  }

  /**
   * Get maximum scale
   */
  getMaxScale() {
    return this._options.maxScale;
  }

  /**
   * Check if currently scaling
   */
  isScaling() {
    return this._isScaling;
  }

  /**
   * Clean up
   */
  cleanup() {
    this._isScaling = false;
  }
}

export default VRScaleController;
