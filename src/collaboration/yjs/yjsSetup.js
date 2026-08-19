// src/collaboration/yjs/yjsSetup.js
// Core Y.js infrastructure - document, maps, provider initialization
//
// v2.1 ARCHITECTURE: Y.js for PRESENCE + REAL-TIME VISUALIZATION SYNC
// ============================================================================
// Y.js handles ephemeral real-time data:
// - Cursor positions
// - VR avatars and controller poses
// - Active users in views
// - Text chat (via Matrix-CRDT in future)
// - Camera state (real-time smooth sync between collaborators)
// - Visualization settings (representation, opacity, colormap, scalar coloring)
// - Active manipulator identity (who is currently interacting)
//
// PERSISTENT STATE comes from SERVER via REST API + WebSocket broadcast:
// - Datasets → server/src/routes/files.js
// - Annotations → server/src/routes/annotations.js
// - View configurations → server/src/routes/views.js
//
// This separation ensures:
// - Server is single source of truth (audit trails, versioning)
// - Y.js handles only high-frequency, ephemeral updates
// - WebSocket broadcasts keep clients in sync without polling
// ============================================================================

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";

import clientConfig from "@Core/config/clientConfig.js";
import { sessionManager } from "@Core/session/sessionManager";
import cameraSharePolicy from "@Core/session/cameraSharePolicy.js";
import { authService } from "@Services/authService.js";
import { getUserId } from "@Collaboration/presence/userManagement.js";
import { sync as log } from "@Utils/logger.js";
import { resolveWsUrl } from "@Utils/resolveWsUrl.js";

// ============================================================================
// Core Y.js Document and Awareness
// ============================================================================
export const ydoc = new Y.Doc();
export const awareness = new Awareness(ydoc);

// ============================================================================
// PRESENCE STATE (Active in v2.0)
// These are the only Y.js maps that should be actively used
// ============================================================================

// Cursor presence: userId -> { position, color, name, viewId, lastUpdate }
export const yCursors = ydoc.getMap("cursors");

// Camera presence: viewId -> { camera: {...}, userId, clientId, lastUpdate }
// Real-time camera sync for smooth collaborative viewing
export const yCameras = ydoc.getMap("cameras");

// Visualization state: viewId -> { visualization: {...}, userId, clientId, lastUpdate }
// Real-time sync for representation, opacity, colormap, scalar coloring
export const yVisualizationState = ydoc.getMap("visualizationState");

// Manipulator state: userId -> { userId, displayName, target, action, clientId, timestamp }
// Tracks who is currently interacting (camera, dataset, filter)
export const yManipulatorState = ydoc.getMap("manipulatorState");

// Active dataset: roomId -> { datasetId, name, path, type, source, version, updatedBy, updatedAt, clientId }
// Syncs dataset selection to all users in the same room/session
export const yActiveDataset = ydoc.getMap("activeDataset");

// View presence: viewId -> { viewers: [userId, ...], lastUpdate }
export const yViewPresence = ydoc.getMap("viewPresence");

// VR avatars: participantId -> { position, rotation, headPose, handPoses, ... }
// PARTICIPANT id (account+device, see userManagement.getParticipantId), NOT
// userId: two headsets signed into one account share a userId and would
// collapse into a single entry that each of them then skips as its own.
export const yAvatars = ydoc.getMap("avatars");

// VR controllers: `${participantId}_${hand}` -> { position, rotation, buttons, ... }
export const yVRControllers = ydoc.getMap("vrControllers");

// Text chat: Array of { userId, message, timestamp }
// NOTE: Planning migration to Matrix-CRDT for federation and E2EE
export const yText = ydoc.getArray("chatMessages");

// VR session registry: viewConfigurationId -> { sessionId, viewConfigurationId,
// hostUserId, hostUserName, datasetId, projectId, createdAt, lastHeartbeat,
// participantCount }
// Room-scoped so two "Enter VR" taps on the SAME view converge on one shared
// Y.js session id instead of each minting its own vrsession_<ts>_<rand> and
// opening a DIFFERENT `vr-participants-<sessionId>` map. Server discovery
// (GET /vr/sessions) can't fix this — it filters on projectId, which is
// undefined for locally loaded datasets.
export const yVRSessions = ydoc.getMap("vr-sessions");

// ============================================================================
// Provider Initialization
// ============================================================================

let _provider = null;

async function waitForAccessToken() {
  // In dev bypass mode, no token is needed.
  const isDevMode =
    clientConfig.devBypassAuth === true || clientConfig.devBypassAuth === "true";
  if (isDevMode) return null;

  try {
    // authService.getAccessToken() auto-refreshes if needed.
    const token = await authService.getAccessToken?.();
    return token || null;
  } catch {
    log.debug("Could not get access token — proceeding without (dev or offline?)");
    return null;
  }
}

/**
 * Initialize the Y.js WebSocket provider
 * This must be called after sessionManager.initializeFromURL()
 */
export async function initializeYjsProvider() {
  if (_provider) {
    log.warn("Y.js provider already initialized");
    return _provider;
  }

  const roomId = sessionManager.getRoomId();
  const wsUrl = resolveWsUrl(clientConfig.yjsWebSocketUrl);
  let token = null;

  try {
    token = await waitForAccessToken();
  } catch (error) {
    // Token errors are ignored - connecting without token in dev mode
    log.debug("Proceeding without access token");
  }

  // All connections allowed in development - token not required for collaboration
  log.info("Y.js connecting in collaboration mode (no token required)");

  const isDevMode =
    clientConfig.devBypassAuth === true || clientConfig.devBypassAuth === "true";

  const params = {};

  if (token) {
    // Pass JWT so server can validate room membership in production
    params.token = token;
  }

  if (isDevMode) {
    // DEV_BYPASS_AUTH: identify user by id/name via URL params
    const user = authService.getUser?.();
    if (user?.id) {
      params.userId = user.id;
      params.username = user.name;
    }
  }

  // Pass projectId so the Y.js server can perform project/room membership checks
  params.projectId = sessionManager.getProjectId();

  _provider = new WebsocketProvider(wsUrl, roomId, ydoc, {
    awareness,
    params,
  });

  log.info(`Y.js connecting to ${wsUrl} room: ${roomId}`);

  _provider.on("status", (event) => {
    log.info(`Y.js connection status: ${event.status}`);
    if (event.status === 'connected') {
      console.group("[CIA Collab] Y.js connected");
      console.log("Room:", roomId);
      console.log("User:", getUserId(), "(per-tab identity)");
      console.log("Y.js clientID (unique per tab):", ydoc.clientID);
      console.log("WebSocket URL:", wsUrl);
      console.groupEnd();
    }
  });

  _provider.on("sync", (synced) => {
    if (synced) {
      log.info("Y.js synchronized with server");

      // Fires on every reconnect, not just the first sync — initializeAllObservers()
      // is idempotent (guard lives in yjsObservers.js) so re-registration here is safe.
      import("@Collaboration/yjs/yjsObservers.js").then(
        ({ initializeAllObservers }) => {
          initializeAllObservers();
        }
      );
    }
  });

  return _provider;
}

// Export provider as a getter so it throws a helpful error if accessed before init
export const provider = new Proxy(
  {},
  {
    get(target, prop) {
      if (!_provider) {
        const error = new Error(
          `Y.js provider not initialized - call initializeYjsProvider() first.\n` +
            `Attempted to access provider.${String(prop)}`
        );
        log.error("Provider access stack trace:");
        log.error(error.stack);
        throw error;
      }
      return _provider[prop];
    },
  }
);

// ============================================================================
// PRESENCE SYNC FUNCTIONS (Active in v2.0)
// ============================================================================

/**
 * Update cursor presence in Y.js
 * @param {string} userId - User ID
 * @param {Object} cursorData - { position, color, name, viewId }
 */
export function syncCursorToYjs(userId, cursorData) {
  try {
    yCursors.set(userId, {
      ...cursorData,
      lastUpdate: Date.now(),
    });
  } catch (error) {
    log.error("Failed to sync cursor to Y.js:", error);
  }
}

/**
 * Update VR avatar presence in Y.js
 * @param {string} participantId - Per-DEVICE id (getParticipantId), not userId
 * @param {Object} avatarData - { position, rotation, headPose, ... }
 */
export function syncAvatarToYjs(participantId, avatarData) {
  try {
    yAvatars.set(participantId, {
      ...avatarData,
      lastUpdate: Date.now(),
    });
  } catch (error) {
    log.error("Failed to sync avatar to Y.js:", error);
  }
}

/**
 * Update VR controller presence in Y.js
 * @param {string} controllerId - `${participantId}_${hand}` format
 * @param {Object} controllerData - { position, rotation, buttons, ... }
 */
export function syncVRControllerToYjs(controllerId, controllerData) {
  try {
    yVRControllers.set(controllerId, {
      ...controllerData,
      lastUpdate: Date.now(),
    });
  } catch (error) {
    log.error("Failed to sync VR controller to Y.js:", error);
  }
}

/**
 * Update view presence (who is viewing what)
 * @param {string} viewId - View configuration ID
 * @param {string[]} viewers - Array of user IDs viewing this view
 */
export function syncViewPresenceToYjs(viewId, viewers) {
  try {
    yViewPresence.set(viewId, {
      viewers,
      lastUpdate: Date.now(),
    });
  } catch (error) {
    log.error("Failed to sync view presence to Y.js:", error);
  }
}

/**
 * Update camera presence in Y.js for real-time sync
 * This enables smooth camera synchronization between users viewing the same view
 * @param {string} viewId - View configuration ID
 * @param {string} userId - User who moved the camera
 * @param {Object} cameraState - { position, focalPoint, viewUp, parallelScale, clippingRange, viewAngle }
 * @param {string|null} [syncKey] - Cross-client sync key (see viewSyncKey.js).
 *   viewId is local to the publisher — every client mints its own — so peers
 *   match on this instead.
 * @param {string|null} [collaborationViewId] - Additive per-view id (H5, see
 *   viewSyncKey.js's `mode: 'view'`). Currently inert — no consumer matches
 *   on it yet — carried along so it's available once one does.
 */
export function syncCameraToYjs(viewId, userId, cameraState, syncKey = null, collaborationViewId = null) {
  // Personal-camera mode: the user opted out of sharing their viewpoint —
  // suppress the outgoing broadcast entirely (see cameraSharePolicy).
  if (!cameraSharePolicy.isCameraShared()) return;
  try {
    yCameras.set(viewId, {
      camera: cameraState,
      userId,
      syncKey,
      collaborationViewId,
      clientId: ydoc.clientID,
      lastUpdate: Date.now(),
    });
  } catch (error) {
    log.error("Failed to sync camera to Y.js:", error);
  }
}

/**
 * Sync visualization settings to Y.js for real-time collaborative updates.
 * Covers representation, opacity, colormap, scalar array selection.
 * @param {string} viewId - View configuration ID
 * @param {string} userId - User making the change
 * @param {Object} vizState - Partial visualization state (only changed fields)
 * @param {string|null} [syncKey] - Cross-client sync key (see viewSyncKey.js).
 *   viewId is local to the publisher — every client mints its own — so peers
 *   match on this instead.
 * @param {string|null} [collaborationViewId] - Additive per-view id (H5, see
 *   viewSyncKey.js's `mode: 'view'`). Currently inert — no consumer matches
 *   on it yet — carried along so it's available once one does.
 * @param {number|null} [revision] - The writer's last-known
 *   `view_configurations.revision` for this view (see
 *   pushSharedVisualizationUpdate in visualizationSyncService.js, which
 *   sources it from ViewConfigurationManager's cached view). Stamped onto
 *   the entry so a late-join replay (yjsObservers.js's
 *   replayVisualizationState) can tell a stale in-flight entry apart from
 *   one newer than a server snapshot it's being compared against. Omitted
 *   (left unset, not written as an explicit null) when the caller has no
 *   revision to report — see replayVisualizationState's docstring for how
 *   an unstamped entry is treated.
 * @param {{sessionRevision: number|null, actorId: string, opId: string|null}|null} [meta]
 *   Phase D6 mutation envelope (VR gestures only, currently) — see
 *   VRExplorationManager._buildMutationMeta. Each present field is stamped
 *   onto the entry individually; omitted entirely when not supplied.
 */
export function syncVisualizationToYjs(viewId, userId, vizState, syncKey = null, collaborationViewId = null, revision = null, meta = null) {
  try {
    // Each field is its own nested Y.Map entry (not a plain-object merge), so
    // two clients patching DIFFERENT fields concurrently (e.g. Alice changes
    // opacity, Bob changes representation) both survive — Y.js merges at the
    // per-key level instead of picking one whole-value winner. A plain-object
    // read-merge-write here used to let the second write silently clobber the
    // first client's field, even though the two patches touched disjoint keys.
    ydoc.transact(() => {
      let entry = yVisualizationState.get(viewId);
      if (!(entry instanceof Y.Map)) {
        entry = new Y.Map();
        yVisualizationState.set(viewId, entry);
      }
      let vizMap = entry.get("visualization");
      if (!(vizMap instanceof Y.Map)) {
        vizMap = new Y.Map();
        entry.set("visualization", vizMap);
      }
      for (const [key, value] of Object.entries(vizState || {})) {
        vizMap.set(key, value);
      }
      entry.set("userId", userId);
      entry.set("syncKey", syncKey);
      entry.set("collaborationViewId", collaborationViewId);
      entry.set("clientId", ydoc.clientID);
      entry.set("lastUpdate", Date.now());
      if (revision != null) {
        entry.set("revision", revision);
      }
      if (meta) {
        if (meta.actorId != null) entry.set("actorId", meta.actorId);
        if (meta.opId != null) entry.set("opId", meta.opId);
        if (meta.sessionRevision != null) entry.set("sessionRevision", meta.sessionRevision);
      }
    });
  } catch (error) {
    log.error("Failed to sync visualization to Y.js:", error);
  }
}

/**
 * Broadcast active manipulator identity for UI awareness.
 * Call with target/action when interaction starts; call with null target to clear.
 * @param {string} userId
 * @param {string|null} displayName
 * @param {string|null} target - "camera" | "dataset" | "filter" | null (clear)
 * @param {string|null} action - "manipulating" | "loading" | "filtering" | null
 */
export function syncManipulatorToYjs(userId, displayName, target, action) {
  try {
    if (!target) {
      yManipulatorState.delete(userId);
    } else {
      yManipulatorState.set(userId, {
        userId,
        displayName,
        target,
        action,
        clientId: ydoc.clientID,
        timestamp: Date.now(),
      });
    }
  } catch (error) {
    log.error("Failed to sync manipulator to Y.js:", error);
  }
}

/**
 * Broadcast the active dataset to all users in the same room.
 * Keyed by roomId so sync is scoped to the current session only.
 * @param {string} roomId - Session/room ID (from sessionManager.getRoomId())
 * @param {string} userId - User making the selection
 * @param {{ datasetId, name, path, type, source }} datasetInfo
 */
export function syncActiveDatasetToYjs(roomId, userId, datasetInfo) {
  try {
    // "Active dataset" is semantically exclusive — only one can be active per
    // room — so last-writer-wins on the VALUE is correct. What used to be
    // broken was `version`: reading the previous value and incrementing it
    // locally races when two clients select concurrently (both can read the
    // same prev.version and compute the same next value). Date.now() needs no
    // read of a shared value to compute, so it can't collide the same way.
    ydoc.transact(() => {
      yActiveDataset.set(roomId, {
        ...datasetInfo,
        version: Date.now(),
        updatedBy: userId,
        updatedAt: Date.now(),
        clientId: ydoc.clientID,
      });
    });
    console.log('[CIA Collab] → activeDataset broadcast', datasetInfo.datasetId);
  } catch (error) {
    log.error("Failed to sync active dataset to Y.js:", error);
  }
}

// ============================================================================
// VR SESSION REGISTRY (Phase 1 — session convergence)
// ============================================================================

/**
 * A registry record whose lastHeartbeat is older than this is treated as
 * abandoned (e.g. the host's tab closed without a clean leave) — a fresh
 * "Enter VR" on that view claims the slot instead of adopting a dead session.
 */
export const VR_SESSION_STALE_MS = 15000;

function isLiveVRSessionRecord(record, nowMs = Date.now()) {
  if (!record) return false;
  return nowMs - (record.lastHeartbeat || 0) <= VR_SESSION_STALE_MS;
}

/**
 * Look up the live VR session registered for a view, if any.
 * @param {string} viewConfigurationId
 * @returns {object|null} the record, or null if missing/stale
 */
export function getVRSessionForView(viewConfigurationId) {
  if (!viewConfigurationId) return null;
  const record = yVRSessions.get(viewConfigurationId);
  return isLiveVRSessionRecord(record) ? record : null;
}

/**
 * Try to claim the VR session slot for a view. If a live record already
 * exists there AND belongs to a DIFFERENT host — another client claimed it
 * first — that record is returned UNCHANGED and the caller must adopt it
 * rather than overwrite it. If the live record belongs to the SAME host,
 * this is not a competing claim — it's that host updating its own record
 * (e.g. rekeying from a temporary id to the server-assigned one after a slow
 * registration completes late), so it's allowed through, preserving the
 * original createdAt/participantCount rather than resetting them. Otherwise
 * (no live record at all) our record is written and returned.
 *
 * Two clients can call this "simultaneously" (neither sees a live record
 * yet) and both write; Y.js Map is last-writer-wins, so every client
 * eventually converges on ONE surviving value once the transactions
 * propagate. The loser of that race has to notice its own value lost (see
 * VRExplorationManager's post-claim observer) and re-key rather than trying
 * to tie-break locally — there is no way to pick a winner synchronously
 * across two clients that can't see each other yet.
 *
 * @param {string} viewConfigurationId
 * @param {{sessionId:string, hostUserId:string, hostUserName:string, datasetId?:string, projectId?:string, participantCount?:number}} record
 * @returns {object} the record that won the claim — ours, or the pre-existing live one from a different host
 */
export function claimVRSession(viewConfigurationId, record) {
  let winner = record;
  try {
    ydoc.transact(() => {
      const existing = yVRSessions.get(viewConfigurationId);
      if (isLiveVRSessionRecord(existing) && existing.hostUserId !== record.hostUserId) {
        winner = existing;
        return;
      }
      const now = Date.now();
      winner = {
        ...record,
        viewConfigurationId,
        createdAt: existing?.createdAt || record.createdAt || now,
        lastHeartbeat: now,
        participantCount: existing?.participantCount || record.participantCount || 1,
      };
      yVRSessions.set(viewConfigurationId, winner);
    });
  } catch (error) {
    log.error("Failed to claim VR session:", error);
  }
  return winner;
}

/**
 * Refresh lastHeartbeat so the record doesn't go stale while its session is
 * active. Host-only: a non-host calling this is a no-op, so a guest can never
 * keep a crashed/disconnected host's record artificially live — that would
 * block the stale-record election in VRExplorationManager's
 * _tickVRSessionRegistry from ever running after an ungraceful host
 * disconnect (no clean releaseVRSession call).
 * @param {string} viewConfigurationId
 * @param {string} userId - caller's user id; must match the record's hostUserId to take effect
 */
export function heartbeatVRSession(viewConfigurationId, userId) {
  try {
    const existing = yVRSessions.get(viewConfigurationId);
    if (!existing || existing.hostUserId !== userId) return;
    yVRSessions.set(viewConfigurationId, {
      ...existing,
      lastHeartbeat: Date.now(),
    });
  } catch (error) {
    log.error("Failed to heartbeat VR session:", error);
  }
}

/**
 * Release the VR session slot for a view. Host-only: a non-host calling this
 * is a no-op, so a joiner losing network briefly can never delete the
 * registry entry out from under the host.
 * @param {string} viewConfigurationId
 * @param {string} userId - caller's user id
 */
export function releaseVRSession(viewConfigurationId, userId) {
  try {
    const existing = yVRSessions.get(viewConfigurationId);
    if (!existing || existing.hostUserId !== userId) return;
    yVRSessions.delete(viewConfigurationId);
  } catch (error) {
    log.error("Failed to release VR session:", error);
  }
}

// ============================================================================
// COLLABORATION VIEW REGISTRY (H5 — collaborationViewId)
// ============================================================================
//
// A collaborationViewId identifies ONE logical collaborative view — distinct
// from viewConfigId (minted per-client via POST /views, never shared) and
// from datasetId (shared by CONTENT, not by view — see viewSyncKey.js's
// dataset-based syncKey, which stays the default for existing sync channels).
// Keyed by that same dataset-based syncKey so every client viewing the same
// dataset in the same room agrees on one id: the first client to resolve a
// given syncKey with no existing record mints and claims it; every later
// client for that syncKey adopts the existing id instead of minting its own.
// Modeled directly on claimVRSession above — same claim-if-absent-else-adopt
// shape, same last-writer-wins convergence guarantee.
//
// Currently unused by any existing sync call site (see viewSyncKey.js's
// `mode: 'view'` — nothing defaults to it yet); this registry exists so that
// plumbing has somewhere real to claim an id from.

export const yCollaborationViews = ydoc.getMap("collaboration-views");

/**
 * Look up the collaborationViewId already claimed for a dataset-based sync
 * key, if any.
 * @param {string} syncKey - see resolveViewSyncKey() in viewSyncKey.js
 * @returns {string|null}
 */
export function getCollaborationViewId(syncKey) {
  if (!syncKey) return null;
  return yCollaborationViews.get(syncKey)?.collaborationViewId || null;
}

/**
 * Claim (or adopt) the collaborationViewId for a dataset-based sync key.
 * @param {string} syncKey - see resolveViewSyncKey() in viewSyncKey.js
 * @param {string} [mintedBy] - caller's user id, for diagnostics only
 * @returns {string|null} the id that won the claim — ours, or the pre-existing one
 */
export function claimCollaborationViewId(syncKey, mintedBy) {
  if (!syncKey) return null;
  let winner = null;
  try {
    ydoc.transact(() => {
      const existing = yCollaborationViews.get(syncKey);
      if (existing) {
        winner = existing;
        return;
      }
      winner = {
        collaborationViewId: `cview_${ydoc.clientID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        mintedBy: mintedBy || null,
        createdAt: Date.now(),
      };
      yCollaborationViews.set(syncKey, winner);
    });
  } catch (error) {
    log.error("Failed to claim collaboration view id:", error);
  }
  return winner?.collaborationViewId || null;
}

/**
 * Remove this device's presence from Y.js (call on disconnect).
 *
 * Takes a PARTICIPANT id, not a user id: passing the account id would wipe the
 * presence of every device signed into that account, so one headset leaving
 * would erase the other's avatar and controllers mid-session.
 *
 * @param {string} participantId - getParticipantId() of the leaving device
 */
export function removeUserPresenceFromYjs(participantId) {
  yCursors.delete(participantId);
  yAvatars.delete(participantId);
  // Remove both hand controllers
  yVRControllers.delete(`${participantId}_left`);
  yVRControllers.delete(`${participantId}_right`);
  log.info(`Participant presence removed from Y.js: ${participantId}`);
}

log.info("Y.js core initialized (v2.0 - presence only architecture)");
