// src/core/vr/VRManipulationLock.js
// A single assignable "who may manipulate the shared data" token for a VR
// exploration session.
//
// WHY NOT VRControlManager: that manager models "a DESKTOP user puppeteers a
// VR user's viewpoint" (establishControl sets mode = DESKTOP_CONTROLLER). This
// is an orthogonal concern — nobody is driving anybody's camera here, we are
// deciding which ONE participant's clip/threshold/glyph/transform patches are
// allowed to reach visualizationSyncService. Folding the two together would
// mean a desktop controller implicitly owning data control, which is not what
// either feature means.
//
// PHASE D3 — server lease client. Authority for "who may manipulate" now
// lives server-side as a compare-and-swap lease on vr_exploration_sessions
// (server/src/routes/vr.js: POST/DELETE .../lease, POST .../lease/heartbeat,
// POST .../lease/grant). This class is a thin client of those four endpoints.
//
// The Y.js map `vr-manipulation-<sessionId>` is kept, but demoted to a FAST
// UI ECHO ONLY — every time this client learns the true lease state (from its
// own request's response, or from another client's change arriving over the
// `vr:lease-changed` WebSocket broadcast — see _handleLeaseChangedEvent), it
// mirrors the holder into the map so anything reading getHolder()/isHeldByMe()
// (VRSpatialMenuModel, remote menus) updates within a frame without waiting on
// a network round trip. It is NOT the source of truth for canManipulate().
//
//   "holder"   -> { holderUserId, holderUserName, grantedBy, grantedAt, heartbeat }
//   "requests" -> { [userId]: { userName, atMs } }
//
// `requests` stays entirely Y.js-authoritative — it is advisory UI ("who has
// asked"), never enforced server-side, so it needs no lease involvement at
// all. See requestControl/approveRequest/denyRequest below, all unchanged
// from the pre-lease implementation.
//
// LOCAL vs SERVER SESSIONS. VRExplorationManager can be running against a
// local `vrsession_*` id — _tryRegisterSession failed, timed out, or hasn't
// resolved yet — with no server row to hold a lease on. A lease must never be
// attempted against one (see isServerSessionId / _isServerSession). For a
// local session, canManipulate() falls back to exactly the Y.js mutual-
// exclusion this class used before the lease existed: this is deliberate, not
// a leftover — solo/offline VR must keep working (see canManipulate()).

import { vr as log } from '@Utils/logger.js';
import { ydoc } from '@Collaboration/yjs/yjsSetup.js';
import { apiClient } from '@Services/apiClient.js';
import { getDeviceId } from '@Core/identity/deviceIdentity.js';
// Every identity check here answers "is this DEVICE the holder/host?", so it
// must use the per-device participant id. With getUserId() (the account), two
// headsets signed into one account both believed they held the token the
// moment either of them took it.
import {
  getParticipantId,
  getParticipantName,
  isSelfIdentity,
} from '@Collaboration/presence/userManagement.js';

/**
 * A holder whose heartbeat has not been refreshed within this window counts as
 * absent — their headset died, their tab froze, or they left without a clean
 * stop(). Deliberately well above the ~1 Hz heartbeat rate so a couple of
 * dropped ticks never vacate a live holder.
 */
export const MANIP_STALE_MS = 8000;

/** A pending "may I have control?" request older than this is dropped. */
export const REQUEST_TTL_MS = 30000;

/**
 * Floor on holder heartbeat writes. heartbeat() is safe to call every frame;
 * this is what keeps it off the Y.js wire (and the lease heartbeat endpoint)
 * at 72-90 Hz.
 */
export const HEARTBEAT_INTERVAL_MS = 1000;

const HOLDER_KEY = 'holder';
const REQUESTS_KEY = 'requests';

// Server-issued session ids are UUIDs (vr_exploration_sessions.id). The local
// fallback minted by VRExplorationManager while registration is pending/failed
// is shaped `vrsession_<...>` and never matches this. Anything else (test
// fixture ids like "test-session-1") also correctly reads as "not a server
// session" — there is no row, so no lease is attempted, and this class falls
// back to its original Y.js-only behavior. See class docstring.
const SERVER_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} sessionId
 * @returns {boolean} true when `sessionId` is shaped like a real server
 *   `vr_exploration_sessions.id`, as opposed to a local `vrsession_*`
 *   placeholder or a test fixture id.
 */
export function isServerSessionId(sessionId) {
  return typeof sessionId === 'string' && SERVER_SESSION_ID_RE.test(sessionId);
}

export class VRManipulationLock {
  /**
   * @param {{id: string, ownerUserId?: string, ownerUserName?: string}} session
   *   The live VRExplorationSession. Read (never written) for `id` — which
   *   keys the Y.js map AND (when it is a real server id) the lease endpoints
   *   — and `ownerUserId`, which decides who is the host.
   */
  constructor(session) {
    this._session = session;
    this._boundSessionId = session.id;
    this._yLock = null;
    this._observers = [];
    /** @type {Set<Function>} */
    this._listeners = new Set();
    this._lastHeartbeatAt = 0;

    // Server lease bookkeeping (Phase D3). See canManipulate()/_resetLeaseState().
    /** @type {{participantId:string, userName?:string}|null} */
    this._serverHolder = null;
    this._epoch = 0;
    /** @type {'held'|'not-held'|'unknown'} */
    this._leaseState = 'not-held';
    /** ms timestamp of the last CONFIRMED (not offline-grace) expiry while we held it. */
    this._lastHeldExpiresAtMs = 0;

    this._onLeaseChangedEvent = null;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  start() {
    this._yLock = ydoc.getMap(`vr-manipulation-${this._session.id}`);
    this._resetLeaseState();
    this._attachObserver();
    this._attachLeaseEventListener();
    log.debug(`VRManipulationLock started on vr-manipulation-${this._session.id}`);
  }

  stop() {
    this._detachObserver();
    this._detachLeaseEventListener();

    // Vacate rather than leave a holder record that every other client has to
    // wait MANIP_STALE_MS to time out. Requests we filed are dropped for the
    // same reason.
    try {
      if (this._yLock) {
        if (this.isHeldByMe()) this._yLock.delete(HOLDER_KEY);
        this._removeRequest(getParticipantId());
      }
    } catch (err) {
      log.warn(`VRManipulationLock stop failed: ${err?.message}`);
    }

    // Best-effort server release — never blocks stop(), never throws into it.
    if (this._leaseState === 'held' && this._isServerSession()) {
      this._releaseLease().catch(() => {});
    }

    this._listeners.clear();
    this._yLock = null;
    this._lastHeartbeatAt = 0;
    this._resetLeaseState();
    log.debug('VRManipulationLock stopped');
  }

  /**
   * Re-key onto a different Y.js session id — same contract as
   * VRParticipantSync.rekey / VRControlManager.rekey (see
   * VRExplorationManager._watchVRSessionConvergence). The map is bound in
   * start(), so without this a client that lost the session-id claim race
   * would keep negotiating control on a map nobody else reads.
   *
   * Phase D3: if we held a REAL server lease against the OLD id, release it
   * and re-acquire against the NEW id — but only when the new id is itself a
   * real server session. _tryRegisterSession can leave VR running on a local
   * `vrsession_*` id with no server row; a lease must never be attempted
   * against one (see isServerSessionId).
   *
   * Listeners registered via onChange() survive the re-key deliberately: the
   * subscriber (VRExplorationManager) is unaware the map moved.
   *
   * @param {string} newSessionId
   */
  rekey(newSessionId) {
    if (!newSessionId || newSessionId === this._boundSessionId) return;

    const oldSessionId = this._boundSessionId;
    const hadServerLease = this._isServerSession(oldSessionId) && this._leaseState === 'held';

    // Vacate the OLD map first, exactly as VRParticipantSync does, so a stale
    // copy of us cannot squat there until MANIP_STALE_MS elapses.
    try {
      if (this._yLock && this.isHeldByMe()) this._yLock.delete(HOLDER_KEY);
      this._removeRequest(getParticipantId());
    } catch (err) {
      log.warn(`VRManipulationLock rekey cleanup failed: ${err?.message}`);
    }

    // Fire-and-forget: rekey() itself must stay synchronous (the map swap
    // below is asserted on immediately by callers/tests), so the lease
    // transfer happens in the background.
    if (hadServerLease) {
      this._releaseLease(oldSessionId).catch(() => {});
    }

    this._detachObserver();
    this._session.id = newSessionId;
    this._boundSessionId = newSessionId;
    this._yLock = ydoc.getMap(`vr-manipulation-${newSessionId}`);
    this._lastHeartbeatAt = 0;
    this._resetLeaseState();
    this._attachObserver();
    this._notify();

    if (hadServerLease && this._isServerSession(newSessionId)) {
      this._acquireLease().catch(() => {});
    }

    log.info(`VRManipulationLock re-keyed to session ${newSessionId}`);
  }

  /**
   * Subscribe to any holder/request change.
   * @param {(state: {holder: object|null, requests: Array<object>}) => void} cb
   * @returns {() => void} unsubscribe
   */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  // ===========================================================================
  // READS
  // ===========================================================================

  /** @returns {boolean} true when the local user owns this session. */
  isHost() {
    // isSelfIdentity, not an exact compare: ownerUserId is a participant id
    // when the session was claimed through the Y.js registry, but a bare
    // account id when it came back from the server (joinSession).
    return isSelfIdentity(this._session?.ownerUserId);
  }

  /**
   * Stricter than isHost(): true only when ownerUserId is DEVICE-grained
   * (contains the participant-id separator) AND matches this device's
   * getParticipantId() exactly.
   *
   * WHY isHost() alone is not enough to gate lease seizure: a legacy
   * pre-021 row (or any row that fell back to the bare owner_user_id — see
   * src/core/vr/vrSessionOwner.js) carries only the ACCOUNT id.
   * isSelfIdentity() deliberately tolerates that bare id (roster/grant/
   * release all want "is this my account's session"), so isHost() returns
   * true for EVERY device signed into that account — exactly the two-
   * headsets-one-account bug this method exists to contain. Authority
   * *seizure* (claimAsHost(), gated below) needs the strict device-grain
   * read; isHost() itself stays permissive on purpose — see claimAsHost().
   * @returns {boolean}
   */
  _isHostAtDeviceGrain() {
    const ownerId = this._session?.ownerUserId;
    return typeof ownerId === 'string' && ownerId.includes('#') && ownerId === getParticipantId();
  }

  /**
   * The LIVE holder, or null. A record whose heartbeat lapsed past
   * MANIP_STALE_MS reads as null here (the holder is treated as absent) —
   * this is a pure read, the reclaiming WRITE is host-only, see heartbeat().
   *
   * This still reads the Y.js map, which Phase D3 keeps as a fast mirror of
   * the server lease (see class docstring) — so this continues to return the
   * right answer for a server session without needing to change shape here.
   * @returns {{holderUserId:string, holderUserName:string, grantedBy:string,
   *   grantedAt:number, heartbeat:number}|null}
   */
  getHolder() {
    const raw = this._readHolder();
    if (!raw) return null;
    if (Date.now() - (raw.heartbeat || raw.grantedAt || 0) > MANIP_STALE_MS) return null;
    return raw;
  }

  /** @returns {boolean} the local user is the live holder. */
  isHeldByMe() {
    return this.getHolder()?.holderUserId === getParticipantId();
  }

  /**
   * May the local user push shared data changes right now?
   *
   * SERVER SESSION: authority is the server lease, not Y.js. True only when
   * `_leaseState === 'held'`, with one relief valve — OFFLINE GRACE: if the
   * lease server is unreachable (`_leaseState === 'unknown'`), we still allow
   * IF we were previously confirmed held AND we are still within that lease's
   * last known `expiresAt`. The server cannot have granted the lease to
   * anyone else before that expiry, so this is safe — and mandatory: without
   * it, one dropped heartbeat would freeze the headset mid-session.
   * `'unknown'` with no prior confirmed hold denies.
   *
   * LOCAL SESSION (no server row — see isServerSessionId): there is no lease
   * to enforce, so this falls back to exactly the Y.js mutual-exclusion this
   * class used before the lease existed — true when nobody live holds the
   * Y.js token, or when we do. This is what keeps solo/offline VR working.
   * @returns {boolean}
   */
  canManipulate() {
    if (!this._isServerSession()) {
      const holder = this.getHolder();
      if (!holder) return true;
      return holder.holderUserId === getParticipantId();
    }

    if (this._leaseState === 'held') return true;
    if (this._leaseState === 'unknown') {
      return this._lastHeldExpiresAtMs > 0 && Date.now() < this._lastHeldExpiresAtMs;
    }
    return false;
  }

  /**
   * Pending control requests, expired ones filtered out.
   * @returns {Array<{userId:string, userName:string, atMs:number}>}
   */
  getRequests() {
    const map = this._readRequests();
    const now = Date.now();
    return Object.entries(map)
      .filter(([, r]) => r && now - (r.atMs || 0) <= REQUEST_TTL_MS)
      .map(([userId, r]) => ({ userId, userName: r.userName || userId, atMs: r.atMs || 0 }))
      .sort((a, b) => a.atMs - b.atMs);
  }

  // ===========================================================================
  // WRITES
  // ===========================================================================

  /**
   * The host takes the token. Called once on session start, and again by
   * heartbeat() when the current holder goes stale.
   *
   * Phase D3: still writes the Y.js echo synchronously (unchanged — callers
   * observe this within the same tick), and additionally fires the server
   * acquire in the background. The Y.js write is optimistic; canManipulate()
   * only flips to true once the acquire response lands (or, for a local
   * session, never needed one — see canManipulate()).
   * @returns {boolean} whether the (Y.js) write happened
   */
  claimAsHost() {
    if (!this._yLock || !this.isHost()) return false;
    // Server sessions only: a bare (account-grained) ownerUserId must not be
    // allowed to seize the lease just because isHost() tolerates it — see
    // _isHostAtDeviceGrain(). Local `vrsession_*` sessions (no server row,
    // no lease to seize) are deliberately exempt, so solo/offline VR — where
    // ownerUserId legitimately has no device suffix in some test/legacy
    // paths — keeps working exactly as before.
    if (this._isServerSession() && !this._isHostAtDeviceGrain()) return false;
    this._writeHolder(getParticipantId(), getParticipantName(), getParticipantId());
    this._acquireLease().catch(() => {});
    return true;
  }

  /**
   * Hand the token to someone else. Permitted for the current holder and for
   * the host (so a host can always take a stuck token back off a peer).
   * @param {string} userId
   * @param {string} [userName]
   * @returns {boolean}
   */
  grantTo(userId, userName) {
    if (!this._yLock || !userId) return false;
    if (!this.isHeldByMe() && !this.isHost()) return false;

    const pending = this._readRequests()[userId];
    this._writeHolder(userId, userName || pending?.userName || userId, getParticipantId());
    this._removeRequest(userId);
    this._grantLease(userId).catch(() => {});
    return true;
  }

  /**
   * Give the token back to the session host. Only the current holder may do
   * this — a bystander calling release() would be able to yank control off
   * whoever has it.
   * @returns {boolean}
   */
  release() {
    if (!this._yLock || !this.isHeldByMe()) return false;

    const hostId = this._session?.ownerUserId;
    // A bare (account-only) host id on a SERVER session — a legacy pre-021
    // row, or any row that fell back to owner_user_id (see vrSessionOwner.js)
    // — is not addressable: isHeldByMe()/getHolder() compare against the
    // device-grained getParticipantId(), so a bare id written here could
    // never be recognized as held by anyone again. Treat it the same as "no
    // host at all" and vacate outright, rather than writing a key nobody can
    // pick back up. Scoped to server sessions only, mirroring claimAsHost()'s
    // gate — a LOCAL session's ownerUserId always comes from
    // getParticipantId() (Path 2/3 in VRExplorationManager.startExploration),
    // so it is never bare in practice, and this must not change local/
    // offline VR's long-standing behavior.
    const unaddressableHost =
      this._isServerSession() && !!hostId && !hostId.includes('#');
    if (!hostId || isSelfIdentity(hostId) || unaddressableHost) {
      // We ARE the host, the session has no host at all, or (server session
      // only) the host id is unaddressable: vacate outright rather than
      // re-granting ourselves the token we just gave up / writing a key
      // nobody can pick back up.
      this._yLock.delete(HOLDER_KEY);
      this._releaseLease().catch(() => {});
      return true;
    }
    this._writeHolder(hostId, this._session?.ownerUserName || hostId, getParticipantId());
    // Handing back to a specific host is a TRANSFER of server authority, not
    // a plain release (which would leave the lease unheld and no one — not
    // even the host — server-confirmed to hold it). The host's own lock
    // instance picks this up via the vr:lease-changed broadcast this grant
    // fires (see _handleLeaseChangedEvent), the same path a peer-to-peer
    // grantTo uses.
    this._grantLease(hostId).catch(() => {});
    return true;
  }

  /**
   * File a request for control. Idempotent — re-requesting just refreshes the
   * timestamp, which is also how a user keeps a request alive past
   * REQUEST_TTL_MS.
   *
   * Unchanged by Phase D3 — requests are advisory UI, not authority, and stay
   * entirely Y.js-side (see class docstring).
   * @returns {boolean}
   */
  requestControl() {
    if (!this._yLock) return false;
    if (this.isHeldByMe()) return false;

    const next = this._prunedRequests();
    next[getParticipantId()] = { userName: getParticipantName(), atMs: Date.now() };
    this._yLock.set(REQUESTS_KEY, next);
    return true;
  }

  /** Grant the token to a requester and clear their request. */
  approveRequest(userId) {
    const pending = this._readRequests()[userId];
    return this.grantTo(userId, pending?.userName);
  }

  /** Drop a request without granting anything. */
  denyRequest(userId) {
    if (!this._yLock || !userId) return false;
    if (!this.isHeldByMe() && !this.isHost()) return false;
    this._removeRequest(userId);
    return true;
  }

  /**
   * Periodic upkeep. Safe to call every frame — everything below is gated on
   * HEARTBEAT_INTERVAL_MS, so at most one Y.js write, and at most one lease
   * heartbeat POST, per second per client.
   *
   * Jobs:
   *  1. If the SERVER lease is 'held', refresh its TTL (Phase D3, new).
   *  2. If we hold the Y.js token, refresh its heartbeat so nobody reclaims it.
   *  3. If we are the HOST and the recorded holder has gone stale, reclaim —
   *     via claimAsHost(), which now also re-attempts the server acquire, so
   *     a genuinely expired server lease gets reclaimed too (its TTL is
   *     deliberately longer than MANIP_STALE_MS — see D2 — so by the time the
   *     Y.js view goes stale the server-side compare-and-swap already allows
   *     a new acquire).
   *
   * (3) is host-only ON PURPOSE. If every client wrote the reclaim, N clients
   * would race on the same `holder` key the instant a holder dropped, each
   * naming a different winner until Y.js's last-writer-wins settled — with the
   * gate flapping for everyone in between. One writer, one outcome.
   *
   * Every network call here is fire-and-forget and internally try/catches —
   * this runs inside the XR frame loop and must never throw into it.
   *
   * @returns {boolean} whether anything was written (Y.js)
   */
  heartbeat() {
    if (!this._yLock) return false;

    const now = Date.now();
    if (now - this._lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return false;
    this._lastHeartbeatAt = now;

    // Server lease refresh — gated on OUR confirmed lease state, independent
    // of whichever branch below actually touches Y.js (they can briefly
    // diverge by up to one round trip after a claim/grant).
    if (this._leaseState === 'held' && this._isServerSession()) {
      this._sendLeaseHeartbeat().catch(() => {});
    }

    if (this.isHeldByMe()) {
      const current = this._readHolder();
      this._yLock.set(HOLDER_KEY, { ...current, heartbeat: now });
      return true;
    }

    if (!this.isHost()) return false;

    // Host-only housekeeping from here down.
    const raw = this._readHolder();
    const stale = raw && now - (raw.heartbeat || raw.grantedAt || 0) > MANIP_STALE_MS;
    if (stale) {
      log.info(`VRManipulationLock: holder ${raw.holderUserId} went stale — host reclaiming`);
      this.claimAsHost();
      return true;
    }

    // Sweep expired requests so a roster built from getRequests() doesn't have
    // to re-filter forever (and so the Y.js payload stays small).
    const map = this._readRequests();
    const pruned = this._prunedRequests();
    if (Object.keys(map).length !== Object.keys(pruned).length) {
      this._yLock.set(REQUESTS_KEY, pruned);
      return true;
    }

    return false;
  }

  // ===========================================================================
  // INTERNALS — Y.js
  // ===========================================================================

  /** @private */
  _attachObserver() {
    if (!this._yLock) return;
    const observer = () => this._notify();
    this._yLock.observe(observer);
    this._observers.push(() => {
      try {
        this._yLock?.unobserve(observer);
      } catch {
        /* map already gone */
      }
    });
  }

  /** @private */
  _detachObserver() {
    this._observers.forEach((off) => off());
    this._observers = [];
  }

  /** @private */
  _notify() {
    const state = { holder: this.getHolder(), requests: this.getRequests() };
    for (const cb of this._listeners) {
      try {
        cb(state);
      } catch (err) {
        log.warn(`VRManipulationLock listener threw: ${err?.message}`);
      }
    }
  }

  /** @private Raw holder record, staleness NOT applied. */
  _readHolder() {
    const raw = this._yLock?.get(HOLDER_KEY);
    return raw && typeof raw === 'object' ? raw : null;
  }

  /** @private */
  _readRequests() {
    const raw = this._yLock?.get(REQUESTS_KEY);
    return raw && typeof raw === 'object' ? raw : {};
  }

  /** @private A copy of the requests map with expired entries removed. */
  _prunedRequests() {
    const now = Date.now();
    const out = {};
    for (const [userId, r] of Object.entries(this._readRequests())) {
      if (r && now - (r.atMs || 0) <= REQUEST_TTL_MS) out[userId] = r;
    }
    return out;
  }

  /** @private */
  _removeRequest(userId) {
    if (!this._yLock || !userId) return;
    const map = this._readRequests();
    if (!(userId in map)) return;
    const next = { ...map };
    delete next[userId];
    this._yLock.set(REQUESTS_KEY, next);
  }

  /** @private */
  _writeHolder(holderUserId, holderUserName, grantedBy) {
    const now = Date.now();
    this._yLock.set(HOLDER_KEY, {
      holderUserId,
      holderUserName,
      grantedBy,
      grantedAt: now,
      heartbeat: now,
    });
    // Our own next heartbeat should not be suppressed by a stale throttle
    // stamp left over from before the token moved.
    this._lastHeartbeatAt = holderUserId === getParticipantId() ? now : 0;
  }

  // ===========================================================================
  // INTERNALS — server lease (Phase D3)
  // ===========================================================================

  /**
   * @private
   * @param {string} [sessionId] defaults to the currently bound session id
   * @returns {boolean}
   */
  _isServerSession(sessionId = this._boundSessionId) {
    return isServerSessionId(sessionId);
  }

  /**
   * @private Reset local lease bookkeeping — used on start() and rekey().
   * Local (non-server) sessions get `_leaseState = 'held'` — not because a
   * lease was granted, but because there IS no lease to enforce, and
   * canManipulate() only consults `_leaseState` on the server-session path
   * (see canManipulate()). This keeps a freshly-(re)started local session
   * permissive, matching this class's pre-lease behavior.
   */
  _resetLeaseState() {
    this._serverHolder = null;
    this._epoch = 0;
    this._lastHeldExpiresAtMs = 0;
    this._leaseState = this._isServerSession() ? 'not-held' : 'held';
  }

  /** @private Definitive (server-confirmed) "we hold it". */
  _applyHeld(holder, epoch, expiresAt) {
    this._serverHolder = holder || null;
    if (Number.isFinite(Number(epoch))) this._epoch = Number(epoch);
    this._leaseState = 'held';
    this._lastHeldExpiresAtMs = expiresAt ? new Date(expiresAt).getTime() : 0;
  }

  /**
   * @private Definitive (server-confirmed) "we do NOT hold it" — a 409/403,
   * a successful release, or being granted away. Clears the offline-grace
   * window on purpose: a definitive answer always outranks a stale grace
   * period from an earlier hold.
   */
  _applyNotHeld(holder = null) {
    this._serverHolder = holder;
    this._leaseState = 'not-held';
    this._lastHeldExpiresAtMs = 0;
  }

  /**
   * @private A network/server failure taught us nothing definitive — fall
   * back to offline grace (canManipulate()) rather than assuming either
   * outcome. Deliberately does NOT touch `_lastHeldExpiresAtMs`.
   */
  _applyUnknown() {
    this._leaseState = 'unknown';
  }

  /**
   * @private Shared error handling for all four endpoints. A network error or
   * 5xx teaches us nothing about who holds the lease — 'unknown', offline
   * grace applies. Any other status (409 lease-held/lease-lost, 403
   * desktop-control-disabled/lease-grant-forbidden, 404, ...) is a real
   * answer from the server: we definitively do not hold it.
   * @param {*} err
   */
  _onLeaseError(err) {
    const status = err?.status;
    const isNetworkOrServerError = status === 0 || status === undefined || status >= 500;
    if (isNetworkOrServerError) {
      log.warn(`VRManipulationLock lease request failed (offline grace): ${err?.message}`);
      this._applyUnknown();
    } else {
      this._applyNotHeld(err?.details?.holder ?? null);
    }
  }

  /**
   * @private POST /vr/sessions/:id/lease — acquire or refresh (as current
   * holder) the manipulation lease. No-ops against a non-server session id.
   */
  async _acquireLease() {
    if (!this._isServerSession()) return null;
    try {
      const res = await apiClient.post(`/vr/sessions/${this._boundSessionId}/lease`, {
        deviceId: getDeviceId(),
      });
      const heldByMe = res?.holder?.participantId === getParticipantId();
      if (heldByMe) {
        this._applyHeld(res.holder, res.epoch, res.expiresAt);
        this._writeHolder(
          getParticipantId(),
          res.holder.userName || getParticipantName(),
          getParticipantId()
        );
      } else {
        // A 200 from POST /lease should only ever mean WE now hold it — but
        // guard defensively rather than trust that invariant blindly.
        this._applyNotHeld(res?.holder ?? null);
      }
      this._notify();
      return res;
    } catch (err) {
      this._onLeaseError(err);
      this._notify();
      return null;
    }
  }

  /**
   * @private POST /vr/sessions/:id/lease/heartbeat — extend the TTL of a
   * lease we believe we hold. Only called while `_leaseState === 'held'`
   * (see heartbeat()).
   */
  async _sendLeaseHeartbeat() {
    if (!this._isServerSession()) return null;
    try {
      const res = await apiClient.post(
        `/vr/sessions/${this._boundSessionId}/lease/heartbeat`,
        { deviceId: getDeviceId(), epoch: this._epoch }
      );
      this._applyHeld(this._serverHolder, res.epoch, res.expiresAt);
      this._notify();
      return res;
    } catch (err) {
      this._onLeaseError(err);
      this._notify();
      return null;
    }
  }

  /**
   * @private DELETE /vr/sessions/:id/lease — release. Best-effort: a failure
   * here (network down, already unheld, forbidden) must never throw or block
   * the caller — the TTL lapses server-side regardless.
   * @param {string} [sessionIdOverride] used by rekey() to release the OLD
   *   session's lease after `_boundSessionId` has already moved to the new one.
   */
  async _releaseLease(sessionIdOverride) {
    const sessionId = sessionIdOverride || this._boundSessionId;
    if (!this._isServerSession(sessionId)) return null;
    try {
      await apiClient.delete(`/vr/sessions/${sessionId}/lease`, {
        body: { deviceId: getDeviceId() },
      });
      if (sessionId === this._boundSessionId) {
        this._applyNotHeld(null);
        this._notify();
      }
      return true;
    } catch (err) {
      if (sessionId === this._boundSessionId) {
        this._onLeaseError(err);
        this._notify();
      }
      return null;
    }
  }

  /**
   * @private POST /vr/sessions/:id/lease/grant — force-transfer to another
   * participant. Authority (holder or session owner) is enforced server-side;
   * a 403 here just means the server disagreed, handled like any other
   * definitive lease error.
   * @param {string} toParticipantId
   */
  async _grantLease(toParticipantId) {
    if (!this._isServerSession() || !toParticipantId) return null;
    try {
      const res = await apiClient.post(`/vr/sessions/${this._boundSessionId}/lease/grant`, {
        toParticipantId,
        deviceId: getDeviceId(),
      });
      const heldByMe = res?.holder?.participantId === getParticipantId();
      if (heldByMe) {
        this._applyHeld(res.holder, res.epoch, res.expiresAt);
      } else {
        this._applyNotHeld(res?.holder ?? null);
      }
      this._notify();
      return res;
    } catch (err) {
      this._onLeaseError(err);
      this._notify();
      return null;
    }
  }

  /**
   * @private Attach the `cia:vr-lease-changed` window listener — serverSync.js
   * dispatches this for every acquire/heartbeat/release/grant broadcast (see
   * wsManager.vrLeaseChanged), following the exact pattern
   * AvatarNetworkSync.js uses for `cia:vr-participant-*`. This is how a
   * GRANTEE learns they now hold the lease: the granter's request updates the
   * granter's own state directly, but the grantee only finds out via this
   * broadcast.
   */
  _attachLeaseEventListener() {
    if (typeof window === 'undefined') return;
    this._onLeaseChangedEvent = (e) => this._handleLeaseChangedEvent(e?.detail);
    window.addEventListener('cia:vr-lease-changed', this._onLeaseChangedEvent);
  }

  /** @private */
  _detachLeaseEventListener() {
    if (typeof window === 'undefined' || !this._onLeaseChangedEvent) return;
    window.removeEventListener('cia:vr-lease-changed', this._onLeaseChangedEvent);
    this._onLeaseChangedEvent = null;
  }

  /**
   * @private
   * @param {{sessionId?: string, lease: {holderParticipantId:string,
   *   holderName:string|null, expiresAt:string, epoch:number}|null}} detail
   */
  _handleLeaseChangedEvent(detail) {
    if (!detail || detail.sessionId !== this._boundSessionId) return;

    const lease = detail.lease;
    if (!lease) {
      this._applyNotHeld(null);
      if (this._yLock) this._yLock.delete(HOLDER_KEY);
      this._notify();
      return;
    }

    const holder = { participantId: lease.holderParticipantId, userName: lease.holderName };
    const heldByMe = holder.participantId === getParticipantId();
    if (heldByMe) {
      this._applyHeld(holder, lease.epoch, lease.expiresAt);
    } else {
      this._applyNotHeld(holder);
    }
    if (this._yLock) {
      this._writeHolder(
        holder.participantId,
        holder.userName || holder.participantId,
        holder.participantId
      );
    }
    this._notify();
  }
}

export default VRManipulationLock;
