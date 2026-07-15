// src/core/vr/navigation/VRNavigationController.js
// Orchestrates VR navigation modes (fly, teleport, walk, scale)

import { vr as log } from "@Utils/logger.js";
import { EXPLORATION_MODES } from "@Core/data/models/VRExplorationSession.js";
import { VRFlyMode } from "./VRFlyMode.js";
import { VRTeleportMode } from "./VRTeleportMode.js";
import { VRGrabMode } from "./VRGrabMode.js";
import { VRScaleController } from "./VRScaleController.js";
import { mapXRPointToData } from "@Core/vr/tools/vrPlaneMath.js";

export class VRNavigationController {
  constructor(session, vrContext) {
    this._session = session;
    this._vrContext = vrContext;
    this._activeMode = null;
    this._activeModeId = null;

    // Navigation modes. Teleport gets a raycastToScene callback so it can
    // land on the actual dataset surface, not just an infinite floor plane.
    const raycastToScene = this._raycastToScene.bind(this);
    this._modes = {
      [EXPLORATION_MODES.FLY]: new VRFlyMode(vrContext),
      [EXPLORATION_MODES.TELEPORT]: new VRTeleportMode(vrContext, { raycastToScene }),
      // WALK mode uses same as fly but restricted to ground
      [EXPLORATION_MODES.WALK]: new VRFlyMode(vrContext, { groundLocked: true }),
      // GRAB mode: pinch-and-drag to pull the data closer / push it away. Grab
      // and teleport are mutually exclusive (the active mode decides who
      // consumes the pinch), so a pinch never both teleports and grabs.
      [EXPLORATION_MODES.GRAB]: new VRGrabMode(vrContext),
    };

    // Scale controller is always active alongside navigation
    this._scaleController = new VRScaleController(vrContext);

    // Set default mode
    this.setMode(session.defaultExplorationMode || EXPLORATION_MODES.FLY);
  }

  /**
   * Set the active navigation mode
   *
   * @param {string} modeId - One of EXPLORATION_MODES
   */
  setMode(modeId) {
    if (this._activeModeId === modeId) return;

    // Deactivate current mode
    if (this._activeMode) {
      this._activeMode.deactivate();
    }

    // Activate new mode
    this._activeMode = this._modes[modeId];
    this._activeModeId = modeId;

    if (this._activeMode) {
      this._activeMode.activate();
      log.debug(`Navigation mode changed to: ${modeId}`);
    } else {
      log.warn(`Unknown navigation mode: ${modeId}`);
    }
  }

  /**
   * Get current navigation mode
   */
  getMode() {
    return this._activeModeId;
  }

  /**
   * Cycle through available navigation modes
   */
  cycleMode() {
    const modes = [
      EXPLORATION_MODES.FLY,
      EXPLORATION_MODES.TELEPORT,
      EXPLORATION_MODES.WALK,
      EXPLORATION_MODES.GRAB,
    ];

    const currentIndex = modes.indexOf(this._activeModeId);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.setMode(modes[nextIndex]);

    return modes[nextIndex];
  }

  /**
   * Update navigation based on input state
   * Called every frame
   *
   * @param {Object} inputState - Controller input state
   * @param {XRFrame} frame - XR frame
   * @param {number} deltaTime - Time since last frame in seconds
   * @returns {Object} Navigation result { position, orientation, vrScale }
   */
  update(inputState, frame, deltaTime) {
    let result = {
      position: null,
      orientation: null,
      vrScale: null,
      teleporting: false,
    };

    // Check for scale gesture (two-hand pinch)
    const scaleResult = this._scaleController.update(inputState, deltaTime);
    if (scaleResult.scaling) {
      result.vrScale = scaleResult.newScale;
    }

    // Update active navigation mode
    if (this._activeMode && !scaleResult.scaling) {
      const navResult = this._activeMode.update(inputState, frame, deltaTime);
      result = { ...result, ...navResult };
    } else if (this._activeMode && scaleResult.scaling) {
      // Suppressed this frame by the two-hand scale gesture. Tell the mode so a
      // held grab re-anchors on resume instead of jumping (no-op for modes that
      // don't implement it).
      this._activeMode.onFrameSkipped?.();
    }

    return result;
  }

  /**
   * Raycast an XR-space origin/direction against the dataset, returning the
   * hit back in XR space so VRTeleportMode can compare it against its
   * (XR-space) parabolic arc points. Direction is rotation-only (unaffected
   * by the vrScale/vrOrigin translation+scale offset), matching
   * vrPlaneMath.js's convention for controller-forward vectors.
   *
   * @param {{x:number,y:number,z:number}} originXR
   * @param {{x:number,y:number,z:number}} directionXR - unit vector
   * @returns {{position:{x,y,z}, valid:boolean, distance:number}|null}
   * @private
   */
  _raycastToScene(originXR, directionXR) {
    const handler = this._vrContext.handler;
    if (!handler?.raycastVR) return null;

    const vrScale = this._vrContext.vrScale || 1.0;
    const vrOrigin = this._vrContext.vrOrigin || [0, 0, 0];
    const [ox, oy, oz] = mapXRPointToData(originXR, vrScale, vrOrigin);

    const hit = handler.raycastVR(this._vrContext, {
      origin: { x: ox, y: oy, z: oz },
      direction: directionXR,
    });
    if (!hit?.hit) return null;

    // Convert the data-space hit back to XR space: xrPos = (dataPos - vrOrigin) * vrScale
    const position = {
      x: (hit.position.x - vrOrigin[0]) * vrScale,
      y: (hit.position.y - vrOrigin[1]) * vrScale,
      z: (hit.position.z - vrOrigin[2]) * vrScale,
    };
    const dx = position.x - originXR.x;
    const dy = position.y - originXR.y;
    const dz = position.z - originXR.z;

    return {
      position,
      valid: true,
      distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
    };
  }

  /**
   * Get current VR scale
   */
  getScale() {
    return this._scaleController.getScale();
  }

  /**
   * Set VR scale directly
   *
   * @param {number} scale - New scale value
   */
  setScale(scale) {
    this._scaleController.setScale(scale);
  }

  /**
   * Get navigation mode display info
   */
  getModeInfo() {
    const modeInfo = {
      [EXPLORATION_MODES.FLY]: {
        name: "Fly",
        icon: "fly",
        description: "Free movement in all directions",
        controls: "Thumbstick to move, trigger to boost",
      },
      [EXPLORATION_MODES.TELEPORT]: {
        name: "Teleport",
        icon: "teleport",
        description: "Point and teleport to location",
        controls: "Hold thumbstick to aim, release to teleport",
      },
      [EXPLORATION_MODES.WALK]: {
        name: "Walk",
        icon: "walk",
        description: "Ground-locked movement",
        controls: "Thumbstick to move, stays on ground plane",
      },
      [EXPLORATION_MODES.GRAB]: {
        name: "Move",
        icon: "move",
        description: "Move — pinch and drag to pull the data closer or push it away",
        controls: "Pinch and drag to pull the data closer or push it away",
      },
    };

    return modeInfo[this._activeModeId] || modeInfo[EXPLORATION_MODES.FLY];
  }

  /**
   * Get scale controller info
   */
  getScaleInfo() {
    return {
      currentScale: this._scaleController.getScale(),
      minScale: this._scaleController.getMinScale(),
      maxScale: this._scaleController.getMaxScale(),
    };
  }

  /**
   * Clean up navigation controller
   */
  cleanup() {
    if (this._activeMode) {
      this._activeMode.deactivate();
    }
    this._scaleController.cleanup();
  }
}

export default VRNavigationController;
