// src/services/visualizationSyncService.js
// Canonical write path for shared InstanceToolsPanel visualization controls
// (Camera, Transform, Appearance, Colormap, Slice, Window/Level, Widgets).
//
// Every shared panel setter calls one of the push* functions here AFTER
// applying its change locally via instanceTools/vtkSceneFeature. Each push*:
//   1. Checks permission (view:modify_configuration) for the active workspace.
//   2. Pushes an ephemeral update over Y.js for real-time cross-client feedback
//      (reuses the existing syncCameraToYjs/syncVisualizationToYjs channel —
//      already consumed by workspaceManager._setupViewSyncListener()).
//   3. Persists the change to ViewConfiguration via ViewConfigurationManager
//      (throttled REST sync + WebSocket broadcast to other clients, and
//      durable for late joiners / reload).
//
// Permission is resolved from workspaceManager.getActiveWorkspace() (the
// collaboration-workspace singleton), NOT from a React prop — the
// InstanceToolsPanel component tree does not currently thread a workspaceId
// prop down to this depth, so gating on a hook prop would silently no-op.

import { getViewConfigurationManager } from "@Init/appInitializer.js";
import { syncCameraToYjs, syncVisualizationToYjs } from "@Collaboration/yjs/yjsSetup.js";
import { getUserId } from "@Collaboration/presence/userManagement.js";
import { workspaceManager as collaborationWorkspaceManager } from "@Core/data/managers/WorkspaceManager.js";
import { permissionService, PERMISSIONS } from "@Services/permissionService.js";

const NO_VIEW = { persisted: false, reason: "no-active-view" };
const NO_PERMISSION = { persisted: false, reason: "permission-denied" };
// Sent to collaborators but not written to a ViewConfiguration, because there
// is no active workspace to own one. `transmitted: true` is what distinguishes
// this from an actual refusal — callers that only check `persisted` would
// otherwise report a working sync as a failure.
const TRANSMITTED_ONLY = {
  persisted: false,
  transmitted: true,
  reason: "no-active-workspace",
};

const _roleFetchInFlight = new Set();

// ---------------------------------------------------------------------------
// Ephemeral Y.js send throttling
//
// The durable REST persist (ViewConfigurationManager) already throttles to
// 100ms, but the ephemeral Y.js send was called once per React onChange tick —
// a slider drag flooded the CRDT + relay with an update per pixel. Throttle the
// Y.js send per view with a leading edge + a guaranteed trailing flush so the
// final value is never dropped, at ~20 updates/sec (matches VRCursorSync).
// Patches are merged per view (shallow) so distinct fields queued within a
// window are all delivered in one send.
// ---------------------------------------------------------------------------
const YJS_SEND_THROTTLE_MS = 50;

function createViewPatchThrottle(sendFn, throttleMs = YJS_SEND_THROTTLE_MS) {
  const state = new Map(); // viewId -> { lastSent, timer, pending, userId, syncKey }

  const flush = (viewId) => {
    const e = state.get(viewId);
    if (!e || !e.pending) return;
    const patch = e.pending;
    e.pending = null;
    e.lastSent = Date.now();
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    if (e.userId) sendFn(viewId, e.userId, patch, e.syncKey);
  };

  return (viewId, userId, patch, syncKey = null) => {
    let e = state.get(viewId);
    if (!e) {
      e = { lastSent: 0, timer: null, pending: null, userId, syncKey };
      state.set(viewId, e);
    }
    e.userId = userId;
    // Latest wins, but never let a caller that omitted the key erase one we
    // already have — a mid-drag patch from a path that doesn't resolve it
    // would otherwise make the trailing flush unroutable for peers.
    if (syncKey) e.syncKey = syncKey;
    e.pending = { ...(e.pending || {}), ...patch };

    const elapsed = Date.now() - e.lastSent;
    if (elapsed >= throttleMs) {
      flush(viewId);
    } else if (!e.timer) {
      e.timer = setTimeout(() => flush(viewId), throttleMs - elapsed);
    }
  };
}

const _throttledCameraSend = createViewPatchThrottle(syncCameraToYjs);
const _throttledVizSend = createViewPatchThrottle(syncVisualizationToYjs);

/**
 * Resolve the workspaceId for the currently active collaboration workspace.
 * Returns null if none is active (e.g. not yet loaded).
 */
export function resolveActiveWorkspaceId() {
  return collaborationWorkspaceManager.getActiveWorkspace()?.getEffectiveId() || null;
}

/**
 * How much of the sync pipeline a change is allowed to use right now.
 *
 * WHY THREE STATES AND NOT A BOOLEAN
 * The old boolean folded "there is no workspace" into "you lack permission",
 * which broke the most common local workflow: opening a VTP file never
 * activates a workspace, so every VR change was refused and the user was told
 * their *role* was read-only — for a role that did not exist. Worse, the
 * desktop VTK tools never consulted this gate at all, so the SAME clipBox /
 * threshold / representation change broadcast fine from the tools menu while VR
 * was blocked.
 *
 * No workspace means no permission model to enforce, not "deny everything".
 * There is nothing to persist to either, so that case transmits over Y.js and
 * skips only the durable write. Once a workspace DOES exist, the role check is
 * exactly as strict as it has always been.
 *
 * @typedef {'ephemeral'|'full'|'blocked'} ShareMode
 */

/** Y.js only — no workspace to persist to, and no roles to enforce. */
const SHARE_EPHEMERAL = "ephemeral";
/** Y.js + durable REST persist. */
const SHARE_FULL = "full";
/** Nothing: a workspace exists and this role may not modify the view. */
const SHARE_BLOCKED = "blocked";

/**
 * Resolve how much of the pipeline the local user may use for the active view.
 * Kicks off a background role fetch when nothing is cached yet, so subsequent
 * calls become accurate.
 * @returns {ShareMode}
 */
export function resolveShareMode() {
  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) return SHARE_EPHEMERAL;

  if (
    permissionService.getCachedRole(workspaceId) == null &&
    !_roleFetchInFlight.has(workspaceId)
  ) {
    _roleFetchInFlight.add(workspaceId);
    permissionService
      .fetchWorkspaceRole(workspaceId)
      .finally(() => _roleFetchInFlight.delete(workspaceId));
  }

  return permissionService.hasPermission(workspaceId, PERMISSIONS.VIEW_MODIFY_CONFIGURATION)
    ? SHARE_FULL
    : SHARE_BLOCKED;
}

/**
 * Whether the local user may modify the active shared view.
 *
 * True in ephemeral mode as well as full: with no workspace there is no role to
 * deny, and refusing there is what silently broke local-file collaboration.
 * @returns {boolean}
 */
export function canModifyActiveView() {
  return resolveShareMode() !== SHARE_BLOCKED;
}

/** Human-readable reason to show in the panel when a control is gated. */
export function getPermissionDeniedReason() {
  return resolveShareMode() === SHARE_BLOCKED ? "View is read-only for your role" : null;
}

/**
 * Push a camera update: ephemeral Y.js (real-time) + throttled durable persist.
 * @param {string} viewId
 * @param {object} cameraPatch - partial camera state (position, focalPoint, viewUp, viewAngle, ...)
 * @param {string|null} [syncKey] - cross-client sync key (see viewSyncKey.js)
 */
export function pushSharedCameraUpdate(viewId, cameraPatch, syncKey = null) {
  if (!viewId) return NO_VIEW;

  const mode = resolveShareMode();
  if (mode === SHARE_BLOCKED) return NO_PERMISSION;

  const userId = getUserId();
  if (userId) _throttledCameraSend(viewId, userId, cameraPatch, syncKey);

  if (mode === SHARE_EPHEMERAL) return TRANSMITTED_ONLY;
  getViewConfigurationManager()?.updateCamera(viewId, cameraPatch);

  return { persisted: true };
}

/**
 * Push a visualization update (opacity, representation, pointSize, lineWidth,
 * colormap, activeArray, transform, slice, windowLevel, glyph): ephemeral
 * Y.js (real-time) + throttled durable persist.
 * @param {string} viewId
 * @param {object} patch - shallow patch, e.g. { opacity: 0.5 } or { transform: {...} }
 * @param {string|null} [syncKey] - cross-client sync key (see viewSyncKey.js).
 *   Without it the patch only reaches peers that happen to share this exact
 *   viewId, which ad-hoc-opened views never do.
 */
export function pushSharedVisualizationUpdate(viewId, patch, syncKey = null) {
  if (!viewId) return NO_VIEW;

  const mode = resolveShareMode();
  if (mode === SHARE_BLOCKED) return NO_PERMISSION;

  const userId = getUserId();
  if (userId) _throttledVizSend(viewId, userId, patch, syncKey);

  // No workspace: the peer still sees the change, but there is no
  // ViewConfiguration to write it to, so it does not survive a reload.
  if (mode === SHARE_EPHEMERAL) return TRANSMITTED_ONLY;
  getViewConfigurationManager()?.updateVisualization(viewId, patch);

  return { persisted: true };
}

/**
 * Push a widget activation toggle (ruler/angle/plane). Durable-only (REST +
 * WebSocket broadcast) — widget toggles create/destroy VTK widget objects
 * rather than mutate a continuous property, so there's no ephemeral Y.js
 * channel for them; the receiving side diffs against current state instead
 * of blindly re-toggling on every tick.
 * @param {string} viewId
 * @param {string} widgetType - 'line' | 'angle' | 'plane'
 * @param {boolean} active
 */
export function pushSharedWidgetToggle(viewId, widgetType, active) {
  if (!viewId) return NO_VIEW;
  if (resolveShareMode() === SHARE_BLOCKED) return NO_PERMISSION;

  const vcm = getViewConfigurationManager();
  const view = vcm?.getView(viewId);
  if (!view) return NO_VIEW;

  const existing = view.widgets?.find((w) => w.type === widgetType);
  if (existing) {
    vcm.updateWidget(viewId, existing.id, { active });
  } else {
    vcm.addWidget(viewId, { type: widgetType, active });
  }

  return { persisted: true };
}
