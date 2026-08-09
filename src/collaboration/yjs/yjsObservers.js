// src/collaboration/yjs/yjsObservers.js
// Y.js observers for PRESENCE DATA ONLY
//
// v2.0 ARCHITECTURE:
// ============================================================================
// Y.js is used ONLY for ephemeral presence data:
// - Cursor positions
// - VR avatars and controller poses
// - View presence (who's viewing what)
//
// PERSISTENT STATE comes from SERVER via REST API + WebSocket broadcast:
// - Datasets → /api/files + serverSync.js
// - Annotations → /api/annotations + serverSync.js
// - Views → /api/views + serverSync.js
// ============================================================================

import * as Y from "yjs";
import {
  ydoc,
  yCursors,
  yCameras,
  yAvatars,
  yViewPresence,
  yVisualizationState,
  yManipulatorState,
  yActiveDataset,
} from "@Collaboration/yjs/yjsSetup.js";
import { getUserId, getParticipantId } from "@Collaboration/presence/userManagement.js";
import { sync as log } from "@Utils/logger.js";

// ============================================================================
// LEGACY COMPATIBILITY EXPORTS
// These are kept for backward compatibility with appInitializer.js
// ============================================================================

let isSystemReady = false;

/**
 * Mark system as ready for processing
 * @deprecated v2.0 - Kept for backward compatibility, now a no-op
 */
export function markSystemReady() {
  log.debug("System marked as ready (no-op in v2.0 - state comes from server)");
  isSystemReady = true;
}

// ============================================================================
// PRESENCE OBSERVERS (Active in v2.0)
// ============================================================================

/**
 * Cursor presence observer
 * Watches for remote cursor updates and notifies listeners
 */
let cursorChangeCallbacks = [];

export function onCursorChange(callback) {
  cursorChangeCallbacks.push(callback);
  return () => {
    cursorChangeCallbacks = cursorChangeCallbacks.filter(
      (cb) => cb !== callback
    );
  };
}

export function initializeCursorObserver() {
  log.debug("Setting up cursor presence observer");

  const handler = (event) => {
    const myId = getUserId();

    event.changes.keys.forEach((change, cursorUserId) => {
      // Skip own cursor
      if (cursorUserId === myId) return;

      const cursorData = yCursors.get(cursorUserId);
      cursorChangeCallbacks.forEach((cb) => {
        try {
          cb({ action: change.action, userId: cursorUserId, data: cursorData });
        } catch (error) {
          log.error("Cursor observer callback error:", error);
        }
      });
    });
  };
  yCursors.observe(handler);

  log.debug("Cursor observer initialized");
  return () => yCursors.unobserve(handler);
}

/**
 * VR avatar presence observer
 * Watches for remote avatar updates
 */
let avatarChangeCallbacks = [];

export function onAvatarChange(callback) {
  avatarChangeCallbacks.push(callback);
  return () => {
    avatarChangeCallbacks = avatarChangeCallbacks.filter(
      (cb) => cb !== callback
    );
  };
}

export function initializeAvatarObserver() {
  log.debug("Setting up avatar presence observer");

  const handler = (event) => {
    // yAvatars is keyed per DEVICE, so the self-skip must be too — comparing
    // against getUserId() made a second headset on the same account look like
    // "me" and silently dropped its avatar.
    const myId = getParticipantId();

    event.changes.keys.forEach((change, avatarParticipantId) => {
      // Skip own avatar
      if (avatarParticipantId === myId) return;

      const avatarData = yAvatars.get(avatarParticipantId);
      avatarChangeCallbacks.forEach((cb) => {
        try {
          cb({ action: change.action, userId: avatarParticipantId, data: avatarData });
        } catch (error) {
          log.error("Avatar observer callback error:", error);
        }
      });
    });
  };
  yAvatars.observe(handler);

  log.debug("Avatar observer initialized");
  return () => yAvatars.unobserve(handler);
}

/**
 * View presence observer
 * Tracks who is viewing which view configuration
 */
let viewPresenceChangeCallbacks = [];

export function onViewPresenceChange(callback) {
  viewPresenceChangeCallbacks.push(callback);
  return () => {
    viewPresenceChangeCallbacks = viewPresenceChangeCallbacks.filter(
      (cb) => cb !== callback
    );
  };
}

export function initializeViewPresenceObserver() {
  log.debug("Setting up view presence observer");

  const handler = (event) => {
    event.changes.keys.forEach((change, viewId) => {
      const presenceData = yViewPresence.get(viewId);
      viewPresenceChangeCallbacks.forEach((cb) => {
        try {
          cb({ action: change.action, viewId, data: presenceData });
        } catch (error) {
          log.error("View presence observer callback error:", error);
        }
      });
    });
  };
  yViewPresence.observe(handler);

  log.debug("View presence observer initialized");
  return () => yViewPresence.unobserve(handler);
}

/**
 * Camera presence observer
 * Watches for remote camera updates for real-time smooth synchronization
 * This enables smooth camera sync between users viewing the same view
 */
let cameraChangeCallbacks = [];

export function onCameraChange(callback) {
  cameraChangeCallbacks.push(callback);
  return () => {
    cameraChangeCallbacks = cameraChangeCallbacks.filter(
      (cb) => cb !== callback
    );
  };
}

export function initializeCameraObserver() {
  log.debug("Setting up camera presence observer");

  const handler = (event) => {
    const myId = getUserId();

    event.changes.keys.forEach((change, viewId) => {
      const cameraData = yCameras.get(viewId);

      // Skip if this update came from THIS browser connection (prevents feedback loop).
      // Use ydoc.clientID (unique per WebSocket connection) not userId, so
      // two windows logged in as the same user still sync with each other.
      if (cameraData && cameraData.clientId === ydoc.clientID) return;

      cameraChangeCallbacks.forEach((cb) => {
        try {
          cb({
            action: change.action,
            viewId,
            camera: cameraData?.camera,
            userId: cameraData?.userId,
            syncKey: cameraData?.syncKey,
            collaborationViewId: cameraData?.collaborationViewId,
          });
        } catch (error) {
          log.error("Camera observer callback error:", error);
        }
      });
    });
  };
  yCameras.observe(handler);

  log.debug("Camera observer initialized");
  return () => yCameras.unobserve(handler);
}

// ============================================================================
// Visualization State Observer
// ============================================================================

let visualizationChangeCallbacks = [];

export function onVisualizationChange(callback) {
  visualizationChangeCallbacks.push(callback);
  return () => {
    visualizationChangeCallbacks = visualizationChangeCallbacks.filter(
      (cb) => cb !== callback
    );
  };
}

export function initializeVisualizationObserver() {
  log.debug("Setting up visualization state observer");

  // observeDeep, not observe: each viewId's entry is now a nested Y.Map (see
  // syncVisualizationToYjs), so a field-level patch to an EXISTING entry
  // mutates the nested map in place rather than replacing the top-level key
  // — a plain top-level .observe() would only fire the first time a viewId's
  // entry is created, never on later per-field patches.
  const handler = (events) => {
    const changedViewIds = new Set();
    events.forEach((event) => {
      if (event.path.length === 0) {
        // Fired directly on yVisualizationState: a viewId key was added/removed.
        event.changes.keys.forEach((_change, viewId) => changedViewIds.add(viewId));
      } else {
        // Fired on a nested entry/visualization Y.Map: path[0] is the viewId.
        changedViewIds.add(event.path[0]);
      }
    });

    changedViewIds.forEach((viewId) => {
      const entry = yVisualizationState.get(viewId);
      // Legacy plain-object entry from before this migration (or the entry
      // was deleted) — skip rather than throw; self-heals on the next write.
      if (!(entry instanceof Y.Map)) return;

      // Skip updates that came from this browser connection
      if (entry.get("clientId") === ydoc.clientID) return;

      const vizMap = entry.get("visualization");
      const visualization = vizMap instanceof Y.Map ? vizMap.toJSON() : null;

      log.debug(`[CIA Collab] ← viz from ${entry.get("userId")} for view ${viewId}`, visualization);

      visualizationChangeCallbacks.forEach((cb) => {
        try {
          cb({
            action: "update",
            viewId,
            visualization,
            userId: entry.get("userId"),
            syncKey: entry.get("syncKey"),
            collaborationViewId: entry.get("collaborationViewId"),
          });
        } catch (error) {
          log.error("Visualization observer callback error:", error);
        }
      });
    });
  };
  yVisualizationState.observeDeep(handler);

  log.debug("Visualization state observer initialized");
  return () => yVisualizationState.unobserveDeep(handler);
}

// ============================================================================
// Manipulator State Observer
// ============================================================================

let manipulatorChangeCallbacks = [];

export function onManipulatorChange(callback) {
  manipulatorChangeCallbacks.push(callback);
  return () => {
    manipulatorChangeCallbacks = manipulatorChangeCallbacks.filter(
      (cb) => cb !== callback
    );
  };
}

export function initializeManipulatorObserver() {
  log.debug("Setting up manipulator state observer");

  const handler = (event) => {
    event.changes.keys.forEach((change, userId) => {
      const data = yManipulatorState.get(userId);

      // Skip own manipulation events
      if (data && data.clientId === ydoc.clientID) return;

      manipulatorChangeCallbacks.forEach((cb) => {
        try {
          cb({
            action: change.action,
            userId,
            manipulator: data || null,
          });
        } catch (error) {
          log.error("Manipulator observer callback error:", error);
        }
      });
    });
  };
  yManipulatorState.observe(handler);

  log.debug("Manipulator state observer initialized");
  return () => yManipulatorState.unobserve(handler);
}

// ============================================================================
// Active Dataset Observer
// ============================================================================

let activeDatasetChangeCallbacks = [];

export function onActiveDatasetChange(callback) {
  activeDatasetChangeCallbacks.push(callback);
  return () => {
    activeDatasetChangeCallbacks = activeDatasetChangeCallbacks.filter(
      (cb) => cb !== callback
    );
  };
}

export function initializeActiveDatasetObserver() {
  log.debug("Setting up active dataset observer");

  const handler = (event) => {
    event.changes.keys.forEach((change, roomId) => {
      const data = yActiveDataset.get(roomId);
      if (!data) return;

      // Skip updates that came from this browser connection
      if (data.clientId === ydoc.clientID) return;

      // Y.js's YMapEvent already carries the pre-change value for 'update'/
      // 'delete' actions — use it to detect, with no extra bookkeeping, when
      // THIS client's own very-recent selection got raced out by another
      // client's concurrent write (last-writer-wins on the whole value is
      // correct for an exclusive "active dataset" — the gap being closed
      // here is that the losing client previously got zero signal).
      const oldValue = change.oldValue;
      const overroteLocalSelection =
        change.action === "update" &&
        oldValue?.clientId === ydoc.clientID &&
        oldValue?.datasetId !== data.datasetId;

      console.log(
        '[CIA Collab] ← activeDataset received',
        data.datasetId, 'v' + data.version,
        'from', data.updatedBy
      );

      activeDatasetChangeCallbacks.forEach((cb) => {
        try {
          cb({ roomId, ...data, overroteLocalSelection });
        } catch (e) {
          log.error("activeDataset observer callback error:", e);
        }
      });
    });
  };
  yActiveDataset.observe(handler);

  log.debug("Active dataset observer initialized");
  return () => yActiveDataset.unobserve(handler);
}

// ============================================================================
// Initialize All Observers
// ============================================================================

let _initialized = false;
let _cleanupFns = [];

/**
 * Idempotent: re-registering observers on every Y.js "sync" event (which
 * fires on every reconnect, not just the first connection — see
 * yjsSetup.js's provider.on("sync", ...) listener) used to stack a fresh
 * set of .observe() callbacks on the same Y.Map every time, compounding
 * forever. Guard against that here rather than at each call site.
 */
export function initializeAllObservers() {
  if (_initialized) {
    log.debug("Y.js observers already initialized — skipping re-registration");
    return teardownAllObservers;
  }
  _initialized = true;

  log.debug("Setting up Y.js observers (v2.1 - presence + visualization sync)");

  _cleanupFns = [
    initializeCursorObserver(),
    initializeAvatarObserver(),
    initializeViewPresenceObserver(),
    initializeCameraObserver(),
    initializeVisualizationObserver(),
    initializeManipulatorObserver(),
    initializeActiveDatasetObserver(),
  ];

  // Persistent state (datasets, views, annotations) still comes from server:
  // - REST API: useProjectFiles, DatasetManager.fetchDatasetsFromServer
  // - WebSocket: serverSync.js broadcasts

  // Diagnostic: log collaboration identity on connect
  console.group("[CIA Collab] Observers initialized");
  console.log("Account ID:", getUserId());
  // Two headsets on ONE account share the account id above and differ only
  // here — the first thing to compare when they cannot see each other.
  console.log("Participant ID (unique per device):", getParticipantId());
  console.log("Y.js clientID (unique per connection):", ydoc.clientID);
  console.groupEnd();

  log.info("Y.js observers initialized (v2.1)");

  return teardownAllObservers;
}

/**
 * Unobserves every Y.Map registered by initializeAllObservers() and resets
 * state so a later initializeAllObservers() call re-registers cleanly.
 */
export function teardownAllObservers() {
  _cleanupFns.forEach((fn) => {
    try {
      fn?.();
    } catch (error) {
      log.error("Error tearing down Y.js observer:", error);
    }
  });
  _cleanupFns = [];
  _initialized = false;
  log.debug("Y.js observers torn down");
}
