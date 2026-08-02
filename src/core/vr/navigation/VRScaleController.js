// src/core/vr/navigation/VRScaleController.js
// Handles VR scale changes via two-hand pinch gesture

import { vr as log } from "@Utils/logger.js";

// Below this hand separation, atan2(dx, dz) is tracking-noise-sized (the X/Z
// deltas are near zero), so the "handlebar" heading is essentially random —
// don't let it inject rotation jitter into vrRotation.
const MIN_TWIST_SEPARATION_M = 0.15;
// Floor for the grip-distance ratio's denominator (and numerator), so hands
// nearly touching don't produce a divide-by-near-zero scale spike.
const MIN_GRIP_SEPARATION_M = 0.05;

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
      // Release threshold, lower than gripThreshold (hysteresis). Without a
      // gap, squeeze noise hovering right at 0.7 rapidly starts/stops the
      // gesture every frame.
      gripReleaseThreshold: 0.4,
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
    this._lastAngle = null;
    this._rotationAccum = 0;
  }

  /**
   * True when a hand is "engaged" for the two-hand gesture. Mirrors the
   * world-grab predicate in VRExplorationManager (~232-238): transient-
   * pointer sources (Apple Vision Pro's gripless pinch — squeezeValue is
   * always 0) engage on triggerPressed; tracked controllers (Quest 2) use
   * squeeze ONLY. Without this split, pulling BOTH TRIGGERS on Quest 2 (e.g.
   * mid object-move) also engaged this gesture, which has the highest
   * precedence in VRNavigationController and silently suppressed grab, fly
   * and snap-turn.
   *
   * @param {Object} controller
   * @param {boolean} [engaged] - Whether this hand is already part of an
   *   active gesture. When true, the (lower) release threshold is used
   *   instead of the engage threshold, giving squeeze hysteresis so noise
   *   hovering near the threshold doesn't chatter the gesture on/off.
   * @private
   */
  _isEngaged(controller, engaged = false) {
    if (!controller) return false;
    if (controller.isTransientPointer) {
      return controller.triggerPressed === true;
    }
    const threshold = engaged
      ? this._options.gripReleaseThreshold
      : this._options.gripThreshold;
    return (controller.squeezeValue || 0) > threshold;
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

    if (
      this._isEngaged(leftController, this._isScaling) &&
      this._isEngaged(rightController, this._isScaling)
    ) {
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
    const safeCurrent = Math.max(currentDistance, MIN_GRIP_SEPARATION_M);
    const distanceRatio = safeCurrent / this._initialGripDistance;
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
    //
    // Integrate PER-FRAME deltas. The previous form,
    // _normalizeAngle(currentAngle - this._initialAngle), used a FROZEN
    // baseline: twisting past +/-180 degrees from the gesture's start
    // heading wrapped the sign and snapped the world a full turn mid-gesture.
    // Per-frame steps are milliradians, so _normalizeAngle here only ever
    // removes a genuine +/-PI seam crossing.
    if (currentDistance >= MIN_TWIST_SEPARATION_M) {
      this._rotationAccum += this._normalizeAngle(currentAngle - this._lastAngle);
    }
    // Re-seed unconditionally: a dip below the separation threshold must be
    // SKIPPED, not deferred — otherwise noise accumulated while the hands
    // were too close gets injected in one step when they separate again.
    this._lastAngle = currentAngle;
    const newRotation = this._initialRotation + this._rotationAccum;
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
    this._initialGripDistance = Math.max(initialDistance, MIN_GRIP_SEPARATION_M);
    this._initialScale = this._scale;
    this._initialAngle = initialAngle;
    this._initialRotation = this._vrContext.vrRotation || 0;
    this._lastAngle = initialAngle;
    this._rotationAccum = 0;
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
    this._lastAngle = null;
    this._rotationAccum = 0;
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
