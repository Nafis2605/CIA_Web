// src/core/vr/vrAccessibilityStore.js
// Read-only bridge onto the VR accessibility settings that
// src/ui/react/context/VRAccessibilityContext.jsx persists to localStorage.
//
// Core VR code (this directory) must not import from src/ui/react/ — the
// project's dependency direction is UI -> Services -> Managers -> Core ->
// Utils (see CLAUDE.md), and VRAccessibilityContext is a React context under
// UI. There are also multiple startExploration call sites, so threading the
// setting through session config would mean keeping all of them in sync.
// Instead this tiny module owns the shared storage key and a plain read, and
// VRAccessibilityContext imports VR_A11Y_STORAGE_KEY from here (UI importing
// core is the allowed direction) so the two never drift apart.

import { vr as log } from "@Utils/logger.js";

/** Must match the literal VRAccessibilityContext.jsx used to persist settings. */
export const VR_A11Y_STORAGE_KEY = "cia-vr-accessibility-settings";

/**
 * Defaults mirrored from VRAccessibilityContext's DEFAULT_VR_ACCESSIBILITY,
 * limited to the slice core VR code actually reads (movement.snapTurn).
 * @type {{movement: {snapTurn: ('off'|15|30|45|90)}}}
 */
export const DEFAULT_VR_A11Y_SETTINGS = {
  movement: {
    snapTurn: 45, // 'off' | 15 | 30 | 45 | 90
  },
};

/**
 * Read the persisted VR accessibility settings, merged over the defaults.
 * Never throws: missing localStorage (SSR/tests), invalid JSON, or a
 * localStorage that throws on access all fall back to the defaults.
 * @returns {{movement: {snapTurn: ('off'|15|30|45|90)}}}
 */
export function readVRAccessibilitySettings() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) {
      return DEFAULT_VR_A11Y_SETTINGS;
    }
    const stored = localStorage.getItem(VR_A11Y_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_VR_A11Y_SETTINGS;
    }
    const parsed = JSON.parse(stored);
    const parsedMovement =
      parsed && typeof parsed === "object" && parsed.movement && typeof parsed.movement === "object"
        ? parsed.movement
        : undefined;
    return {
      ...DEFAULT_VR_A11Y_SETTINGS,
      ...(parsed && typeof parsed === "object" ? parsed : undefined),
      movement: {
        ...DEFAULT_VR_A11Y_SETTINGS.movement,
        ...parsedMovement,
      },
    };
  } catch (e) {
    log.warn(`Failed to read VR accessibility settings: ${e?.message}`);
    return DEFAULT_VR_A11Y_SETTINGS;
  }
}

export default readVRAccessibilitySettings;
