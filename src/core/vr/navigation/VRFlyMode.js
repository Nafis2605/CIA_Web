// src/core/vr/navigation/VRFlyMode.js
// Free-flying navigation mode for VR exploration

import { vr as log } from "@Utils/logger.js";

export class VRFlyMode {
  constructor(vrContext, options = {}) {
    this._vrContext = vrContext;
    this._options = {
      baseSpeed: 2.0, // meters per second at scale 1.0
      boostMultiplier: 3.0,
      deadzone: 0.15, // Thumbstick deadzone
      smoothing: 0.9, // Velocity smoothing factor
      groundLocked: false, // If true, Y movement is locked (walk mode)
      ...options,
    };

    // Movement state
    this._velocity = { x: 0, y: 0, z: 0 };
    this._isActive = false;
  }

  activate() {
    this._isActive = true;
    this._velocity = { x: 0, y: 0, z: 0 };
    log.debug("VRFlyMode activated");
  }

  deactivate() {
    this._isActive = false;
    log.debug("VRFlyMode deactivated");
  }

  /**
   * Toggle ground-locking (walk mode) at runtime. update() reads
   * this._options.groundLocked each frame, so mutating it here is enough — no
   * need for a second FlyMode instance. When true, vertical (Y) stick/button
   * movement is zeroed so the user stays on the floor plane.
   * @param {boolean} locked
   */
  setGroundLocked(locked) {
    this._options.groundLocked = !!locked;
  }

  /** No-op re-anchor hook (parity with grab layers) — fly holds no cross-frame
   * anchor beyond smoothed velocity, so nothing to reset. @param */
  onFrameSkipped() {
    // Bleed velocity so locomotion doesn't lurch when a suppressed frame
    // (two-hand scale) ends.
    this._velocity = { x: 0, y: 0, z: 0 };
  }

  /**
   * Update navigation based on input.
   *
   * Returns an ABSOLUTE new vrOrigin (data space) in `position`, matching
   * VRTeleportMode's contract — VRExplorationManager._onFrame applies
   * `navResult.position` directly to `vrContext.vrOrigin` for either mode.
   *
   * @param {Object} inputState - Controller input state
   * @param {XRFrame} frame - XR frame
   * @param {number} deltaTime - Time since last frame in seconds
   * @returns {Object} { position, orientation, isBoosting, speed }
   */
  update(inputState, frame, deltaTime) {
    if (!this._isActive) return { position: null, orientation: null };

    const leftController = inputState.controllers?.left;

    // baseSpeed is "meters per second at scale 1.0" (a physical walking
    // pace); dividing by vrScale converts that into the equivalent
    // data-space speed, matching the camera's own xrPos/vrScale mapping
    // (VTKInstanceHandler._updateCameraFromVRPose) so flying feels like a
    // consistent physical pace regardless of the current zoom level.
    const vrScale = this._vrContext.vrScale || 1.0;
    const scaledSpeed = this._options.baseSpeed / vrScale;

    // Calculate desired movement from left thumbstick
    const moveInput = this._getMovementInput(leftController);

    // Constant speed. Boost USED to be "right trigger held", but the trigger is
    // now the object-move gesture (see VRNavigationController layered model), so
    // coupling boost to it would 3x fly speed whenever the user drags data.
    const speed = scaledSpeed;

    // Calculate target velocity
    const targetVelocity = {
      x: moveInput.x * speed,
      y: this._options.groundLocked ? 0 : moveInput.y * speed,
      z: moveInput.z * speed,
    };

    // Smooth velocity
    const smoothing = this._options.smoothing;
    this._velocity = {
      x: this._velocity.x * smoothing + targetVelocity.x * (1 - smoothing),
      y: this._velocity.y * smoothing + targetVelocity.y * (1 - smoothing),
      z: this._velocity.z * smoothing + targetVelocity.z * (1 - smoothing),
    };

    // Calculate position delta (data space, see scaledSpeed comment above)
    const positionDelta = {
      x: this._velocity.x * deltaTime,
      y: this._velocity.y * deltaTime,
      z: this._velocity.z * deltaTime,
    };

    // Transform movement by head orientation, so pushing the stick
    // "forward" moves in the direction the user is physically looking.
    const headOrientation = inputState.headPose?.orientation;
    const transformedDelta = this._transformByOrientation(
      positionDelta,
      headOrientation
    );

    const vrOrigin = this._vrContext.vrOrigin || [0, 0, 0];
    const position = {
      x: vrOrigin[0] + transformedDelta.x,
      y: vrOrigin[1] + transformedDelta.y,
      z: vrOrigin[2] + transformedDelta.z,
    };

    return {
      position,
      orientation: null,
      isBoosting: false,
      speed: Math.sqrt(
        this._velocity.x ** 2 + this._velocity.y ** 2 + this._velocity.z ** 2
      ),
    };
  }

  /**
   * Get movement input from left controller thumbstick
   * @private
   */
  _getMovementInput(controller) {
    if (!controller?.thumbstick) {
      return { x: 0, y: 0, z: 0 };
    }

    const { x, y } = controller.thumbstick;
    const deadzone = this._options.deadzone;

    // Apply deadzone
    const adjustedX = Math.abs(x) > deadzone ? x : 0;
    const adjustedY = Math.abs(y) > deadzone ? y : 0;

    // Map thumbstick to movement
    // X = strafe left/right
    // Y = forward/back (inverted so push forward moves forward)
    // Vertical movement from A/B buttons or squeeze
    let verticalInput = 0;
    if (controller.buttons?.a) verticalInput = 1;
    if (controller.buttons?.b) verticalInput = -1;
    if (controller.squeezeValue > 0.5) verticalInput = controller.squeezeValue;

    return {
      x: adjustedX, // Strafe
      y: verticalInput, // Up/down
      z: -adjustedY, // Forward/back
    };
  }

  /**
   * Transform movement vector by head orientation
   * @private
   */
  _transformByOrientation(movement, orientation) {
    if (!orientation) return movement;

    // Extract yaw from quaternion (we only want horizontal rotation)
    const { x: qx, y: qy, z: qz, w: qw } = orientation;

    // Calculate yaw angle from quaternion
    const siny_cosp = 2 * (qw * qy + qz * qx);
    const cosy_cosp = 1 - 2 * (qx * qx + qy * qy);
    const yaw = Math.atan2(siny_cosp, cosy_cosp);

    // Rotate movement vector around Y axis
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);

    return {
      x: movement.x * cos - movement.z * sin,
      y: movement.y, // Keep vertical component
      z: movement.x * sin + movement.z * cos,
    };
  }
}

export default VRFlyMode;
