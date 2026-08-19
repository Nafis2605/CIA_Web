// src/core/vr/VRExplorationManager.js
// Manages VR exploration session lifecycle and coordination
//
// RESPONSIBILITIES:
// - Create/join/leave exploration sessions
// - Coordinate with VRManager for WebXR
// - Manage participant state via Y.js
// - Bridge between UI and VR system

import { vr as log } from '@Utils/logger.js';
import { vrManager } from '@Core/vr/VRManager.js';
import { VRExplorationSession, PARTICIPATION_MODE, SESSION_STATUS, EXPLORATION_MODES } from '@Core/data/models/VRExplorationSession.js';
import { VRParticipantSync } from '@Core/vr/VRParticipantSync.js';
import { VRToolManager } from '@Core/vr/tools/VRToolManager.js';
import { VRSnapshotManager } from '@Core/vr/VRSnapshotManager.js';
import { VRControlManager } from '@Core/vr/VRControlManager.js';
import { VRManipulationLock, isServerSessionId } from '@Core/vr/VRManipulationLock.js';
// Phase D5 rollback snapshot source — see beginManipulationGesture. Reads the
// full set of VTK visualization state applySharedState() knows how to apply
// (Phase C3), not just camera/opacity/representation.
import { aggregateVTKVisualizationState } from '@Core/instances/types/vtk/vtkStateAggregator.js';
import { VRNavigationController } from '@Core/vr/navigation/VRNavigationController.js';
import { workspaceManager } from '@Core/instances/workspaceManager.js';
import { resolveViewSyncKey, instanceMatchesViewUpdate } from '@Core/instances/viewSyncKey.js';
import { resolveServerSessionOwnerId, resolveServerSessionOwnerName } from '@Core/vr/vrSessionOwner.js';
import { getViewConfigurationManager, getDatasetManager } from '@Init/appInitializer.js';
// getParticipantId(), NOT getUserId(), is the identity every peer-facing check
// below uses: two headsets on one account share a getUserId(), so "is this me?"
// answered yes on both and each device claimed the other's host role, lock and
// avatar. getUserId() stays only where an ACCOUNT is meant.
import {
  getUserId,
  getUserName,
  getUserColor,
  getParticipantId,
  getParticipantName,
  isSelfIdentity,
} from '@Collaboration/presence/userManagement.js';
// Room id for the collaboration diagnostic — it is the Y.Doc room every peer
// must share, and the first thing to compare when two headsets cannot see
// each other. See getCollaborationDiagnostics().
import { sessionManager } from '@Core/session/sessionManager.js';
import { getDeviceId } from '@Core/identity/deviceIdentity.js';
import { apiClient } from '@Services/apiClient.js';
import { isBuiltInDatasetId, resolveBuiltInDatasetId } from '@Services/builtInDatasets.js';
import { BaseManager } from '@Core/data/managers/BaseManager.js';
import { vrAvatarSystem } from '@Core/instances/types/vtk/vr/VTKVRAvatars.js';
import { vrSpatialUI } from '@Core/instances/types/vtk/vr/VTKVRSpatialUI.js';
import { vrMultiViewGrid } from '@Core/vr/VRMultiViewGrid.js';
import {
  vtkClippingFeature,
  vtkSceneFeature,
  vtkThresholdFeature,
  vtkIsosurfaceFeature,
} from '@Core/instances/types/vtk/features/index.js';
import { VRValueEditorModel } from '@Core/vr/VRValueEditorModel.js';
import { vtkGlyphFeature, isGlyphFeatureAvailable, getDisabledGlyphTypes } from '@Core/instances/types/vtk/features/VTKGlyphFeature.js';
import { instanceTools } from '@VTK/vtkInstanceTools.js';
import { pushSharedVisualizationUpdate } from '@Services/visualizationSyncService.js';
import { vrCursorSync } from '@Core/vr/VRCursorSync.js';
import {
  ydoc,
  yVRSessions,
  getVRSessionForView,
  claimVRSession,
  heartbeatVRSession,
  releaseVRSession,
  syncManipulatorToYjs,
  yManipulatorState,
} from '@Collaboration/yjs/yjsSetup.js';
import { hydrateFromYjs } from '@Collaboration/yjs/yjsObservers.js';
import { presenceSystem } from '@Collaboration/presence/presenceSystem.js';
import { mapXRPointToData, controllerForward } from '@Core/vr/tools/vrPlaneMath.js';
import { vrEnvironment } from '@Core/vr/environment/VREnvironment.js';
import { voiceRoomService, getVoiceRoomName } from '@Services/voice/voiceRoomService.js';

// ---------------------------------------------------------------------------
// Entry-placement geometry. These four are derived TOGETHER and must stay in
// sync with VTKVRSpatialUI's PANEL_DISTANCE — the whole point is that the
// dataset and the spatial menu do not occupy the same solid angle.
//
// The old fit (2.5 m diagonal at 2.0 m) made the dataset subtend ~77 deg while
// the panel subtends ~40 deg, so no lateral offset could separate them: the
// menu would have to sit ~67 deg off-axis, outside any usable gaze cone. The
// fix is to fit the dataset to a smaller angular radius so both fit in front.
//
// Solve for the centre distance D such that the near face of the bounding
// sphere clears the panel plane:
//     D = PANEL_PLANE_M + PANEL_CLEARANCE_M + R,  where R = D * sin(halfAngle)
//  => D * (1 - sin(halfAngle)) = PANEL_PLANE_M + PANEL_CLEARANCE_M
// With 15 deg / 1.6 m / 0.35 m this gives D ~= 2.63 m, R ~= 0.68 m, so the
// dataset spans ~1.36 physical metres. Deliberately smaller than before — the
// user grows it with the two-hand gesture, which now stays grounded.
const FIT_HALF_ANGLE_RAD = (15 * Math.PI) / 180;
const PANEL_PLANE_M = 1.6;
const PANEL_CLEARANCE_M = 0.35;
const FIT_DISTANCE_M =
  (PANEL_PLANE_M + PANEL_CLEARANCE_M) / (1 - Math.sin(FIT_HALF_ANGLE_RAD));
const FIT_DIAGONAL_M = 2 * FIT_DISTANCE_M * Math.sin(FIT_HALF_ANGLE_RAD);

// How high (physical metres) the dataset's own bottom bound sits above the
// floor — a fixed pedestal rather than resting directly on it. Without this,
// _computeAutoPlacement's grounding invariant (see there) pins a flat/short
// dataset's bottom to the literal floor, so its center — and anything sized
// to its bounds, like the cube-axes marker — ends up hugging the floor well
// below a comfortable standing eye/interaction line. A fixed pedestal (not a
// "center at eye height" placement) keeps the dataset visually anchored to
// the floor grid rather than floating disconnected from it.
const PEDESTAL_HEIGHT_M = 0.5;

// How long a "Building glyphs…" style status label may persist before the
// panel falls back to its normal status line (see getPendingWorkLabel).
const PENDING_WORK_TTL_MS = 3000;

// Minimum gap between surface picks for the pointer's hit marker (10 Hz).
//
// VTKInstanceHandler.raycastVR rebuilds its pick list (_getVRPickTargets) on
// EVERY call and then runs a vtkCellPicker pass, so it is nowhere near a
// 90 Hz-per-frame budget. The hit point only has to look attached to the
// surface, and at 10 Hz the ray itself still moves every frame — only the dot
// quantizes. Between picks the cached hit is reused verbatim.
const POINTER_PICK_MS = 100;

// Minimum gap between shared vr-sessions registry housekeeping ticks
// (heartbeat + host-promotion check) — see _tickVRSessionRegistry. 1 Hz is
// generous next to VR_SESSION_STALE_MS (15s), and keeps this off the
// per-frame budget entirely.
const VR_SESSION_HEARTBEAT_MS = 1000;

// Floor between POST /vr/sessions/:id/heartbeat calls (Issue 6 — session
// liveness, distinct from the manipulation LEASE's own heartbeat). Piggybacks
// on the 1Hz vr-session-registry tick purely for scheduling convenience — it
// runs at its own, much coarser cadence via this separate gate. 30s keeps it
// well under the server's REAP_ACTIVE_STALE_MS (120s)/REAP_PREPARING_STALE_MS
// (90s — server/src/routes/vr.js) with plenty of margin for a couple of
// dropped ticks.
const SERVER_SESSION_HEARTBEAT_MS = 30000;

// How long an in-VR notice ("X has data control") stays on the spatial menu's
// status line. Long enough to read at arm's length inside a headset, short
// enough that it never masks the dataset/scale/mode line for a whole gesture.
const VR_NOTICE_MS = 2500;

// How long after the last shared-data change this user stays lit as the
// "active manipulator" on every desktop client (the existing
// yjsSetup.syncManipulatorToYjs / onManipulatorChange channel). Matches the
// desktop camera-manipulation debounce so VR and desktop activity decay alike.
const MANIPULATOR_IDLE_MS = 1500;

// Human-readable names for the keys _pushVisualizationPatch can carry, used
// only for the refusal notice ("Glyphs needs data control — Alice has it").
const PATCH_LABELS = Object.freeze({
  clipBox: 'Clip',
  representation: 'Appearance',
  glyph: 'Glyphs',
  threshold: 'Threshold',
  isosurface: 'Isosurface',
  transform: 'Move Object',
});

// Which patch keys read as "filtering" rather than "changing the dataset" on
// the desktop manipulator-awareness UI (see _signalManipulation).
const FILTER_PATCH_KEYS = new Set(['clipBox', 'threshold', 'isosurface', 'glyph']);

// Mirrors the server's UUID check (isValidUUID, server/src/middleware/
// validateUUID.js) — used only to decide whether _checkVRPreprocessingReadiness
// can even ask the DB about a dataset. Builtin/demo ids (e.g. "builtin-lungs")
// and other client-only placeholder ids are never UUIDs and have no
// preprocessing row to check, so they must short-circuit rather than hit the
// server (which applies the identical guard — see asUuidOrNull in
// server/src/routes/vr.js — so this is belt-and-suspenders, not load-bearing
// on its own).
const DATASET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidDatasetUUID(id) {
  return typeof id === 'string' && DATASET_UUID_RE.test(id);
}

// Phase D5: how long after the last tick of a throttled value-drag (point
// size / line width / threshold min-max — see _pushThrottledPatch) with no
// further ticks before its manipulation gesture auto-ends. There is no
// discrete "pointer up" reaching that method, only a stream of value
// changes, so silence is the only end-of-gesture signal available.
const THROTTLED_GESTURE_IDLE_MS = 500;

class VRExplorationManager extends BaseManager {
  constructor() {
    super();

    // Active session
    this._activeSession = null;
    this._activeContext = null;

    // Sub-managers
    this._participantSync = null;
    this._toolManager = null;
    this._snapshotManager = null;
    this._controlManager = null;
    this._navigationController = null;

    // Data-manipulation token (Phase 3). Null outside an active session — and
    // EVERY gate below fails OPEN on null UNLESS _leaseRequired (Phase D4),
    // so nothing that worked before this existed can be blocked by its
    // absence (see _hasManipulationControl).
    /** @type {VRManipulationLock|null} */
    this._manipulationLock = null;
    this._offManipulationLock = null;
    // Phase D4 fail-closed gate. True ONLY once the active session is
    // confirmed against a real server row (isServerSessionId(session.id)) —
    // set alongside every place session.id is finalized/rekeyed
    // (startExploration, _reconcileLateRegistration,
    // _watchVRSessionConvergence). See _hasManipulationControl for why
    // unconditional fail-closed would break both offline/local VR and the
    // existing tests that fabricate a lock-less _activeContext.
    this._leaseRequired = false;
    // Phase D5: gesture-scoped rollback bookkeeping. Exactly one gesture is
    // ever in flight at a time (VR input is single-threaded per frame) — see
    // beginManipulationGesture/endManipulationGesture.
    /** @type {{kind:string, instanceId:string, state:object}|null} */
    this._gestureSnapshot = null;
    this._gestureOpId = null;
    // Per-hook "is a gesture currently open" flags — see _pushObjectTransformPatch,
    // _handleToolAction's clip-box-updated case, and _pushThrottledPatch.
    this._transformGestureActive = false;
    this._clipGestureActive = false;
    this._throttledGestureActive = false;
    this._throttledGestureTimer = null;
    // Transient in-headset message, { text, untilMs } — see _flashVRNotice.
    this._vrNotice = null;
    // Debounce handle for the "this user is manipulating" activity signal.
    this._manipulatorIdleTimer = null;

    // Frame loop — driven by vrManager's single XR rAF loop, not our own.
    // _offFrame/_offSessionEnded hold the unsubscribe functions returned by
    // vrManager.on(); _leaving guards against re-entrant leaveSession() calls
    // (leaveSession -> vrManager.exitVR() -> "end" event -> our sessionEnded
    // handler -> leaveSession again).
    this._offFrame = null;
    this._offSessionEnded = null;
    this._leaving = false;
    this._lastFrameTime = 0;

    // Isolation mode (room-scale inspection)
    this._isolationBackup = null;
    this._lastIsolationButtonState = false;
    this._lastMenuToggleButtonState = false;

    // vrManager.getYawOffset() snapshot, compared each frame in _onFrame to
    // force vrSpatialUI.forceReanchor() after a snap-turn (see there).
    this._lastMenuYawOffset = 0;

    // Which hand's controller is treated as "active" this frame for menu
    // hit-testing, tool input (e.g. annotation placement), and the aiming
    // reticle — see _resolveActivePointerHand. Sticky across frames while a
    // trigger stays held; defaults to 'right' when neither is pressed, so
    // idle frames behave exactly as before this existed.
    this._lastTriggerPressed = { left: false, right: false };
    this._lastActivePointerHand = 'right';

    // Per-frame error dedupe — a throw inside the XR loop repeats at headset
    // frame rate, so each distinct "<step>:<message>" is logged once. Cleared
    // between sessions by _resetFrameErrorState; without that reset a fault
    // that recurred in a later session of the same page load logged nothing.
    this._frameErrorSignatures = new Set();
    this._lastFrameErrorSignature = null;

    // In-VR "follow a collaborator" — soft positional follow only, never
    // touches head orientation (see followParticipant/_updateParticipantFollow).
    this._followTargetUserId = null;

    // One-shot: _applyInitialPlacement runs before any XR frame exists, so it
    // has to assume the user faces reference-space -Z at session start. That
    // assumption doesn't hold on every platform — set once the first real
    // frame's viewerPose arrives, correcting placement to the user's actual
    // head position/facing (see _applyPoseRelativePlacement).
    this._needsPoseCorrection = false;

    // One-shot: Vision Pro's transient-pointer input sources are grip-less
    // and typically don't appear in xrSession.inputSources until the user
    // pinches, so we can't tell at session start whether the platform is
    // gripless — detection happens lazily in _onFrame on the first frame
    // that reports a controller (see the input-profile check there).
    this._inputProfileDetected = false;

    // Deferred work queue: heavy per-toggle operations (glyph rebuild,
    // isosurface extraction, ...) triggered from inside the menu's
    // synchronous activate() call. Draining happens at the END of the XR
    // frame, AFTER the eyes are drawn (see _onFrame/_drainDeferredWork), so
    // the stall lands between frames instead of inside one — see _deferHeavy.
    this._deferredWork = [];
    this._pendingWorkLabel = null;

    // Floor point under the head in XR metres, refreshed each frame. Used as
    // the pivot for scale changes that originate outside the frame loop.
    this._lastHeadFloorXR = null;

    // Throttle cache for the pointer's surface pick — { pos, atMs }. See
    // POINTER_PICK_MS and _pickPointerHit.
    /** @type {{pos: {x:number,y:number,z:number}|null, atMs: number}|null} */
    this._lastPointerHit = null;

    // Session convergence (Phase 1): unsubscribe for the short-lived
    // post-claim yVRSessions observer (see _watchVRSessionConvergence), and
    // the Date.now() guard for the ≤1 Hz registry heartbeat/host-promotion
    // tick (see _tickVRSessionRegistry).
    this._offVRSessionObserver = null;
    this._lastVRSessionHeartbeat = 0;

    // Issue 6 (session lifecycle): the server row id WE successfully
    // registered via _tryRegisterSession/_reconcileLateRegistration — null
    // when we joined (Path 1), adopted a live local record (Path 2), or lost
    // the server's create race (serverRow.adopted). Lets the fast-path
    // orphan cleanup in _watchVRSessionConvergence's rekey branch tell "a row
    // WE created is now unreachable" (safe to delete) apart from "someone
    // else's canonical row is unreachable" (never delete — see that
    // method's comment). Also gates _sendServerSessionHeartbeat's own 30s
    // throttle in the frame loop.
    this._registeredServerSessionId = null;
    this._lastServerSessionHeartbeat = 0;

    // Bind methods
    this._onFrame = this._onFrame.bind(this);
    this._onSessionEnd = this._onSessionEnd.bind(this);
  }

  // ===========================================================================
  // SESSION LIFECYCLE
  // ===========================================================================

  /**
   * Start a new VR exploration session
   *
   * @param {string} instanceId - Source instance
   * @param {Object} config - Session configuration
   * @returns {Promise<VRExplorationSession>}
   */
  async startExploration(instanceId, config = {}) {
    log.info('Starting VR exploration...', { instanceId, config });

    // Get instance and handler
    const instance = workspaceManager.getInstance(instanceId);
    if (!instance) {
      throw new Error('Instance not found');
    }

    const handler = instance.handler;
    if (!handler.supportsVRExploration?.()) {
      throw new Error('Handler does not support VR exploration');
    }

    // Check VR support
    if (!vrManager.isVRSupported()) {
      throw new Error('WebXR not supported');
    }

    // Issue 7: refuse (or warn past, via config.skipPreprocessingCheck) entry
    // onto a large dataset that still needs server-side LOD/octree prep. Must
    // run BEFORE _resolveSessionKey/session registration below — a blocked
    // entry must never create a server row, or it becomes an Issue-6 zombie
    // the moment it's created.
    await this._checkVRPreprocessingReadiness(instance, config);

    // Create session locally. If we're joining an existing server session
    // (config.serverSession from joinSession), reuse its id; otherwise the
    // session is registered with the server after VR entry succeeds.
    // `state` is the Phase C buildSessionState() snapshot embedded in the
    // join response (see joinSession below) — only present when this call
    // originated from an actual join, not a fresh "Enter VR".
    const { serverSession = null, state: sessionState = null, ...sessionConfig } = config;
    const session = new VRExplorationSession({
      id: serverSession?.id ||
        `vrsession_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      viewConfigurationId: instance.viewConfigId,
      datasetId: instance.instanceData?.dataset?.id,
      projectId: instance.instanceData?.projectId,
      // resolveServerSessionOwnerId prefers owner_participant_id (composite,
      // accountUserId#deviceId — migration 021) over the bare owner_user_id,
      // so a joiner reads the HOST'S DEVICE, not just their account. See
      // src/core/vr/vrSessionOwner.js for why this single assignment point
      // is enough to fix every downstream read of session.ownerUserId.
      ownerUserId: resolveServerSessionOwnerId(serverSession) || getParticipantId(),
      ownerUserName: resolveServerSessionOwnerName(serverSession) || getParticipantName(),
      ...sessionConfig,
    });

    // SESSION CONVERGENCE (defect: a second "Enter VR" tap on the same view
    // used to mint its own vrsession_<ts>_<rand> id, opening a DIFFERENT
    // `vr-participants-<id>` Y.js map — the two users were invisible to each
    // other, and the server's GET /vr/sessions can't fix it (it filters on
    // projectId, which is undefined for locally loaded datasets). The id
    // must be settled before sub-managers are constructed: VRParticipantSync
    // keys its Y.js map by session.id, so joiners need the canonical id to
    // sync avatars against the same map.
    //
    // Three paths, in priority order:
    //  1. Explicit join (config.serverSession) — id is already canonical.
    //  2. A live room-scoped registry record already exists for this view
    //     (another client entered VR on it first) — adopt its sessionId/host
    //     directly and skip server registration entirely. This also removes
    //     the up-to-1500ms _tryRegisterSession race from the joiner's path.
    //  3. Neither — we're first. Register with the server as before, then
    //     claim the registry slot; someone racing us for the SAME slot may
    //     still beat us to it (Y.js Map is last-writer-wins), so adopt
    //     whatever claimVRSession() returns rather than assuming we won it.
    const sessionKey = this._resolveSessionKey(instance);
    // Issue 6: reset per-session bookkeeping from any PREVIOUS session this
    // manager instance ran (it's a singleton) — otherwise a stale id from
    // last time could make the fast-path orphan cleanup below think this
    // brand-new session already registered a row it never actually created.
    this._registeredServerSessionId = null;
    if (serverSession?.id) {
      // Path 1 — nothing to adopt, id is already canonical.
    } else {
      const liveRecord = getVRSessionForView(sessionKey);
      if (liveRecord) {
        // Path 2
        session.id = liveRecord.sessionId;
        session.ownerUserId = liveRecord.hostUserId;
        session.ownerUserName = liveRecord.hostUserName;
      } else {
        // Path 3
        const serverRow = await this._tryRegisterSession(session, undefined, sessionKey);
        if (serverRow?.id) {
          session.id = serverRow.id;
        }

        if (serverRow?.adopted) {
          // Issue 6 / THE load-bearing interaction with Issue 5: we lost the
          // create race (one active session per room+dataset —
          // ux_vr_sessions_room_dataset_active, 023_vr_session_lifecycle.sql).
          // The server already folded us in as a participant on the
          // WINNER's row — adopt ITS identity via resolveServerSessionOwnerId/
          // -Name rather than falling into the claimVRSession call below with
          // OURSELVES as hostUserId, which would write us into the Yjs
          // registry as host for a session the server says someone else
          // owns, re-introducing the two-hosts bug Issue 5 fixed — through
          // the registry this time, instead of the manipulation lease.
          session.ownerUserId = resolveServerSessionOwnerId(serverRow) || session.ownerUserId;
          session.ownerUserName = resolveServerSessionOwnerName(serverRow) || session.ownerUserName;
        } else {
          const claimed = claimVRSession(sessionKey, {
            sessionId: session.id,
            hostUserId: getParticipantId(),
            hostUserName: getParticipantName(),
            datasetId: session.datasetId,
            projectId: session.projectId,
          });
          session.id = claimed.sessionId;
          session.ownerUserId = claimed.hostUserId;
          session.ownerUserName = claimed.hostUserName;
          // We successfully registered a row of our own with the server
          // (not an adoption) — remember its id so the fast-path orphan
          // cleanup in _watchVRSessionConvergence can tell "a row WE
          // created is now unreachable" apart from "someone else's row is
          // unreachable" (see that method's rekey branch).
          if (serverRow?.id) {
            this._registeredServerSessionId = serverRow.id;
          }
        }
      }
    }

    // Add self as participant
    session.addParticipant(
      getParticipantId(),
      getParticipantName(),
      getUserColor(getParticipantId()),
      serverSession ? sessionConfig.participationMode || PARTICIPATION_MODE.VR_EXPLORER : PARTICIPATION_MODE.VR_EXPLORER
    );

    // Initialize sub-managers
    this._participantSync = new VRParticipantSync(session);
    this._snapshotManager = new VRSnapshotManager(session, getViewConfigurationManager());
    this._controlManager = new VRControlManager(session);
    // Data-control token. Deliberately NOT VRControlManager: that models a
    // desktop user puppeteering a VR user's viewpoint, which is orthogonal to
    // "who may push shared visualization patches". See VRManipulationLock.
    this._manipulationLock = new VRManipulationLock(session);
    // Phase D4: session.id is fully settled by this point (all three
    // convergence paths above already ran) — decide whether a lease is
    // obtainable/enforceable for THIS session right now. Re-evaluated by
    // _reconcileLateRegistration/_watchVRSessionConvergence if the id
    // changes later.
    this._leaseRequired = isServerSessionId(session.id);

    // Request XR session via VRManager — the sole owner of session lifecycle,
    // reference space and the XRWebGLLayer. This must be the only place that
    // ever calls navigator.xr.requestSession() for exploration; a competing
    // session here was the root cause of VR entry rendering nothing.
    //
    // A missing context here almost always means this view is currently
    // SERVER-rendered (no local WebGL canvas exists to build an XRWebGLLayer
    // from) — see docs/vr-rendering-architecture.md for why that's a hard
    // architectural boundary, not a bug, and why VR cannot support it.
    const glContext = handler.getWebGLContext(instance.instanceId);
    if (!glContext) {
      throw new Error(
        'This view is currently server-rendered, and VR does not support server-rendered views. ' +
        'Switch this view to local rendering and reload the dataset before entering VR. ' +
        'VR always renders on the headset’s own GPU — the server only contributes preprocessing (LOD, octree, bounds), never frames.'
      );
    }

    // Pre-warm microphone permission BEFORE going immersive. Once an
    // immersive-vr session is running the browser has nowhere to render a
    // permission prompt, so a getUserMedia() deferred until the user first
    // unmutes inside VR either hangs or is denied outright. initialize()
    // requests and immediately releases a track, which is enough to settle
    // the permission while normal DOM UI is still on screen.
    //
    // Deliberately awaited but never fatal: a user who denies the mic should
    // still get into VR, just without voice.
    await this._prewarmVoicePermission();

    log.debug('Requesting XR session via VRManager...');
    await vrManager.enterVR(glContext, {
      sessionId: session.id,
      navigationMode: sessionConfig.explorationMode,
      scale: sessionConfig.vrScale,
      requiredFeatures: ['local-floor'],
      // NOTE: do NOT request 'layers'. The renderer draws exclusively through
      // the legacy XRWebGLLayer set as baseLayer (VRManager._setupWebGLLayer).
      // Browsers that support the WebXR Layers API (e.g. Oculus/Meta Quest)
      // would grant 'layers', and the spec then forbids setting baseLayer in
      // updateRenderState() — throwing "Can't use baseLayer with layers feature
      // requested" and blocking VR entry. We never use the Layers API, so
      // requesting it gains nothing and only breaks capable headsets.
      optionalFeatures: ['bounded-floor', 'hand-tracking'],
    });
    const xrSession = vrManager.getSession();

    // Enter VR exploration mode on handler, handing it the already-configured
    // gl/XRWebGLLayer/reference space instead of letting it create its own.
    log.debug('Entering VR exploration mode on handler...');
    const vrContext = await handler.enterVRExploration(
      instance.instanceData,
      session,
      xrSession,
      {
        gl: glContext,
        xrLayer: vrManager.getXRLayer(),
        referenceSpace: vrManager.getReferenceSpace(),
      }
    );

    // Auto-fit placement: never leave vrOrigin at [0,0,0] — scientific
    // datasets are rarely centered on the data origin, so an unplaced
    // dataset is invisible on entry. Uses the same math as enterIsolation().
    this._applyInitialPlacement(vrContext, sessionConfig);
    this._needsPoseCorrection = true;

    // Initialize tool manager with handler. The `canManipulate` predicate is
    // INJECTED rather than imported by the tools, so VRAnnotationTool/
    // VRMeasureTool can refuse a placement without importing this manager
    // (which imports them — that would be a cycle).
    this._toolManager = new VRToolManager(handler, vrContext, {
      canManipulate: (label) => this._requireManipulationControl(label),
      flashNotice: (text, ms) => this._flashVRNotice(text, ms),
    });

    // Initialize navigation controller. The onObjectMoved callback lets the
    // MOVE_OBJECT mode broadcast the active dataset's transform to collaborators.
    // Pass vrManager so snap-turn plumbing works in the layered controller.
    this._navigationController = new VRNavigationController(session, vrContext, {
      vrManager,
      onObjectMoved: (final) => this._pushObjectTransformPatch(final),
    });

    // Set the world-grab engagement predicate: grip on tracked controllers
    // (squeeze > 0.7), pinch on Vision Pro (triggerPressed). This keeps grip
    // dedicated to "pull the world for navigation" while trigger stays free
    // for object-move and the menu.
    //
    // Schmitt trigger: engage high, release low. A single threshold made a grip
    // resting near 0.7 chatter at frame rate — every OFF frame froze the world
    // and suppressed fly, every ON frame re-anchored and discarded the hand
    // travel since the last anchor, so the grab felt sticky and stopped
    // tracking. The `engaged` argument is supplied by VRGrabMode, which knows
    // whether the grab is currently active.
    const GRIP_ENGAGE = 0.7;
    const GRIP_RELEASE = 0.4;
    const gripPredicate = (hand, engaged = false) => {
      if (!hand) return false;
      // Grip + trigger together is the "carry the dataset" chord
      // (VRNavigationController._isObjectMoveChord). Excluding it here is what
      // keeps the two from firing at once — grip alone pulls the world, grip
      // with trigger moves the data.
      if (hand.triggerPressed === true && !hand.isTransientPointer) return false;
      // Vision Pro's transient-pointer is gripless (squeezeValue always 0) and
      // its pinch is digital — no hysteresis needed or possible.
      if (hand.isTransientPointer) return hand.triggerPressed === true;
      return (hand.squeezeValue || 0) > (engaged ? GRIP_RELEASE : GRIP_ENGAGE);
    };
    this._navigationController.setWorldGrabEngagement(gripPredicate);

    // Store active context
    this._activeSession = session;
    this._activeContext = {
      session,
      instance,
      handler,
      vrContext,
      xrSession,
    };

    // Start session
    session.start();

    // Issue 6: fire the session-liveness heartbeat once, immediately, rather
    // than waiting for the first 1Hz frame-loop tick below — piggybacking
    // only on that tick would delay the server's 'preparing' -> 'active'
    // transition by up to SERVER_SESSION_HEARTBEAT_MS (30s) after VR entry,
    // a visibly slow status flip for no reason. Sets the throttle gate too,
    // so the frame loop's own tick doesn't immediately re-fire it.
    this._lastServerSessionHeartbeat = Date.now();
    this._sendServerSessionHeartbeat();

    // Fresh session, fresh error budget: the per-step dedupe suppresses repeat
    // logs, so carrying signatures over from a previous session would silence a
    // fault that recurs in this one.
    this._resetFrameErrorState();

    // Drive our frame work off VRManager's single XR frame loop instead of
    // requesting our own animation frames.
    this._offFrame = vrManager.on('frame', this._onFrame);
    this._offSessionEnded = vrManager.on('sessionEnded', this._onSessionEnd);

    // Start participant sync
    this._participantSync.start();

    // Data-control token. The host claims it by default so a fresh session has
    // exactly one authority instead of N headsets racing on the same patch
    // channel; everyone else asks for it (see requestManipulationControl).
    this._safeInitStep('manipulationLock.start', () => {
      this._manipulationLock.start();
      // ownerUserId is a participant id from the Y.js registry, but a bare
      // account id when it came from a server row — isSelfIdentity handles both.
      if (isSelfIdentity(session.ownerUserId)) {
        this._manipulationLock.claimAsHost();
      }
      this._offManipulationLock = this._manipulationLock.onChange((state) =>
        this._emit('manipulationControlChanged', state)
      );
    });

    // Watch the shared registry for a short window after claiming/adopting a
    // slot for this view — a claim race can resolve AFTER our own synchronous
    // claimVRSession() call returns, once a competing write propagates over
    // the network (see claimVRSession's docstring).
    this._watchVRSessionConvergence(sessionKey, session);

    // Initialize avatar system
    const avatarRenderer = vrContext.sceneObjects?.renderer;
    if (avatarRenderer) {
      this._safeInitStep('vrAvatarSystem.initialize', () =>
        vrAvatarSystem.initialize(avatarRenderer, session, vrContext)
      );
    }

    // Spatial environment: floor grid + horizon, physically anchored so the
    // user has depth/scale cues rather than a dataset floating in a void.
    if (avatarRenderer) {
      this._safeInitStep('vrEnvironment.initialize', () =>
        vrEnvironment.initialize(avatarRenderer, vrContext)
      );
    }

    // Pointer-ray broadcasting: desktop collaborators render this VR user's
    // controller ray via vrCursorSync (consumed by VTKRemoteVRRays).
    this._safeInitStep('vrCursorSync.initialize', () =>
      vrCursorSync.initialize(
        getParticipantId(),
        getParticipantName(),
        getUserColor(getParticipantId())
      )
    );

    // Voice, muted. Fire-and-forget: joining LiveKit is a network round trip
    // and must not hold up the first rendered frame. See _autoJoinVoice for
    // why this is automatic rather than menu-driven.
    this._autoJoinVoice();

    // Print the room/session/view triple every peer must agree on. Cheap, once
    // per session, and it is the first thing to check when two headsets cannot
    // see each other.
    this._logCollaborationDiagnostics('session-start');

    // Initialize the in-scene spatial tool menu. WebXR immersive sessions do
    // not render the DOM, so this VTK panel — not the React VRWristMenu — is
    // the guaranteed in-headset UI. It shares this manager as its source of
    // truth (tool select / undo / isolation toggle / exit all route back here).
    if (avatarRenderer) {
      // Pass the transform up front. The panel commits its opening anchor from
      // the FIRST hitTest(), which runs a phase before the first layout() —
      // without bounds it cannot compute its clearance from the dataset and
      // parks itself across the forward axis, where it then swallows the
      // trigger aimed at the data (see VTKVRSpatialUI._latchTransform).
      // _applyInitialPlacement has already populated these above.
      this._safeInitStep('vrSpatialUI.initialize', () =>
        vrSpatialUI.initialize(avatarRenderer, this, {
          vrScale: vrContext.vrScale,
          vrOrigin: vrContext.vrOrigin,
          dataBounds: vrContext.dataBounds,
        })
      );
    }

    // Tell the ROOM (not just the session) that this user is now in a headset.
    // Desktop collaborators who never open the VR panel still need to see it —
    // useRoomPresence's `inVR` bucket and MemberRow's VR badge both read this.
    this._safeInitStep('presence.setVRPresence', () =>
      presenceSystem.setVRPresence({
        inVR: true,
        vrSessionId: session.id,
        vrRole: isSelfIdentity(session.ownerUserId) ? 'host' : 'participant',
      })
    );

    // Late-joiner hydration (Phase C): apply the authoritative server
    // snapshot embedded in the join response, then replay Y.js. Only
    // meaningful for an actual join (serverSession + sessionState present)
    // — a freshly host-started session has nothing to hydrate FROM, and
    // instance/handler are already fully ready at this point (avatars,
    // spatial UI and tool manager are all wired up above).
    if (serverSession && sessionState) {
      this._hydrateSessionState(instance, sessionState);
    }

    // Emit event
    this._emit('explorationStarted', { session, instanceId });

    log.info('VR exploration started', { sessionId: session.id });

    return session;
  }

  /**
   * Phase C late-joiner hydration. The live Y.js visualization/camera
   * observers (yjsObservers.js) are delta-only — installed via
   * .observeDeep()/.observe(), they only ever fire on a CHANGE — so anything
   * written to Y.js before this client's observer attached is otherwise
   * invisible to it. Without this, a peer joining an in-progress VR session
   * sees the host's dataset but none of the host's opacity/representation/
   * colormap/clip/threshold/... state until the host's next live edit.
   *
   * Ordering is deliberate and matters:
   *  1. The server snapshot (`state`, from buildSessionState() on the join
   *     response) is authoritative and carries `revision` — applied FIRST,
   *     directly through the handler's rich applySharedState path (the same
   *     path every Y.js visualization/camera update ultimately flows
   *     through — see workspaceManager._handleYjsVisualizationUpdate /
   *     _handleYjsCameraUpdate) — so there remains exactly one code path
   *     that interprets a visualization/camera patch.
   *  2. The Y.js replay runs SECOND. It may hold in-flight edits the server
   *     hasn't persisted yet, so it must not be skipped — but a Y.js entry
   *     older than the snapshot must not clobber it either. `minRevision:
   *     state.revision` enforces that (see syncVisualizationToYjs's
   *     `revision` stamp and yjsObservers.js's replayVisualizationState /
   *     _emitVisualizationEntry for exactly how a stale-vs-unstamped entry
   *     is told apart).
   *
   * @param {object} instance - workspaceManager instance (handler + instanceData)
   * @param {object|null} state - buildSessionState() shape from the join response
   * @private
   */
  _hydrateSessionState(instance, state) {
    if (!state) return;

    try {
      const snapshotPatch = {};
      if (state.visualization) snapshotPatch.visualization = state.visualization;
      if (state.camera) snapshotPatch.camera = state.camera;
      if (Object.keys(snapshotPatch).length > 0 && typeof instance.handler?.applySharedState === 'function') {
        instance.handler.applySharedState(instance.instanceData, snapshotPatch, 'server-snapshot');
      }
    } catch (err) {
      log.warn('Failed to apply server visualization snapshot during VR join hydration:', err?.message || err);
    }

    try {
      const counts = hydrateFromYjs({ minRevision: state.revision ?? null });
      log.debug('VR session state hydrated from Y.js', { snapshotRevision: state.revision, replayed: counts });
    } catch (err) {
      log.warn('Failed to replay Y.js state during VR join hydration:', err?.message || err);
    }
  }

  /**
   * Resolve a view configuration to its live instance and start VR
   * exploration on it. This is the single entry point every "Enter VR" UI
   * surface (launch modal, canvas footer toggle, header button, voice
   * command) should call — no caller should ever talk to vrManager.enterVR()
   * or navigator.xr.requestSession() directly.
   *
   * @param {string} viewConfigId
   * @param {Object} [config] - see startExploration
   * @returns {Promise<VRExplorationSession>}
   */
  async startForView(viewConfigId, config = {}) {
    const instance = workspaceManager.getInstanceByViewConfigId(viewConfigId);
    if (!instance) {
      throw new Error('No open view found for VR exploration');
    }
    if (!instance.instanceData?.hasData) {
      throw new Error('Load a dataset to explore in VR');
    }
    const handler = instance.handler;
    if (!handler?.supportsVRExploration?.()) {
      throw new Error('This view type does not support VR exploration');
    }

    return this.startExploration(instance.instanceId, config);
  }

  /**
   * Issue 7 (VR rendering architecture, Round 2): ask the server whether this
   * dataset's LOD/octree/bounds preprocessing (vrPreprocessing.js) is done
   * before letting a fresh "Enter VR" proceed on a huge unprocessed dataset
   * with no warning. See docs/vr-rendering-architecture.md for the boundary
   * this enforces — the server prepares data, it never renders VR frames, so
   * a dataset that needs prep and hasn't received it is a real blocker, not
   * a cosmetic one.
   *
   * Three cases skip the check entirely and resolve to `null` (proceed, no
   * server round-trip):
   *  - `config.serverSession` is set — this is a JOIN, not a fresh entry. The
   *    host already passed (or bypassed) this gate; blocking the joiner here
   *    would break joining a dataset the host is already inside.
   *  - `config.skipPreprocessingCheck` is true — the user already saw a
   *    refusal once and chose "Enter anyway" (VRLaunchModal.jsx).
   *  - the dataset id is missing or not a UUID (builtin/demo datasets, e.g.
   *    "builtin-lungs", have no row to check) — mirrors the server's own
   *    `asUuidOrNull` short-circuit on GET /vr/preprocessing/:datasetId/ready
   *    (server/src/routes/vr.js), so a bundled demo dataset never blocks VR
   *    entry on either side of the wire.
   *
   * Fails OPEN on any network/parse error from the readiness fetch itself —
   * deliberately the OPPOSITE of the Phase D manipulation lease's fail-CLOSED
   * posture (see VRManipulationLock.js / the leaseGate tests). A stale/failed
   * readiness check only costs frame rate on a possibly-unprocessed dataset;
   * a stale/failed lease check risks silent data corruption between peers.
   * Different risk, deliberately different default.
   *
   * @param {object} instance - workspaceManager instance (see startExploration)
   * @param {object} config - the same config startExploration receives
   * @returns {Promise<{ready:boolean, required:boolean, status:string, progress:number, estimatedTime:number}|null>}
   *   null when the check was skipped (proceed silently).
   * @private
   */
  async _checkVRPreprocessingReadiness(instance, config) {
    if (config?.serverSession || config?.skipPreprocessingCheck) {
      return null;
    }

    const datasetId = instance?.instanceData?.dataset?.id;
    if (!isValidDatasetUUID(datasetId)) {
      return null;
    }

    let readiness;
    try {
      readiness = await apiClient.get(`/vr/preprocessing/${datasetId}/ready`);
    } catch (err) {
      log.warn(`VR preprocessing readiness check failed for dataset ${datasetId} — proceeding (fail-open): ${err?.message}`, err);
      return null;
    }

    if (readiness && readiness.required === true && readiness.ready === false) {
      const progress = Number.isFinite(readiness.progress) ? readiness.progress : 0;
      const minutes = Math.ceil((Number(readiness.estimatedTime) || 0) / 60);
      // `.code` lets a caller (VRLaunchModal's "Enter anyway" affordance)
      // distinguish this specific, bypassable refusal from any other
      // startExploration failure without parsing the message string.
      throw Object.assign(
        new Error(
          `VR preprocessing for this dataset is ${readiness.status} (${progress}%). Large datasets need LOD/octree generation before VR — this usually takes about ${minutes} min. Start it from the dataset panel, or retry once it completes.`
        ),
        { code: 'vr-preprocessing-required' }
      );
    }

    return readiness || null;
  }

  /**
   * Resolve the key this instance's VR exploration converges on in the
   * shared `vr-sessions` registry (yVRSessions).
   *
   * WHY dataset id, not view id: every client that opens a dataset mints its
   * OWN ViewConfiguration via createView()/POST /views, so two headsets
   * looking at the SAME dataset in the SAME room hold two different, both
   * individually valid, viewConfigIds. Keying convergence on viewConfigId
   * (the old behaviour) meant each headset looked up — and claimed — a
   * DIFFERENT registry slot; neither could ever observe the other's claim,
   * so avatars/poses were permanently split across two sessions with no way
   * to recover. yVRSessions is already room-scoped (see yjsSetup.js), so
   * "same datasetId" is exactly "same dataset, same room" — the actual
   * semantics a shared VR exploration needs.
   *
   * Falls back to viewConfigId when there is no dataset id (e.g. a handler
   * that hasn't attached dataset metadata to the instance yet); returns
   * undefined when neither is available so callers preserve the existing
   * "no key, do nothing" behaviour instead of claiming/watching garbage.
   *
   * Delegates to @Core/instances/viewSyncKey.js — the visualization and camera
   * channels converge on the same key, and they must not be allowed to drift
   * apart from session convergence. Only the empty case differs: this returns
   * undefined where the shared helper returns null.
   *
   * @param {object} instance - workspaceManager instance (see startExploration)
   * @returns {string|undefined}
   * @private
   */
  _resolveSessionKey(instance) {
    return resolveViewSyncKey(instance) || undefined;
  }

  /**
   * @private
   * sessionManager.getRoomId() throws when the session hasn't been
   * initialized yet (see sessionManager.js), unlike getProjectId() which
   * falls back to a default. Mirrors serverSync.js's _safeRoomId() — turns
   * "not ready yet" into null instead of an uncaught throw out of callers
   * like _tryRegisterSession that run well before initialization is
   * guaranteed.
   * @returns {string|null}
   */
  _safeRoomId() {
    try {
      return sessionManager.getRoomId();
    } catch {
      return null;
    }
  }

  /**
   * Register a locally started session with the server, bounded by a short
   * timeout so a slow network never delays VR entry (WebXR requestSession
   * must run while user activation is still fresh). The server generates
   * the canonical id, which every client's Y.js participant map is keyed by
   * — so this must resolve before VRParticipantSync is constructed.
   *
   * @param {VRExplorationSession} session
   * @param {number} [timeoutMs]
   * @param {string} [sessionKey] - _resolveSessionKey()'s result for this
   *   view (Issue 6) — sent as datasetSyncKey so the server can enforce one
   *   active session per (room, dataset). Deliberately a 3rd POSITIONAL
   *   param, not folded into an options object: several existing tests call
   *   this positionally (session, timeoutMs) and would break otherwise.
   * @returns {Promise<object|null>} Server session row, or null (offline/slow).
   *   May carry `adopted: true` — see startExploration's Path 3 for the
   *   load-bearing handling that requires.
   * @private
   */
  async _tryRegisterSession(session, timeoutMs = 1500, sessionKey) {
    // The server requires every VR session to belong to a room now
    // (resolveRoomAccess() in server/src/routes/vr.js 400s on missing-room)
    // — and a roomless client has nothing to converge on anyway, since
    // yjsSetup.js binds the ydoc (and this session's participant/manipulation
    // maps) to sessionManager.getRoomId(). getRoomId() throws when the
    // session hasn't finished initializing yet (see sessionManager.js);
    // resolve it defensively via the same pattern serverSync.js's
    // _safeRoomId() uses, and skip the POST entirely rather than firing a
    // request that is guaranteed to 400 and just burns this method's short
    // registration timeout budget. The existing local-id fallback below
    // (the timeout/catch paths) already handles "no server session" fine.
    const roomId = this._safeRoomId();
    if (!roomId) {
      log.warn('VR session registration skipped — no room resolved yet (continuing locally)');
      return null;
    }

    const post = apiClient
      .post('/vr/sessions', {
        viewConfigurationId: session.viewConfigurationId,
        datasetId: session.datasetId,
        projectId: session.projectId,
        roomId,
        explorationMode: session.explorationMode,
        vrScale: session.vrScale,
        allowJoin: session.allowJoin,
        allowDesktopParticipants: session.allowDesktopParticipants,
        allowDesktopControl: session.allowDesktopControl,
        deviceId: getDeviceId(),
        // Stable, client-generated collaboration id (session.id, minted at
        // construction — see startExploration). Recorded on the row
        // separately from its own server-generated PK so a late response
        // can always be reconciled unambiguously. NOT the dataset identity
        // (see datasetSyncKey below) — this is per-ATTEMPT, minted fresh
        // every VR entry, and 023_vr_session_lifecycle.sql's header
        // documents the correction to 021's comment that once conflated the
        // two.
        clientSessionKey: session.id,
        // Per-DATASET identity (Issue 6) — _resolveSessionKey()'s result
        // (resolveViewSyncKey: dataset id first, viewConfigId fallback).
        // Drives the server's ux_vr_sessions_room_dataset_active — one
        // active session per (room, dataset).
        datasetSyncKey: sessionKey || null,
      })
      .catch((err) => {
        log.warn('VR session server registration failed (continuing locally):', err.message);
        return null;
      });

    const TIMED_OUT = Symbol('vr-registration-timeout');
    const timeout = new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs));
    const raceResult = await Promise.race([post, timeout]);

    if (raceResult !== TIMED_OUT) {
      if (raceResult?.id) {
        log.debug(`VR session registered on server as ${raceResult.id}`);
        return raceResult;
      }
      return null;
    }

    // Timeout won. `post` is still running — do NOT drop it (that was the
    // bug this fixes): reconcile against whatever it eventually resolves to,
    // once _activeSession/sub-managers exist. Attaching this only in the
    // timeout branch (rather than unconditionally on `post`) matters: a fast
    // response resolves `post` before startExploration has set
    // `_activeSession = session` (that happens well after this method
    // returns), so reconciling unconditionally would see "not the active
    // session yet" on every normal fast registration and delete the row it
    // just created.
    log.warn('VR session registration timed out; continuing with local id (reconciled if/when it completes)');
    post.then((serverRow) => this._reconcileLateRegistration(session, serverRow));
    return null;
  }

  /**
   * Runs when a registration POST from _tryRegisterSession resolves AFTER
   * its 1.5s race already timed out. If we're still on the local id it
   * raced against, adopt the server's canonical id now — mirroring
   * _watchVRSessionConvergence's rekey sequence exactly (see its comment for
   * why order matters: session.id first, then sub-managers, so nothing reads
   * a stale id mid-rekey). If we've since left, or a Y.js convergence race
   * already re-keyed us onto a different session, this row is unreachable
   * via Y.js and would otherwise sit orphaned in 'preparing' status forever
   * — end it instead.
   *
   * @param {VRExplorationSession} session
   * @param {object|null} serverRow
   * @private
   */
  _reconcileLateRegistration(session, serverRow) {
    if (!serverRow?.id || session.id === serverRow.id) return;

    const stillUsingLocalId =
      this._activeSession === session && String(session.id).startsWith('vrsession_');

    if (!stillUsingLocalId) {
      // Issue 6: never delete an ADOPTED row here — if serverRow.adopted is
      // true, serverRow.id is the WINNER's row (we lost the create race),
      // not one we created. Deleting it would end the real host's session
      // out from under them.
      if (!serverRow.adopted) {
        apiClient
          .delete(`/vr/sessions/${serverRow.id}`)
          .catch((err) => log.debug('Failed to clean up orphaned VR session row:', err.message));
      }
      return;
    }

    log.info(`VR session registration completed late — adopting server id ${serverRow.id}`);
    session.id = serverRow.id;
    this._leaseRequired = isServerSessionId(serverRow.id);
    this._participantSync?.rekey(serverRow.id);
    this._controlManager?.rekey(serverRow.id);
    this._manipulationLock?.rekey(serverRow.id);
    vrAvatarSystem.rekey?.(serverRow.id);

    if (serverRow.adopted) {
      // Same load-bearing branch as startExploration's Path 3 (Issue 6): a
      // late-arriving response can ALSO report we lost the create race —
      // adopt the winner's identity instead of leaving OUR OWN id (written
      // by this manager's earlier local claimVRSession call, back when
      // registration was still in flight) stamped on session.ownerUserId.
      // Skipping the claimVRSession call below is deliberate, same reason as
      // Path 3's: writing ourselves as hostUserId for a session the server
      // says someone else owns re-introduces the two-hosts bug through the
      // registry.
      session.ownerUserId = resolveServerSessionOwnerId(serverRow) || session.ownerUserId;
      session.ownerUserName = resolveServerSessionOwnerName(serverRow) || session.ownerUserName;
      return;
    }

    // We successfully registered a row of our own with the server (not an
    // adoption) — remember its id for the fast-path orphan cleanup in
    // _watchVRSessionConvergence (see that method's rekey branch).
    this._registeredServerSessionId = serverRow.id;

    const sessionKey = this._resolveSessionKey(this._activeContext?.instance);
    if (sessionKey) {
      claimVRSession(sessionKey, {
        sessionId: serverRow.id,
        hostUserId: session.ownerUserId,
        hostUserName: session.ownerUserName,
        datasetId: session.datasetId,
        projectId: session.projectId,
      });
    }
  }

  /**
   * Watch the shared `vr-sessions` registry for the lifetime of this
   * session (not just a brief window after claiming — see history below),
   * handling two distinct cases as the record for `sessionKey` changes:
   *
   *  - Different `sessionId`: a claim-race resolution. Two clients can claim
   *    the registry slot "simultaneously" (see claimVRSession's docstring) —
   *    each wins its own synchronous local claim, but once the competing
   *    write propagates over the network, Y.js's last-writer-wins resolution
   *    can silently overwrite our entry with someone else's. If that
   *    happens, our sub-managers are still keyed by our own (losing) session
   *    id and would be invisible to the winner — so re-key onto the survivor
   *    the moment we see it.
   *
   *  - Same `sessionId`, but a different `hostUserId`: a host-promotion
   *    committed by _tickVRSessionRegistry (elsewhere, possibly by another
   *    client) after the previous host's registry record went stale. Every
   *    other client must learn the new host, not just the one that
   *    performed the promotion — update local state and notify listeners.
   *
   * Used to self-unsubscribe after a fixed window (the claim-race case is
   * usually resolved within seconds of session start), which meant no
   * client was listening for #2 at all once that window elapsed — host
   * promotions after the first few seconds of a session were visible only
   * to the client that performed them. Now stays attached for the session's
   * lifetime; torn down by leaveSession via _offVRSessionObserver.
   *
   * @param {string} sessionKey - see _resolveSessionKey()
   * @param {VRExplorationSession} session
   * @private
   */
  _watchVRSessionConvergence(sessionKey, session) {
    if (!sessionKey) return;

    // A previous call (shouldn't normally overlap, but startExploration can
    // in principle run again) must not leak.
    this._offVRSessionObserver?.();

    const observer = (event) => {
      if (!event.changes.keys.has(sessionKey)) return;

      const record = getVRSessionForView(sessionKey);
      if (!record) return;

      if (record.sessionId !== session.id) {
        log.info(`VR session claim race resolved against us — re-keying ${session.id} -> ${record.sessionId}`);

        // Captured BEFORE session.id is mutated below — this is what "our own
        // now-unreachable row" means for the fast-path orphan cleanup further
        // down (Issue 6).
        const orphanId = session.id;
        const weRegisteredOrphan = orphanId === this._registeredServerSessionId;

        // ORDER MATTERS. Mutate the session FIRST: AvatarManager holds this same
        // object and reads `session.id` live (it used to cache a copy, which then
        // went stale here and made both headsets filter out each other's avatar
        // metadata). The three managers below take the id as an argument and so
        // don't care, but vrAvatarSystem.rekey re-broadcasts using the live value
        // and would announce the LOSING id if it ran before this line.
        session.id = record.sessionId;
        session.ownerUserId = record.hostUserId;
        session.ownerUserName = record.hostUserName;
        this._leaseRequired = isServerSessionId(record.sessionId);

        this._participantSync?.rekey(record.sessionId);
        this._controlManager?.rekey(record.sessionId);
        this._manipulationLock?.rekey(record.sessionId);
        vrAvatarSystem.rekey?.(record.sessionId);

        // Fast-path orphan cleanup (Issue 6): we lost the create-race and our
        // own now-unreachable server row would otherwise sit orphaned in
        // 'preparing'/'active' until lazy-expiry reaping catches it, minutes
        // later. Gated strictly on "did WE register this EXACT row"
        // (weRegisteredOrphan) rather than just isServerSessionId(orphanId)
        // — on the JOIN path (config.serverSession in startExploration),
        // orphanId would be the REAL HOST's canonical session id, and
        // deleting it would end their session out from under them.
        if (weRegisteredOrphan) {
          this._registeredServerSessionId = null;
          // Promise.resolve()-wrapped for the same reason as
          // _sendServerSessionHeartbeat: this fires from inside a Y.js
          // observer callback, not a context with its own error boundary —
          // it must never throw synchronously regardless of what
          // apiClient.delete returns.
          try {
            Promise.resolve(apiClient.delete(`/vr/sessions/${orphanId}`)).catch((err) =>
              log.debug('Failed to clean up orphaned VR session row:', err?.message)
            );
          } catch (err) {
            log.debug('Failed to clean up orphaned VR session row:', err?.message);
          }
        }

        // The ids every peer must agree on just changed — re-dump them.
        this._logCollaborationDiagnostics('session-rekey');
        return;
      }

      if (record.hostUserId !== session.ownerUserId) {
        log.info(`VR session host changed: ${session.ownerUserId} -> ${record.hostUserId}`);

        session.ownerUserId = record.hostUserId;
        session.ownerUserName = record.hostUserName;

        window.dispatchEvent(new CustomEvent('cia:vr-session-host-changed', {
          detail: { sessionId: session.id, hostUserId: record.hostUserId, hostUserName: record.hostUserName }
        }));
      }
    };

    yVRSessions.observe(observer);
    this._offVRSessionObserver = () => yVRSessions.unobserve(observer);
  }

  /**
   * Session-liveness heartbeat (Issue 6) — POST /vr/sessions/:id/heartbeat.
   * Distinct from the manipulation LEASE's own heartbeat
   * (VRManipulationLock.heartbeat, which shares the same 1Hz frame-loop tick
   * but has its own internal floor) — this one feeds
   * vr_exploration_sessions.last_heartbeat_at (lazy-expiry reaping) and, on
   * the owner device's first call, performs the session's ONE
   * 'preparing' -> 'active' transition server-side.
   *
   * Fire-and-forget: must never throw into the frame loop (see the frame
   * loop's _safeFrameStep wrapper) or block startExploration. A no-op for a
   * local `vrsession_*` id — nothing server-side to heartbeat.
   *
   * Wrapped in Promise.resolve()/try-catch rather than assuming
   * apiClient.post always returns a thenable: this is called synchronously
   * from startExploration (right after session.start(), before any VR
   * frame exists), so a test double or a genuinely synchronous rejection
   * here must not throw INTO startExploration itself.
   * @private
   */
  _sendServerSessionHeartbeat() {
    const session = this._activeSession;
    if (!session?.id || !isServerSessionId(session.id)) return;
    try {
      Promise.resolve(
        apiClient.post(`/vr/sessions/${session.id}/heartbeat`, { deviceId: getDeviceId() })
      ).catch((err) => log.debug('VR session heartbeat failed:', err?.message));
    } catch (err) {
      log.debug('VR session heartbeat failed:', err?.message);
    }
  }

  /**
   * Low-frequency (throttled to VR_SESSION_HEARTBEAT_MS by the caller in
   * _onFrame) housekeeping for the shared `vr-sessions` registry:
   *  - refresh our record's heartbeat so the stale sweep (VR_SESSION_STALE_MS)
   *    never evicts a session that is still live;
   *  - if the host's record has disappeared (clean release, or its heartbeat
   *    went stale), deterministically promote exactly one remaining client
   *    instead of running a voting protocol. Every remaining client runs this
   *    same computation; only the one that agrees it is the winner writes the
   *    claim.
   *
   * Winner selection uses the shared join-order Y.Array (see
   * VRParticipantSync.getJoinOrder()) — the first live participant to appear
   * in it — rather than each client's local `joinedAt`. `joinedAt` is a local
   * Date.now() stamped the moment each client first observes a peer, never
   * broadcast, so two clients can disagree on it under clock skew or packet
   * arrival order and elect different hosts. Y.Array insertion order is
   * CRDT-consistent across synced replicas, so this can't diverge. The old
   * `joinedAt` reduce is kept only as a defensive fallback for the case where
   * the join-order array hasn't yet populated for a live participant.
   *
   * Must key on the same value startExploration claimed/watched under (see
   * _resolveSessionKey) — otherwise this heartbeats/promotes against a
   * DIFFERENT registry slot than the one the session actually lives at,
   * which looks exactly like the record having gone stale (host-promotion
   * fires spuriously) even though nothing is actually wrong.
   *
   * @param {string|undefined} sessionKey - see _resolveSessionKey()
   * @param {VRExplorationSession|null} session
   * @private
   */
  _tickVRSessionRegistry(sessionKey, session) {
    if (!sessionKey || !session) return;

    heartbeatVRSession(sessionKey, getParticipantId());

    if (getVRSessionForView(sessionKey)) return; // host's slot is still live

    const vrParticipants = session.getVRParticipants?.() || [];
    if (!vrParticipants.length) return;

    const liveIds = new Set(vrParticipants.map(p => p.odUserId));
    const joinOrder = this._participantSync?.getJoinOrder?.() || [];
    const orderedWinnerId = joinOrder.find(record => liveIds.has(record.participantId))?.participantId;

    const fallbackWinnerId = vrParticipants.reduce((best, p) =>
      !best || p.joinedAt < best.joinedAt ? p : best,
      null
    )?.odUserId;

    const winnerId = orderedWinnerId ?? fallbackWinnerId;
    if (!winnerId || winnerId !== getParticipantId()) return; // not our turn

    const claimed = claimVRSession(sessionKey, {
      sessionId: session.id,
      hostUserId: getParticipantId(),
      hostUserName: getParticipantName(),
      datasetId: session.datasetId,
      projectId: session.projectId,
    });
    session.ownerUserId = claimed.hostUserId;
    session.ownerUserName = claimed.hostUserName;
    if (claimed.hostUserId === getParticipantId()) {
      log.info(`VR session host promoted: ${getParticipantId()} claimed ${sessionKey}`);
    }
  }

  /**
   * Resolve the local VTK instance a session/join response corresponds to,
   * in priority order (Phase B of the room-scoping/join-correctness plan):
   *
   *  1. Exact `view_configuration_id` match — the pre-existing behaviour,
   *     and still correct for a client that genuinely shares one
   *     ViewConfiguration with the host (a saved/linked view).
   *  2. `instanceMatchesViewUpdate()` against every locally open VTK
   *     instance, keyed on the join response's resolved dataset id. This is
   *     the case that actually matters for a peer: every client mints its
   *     OWN ViewConfiguration when it opens a dataset (see the big comment
   *     on _resolveSessionKey above), so step 1 can never match one by
   *     construction — only the dataset id is common between two headsets
   *     looking at the same data.
   *  3. Auto-load: register the dataset locally (if not already) and
   *     create+place a view for it via viewLifecycleService, reusing the
   *     EXACT pair workspaceManager._handleYjsActiveDatasetUpdate already
   *     uses for the equivalent "remote client switched datasets" case — no
   *     new load path. Needs `joinResponse.dataset`, so a call made before
   *     the join POST has resolved (see joinSession's pre-check) can never
   *     succeed past step 2 and bails out distinctly rather than pretending
   *     "not found".
   *
   * Deliberately does NOT enter VR when it loads something (`loaded: true`
   * on the return) — fetchDatasetById/createAndPlaceView spans many frames,
   * which burns the WebXR user-activation gesture that triggered the join in
   * the first place, so a requestSession() run immediately after would
   * reject. The caller surfaces this as 'ready-press-enter' and waits for a
   * second explicit gesture.
   *
   * @param {Object} sessionRecord - server session row (view_configuration_id, dataset_id, ...)
   * @param {Object|null} joinResponse - POST /sessions/:id/join response body
   *   (dataset, viewConfigurationId), or null to resolve steps 1-2 only
   *   without touching the network.
   * @returns {Promise<{instance: Object|null, loaded: boolean, reason?: string}>}
   * @private
   */
  async _resolveOrLoadInstanceForSession(sessionRecord, joinResponse) {
    const viewConfigId = joinResponse?.viewConfigurationId || sessionRecord?.view_configuration_id || null;

    if (viewConfigId) {
      const exact = workspaceManager.getInstanceByViewConfigId(viewConfigId);
      if (exact) return { instance: exact, loaded: false };
    }

    const syncKey = joinResponse?.dataset?.id || sessionRecord?.dataset_id || null;
    if (viewConfigId || syncKey) {
      for (const candidate of workspaceManager.getInstancesByType('vtk')) {
        if (instanceMatchesViewUpdate(candidate, viewConfigId, syncKey)) {
          return { instance: candidate, loaded: false };
        }
      }
    }

    if (!joinResponse) {
      return { instance: null, loaded: false, reason: 'awaiting-join-response' };
    }

    const dataset = joinResponse.dataset;
    if (!dataset?.id) {
      return { instance: null, loaded: false, reason: 'no-dataset' };
    }

    const dm = getDatasetManager();
    if (!dm) {
      return { instance: null, loaded: false, reason: 'dataset-manager-unavailable' };
    }

    let datasetId = dataset.id;
    try {
      if (!dm.getDataset(datasetId)) {
        if (dataset.kind === 'builtin') {
          // loadBuiltInDatasets() registers the whole manifest for every
          // client at boot, so getDataset() missing it here is the unusual
          // case — recover the dataset's stable server-side UUID
          // (migrations/020_bundled_dataset_ids.sql) and load it the same
          // way an uploaded dataset would be. addBuiltInDataset() needs a
          // manifest `path` this join response doesn't carry, so it is not
          // an option here — same reasoning as _getPersistenceScope above.
          const resolvedId = await resolveBuiltInDatasetId(datasetId);
          if (resolvedId) {
            await dm.fetchDatasetById(resolvedId);
            datasetId = resolvedId;
          }
        } else {
          await dm.fetchDatasetById(datasetId);
        }
      }
    } catch (err) {
      log.warn(`Auto-load: failed to register dataset ${datasetId} for VR join:`, err.message);
      return { instance: null, loaded: false, reason: 'dataset-load-failed' };
    }

    if (!dm.getDataset(datasetId)) {
      return { instance: null, loaded: false, reason: 'dataset-load-failed' };
    }

    try {
      // Lazy import, not a module-scope one: ViewLifecycleService.js pulls in
      // ViewGroupManager.js and a wide manager dependency chain that most of
      // this file's existing tests never touch and don't mock (they mock
      // @Utils/logger.js partially, which that chain needs more of). Loading
      // it only when auto-load actually runs — rather than for every test
      // that merely imports this file — keeps those unaffected. vi.mock()
      // intercepts dynamic imports the same as static ones, so
      // VRExplorationManager.joinResolve.test.js's mock of this module still
      // applies here.
      const { viewLifecycleService } = await import('@Services/ViewLifecycleService.js');
      const { view } = await viewLifecycleService.createAndPlaceView(datasetId);
      const instance = workspaceManager.getInstanceByViewConfigId(view.id);
      if (!instance) {
        return { instance: null, loaded: false, reason: 'view-not-placed' };
      }
      // Hydrate now, not just on VR entry: auto-load deliberately does NOT
      // enter VR here (burns the WebXR activation gesture — see this
      // method's docstring), so the caller waits for a second explicit
      // "Enter VR" press. Without hydrating here, the freshly-loaded
      // instance would sit on desktop showing only camera/opacity/
      // representation defaults until that second press reaches
      // startExploration()'s own hydration call.
      this._hydrateSessionState(instance, joinResponse.state);
      return { instance, loaded: true };
    } catch (err) {
      log.warn(`Auto-load: failed to create/place a view for dataset ${datasetId}:`, err.message);
      return { instance: null, loaded: false, reason: 'view-create-failed' };
    }
  }

  /**
   * Join an existing VR exploration session, given the already-fetched
   * session record (callers listing sessions — e.g. VRExploreButton's
   * session popover — already have this row from their GET /vr/sessions;
   * avoid a redundant refetch here). Fields are the raw
   * vr_exploration_sessions row shape (snake_case) returned by the server.
   *
   * Error handling (Phase B — replaces a blanket try/catch that used to
   * swallow every failure, 401/403/404 included, and left the join POST
   * unawaited AND unhandled whenever the 1.5s timeout won):
   *  - A 4xx response is authoritative — the server rejected the join for a
   *    specific, actionable reason (wrong room, session ended, joining
   *    disabled, ...). Fails hard and returns immediately; no fallthrough.
   *  - A network error / 5xx / timeout-with-no-response degrades rather
   *    than fails, but ONLY continues into VR entry if step 1 or 2 of
   *    _resolveOrLoadInstanceForSession already resolved an instance
   *    locally — auto-load is impossible without the join response's
   *    dataset descriptor, so there is nothing to fall back to.
   *  - The 1.5s race against the join POST — needed so a slow network never
   *    delays VR entry while WebXR user-activation is still fresh — is kept
   *    ONLY for that same already-resolvable case. When auto-load may be
   *    needed, the POST is awaited in full. The raced promise always gets a
   *    .catch so a late rejection can never become an unhandled rejection.
   *
   * @param {Object} sessionRecord - server session row (id, view_configuration_id,
   *   owner_user_name, default_exploration_mode, default_vr_scale, ...)
   * @param {string} mode - Participation mode (PARTICIPATION_MODE)
   * @returns {Promise<{joined: boolean, vrEntered: boolean, session?: object,
   *   reason?: string, error?: string, detail?: object, instanceId?: string}>}
   */
  async joinSession(sessionRecord, mode = PARTICIPATION_MODE.DESKTOP_OBSERVER) {
    const sessionId = sessionRecord?.id;
    if (!sessionId) {
      return { joined: false, vrEntered: false, reason: 'session-not-found' };
    }
    log.info('Joining VR session...', { sessionId, mode });

    const isVRMode = mode === PARTICIPATION_MODE.VR_EXPLORER;

    // Cheap, network-free check of steps 1-2 only (joinResponse is null —
    // see _resolveOrLoadInstanceForSession) — this is what decides whether
    // the join POST below can be raced against the WebXR activation budget
    // or must be awaited in full.
    const localResolution = isVRMode
      ? await this._resolveOrLoadInstanceForSession(sessionRecord, null)
      : null;
    const hasLocalInstance = !!localResolution?.instance;

    let joinResponse = null;
    let joinError = null;
    const body = { mode, deviceId: getDeviceId(), roomId: this._safeRoomId() };

    if (!isVRMode || hasLocalInstance) {
      const joinPost = apiClient
        .post(`/vr/sessions/${sessionId}/join`, body)
        .then((response) => { joinResponse = response; return response; })
        .catch((err) => { joinError = err; return null; });
      const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500));
      const raceResult = await Promise.race([joinPost, timeout]);
      if (raceResult === 'timeout') {
        log.debug(`VR join notification for ${sessionId} still in flight past the 1.5s budget — continuing locally`);
      }
    } else {
      // Nothing resolvable locally — auto-load needs the join response's
      // dataset descriptor, so there is no fast path here.
      try {
        joinResponse = await apiClient.post(`/vr/sessions/${sessionId}/join`, body);
      } catch (err) {
        joinError = err;
      }
    }

    if (joinError) {
      if (joinError.status >= 400 && joinError.status < 500) {
        log.warn(`VR session join rejected (${joinError.status}):`, joinError.message);
        return {
          joined: false,
          vrEntered: false,
          error: joinError.details?.error || joinError.message,
          detail: joinError.details,
        };
      }
      // Network error / 5xx. Only VR entry needs an instance to fall back
      // to — desktop modes have nothing left to do here regardless, so keep
      // their pre-existing "continue, participant state reconciles via
      // Y.js/WS once connectivity returns" behaviour.
      if (isVRMode && !hasLocalInstance) {
        log.warn('VR session join failed and no local instance to fall back on:', joinError.message);
        return { joined: false, vrEntered: false, reason: 'join-unavailable' };
      }
      log.warn('VR session join notification failed (continuing degraded):', joinError.message);
    }

    // Desktop observers/participants are done: participant state flows via Y.js/WS
    if (!isVRMode) {
      this._emit('sessionJoined', { sessionId, mode });
      return { joined: true, vrEntered: false, session: sessionRecord, degraded: !!joinError };
    }

    // Re-resolve now that a join response may be available — a no-op read
    // of the already-found instance when hasLocalInstance, otherwise this
    // is where step 3 (auto-load) actually runs.
    const resolution = hasLocalInstance
      ? localResolution
      : await this._resolveOrLoadInstanceForSession(sessionRecord, joinResponse);

    if (!resolution.instance) {
      log.warn(`Cannot enter VR for session ${sessionId}: no instance resolved (${resolution.reason})`);
      this._emit('sessionJoined', { sessionId, mode, vrEntered: false });
      return {
        joined: true,
        vrEntered: false,
        session: sessionRecord,
        reason: resolution.reason || 'view-not-open',
      };
    }

    if (resolution.loaded) {
      // See _resolveOrLoadInstanceForSession's docstring: entering VR here
      // would burn the activation gesture the auto-load itself just spent.
      this._emit('sessionJoined', { sessionId, mode, vrEntered: false, instanceId: resolution.instance.instanceId });
      return {
        joined: true,
        vrEntered: false,
        session: sessionRecord,
        reason: 'ready-press-enter',
        instanceId: resolution.instance.instanceId,
      };
    }

    // Enter VR against the shared session id. `state` (Phase C
    // buildSessionState() snapshot) rides along so startExploration's own
    // hydration step (_hydrateSessionState) needs no second round trip —
    // for the auto-load path this is a no-op re-apply, since
    // _resolveOrLoadInstanceForSession already hydrated once when it loaded
    // the instance; Y.js entries are idempotent to replay.
    await this.startExploration(resolution.instance.instanceId, {
      serverSession: sessionRecord,
      participationMode: mode,
      explorationMode: sessionRecord.default_exploration_mode,
      vrScale: Number(sessionRecord.default_vr_scale) || 1.0,
      state: joinResponse?.state || null,
    });

    this._emit('sessionJoined', { sessionId, mode, vrEntered: true });
    return { joined: true, vrEntered: true, session: sessionRecord };
  }

  /**
   * Leave the current session
   */
  /**
   * Run one teardown step, logging and swallowing any failure instead of
   * letting it abort the rest of leaveSession()'s cleanup sequence. Without
   * this, a single sub-manager throwing (e.g. vrSpatialUI.dispose()) would
   * skip every step after it — critically vrEnvironment.dispose() — leaving
   * floor/wall/marker/menu actors permanently stuck in the instance's
   * long-lived renderer (VR "exits" with no visible error, but the next
   * "Enter VR" then sizes the dataset off contaminated bounds). Each step is
   * independently guarded so one failure can never take out the others.
   * @private
   */
  async _safeCleanupStep(label, fn) {
    try {
      await fn();
    } catch (e) {
      log.error(`VR leaveSession: ${label} failed`, e);
    }
  }

  /**
   * Run one VR sub-system init step, logging and swallowing any failure
   * instead of letting it abort the rest of startExploration()'s setup. By
   * the time these run, session.start() and the XR frame loop are already
   * live — the user is fully immersed — so without this, a single sub-system
   * throwing (e.g. vrSpatialUI.initialize() building ~25 button actors) would
   * silently reject the whole startExploration() promise. The caller only
   * sees a desktop toast, invisible from inside the headset, and everything
   * after the failed step (critically the spatial menu, since it initializes
   * last) never gets a chance to run. Each step is independently guarded so
   * one failure can never take out the others, and the error is logged with
   * enough detail (message + stack) to diagnose from a headset's remote
   * console (chrome://inspect for Quest, Safari Develop menu for Vision Pro).
   * @private
   */
  _safeInitStep(label, fn) {
    try {
      fn();
    } catch (e) {
      log.error(`VR startExploration: ${label} failed — ${e?.message}`, e?.stack || e);
    }
  }

  /**
   * Per-frame sibling of _safeInitStep, for steps whose failure must not cost
   * this frame's presence broadcast.
   *
   * WHY: _onFrame wrapped ~20 calls in ONE try. The participant pose broadcast
   * sits about two-thirds of the way down, behind navigation, tools, follow and
   * isolation — so a throw in any of those jumped straight to the outer catch
   * and skipped the broadcast, the avatar update and the handler's draw. The
   * cause is per-frame state, so it then repeated every frame: the peer's
   * avatar froze permanently while this headset carried on rendering a
   * perfectly healthy-looking session.
   *
   * Errors are deduped per LABEL rather than globally, so a persistent throw in
   * navigation still leaves a later throw in tools visible instead of masking
   * it — the previous single-signature dedupe hid exactly that case.
   *
   * @param {string} label - step name, shown in the log
   * @param {Function} fn
   * @returns {*} fn's return value, or undefined if it threw
   * @private
   */
  _safeFrameStep(label, fn) {
    try {
      return fn();
    } catch (e) {
      const signature = `${label}:${e?.message || String(e)}`;
      if (!this._frameErrorSignatures.has(signature)) {
        this._frameErrorSignatures.add(signature);
        log.error(
          `VR frame: ${label} failed — ${e?.message} (further identical errors suppressed)`,
          e?.stack || e
        );
      }
      return undefined;
    }
  }

  /**
   * Clear per-frame error dedupe state. Called on session start and teardown:
   * the signatures are what suppress repeat logs, so carrying them across
   * sessions means a fault that recurs in the NEXT session logs nothing at all.
   * @private
   */
  _resetFrameErrorState() {
    this._frameErrorSignatures.clear();
    this._lastFrameErrorSignature = null;
  }

  async leaveSession() {
    // Guard against re-entrancy: leaveSession() -> vrManager.exitVR() ->
    // XRSession "end" event -> our sessionEnded handler -> leaveSession()
    // again. Also covers the reverse: the headset/browser ends the session
    // first (user removed headset), which fires sessionEnded and calls us
    // here without anyone having called leaveSession() directly.
    if (!this._activeSession || this._leaving) return;
    this._leaving = true;

    const session = this._activeSession;
    // Captured before _activeContext is nulled out in `finally` — the
    // registry release below needs it after every other cleanup step runs.
    // Must match the key startExploration claimed under (see
    // _resolveSessionKey), or this releases the wrong registry slot entirely.
    const sessionKey = this._resolveSessionKey(this._activeContext?.instance);

    log.info('Leaving VR session...', { sessionId: session.id });

    try {
      // Unsubscribe from VRManager events first so no further frame/end
      // callbacks touch a partially torn-down context.
      this._offFrame?.();
      this._offFrame = null;
      this._offSessionEnded?.();
      this._offSessionEnded = null;

      // Stop watching for a delayed claim-race resolution (see
      // _watchVRSessionConvergence) — nothing left to re-key onto once we're
      // leaving.
      await this._safeCleanupStep('vrSessionObserver.cleanup', () => {
        this._offVRSessionObserver?.();
        this._offVRSessionObserver = null;
      });

      // Release the shared registry slot if WE are the host, so a remaining
      // participant's host-promotion check (_tickVRSessionRegistry) sees it
      // vacated instead of waiting out VR_SESSION_STALE_MS. No-op for a
      // non-host (releaseVRSession itself also guards this, but checking
      // here avoids a pointless Y.js write from every leaving participant).
      await this._safeCleanupStep('vrSessionRegistry.release', () => {
        if (sessionKey && isSelfIdentity(session.ownerUserId)) {
          releaseVRSession(sessionKey, session.ownerUserId);
        }
      });

      // Clean up sub-managers — each step independently guarded (see
      // _safeCleanupStep) so a failure in one can never skip the rest,
      // especially vrEnvironment.dispose() (must run before the handler's
      // final desktop render, and before the next VR entry computes bounds).
      await this._safeCleanupStep('participantSync.stop', () => this._participantSync?.stop());
      await this._safeCleanupStep('vrCursorSync.clearCursor', () => vrCursorSync.clearCursor());
      await this._safeCleanupStep('vrMultiViewGrid.disable', () => vrMultiViewGrid.disable());
      await this._safeCleanupStep('vrSpatialUI.dispose', () => vrSpatialUI.dispose());
      await this._safeCleanupStep('vrAvatarSystem.dispose', () => vrAvatarSystem.dispose());
      await this._safeCleanupStep('vrEnvironment.dispose', () => vrEnvironment.dispose());
      await this._safeCleanupStep('toolManager.cleanup', () => this._toolManager?.cleanup());
      await this._safeCleanupStep('snapshotManager.cleanup', () => this._snapshotManager?.cleanup());
      await this._safeCleanupStep('controlManager.cleanup', () => this._controlManager?.cleanup());
      await this._safeCleanupStep('manipulationLock.stop', () => {
        this._offManipulationLock?.();
        this._offManipulationLock = null;
        this._manipulationLock?.stop();
      });
      // Clear our "currently manipulating" flag on every desktop client, so a
      // VR user who exits mid-gesture doesn't stay lit forever.
      await this._safeCleanupStep('manipulatorSignal.clear', () => this._clearManipulationSignal());
      await this._safeCleanupStep('navigationController.cleanup', () => this._navigationController?.cleanup());

      // Exit VR exploration on handler
      await this._safeCleanupStep('handler.exitVRExploration', () => {
        if (this._activeContext?.handler && this._activeContext?.vrContext) {
          return this._activeContext.handler.exitVRExploration(this._activeContext.vrContext);
        }
        return undefined;
      });

      // End the XR session via VRManager (the sole session owner). Safe to
      // call even if the session already ended (e.g. we got here via the
      // sessionEnded event) — exitVR() no-ops when there's no active session.
      try {
        await vrManager.exitVR();
      } catch (e) {
        // Session may already be ended
      }

      // End session
      session.end();

      // Notify the server (non-fatal; only meaningful for server-registered ids)
      if (session.id && !String(session.id).startsWith('vrsession_')) {
        apiClient
          .post(`/vr/sessions/${session.id}/leave`, { deviceId: getDeviceId() })
          .catch((err) => log.warn('VR session leave notification failed:', err.message));
      }
    } finally {
      // Guaranteed to run even if something above threw unexpectedly outside
      // the individually-guarded steps — otherwise _leaving would stay true
      // forever and every future "Enter VR" attempt would silently no-op.
      this._activeSession = null;
      this._activeContext = null;
      this._isolationBackup = null;
      this._lastIsolationButtonState = false;
      this._lastMenuToggleButtonState = false;
      this._lastMenuYawOffset = 0;
      this._resetFrameErrorState();
      this._followTargetUserId = null;
      this._inputProfileDetected = false;
      // The cached hit belongs to the picker on the vrContext just disposed.
      this._lastPointerHit = null;
      // Defensive — the try block above already unsubscribes/releases these,
      // but guarantee a clean slate even if it threw before reaching them.
      this._offVRSessionObserver?.();
      this._offVRSessionObserver = null;
      this._lastVRSessionHeartbeat = 0;
      this._lastServerSessionHeartbeat = 0;
      this._registeredServerSessionId = null;
      // Drop any queued heavy work so it cannot run after exit (see
      // _deferHeavy/_drainDeferredWork) — the toggle's manager/feature state
      // it would have mutated may itself be torn down by the steps above.
      this._deferredWork = [];
      this._pendingWorkLabel = null;
      this._participantSync = null;
      this._toolManager = null;
      this._snapshotManager = null;
      this._controlManager = null;
      this._navigationController = null;
      this._offManipulationLock?.();
      this._offManipulationLock = null;
      this._manipulationLock = null;
      this._leaseRequired = false;
      this._gestureSnapshot = null;
      this._gestureOpId = null;
      this._transformGestureActive = false;
      this._clipGestureActive = false;
      this._throttledGestureActive = false;
      if (this._throttledGestureTimer) {
        clearTimeout(this._throttledGestureTimer);
        this._throttledGestureTimer = null;
      }
      this._vrNotice = null;

      // Clear the room-wide "in VR" flag set in startExploration.
      await this._safeCleanupStep('presence.clearVRPresence', () =>
        presenceSystem.setVRPresence({ inVR: false, vrSessionId: null, vrRole: null })
      );

      // Emit events
      this._emit('sessionLeft', { sessionId: session.id });

      window.dispatchEvent(new CustomEvent('cia:vr-session-ended', {
        detail: { sessionId: session.id }
      }));

      this._leaving = false;
    }
  }

  // ===========================================================================
  // PARTICIPANT MANAGEMENT
  // ===========================================================================

  getActiveSession() {
    return this._activeSession;
  }

  /** Display name of the dataset in the active session, for spatial UI status text. */
  getActiveDatasetName() {
    const dataset = this._activeContext?.instance?.instanceData?.dataset;
    return dataset?.filename || dataset?.name || null;
  }

  getMyParticipant() {
    return this._activeSession?.getParticipant(getParticipantId());
  }

  /**
   * Other participants in the active session (excluding self), for the
   * spatial UI's collaborator go-to/follow controls.
   * @returns {Array<import('@Core/data/models/VRExplorationSession.js').VRParticipant>}
   */
  getOtherParticipants() {
    const session = this._activeSession;
    if (!session) return [];
    const selfId = getParticipantId();
    return session.participants.filter((p) => p.odUserId !== selfId);
  }

  /**
   * The session's participants in DISPLAY PRECEDENCE order, decorated with
   * everything a roster surface (the in-VR people drawer, the desktop
   * VRSessionPanel) needs to render a row without querying four subsystems
   * itself.
   *
   * Order — deliberately NOT alphabetical or join order alone:
   *   1. the data-control holder (who can change what everyone sees)
   *   2. the session host (who can take it back)
   *   3. the other VR explorers, oldest `joinedAt` first (stable: Phase 5's
   *      upsertParticipant stopped `joinedAt` being reset by every pose packet,
   *      so this ordering no longer reshuffles itself frame to frame)
   *   4. desktop observers
   * Ties inside a band break on userId so the list never jitters.
   *
   * Every field is read from an EXISTING source: `session.participants` for
   * identity/mode/joinedAt, `_participantSync.getRemoteParticipants()` for
   * liveness, `_manipulationLock` for the token, `yManipulatorState` (the same
   * room-global channel `_signalManipulation` writes and the desktop awareness
   * UI already observes) for activity, and `_getParticipantDataPosition` for
   * distance.
   *
   * @returns {Array<{userId:string, userName:string, userColor:string,
   *   mode:string, isSelf:boolean, isHost:boolean, isHolder:boolean,
   *   activity:string|null, isStale:boolean, distance:number|null}>}
   */
  getSessionRoster() {
    const session = this._activeSession;
    if (!session) return [];

    const selfId = getParticipantId();
    const hostId = session.ownerUserId || null;
    const holderId = this.getManipulationHolder()?.holderUserId || null;

    // Liveness comes from the Y.js pose map, which only carries REMOTE entries
    // (getRemoteParticipants filters self out) — so self is never stale.
    const liveById = new Map();
    try {
      for (const p of this._participantSync?.getRemoteParticipants?.() || []) {
        if (p?.odUserId) liveById.set(p.odUserId, p);
      }
    } catch (err) {
      log.warn(`VR roster: participant sync read failed — ${err?.message}`);
    }

    const selfPos = this._getParticipantDataPosition(selfId);

    const rows = (Array.isArray(session.participants) ? session.participants : [])
      .filter((p) => p?.odUserId)
      .map((p) => {
        const userId = p.odUserId;
        const isSelf = userId === selfId;
        const live = liveById.get(userId) || null;
        return {
          userId,
          userName: p.userName || userId,
          userColor: p.userColor || '#888888',
          mode: p.mode || PARTICIPATION_MODE.DESKTOP_OBSERVER,
          isSelf,
          isHost: !!hostId && userId === hostId,
          isHolder: !!holderId && userId === holderId,
          activity: this._readActivity(userId),
          // A participant the session model knows about but the pose map has
          // never seen is NOT stale — that is a desktop observer, or a VR peer
          // whose first packet has not landed yet.
          isStale: !isSelf && !!live?.isStale,
          distance: isSelf ? 0 : this._distanceBetween(selfPos, this._getParticipantDataPosition(userId)),
          joinedAt: typeof p.joinedAt === 'number' ? p.joinedAt : 0,
        };
      });

    const rank = (r) => {
      if (r.isHolder) return 0;
      if (r.isHost) return 1;
      return r.mode === PARTICIPATION_MODE.VR_EXPLORER ? 2 : 3;
    };
    rows.sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });

    // joinedAt was only carried to sort by; it is not part of the roster shape.
    return rows.map(({ joinedAt: _joinedAt, ...row }) => row);
  }

  /**
   * What this user is currently manipulating, from the room-global manipulator
   * channel (`syncManipulatorToYjs`). Returns null when idle.
   * @param {string} userId
   * @returns {string|null} e.g. 'dataset' | 'filter'
   * @private
   */
  _readActivity(userId) {
    try {
      return yManipulatorState?.get?.(userId)?.target || null;
    } catch {
      return null;
    }
  }

  /** @returns {number|null} Euclidean distance in data space, null if unknown. @private */
  _distanceBetween(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return null;
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Number.isFinite(d) ? d : null;
  }

  /**
   * A participant's last known head position, converted from THEIR OWN
   * physical XR space into shared data space using THEIR vrScale/vrOrigin
   * (each VR participant has an independent WebXR reference space — same
   * conversion as RemoteAvatarController._toScenePose / followService).
   * @param {string} userId
   * @returns {number[]|null} [x, y, z] in data space, or null if unknown
   * @private
   */
  _getParticipantDataPosition(userId) {
    const state = this._participantSync?.getParticipantState(userId);
    const headPose = state?.headPose;
    if (!headPose?.position) return null;

    const theirScale = typeof state.vrScale === 'number' ? state.vrScale : 1.0;
    const theirOrigin = Array.isArray(state.vrOrigin) ? state.vrOrigin : [0, 0, 0];
    return mapXRPointToData(headPose.position, theirScale, theirOrigin);
  }

  /**
   * One-shot: move the local vrOrigin so the target participant sits ~1.5m
   * in front of the user at chest height (same convention as
   * _computeAutoPlacement/enterIsolation). Keeps this user's own vrScale.
   * @param {string} userId
   * @returns {boolean} true if the target's position was known and applied
   */
  goToParticipant(userId) {
    const ctx = this._activeContext?.vrContext;
    if (!ctx) return false;
    const targetPos = this._getParticipantDataPosition(userId);
    if (!targetPos) return false;

    const vrScale = ctx.vrScale || 1.0;
    // Y stays on the ground plane rather than tracking the target's altitude:
    // you walk over to stand near them, you don't get teleported to their eye
    // height. Keeps the grounding invariant intact (see _groundY).
    ctx.vrOrigin = [
      targetPos[0],
      this._groundY(ctx),
      targetPos[2] + 1.5 / vrScale,
    ];
    this._emit('wentToParticipant', { userId });
    return true;
  }

  /**
   * Start soft positional follow of a participant: every frame, vrOrigin
   * lerps toward standing near their current position. Head orientation is
   * NEVER touched — the user keeps free head-look at all times (a hard
   * spectator lock is a motion-sickness hazard). Any local locomotion
   * input this frame cancels follow, mirroring followService's desktop
   * auto-unfollow-on-manual-move semantics.
   * @param {string} userId
   * @returns {boolean} true if a live session is active
   */
  followParticipant(userId) {
    if (!this._activeContext?.vrContext || !userId) return false;
    this._followTargetUserId = userId;
    this._emit('followingParticipantChanged', { userId });
    return true;
  }

  stopFollowing() {
    if (!this._followTargetUserId) return;
    this._followTargetUserId = null;
    this._emit('followingParticipantChanged', { userId: null });
  }

  isFollowingParticipant() {
    return this._followTargetUserId;
  }

  async updateParticipantMode(newMode) {
    if (!this._activeSession) return;

    const participant = this._activeSession.updateParticipantMode(getParticipantId(), newMode);

    // Sync via Y.js
    this._participantSync?.broadcastParticipant(participant);

    this._emit('participantUpdated', { participant });

    return participant;
  }

  // ===========================================================================
  // CONTROL MANAGEMENT (delegated to VRControlManager)
  // ===========================================================================

  async requestControl(targetUserId) {
    if (!this._controlManager) throw new Error('No active session');
    return this._controlManager.requestControl(targetUserId);
  }

  async releaseControl() {
    if (!this._controlManager) throw new Error('No active session');
    return this._controlManager.releaseControl();
  }

  respondToControlRequest(approved) {
    if (!this._controlManager) return;
    this._controlManager.respondToRequest(approved);
  }

  // ===========================================================================
  // DATA-MANIPULATION TOKEN (delegated to VRManipulationLock)
  // ===========================================================================
  //
  // Exactly one participant at a time may push SHARED data changes — clip,
  // representation, glyphs, threshold, isosurface, and dataset transform.
  // The host holds the token by default, can hand it to anyone, and everyone
  // else can ask.
  //
  // WHAT IS DELIBERATELY NOT GATED: vrScale, vrOrigin, locomotion, follow,
  // isolation, probe, and annotation/measurement placement. vrScale/vrOrigin/
  // locomotion/follow/isolation/probe are this user's own viewpoint — gating
  // them would mean four people in one headset session all being dragged
  // around by whoever holds the token. Annotation and measurement placement
  // are additive, per-user, non-conflicting writes (unlike clip/threshold/
  // glyph, which mutate ONE shared representation of the dataset) — any
  // participant may place one at any time regardless of who holds the token;
  // see VRAnnotationTool.js/VRMeasureTool.js, which no longer call
  // canManipulate() before placement.

  /**
   * Silent permission read — Phase D4 fail-closed gate.
   *
   * `_leaseRequired` decides which failure mode applies when the lock ITSELF
   * is unusable (missing, wrong shape, or throws):
   *  - Server session (`_leaseRequired === true`): fail CLOSED. A session
   *    confirmed against a real server row (see isServerSessionId) has an
   *    obtainable lease; a missing/throwing lock at that point is a bug, not
   *    "nobody's contesting it", so refusing is the safe default.
   *  - Local / not-yet-confirmed session (`_leaseRequired === false`): fail
   *    OPEN, exactly the pre-D4 behaviour. `_tryRegisterSession` can fail
   *    (offline, 500, the client_session_key collision) and strand VR on a
   *    local `vrsession_*` id with no server row and no obtainable lease —
   *    unconditional fail-closed would make solo/offline VR completely
   *    inert. This also keeps ~21 existing tests green that fabricate
   *    `_activeContext` with no lock at all (see
   *    VRExplorationManager.manipulationGate.test.js).
   *
   * When the lock DOES exist and answers normally, its answer is ALWAYS
   * authoritative regardless of `_leaseRequired` — a local session still
   * runs the original Y.js mutual-exclusion
   * (VRManipulationLock.canManipulate's local-session branch), and that must
   * still be enforced even though no lease is required.
   * @returns {boolean}
   * @private
   */
  _hasManipulationControl() {
    const lock = this._manipulationLock;
    if (!lock || typeof lock.canManipulate !== 'function') {
      return !this._leaseRequired;
    }
    try {
      return lock.canManipulate() === true;
    } catch (err) {
      log.warn(
        `VR manipulation lock read failed (${this._leaseRequired ? 'denying' : 'allowing'}): ${err?.message}`
      );
      return !this._leaseRequired;
    }
  }

  /**
   * Permission check WITH in-headset feedback. Returns true when the action
   * may proceed; on refusal it flashes a notice naming the holder, because a
   * silently dropped patch is exactly the desync this feature exists to fix.
   * @param {string} [label] - what the user was trying to do, e.g. "Glyphs"
   * @returns {boolean}
   */
  _requireManipulationControl(label = 'That change') {
    if (this._hasManipulationControl()) return true;
    const holderName = this.getManipulationHolder()?.holderUserName;
    this._flashVRNotice(
      holderName
        ? `${label} needs data control — ${holderName} has it`
        : `${label} needs data control`
    );
    return false;
  }

  // ---------------------------------------------------------------------------
  // PHASE D5 — acquire at gesture start, roll back on rejection
  // ---------------------------------------------------------------------------
  //
  // Every VR control used to mutate local VTK state BEFORE the permission
  // check (_pushVisualizationPatch/_requireManipulationControl only gate
  // whether the CHANGE IS BROADCAST, not whether it was applied locally in
  // the first place) — so a refused participant's own headset silently
  // diverged from the shared state instead of being told no. begin/end wrap
  // a gesture (a menu tap, a drag, a throttled value change) so the
  // permission read happens — and a pre-mutation snapshot is captured —
  // BEFORE the local mutation, with a rollback path for when the answer
  // turns out to be no.

  /**
   * @private Synchronous core of beginManipulationGesture — split out so
   * SYNCHRONOUS call sites (menu actions that schedule work via _deferHeavy,
   * or fire a local mutation in the same tick) can gate on the boolean
   * immediately, in the SAME tick as the local mutation they are about to
   * perform/schedule. The public beginManipulationGesture is a thin async
   * wrapper over this — gesture semantics are identical whether a caller
   * awaits it or not.
   *
   * Captures the pre-gesture snapshot UNCONDITIONALLY BEFORE consulting the
   * lock: a continuous gesture (clip/transform drag) may already be
   * mutating local VTK state in real time across many frames, so the ONLY
   * way to guarantee a genuinely pre-gesture snapshot is to take it right
   * now, before the permission read — not after.
   *
   * Deliberately does NOT call an "acquire" endpoint. VRManipulationLock's
   * public surface is intentionally frozen (see
   * VRManipulationLock.serverLease.test.js "is unchanged by the server-lease
   * rewrite") and exposes no "take the lease even though I'm not the
   * current holder" method — rightly so: a gesture starting must never
   * silently take the token from whoever legitimately holds it. This calls
   * the existing public heartbeat() (safe every frame, internally
   * throttled) to nudge a TTL refresh when we already hold it, then reads
   * the current answer via _hasManipulationControl().
   * @param {string} kind
   * @param {string} [instanceId]
   * @returns {boolean}
   */
  _beginGestureSync(kind, instanceId) {
    const id = instanceId || this._activeContext?.instance?.instanceId;
    const instanceData = this._activeContext?.instance?.instanceData;
    const snapshotState = id && instanceData ? this._safeAggregateState(id, instanceData) : null;

    try {
      this._manipulationLock?.heartbeat?.();
    } catch {
      /* best-effort refresh only */
    }

    const allowed = this._hasManipulationControl();

    if (!allowed) {
      this._requireManipulationControl(PATCH_LABELS[kind] || 'That change');
      // Nothing may have actually mutated yet at THIS call site (most
      // callers gate the mutation on this return value), but a caller that
      // can't gate synchronously (frame-loop drag/grab) may already be a
      // few frames in — restoring here is a no-op in the former case and
      // the correct undo in the latter.
      if (id && snapshotState) this._restoreGestureSnapshot(id, snapshotState);
      this._gestureSnapshot = null;
      this._gestureOpId = null;
      return false;
    }

    this._gestureSnapshot = id ? { kind, instanceId: id, state: snapshotState || {} } : null;
    this._gestureOpId =
      `${getParticipantId()}_${kind}_${Date.now().toString(36)}` +
      Math.random().toString(36).slice(2, 8);
    return true;
  }

  /**
   * Begin a manipulation gesture: read/refresh authority and, on success,
   * capture a rollback snapshot + mint a per-gesture op id (Phase D6 reuses
   * it as the mutation envelope's opId across every patch this gesture
   * sends). Awaitable for callers that can afford to; frame-loop call sites
   * fire-and-forget instead (see _pushObjectTransformPatch and the
   * clip-box-updated case in _handleToolAction) since begin() must never
   * block the XR frame loop.
   * @param {string} kind - e.g. 'transform', 'clipBox', 'representation',
   *   'threshold', 'throttled' — anything with a PATCH_LABELS entry gets a
   *   named refusal notice; anything else falls back to "That change".
   * @param {{instanceId?: string}} [opts]
   * @returns {Promise<boolean>}
   */
  async beginManipulationGesture(kind, { instanceId } = {}) {
    return this._beginGestureSync(kind, instanceId);
  }

  /**
   * End a manipulation gesture. `committed: true` (default) just clears the
   * bookkeeping — the gesture's own patches already went out (or were
   * refused, in which case begin() already rolled back). `committed: false`
   * lets a caller explicitly abort a gesture that never got a chance to
   * push anything and restore the pre-gesture snapshot.
   *
   * No-ops if `kind` doesn't match the currently open gesture (e.g. a
   * stale/duplicate end() call after a new gesture already started) — never
   * clears or rolls back a DIFFERENT gesture's bookkeeping.
   * @param {string} kind
   * @param {{committed?: boolean}} [opts]
   */
  endManipulationGesture(kind, { committed = true } = {}) {
    if (!this._gestureSnapshot || this._gestureSnapshot.kind !== kind) return;
    if (!committed) {
      this._restoreGestureSnapshot(this._gestureSnapshot.instanceId, this._gestureSnapshot.state);
    }
    this._gestureSnapshot = null;
    this._gestureOpId = null;
  }

  /**
   * @private Read aggregateVTKVisualizationState defensively — a throwing
   * feature must never abort a gesture begin (aggregateVTKVisualizationState
   * already try/catches per-source internally; this is the outer guard for
   * the aggregate call itself, e.g. a missing/mid-teardown instance).
   * @param {string} instanceId
   * @param {object} instanceData
   * @returns {object|null}
   */
  _safeAggregateState(instanceId, instanceData) {
    try {
      return aggregateVTKVisualizationState(instanceId, instanceData);
    } catch (err) {
      log.warn(`VR gesture snapshot failed: ${err?.message}`);
      return null;
    }
  }

  /**
   * @private Restore a captured pre-gesture snapshot via applySharedState —
   * REUSED deliberately (not a bespoke restore path): it is the only rich
   * apply path VTKInstanceHandler has, and its
   * _beginApplyingRemoteState/_endApplyingRemoteState guard stops this
   * restore from re-broadcasting as a fresh local change. Fire-and-forget:
   * must never block the XR frame loop or a synchronous menu handler.
   * @param {string} instanceId
   * @param {object} state - aggregateVTKVisualizationState() output
   */
  _restoreGestureSnapshot(instanceId, state) {
    try {
      const handler = this._activeContext?.handler;
      const instanceData = this._activeContext?.instance?.instanceData;
      if (!handler || typeof handler.applySharedState !== 'function' || !instanceData) return;
      Promise.resolve(
        handler.applySharedState(instanceData, { visualization: state }, '__rollback__')
      ).catch((err) => log.warn(`VR gesture rollback failed: ${err?.message}`));
    } catch (err) {
      log.warn(`VR gesture rollback failed: ${err?.message}`);
    }
  }

  /**
   * Phase D6 mutation envelope — threaded as pushSharedVisualizationUpdate's
   * optional 4th argument (see _pushVisualizationPatch). `opId` is per
   * GESTURE (set once in _beginGestureSync, cleared in endManipulationGesture),
   * not per frame, so every patch sent mid-gesture (a drag's non-final
   * frames, a throttled value's ticks) dedupes to the same id. `sessionRevision`
   * (vr_exploration_sessions.revision, the lease-authority epoch — see D1/D2)
   * is left null here: reading it live would need a new accessor on
   * VRManipulationLock, whose public surface is deliberately frozen (see
   * _beginGestureSync's docstring) — revisit if that surface is ever revised
   * on purpose. Per the plan, this is advisory bookkeeping, not enforcement:
   * mutation-level conflict detection is already handled by
   * view_configurations.revision/base_revision, and authority fencing by
   * lease_epoch.
   * @private
   * @returns {{sessionRevision: number|null, actorId: string, opId: string|null}}
   */
  _buildMutationMeta() {
    return {
      sessionRevision: null,
      actorId: getParticipantId(),
      opId: this._gestureOpId || null,
    };
  }

  /** Ask the current holder for the token. @returns {boolean} */
  requestManipulationControl() {
    if (!this._manipulationLock) return false;
    const ok = this._manipulationLock.requestControl() === true;
    this._flashVRNotice(ok ? 'Control requested' : 'You already have data control');
    return ok;
  }

  /** Hand the token to another participant. @returns {boolean} */
  grantManipulationControlTo(userId, userName) {
    const ok = this._manipulationLock?.grantTo(userId, userName) === true;
    if (ok) {
      const name =
        userName ||
        this.getOtherParticipants().find((p) => p.odUserId === userId)?.userName ||
        userId;
      this._flashVRNotice(`Data control given to ${name}`);
    }
    return ok;
  }

  /** Give the token back to the session host. @returns {boolean} */
  releaseManipulationControl() {
    const ok = this._manipulationLock?.release() === true;
    if (ok) this._flashVRNotice('Data control released');
    return ok;
  }

  /**
   * @returns {{holderUserId:string, holderUserName:string, grantedBy:string,
   *   grantedAt:number, heartbeat:number}|null} null when nobody live holds it
   */
  /**
   * One-shot snapshot of everything that has to MATCH between two headsets for
   * them to share a world. Logged on session start and callable from the
   * console (remote-debug a Quest via chrome://inspect).
   *
   * This exists because the overwhelmingly common multi-headset failure — the
   * two devices being in different sessions — is invisible in-headset. Each
   * user sees a working VR scene and an empty People list, with nothing to say
   * whether the problem is the room, the view, the network, or the token. BOTH
   * `roomId` and `sessionKey` must be identical on the two devices — sessionKey
   * is what convergence actually keys on (see _resolveSessionKey; usually the
   * dataset id, NOT viewConfigId — each client mints its own ViewConfiguration,
   * so comparing viewConfigId across headsets is meaningless and was the
   * original bug here). A null sessionKey means neither a dataset id nor a
   * viewConfigId was available, which silently defeats convergence entirely.
   *
   * @returns {object} plain, loggable snapshot
   */
  getCollaborationDiagnostics() {
    let roster = [];
    try {
      roster = this.getSessionRoster() || [];
    } catch {
      roster = [];
    }
    const holder = (() => {
      try {
        return this.getManipulationHolder();
      } catch {
        return null;
      }
    })();

    const instance = this._activeContext?.instance;
    const vrSessionId = this._activeContext?.session?.id ?? null;

    return {
      // MUST MATCH on both headsets ------------------------------------------
      roomId: sessionManager.getRoomId?.() ?? null,
      datasetId: instance?.instanceData?.dataset?.id ?? instance?.datasetId ?? null,
      sessionKey: this._resolveSessionKey(instance) ?? null,
      vrSessionId,
      // The Y.js map the poses actually travel through. Two headsets naming
      // different maps here is the whole failure, stated in one line.
      participantMap: vrSessionId ? `vr-participants-${vrSessionId}` : null,

      // MUST DIFFER on both headsets -----------------------------------------
      // viewConfigId is per-client by construction (each mints its own via
      // POST /views); it is NOT a bug that these differ — see viewSyncKey.js.
      viewConfigId: instance?.viewConfigId ?? null,
      // Two headsets on ONE account share accountId and differ only in
      // participantId — the fastest way to tell "same account, two devices"
      // from "wrong room".
      accountId: getUserId(),
      participantId: getParticipantId(),
      yjsClientId: ydoc.clientID,

      // Session state --------------------------------------------------------
      userName: getParticipantName(),
      participants: roster.length,
      peers: roster.filter((r) => !r.isSelf).map((r) => r.userName || r.odUserId),
      controlHolder: holder?.holderUserName || holder?.holderUserId || '(unheld)',
      voiceConnected: (() => {
        try {
          return this.isVoiceConnected();
        } catch {
          return false;
        }
      })(),
    };
  }

  /**
   * Print the collaboration snapshot.
   *
   * LEVEL IS LOAD-BEARING. This used to log at `info`, which the logger
   * suppresses on any non-localhost host (see logger.js's defaultLevel) — and a
   * headset is never localhost. The single diagnostic written specifically to
   * debug two headsets therefore never printed on either of them. `warn`
   * survives the default threshold, and one line per session (plus one per
   * re-key) is a price worth paying to never lose it again.
   *
   * @param {string} reason - what triggered the dump
   * @private
   */
  _logCollaborationDiagnostics(reason) {
    try {
      const d = this.getCollaborationDiagnostics();
      log.warn(
        `VR collab [${reason}]\n` +
          `  MUST MATCH  room=${d.roomId} dataset=${d.datasetId} key=${d.sessionKey}\n` +
          `              session=${d.vrSessionId} map=${d.participantMap}\n` +
          `  MUST DIFFER view=${d.viewConfigId} participant=${d.participantId} yjsClient=${d.yjsClientId}\n` +
          `  account=${d.accountId} as=${d.userName} participants=${d.participants} ` +
          `peers=[${d.peers.join(', ')}] control=${d.controlHolder} voice=${d.voiceConnected}`
      );
      if (!d.sessionKey) {
        log.warn(
          'VR collab: sessionKey is null (no dataset id or viewConfigId) — ' +
            'VR session convergence cannot match it against the other headset.'
        );
      }
    } catch (err) {
      log.warn(`VR collab diagnostics failed: ${err?.message}`);
    }
  }

  getManipulationHolder() {
    return this._manipulationLock?.getHolder() ?? null;
  }

  /** @returns {boolean} */
  isManipulationHolder() {
    return this._manipulationLock?.isHeldByMe() === true;
  }

  /** @returns {Array<{userId:string,userName:string,atMs:number}>} */
  getManipulationRequests() {
    return this._manipulationLock?.getRequests() ?? [];
  }

  /** Approve a pending request (holder/host only). @returns {boolean} */
  approveManipulationRequest(userId) {
    return this._manipulationLock?.approveRequest(userId) === true;
  }

  /** Deny a pending request (holder/host only). @returns {boolean} */
  denyManipulationRequest(userId) {
    return this._manipulationLock?.denyRequest(userId) === true;
  }

  // ---------------------------------------------------------------------------
  // IN-VR NOTICE
  // ---------------------------------------------------------------------------

  /**
   * Show a transient message on the spatial menu's status line. Reuses the
   * EXISTING dirty-checked status canvas (VRSpatialMenuModel.getStatusLine →
   * VTKVRSpatialUI._layoutStatus) rather than adding an actor: a notice that
   * costs a texture upload only while it is on screen.
   * @param {string} text
   * @param {number} [ms=VR_NOTICE_MS]
   */
  _flashVRNotice(text, ms = VR_NOTICE_MS) {
    if (!text) return;
    this._vrNotice = { text, untilMs: Date.now() + ms };
  }

  /**
   * The live notice text, or null once it has expired.
   * @returns {string|null}
   */
  getVRNotice() {
    const notice = this._vrNotice;
    if (!notice) return null;
    if (Date.now() >= notice.untilMs) {
      this._vrNotice = null;
      return null;
    }
    return notice.text;
  }

  // ---------------------------------------------------------------------------
  // ACTIVITY SIGNAL
  // ---------------------------------------------------------------------------

  /**
   * Light this user up as the active manipulator for everyone, VR and desktop
   * alike, through the EXISTING yjsSetup manipulator channel — the same one
   * VTKInstanceHandler uses for desktop camera drags, already observed by
   * every desktop client via onManipulatorChange. No new plumbing, no new
   * Y.js map, and desktop awareness UI gets VR activity for free.
   *
   * @param {'dataset'|'filter'} target
   * @param {string} [action='manipulating']
   * @private
   */
  _signalManipulation(target, action = 'manipulating') {
    try {
      syncManipulatorToYjs(getParticipantId(), getParticipantName(), target, action);
      // In-headset counterpart of the desktop awareness UI: a marker on THIS
      // user's avatar so the other headsets can see who is acting. Driven here
      // — at manipulation-event rate, then again on the idle timer — never per
      // frame; it costs one Y.js presence write (see AvatarNetworkSync's
      // unchanged-payload short-circuit).
      vrAvatarSystem.setLocalActivity?.(target);
      if (this._manipulatorIdleTimer) clearTimeout(this._manipulatorIdleTimer);
      this._manipulatorIdleTimer = setTimeout(() => {
        this._manipulatorIdleTimer = null;
        this._clearManipulationSignal();
      }, MANIPULATOR_IDLE_MS);
    } catch (err) {
      log.warn(`VR manipulator signal failed: ${err?.message}`);
    }
  }

  /** @private */
  _clearManipulationSignal() {
    if (this._manipulatorIdleTimer) {
      clearTimeout(this._manipulatorIdleTimer);
      this._manipulatorIdleTimer = null;
    }
    try {
      syncManipulatorToYjs(getParticipantId(), null, null, null);
      vrAvatarSystem.setLocalActivity?.(null);
    } catch (err) {
      log.warn(`VR manipulator clear failed: ${err?.message}`);
    }
  }

  // ===========================================================================
  // TOOL MANAGEMENT (delegated to VRToolManager)
  // ===========================================================================

  async activateTool(toolId) {
    if (!this._toolManager) return;
    try {
      await this._toolManager.activateTool(toolId);
      this._emit('toolActivated', { toolId });
    } catch (error) {
      log.warn(`VR tool activation failed for "${toolId}": ${error?.message}`);
      this._emit('toolActivationFailed', { toolId, error: error?.message || String(error) });
    }
  }

  deactivateTool() {
    if (!this._toolManager) return;
    this._toolManager.deactivateTool();
    this._emit('toolDeactivated', {});
  }

  getActiveTool() {
    return this._toolManager?.getActiveTool();
  }

  /**
   * Undo the active tool's most recent action (e.g. remove the last VR
   * annotation or measurement). Routes the resulting tool action through the
   * same _handleToolAction path the controller A-button uses, so persistence
   * and broadcast stay consistent. Invoked by the spatial menu's Undo button.
   * @returns {boolean} true if something was undone
   */
  undoLastToolAction() {
    const tool = this._toolManager?.getActiveTool?.();
    const action = tool?.undoLast?.();
    if (!action) return false;
    this._handleToolAction(action);
    return true;
  }

  /**
   * Archive the active measurement path and begin a disconnected one. Backs the
   * measure tool's contextual "New Path" button — without it, the only way to
   * start measuring elsewhere would be to undo every point first.
   * @returns {object|null} the archived path, or null if nothing was drawn
   */
  startNewMeasurementPath() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'measure' || typeof tool.newPath !== 'function') return null;
    const action = tool.newPath();
    if (!action) return null;
    this._handleToolAction(action);
    return action.data ?? null;
  }

  getAvailableTools() {
    return this._toolManager?.getAvailableTools() || [];
  }

  /**
   * Advance the active tool's pending annotation label to the next preset
   * (VRAnnotationTool.cycleLabel — the only VR text-entry mechanism, see
   * ANNOTATION_LABEL_PRESETS). No-ops if the active tool doesn't support
   * labels. Invoked by the spatial menu's "Label" button.
   * @returns {string|null} the newly-selected label, or null if unsupported
   */
  cycleAnnotationLabel() {
    const tool = this._toolManager?.getActiveTool?.();
    if (typeof tool?.cycleLabel !== 'function') return null;
    const label = tool.cycleLabel();
    this._emit('annotationLabelChanged', { label });
    return label;
  }

  /** @returns {string|null} the label the next placed annotation will carry */
  getPendingAnnotationLabel() {
    const tool = this._toolManager?.getActiveTool?.();
    return typeof tool?.getPendingLabel === 'function' ? tool.getPendingLabel() : null;
  }

  /**
   * Invert the active Clip tool's plane direction. Routes the resulting
   * clip-box-updated action through the same _handleToolAction path the
   * A-button shortcut uses, so persistence/broadcast stays consistent.
   * No-ops if Clip isn't the active tool. Invoked by the spatial menu's
   * contextual "Invert" button.
   */
  invertClipPlane() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'clip' || typeof tool.invert !== 'function') return;
    const action = tool.invert();
    if (action) this._handleToolAction(action);
  }

  /**
   * Cycle the clip plane's axis constraint (free -> X -> Y -> Z). Backs the
   * contextual "Axis" button, which is the only way to get an exactly
   * axis-aligned cut on Vision Pro — free-aiming a plane by hand with no grip
   * to brace against is not precise.
   * @returns {string|null} the new axis lock, or null when free
   */
  cycleClipAxis() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'clip' || typeof tool.cycleAxisLock !== 'function') return null;
    const action = tool.cycleAxisLock();
    if (action) this._handleToolAction(action);
    return tool.getAxisLock?.() ?? null;
  }

  /**
   * Reset the active Clip tool's plane. Same routing as invertClipPlane().
   * Invoked by the spatial menu's contextual "Reset" button.
   */
  resetClipPlane() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'clip' || typeof tool.reset !== 'function') return;
    const action = tool.reset();
    if (action) this._handleToolAction(action);
  }

  /**
   * Cycle the active Annotate tool's marker colour. No-ops (returns null) if
   * Annotate isn't the active tool. Invoked by the spatial menu's contextual
   * "Color" button.
   *
   * Replaced cycleAnnotationMode (marker/text/drawing), which changed only
   * stored metadata — the tool drew the same sphere for every mode, so the
   * button appeared to do nothing.
   * @returns {string|null} the newly-selected colour name
   */
  cycleAnnotationColor() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'annotate' || typeof tool.cycleColor !== 'function') return null;
    return tool.cycleColor();
  }

  /**
   * Current state of the active Annotate tool's in-progress draft (a fixed
   * point with nothing persisted yet). Read every frame by the spatial
   * keyboard's status line. Returns null when Annotate isn't the active tool
   * or no draft is open — the keyboard renderer treats null as "not shown".
   * @returns {{active:boolean,text:string,fallbackText:string,position:object,color:*}|null}
   */
  getAnnotationDraft() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'annotate' || typeof tool.getDraft !== 'function') return null;
    return tool.getDraft();
  }

  /**
   * Append characters to the active draft's text buffer. No-ops (returns
   * null) if Annotate isn't active or no draft is open. Invoked per keypress
   * by the spatial keyboard's kbd-char / kbd-preset keys.
   * @param {string} str
   * @returns {string|null} the new draft text, or null if unsupported
   */
  appendAnnotationDraft(str) {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'annotate' || typeof tool.appendDraftText !== 'function') return null;
    return tool.appendDraftText(str);
  }

  /**
   * Remove the last character of the active draft's text buffer. Same guard
   * shape as appendAnnotationDraft. Invoked by the keyboard's Del key.
   * @returns {string|null} the new draft text, or null if unsupported
   */
  backspaceAnnotationDraft() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'annotate' || typeof tool.backspaceDraft !== 'function') return null;
    return tool.backspaceDraft();
  }

  /**
   * Save the active draft as a real, persisted, broadcast annotation.
   * Routes the resulting annotation-created action through _handleToolAction
   * — never call _persistVRAnnotation directly — so persistence and _emit
   * stay behind the single choke point every other tool action goes through
   * (see undoLastToolAction, invertClipPlane). Invoked by the keyboard's
   * Save key.
   * @returns {boolean} true if a draft was confirmed
   */
  confirmAnnotationDraft() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'annotate') return false;
    const action = tool.confirmDraft?.();
    if (action) this._handleToolAction(action);
    return !!action;
  }

  /**
   * Discard the active draft — nothing persisted, nothing broadcast. Same
   * _handleToolAction routing discipline as confirmAnnotationDraft. Invoked
   * by the keyboard's Cancel key.
   * @returns {boolean} true if a draft was cancelled
   */
  cancelAnnotationDraft() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'annotate') return false;
    const action = tool.cancelDraft?.();
    if (action) this._handleToolAction(action);
    return !!action;
  }

  /**
   * Toggle the active Probe tool's continuous-sampling mode. No-ops (returns
   * false) if Probe isn't the active tool. Invoked by the spatial menu's
   * contextual "Continuous" button.
   * @returns {boolean} the new continuous-mode state
   */
  toggleProbeContinuous() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'probe' || typeof tool.setContinuousMode !== 'function') return false;
    const next = !tool.isContinuousMode();
    tool.setContinuousMode(next);
    return next;
  }

  /** @returns {boolean} whether the active Probe tool is in continuous-sampling mode */
  isProbeContinuous() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'probe' || typeof tool.isContinuousMode !== 'function') return false;
    return tool.isContinuousMode();
  }

  /**
   * Clear the active Probe tool's sample history. No-ops if Probe isn't the
   * active tool. Invoked by the spatial menu's contextual "Clear" button.
   */
  clearProbeHistory() {
    const tool = this._toolManager?.getActiveTool?.();
    if (tool?.id !== 'probe' || typeof tool.clearHistory !== 'function') return;
    tool.clearHistory();
  }

  // ===========================================================================
  // VOICE (delegated to voiceRoomService)
  // ===========================================================================
  //
  // Thin pass-through so the spatial menu's Mute/Voice buttons can control the
  // same LiveKit voice room the voice bar/tab use, without leaving VR. Room
  // name is derived from the collaboration session (getVoiceRoomName), not
  // reinvented here.

  /** @returns {boolean} whether the local participant is currently muted */
  isVoiceMuted() {
    return voiceRoomService.isMuted;
  }

  /**
   * Toggle the local participant's mute state. Fire-and-forget: toggleMute()
   * is async, but the spatial menu's activate() must return synchronously —
   * the button's tint catches up on the next frame once isVoiceMuted()
   * re-reads the (by-then-updated) state.
   * @returns {boolean} the new muted state, read optimistically before the
   *   promise resolves
   */
  toggleVoiceMute() {
    voiceRoomService.toggleMute().catch((err) => log.warn('Voice mute toggle failed:', err?.message));
    return !voiceRoomService.isMuted;
  }

  /** @returns {boolean} whether currently connected to the session's voice room */
  isVoiceConnected() {
    return voiceRoomService.isConnected();
  }

  /**
   * Join or leave the session's voice room. Fire-and-forget, same rationale
   * as toggleVoiceMute().
   * @returns {boolean} the new connected state, read optimistically
   */
  /**
   * Settle microphone permission while DOM prompts can still be shown.
   * Never throws — voice is optional, VR entry is not.
   * @private
   * @returns {Promise<void>}
   */
  async _prewarmVoicePermission() {
    try {
      await voiceRoomService.initialize();
    } catch (err) {
      log.warn('Voice pre-warm failed (continuing without voice):', err?.message);
    }
  }

  /**
   * Join the session's voice room, muted.
   *
   * Called automatically on VR entry. It used to be reachable ONLY through the
   * spatial menu's SESSION drawer — a closed drawer inside an in-world menu —
   * so in practice two headsets in the same VR session never had voice, which
   * read as "voice doesn't work in VR". getVoiceRoomName() is scoped to
   * sessionManager.getRoomId(), the same room the VR session itself is scoped
   * to, so both headsets land in one LiveKit room.
   *
   * Muted on join is deliberate: an automatically opened microphone is a
   * privacy surprise. The menu's mic toggle unmutes.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _autoJoinVoice() {
    if (voiceRoomService.isConnected()) return;
    try {
      await voiceRoomService.joinRoom(getVoiceRoomName(), getParticipantName());
      log.info('Voice room joined for VR session (muted)');
    } catch (err) {
      log.warn('Voice auto-join failed (continuing without voice):', err?.message);
    }
  }

  toggleVoiceConnection() {
    if (voiceRoomService.isConnected()) {
      voiceRoomService.leaveRoom().catch((err) => log.warn('Voice leave failed:', err?.message));
      return false;
    }
    voiceRoomService
      .joinRoom(getVoiceRoomName(), getParticipantName())
      .catch((err) => log.warn('Voice join failed:', err?.message));
    return true;
  }

  // ===========================================================================
  // NAVIGATION (delegated to VRNavigationController)
  // ===========================================================================

  setNavigationMode(mode) {
    if (!this._navigationController) return;
    // MOVE_OBJECT is the one locomotion mode that is not a per-user viewpoint:
    // its drag rewrites the SHARED dataset transform. Letting a non-holder
    // enter it means they drag the data locally, _pushVisualizationPatch
    // silently drops the patch, and their view is permanently out of step with
    // everyone else's — worse than refusing the mode outright.
    if (mode === EXPLORATION_MODES.MOVE_OBJECT && !this._requireManipulationControl('Move Object')) {
      return null;
    }
    this._navigationController.setMode(mode);
    this._emit('navigationModeChanged', { mode });
    return mode;
  }

  getNavigationMode() {
    return this._navigationController?.getMode();
  }

  cycleNavigationMode() {
    if (!this._navigationController) return null;
    let newMode = this._navigationController.cycleMode();
    // Same reasoning as setNavigationMode — the cycle must not be able to park
    // a non-holder in MOVE_OBJECT through the back door. Step past it once
    // (the cycle is finite and only one entry is gated, so this terminates).
    if (newMode === EXPLORATION_MODES.MOVE_OBJECT && !this._hasManipulationControl()) {
      this._requireManipulationControl('Move Object');
      newMode = this._navigationController.cycleMode();
    }
    this._emit('navigationModeChanged', { mode: newMode });
    return newMode;
  }

  getNavigationModeInfo() {
    return this._navigationController?.getModeInfo();
  }

  getVRScale() {
    return this._navigationController?.getScale() || 1.0;
  }

  setVRScale(scale) {
    if (!this._navigationController) return;
    // Pivot the preset about the floor under the user, so Overview/Normal/
    // Detail resize the dataset in place instead of hurling it toward or away
    // from them. Unpivoted, a preset tap is a homothety about the XR origin —
    // the same defect the two-hand gesture had, and a 10x preset jump makes it
    // far more violent. See VRScaleController.setScale.
    this._navigationController.setScale(scale, this._lastHeadFloorXR);
    // setScale's pivot deliberately leaves Y untouched (see its doc comment),
    // which is exactly right for the OLD scale-independent floor grounding
    // but leaves the pedestal (see PEDESTAL_HEIGHT_M) stale at the previous
    // scale's height. Re-ground now that vrScale has changed — a one-shot
    // preset tap, not a live gesture, so there's no per-frame pivot logic to
    // fight with here (contrast the two-hand gesture, which deliberately
    // holds Y fixed for its own duration — see VRScaleController._pivotedOrigin).
    const ctx = this._activeContext?.vrContext;
    if (ctx && Array.isArray(ctx.vrOrigin)) {
      ctx.vrOrigin[1] = this._groundY(ctx);
    }
    this._emit('vrScaleChanged', { scale });
  }

  // ===========================================================================
  // VISUALIZATION (representation cycling + glyph toggle)
  // ===========================================================================
  //
  // These drive the SAME desktop implementations the InstanceToolsPanel uses
  // (instanceTools / vtkGlyphFeature) and push the SAME visualizationSyncService
  // patch its menus push, so an in-VR change is indistinguishable from a desktop
  // one to every collaborator (and persists identically for late joiners).

  /**
   * Cycle the active dataset's surface representation
   * surface → wireframe → points → surface, mirroring the desktop Appearance
   * menu. Renders locally via instanceTools.setRepresentation AND pushes the
   * `representation` field to collaborators + persistence.
   * @returns {string|null} the new representation, or null if no active dataset
   */
  cycleRepresentation() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return null;

    const order = ['surface', 'wireframe', 'points'];
    const current = instanceTools.getRepresentation?.(instanceId) || 'surface';
    const next = order[(order.indexOf(current) + 1) % order.length];

    // Phase D5: begin() MUST run before _deferHeavy schedules, not inside
    // the deferred callback — capturing the snapshot in there would read
    // state AFTER instanceTools.setRepresentation already ran, so a later
    // rollback would restore the wrong (already-mutated) value. Refused ->
    // skip the deferred mutation entirely (begin() already flashed the
    // notice) rather than optimistically applying it anyway.
    if (!this._beginGestureSync('representation', instanceId)) return null;

    // Deferred like the other menu-triggered visualization changes (see
    // _deferHeavy / toggleGlyphs) — the mapper rebuild + sync patch run one
    // frame later; the optimistic `next` is returned immediately.
    // boundsMayChange: false — representation only changes how the mapper
    // draws existing geometry (surface/wireframe/points), never its bounds.
    this._deferHeavy('Applying appearance…', () => {
      instanceTools.setRepresentation?.(instanceId, next);
      this._pushVisualizationPatch({ representation: next });
      this.endManipulationGesture('representation');
    }, { boundsMayChange: false });
    this._emit('representationChanged', { representation: next });
    return next;
  }

  /**
   * Set one specific representation, backing the Appearance drawer's discrete
   * Surface/Wire/Points buttons. Same effect as cycleRepresentation without the
   * guessing — cycleRepresentation is kept for voice commands and any other
   * caller that genuinely wants "next".
   * @param {'surface'|'wireframe'|'points'} mode
   * @returns {string|null} the applied mode, or null with no active dataset
   */
  setRepresentation(mode) {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return null;
    if (!['surface', 'wireframe', 'points'].includes(mode)) {
      log.warn(`VR setRepresentation: unknown mode "${mode}"`);
      return null;
    }

    // Phase D5 — see cycleRepresentation's identical comment.
    if (!this._beginGestureSync('representation', instanceId)) return null;

    // Deferred — see cycleRepresentation. boundsMayChange: false, same reason.
    this._deferHeavy('Applying appearance…', () => {
      instanceTools.setRepresentation?.(instanceId, mode);
      this._pushVisualizationPatch({ representation: mode });
      this.endManipulationGesture('representation');
    }, { boundsMayChange: false });
    this._emit('representationChanged', { representation: mode });
    return mode;
  }

  // ===========================================================================
  // SCENE CHROME — data reference grid + labelled axes
  // ===========================================================================
  //
  // These reuse VTKSceneFeature, the same code the desktop scene menu drives.
  // Because VR shares the desktop renderer, a grid toggled on either side is
  // already visible in the other — only the in-VR CONTROL was missing.
  //
  // Bounds are passed explicitly. VTKSceneFeature otherwise sizes itself from
  // renderer.computeVisiblePropBounds(), which in a VR session also sees
  // VREnvironment's floor and walls (~20 m) — so the grid would be built around
  // the room rather than the data. vrContext.dataBounds is already scoped to
  // the data actor alone.
  //
  // Deliberately NOT synced to collaborators: pushSharedVisualizationUpdate has
  // no scene field and applySharedState no scene branch, and these are viewer
  // chrome in the same category as isolation and the Views grid, both already
  // session-local. Syncing would mean new Y.js schema + ViewConfiguration +
  // applySharedState work for no collaborative value. If that changes, the
  // shape is: patch { scene: vtkSceneFeature.getState(id) }, and an
  // applySharedState branch calling setGridVisible/setGridPlane/setAxesVisible.

  /** @private Shared preamble for the scene-chrome wrappers. */
  _sceneTarget() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return null;
    return { instanceId, bounds: this._activeContext?.vrContext?.dataBounds || null };
  }

  /**
   * Toggle the data reference grid.
   * Distinct from toggleGridMode(), which lays out OTHER open views in space.
   * @returns {boolean} whether the grid is now visible
   */
  toggleReferenceGrid() {
    const t = this._sceneTarget();
    if (!t) return false;
    try {
      vtkSceneFeature.toggleGrid(t.instanceId, { bounds: t.bounds });
    } catch (err) {
      log.warn(`VR reference grid toggle failed: ${err?.message}`);
      return false;
    }
    const visible = this.isReferenceGridVisible();
    this._emit('referenceGridToggled', { visible });
    return visible;
  }

  /** @returns {boolean} */
  isReferenceGridVisible() {
    const t = this._sceneTarget();
    if (!t) return false;
    return !!vtkSceneFeature.getState?.(t.instanceId)?.showGrid;
  }

  /**
   * Cycle the reference grid's plane. Starts at xz (the "floor" orientation,
   * which is what a grid usually means in a room-scale headset).
   * @returns {string|null} the new plane
   */
  cycleGridPlane() {
    const t = this._sceneTarget();
    if (!t) return null;
    const order = ['xz', 'xy', 'yz'];
    const current = vtkSceneFeature.getState?.(t.instanceId)?.gridPlane || 'xz';
    const next = order[(order.indexOf(current) + 1) % order.length];
    try {
      vtkSceneFeature.setGridPlane(t.instanceId, next, { bounds: t.bounds });
    } catch (err) {
      log.warn(`VR grid plane cycle failed: ${err?.message}`);
      return null;
    }
    this._emit('gridPlaneChanged', { plane: next });
    return next;
  }

  /**
   * Toggle the labelled cube axes around the data.
   * @returns {boolean} whether the axes are now visible
   */
  toggleDataAxes() {
    const t = this._sceneTarget();
    if (!t) return false;
    try {
      vtkSceneFeature.toggleAxes(t.instanceId, { bounds: t.bounds });
    } catch (err) {
      log.warn(`VR data axes toggle failed: ${err?.message}`);
      return false;
    }
    const visible = this.areDataAxesVisible();
    this._emit('dataAxesToggled', { visible });
    return visible;
  }

  /** @returns {boolean} */
  areDataAxesVisible() {
    const t = this._sceneTarget();
    if (!t) return false;
    return !!vtkSceneFeature.getState?.(t.instanceId)?.showAxes;
  }

  // ===========================================================================
  // FILTERS — threshold + isosurface
  // ===========================================================================

  /** @private */
  _instanceId() {
    return this._activeContext?.instance?.instanceId || null;
  }

  /**
   * Threshold needs at least one scalar array to act on. scanAvailableArrays
   * runs at load time, so this is just a read.
   * @returns {boolean}
   */
  isThresholdAvailable() {
    const id = this._instanceId();
    if (!id) return false;
    const arrays = vtkThresholdFeature.getState?.(id)?.availableArrays;
    return Array.isArray(arrays) && arrays.length > 0;
  }

  /** @returns {boolean} */
  isThresholdEnabled() {
    const id = this._instanceId();
    return !!(id && vtkThresholdFeature.getState?.(id)?.enabled);
  }

  /** @returns {object|null} */
  getThresholdState() {
    const id = this._instanceId();
    return id ? vtkThresholdFeature.getState?.(id) ?? null : null;
  }

  /**
   * Toggle the threshold filter, syncing the result to collaborators through
   * the existing `threshold` visualization channel (the desktop menu pushes the
   * same patch).
   * @returns {boolean} whether threshold is now enabled
   */
  toggleThresholdFilter() {
    const id = this._instanceId();
    if (!id || !this.isThresholdAvailable()) return false;
    const wasEnabled = this.isThresholdEnabled();

    // Phase D5 — same "begin before _deferHeavy schedules" reasoning as
    // cycleRepresentation/setRepresentation. Refused -> skip the deferred
    // toggle entirely.
    if (!this._beginGestureSync('threshold', id)) return wasEnabled;

    // Availability + current-state reads above stay synchronous; the actual
    // filter (re)application is the expensive part — deferred, same
    // reasoning as toggleGlyphs (see _deferHeavy).
    this._deferHeavy(wasEnabled ? 'Removing threshold…' : 'Applying threshold…', () => {
      try {
        vtkThresholdFeature.toggleThreshold(id);
      } catch (err) {
        log.warn(`VR threshold toggle failed: ${err?.message}`);
        this.endManipulationGesture('threshold', { committed: false });
        return;
      }
      this._syncThreshold(id);
      this._emit('thresholdToggled', { enabled: this.isThresholdEnabled() });
      this.endManipulationGesture('threshold');
    });

    return !wasEnabled;
  }

  /** Cycle threshold mode: between -> above -> below. @returns {string|null} */
  cycleThresholdMode() {
    const id = this._instanceId();
    if (!id) return null;
    const order = ['between', 'above', 'below'];
    const current = vtkThresholdFeature.getState?.(id)?.mode || 'between';
    const next = order[(order.indexOf(current) + 1) % order.length];

    // Phase D5: this action is synchronous end-to-end (no _deferHeavy), so
    // begin/end simply bracket it — same "gesture-shaped" treatment as the
    // clip box's discrete invert/reset/cycleAxis actions.
    if (!this._beginGestureSync('threshold', id)) return null;

    try {
      vtkThresholdFeature.setMode(id, next);
    } catch (err) {
      log.warn(`VR threshold mode cycle failed: ${err?.message}`);
      this.endManipulationGesture('threshold', { committed: false });
      return null;
    }
    this._syncThreshold(id);
    this.endManipulationGesture('threshold');
    return next;
  }

  /** Cycle which scalar array the threshold acts on. @returns {string|null} */
  cycleThresholdArray() {
    const id = this._instanceId();
    if (!id) return null;
    const state = vtkThresholdFeature.getState?.(id);
    const arrays = state?.availableArrays;
    if (!Array.isArray(arrays) || arrays.length === 0) return null;

    const names = arrays.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
    if (!names.length) return null;
    const next = names[(names.indexOf(state?.activeArray) + 1) % names.length];

    if (!this._beginGestureSync('threshold', id)) return null;

    try {
      vtkThresholdFeature.selectArray(id, next);
    } catch (err) {
      log.warn(`VR threshold array cycle failed: ${err?.message}`);
      this.endManipulationGesture('threshold', { committed: false });
      return null;
    }
    this._syncThreshold(id);
    this.endManipulationGesture('threshold');
    return next;
  }

  /** @private Push the threshold config through the shared channel. */
  _syncThreshold(instanceId) {
    try {
      const config = vtkThresholdFeature.getConfigForSync?.(instanceId);
      if (config) this._pushVisualizationPatch({ threshold: config });
    } catch (err) {
      log.warn(`VR threshold sync failed: ${err?.message}`);
    }
  }

  /**
   * Isosurface requires volume/image data, so it is simply unavailable for
   * plain polydata — the menu dims the button rather than letting it no-op.
   * @returns {boolean}
   */
  isIsosurfaceAvailable() {
    const id = this._instanceId();
    const instanceData = this._activeContext?.instance?.instanceData;
    if (!id || !instanceData?.imageData) return false;
    try {
      return vtkIsosurfaceFeature.isAvailable?.(id, instanceData) !== false;
    } catch {
      return false;
    }
  }

  /** @returns {boolean} */
  isIsosurfaceEnabled() {
    const id = this._instanceId();
    return !!(id && vtkIsosurfaceFeature.getState?.(id)?.enabled);
  }

  /** @returns {object|null} */
  getIsosurfaceState() {
    const id = this._instanceId();
    return id ? vtkIsosurfaceFeature.getState?.(id) ?? null : null;
  }

  /**
   * Toggle isosurface extraction.
   *
   * Session-local on purpose: unlike threshold, isosurface has no field in
   * pushSharedVisualizationUpdate and no applySharedState branch, so syncing it
   * would mean extending the Y.js schema and ViewConfiguration. Left as a
   * follow-up rather than half-wired.
   *
   * enableIsosurface is async; the returned boolean is the optimistic target
   * state, and the menu re-reads getState on the next frame regardless.
   * @returns {boolean}
   */
  toggleIsosurface() {
    const id = this._instanceId();
    if (!id || !this.isIsosurfaceAvailable()) return false;
    const enabled = this.isIsosurfaceEnabled();

    // Availability + current-state reads above stay synchronous so the
    // button can still report "unavailable" immediately. The actual marching
    // cubes enable/disable is the expensive part — deferred, same reasoning
    // as toggleGlyphs (see _deferHeavy).
    if (enabled) {
      this._deferHeavy('Removing isosurface…', () => {
        try {
          vtkIsosurfaceFeature.disableIsosurface(id);
        } catch (err) {
          log.warn(`VR isosurface toggle failed: ${err?.message}`);
        }
      });
    } else {
      const imageData = this._activeContext?.instance?.instanceData?.imageData;
      this._deferHeavy('Building isosurface…', () => {
        try {
          const r = vtkIsosurfaceFeature.enableIsosurface?.(id, imageData);
          // Fire-and-forget: must never block or break the XR frame loop.
          if (r && typeof r.catch === 'function') {
            r.catch((err) => log.warn(`VR isosurface enable failed: ${err?.message}`));
          }
        } catch (err) {
          log.warn(`VR isosurface toggle failed: ${err?.message}`);
        }
      });
    }

    this._emit('isosurfaceToggled', { enabled: !enabled });
    return !enabled;
  }

  // ===========================================================================
  // SHARED NUMERIC STEPPER
  // ===========================================================================

  /** @private Lazily build the value editor, bound to this manager. */
  _valueEditor() {
    if (!this._valueEditorModel) {
      this._valueEditorModel = new VRValueEditorModel(this);
    }
    return this._valueEditorModel;
  }

  /** Retarget the stepper to the next editable value. @returns {string|null} */
  cycleValueTarget() {
    return this._valueEditor().cycleTarget();
  }

  /** @returns {number|null} the new value */
  nudgeValue(steps) {
    return this._valueEditor().nudge(steps);
  }

  /** @returns {number|null} the restored value */
  resetValue() {
    return this._valueEditor().reset();
  }

  /** @returns {string} one-line readout for the status line */
  getValueReadout() {
    return this._valueEditor().getReadout();
  }

  // --- Value accessors the stepper's targets read/write ----------------------
  //
  // Thin passthroughs to instanceTools / the feature modules, each pushing the
  // same sync patch the desktop controls push. Holding "+" fires these many
  // times, so the sync side is throttled (see _pushThrottledPatch).

  /** @returns {number|null} */
  getPointSize() {
    const id = this._instanceId();
    return id ? instanceTools.getPointSize?.(id) ?? null : null;
  }

  setPointSize(value) {
    const id = this._instanceId();
    if (!id) return;
    instanceTools.setPointSize?.(id, value);
    this._pushThrottledPatch({ pointSize: value });
  }

  /** @returns {number|null} */
  getLineWidth() {
    const id = this._instanceId();
    return id ? instanceTools.getLineWidth?.(id) ?? null : null;
  }

  setLineWidth(value) {
    const id = this._instanceId();
    if (!id) return;
    instanceTools.setLineWidth?.(id, value);
    this._pushThrottledPatch({ lineWidth: value });
  }

  /** @returns {string|null} current representation, for target availability */
  getRepresentation() {
    const id = this._instanceId();
    return id ? instanceTools.getRepresentation?.(id) ?? null : null;
  }

  setThresholdMin(value) {
    const id = this._instanceId();
    if (!id) return;
    vtkThresholdFeature.setMinValue?.(id, value);
    this._pushThrottledPatch(null, () => ({
      threshold: vtkThresholdFeature.getConfigForSync?.(id),
    }));
  }

  setThresholdMax(value) {
    const id = this._instanceId();
    if (!id) return;
    vtkThresholdFeature.setMaxValue?.(id, value);
    this._pushThrottledPatch(null, () => ({
      threshold: vtkThresholdFeature.getConfigForSync?.(id),
    }));
  }

  setIsovalue(value) {
    const id = this._instanceId();
    if (!id) return;
    // Session-local, like the isosurface toggle itself — see toggleIsosurface.
    vtkIsosurfaceFeature.setIsovalue?.(id, value);
  }

  setIsosurfaceOpacity(value) {
    const id = this._instanceId();
    if (!id) return;
    vtkIsosurfaceFeature.setOpacity?.(id, value);
  }

  /**
   * Push a visualization patch at most ~20/sec. A held "+" button fires every
   * frame; without this each tap would become a Y.js broadcast and a
   * ViewConfiguration write. Mirrors the mid-drag throttle in
   * _pushObjectTransformPatch.
   *
   * @param {object|null} patch - static patch, or null when it must be built lazily
   * @param {Function} [build] - lazy builder, used when the patch is expensive
   * @private
   */
  _pushThrottledPatch(patch, build) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - (this._lastValuePatchAt || 0) < 50) return;
    this._lastValuePatchAt = now;

    // Phase D5: lazily begin on the first tick since the last gesture ended
    // — a held "+" button or a slider drag fires this at ~20 Hz, and
    // re-acquiring per-tick would hammer the lease endpoint for no reason
    // (nothing here needs a fresh network round trip mid-burst; see
    // _beginGestureSync's docstring — it's a cached read + best-effort
    // heartbeat nudge, not a POST). There is no discrete "pointer up"
    // reaching this method, only a stream of value changes, so the gesture
    // auto-ends after THROTTLED_GESTURE_IDLE_MS of silence instead.
    if (!this._throttledGestureActive) {
      this._throttledGestureActive = this._beginGestureSync('throttled');
    }
    if (this._throttledGestureTimer) clearTimeout(this._throttledGestureTimer);
    this._throttledGestureTimer = setTimeout(() => {
      this._throttledGestureTimer = null;
      this._throttledGestureActive = false;
      this.endManipulationGesture('throttled');
    }, THROTTLED_GESTURE_IDLE_MS);

    const payload = patch || (typeof build === 'function' ? build() : null);
    if (payload) this._pushVisualizationPatch(payload);
  }

  /** Current surface representation of the active dataset (for menu highlight). */
  getRepresentation() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return null;
    return instanceTools.getRepresentation?.(instanceId) || 'surface';
  }

  /**
   * Toggle vector/scalar glyphs on the active dataset, mirroring the desktop
   * glyph menu handler (VTKInstanceHandler). Disables if currently enabled;
   * otherwise enables using the first available vector array for orientation,
   * guarded by the same availability check the desktop menu uses. Pushes the
   * same `glyph` sync patch so collaborators + persistence converge.
   * @returns {boolean} the new enabled state (false if unavailable / no arrays)
   */
  toggleGlyphs() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return false;

    const state = vtkGlyphFeature.getState(instanceId);
    if (!state) return false;

    if (state.enabled) {
      // Disabling is cheap, but deferred anyway for symmetry with enable —
      // see _deferHeavy — and so the two can never race out of FIFO order if
      // the user taps twice before a frame drains.
      this._deferHeavy('Removing glyphs…', () => {
        vtkGlyphFeature.disableGlyphs(instanceId);
        this._pushVisualizationPatch({ glyph: vtkGlyphFeature.getConfigForSync(instanceId) });
      });
      this._emit('glyphsToggled', { enabled: false });
      return false;
    }

    // Cheap guards stay synchronous so the button can still report "can't do
    // that" immediately, without ever touching the deferred queue.
    const polydata = this._activeContext?.instance?.instanceData?.polydata;
    if (!polydata) {
      log.warn('VR glyph toggle: dataset polydata unavailable');
      return false;
    }

    const { vectorArrays = [], scalarArrays = [] } = state;
    const hasPoints = (polydata.getNumberOfPoints?.() ?? 0) > 0;
    if (!isGlyphFeatureAvailable(vectorArrays, scalarArrays, hasPoints)) {
      log.warn('VR glyph toggle: no usable vector/scalar/point data on this dataset');
      return false;
    }

    // Pick settings the DATA can actually satisfy, rather than inheriting
    // VTKGlyphFeature's defaults.
    //
    // Those defaults are glyphType 'arrow' (requiresOrientation), and VR
    // passed orientationArray = undefined when the dataset had no vector
    // array — invisible specks on a large dataset, scene-swamping blobs on a
    // small one. That was the "Glyphs doesn't work" report. Now that
    // SCALING_MODES has been corrected to match vtk.js's real enum
    // (magnitude=1, components=2 — see VTKGlyphFeature.js), 'magnitude' is
    // the correct, non-hacky way to express "scale by vector length/scalar
    // magnitude" here.
    const vectorName = vectorArrays?.[0]?.name;
    const scalarName = scalarArrays?.[0]?.name;
    const options = vectorName
      ? {
          glyphType: 'arrow',
          scalingMode: 'magnitude',
          orientationArray: vectorName,
          scaleArray: vectorName,
        }
      : scalarName
      ? {
          // 'sphere' is requiresOrientation:false, so it renders correctly with
          // no vector data — unlike 'arrow', which has nothing to point along.
          glyphType: 'sphere',
          scalingMode: 'off',
          orientationArray: null,
          colorMode: 'scalar',
          colorArray: scalarName,
        }
      : {
          // Point-only dataset (no vector/scalar arrays at all): constant-
          // scale, solid-colored spheres are the only thing the data can
          // actually satisfy.
          glyphType: 'sphere',
          scalingMode: 'off',
          orientationArray: null,
          colorMode: 'solid',
          colorArray: null,
        };
    options.scaleFactor = this._autoGlyphScaleFactor(polydata);

    // The expensive part — vtkGlyphFeature.enableGlyphs runs
    // _buildSubsampledPolydata plus first-draw shader compilation — is
    // deferred; everything above already ran synchronously so we can return
    // the optimistic `true` right now.
    this._deferHeavy('Building glyphs…', () => {
      vtkGlyphFeature.enableGlyphs(instanceId, polydata, options);
      this._pushVisualizationPatch({ glyph: vtkGlyphFeature.getConfigForSync(instanceId) });
    });
    this._emit('glyphsToggled', { enabled: true });
    return true;
  }

  /**
   * A glyph size that suits the dataset, in DATA units.
   *
   * VTKGlyphFeature's default is a hardcoded 1.0, which is meaningless without
   * knowing the data's scale: sub-pixel on a dataset spanning thousands of
   * units, scene-swamping on a normalised one. Derive it from the mean point
   * spacing instead — `diagonal / cbrt(N)` — halved, because the sphere and
   * arrow sources have radius ~0.5, so scaleFactor reads as a diameter.
   * @private
   */
  _autoGlyphScaleFactor(polydata) {
    try {
      const b = this._activeContext?.vrContext?.dataBounds;
      const diagonal =
        Array.isArray(b) && b.length === 6
          ? Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4])
          : 0;
      const n = polydata?.getNumberOfPoints?.() || 0;
      if (!(diagonal > 1e-9) || n < 2) return 1.0;
      const spacing = diagonal / Math.cbrt(n);
      // Clamp so a pathological aspect ratio can't produce a degenerate size.
      return Math.max(diagonal * 1e-4, Math.min(diagonal * 0.1, spacing * 0.5));
    } catch {
      return 1.0;
    }
  }

  /** @returns {boolean} whether glyphs are currently enabled on the active dataset */
  isGlyphsEnabled() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return false;
    return !!vtkGlyphFeature.getState(instanceId)?.enabled;
  }

  /**
   * Select a specific glyph type (or disable glyphs with typeId === null).
   * Unlike toggleGlyphs above (on/off only — it always auto-picks arrow-or-
   * sphere with no user choice, which is why VR glyphs looked "random": the
   * dataset's first vector array may not be a meaningful direction, and the
   * user had no way to pick a different array or a non-oriented shape
   * instead), this exposes the full type set the desktop glyph menu already
   * offers (VTKInstanceHandler.js glyph-menu options) — every VTKGlyphFeature
   * GLYPH_TYPES id, each backed by a real vtk.js source (vtkArrowSource,
   * vtkConeSource, vtkSphereSource, vtkCubeSource, vtkCylinderSource; 'dot' is
   * a small vtkSphereSource). No new glyph rendering code — this only adds a
   * VR menu surface for the API toggleGlyphs and the desktop menu both
   * already call.
   * @param {string|null} typeId - a VTKGlyphFeature GLYPH_TYPES id, or null to disable
   * @returns {boolean} true if the request was accepted
   */
  setGlyphType(typeId) {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return false;

    if (typeId === null) {
      this._deferHeavy('Removing glyphs…', () => {
        vtkGlyphFeature.disableGlyphs(instanceId);
        this._pushVisualizationPatch({ glyph: vtkGlyphFeature.getConfigForSync(instanceId) });
      });
      this._emit('glyphsToggled', { enabled: false });
      return true;
    }

    const state = vtkGlyphFeature.getState(instanceId);
    if (!state) return false;

    // Same guards toggleGlyphs uses, but reported (a disabled-type tap fails
    // loud via a notice, not silently — see the plan's notice-visibility fix).
    const { vectorArrays = [], scalarArrays = [] } = state;
    const polydata = this._activeContext?.instance?.instanceData?.polydata;
    if (getDisabledGlyphTypes(vectorArrays).includes(typeId)) {
      this._flashVRNotice(`${typeId} needs a vector array — this dataset has none`);
      return false;
    }
    const hasPoints = (polydata?.getNumberOfPoints?.() ?? 0) > 0;
    if (!isGlyphFeatureAvailable(vectorArrays, scalarArrays, hasPoints)) {
      this._flashVRNotice('No vector, scalar, or point data on this dataset for glyphs');
      return false;
    }

    if (state.enabled) {
      // Already running — just swap the shape. VTKGlyphFeature.setGlyphType
      // only rebuilds the glyph SOURCE, not the mapper/subsample (see its
      // definition), so this is cheap enough to run synchronously, unlike
      // the initial enable below.
      vtkGlyphFeature.setGlyphType(instanceId, typeId);
      this._pushVisualizationPatch({ glyph: vtkGlyphFeature.getConfigForSync(instanceId) });
      this._emit('glyphsToggled', { enabled: true });
      return true;
    }

    // Not yet enabled: bring it up WITH the requested type, using the same
    // array-driven options toggleGlyphs derives — just parameterized on the
    // user's chosen type instead of always picking arrow-or-sphere.
    if (!polydata) return false;

    const vectorName = vectorArrays?.[0]?.name;
    const scalarName = scalarArrays?.[0]?.name;
    const options = vectorName
      ? {
          glyphType: typeId,
          scalingMode: 'magnitude',
          orientationArray: vectorName,
          scaleArray: vectorName,
        }
      : {
          glyphType: typeId,
          scalingMode: 'off',
          orientationArray: null,
          colorMode: scalarName ? 'scalar' : 'solid',
          colorArray: scalarName || null,
        };
    options.scaleFactor = this._autoGlyphScaleFactor(polydata);

    this._deferHeavy('Building glyphs…', () => {
      vtkGlyphFeature.enableGlyphs(instanceId, polydata, options);
      this._pushVisualizationPatch({ glyph: vtkGlyphFeature.getConfigForSync(instanceId) });
    });
    this._emit('glyphsToggled', { enabled: true });
    return true;
  }

  /** @returns {string|null} the current glyph type, or null if disabled/unavailable */
  getGlyphType() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return null;
    const state = vtkGlyphFeature.getState(instanceId);
    return state?.enabled ? state.glyphType : null;
  }

  /** @returns {string[]} glyph type ids disabled on the active dataset (no vector array) */
  getDisabledGlyphTypeIds() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return [];
    const state = vtkGlyphFeature.getState(instanceId);
    return getDisabledGlyphTypes(state?.vectorArrays || []);
  }

  /**
   * @returns {string|null} the point-data array name currently driving glyph
   *   orientation, or null. Surfaced in the VR status line specifically to
   *   close the "why do these arrows look random" gap — the array is picked
   *   automatically (the dataset's first vector array) and was previously
   *   never shown to the user anywhere in VR.
   */
  getGlyphOrientationArray() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return null;
    const state = vtkGlyphFeature.getState(instanceId);
    return state?.enabled ? state.orientationArray || null : null;
  }

  // ===========================================================================
  // ISOLATION MODE (room-scale inspection)
  // ===========================================================================
  //
  // Isolation pulls the active dataset to room scale so the user can walk
  // around it, and restores the previous scale/origin on exit. The camera
  // mapping is dataPos = xrPos / vrScale + vrOrigin (see
  // VTKInstanceHandler._updateCameraFromVRPose), so isolation is purely a
  // vrScale/vrOrigin change — no actor mutation, nothing leaks to other
  // participants beyond the normal vrScale presence field.

  /**
   * Enter isolation mode: scale the model to ~room size and stand the user
   * a couple of meters back from its center.
   * @returns {boolean} true if isolation is now active
   */
  /**
   * Compute an auto-fit vrScale/vrOrigin so a dataset of arbitrary size and
   * position ends up ~1m in front of the user, its own bottom bound resting
   * PEDESTAL_HEIGHT_M above the floor (not directly on it — see there),
   * regardless of where its bounds sit relative to the data origin. Shared by
   * initial VR placement (_applyInitialPlacement) and isolation mode
   * (enterIsolation) — same math, same "diagonal spans ~2.5 physical meters"
   * convention.
   * @private
   */
  _computeAutoPlacement(dataBounds) {
    // Guard degenerate/invalid bounds: a null box, or one whose extent is
    // (near) zero on every axis — which happens when actors aren't fully
    // added yet on the Vision Pro entry timing — would yield a nonsense
    // diagonal and mis-size the object. Fall back to a unit box in that case.
    let b = dataBounds;
    const valid =
      Array.isArray(b) &&
      b.length === 6 &&
      b.every((v) => Number.isFinite(v)) &&
      (b[1] - b[0] > 1e-6 || b[3] - b[2] > 1e-6 || b[5] - b[4] > 1e-6);
    if (!valid) b = [-1, 1, -1, 1, -1, 1];

    const dx = b[1] - b[0];
    const dy = b[3] - b[2];
    const dz = b[5] - b[4];
    const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const center = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];

    // Auto-fit: the bounding diagonal spans FIT_DIAGONAL_M physical metres,
    // centred FIT_DISTANCE_M in front (see the derivation at the top of this
    // file — the distance is what keeps the dataset clear of the menu panel).
    const vrScale = FIT_DIAGONAL_M / diagonal;

    // GROUNDING INVARIANT. The dataset's base sits PEDESTAL_HEIGHT_M above
    // the floor iff its data-space Y-minimum maps to physical y=PEDESTAL_HEIGHT_M,
    // and since
    //     xr.y(P) = (P - vrOrigin[1]) * vrScale
    // that is exactly `vrOrigin[1] = dataBounds[2] - PEDESTAL_HEIGHT_M / vrScale`.
    // vrOrigin[1] is still a FIXED data-space value once placed, independent
    // of any later vrScale change — that's the property that matters below.
    //
    // Pinning SOME fixed data-space plane here is what fixes "the data keeps
    // getting larger and rises over the user". Changing vrScale with vrOrigin
    // fixed is a homothety about the XR origin, which in local-floor space is
    // the floor point under the user — so every coordinate INCLUDING HEIGHT
    // multiplies by s/s0. It used to start at xr.y ~= +0.6 m and double with
    // every doubling of scale. A point sitting exactly on the pinned plane is
    // a fixed point of that homothety, so grounding removes the rise with no
    // per-frame clamp — the pedestal offset doesn't reintroduce it, since it
    // only changes WHICH plane is pinned, not whether one is.
    const groundY = b[2] - PEDESTAL_HEIGHT_M / vrScale;
    const vrOrigin = [
      center[0],
      groundY,
      center[2] + FIT_DISTANCE_M / vrScale,
    ];
    return {
      vrScale,
      vrOrigin,
      diagonal,
      center,
      groundY,
      radiusM: FIT_DIAGONAL_M / 2,
    };
  }

  /**
   * Data-space Y of the plane the dataset rests on — the value vrOrigin[1]
   * must hold for the dataset's bottom bound to sit PEDESTAL_HEIGHT_M above
   * the floor (see the grounding invariant in _computeAutoPlacement). Every
   * writer of vrOrigin[1] has to go through this, or the first one that
   * doesn't silently un-grounds the dataset and the ballooning returns.
   * @private
   */
  _groundY(vrContext) {
    const b = vrContext?.dataBounds;
    const vrScale = vrContext?.vrScale || 1;
    if (Array.isArray(b) && b.length === 6 && Number.isFinite(b[2])) {
      return b[2] - PEDESTAL_HEIGHT_M / vrScale;
    }
    return vrContext?.vrOrigin?.[1] ?? 0;
  }

  /**
   * Re-read the data actor's bounds. `vrContext.dataBounds` is captured once
   * at VR entry, but Threshold/Isosurface/Glyphs SUBSTITUTE a derived actor
   * with different bounds — leaving it stale would put the grounding plane
   * (and the menu's angular clearance) on the wrong geometry.
   * @param {Object} [vrContext] defaults to the active context
   * @returns {number[]|null} the refreshed bounds, or the previous value
   */
  /**
   * Pin the world-locked environment pieces to the dataset's frame: the floor
   * lattice phase-anchors to the data centre, and the four cardinal posts sit
   * at fixed data-space points framing the dataset. Constant apparent size at
   * a world-fixed position is the strongest translation-parallax cue there is.
   * @private
   */
  _applyEnvironmentAnchor(vrContext, placement) {
    try {
      const p = placement || this._computeAutoPlacement(vrContext?.dataBounds);
      const c = p.center;
      const b = vrContext?.dataBounds;
      // Frame the dataset: posts just outside its horizontal footprint, or a
      // sane default when bounds are degenerate.
      const spanX = Array.isArray(b) ? Math.abs(b[1] - b[0]) : 0;
      const spanZ = Array.isArray(b) ? Math.abs(b[5] - b[4]) : 0;
      const r = 0.9 * Math.max(spanX, spanZ, 1e-6) || 1;
      vrEnvironment.setWorldAnchor({
        refPoint: [c[0], p.groundY, c[2]],
        markerAnchors: [
          [c[0] + r, p.groundY, c[2]],
          [c[0] - r, p.groundY, c[2]],
          [c[0], p.groundY, c[2] + r],
          [c[0], p.groundY, c[2] - r],
        ],
      });
    } catch (e) {
      log.warn(`VR environment anchor failed — ${e?.message}`);
    }
  }

  refreshDataBounds(vrContext) {
    const ctx = vrContext || this._activeContext?.vrContext;
    if (!ctx) return null;
    const actor = ctx.sceneObjects?.actor;
    const b = typeof actor?.getBounds === 'function' ? actor.getBounds() : null;
    const valid =
      Array.isArray(b) &&
      b.length === 6 &&
      b.every((v) => Number.isFinite(v)) &&
      (b[1] - b[0] > 1e-6 || b[3] - b[2] > 1e-6 || b[5] - b[4] > 1e-6);
    if (!valid) return ctx.dataBounds ?? null;
    ctx.dataBounds = [...b];
    return ctx.dataBounds;
  }

  /**
   * Apply the starting pose for a freshly-entered VR context. If the caller
   * didn't request an explicit scale, auto-fit the dataset to room scale
   * (matches enterIsolation's convention). If an explicit scale WAS
   * requested, keep it but still compute vrOrigin so the dataset center
   * sits in front of the user — vrOrigin must never be left at [0,0,0].
   * @private
   */
  _applyInitialPlacement(vrContext, sessionConfig) {
    const placement = this._computeAutoPlacement(vrContext.dataBounds);

    // ALWAYS auto-fit on fresh entry. A persisted/default `vrScale` (from a
    // prior session's default_vr_scale, threaded in via sessionConfig) is a
    // stale hint, not a live user gesture — honoring it was the root cause of
    // the "object appears tiny and far away" report on Apple Vision Pro, where
    // a small saved scale locked the dataset far below its fit-to-view size.
    // Live scale/rotation gestures during the session write vrContext directly;
    // they don't come back through sessionConfig, so ignoring it here is safe.
    vrContext._hasExplicitScale = false;
    vrContext.vrScale = placement.vrScale;
    vrContext.vrOrigin = placement.vrOrigin;
    // Auto-fit diagonal, kept on the context for the scale/zoom controls that
    // read it back when re-fitting the dataset to the play area.
    vrContext._autoFitDiagonal = placement.diagonal;
    // Rotation is part of the same affine XR→data map as scale/origin; start
    // unrotated (yaw radians about world-up through the data center).
    vrContext.vrRotation = 0;

    log.info('Applied initial VR placement', {
      vrScale: vrContext.vrScale,
      vrOrigin: vrContext.vrOrigin,
      diagonal: placement.diagonal,
      ignoredSessionScale: sessionConfig?.vrScale ?? null,
    });
  }

  /**
   * Re-place the dataset relative to the user's ACTUAL head position and
   * facing direction, read from the first real XR frame. _applyInitialPlacement
   * runs before any frame exists, so it has to assume the user faces
   * reference-space -Z at session start — not guaranteed on every
   * headset/platform. Getting this wrong leaves the dataset out of the
   * viewing frustum entirely (reported as a fully black VR view).
   * @private
   */
  _applyPoseRelativePlacement(vrContext, viewerPose) {
    const { position, orientation } = viewerPose.transform;

    // GROUND-PROJECT the gaze ray. controllerForward is the full 3D forward,
    // so the old code's `forward[1] * distance` threw the dataset up to +/-2 m
    // vertically if the user happened to be looking up or down on the first
    // frame. The dataset belongs on the floor in front of them regardless of
    // head pitch, so only the heading matters.
    const forward = controllerForward(orientation);
    let fx = forward[0];
    let fz = forward[2];
    const flen = Math.hypot(fx, fz);
    if (flen < 1e-6) {
      // Looking straight up or down — no meaningful heading; fall back to the
      // reference space's forward.
      fx = 0;
      fz = -1;
    } else {
      fx /= flen;
      fz /= flen;
    }

    const placement = this._computeAutoPlacement(vrContext.dataBounds);
    // Always auto-fit (see _applyInitialPlacement) — the pose-relative pass
    // only re-derives vrOrigin so the auto-fit dataset centers on where the
    // user is actually looking on the first real frame.
    const vrScale = placement.vrScale;

    // Horizontal target only. The vertical placement comes entirely from the
    // grounding invariant below: with vrOrigin[1] = groundY, the centre lands
    // at (center[1] - groundY) * vrScale above the floor — i.e. its own
    // half-height plus PEDESTAL_HEIGHT_M, resting on the pedestal.
    const targetX = position.x + fx * FIT_DISTANCE_M;
    const targetZ = position.z + fz * FIT_DISTANCE_M;

    vrContext.vrScale = vrScale;
    vrContext.vrRotation = 0;
    vrContext.vrOrigin = [
      placement.center[0] - targetX / vrScale,
      placement.groundY,
      placement.center[2] - targetZ / vrScale,
    ];

    // Anchor the world-locked environment to the dataset's frame now that its
    // real placement is known. The floor's grid lines phase-lock to this point
    // and the cardinal posts pin to fixed data-space positions, so travelling
    // produces genuine motion parallax — the cue that makes the stick read as
    // moving the user rather than sliding the dataset.
    this._applyEnvironmentAnchor(vrContext, placement);

    log.info('Applied pose-relative VR placement', {
      vrScale: vrContext.vrScale,
      vrOrigin: vrContext.vrOrigin,
      headPosition: [position.x, position.y, position.z],
      headForward: forward,
    });
  }

  enterIsolation() {
    const ctx = this._activeContext?.vrContext;
    if (!ctx) {
      log.warn('Cannot enter isolation: no active VR context');
      return false;
    }
    if (this._isolationBackup) return true; // already isolated

    this._isolationBackup = {
      vrScale: ctx.vrScale,
      vrOrigin: [...(ctx.vrOrigin || [0, 0, 0])],
    };

    const placement = this._computeAutoPlacement(ctx.dataBounds);
    if (this._navigationController?.setScale) {
      this._navigationController.setScale(placement.vrScale);
    } else {
      ctx.vrScale = placement.vrScale;
    }
    ctx.vrOrigin = placement.vrOrigin;

    const viewId = this._activeContext.instance?.viewConfigId || ctx.instanceId;
    vrManager.enterIsolationMode(viewId);
    this._emit('isolationChanged', { isolated: true, viewId });
    log.info('Entered isolation mode', { scale: ctx.vrScale, diagonal: placement.diagonal });
    return true;
  }

  /**
   * Exit isolation mode and restore the previous scale and origin.
   * @returns {boolean} true if isolation is now inactive
   */
  exitIsolation() {
    const ctx = this._activeContext?.vrContext;
    if (!ctx || !this._isolationBackup) return false;

    const { vrScale, vrOrigin } = this._isolationBackup;
    this._isolationBackup = null;

    if (this._navigationController?.setScale) {
      this._navigationController.setScale(vrScale);
    } else {
      ctx.vrScale = vrScale;
    }
    // Re-ground on restore: dataBounds may have changed while isolated (a
    // filter swapping the actor), which would make the backed-up Y stale and
    // leave the dataset floating or sunk.
    ctx.vrOrigin = [vrOrigin[0], this._groundY(ctx), vrOrigin[2]];

    vrManager.exitIsolationMode();
    this._emit('isolationChanged', { isolated: false });
    log.info('Exited isolation mode');
    return true;
  }

  /**
   * Toggle isolation mode.
   */
  toggleIsolation() {
    return this._isolationBackup ? this.exitIsolation() : this.enterIsolation();
  }

  isIsolated() {
    return this._isolationBackup != null;
  }

  // ===========================================================================
  // MULTI-VIEW GRID MODE
  // ===========================================================================
  //
  // Shows the workspace's OTHER open VTK views as a grid of datasets inside
  // the active VR scene (proxy actors sharing the source views' mappers —
  // see VRMultiViewGrid). Source views are never mutated, and the grid is
  // strictly session-local: nothing is broadcast to other participants.

  /**
   * Enable grid mode: every other open VTK instance with loaded data appears
   * as a scaled-down dataset in a grid in front of the user.
   * @returns {boolean} true if the grid is now showing at least one view
   */
  enableGridMode() {
    const ctx = this._activeContext?.vrContext;
    const sceneObjects = ctx?.sceneObjects;
    if (!sceneObjects?.renderer) {
      log.warn('Cannot enable grid mode: no active VR context');
      return false;
    }

    const activeInstanceId = this._activeContext.instance?.instanceId;
    const others = [];
    for (const instance of workspaceManager.getInstancesByType('vtk')) {
      if (!instance || instance.instanceId === activeInstanceId) continue;
      const data = instance.instanceData;
      if (!data?.hasData) continue;

      // Prefer the source renderer's full actor list (includes glyphs,
      // annotation lines, etc.); fall back to the primary data actor.
      let actors = [];
      try {
        actors = data.sceneObjects?.renderer?.getActors?.() || [];
      } catch {
        actors = [];
      }
      if (actors.length === 0 && data.sceneObjects?.actor) {
        actors = [data.sceneObjects.actor];
      }
      if (actors.length > 0) {
        others.push({ instanceId: instance.instanceId, actors });
      }
    }

    const shown = vrMultiViewGrid.enable(sceneObjects, others);
    this._emit('gridModeChanged', { enabled: shown > 0, viewCount: shown });
    return shown > 0;
  }

  /**
   * Disable grid mode and remove all proxy actors from the VR scene.
   * @returns {boolean} always false (grid is now inactive)
   */
  disableGridMode() {
    if (vrMultiViewGrid.isEnabled()) {
      vrMultiViewGrid.disable();
      this._emit('gridModeChanged', { enabled: false, viewCount: 0 });
    }
    return false;
  }

  /**
   * Toggle grid mode.
   * @returns {boolean} whether the grid is now enabled
   */
  toggleGridMode() {
    return vrMultiViewGrid.isEnabled() ? this.disableGridMode() : this.enableGridMode();
  }

  isGridModeEnabled() {
    return vrMultiViewGrid.isEnabled();
  }

  /**
   * Highlight/grab a grid placement (instance id). Pass null to clear.
   * @param {string|null} instanceId
   */
  setGridTarget(instanceId) {
    vrMultiViewGrid.setTargeted(instanceId);
  }

  // ===========================================================================
  // SNAPSHOTS (delegated to VRSnapshotManager)
  // ===========================================================================

  async createSnapshot(name) {
    if (!this._snapshotManager) throw new Error('No active session');
    return this._snapshotManager.quickSave(name);
  }

  /**
   * Load a snapshot and reapply the VR-side state it captured.
   *
   * VRSnapshotManager restores the ViewConfiguration (camera, appearance, clip
   * box, ...), but the VR zoom level and navigation mode live on the session's
   * participant record, so they were saved and then never reapplied — "Load"
   * restored strictly less than its name implied. Reapply the LOCAL
   * participant's captured vrScale + mode here, where vrContext and the
   * navigation controller are in scope.
   *
   * Note: vrOrigin is intentionally not restored — createSessionSnapshot does
   * not capture it (see VRExplorationSession.createSessionSnapshot), so there
   * is nothing saved to put back.
   */
  async loadSnapshot(snapshotId) {
    if (!this._snapshotManager) throw new Error('No active session');
    const snapshot = await this._snapshotManager.loadSnapshot(snapshotId);

    try {
      const mine = snapshot?.participantStates?.find(
        (p) => p.odUserId === getParticipantId()
      );
      const vrContext = this._activeContext?.vrContext;
      if (mine && vrContext) {
        if (Number.isFinite(mine.vrScale) && mine.vrScale > 0) {
          vrContext.vrScale = mine.vrScale;
          this._navigationController?.setScale?.(mine.vrScale);
          // Re-ground: _groundY's data-space value depends on vrScale (see
          // PEDESTAL_HEIGHT_M), so restoring a different scale without this
          // would leave the pedestal height stale and drifting.
          if (Array.isArray(vrContext.vrOrigin)) {
            vrContext.vrOrigin[1] = this._groundY(vrContext);
          }
        }
        if (mine.mode) this.setNavigationMode(mine.mode);
      }
    } catch (err) {
      // Never let a partial restore break loading the view snapshot itself.
      log.warn(`VR snapshot: placement restore failed: ${err?.message}`);
    }

    return snapshot;
  }

  getSessionSnapshots() {
    return this._snapshotManager?.getSessionSnapshots() || [];
  }

  // ===========================================================================
  // FRAME LOOP
  // ===========================================================================
  //
  // Frame work is driven by vrManager's own XR rAF loop via the "frame"
  // event (see startExploration's vrManager.on('frame', this._onFrame)) —
  // there is exactly one requestAnimationFrame loop for the whole VR
  // session, owned by VRManager.

  /**
   * Queue heavy work to run at the END of the next XR frame instead of
   * inside the current one. Menu activations run SYNCHRONOUSLY inside the
   * XR rAF callback (VTKVRSpatialUI.update -> VRSpatialMenuModel.activate),
   * so any multi-hundred-millisecond operation there (e.g. glyph rebuild's
   * O(N) subsampled-polydata copy) drops frames — the headset's reprojection
   * shows that up as the world shaking. Draining after this frame's eyes are
   * drawn (see _drainDeferredWork, called from _onFrame) puts the stall
   * between frames instead of inside one.
   *
   * Callers keep all cheap guard/availability logic synchronous and defer
   * only the expensive call plus its sync patch — see toggleGlyphs() for the
   * pattern.
   *
   * @param {string} label - short user-facing status text shown while this
   *   (or an earlier queued) task is pending — see getPendingWorkLabel() and
   *   VRSpatialMenuModel.getStatusLine().
   * @param {Function} fn - the deferred work; invoked with no arguments and
   *   individually try/caught by _drainDeferredWork so a failure here can
   *   never strand the queue or the frame loop.
   * @param {{boundsMayChange?: boolean}} [opts] - boundsMayChange defaults to
   *   true (Threshold/Isosurface/Glyphs substitute the actor with different
   *   bounds). Pass false for tasks that only touch actor/mapper properties
   *   (e.g. representation) so _drainDeferredWork can skip the bounds
   *   readback — see the note there.
   * @private
   */
  _deferHeavy(label, fn, { boundsMayChange = true } = {}) {
    // Coalesce a repeat of the same action. Because the guards run
    // synchronously but the mutation is deferred, a second tap before the
    // drain reads pre-tap state — so double-tapping Threshold used to enqueue
    // toggle() twice (net: off) while the menu optimistically showed "on".
    const tail = this._deferredWork[this._deferredWork.length - 1];
    if (tail && tail.label === label) return;

    this._deferredWork.push({ label, fn, boundsMayChange });
    this._pendingWorkLabel = label;
    this._pendingWorkAtMs = Date.now();
  }

  /**
   * Drain ONE queued task per call — never more, so a burst of taps spreads
   * its cost over several frames instead of front-loading it onto the very
   * next one. Called once per XR frame, at the end, after the eyes are drawn
   * (see _onFrame). Each task is individually try/caught: one throwing task
   * must not prevent the tasks queued behind it from ever draining, and must
   * not strand _pendingWorkLabel on a task that will never run again.
   * @private
   */
  _drainDeferredWork() {
    const task = this._deferredWork.shift();
    if (task) {
      try {
        task.fn();
      } catch (e) {
        log.error(`VR deferred work "${task.label}" failed — ${e?.message}`, e?.stack || e);
      }
      // Threshold/Isosurface/Glyphs SUBSTITUTE a derived actor with different
      // bounds. Refreshing here rather than at each call site means a new one
      // can't forget to — and stale bounds would silently put the grounding
      // plane and the menu's angular clearance on dead geometry. Runs even if
      // the task threw: it may have partially applied.
      // Representation-only changes (see cycleRepresentation/setRepresentation)
      // opt out via boundsMayChange: false — they never touch the actor's
      // bounds, and this synchronous actor.getBounds() readback was extra
      // main-thread work landing in the same XR frame slot that caused the
      // "world shaking" glyph-rebuild bug this comment describes above.
      if (task.boundsMayChange !== false) {
        try {
          this.refreshDataBounds();
        } catch (e) {
          log.warn(`VR dataBounds refresh failed — ${e?.message}`);
        }
      }
    }
    this._pendingWorkLabel = this._deferredWork[0]?.label ?? null;
    this._pendingWorkAtMs = this._pendingWorkLabel ? Date.now() : 0;
  }

  /**
   * @returns {string|null} the label of the currently queued/in-flight
   *   deferred task (see _deferHeavy), or null when nothing is pending. Read
   *   by VRSpatialMenuModel.getStatusLine() so the panel shows "Building
   *   glyphs…" (etc.) instead of silently freezing while the work runs.
   */
  getPendingWorkLabel() {
    if (!this._pendingWorkLabel) return null;
    // TTL. VRSpatialMenuModel.getStatusLine short-circuits on this label
    // unconditionally, so a queue that somehow stops draining would leave the
    // panel reading "Building glyphs…" for the rest of the session, hiding the
    // dataset name, scale and nav mode. Belt and braces with the `finally` in
    // _onFrame that keeps the drain running.
    if (Date.now() - (this._pendingWorkAtMs || 0) > PENDING_WORK_TTL_MS) {
      return null;
    }
    return this._pendingWorkLabel;
  }

  /**
   * @param {{time:number, deltaTime:number, frame:XRFrame, viewerPose:XRViewerPose}} frameData
   */
  _onFrame({ time, deltaTime: deltaTimeMs, frame, viewerPose }) {
    if (!this._activeContext) return;

    const { handler, vrContext } = this._activeContext;
    // Clamp: the upper bound stops a tracking hitch or tab throttle from
    // producing one huge position delta that teleports the user; the lower
    // bound guards against a duplicated timestamp giving dt=0.
    const deltaTime = Math.min(
      0.1,
      Math.max(1e-4, (deltaTimeMs || 16.67) / 1000)
    );

    try {
      if (this._needsPoseCorrection && viewerPose) {
        this._needsPoseCorrection = false;
        this._applyPoseRelativePlacement(vrContext, viewerPose);
      }

      // Get input state
      const inputState = this._gatherInputState(frame);

      // Resolve which hand is "active" this frame BEFORE menu hit-testing
      // (below) or any tool/reticle consumer runs — see
      // _resolveActivePointerHand. Mutates inputState in place (adds a top-
      // level field), so every clone taken from it later this frame
      // (_gateInputState's navInput/toolInput) carries it for free.
      this._resolveActivePointerHand(inputState);

      // A snap-turn (or any other reference-space offset) rotates the frame
      // every subsequent pose is reported in, but is deliberately built to
      // leave head POSITION nearly unchanged (see VRManager.applySnapTurn) —
      // so vrSpatialUI's position-drift re-anchor gate never trips on its
      // own, and its cached anchor would silently desync from the camera and
      // stay frozen there. Force a fresh anchor the frame after any yaw
      // change, before this frame's hitTest() runs.
      const currentYawOffset = vrManager.getYawOffset?.() ?? 0;
      if (currentYawOffset !== this._lastMenuYawOffset) {
        this._lastMenuYawOffset = currentYawOffset;
        vrSpatialUI.forceReanchor?.();
      }

      // Quest: left X is the fast menu toggle. Reopening deliberately creates
      // a fresh anchor at the user's current gaze, so a menu left elsewhere
      // never traps the user into searching for it.
      const menuTogglePressed = !!inputState.controllers?.left?.buttons?.x;
      if (menuTogglePressed && !this._lastMenuToggleButtonState) {
        vrSpatialUI.toggleAtHead(inputState.headPose);
      }
      this._lastMenuToggleButtonState = menuTogglePressed;

      // Cache the floor point under the head. Menu actions (scale presets) run
      // outside the frame loop and have no inputState of their own, but they
      // need a pivot to resize about — see setVRScale.
      const headXR = inputState.headPose?.position;
      if (headXR) {
        this._lastHeadFloorXR = [headXR.x, 0, headXR.z];
      }

      // INPUT ARBITRATION (R2). The floating spatial menu must be interactable
      // without its pinches also firing tools/teleport. So the menu hit-tests
      // the RAW input FIRST — before nav/tools — and reports whether the
      // pointer is over a button. We then hand nav and the tools a shallow-
      // cloned inputState with the offending trigger stripped, never mutating
      // the object _gatherInputState returned (other consumers below — pose
      // sync, avatars, pointer broadcast — still read the raw poses).
      //
      // Isolated in its own try/catch (unlike the rest of this frame body,
      // which shares one try/catch below): vrSpatialUI.hitTest() is the
      // newest, highest-risk per-frame call (canvas/texture work upstream of
      // it in the same module), and this whole method runs every frame — an
      // uncaught throw here would repeat on every subsequent frame and stall
      // nav/tools/avatar sync right along with the menu. Isolating it means a
      // menu-only failure stays menu-only, and gets logged instead of
      // silently freezing the session.
      //
      // FRAME-ORDER CONTRACT: this is PHASE 1 (hitTest) of the menu's
      // per-frame update, deliberately called here — before navigation below
      // mutates vrContext.vrScale/vrOrigin — because it's pure XR-metre
      // geometry (head/controller poses), entirely independent of that
      // transform. PHASE 2 (layout, which DOES depend on the transform) runs
      // later, after nav — see the vrSpatialUI.layout() call below
      // vrEnvironment.updateTransform(). Splitting it this way fixes a
      // one-frame placement lag: previously, calling the combined update()
      // here meant the panel's actors were positioned using vrContext's
      // transform from frame N-1 while the camera rendered frame N, so the
      // panel would visibly swim against the world by up to a frame's worth
      // of the user's locomotion/scale distance whenever they moved.
      let menuResult = null;
      try {
        menuResult = vrSpatialUI.hitTest(inputState) || null;
      } catch (e) {
        log.error(`VR frame: vrSpatialUI.hitTest failed — ${e?.message}`, e?.stack || e);
      }
      const menuHovering = !!menuResult?.hovering;
      const menuHand = menuResult?.hand || 'right';
      const menuConsumesTrigger = menuResult?.consumingTrigger ?? menuHovering;
      const menuConsumesGrip = !!menuResult?.consumingGrip;
      // A pinch used to place/aim an active tool must not ALSO aim teleport.
      const toolActive = !!this._toolManager?.getActiveTool?.();

      // INPUT GATING: in the new layered model, grip stays ALWAYS ON for
      // world-grab navigation; only trigger is gated by menu/tool. Grip is
      // never stripped so pulling the world is always available (standard VR
      // convention, e.g. Meta Quest 3 — the hand is never "interrupted" by UI).
      const navStripHands = new Set();
      const toolStripHands = new Set();
      const navStripGripHands = new Set();
      const toolStripGripHands = new Set();
      if (menuConsumesTrigger) {
        navStripHands.add(menuHand);
        toolStripHands.add(menuHand);
      }
      if (menuConsumesGrip) {
        // Grip normally remains world-grab. While it is actively moving the
        // menu header, however, that one hand belongs to the menu.
        navStripGripHands.add(menuHand);
        toolStripGripHands.add(menuHand);
      }
      if (toolActive) {
        // Strip both hands' triggers from nav/tools so a tool placement never
        // drives object-move or menu hover. Grip remains (world navigation).
        navStripHands.add('left');
        navStripHands.add('right');
      }
      const navInput = this._gateInputState(inputState, navStripHands, navStripGripHands);
      const toolInput = this._gateInputState(inputState, toolStripHands, toolStripGripHands);

      // NOTE: Vision Pro input detection (transient-pointer) used to trigger a
      // mode switch here, but the new layered model handles it transparently:
      // the world-grab predicate checks isTransientPointer and routes pinches
      // correctly (pinch = grip on Vision Pro, squeeze on tracked controllers).
      // Locomotion (left stick) and snap turn (right stick) still work on
      // Vision Pro even though there's no hardware stick (they read zero but
      // don't hurt). The first time the user pinches, it will pull the world
      // (world-grab via the injected grip predicate) — no mode switch needed.

      // Update navigation (handles movement, teleport, scale). Nav consumes the
      // arbitration-gated clone so a menu pinch / tool pinch can't drive it.
      //
      // Guarded from here down to the tool update: these steps sit UPSTREAM of
      // the participant broadcast below, and used to share one try with it, so
      // any throw here stopped this headset from publishing its pose — every
      // frame, silently, for the rest of the session. Losing a frame of
      // navigation is recoverable; losing presence entirely is not.
      this._safeFrameStep('navigation', () => {
        if (!this._navigationController) return;
        const navResult = this._navigationController.update(navInput, frame, deltaTime);

        // Apply navigation result to VR context
        if (navResult.vrScale !== null) {
          vrContext.vrScale = navResult.vrScale;
        }
        if (navResult.vrRotation != null) {
          // Two-hand twist yaw. Applied to the data actor (turntable spin) by
          // the handler each frame from vrContext.vrRotation — see
          // VTKInstanceHandler._applyVRDataRotation.
          vrContext.vrRotation = navResult.vrRotation;
        }
        if (navResult.position) {
          vrContext.vrOrigin = [
            navResult.position.x,
            navResult.position.y,
            navResult.position.z,
          ];
        }

        // Persist the new placement to the ViewConfiguration on gesture END
        // only (grab release / teleport commit), never per drag frame.
        if (navResult.grabEnded || navResult.teleporting) {
          this._persistVRHints(vrContext);
        }
      });

      // In-VR follow: soft positional lerp toward the target participant.
      // Real locomotion input (thumbstick/teleport trigger) always wins and
      // cancels follow — mirrors followService's desktop
      // auto-unfollow-on-manual-move semantics. Reads the nav-gated clone so a
      // menu/tool pinch doesn't read as "the user is moving".
      this._safeFrameStep('follow', () => {
        if (!this._followTargetUserId) return;
        if (this._hasLocomotionInput(navInput)) {
          this.stopFollowing();
        } else {
          this._updateParticipantFollow(vrContext, deltaTime);
        }
      });

      // B button (right controller) toggles isolation mode: pull the model
      // to room scale for walk-around inspection, press again to restore.
      const bPressed = inputState.controllers?.right?.buttons?.b || false;
      if (bPressed && !this._lastIsolationButtonState) {
        this._safeFrameStep('isolation-toggle', () => this.toggleIsolation());
      }
      this._lastIsolationButtonState = bPressed;

      // Update tools with the arbitration-gated clone so a pinch aimed at a
      // menu button never also fires the active tool.
      this._safeFrameStep('tools', () => {
        const toolAction = this._toolManager?.update(toolInput, frame);
        if (toolAction) {
          this._handleToolAction(toolAction);
        }
      });

      // STEP 6.5 — pointer ray. Computed HERE, between the tools and the
      // participant broadcast, for one reason: its result has to ride along in
      // the same updateLocalState payload below, so a remote viewer never
      // renders a head pose from frame N against a pointer from frame N-1.
      // Cheap by construction — a quaternion rotate plus one mapXRPointToData,
      // both of which the old inline _broadcastPointerRay already paid — and
      // the only expensive part (the surface pick) is capped at 10 Hz inside
      // and skipped entirely while the menu is hovered.
      // Guarded: a pick failure must degrade to "no ray this frame", not cost
      // the pose broadcast on the next line.
      const pointerRay = this._safeFrameStep('pointer-ray', () =>
        this._computePointerRay(inputState, vrContext, { skipPick: menuHovering })
      );

      // Update participant sync. Head/hand poses are in THIS user's own
      // physical XR space (each participant has an independent WebXR
      // session/reference space) — vrScale/vrOrigin travel alongside so
      // remote viewers can convert into the one shared frame, data space,
      // using the SENDER's transform rather than their own (see
      // RemoteAvatarController._toScenePose).
      //
      // Guarded in its own right so that even a malformed pose can't take down
      // the steps after it (avatars, the handler's stereo draw).
      this._safeFrameStep('participant-broadcast', () =>
        this._participantSync?.updateLocalState({
          headPose: inputState.headPose,
          leftHandPose: inputState.controllers?.left?.pose,
          rightHandPose: inputState.controllers?.right?.pose,
          vrScale: vrContext.vrScale || 1.0,
          vrOrigin: vrContext.vrOrigin || [0, 0, 0],
          // XR metres (converted by the receiver with the transform above)...
          pointer: pointerRay,
          // ...and the surface hit, which is ALREADY data space and shared by
          // every viewer — see VRParticipantSync.updateLocalState.
          pointerHit: pointerRay?.hit || null,
        })
      );

      // Shared vr-sessions registry housekeeping — heartbeat + host-promotion
      // check (see _tickVRSessionRegistry) — throttled to VR_SESSION_HEARTBEAT_MS,
      // same Date.now()-guard style as the pointer pick throttle above.
      const nowForVRSessionRegistry = Date.now();
      if (nowForVRSessionRegistry - this._lastVRSessionHeartbeat >= VR_SESSION_HEARTBEAT_MS) {
        this._lastVRSessionHeartbeat = nowForVRSessionRegistry;
        this._safeFrameStep('vr-session-registry', () =>
          this._tickVRSessionRegistry(
            this._resolveSessionKey(this._activeContext?.instance),
            this._activeSession
          )
        );
        // Same 1 Hz budget: refresh our hold on the data-control token, or (as
        // host) reclaim one whose holder went stale. Internally throttled too,
        // so sharing this tick is belt-and-braces rather than load-bearing.
        try {
          this._manipulationLock?.heartbeat();
        } catch (err) {
          log.warn(`VR manipulation heartbeat failed: ${err?.message}`);
        }

        // Server SESSION liveness heartbeat (Issue 6) — piggybacks on this
        // 1Hz tick only for scheduling convenience; it runs at its own,
        // far coarser SERVER_SESSION_HEARTBEAT_MS cadence via this separate
        // gate. No-op for a local vrsession_* id (see
        // _sendServerSessionHeartbeat).
        if (nowForVRSessionRegistry - this._lastServerSessionHeartbeat >= SERVER_SESSION_HEARTBEAT_MS) {
          this._lastServerSessionHeartbeat = nowForVRSessionRegistry;
          this._safeFrameStep('server-session-heartbeat', () => this._sendServerSessionHeartbeat());
        }
      }

      // Broadcast the active controller ray so desktop collaborators can see
      // where this VR user is pointing (throttled inside vrCursorSync).
      this._safeFrameStep('pointer-ray-broadcast', () =>
        this._broadcastPointerRay(pointerRay)
      );

      // Update avatar system
      this._safeFrameStep('avatars', () => vrAvatarSystem.update(deltaTime, inputState));

      // Everything that can mutate vrContext.vrScale/vrOrigin has now run:
      // navigation, participant-follow, the B-button isolation toggle, and
      // tool actions. Place the world-anchored in-scene geometry LAST, so it
      // uses exactly the transform this frame's camera is about to render
      // with.
      //
      // Keep the floor/environment anchored under the user as they
      // teleport/fly/scale/follow (no-ops internally if nothing changed).
      vrEnvironment.updateTransform(vrContext.vrScale, vrContext.vrOrigin);

      // FRAME-ORDER CONTRACT (see the vrSpatialUI.hitTest() call above): this
      // is PHASE 2 (layout) of the menu's per-frame update — placement only.
      // hitTest ran at the top of the frame because it is pure XR-metre
      // geometry and its result has to gate nav/tool input; layout runs here
      // because it is the only half that depends on vrScale/vrOrigin.
      // Previously the combined update() ran at the top, so the panel was
      // positioned with frame N-1's transform while the camera rendered frame
      // N — the panel visibly swam against the world by a frame's worth of
      // the user's locomotion whenever they moved. Isolated in its own
      // try/catch for the same reason as hitTest() — a menu-only placement
      // failure must not stall the handler's draw.
      try {
        vrSpatialUI.layout({
          vrScale: vrContext.vrScale,
          vrOrigin: vrContext.vrOrigin,
          // Consumed by the panel's adaptive side-offset, which needs the
          // dataset's angular size to know how far to sit beside it.
          dataBounds: vrContext.dataBounds,
        });
      } catch (e) {
        log.error(`VR frame: vrSpatialUI.layout failed — ${e?.message}`, e?.stack || e);
      }

      // Let handler update VR rendering (synchronous stereo render — see
      // VTKInstanceHandler.updateVRExploration). Gets the tool-gated clone so a
      // menu pinch doesn't leak into the handler's own interaction handling.
      handler.updateVRExploration?.(vrContext, frame, toolInput, viewerPose);

      // Emit frame event for UI
      this._emit('frame', { time, inputState, deltaTime });

    } catch (error) {
      // BACKSTOP ONLY. The steps that used to make this catch load-bearing —
      // navigation, follow, isolation, tools, pointer ray, the participant
      // broadcast, avatars — are each wrapped in _safeFrameStep now, precisely
      // so that one of them throwing can no longer skip the presence broadcast
      // downstream of it and freeze this headset's avatar for every peer.
      //
      // What still reaches here is the genuinely frame-fatal set: pose
      // correction, _gatherInputState (without inputState the rest is
      // meaningless), the input gating, and the handler's stereo draw.
      const signature = error?.message || String(error);
      if (this._lastFrameErrorSignature !== signature) {
        this._lastFrameErrorSignature = signature;
        log.error(
          `Error in VR frame loop: ${signature}`,
          error?.stack || error
        );
      }
    } finally {
      // Drain one deferred heavy task, now that both eyes for THIS frame have
      // been drawn.
      //
      // MUST be in `finally`. It used to sit at the end of the try block,
      // downstream of ~9 unguarded calls (input gathering, navigation, tools,
      // avatars, the handler's draw). Any of those throwing skipped the drain —
      // and because the cause is per-frame state, it skipped it on every
      // subsequent frame too. The queue then grew forever and Glyphs, Style,
      // Threshold and Isosurface silently stopped applying while the session
      // carried on rendering normally, with only a log line to show for it.
      try {
        this._drainDeferredWork();
      } catch (e) {
        log.error(`VR deferred drain failed — ${e?.message}`, e?.stack || e);
      }
    }
  }

  /**
   * True if the user is actively driving locomotion this frame (thumbstick
   * past deadzone, or the teleport trigger held) — used to cancel in-VR
   * follow the moment the user tries to move themselves.
   * @private
   */
  _hasLocomotionInput(inputState) {
    const mag = (c) =>
      c?.thumbstick ? Math.hypot(c.thumbstick.x || 0, c.thumbstick.y || 0) : 0;
    const left = inputState.controllers?.left;
    const right = inputState.controllers?.right;
    return mag(left) > 0.15 || mag(right) > 0.15 || !!right?.triggerPressed;
  }

  /**
   * Return a SHALLOW clone of the frame's input state with trigger and/or grip
   * stripped from the named hands. Used for input
   * arbitration (R2): the object _gatherInputState returned is never mutated —
   * the menu and pose/avatar consumers keep reading the raw triggers/poses —
   * while nav and tools receive a gated copy so a menu interaction doesn't
   * also drive locomotion. Thumbsticks, poses and face buttons pass through.
   *
   * @param {Object} inputState - raw state from _gatherInputState
   * @param {Set<string>|Array<string>} triggerHands - hands whose trigger is stripped
   * @param {Set<string>|Array<string>} gripHands - hands whose grip is stripped
   * @returns {Object} the same object if nothing to strip, else a gated clone
   * @private
   */
  _gateInputState(inputState, triggerHands, gripHands = []) {
    const triggerList = triggerHands instanceof Set ? [...triggerHands] : triggerHands || [];
    const gripList = gripHands instanceof Set ? [...gripHands] : gripHands || [];
    if (!triggerList.length && !gripList.length) return inputState;
    const clone = { ...inputState, controllers: { ...inputState.controllers } };
    for (const hand of new Set([...triggerList, ...gripList])) {
      const c = clone.controllers?.[hand];
      if (c) {
        clone.controllers[hand] = {
          ...c,
          ...(triggerList.includes(hand) ? { triggerPressed: false, triggerValue: 0 } : {}),
          ...(gripList.includes(hand) ? { squeezePressed: false, squeezeValue: 0 } : {}),
        };
      }
    }
    return clone;
  }

  /**
   * Persist the current VR placement (vrScale / vrOrigin / mode) onto the
   * active ViewConfiguration so the "where the data sits" survives the session
   * (R4 — position must not feel fixed, but the last placement should stick).
   * Fired only on gesture END (grab release / teleport commit). Fire-and-forget
   * and fully guarded — it must never throw into the XR frame loop.
   * @param {Object} vrContext
   * @private
   */
  _persistVRHints(vrContext) {
    try {
      const viewId = this._activeContext?.instance?.viewConfigId;
      if (!viewId) return;
      const view = getViewConfigurationManager()?.getView?.(viewId);
      if (typeof view?.updateVRHints !== 'function') return;
      const origin = vrContext?.vrOrigin || [0, 0, 0];
      view.updateVRHints({
        vrScale: vrContext?.vrScale,
        vrOrigin: [origin[0], origin[1], origin[2]],
        explorationMode: this.getNavigationMode(),
      });
    } catch (err) {
      log.warn(`VR hints persist failed: ${err?.message}`);
    }
  }

  /**
   * Per-frame soft positional follow: lerps vrOrigin toward standing near
   * the followed participant's current position. Never touches orientation.
   * Auto-stops if the target's position becomes unknown (e.g. they left).
   * @private
   */
  _updateParticipantFollow(vrContext, deltaTime) {
    const targetPos = this._getParticipantDataPosition(this._followTargetUserId);
    if (!targetPos) {
      this.stopFollowing();
      return;
    }

    const vrScale = vrContext.vrScale || 1.0;
    const desired = [targetPos[0], targetPos[2] + 1.5 / vrScale];

    // ~0.5s settle time regardless of frame rate. Only X/Z are lerped — Y is
    // pinned to the ground plane so following someone walks you across the
    // floor rather than drifting you up to their altitude, and so follow can
    // never un-ground the dataset (see _groundY).
    const alpha = Math.min(1, deltaTime * 2);
    const origin = vrContext.vrOrigin || [0, 0, 0];
    vrContext.vrOrigin = [
      origin[0] + (desired[0] - origin[0]) * alpha,
      this._groundY(vrContext),
      origin[2] + (desired[1] - origin[2]) * alpha,
    ];
  }

  /**
   * Compute this frame's pointer ray for the active hand (right wins when both
   * are tracked), plus — at most 10x/s — where that ray meets the geometry.
   *
   * Two consumers, TWO COORDINATE FRAMES, and mixing them up is the whole
   * subtlety here:
   *  - `origin`/`direction` are the SENDER's raw XR metres. They go to
   *    VRParticipantSync, and RemoteAvatarController._toScenePose converts them
   *    with this sender's vrScale/vrOrigin, because every participant has a
   *    physically distinct WebXR reference space. Pre-converting them here
   *    would make the receiver apply the transform twice.
   *  - `dataOrigin` is the same point already mapped to data space, for the
   *    desktop broadcast (VTKRemoteVRRays renders in data space directly).
   *  - `hit` is a point ON the shared geometry, so it is data space for
   *    everyone and is never re-transformed by anyone.
   *
   * Never throws: the pointer is cosmetic and must not be able to break the
   * frame loop (the callers below rely on this, as does _broadcastPointerRay).
   *
   * @param {object} inputState - from _gatherInputState
   * @param {object} vrContext
   * @param {{skipPick?: boolean}} [opts] - skipPick while the spatial menu is
   *   hovered: the ray is aimed at the panel, not the data, so picking would
   *   burn a vtkCellPicker pass to (correctly) find nothing.
   * @returns {{origin:{x:number,y:number,z:number},
   *   dataOrigin:{x:number,y:number,z:number},
   *   direction:{x:number,y:number,z:number},
   *   hand:'left'|'right',
   *   hit:{position:{x:number,y:number,z:number},pointId:number,cellId:number,
   *     datasetId:string|null,actorRole:string|null}|null}|null}
   * @private
   */
  _computePointerRay(inputState, vrContext, { skipPick = false } = {}) {
    try {
      const hand = inputState?.controllers?.right?.pose
        ? 'right'
        : inputState?.controllers?.left?.pose
          ? 'left'
          : null;
      if (!hand) return null;

      const controller = inputState.controllers[hand];
      const pose = controller.pose;
      if (!pose?.position || !pose?.orientation) return null;

      const dataOrigin = mapXRPointToData(
        pose.position,
        vrContext?.vrScale || 1.0,
        vrContext?.vrOrigin || [0, 0, 0]
      );
      const dir = controllerForward(pose.orientation);

      return {
        origin: { x: pose.position.x, y: pose.position.y, z: pose.position.z },
        dataOrigin: { x: dataOrigin[0], y: dataOrigin[1], z: dataOrigin[2] },
        direction: { x: dir[0], y: dir[1], z: dir[2] },
        hand,
        hit: this._pickPointerHit(controller, vrContext, skipPick),
      };
    } catch {
      // pointer is cosmetic — never break the frame loop
      return null;
    }
  }

  /**
   * Throttled surface pick for the pointer's hit marker. Returns the cached
   * result between picks so the caller can treat it as a per-frame value.
   *
   * Carries the same identity fields raycastVR resolves (pointId/cellId/
   * datasetId/actorRole) — not just the bare position — because this same
   * pick rides into VRParticipantSync.updateLocalState (see the call site
   * in the frame loop) and out to every collaborator's remote-avatar hit
   * marker, so the "what am I currently pointing at" signal is broadcast in
   * real time, not just used cosmetically for the dot's position.
   *
   * @param {object} controller - inputState.controllers[hand]
   * @param {object} vrContext
   * @param {boolean} skipPick
   * @returns {{position:{x:number,y:number,z:number},pointId:number,
   *   cellId:number,datasetId:string|null,actorRole:string|null}|null}
   * @private
   */
  _pickPointerHit(controller, vrContext, skipPick) {
    // Aimed at the menu: drop the cache too, or the dot would hang on the last
    // surface point while the user works the panel.
    if (skipPick) {
      this._lastPointerHit = null;
      return null;
    }

    const now = Date.now();
    const cached = this._lastPointerHit;
    if (cached && now - cached.atMs < POINTER_PICK_MS) return cached.pick;

    const handler = this._activeContext?.handler;
    if (typeof handler?.raycastVR !== 'function' || !controller?.targetRay) {
      this._lastPointerHit = { pick: null, atMs: now };
      return null;
    }

    let pick = null;
    try {
      // Same call convention as VRAnnotationTool._performRaycast — raycastVR
      // accepts the XRRigidTransform targetRay directly and returns
      // { hit, position, pointId, cellId, datasetId, actorRole, ... } in
      // data space.
      const result = handler.raycastVR(vrContext, controller.targetRay);
      if (result?.hit && result.position) {
        // The aiming reticle/dot should track the raw ray-surface
        // intersection (surfacePosition) so it slides smoothly across the
        // mesh, not jump between vertices — vertex-snapped `position` is for
        // callers persisting/rendering something BY pointId (annotations),
        // not this general-purpose cursor.
        const cursorPosition = result.surfacePosition || result.position;
        pick = {
          position: { x: cursorPosition.x, y: cursorPosition.y, z: cursorPosition.z },
          pointId: result.pointId ?? -1,
          cellId: result.cellId ?? -1,
          datasetId: result.datasetId ?? null,
          actorRole: result.actorRole ?? null,
        };
      }
    } catch {
      // Swallow, but still stamp the cache below so a persistently throwing
      // picker is retried at 10 Hz rather than 90 Hz.
      pick = null;
    }

    this._lastPointerHit = { pick, atMs: now };
    return pick;
  }

  /**
   * Publish an already-computed pointer ray (in DATA space, so desktop views can
   * render it directly) via vrCursorSync.
   * Never throws — pointer visibility must not break the frame loop.
   *
   * @param {ReturnType<VRExplorationManager['_computePointerRay']>} ray
   * @private
   */
  _broadcastPointerRay(ray) {
    try {
      if (!ray) return;
      const viewId = this._activeContext?.instance?.viewConfigId;
      if (!viewId) return;

      vrCursorSync.broadcastVRPointer(viewId, ray.dataOrigin, ray.direction, ray.hand);
    } catch {
      // pointer broadcast is cosmetic — never break the frame loop
    }
  }

  /**
   * Resolve which hand's controller should be treated as "active" this
   * frame — the single source of truth menu hit-testing, tool input (e.g.
   * VRAnnotationTool), and the aiming reticle all read, instead of each
   * independently hardcoding a right-hand-first preference (the cause of
   * left-handed/left-only interaction silently failing to route triggers).
   *
   * Rule: prefer whichever hand produced a trigger RISING EDGE this frame;
   * if neither did, hold the previously-resolved hand while its trigger is
   * still held; if neither hand's trigger is held, fall back to 'right'
   * (today's long-standing default), so idle frames render identically to
   * before this existed.
   *
   * Mutates `inputState` in place (adds `activePointerHand`) rather than
   * returning a value the caller must thread through — _gateInputState's
   * clone (`{ ...inputState, controllers: {...} }`) is a shallow spread of
   * all top-level keys, so the field survives into navInput/toolInput for
   * free.
   * @private
   */
  _resolveActivePointerHand(inputState) {
    const leftPressed = !!inputState.controllers?.left?.triggerPressed;
    const rightPressed = !!inputState.controllers?.right?.triggerPressed;
    const leftRising = leftPressed && !this._lastTriggerPressed.left;
    const rightRising = rightPressed && !this._lastTriggerPressed.right;
    this._lastTriggerPressed.left = leftPressed;
    this._lastTriggerPressed.right = rightPressed;

    let hand;
    if (leftRising && !rightRising) hand = 'left';
    else if (rightRising && !leftRising) hand = 'right';
    else if (leftRising && rightRising) hand = this._lastActivePointerHand; // simultaneous — keep sticky
    else if (leftPressed && !rightPressed) hand = 'left';
    else if (rightPressed && !leftPressed) hand = 'right';
    else if (leftPressed && rightPressed) hand = this._lastActivePointerHand;
    else hand = 'right'; // neither pressed — stable default

    this._lastActivePointerHand = hand;
    inputState.activePointerHand = hand;
    return hand;
  }

  _gatherInputState(frame) {
    const session = frame.session;
    // vrManager owns the session, so its reference space is always valid by
    // the time frames are flowing — no per-frame fallback request needed
    // (requestReferenceSpace() returns a Promise, which was never usable
    // synchronously by frame.getPose() below anyway).
    const referenceSpace = vrManager.getReferenceSpace();

    const state = {
      headPose: null,
      controllers: {
        left: null,
        right: null,
      },
      hands: {
        left: null,
        right: null,
      },
    };

    // Get head pose
    try {
      const viewerPose = frame.getViewerPose(referenceSpace);
      if (viewerPose) {
        state.headPose = viewerPose.transform;
      }
    } catch (e) {
      // Reference space not ready
    }

    // Get controller states
    for (const source of session.inputSources) {
      // NOTE: hand-tracked sources are NOT skipped.
      //
      // This used to be `if (source.hand) continue;`, which silently discarded
      // every input source carrying an XRHand — while 'hand-tracking' is
      // requested as an optional feature on session start (see enterVR's
      // optionalFeatures below). Whenever the runtime attached a hand to the
      // pinch/transient source, or the user simply put the controllers down,
      // inputState.controllers stayed { left: null, right: null } and EVERY
      // tool received nothing at all, with no error and no visible symptom.
      //
      // A hand-tracked source still exposes targetRaySpace, so it falls
      // through to the gripless branch below and is treated exactly like a
      // Vision Pro transient pointer — which is the right model for it: aim
      // along the target ray, pinch to select, no thumbstick, no grip.
      if (source.hand && !source.targetRaySpace) {
        // Nothing to aim with — no ray, no pose, nothing a tool could use.
        continue;
      }

      if (source.gripSpace && !source.hand) {
        const handedness = source.handedness;
        try {
          const gripPose = frame.getPose(source.gripSpace, referenceSpace);
          const targetRayPose = source.targetRaySpace
            ? frame.getPose(source.targetRaySpace, referenceSpace)
            : null;

          state.controllers[handedness] = {
            pose: gripPose?.transform,
            targetRay: targetRayPose?.transform,
            gamepad: source.gamepad,
            isTransientPointer: false,
            triggerPressed:
              source.gamepad?.buttons?.[0]?.pressed ||
              vrManager.isSelectPressed(source),
            triggerValue: source.gamepad?.buttons?.[0]?.value || 0,
            squeezePressed: source.gamepad?.buttons?.[1]?.pressed || false,
            squeezeValue: source.gamepad?.buttons?.[1]?.value || 0,
            thumbstick: {
              x: source.gamepad?.axes?.[2] || 0,
              y: source.gamepad?.axes?.[3] || 0,
            },
            buttons: {
              a: handedness === 'right' && !!source.gamepad?.buttons?.[4]?.pressed,
              b: handedness === 'right' && !!source.gamepad?.buttons?.[5]?.pressed,
              x: handedness === 'left' && !!source.gamepad?.buttons?.[4]?.pressed,
              y: handedness === 'left' && !!source.gamepad?.buttons?.[5]?.pressed,
            },
          };
        } catch (e) {
          // Pose not available
        }
      } else if (source.targetRaySpace) {
        // Gripless sources: Vision Pro "transient-pointer" (gaze + pinch).
        // No grip space, usually no gamepad, and handedness may be "none" —
        // map "none" to "right" so tools that read controllers.right work.
        try {
          const targetRayPose = frame.getPose(source.targetRaySpace, referenceSpace);
          if (!targetRayPose) continue;

          // Resolve which hand slot this gripless source fills. visionOS often
          // reports handedness "none" for pinch sources; assign it to whichever
          // slot is still free so TWO simultaneous pinches populate both hands
          // (required for the two-hand scale + twist gesture) rather than
          // collapsing onto "right".
          let handedness =
            source.handedness && source.handedness !== 'none'
              ? source.handedness
              : null;
          if (!handedness) {
            handedness = !state.controllers.right
              ? 'right'
              : !state.controllers.left
                ? 'left'
                : null;
            if (!handedness) continue; // both hands already filled
          }

          // Don't overwrite a real tracked controller for the same hand
          if (state.controllers[handedness]) continue;

          state.controllers[handedness] = {
            pose: targetRayPose.transform,
            targetRay: targetRayPose.transform,
            gamepad: source.gamepad || null,
            targetRayMode: source.targetRayMode,
            isTransientPointer: true,
            triggerPressed:
              source.gamepad?.buttons?.[0]?.pressed ||
              vrManager.isSelectPressed(source),
            triggerValue: source.gamepad?.buttons?.[0]?.value || 0,
            squeezePressed: false,
            squeezeValue: 0,
            thumbstick: { x: 0, y: 0 },
            buttons: { a: false, b: false, x: false, y: false },
          };
        } catch (e) {
          // Pose not available
        }
      }
    }

    return state;
  }

  _handleToolAction(action) {
    log.debug('Tool action:', action);

    switch (action.type) {
      case 'annotation-pending':
        // Point fixed, keyboard open — nothing persisted or broadcast yet.
        // Reached only from VRAnnotationTool.handleInput's trigger placement.
        this._emit('annotationPending', action.data);
        break;
      case 'annotation-created':
        // Reached only from confirmAnnotationDraft() now (Save) — the old
        // instant-place-on-trigger path is gone.
        this._emit('annotationCreated', action.data);
        this._persistVRAnnotation(action.data);
        break;
      case 'annotation-cancelled':
        // Draft discarded — nothing was ever persisted, so nothing to delete.
        this._emit('annotationCancelled', action.data);
        break;
      case 'annotation-removed':
        this._emit('annotationRemoved', action.data);
        this._deletePersistedVRAnnotation(action.data);
        break;
      case 'measurement-start-placed':
        // First point of a chained path — nothing to persist until it closes
        // a segment, but observers want to know a measurement has begun.
        this._emit('measurementStartPlaced', action.data);
        break;
      case 'measurement-created':
        this._emit('measurementCreated', action.data);
        this._persistVRMeasurement(action.data);
        break;
      case 'measurement-removed':
        this._emit('measurementRemoved', action.data);
        // Undo must also remove the SERVER-side annotation, or an undone
        // segment reappears for everyone else (and on reload). Works unchanged
        // for measurements: same annotation store, keyed on the serverId that
        // _persistVRMeasurement back-fills onto this same object.
        this._deletePersistedVRAnnotation(action.data);
        break;
      case 'measurement-cancelled':
        this._emit('measurementCancelled', action.data ?? null);
        break;
      case 'measurement-path-completed':
        this._emit('measurementPathCompleted', action.data);
        break;
      case 'probe-created':
        // Probe results are intentionally session-local (transient inspection).
        this._emit('probeCreated', action.data);
        break;
      case 'clip-box-updated': {
        this._emit('clipBoxUpdated', action.data);
        // Phase D5: already gesture-shaped (final:false during the drag,
        // final:true once on release) — begin on the first non-final
        // frame, end once the release frame pushes. The one-shot
        // invert/reset/cycleAxis actions (see invertClipPlane etc.) arrive
        // here as a single final:true with no preceding false frame, so
        // _clipGestureActive never opens for them and this is a no-op past
        // the existing _pushVisualizationPatch gate.
        const clipInstanceId = this._activeContext?.vrContext?.instanceId;
        if (!action.data?.final && !this._clipGestureActive) {
          this._clipGestureActive = this._beginGestureSync('clipBox', clipInstanceId);
        }
        // Sync/persist only on gesture end — not every drag frame.
        if (action.data?.final) {
          const config = clipInstanceId
            ? vtkClippingFeature.getConfigForSync(clipInstanceId)
            : null;
          if (config) this._pushVisualizationPatch({ clipBox: config });
          if (this._clipGestureActive) {
            this._clipGestureActive = false;
            this.endManipulationGesture('clipBox');
          }
        }
        break;
      }
      default:
        // Session-local tool feedback (probe-*, clip-grab-start, ...). Emitted
        // for observers; nothing persisted. A default arm exists so a newly
        // added action type can never again be silently swallowed — several
        // were, which is how tools appeared to half-work.
        this._emit('toolAction', action);
        break;
    }
  }

  /**
   * Push a VR-manipulated visualization patch (clipBox / representation / glyph)
   * to collaborators + persistence via the same channel the desktop menus use
   * (visualizationSyncService → Y.js broadcast + ViewConfiguration), so an
   * in-VR change is identical to a desktop one. Fire-and-forget: must never
   * block or break the XR frame loop.
   * THE single choke point for shared data changes, and therefore the single
   * place the manipulation token is enforced: clip / representation / glyph /
   * threshold / isosurface all call this directly, and _pushObjectTransformPatch
   * funnels through it too, so one guard covers every one of them.
   *
   * @param {object} patch - e.g. { representation: 'wireframe' } or { clipBox: {...} }
   * @private
   */
  _pushVisualizationPatch(patch) {
    try {
      if (!patch) return;
      const key = Object.keys(patch)[0];
      const label = PATCH_LABELS[key] || 'That change';

      const instance = this._activeContext?.instance;
      const viewId = instance?.viewConfigId;
      if (!viewId) {
        // A view opened without a server-side ViewConfiguration has a null
        // viewConfigId. The local change still applies, but there is nothing
        // to broadcast it against, so the peer never sees it. Silent until
        // now — and indistinguishable in-headset from a working sync.
        this._flashVRNotice(`${label} is local only — this view isn't shared`);
        return;
      }

      if (!this._requireManipulationControl(label)) return;

      // Filters (threshold/isosurface/glyph/clip) read as "filtering" work to
      // desktop observers; everything else is a change to the dataset itself.
      this._signalManipulation(FILTER_PATCH_KEYS.has(key) ? 'filter' : 'dataset');

      // Same key VR session convergence uses (_resolveSessionKey): the peer
      // headset opened this dataset itself and holds a DIFFERENT viewConfigId,
      // so viewId alone would address a view no one else has.
      Promise.resolve(
        pushSharedVisualizationUpdate(
          viewId,
          patch,
          resolveViewSyncKey(instance),
          this._buildMutationMeta()
        )
      )
        .then((result) => {
          // The service REFUSES by RETURNING { persisted: false, reason },
          // it does not throw — so the .catch() below never fires for the
          // most common failure. That made a refused sync completely silent
          // in VR: the local view changed, the other headset never saw it,
          // and nothing explained why.
          //
          // `transmitted` is the case that is NOT a failure: with no active
          // workspace the peer still receives the change, there is just no
          // ViewConfiguration to persist it to. Reporting that as "not shared"
          // would be exactly backwards.
          if (!result || result.persisted || result.transmitted) return;
          this._flashVRNotice(
            result.reason === 'permission-denied'
              ? `${label} not shared — view is read-only for your role`
              : `${label} not shared — no view to share it against`
          );
        })
        .catch((err) => log.warn(`VR visualization sync failed: ${err?.message}`));
    } catch (err) {
      log.warn(`VR visualization sync failed: ${err?.message}`);
    }
  }

  /**
   * Broadcast the active dataset's full transform (position/rotation/scale) after
   * an in-VR object move, reusing the desktop InstanceToolsPanel patch shape
   * ({ transform: { position:[x,y,z], rotation:[x,y,z], scale:[x,y,z] } }). The
   * whole transform is always sent because the Y.js/ViewConfiguration merge is
   * shallow. Non-final (mid-drag) frames are throttled to ~20/sec; the final
   * frame (gesture release) is always sent so the resting pose is authoritative.
   * @param {boolean} final - true on gesture release
   * @private
   */
  _pushObjectTransformPatch(final) {
    try {
      const instanceId = this._activeContext?.instance?.instanceId;
      if (!instanceId) return;

      // Phase D5: begin the gesture on the FIRST non-final frame, not every
      // frame — VRObjectMoveMode's rising-edge frame anchors the grab (its
      // delta is zero on that frame, so the object transform hasn't
      // actually changed yet), making this the earliest point at which a
      // snapshot is genuinely pre-mutation. The per-frame push below must
      // NOT re-acquire on every call — gated on _transformGestureActive.
      if (!final && !this._transformGestureActive) {
        this._transformGestureActive = this._beginGestureSync('transform', instanceId);
      }

      if (!final) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now - (this._lastObjTransformSentAt || 0) < 50) return;
        this._lastObjTransformSentAt = now;
      } else {
        this._lastObjTransformSentAt = 0; // let the next drag send immediately
      }

      const position = instanceTools.getPosition?.(instanceId) || [0, 0, 0];
      const rotation = instanceTools.getRotation?.(instanceId) || [0, 0, 0];
      const scale = instanceTools.getScale?.(instanceId) || [1, 1, 1];

      this._pushVisualizationPatch({
        transform: {
          position: [position[0], position[1], position[2]],
          rotation: [rotation[0], rotation[1], rotation[2]],
          scale: [scale[0], scale[1], scale[2]],
        },
      });

      if (final && this._transformGestureActive) {
        this._transformGestureActive = false;
        this.endManipulationGesture('transform');
      }
    } catch (err) {
      log.warn(`VR object transform sync failed: ${err?.message}`);
    }
  }

  // ===========================================================================
  // VR TOOL RESULT PERSISTENCE
  // ===========================================================================
  //
  // VR-placed annotations and measurements are persisted through the same
  // REST path desktop annotations use. The server broadcast then delivers
  // them to every participant (desktop and VR), closing the loop between
  // immersive actions and the shared annotation store.

  /**
   * @returns {Promise<{datasetId: string|null, projectId: string|null}>}
   *   datasetId is always a real server UUID (or null) — a bundled dataset's
   *   manifest key (e.g. "builtin-lungs") is resolved to its stable UUID row
   *   first (see migrations/020_bundled_dataset_ids.sql / GET
   *   /api/files/builtin), so annotation/measurement persistence never has
   *   to special-case non-UUID ids.
   */
  async _getPersistenceScope() {
    const instance = this._activeContext?.instance;
    let datasetId =
      instance?.instanceData?.dataset?.id || instance?.datasetId || null;
    const projectId = instance?.instanceData?.projectId || null;
    if (datasetId && isBuiltInDatasetId(datasetId)) {
      const localKey = datasetId;
      datasetId = await resolveBuiltInDatasetId(localKey);
      // Safety net alongside DatasetManager's own eager resolution at
      // registration time — covers a boot-time resolve that failed or
      // hadn't completed yet.
      if (datasetId) {
        getDatasetManager()?.registerBuiltInDatasetAlias?.(localKey, datasetId);
      }
    }
    return { datasetId, projectId };
  }

  async _getAnnotationManager() {
    const { annotationManager } = await import(
      '@Core/data/managers/AnnotationManager.js'
    );
    return annotationManager;
  }

  async _persistVRAnnotation(data) {
    const { datasetId, projectId } = await this._getPersistenceScope();
    if (!datasetId || !data?.position) {
      // Marker still renders locally (the tool's own optimistic state) so
      // this looks like success in-headset unless we say otherwise — a
      // dataset with no server id (e.g. loaded locally, never saved) would
      // otherwise silently vanish on reload with no explanation.
      this._flashVRNotice('Annotation not saved — dataset has no server id');
      return;
    }

    // Fire-and-forget: never block the XR frame loop on network I/O
    this._getAnnotationManager()
      .then((annotationManager) => {
        if (!annotationManager) return null;
        return annotationManager.createAnnotation(
          datasetId,
          {
            position: [data.position.x, data.position.y, data.position.z],
            normal: data.normal
              ? [data.normal.x, data.normal.y, data.normal.z]
              : null,
            text: data.text || 'VR marker',
            type: 'point',
            // authorName rides in metadata (not a first-class annotation
            // field) because AnnotationManager already writes the raw
            // createdBy user id separately — this is purely the DISPLAY name
            // so VTKAnnotationLinesFeature can render "who placed this" on
            // the pin without a separate user-id -> display-name lookup.
            metadata: {
              source: 'vr',
              vrMode: data.type,
              color: data.color,
              authorName: data.authorName || getUserName(),
              // pointId is only meaningful relative to whichever polydata
              // pickActorRole names — it does NOT index into the source
              // dataset when pickActorRole is 'glyph'/'threshold'/
              // 'isosurface'. null/-1 means no source point id was resolved.
              pointId: data.pointId ?? null,
              cellId: data.cellId ?? null,
              pickActorRole: data.pickActorRole ?? null,
              // Actor-relative point, so VTKAnnotationLinesFeature can
              // re-anchor the marker if the data actor's transform changes
              // later (VR two-hand twist) — null when not recoverable (see
              // VRAnnotationTool._resolveLocalPosition).
              localPosition: data.localPosition
                ? [data.localPosition.x, data.localPosition.y, data.localPosition.z]
                : null,
            },
          },
          { projectId }
        );
      })
      .then((annotation) => {
        if (annotation) {
          // Map the tool-local id to the server id so undo can delete it
          data.serverId = annotation.id;
          log.debug(`VR annotation persisted as ${annotation.id}`);

          // In-flight-undo hole: the user could Undo (which tombstones with
          // _deleted, see VRAnnotationTool.undoLast) before this create POST
          // resolved. _deletePersistedVRAnnotation early-returns without a
          // serverId, so without this check the row would live on the server
          // and stay broadcast to every participant forever. The keyboard
          // flow makes this window realistic — confirm-then-immediately-undo
          // is exactly a fast double-tap away.
          if (data._deleted) this._deletePersistedVRAnnotation(data);
        }
      })
      .catch((err) => {
        log.warn('Failed to persist VR annotation:', err.message);
        this._flashVRNotice('Annotation failed to save');
      });
  }

  async _deletePersistedVRAnnotation(data) {
    const { datasetId } = await this._getPersistenceScope();
    if (!datasetId || !data?.serverId) return;

    this._getAnnotationManager()
      .then((annotationManager) =>
        annotationManager?.deleteAnnotation(datasetId, data.serverId)
      )
      .catch((err) => log.warn('Failed to delete VR annotation:', err.message));
  }

  async _persistVRMeasurement(data) {
    const { datasetId, projectId } = await this._getPersistenceScope();
    if (!datasetId || !data?.startPoint || !data?.endPoint) {
      this._flashVRNotice('Measurement not saved — dataset has no server id');
      return;
    }

    const mid = {
      x: (data.startPoint.x + data.endPoint.x) / 2,
      y: (data.startPoint.y + data.endPoint.y) / 2,
      z: (data.startPoint.z + data.endPoint.z) / 2,
    };

    this._getAnnotationManager()
      .then((annotationManager) => {
        if (!annotationManager) return null;
        return annotationManager.createAnnotation(
          datasetId,
          {
            position: [mid.x, mid.y, mid.z],
            text: `Distance: ${Number(data.distance).toFixed(3)} ${data.unit || 'units'}`,
            type: 'measurement',
            metadata: {
              source: 'vr',
              startPoint: [data.startPoint.x, data.startPoint.y, data.startPoint.z],
              endPoint: [data.endPoint.x, data.endPoint.y, data.endPoint.z],
              distance: data.distance,
              unit: data.unit || 'units',
              // See _persistVRAnnotation's comment: pointId is only
              // meaningful relative to its own pickActorRole.
              startPointId: data.startPoint.pointId ?? null,
              startCellId: data.startPoint.cellId ?? null,
              startActorRole: data.startPoint.pickActorRole ?? null,
              endPointId: data.endPoint.pointId ?? null,
              endCellId: data.endPoint.cellId ?? null,
              endActorRole: data.endPoint.pickActorRole ?? null,
            },
          },
          { projectId }
        );
      })
      .then((annotation) => {
        if (annotation) {
          data.serverId = annotation.id;
          log.debug(`VR measurement persisted as ${annotation.id}`);

          // Same in-flight-undo hole as _persistVRAnnotation: Undo can
          // tombstone this segment (see VRMeasureTool.undoLast) before this
          // create POST resolves. Without this check the row would live on
          // the server and stay broadcast to every participant forever.
          if (data._deleted) this._deletePersistedVRAnnotation(data);
        }
      })
      .catch((err) => {
        log.warn('Failed to persist VR measurement:', err.message);
        this._flashVRNotice('Measurement failed to save');
      });
  }

  // ===========================================================================
  // EVENT HANDLERS
  // ===========================================================================

  _onSessionEnd() {
    log.info('XR session ended');
    this.leaveSession().catch(err => log.error('Error leaving session:', err));
  }

  // ===========================================================================
  // STATUS QUERIES
  // ===========================================================================

  isExploring() {
    return this._activeSession != null && this._activeSession.isActive();
  }

  getActiveContext() {
    return this._activeContext;
  }
}

export const vrExplorationManager = new VRExplorationManager();
export default vrExplorationManager;
