// src/core/vr/navigation/VRFlyMode.js
// Free-flying navigation mode for VR exploration

import { vr as log } from "@Utils/logger.js";
import { yawRotateVector } from "@Core/vr/tools/vrPlaneMath.js";

export class VRFlyMode {
  constructor(vrContext, options = {}) {
    this._vrContext = vrContext;
    this._options = {
      baseSpeed: 2.0, // meters per second at scale 1.0
      boostMultiplier: 3.0,
      deadzone: 0.15, // Thumbstick deadzone
      // Exponential smoothing time constant (seconds) — dt-correct, unlike a
      // per-frame smoothing factor (see update()). -(1/72)/Math.log(0.9)
      // matches the feel of the old smoothing:0.9 at 72 Hz.
      smoothingTau: 0.1318,
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

    // Smooth velocity — exponential decay toward targetVelocity with a fixed
    // time constant (tau), so the ramp feels the same regardless of frame
    // rate (72 vs 90 vs 120 Hz). A per-frame smoothing factor (the old
    // `smoothing: 0.9` applied every frame) is frame-rate dependent: the same
    // factor converges faster at higher Hz.
    const tau = this._options.smoothingTau;
    const alpha = 1 - Math.exp(-deltaTime / tau);
    this._velocity = {
      x: this._velocity.x + (targetVelocity.x - this._velocity.x) * alpha,
      y: this._velocity.y + (targetVelocity.y - this._velocity.y) * alpha,
      z: this._velocity.z + (targetVelocity.z - this._velocity.z) * alpha,
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

    // Radial deadzone with rescale. A per-axis deadzone (Math.abs(x) >
    // deadzone ? x : 0) rejects a diagonal push whose axes are each below the
    // threshold even though its magnitude is well past it (e.g. (0.14, 0.14)
    // with deadzone 0.15 has hypot ~0.198 > 0.15, but both axes individually
    // fail), and snaps discontinuously to full value the instant either axis
    // crosses the threshold. Radial deadzone treats the stick as a disc and
    // rescales the surviving magnitude back into [0, 1] so speed ramps
    // continuously from zero at the deadzone boundary.
    const mag = Math.min(1, Math.hypot(x, y));
    let adjustedX = 0;
    let adjustedY = 0;
    if (mag > deadzone) {
      const k = ((mag - deadzone) / (1 - deadzone)) / mag;
      adjustedX = x * k;
      adjustedY = y * k;
    }

    // Map thumbstick to movement
    // X = strafe left/right
    // Y = forward/back. WebXR axes[3] is already negative when the stick is
    // pushed forward, and WebXR "forward" is -Z, so the raw (deadzoned) value
    // passes through unnegated — see VRExplorationManager thumbstick.y
    // capture (gamepad.axes[3]) and _transformByOrientation below.
    // Vertical movement from A/B buttons only. Squeeze/grip is reserved for
    // world-grab (VRExplorationManager.js ~224-231, engages above 0.7); a
    // squeezeValue > 0.5 branch here used to overlap that 0.5-0.7 band, so
    // every world-grab start also produced an unintended upward lurch.
    let verticalInput = 0;
    if (controller.buttons?.a) verticalInput = 1;
    if (controller.buttons?.b) verticalInput = -1;

    return {
      x: adjustedX, // Strafe
      y: verticalInput, // Up/down
      z: adjustedY, // Forward/back
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

    // Rotate the horizontal movement vector by yaw using the repo's shared
    // Ry(+theta) helper (see vrPlaneMath.js). This previously hand-rolled
    // Ry(-yaw) (x*cos - z*sin / x*sin + z*cos), which is the rotation in the
    // OPPOSITE direction. Combined with the un-negated `-adjustedY` that used
    // to feed into z above, the two sign errors composed to negate the
    // world-space Z of every movement delta — forward/back was inverted
    // whenever facing +/-Z, and strafe was inverted whenever facing +/-X.
    const [x, y, z] = yawRotateVector(
      [movement.x, movement.y, movement.z],
      yaw
    );
    return { x, y, z };
  }
}

export default VRFlyMode;
