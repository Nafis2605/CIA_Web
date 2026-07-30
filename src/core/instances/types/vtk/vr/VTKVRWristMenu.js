// src/core/instances/types/vtk/vr/VTKVRWristMenu.js
// Left-controller wrist menu: compact quick-access menu anchored to the grip
// pose of the left controller, visible when the palm faces the user.
//
// Visibility: palm-toward-head dot-product test (standard VR wrist menu convention).
// Selection: right-controller ray + trigger (reuses VTKVRSpatialUI's hit-test helpers).
// Content: curated subset from VRSpatialMenuModel.getWristButtons() (tool toggles, Exit, Hide/Show).
//
// TODO (Phase 2): Implement full rendering and interaction.
// For now, this is a stub to preserve the always-on architecture
// from VRExplorationManager. The visible menu is still the floating panel.

import { vr as log } from "@Utils/logger.js";
import { VRSpatialMenuModel } from "@Core/vr/VRSpatialMenuModel.js";

/**
 * Wrist menu: compact, controller-anchored quick-access menu.
 * Lifecycle: initialize(renderer, manager) → per-frame update(inputState) → dispose().
 */
export class VRWristMenu {
  constructor() {
    this._renderer = null;
    this._model = null;
  }

  /**
   * Initialize the wrist menu with a VRSpatialMenuModel.
   * @param {object} renderer - VTK renderer (for adding actors)
   * @param {object} manager - VRExplorationManager instance
   */
  initialize(renderer, manager) {
    try {
      this._renderer = renderer;
      this._model = new VRSpatialMenuModel(manager);
      log.debug("VRWristMenu initialized");
    } catch (err) {
      log.error(`VRWristMenu.initialize failed: ${err?.message}`, err?.stack || err);
    }
  }

  /**
   * Per-frame update: position, visibility, hit-test, and dispatch.
   * @param {object} inputState - controller input state
   * @param {object} options - {vrScale, vrOrigin}
   * @returns {object|null} {hovering, buttonId, hand} or null
   */
  update(inputState, options = {}) {
    if (!this._model || !this._renderer) return null;

    try {
      // TODO: Implement wrist menu rendering and hit-test.
      // For now, return null (not hovering) so the manager doesn't gate input.
      // The floating panel (VRSpatialUI) still handles all menu interaction.
      return null;
    } catch (err) {
      log.error(`VRWristMenu.update failed: ${err?.message}`, err?.stack || err);
      return null;
    }
  }

  /**
   * Clean up: remove all actors from the renderer.
   */
  dispose() {
    try {
      // TODO: remove wrist menu actors
      this._renderer = null;
      this._model = null;
      log.debug("VRWristMenu disposed");
    } catch (err) {
      log.error(`VRWristMenu.dispose failed: ${err?.message}`);
    }
  }
}

export default VRWristMenu;
