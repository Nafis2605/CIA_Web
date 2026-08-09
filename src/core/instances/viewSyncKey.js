// src/core/instances/viewSyncKey.js
// The single definition of "two clients are looking at the same thing".
//
// WHY THIS EXISTS
// Every client that opens a dataset mints its OWN ViewConfiguration via
// createView()/POST /views, and the server hands back a fresh uuid_generate_v4()
// each time. Two headsets showing the SAME dataset in the SAME room therefore
// hold two different, both individually valid, viewConfigIds — and the shared
// dataset path (workspaceManager._handleYjsActiveDatasetUpdate) deliberately
// keeps each client on its own instance, so this is the normal case, not an
// edge case.
//
// Keying cross-client sync on viewConfigId means every peer's update is
// addressed to an id no other client has, so it is silently dropped on receipt.
// VR session convergence already fixed this for sessions by keying on the
// dataset id; this module is that same rule, extracted so the visualization and
// camera channels can share it (see VRExplorationManager._resolveSessionKey and
// workspaceManager._handleYjsVisualizationUpdate).
//
// DEPENDENCY RULE — keep this module dependency-free.
// It is imported from @Core, @Services and @UI. Anything it imports would be
// pulled into all three.

/**
 * Resolve the cross-client sync key for an instance.
 *
 * Dataset id first: it is the one identifier every client viewing the same data
 * agrees on. viewConfigId is the last-resort fallback — for an instance with no
 * dataset yet it is at least stable locally, and for clients that genuinely do
 * share one ViewConfiguration (a saved workspace view) it still matches.
 *
 * Accepts EITHER shape and must yield the same key for both, because the
 * publisher usually holds an `instanceData` while the receiver walks
 * workspaceManager's `instance` wrappers:
 *   - workspaceManager instance: { instanceData: { dataset, datasetId }, datasetId, viewConfigId }
 *   - handler instanceData:      { dataset, datasetId, viewConfigId }
 * All three dataset fields are assigned from the same `dataset.id` on load
 * (VTKInstanceHandler.loadData, workspaceManager.loadDataIntoInstance), so the
 * ordering below is consistent whichever one is passed in.
 *
 * `mode: 'view'` resolves a genuinely distinct per-view identity
 * (`collaborationViewId`) instead, for callers that need isolation between
 * two views of the same dataset rather than the default "same dataset, same
 * room converges" behavior. It deliberately does NOT fall back to dataset id
 * — an instance with no collaborationViewId yet resolves to null in this
 * mode, rather than silently rejoining the dataset-scoped convergence it was
 * asking to opt out of. No existing call site uses this mode; default
 * ('dataset') behavior is unchanged.
 *
 * @param {{instanceData?: {dataset?: {id?: string}, datasetId?: string, collaborationViewId?: string},
 *   dataset?: {id?: string}, datasetId?: string,
 *   viewConfigId?: string, collaborationViewId?: string}|null|undefined} instance
 * @param {{mode?: 'dataset'|'view'}} [options]
 * @returns {string|null} the sync key, or null when nothing identifies it
 */
export function resolveViewSyncKey(instance, { mode = 'dataset' } = {}) {
  if (mode === 'view') {
    return instance?.collaborationViewId || instance?.instanceData?.collaborationViewId || null;
  }
  return (
    instance?.instanceData?.dataset?.id ||
    instance?.instanceData?.datasetId ||
    instance?.dataset?.id ||
    instance?.datasetId ||
    instance?.viewConfigId ||
    null
  );
}

/**
 * Whether a local instance should receive an update published under
 * (`viewId`, `syncKey`) by a remote client.
 *
 * Two ways to match, in priority order:
 *   1. Same viewConfigId — clients that really do share one ViewConfiguration
 *      (saved workspace views, linked views). This is the pre-existing
 *      behaviour and must keep working untouched.
 *   2. Same sync key — clients that each minted their own ViewConfiguration
 *      over the same dataset. This is the case that used to be dropped.
 *
 * `syncKey` is optional so updates from an older client (or any publisher not
 * yet threading it) still match on rule 1 alone rather than matching nothing.
 *
 * @param {{viewConfigId?: string}|null|undefined} instance
 * @param {string} viewId - the publisher's view configuration id
 * @param {string|null|undefined} [syncKey] - the publisher's resolved sync key
 * @param {{mode?: 'dataset'|'view'}} [options]
 * @returns {boolean}
 */
export function instanceMatchesViewUpdate(instance, viewId, syncKey, options) {
  if (!instance) return false;
  if (viewId && instance.viewConfigId === viewId) return true;
  if (!syncKey) return false;
  return resolveViewSyncKey(instance, options) === syncKey;
}
