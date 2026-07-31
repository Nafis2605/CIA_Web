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
import { VRNavigationController } from '@Core/vr/navigation/VRNavigationController.js';
import { workspaceManager } from '@Core/instances/workspaceManager.js';
import { getViewConfigurationManager } from '@Init/appInitializer.js';
import { getUserId, getUserName, getUserColor } from '@Collaboration/presence/userManagement.js';
import { apiClient } from '@Services/apiClient.js';
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
import { vtkGlyphFeature, isGlyphFeatureAvailable } from '@Core/instances/types/vtk/features/VTKGlyphFeature.js';
import { instanceTools } from '@VTK/vtkInstanceTools.js';
import { pushSharedVisualizationUpdate } from '@Services/visualizationSyncService.js';
import { vrCursorSync } from '@Core/vr/VRCursorSync.js';
import { mapXRPointToData, controllerForward } from '@Core/vr/tools/vrPlaneMath.js';
import { vrEnvironment } from '@Core/vr/environment/VREnvironment.js';
import { voiceRoomService, getVoiceRoomName } from '@Services/voice/voiceRoomService.js';

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

    // Create session locally. If we're joining an existing server session
    // (config.serverSession from joinSession), reuse its id; otherwise the
    // session is registered with the server after VR entry succeeds.
    const { serverSession = null, ...sessionConfig } = config;
    const session = new VRExplorationSession({
      id: serverSession?.id ||
        `vrsession_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      viewConfigurationId: instance.viewConfigId,
      datasetId: instance.instanceData?.dataset?.id,
      projectId: instance.instanceData?.projectId,
      ownerUserId: serverSession?.owner_user_id || getUserId(),
      ownerUserName: serverSession?.owner_user_name || getUserName(),
      ...sessionConfig,
    });

    // Register with the server before sub-managers are constructed:
    // VRParticipantSync keys its Y.js map by session.id, so the canonical
    // (server) id must be adopted first for joiners to sync avatars.
    if (!serverSession) {
      const serverRow = await this._tryRegisterSession(session);
      if (serverRow?.id) {
        session.id = serverRow.id;
      }
    }

    // Add self as participant
    session.addParticipant(
      getUserId(),
      getUserName(),
      getUserColor(),
      serverSession ? sessionConfig.participationMode || PARTICIPATION_MODE.VR_EXPLORER : PARTICIPATION_MODE.VR_EXPLORER
    );

    // Initialize sub-managers
    this._participantSync = new VRParticipantSync(session);
    this._snapshotManager = new VRSnapshotManager(session, getViewConfigurationManager());
    this._controlManager = new VRControlManager(session);

    // Request XR session via VRManager — the sole owner of session lifecycle,
    // reference space and the XRWebGLLayer. This must be the only place that
    // ever calls navigator.xr.requestSession() for exploration; a competing
    // session here was the root cause of VR entry rendering nothing.
    const glContext = handler.getWebGLContext(instance.instanceId);
    if (!glContext) {
      throw new Error(
        'Could not get a WebGL context for VR — is the dataset loaded and render mode set to local?'
      );
    }

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

    // Initialize tool manager with handler
    this._toolManager = new VRToolManager(handler, vrContext);

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
    const gripPredicate = (hand) => {
      if (!hand) return false;
      // Vision Pro's transient-pointer is gripless (squeezeValue always 0)
      if (hand.isTransientPointer) return hand.triggerPressed === true;
      // Tracked controllers: use squeeze (grip button)
      return (hand.squeezeValue || 0) > 0.7;
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

    // Drive our frame work off VRManager's single XR frame loop instead of
    // requesting our own animation frames.
    this._offFrame = vrManager.on('frame', this._onFrame);
    this._offSessionEnded = vrManager.on('sessionEnded', this._onSessionEnd);

    // Start participant sync
    this._participantSync.start();

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
      vrCursorSync.initialize(getUserId(), getUserName(), getUserColor(getUserId()))
    );

    // Initialize the in-scene spatial tool menu. WebXR immersive sessions do
    // not render the DOM, so this VTK panel — not the React VRWristMenu — is
    // the guaranteed in-headset UI. It shares this manager as its source of
    // truth (tool select / undo / isolation toggle / exit all route back here).
    if (avatarRenderer) {
      this._safeInitStep('vrSpatialUI.initialize', () => vrSpatialUI.initialize(avatarRenderer, this));
    }

    // Emit event
    this._emit('explorationStarted', { session, instanceId });

    log.info('VR exploration started', { sessionId: session.id });

    return session;
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
   * Register a locally started session with the server, bounded by a short
   * timeout so a slow network never delays VR entry (WebXR requestSession
   * must run while user activation is still fresh). The server generates
   * the canonical id, which every client's Y.js participant map is keyed by
   * — so this must resolve before VRParticipantSync is constructed.
   *
   * @returns {Promise<object|null>} Server session row, or null (offline/slow)
   * @private
   */
  async _tryRegisterSession(session, timeoutMs = 1500) {
    try {
      const post = apiClient.post('/vr/sessions', {
        viewConfigurationId: session.viewConfigurationId,
        datasetId: session.datasetId,
        projectId: session.projectId,
        explorationMode: session.explorationMode,
        vrScale: session.vrScale,
        allowJoin: session.allowJoin,
        allowDesktopParticipants: session.allowDesktopParticipants,
        allowDesktopControl: session.allowDesktopControl,
      });
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
      const serverRow = await Promise.race([post, timeout]);
      if (serverRow?.id) {
        log.debug(`VR session registered on server as ${serverRow.id}`);
        return serverRow;
      }
      log.warn('VR session registration timed out; continuing with local id');
      return null;
    } catch (err) {
      log.warn('VR session server registration failed (continuing locally):', err.message);
      return null;
    }
  }

  /**
   * Join an existing VR exploration session, given the already-fetched
   * session record (callers listing sessions — e.g. VRExploreButton's
   * session popover — already have this row from their GET /vr/sessions;
   * avoid a redundant refetch here). Fields are the raw
   * vr_exploration_sessions row shape (snake_case) returned by the server.
   *
   * The join notification POST is bounded by a short timeout so a slow
   * network never delays entering VR while WebXR user-activation is still
   * fresh — same pattern as _tryRegisterSession. If the session's view is
   * open locally and a VR mode was requested, enters VR against that view
   * using the shared startExploration path (with the server session's id,
   * so avatar/participant Y.js state converges across clients).
   *
   * @param {Object} sessionRecord - server session row (id, view_configuration_id,
   *   owner_user_name, default_exploration_mode, default_vr_scale, ...)
   * @param {string} mode - Participation mode (PARTICIPATION_MODE)
   * @returns {Promise<{joined: boolean, vrEntered: boolean, session?: object, reason?: string}>}
   */
  async joinSession(sessionRecord, mode = PARTICIPATION_MODE.DESKTOP_OBSERVER) {
    const sessionId = sessionRecord?.id;
    if (!sessionId) {
      return { joined: false, vrEntered: false, reason: 'session-not-found' };
    }
    log.info('Joining VR session...', { sessionId, mode });

    try {
      const joinPost = apiClient.post(`/vr/sessions/${sessionId}/join`, { mode });
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
      await Promise.race([joinPost, timeout]);
    } catch (err) {
      log.warn('VR session join notification failed (continuing):', err.message);
    }

    // Desktop observers are done: participant state flows via Y.js/WS
    const isVRMode = mode === PARTICIPATION_MODE.VR_EXPLORER;
    if (!isVRMode) {
      this._emit('sessionJoined', { sessionId, mode });
      return { joined: true, vrEntered: false, session: sessionRecord };
    }

    // VR modes need the session's view open locally
    const viewConfigId = sessionRecord.view_configuration_id;
    const instance = viewConfigId
      ? workspaceManager.getInstanceByViewConfigId(viewConfigId)
      : null;
    if (!instance) {
      log.warn(`Cannot enter VR for session ${sessionId}: view ${viewConfigId} not open locally`);
      this._emit('sessionJoined', { sessionId, mode, vrEntered: false });
      return {
        joined: true,
        vrEntered: false,
        session: sessionRecord,
        reason: 'view-not-open',
      };
    }

    // Enter VR against the shared session id
    await this.startExploration(instance.instanceId, {
      serverSession: sessionRecord,
      participationMode: mode,
      explorationMode: sessionRecord.default_exploration_mode,
      vrScale: Number(sessionRecord.default_vr_scale) || 1.0,
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

  async leaveSession() {
    // Guard against re-entrancy: leaveSession() -> vrManager.exitVR() ->
    // XRSession "end" event -> our sessionEnded handler -> leaveSession()
    // again. Also covers the reverse: the headset/browser ends the session
    // first (user removed headset), which fires sessionEnded and calls us
    // here without anyone having called leaveSession() directly.
    if (!this._activeSession || this._leaving) return;
    this._leaving = true;

    const session = this._activeSession;

    log.info('Leaving VR session...', { sessionId: session.id });

    try {
      // Unsubscribe from VRManager events first so no further frame/end
      // callbacks touch a partially torn-down context.
      this._offFrame?.();
      this._offFrame = null;
      this._offSessionEnded?.();
      this._offSessionEnded = null;

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
          .post(`/vr/sessions/${session.id}/leave`, {})
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
      this._followTargetUserId = null;
      this._inputProfileDetected = false;
      this._participantSync = null;
      this._toolManager = null;
      this._snapshotManager = null;
      this._controlManager = null;
      this._navigationController = null;

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
    return this._activeSession?.getParticipant(getUserId());
  }

  /**
   * Other participants in the active session (excluding self), for the
   * spatial UI's collaborator go-to/follow controls.
   * @returns {Array<import('@Core/data/models/VRExplorationSession.js').VRParticipant>}
   */
  getOtherParticipants() {
    const session = this._activeSession;
    if (!session) return [];
    const selfId = getUserId();
    return session.participants.filter((p) => p.odUserId !== selfId);
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
    ctx.vrOrigin = [
      targetPos[0],
      targetPos[1] - 1.4 / vrScale,
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

    const participant = this._activeSession.updateParticipantMode(getUserId(), newMode);

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
  // TOOL MANAGEMENT (delegated to VRToolManager)
  // ===========================================================================

  activateTool(toolId) {
    if (!this._toolManager) return;
    this._toolManager.activateTool(toolId);
    this._emit('toolActivated', { toolId });
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
  toggleVoiceConnection() {
    if (voiceRoomService.isConnected()) {
      voiceRoomService.leaveRoom().catch((err) => log.warn('Voice leave failed:', err?.message));
      return false;
    }
    voiceRoomService
      .joinRoom(getVoiceRoomName(), getUserName())
      .catch((err) => log.warn('Voice join failed:', err?.message));
    return true;
  }

  // ===========================================================================
  // NAVIGATION (delegated to VRNavigationController)
  // ===========================================================================

  setNavigationMode(mode) {
    if (!this._navigationController) return;
    this._navigationController.setMode(mode);
    this._emit('navigationModeChanged', { mode });
    return mode;
  }

  getNavigationMode() {
    return this._navigationController?.getMode();
  }

  cycleNavigationMode() {
    if (!this._navigationController) return null;
    const newMode = this._navigationController.cycleMode();
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
    this._navigationController.setScale(scale);
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

    instanceTools.setRepresentation?.(instanceId, next);
    this._pushVisualizationPatch({ representation: next });
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

    instanceTools.setRepresentation?.(instanceId, mode);
    this._pushVisualizationPatch({ representation: mode });
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
    try {
      vtkThresholdFeature.toggleThreshold(id);
    } catch (err) {
      log.warn(`VR threshold toggle failed: ${err?.message}`);
      return false;
    }
    this._syncThreshold(id);
    const enabled = this.isThresholdEnabled();
    this._emit('thresholdToggled', { enabled });
    return enabled;
  }

  /** Cycle threshold mode: between -> above -> below. @returns {string|null} */
  cycleThresholdMode() {
    const id = this._instanceId();
    if (!id) return null;
    const order = ['between', 'above', 'below'];
    const current = vtkThresholdFeature.getState?.(id)?.mode || 'between';
    const next = order[(order.indexOf(current) + 1) % order.length];
    try {
      vtkThresholdFeature.setMode(id, next);
    } catch (err) {
      log.warn(`VR threshold mode cycle failed: ${err?.message}`);
      return null;
    }
    this._syncThreshold(id);
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
    try {
      vtkThresholdFeature.selectArray(id, next);
    } catch (err) {
      log.warn(`VR threshold array cycle failed: ${err?.message}`);
      return null;
    }
    this._syncThreshold(id);
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
    try {
      if (enabled) {
        vtkIsosurfaceFeature.disableIsosurface(id);
      } else {
        const imageData = this._activeContext?.instance?.instanceData?.imageData;
        const r = vtkIsosurfaceFeature.enableIsosurface?.(id, imageData);
        // Fire-and-forget: must never block or break the XR frame loop.
        if (r && typeof r.catch === 'function') {
          r.catch((err) => log.warn(`VR isosurface enable failed: ${err?.message}`));
        }
      }
    } catch (err) {
      log.warn(`VR isosurface toggle failed: ${err?.message}`);
      return enabled;
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
      vtkGlyphFeature.disableGlyphs(instanceId);
      this._pushVisualizationPatch({ glyph: vtkGlyphFeature.getConfigForSync(instanceId) });
      this._emit('glyphsToggled', { enabled: false });
      return false;
    }

    const { vectorArrays = [], scalarArrays = [] } = state;
    if (!isGlyphFeatureAvailable(vectorArrays, scalarArrays)) {
      log.warn('VR glyph toggle: no usable vector/scalar point-data arrays on this dataset');
      return false;
    }

    const polydata = this._activeContext?.instance?.instanceData?.polydata;
    if (!polydata) {
      log.warn('VR glyph toggle: dataset polydata unavailable');
      return false;
    }

    vtkGlyphFeature.enableGlyphs(instanceId, polydata, {
      orientationArray: vectorArrays?.[0]?.name,
    });
    this._pushVisualizationPatch({ glyph: vtkGlyphFeature.getConfigForSync(instanceId) });
    this._emit('glyphsToggled', { enabled: true });
    return true;
  }

  /** @returns {boolean} whether glyphs are currently enabled on the active dataset */
  isGlyphsEnabled() {
    const instanceId = this._activeContext?.instance?.instanceId;
    if (!instanceId) return false;
    return !!vtkGlyphFeature.getState(instanceId)?.enabled;
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
   * position ends up ~1m in front of the user at chest height, regardless of
   * where its bounds sit relative to the data origin. Shared by initial VR
   * placement (_applyInitialPlacement) and isolation mode (enterIsolation) —
   * same math, same "diagonal spans ~2.5 physical meters" convention.
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

    // Auto-fit: the dataset's bounding diagonal should appear ~2.5 physical
    // metres across, placed 2.0 m in front and dropped 1.4 m to eye level.
    const vrScale = 2.5 / diagonal;
    const vrOrigin = [
      center[0],
      center[1] - 1.4 / vrScale,
      center[2] + 2.0 / vrScale,
    ];
    return { vrScale, vrOrigin, diagonal, center };
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
    const forward = controllerForward(orientation);
    const distance = 2.0;
    const target = [
      position.x + forward[0] * distance,
      position.y + forward[1] * distance - 0.3,
      position.z + forward[2] * distance,
    ];

    const placement = this._computeAutoPlacement(vrContext.dataBounds);
    // Always auto-fit (see _applyInitialPlacement) — the pose-relative pass
    // only re-derives vrOrigin so the auto-fit dataset centers on where the
    // user is actually looking on the first real frame.
    const vrScale = placement.vrScale;

    vrContext.vrScale = vrScale;
    vrContext.vrRotation = 0;
    vrContext.vrOrigin = [
      placement.center[0] - target[0] / vrScale,
      placement.center[1] - target[1] / vrScale,
      placement.center[2] - target[2] / vrScale,
    ];

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
    ctx.vrOrigin = [...vrOrigin];

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
        (p) => p.odUserId === getUserId()
      );
      const vrContext = this._activeContext?.vrContext;
      if (mine && vrContext) {
        if (Number.isFinite(mine.vrScale) && mine.vrScale > 0) {
          vrContext.vrScale = mine.vrScale;
          this._navigationController?.setScale?.(mine.vrScale);
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
   * @param {{time:number, deltaTime:number, frame:XRFrame, viewerPose:XRViewerPose}} frameData
   */
  _onFrame({ time, deltaTime: deltaTimeMs, frame, viewerPose }) {
    if (!this._activeContext) return;

    const { handler, vrContext } = this._activeContext;
    const deltaTime = (deltaTimeMs || 16.67) / 1000;

    try {
      if (this._needsPoseCorrection && viewerPose) {
        this._needsPoseCorrection = false;
        this._applyPoseRelativePlacement(vrContext, viewerPose);
      }

      // Get input state
      const inputState = this._gatherInputState(frame);

      // INPUT ARBITRATION (R2). The floating spatial menu must be interactable
      // without its pinches also firing tools/teleport. So the menu hit-tests
      // the RAW input FIRST — before nav/tools — and reports whether the
      // pointer is over a button. We then hand nav and the tools a shallow-
      // cloned inputState with the offending trigger stripped, never mutating
      // the object _gatherInputState returned (other consumers below — pose
      // sync, avatars, pointer broadcast — still read the raw poses).
      //
      // Isolated in its own try/catch (unlike the rest of this frame body,
      // which shares one try/catch below): vrSpatialUI.update() is the
      // newest, highest-risk per-frame call (canvas/texture work), and this
      // whole method runs every frame — an uncaught throw here would repeat
      // on every subsequent frame and stall nav/tools/avatar sync right along
      // with the menu. Isolating it means a menu-only failure stays
      // menu-only, and gets logged instead of silently freezing the session.
      let menuResult = null;
      try {
        menuResult =
          vrSpatialUI.update(inputState, {
            vrScale: vrContext.vrScale,
            vrOrigin: vrContext.vrOrigin,
          }) || null;
      } catch (e) {
        log.error(`VR frame: vrSpatialUI.update failed — ${e?.message}`, e?.stack || e);
      }
      const menuHovering = !!menuResult?.hovering;
      const menuHand = menuResult?.hand || 'right';
      // A pinch used to place/aim an active tool must not ALSO aim teleport.
      const toolActive = !!this._toolManager?.getActiveTool?.();

      // INPUT GATING: in the new layered model, grip stays ALWAYS ON for
      // world-grab navigation; only trigger is gated by menu/tool. Grip is
      // never stripped so pulling the world is always available (standard VR
      // convention, e.g. Meta Quest 3 — the hand is never "interrupted" by UI).
      const navStripHands = new Set();
      const toolStripHands = new Set();
      if (menuHovering) {
        // Only strip the trigger, not grip (grip is always-on world-grab)
        navStripHands.add(menuHand);
        toolStripHands.add(menuHand);
      }
      if (toolActive) {
        // Strip both hands' triggers from nav/tools so a tool placement never
        // drives object-move or menu hover. Grip remains (world navigation).
        navStripHands.add('left');
        navStripHands.add('right');
      }
      const navInput = this._gateInputState(inputState, navStripHands);
      const toolInput = this._gateInputState(inputState, toolStripHands);

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
      if (this._navigationController) {
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
      }

      // In-VR follow: soft positional lerp toward the target participant.
      // Real locomotion input (thumbstick/teleport trigger) always wins and
      // cancels follow — mirrors followService's desktop
      // auto-unfollow-on-manual-move semantics. Reads the nav-gated clone so a
      // menu/tool pinch doesn't read as "the user is moving".
      if (this._followTargetUserId) {
        if (this._hasLocomotionInput(navInput)) {
          this.stopFollowing();
        } else {
          this._updateParticipantFollow(vrContext, deltaTime);
        }
      }

      // Keep the floor/environment anchored under the user as they
      // teleport/fly/scale/follow (no-ops internally if nothing changed).
      vrEnvironment.updateTransform(vrContext.vrScale, vrContext.vrOrigin);

      // B button (right controller) toggles isolation mode: pull the model
      // to room scale for walk-around inspection, press again to restore.
      const bPressed = inputState.controllers?.right?.buttons?.b || false;
      if (bPressed && !this._lastIsolationButtonState) {
        this.toggleIsolation();
      }
      this._lastIsolationButtonState = bPressed;

      // Update tools with the arbitration-gated clone so a pinch aimed at a
      // menu button never also fires the active tool.
      const toolAction = this._toolManager?.update(toolInput, frame);
      if (toolAction) {
        this._handleToolAction(toolAction);
      }

      // Update participant sync. Head/hand poses are in THIS user's own
      // physical XR space (each participant has an independent WebXR
      // session/reference space) — vrScale/vrOrigin travel alongside so
      // remote viewers can convert into the one shared frame, data space,
      // using the SENDER's transform rather than their own (see
      // RemoteAvatarController._toScenePose).
      this._participantSync?.updateLocalState({
        headPose: inputState.headPose,
        leftHandPose: inputState.controllers?.left?.pose,
        rightHandPose: inputState.controllers?.right?.pose,
        vrScale: vrContext.vrScale || 1.0,
        vrOrigin: vrContext.vrOrigin || [0, 0, 0],
      });

      // Broadcast the active controller ray so desktop collaborators can see
      // where this VR user is pointing (throttled inside vrCursorSync).
      this._broadcastPointerRay(inputState, vrContext);

      // Update avatar system
      vrAvatarSystem.update(deltaTime, inputState);

      // NOTE: the in-scene tool menu was already updated at the top of the
      // frame (before nav/tools) so its hit-test can gate their input — see
      // the INPUT ARBITRATION block above.

      // Let handler update VR rendering (synchronous stereo render — see
      // VTKInstanceHandler.updateVRExploration). Gets the tool-gated clone so a
      // menu pinch doesn't leak into the handler's own interaction handling.
      handler.updateVRExploration?.(vrContext, frame, toolInput, viewerPose);

      // Emit frame event for UI
      this._emit('frame', { time, inputState, deltaTime });

    } catch (error) {
      log.error('Error in VR frame loop:', error);
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
   * Return a SHALLOW clone of the frame's input state with the trigger stripped
   * (triggerPressed:false, triggerValue:0) from the named hands. Used for input
   * arbitration (R2): the object _gatherInputState returned is never mutated —
   * the menu and pose/avatar consumers keep reading the raw triggers/poses —
   * while nav and tools receive a gated copy so a pinch aimed at a menu button
   * (or a tool) doesn't also drive locomotion. Only triggers are touched;
   * thumbstick, poses and buttons pass through unchanged.
   *
   * @param {Object} inputState - raw state from _gatherInputState
   * @param {Set<string>|Array<string>} hands - which hands to strip ('left'/'right')
   * @returns {Object} the same object if nothing to strip, else a gated clone
   * @private
   */
  _gateInputState(inputState, hands) {
    const list = hands instanceof Set ? [...hands] : hands || [];
    if (!list.length) return inputState;
    const clone = { ...inputState, controllers: { ...inputState.controllers } };
    for (const hand of list) {
      const c = clone.controllers?.[hand];
      if (c) {
        clone.controllers[hand] = { ...c, triggerPressed: false, triggerValue: 0 };
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
    const desired = [
      targetPos[0],
      targetPos[1] - 1.4 / vrScale,
      targetPos[2] + 1.5 / vrScale,
    ];

    // ~0.5s settle time regardless of frame rate.
    const alpha = Math.min(1, deltaTime * 2);
    const origin = vrContext.vrOrigin || [0, 0, 0];
    vrContext.vrOrigin = [
      origin[0] + (desired[0] - origin[0]) * alpha,
      origin[1] + (desired[1] - origin[1]) * alpha,
      origin[2] + (desired[2] - origin[2]) * alpha,
    ];
  }

  /**
   * Publish the local VR controller ray (in DATA space, so desktop views can
   * render it directly) via vrCursorSync. Right hand wins when both present.
   * Never throws — pointer visibility must not break the frame loop.
   * @private
   */
  _broadcastPointerRay(inputState, vrContext) {
    try {
      const viewId = this._activeContext?.instance?.viewConfigId;
      if (!viewId) return;

      const hand = inputState.controllers?.right?.pose
        ? 'right'
        : inputState.controllers?.left?.pose
          ? 'left'
          : null;
      if (!hand) return;

      const pose = inputState.controllers[hand].pose;
      if (!pose?.position || !pose?.orientation) return;

      const origin = mapXRPointToData(
        pose.position,
        vrContext.vrScale || 1.0,
        vrContext.vrOrigin || [0, 0, 0]
      );
      const dir = controllerForward(pose.orientation);

      vrCursorSync.broadcastVRPointer(
        viewId,
        { x: origin[0], y: origin[1], z: origin[2] },
        { x: dir[0], y: dir[1], z: dir[2] },
        hand
      );
    } catch {
      // pointer broadcast is cosmetic — never break the frame loop
    }
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
      if (source.hand) {
        // Hand tracking - skip for now
        continue;
      }

      if (source.gripSpace) {
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
              a: source.gamepad?.buttons?.[4]?.pressed || false,
              b: source.gamepad?.buttons?.[5]?.pressed || false,
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
            buttons: { a: false, b: false },
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
      case 'clip-box-updated':
        this._emit('clipBoxUpdated', action.data);
        // Sync/persist only on gesture end — not every drag frame.
        if (action.data?.final) {
          const instanceId = this._activeContext?.vrContext?.instanceId;
          const config = instanceId
            ? vtkClippingFeature.getConfigForSync(instanceId)
            : null;
          if (config) this._pushVisualizationPatch({ clipBox: config });
        }
        break;
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
   * @param {object} patch - e.g. { representation: 'wireframe' } or { clipBox: {...} }
   * @private
   */
  _pushVisualizationPatch(patch) {
    try {
      const viewId = this._activeContext?.instance?.viewConfigId;
      if (!viewId || !patch) return;

      Promise.resolve(
        pushSharedVisualizationUpdate(viewId, patch)
      ).catch((err) => log.warn(`VR visualization sync failed: ${err?.message}`));
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

  _getPersistenceScope() {
    const instance = this._activeContext?.instance;
    const datasetId =
      instance?.instanceData?.dataset?.id || instance?.datasetId || null;
    const projectId = instance?.instanceData?.projectId || null;
    return { datasetId, projectId };
  }

  async _getAnnotationManager() {
    const { annotationManager } = await import(
      '@Core/data/managers/AnnotationManager.js'
    );
    return annotationManager;
  }

  _persistVRAnnotation(data) {
    const { datasetId, projectId } = this._getPersistenceScope();
    if (!datasetId || !data?.position) return;

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
            metadata: { source: 'vr', vrMode: data.type, color: data.color },
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
      .catch((err) => log.warn('Failed to persist VR annotation:', err.message));
  }

  _deletePersistedVRAnnotation(data) {
    const { datasetId } = this._getPersistenceScope();
    if (!datasetId || !data?.serverId) return;

    this._getAnnotationManager()
      .then((annotationManager) =>
        annotationManager?.deleteAnnotation(datasetId, data.serverId)
      )
      .catch((err) => log.warn('Failed to delete VR annotation:', err.message));
  }

  _persistVRMeasurement(data) {
    const { datasetId, projectId } = this._getPersistenceScope();
    if (!datasetId || !data?.startPoint || !data?.endPoint) return;

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
            },
          },
          { projectId }
        );
      })
      .then((annotation) => {
        if (annotation) {
          data.serverId = annotation.id;
          log.debug(`VR measurement persisted as ${annotation.id}`);
        }
      })
      .catch((err) => log.warn('Failed to persist VR measurement:', err.message));
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
