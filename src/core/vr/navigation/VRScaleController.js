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
      smoothing: 0.8, // Scale change smoothing
      gripThreshold: 0.7, // Grip value to consider "gripping"
      ...options,
    };

    // Current scale
    this._scale = vrContext.vrScale || 1.0;

    // Gesture state
    this._isScaling = false;
    this._initialGripDistance = null;
    this._initialScale = null;
  }

  /**
   * Update scale controller based on input
   *
   * @param {Object} inputState - Controller input state
   * @param {number} deltaTime - Time since last frame
   * @returns {Object} { scaling, newScale }
   */
  update(inputState, deltaTime) {
    const leftController = inputState.controllers?.left;
    const rightController = inputState.controllers?.right;

    // Check for two-hand grip
    const leftGripping =
      leftController?.squeezeValue > this._options.gripThreshold;
    const rightGripping =
      rightController?.squeezeValue > this._options.gripThreshold;

    if (leftGripping && rightGripping) {
      // Both hands gripping - scaling gesture
      return this._handleScaleGesture(leftController, rightController);
    } else if (this._isScaling) {
      // Release scaling gesture
      this._endScaleGesture();
    }

    return { scaling: false, newScale: this._scale };
  }

  /**
   * Handle active scale gesture
   * @private
   */
  _handleScaleGesture(leftController, rightController) {
    const leftPos = leftController.pose?.position;
    const rightPos = rightController.pose?.position;

    if (!leftPos || !rightPos) {
      return { scaling: false, newScale: this._scale };
    }

    // Calculate current distance between hands
    const currentDistance = this._calculateDistance(leftPos, rightPos);

    if (!this._isScaling) {
      // Start scaling
      this._startScaleGesture(currentDistance);
      return { scaling: true, newScale: this._scale };
    }

    // Calculate scale change
    const distanceRatio = currentDistance / this._initialGripDistance;
    const targetScale = this._initialScale / distanceRatio; // Inverse - pulling apart zooms out

    // Apply sensitivity and smoothing
    const scaledTarget =
      this._scale +
      (targetScale - this._scale) *
        this._options.scaleSensitivity *
        (1 - this._options.smoothing);

    // Clamp to limits
    this._scale = Math.max(
      this._options.minScale,
      Math.min(this._options.maxScale, scaledTarget)
    );

    // Update VR context
    this._vrContext.vrScale = this._scale;

    return { scaling: true, newScale: this._scale };
  }

  /**
   * Start scale gesture
   * @private
   */
  _startScaleGesture(initialDistance) {
    this._isScaling = true;
    this._initialGripDistance = initialDistance;
    this._initialScale = this._scale;
    log.debug("Scale gesture started", { initialDistance, initialScale: this._scale });
  }

  /**
   * End scale gesture
   * @private
   */
  _endScaleGesture() {
    this._isScaling = false;
    this._initialGripDistance = null;
    this._initialScale = null;
    log.debug("Scale gesture ended", { finalScale: this._scale });
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
