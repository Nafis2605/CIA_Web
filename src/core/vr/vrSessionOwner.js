// src/core/vr/vrSessionOwner.js
// The single definition of "who owns/hosts this server VR session", mirroring
// src/core/instances/viewSyncKey.js's "single definition, well-commented"
// posture (one small dependency-free module, imported everywhere the answer
// is needed, instead of the same fallback chain re-derived at each read site).
//
// WHY THIS EXISTS
// vr_exploration_sessions.owner_user_id is the ACCOUNT that created the
// session — it says nothing about which of that account's devices is the
// live host. Migration 021 added owner_participant_id, the composite
// `accountUserId#deviceId` id (see buildParticipantId in server/src/routes/
// vr.js and getParticipantId in src/collaboration/presence/userManagement.js)
// that actually identifies a single device. Before this module existed,
// VRExplorationManager.startExploration read owner_user_id directly at its
// one join-path assignment site (the other two paths — registry adopt/claim —
// already produced a composite id via getParticipantId(), so they were never
// broken). The bare id then flowed downstream into nine other read sites
// (VRManipulationLock.isHost/claimAsHost/release, VRExplorationManager's
// roster/presence/release-on-leave, useVRSession's isOwner, VRSessionPanel's
// grant-control gate) — some tolerant of a bare id via isSelfIdentity(),
// others doing an exact compare that a bare id can never satisfy. Two devices
// signed into the SAME account both passed the tolerant checks, so BOTH could
// claim the manipulation lease; the exact-compare sites just silently matched
// nothing (host never shown in the roster, grant-control unusable from the
// desktop panel). Fixing the read at its single assignment point in
// startExploration fixes all nine downstream sites at once.
//
// SHAPE TOLERANCE
// Accepts EITHER a raw REST row (snake_case — GET/POST/join return
// `vr_exploration_sessions` rows as-is) or the camelCase subset websocket.js
// hand-picks for the `vr:session-created` broadcast. Both shapes must resolve
// to the same value for the same session, or a client that learned about a
// session via the WS broadcast would disagree with one that fetched it via
// REST about who the host is.
//
// LEGACY ROWS
// A row created before migration 021 has owner_participant_id === null (the
// column didn't exist yet to populate). resolveServerSessionOwnerId falls
// back to the bare owner_user_id for those — still account-grained, not
// device-grained, which is a known and deliberately contained gap (see
// VRManipulationLock._isHostAtDeviceGrain(), which refuses to let a bare id
// seize the manipulation lease on a server session even though it still
// passes isSelfIdentity()).
//
// DEPENDENCY RULE — keep this module dependency-free, exactly like
// viewSyncKey.js. It is imported from VRExplorationManager and, indirectly,
// from anything that reads session.ownerUserId downstream of it.

/**
 * Resolve the device-grained (when available) owner id for a server VR
 * session row.
 *
 * Priority: `owner_participant_id`/`ownerParticipantId` (composite,
 * `accountUserId#deviceId`, present on any row created after migration 021)
 * → `owner_user_id`/`ownerUserId` (bare account id, always present) → null.
 *
 * @param {{owner_participant_id?: string|null, ownerParticipantId?: string|null,
 *   owner_user_id?: string|null, ownerUserId?: string|null}|null|undefined} row
 * @returns {string|null}
 */
export function resolveServerSessionOwnerId(row) {
  if (!row) return null;
  return row.owner_participant_id || row.ownerParticipantId || row.owner_user_id || row.ownerUserId || null;
}

/**
 * Resolve the display name to pair with resolveServerSessionOwnerId(). There
 * is no per-device name column (a device has no display identity beyond the
 * account's), so this is just the account's owner_user_name — kept as its own
 * function, alongside the id resolver, so callers never have to know that.
 *
 * @param {{owner_user_name?: string|null, ownerUserName?: string|null}|null|undefined} row
 * @returns {string|null}
 */
export function resolveServerSessionOwnerName(row) {
  if (!row) return null;
  return row.owner_user_name || row.ownerUserName || null;
}
