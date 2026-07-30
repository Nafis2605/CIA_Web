// src/core/vr/navigation/VRNavigationController.js
// Orchestrates VR navigation modes (fly, teleport, walk, scale)

import { vr as log } from "@Utils/logger.js";
import { EXPLORATION_MODES } from "@Core/data/models/VRExplorationSession.js";
import { VRFlyMode } from "./VRFlyMode.js";
import { VRTeleportMode } from "./VRTeleportMode.js";
import { VRGrabMode } from "./VRGrabMode.js";
import { VRObjectMoveMode } from "./VRObjectMoveMode.js";
import { VRScaleController } from "./VRScaleController.js";
import { mapXRPointToData } from "@Core/vr/tools/vrPlaneMath.js";

/**
 * Per-mode display metadata (name/icon/description/controls), keyed by the
 * real EXPLORATION_MODES values. Module-level (not just an instance method)
 * so it's importable WITHOUT an instantiated controller — VRLaunchModal shows
 * this before a VR session (and its VRNavigationController) exists.
 * @type {Readonly<Record<string, {name:string, icon:string, description:string, controls:string}>>}
 */
export const NAVIGATION_MODE_INFO = Object.freeze({
  [EXPLORATION_MODES.FLY]: {
    name: "Fly",
    icon: "fly",
    description: "Free movement in all directions; trigger free for tools",
    controls: "Left stick: fly | Right stick: snap turn | Grip: pull world | Two-hand: scale/twist",
  },
  [EXPLORATION_MODES.TELEPORT]: {
    name: "Teleport",
    icon: "teleport",
    description: "Point and jump to a spot on the data",
    controls: "Trigger: aim arc, release to jump | Left stick: fly | Grip: pull world | Two-hand: scale/twist",
  },
  [EXPLORATION_MODES.WALK]: {
    name: "Walk",
    icon: "footprints",
    description: "Ground-locked movement; trigger free for tools",
    controls: "Left stick: walk (stays level) | Right stick: snap turn | Grip: pull world | Two-hand: scale/twist",
  },
  [EXPLORATION_MODES.GRAB]: {
    name: "Move",
    icon: "move",
    description: "Pull the world to you; trigger free for tools",
    controls: "Grip: pull world | Left stick: fly | Right stick: snap turn | Two-hand: scale/twist",
  },
  [EXPLORATION_MODES.MOVE_OBJECT]: {
    name: "Move Object",
    icon: "move",
    description: "Reposition the dataset for all collaborators",
    controls: "Trigger: drag the dataset | Left stick: fly | Grip: pull world | Two-hand: scale/twist",
  },
});

export class VRNavigationController {
  /**
   * Layered always-on navigation model (new in this revision). Per frame:
   *   1. Scale/twist (two-hand pinch+squeeze) — highest precedence; suppresses all others
   *   2. World-grab (grip-engaged VRGrabMode) — owns vrOrigin; suppresses stick locomotion
   *   3. Locomotion (VRFlyMode/FLY+WALK) + snap turn (right-stick flick) — always on
   *   4. Object-move (trigger-engaged VRObjectMoveMode) — independent; gated by manager
   *   5. Teleport (optional toggle) — when enabled, trigger aims/commits teleport
   *
   * Snap turn is debounced: fires once when |rightStickX| > 0.7, re-arms after < 0.3.
   * Engagement predicates are injected so grip/trigger can be remapped per platform.
   *
   * @param {object} session
   * @param {object} vrContext
   * @param {object} [options]
   * @param {object} [options.vrManager] - required for snap-turn plumbing
   * @param {(final: boolean) => void} [options.onObjectMoved] - forwarded to
   *   VRObjectMoveMode so the manager can broadcast the shared object transform.
   * @param {boolean} [options.enableTeleport=false] - if true, trigger does teleport
   *   (instead of object-move) when no exclusive tool is active.
   */
  constructor(session, vrContext, options = {}) {
    this._session = session;
    this._vrContext = vrContext;
    this._vrManager = options.vrManager;

    // Layered navigation modes
    const raycastToScene = this._raycastToScene.bind(this);
    this._flyMode = new VRFlyMode(vrContext); // used by FLY + WALK
    this._teleportMode = new VRTeleportMode(vrContext, { raycastToScene });

    // World-grab uses grip engagement (injected by VRExplorationManager)
    // Constructor will pass { isEngaged: gripPredicate }; see setWorldGrabEngagement.
    this._worldGrab = new VRGrabMode(vrContext);

    // Object-move uses trigger engagement (always trigger for object transform)
    this._objectMove = new VRObjectMoveMode(vrContext, {
      onObjectMoved: options.onObjectMoved,
    });

    // Scale controller is always active
    this._scaleController = new VRScaleController(vrContext);

    // Navigation mode state
    this._activeMode = null;
    this._activeModeId = null;
    this._enableTeleport = options.enableTeleport || false;

    // Snap-turn state
    this._snapTurnArmed = true; // ready to fire on next stick flick
    this._lastRightStickX = 0;

    // Activate the layers that gate their update() on _isActive — VRFlyMode and
    // VRTeleportMode both short-circuit unless activated. World-grab, object-move
    // and scale don't gate on activation. Teleport is only *invoked* when the
    // teleport toggle is on (see update()), so activating it here is harmless.
    this._flyMode.activate();
    this._teleportMode.activate();

    // Set default mode (affects FLY vs WALK ground-lock; locomotion is always-on)
    this.setMode(session.defaultExplorationMode || EXPLORATION_MODES.FLY);
  }

  /**
   * Set the engagement predicate for world-grab (default trigger; overridden
   * to grip for tracked controllers by VRExplorationManager).
   * @param {(hand:Object)=>boolean} predicate - isEngaged(hand) => boolean
   */
  setWorldGrabEngagement(predicate) {
    if (predicate) {
      this._worldGrab = new VRGrabMode(this._vrContext, { isEngaged: predicate });
    }
  }

  /**
   * In layered always-on mode, the "active mode" now controls only the
   * locomotion character (FLY or WALK ground-locking), not the exclusive grab.
   *
   * @param {string} modeId - One of EXPLORATION_MODES
   */
  setMode(modeId) {
    if (this._activeModeId === modeId) return;
    this._activeModeId = modeId;
    // WALK ground-locks the always-on locomotion; every other mode frees Y.
    this._flyMode.setGroundLocked(modeId === EXPLORATION_MODES.WALK);
    // Teleport is driven by the SELECTED MODE, not a constructor flag. It used
    // to read only from options.enableTeleport, which VRExplorationManager never
    // passed — so teleport could never run even while the status line claimed
    // it was active. Now picking the Teleport mode genuinely arms it.
    this._enableTeleport = modeId === EXPLORATION_MODES.TELEPORT;
    log.debug(`Navigation mode changed to: ${modeId}`);
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
      EXPLORATION_MODES.MOVE_OBJECT,
    ];

    const currentIndex = modes.indexOf(this._activeModeId);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.setMode(modes[nextIndex]);

    return modes[nextIndex];
  }

  /**
   * Layered always-on update: scale > world-grab > locomotion+snap-turn > object-move.
   * Each layer may suppress the ones below it (e.g. scaling prevents grab+locomotion).
   *
   * @param {Object} inputState - Controller input state
   * @param {XRFrame} frame - XR frame
   * @param {number} deltaTime - Time since last frame in seconds
   * @returns {Object} Navigation result { position, orientation, vrScale, vrRotation, ... }
   */
  update(inputState, frame, deltaTime) {
    let result = {
      position: null,
      orientation: null,
      vrScale: null,
      vrRotation: null,
      teleporting: false,
    };

    // --- Layer 1: Scale + twist (two-hand pinch/squeeze) — HIGHEST precedence ---
    const scaleResult = this._scaleController.update(inputState, deltaTime);
    const isScaling = scaleResult.scaling;
    if (isScaling) {
      result.vrScale = scaleResult.newScale;
      if (scaleResult.newRotation != null) {
        result.vrRotation = scaleResult.newRotation;
      }
      // Signal all other layers they're suppressed so re-anchor on resume
      this._worldGrab.onFrameSkipped?.();
      this._flyMode.onFrameSkipped?.();
      this._objectMove.onFrameSkipped?.();
      return result; // Skip all lower layers
    }

    // --- Layer 2: World-grab (grip-engaged, always-on) ---
    const grabResult = this._worldGrab.update(inputState);
    const grabbing = this._worldGrab.isGrabbing();
    if (grabResult?.position) {
      result.position = grabResult.position;
    }
    if (grabResult?.grabEnded) {
      // Surface release so the manager persists the final placement.
      result.grabEnded = true;
    }

    // Also treat the release frame (grabEnded, isGrabbing already false) as
    // grab-owned so fly doesn't overwrite the grab's committed final position.
    const grabOwnsFrame = grabbing || !!grabResult?.grabEnded;

    if (grabOwnsFrame) {
      // While pulling the world, don't also stick-locomote (would fight the
      // grab for vrOrigin). Bleed fly velocity so it doesn't lurch on release.
      this._flyMode.onFrameSkipped?.();
    } else {
      // --- Layer 3: Locomotion (left stick) + snap-turn (right stick) ---
      const flyResult = this._flyMode.update(inputState, frame, deltaTime);
      if (flyResult?.position) {
        result.position = flyResult.position;
      }

      // Snap-turn on right-stick X flick (always-on).
      if (this._vrManager) {
        this._updateSnapTurn(inputState);
      }
    }

    // --- Layer 4: the TRIGGER action, decided by the SELECTED MODE ---
    //
    //   MOVE_OBJECT → trigger drags the shared dataset transform
    //   TELEPORT    → trigger aims the arc and commits on release
    //   FLY/WALK/GRAB → trigger does NOTHING here, staying free for tools and
    //                   the spatial menu
    //
    // Previously object-move ran on ANY free trigger regardless of mode, so the
    // dataset could be dragged by accident at any time and the Move/Move Obj
    // buttons changed nothing observable. Gating on _activeModeId is what makes
    // those mode buttons actually do their job.
    //
    // The manager strips the trigger from this input when a tool is active or a
    // menu is hovered, so this only ever sees a "free" trigger. Both actions are
    // suppressed while world-grabbing so a simultaneous grip+trigger can't drive
    // two grabs at once.
    if (grabOwnsFrame) {
      this._objectMove.onFrameSkipped?.();
    } else if (this._activeModeId === EXPLORATION_MODES.MOVE_OBJECT) {
      this._objectMove.update(inputState);
    } else if (this._enableTeleport && this._teleportMode) {
      const teleResult = this._teleportMode.update(inputState, frame, deltaTime);
      if (teleResult?.position) result.position = teleResult.position;
      if (teleResult?.teleporting) result.teleporting = true;
    } else {
      // Trigger is free this frame — keep the object-move mode's internal
      // edge state from going stale so re-entering MOVE_OBJECT re-anchors.
      this._objectMove.onFrameSkipped?.();
    }

    return result;
  }

  /**
   * Handle snap-turn via right-stick X flick. Debounced: fires once when
   * |rightStickX| > 0.7, re-arms after it returns < 0.3.
   * @private
   */
  _updateSnapTurn(inputState) {
    const rightStick = inputState?.controllers?.right?.thumbstick;
    const rightStickX = rightStick?.x || 0;

    if (this._snapTurnArmed && Math.abs(rightStickX) > 0.7) {
      // Fire snap turn: +X = right, -X = left
      const sign = Math.sign(rightStickX);
      this._vrManager.applySnapTurn(sign);
      this._snapTurnArmed = false;
      this._lastRightStickX = rightStickX;
    } else if (!this._snapTurnArmed && Math.abs(rightStickX) < 0.3) {
      // Re-arm once the stick returns to center
      this._snapTurnArmed = true;
    }

    this._lastRightStickX = rightStickX;
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
   * Get navigation mode display info for the CURRENTLY active mode. See
   * NAVIGATION_MODE_INFO for the full per-mode table (also usable without an
   * instantiated controller, e.g. by the pre-session launch modal).
   */
  getModeInfo() {
    return NAVIGATION_MODE_INFO[this._activeModeId] || NAVIGATION_MODE_INFO[EXPLORATION_MODES.FLY];
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
    this._flyMode?.cleanup?.();
    this._teleportMode?.cleanup?.();
    this._worldGrab?.cleanup?.();
    this._objectMove?.cleanup?.();
    this._scaleController?.cleanup?.();
  }
}

export default VRNavigationController;
