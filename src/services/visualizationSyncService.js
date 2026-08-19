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
// The workspace's role hasn't been fetched yet (as opposed to a role that HAS
// been fetched and denies editing, which is plain NO_PERMISSION). The patch
// was queued and will be replayed automatically once the role resolves.
const PENDING_ROLE = { persisted: false, queued: true, reason: "role-pending" };

const _roleFetchInFlight = new Set();

// The first camera/visualization edit right after a workspace becomes active
// can land while its role is still being fetched — resolveShareMode() must
// answer synchronously, so it reports SHARE_BLOCKED for that window even
// though the role may turn out to permit editing. Rather than drop that
// edit, stash the latest patch per (workspaceId, kind) here and replay it
// once the in-flight fetch resolves. Toggle edits (pushSharedWidgetToggle)
// are deliberately not queued — replaying a stale toggle after the user may
// have already re-toggled it locally would flip it the wrong way.
const _pendingReplay = new Map(); // workspaceId -> { camera, visualization }

function _queuePendingReplay(workspaceId, kind, viewId, patch, syncKey) {
  let entry = _pendingReplay.get(workspaceId);
  if (!entry) {
    entry = { camera: null, visualization: null };
    _pendingReplay.set(workspaceId, entry);
  }
  entry[kind] = { viewId, patch, syncKey };
}

function _replayPendingPatches(workspaceId) {
  const entry = _pendingReplay.get(workspaceId);
  if (!entry) return;
  _pendingReplay.delete(workspaceId);

  // Discard rather than resurrect an edit if the user has since switched
  // away from the workspace it was queued for.
  if (resolveActiveWorkspaceId() !== workspaceId) return;

  if (entry.camera) {
    pushSharedCameraUpdate(entry.camera.viewId, entry.camera.patch, entry.camera.syncKey);
  }
  if (entry.visualization) {
    pushSharedVisualizationUpdate(
      entry.visualization.viewId,
      entry.visualization.patch,
      entry.visualization.syncKey
    );
  }
}

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
  const state = new Map(); // viewId -> { lastSent, timer, pending, userId, syncKey, revision }

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
    // 5th arg (collaborationViewId) stays null here — nothing in this
    // throttle resolves one yet (see syncVisualizationToYjs's docstring).
    // 6th arg is the writer's last-known ViewConfiguration.revision, only
    // meaningful to syncVisualizationToYjs; syncCameraToYjs (the other
    // sendFn this throttle wraps) simply ignores the extra argument.
    // 7th arg (meta) is appended ONLY when present, so every existing
    // caller that never supplies one keeps calling sendFn with exactly the
    // same argument count as before (see e.g.
    // visualizationSyncService.test.js's exact toHaveBeenCalledWith checks).
    if (e.userId) {
      if (e.meta) {
        sendFn(viewId, e.userId, patch, e.syncKey, null, e.revision ?? null, e.meta);
      } else {
        sendFn(viewId, e.userId, patch, e.syncKey, null, e.revision ?? null);
      }
    }
  };

  const send = (viewId, userId, patch, syncKey = null, revision = null, meta = null) => {
    let e = state.get(viewId);
    if (!e) {
      e = { lastSent: 0, timer: null, pending: null, userId, syncKey, revision, meta: null };
      state.set(viewId, e);
    }
    e.userId = userId;
    // Latest wins, but never let a caller that omitted the key erase one we
    // already have — a mid-drag patch from a path that doesn't resolve it
    // would otherwise make the trailing flush unroutable for peers.
    if (syncKey) e.syncKey = syncKey;
    // Same reasoning as syncKey: a later, more current revision read always
    // wins; a caller that didn't resolve one (e.g. camera pushes, which
    // never pass revision) must not blank out one already queued.
    if (revision != null) e.revision = revision;
    // Phase D6 mutation envelope (sessionRevision/actorId/opId) — see
    // pushSharedVisualizationUpdate. Only ever supplied by the visualization
    // send path (VR); camera pushes never pass one. Latest wins, same as
    // revision — never blanked out by a caller that didn't resolve one.
    if (meta) e.meta = meta;
    e.pending = { ...(e.pending || {}), ...patch };

    const elapsed = Date.now() - e.lastSent;
    if (elapsed >= throttleMs) {
      flush(viewId);
    } else if (!e.timer) {
      e.timer = setTimeout(() => flush(viewId), throttleMs - elapsed);
    }
  };

  // Exposed so a caller that knows a gesture just ended (e.g. mouse-up after
  // a camera drag) can deliver the last patch immediately instead of it
  // sitting on the trailing timer for up to `throttleMs`.
  send.flush = flush;

  return send;
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
      .then(() => _replayPendingPatches(workspaceId))
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

  const workspaceId = resolveActiveWorkspaceId();
  const mode = resolveShareMode();
  if (mode === SHARE_BLOCKED) {
    // Role not cached yet ⇒ still in flight, not a resolved denial — queue
    // for replay instead of dropping this edit on the floor.
    if (workspaceId && permissionService.getCachedRole(workspaceId) == null) {
      _queuePendingReplay(workspaceId, "camera", viewId, cameraPatch, syncKey);
      return PENDING_ROLE;
    }
    return NO_PERMISSION;
  }

  const userId = getUserId();
  if (userId) _throttledCameraSend(viewId, userId, cameraPatch, syncKey);

  if (mode === SHARE_EPHEMERAL) return TRANSMITTED_ONLY;
  getViewConfigurationManager()?.updateCamera(viewId, cameraPatch);

  return { persisted: true };
}

/**
 * Force-deliver a view's pending throttled camera patch immediately, instead
 * of waiting for the trailing timer. Call this when a drag/orbit gesture
 * ends so the peer sees the final camera position without a throttle-window
 * delay. No-op if nothing is pending for the view.
 * @param {string} viewId
 */
export function flushSharedCameraUpdate(viewId) {
  _throttledCameraSend.flush(viewId);
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
 * @param {{sessionRevision: number|null, actorId: string, opId: string|null}|null} [meta]
 *   Phase D6 mutation envelope (VR only, currently) — written into the Y.js
 *   entry and forwarded to the view PUT. Optional and additive: omitted
 *   entirely (not even as an extra `null` argument) downstream when not
 *   supplied, so no existing caller's call shape changes.
 */
export function pushSharedVisualizationUpdate(viewId, patch, syncKey = null, meta = null) {
  if (!viewId) return NO_VIEW;

  const workspaceId = resolveActiveWorkspaceId();
  const mode = resolveShareMode();
  if (mode === SHARE_BLOCKED) {
    if (workspaceId && permissionService.getCachedRole(workspaceId) == null) {
      _queuePendingReplay(workspaceId, "visualization", viewId, patch, syncKey);
      return PENDING_ROLE;
    }
    return NO_PERMISSION;
  }

  const userId = getUserId();
  if (userId) {
    // The view's last-known server revision, if any — see
    // syncVisualizationToYjs's `revision` param and yjsObservers.js's
    // replayVisualizationState for why a late-join replay needs this
    // stamped on the entry. Reads whatever ViewConfigurationManager has
    // cached locally; it lags the server by one round trip for the patch
    // being sent right now (the REST persist below hasn't resolved yet),
    // which is fine — it's a floor ("written no earlier than revision N"),
    // not a claim about this exact patch's own revision.
    const revision = getViewConfigurationManager()?.getView(viewId)?.revision ?? null;
    _throttledVizSend(viewId, userId, patch, syncKey, revision, meta);
  }

  // No workspace: the peer still sees the change, but there is no
  // ViewConfiguration to write it to, so it does not survive a reload.
  if (mode === SHARE_EPHEMERAL) return TRANSMITTED_ONLY;
  if (meta) {
    getViewConfigurationManager()?.updateVisualization(viewId, patch, meta);
  } else {
    getViewConfigurationManager()?.updateVisualization(viewId, patch);
  }

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
