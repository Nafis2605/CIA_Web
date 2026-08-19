// src/services/serverSync.js
// WebSocket client for real-time server sync

import { config } from "@Core/config/clientConfig.js";
import { sessionManager } from "@Core/session/sessionManager.js";
import { ws as log } from "@Utils/logger.js";
import { resolveWsUrl } from "@Utils/resolveWsUrl.js";
import { authService } from "@Services/authService.js";
import { useComputeJobStore } from "@UI/react/store/computeJobStore.js";
import { toast } from "@UI/react/store/toastStore.js";
import { getSyncWatermark, saveSyncWatermark } from "@Services/syncService.js";
import { metricsService } from "@Services/metrics/metricsService.js";

// Debounce window for delta back-fill requests.
// Multiple incoming events with gaps in rapid succession collapse into one fetch.
const DELTA_BACKFILL_DEBOUNCE_MS = 500;

class ServerSyncService {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this._reconnectTimer = null;
    this._resumeListenersAttached = false;
    // Set by disconnect(), cleared by connect() — distinguishes "the app
    // closed this on purpose" (sign-out) from a network drop, so onclose/
    // the resume listeners don't immediately reconnect right after we asked
    // to stay disconnected.
    this._intentionalDisconnect = false;
    // Named references to the listeners _setupNetworkResumeListeners adds,
    // so disconnect() can actually remove them (an anonymous inline handler
    // can't be passed to removeEventListener).
    this._onNetworkResume = null;
    this._onVisibilityChange = null;
    this.handlers = new Map();
    this.datasetManager = null;
    this.viewConfigurationManager = null;
    this.canvasManager = null;
    this.subsetManager = null;
    this.annotationManager = null;
    this.pendingProjectId = null;
    // Room channel counterpart to pendingProjectId — populated from
    // sessionManager on connect() and (re)sent as "join:room" every time
    // auth:success fires, so a reconnect re-joins the room channel too.
    // Unlike pendingProjectId this can legitimately stay null: VR is the
    // only current consumer of room-scoped WS broadcasts, and a session
    // that hasn't initialized a room yet (getRoomId() throws) has nothing
    // to join.
    this.pendingRoomId = null;
    this._authUnsubscribe = null;
    // DR1: workspace + user scope for watermark management
    this._workspaceId = null;
    this._userId = null;
    this._lastWatermark = 0;
    this._deltaFetchPending = false;
    this._deltaFetchTimer = null;
  }

  /**
   * Set the workspace scope for watermark tracking.
   * Call this after the user joins a workspace.
   *
   * Restores the persisted watermark (localStorage, via getSyncWatermark)
   * into memory immediately — without this, every reconnect/reload started
   * `_lastWatermark` back at 0 regardless of what had already been synced,
   * relying entirely on the REACTIVE gap check in a later live message to
   * ever notice anything was missed (see auth:success below for the other
   * half of this fix).
   */
  setWorkspaceId(workspaceId) {
    this._workspaceId = workspaceId;
    this._restoreWatermark();
  }

  /**
   * @private
   */
  _restoreWatermark() {
    if (!this._workspaceId) return;
    this._lastWatermark = getSyncWatermark(this._workspaceId, this._userId);
  }

  initialize(datasetManager, viewConfigurationManager = null) {
    this.datasetManager = datasetManager;
    this.viewConfigurationManager = viewConfigurationManager;
    this._setupDefaultHandlers();
    this._setupNetworkResumeListeners();
    this.connect();
  }

  /**
   * A Quest that sleeps or a laptop that loses Wi-Fi can outlast the capped
   * backoff's growing delay while sitting in a `setTimeout` wait. Resume
   * signals (network back online, tab regaining focus/visibility) short-
   * circuit that wait and retry immediately instead of leaving the client
   * stuck until the next scheduled attempt or a page reload.
   */
  _setupNetworkResumeListeners() {
    if (this._resumeListenersAttached || typeof window === "undefined") return;
    this._resumeListenersAttached = true;

    const tryResumeNow = () => {
      // The app asked to stay disconnected (e.g. sign-out) — a stray
      // online/focus/visibility signal must not undo that.
      if (this._intentionalDisconnect) return;
      if (this.isConnected) return;
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      log.info("Network/visibility resume signal — attempting immediate reconnect");
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      this.connect();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tryResumeNow();
    };

    this._onNetworkResume = tryResumeNow;
    this._onVisibilityChange = onVisibilityChange;

    window.addEventListener("online", tryResumeNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", tryResumeNow);
  }

  /**
   * Set the ViewConfigurationManager reference
   * Called by appInitializer after ViewConfigurationManager is created
   */
  setViewConfigurationManager(viewConfigurationManager) {
    this.viewConfigurationManager = viewConfigurationManager;
  }

  /**
   * Set the CanvasManager reference
   * Called by appInitializer after CanvasManager is initialized
   */
  setCanvasManager(canvasManager) {
    this.canvasManager = canvasManager;
  }

  /**
   * Set the SubsetManager reference
   * Called by appInitializer after SubsetManager is initialized
   */
  setSubsetManager(subsetManager) {
    this.subsetManager = subsetManager;
  }

  /**
   * Set the AnnotationManager reference
   * Called by appInitializer after AnnotationManager is initialized
   */
  setAnnotationManager(annotationManager) {
    this.annotationManager = annotationManager;
  }

  /**
   * Set the pending room id, mirroring how pendingProjectId is populated
   * from sessionManager.getProjectId() in connect(). Exposed publicly so a
   * caller that resolves the room after connect() has already fired (e.g.
   * sessionManager finishing initialization) can still get it sent — the
   * next auth:success (including a reconnect's) will pick it up.
   */
  setRoomId(roomId) {
    this.pendingRoomId = roomId || null;
  }

  /**
   * @private
   * sessionManager.getRoomId() throws when the session hasn't been
   * initialized yet (see sessionManager.js), unlike getProjectId() which
   * falls back to a default. connect() runs on module init, well before
   * that's guaranteed — this wrapper turns "not ready yet" into null
   * instead of an uncaught throw out of the ws.onopen handler.
   */
  _safeRoomId() {
    try {
      return sessionManager.getRoomId();
    } catch {
      return null;
    }
  }

  connect() {
    // A fresh connect() (initial load, or a deliberate reconnect after a
    // prior disconnect()) means the app wants to be connected again —
    // clear the flag so onclose/resume listeners aren't stuck refusing to
    // reconnect after this point.
    this._intentionalDisconnect = false;
    // config.apiBaseUrl is normally a relative "/api" path, in which case the
    // live broadcast socket rides the same origin via the webpack devServer's
    // /app-ws proxy (mounted at /app-ws rather than /ws because webpack-dev-
    // server's own HMR socket already owns /ws — see webpack.config.js).
    // An absolute apiBaseUrl override (e.g. a non-dev-server deployment) is
    // assumed to expose the backend's real /ws path directly.
    const wsUrl = config.apiBaseUrl.startsWith("/")
      ? resolveWsUrl("/app-ws")
      : config.apiBaseUrl.replace(/^http/, "ws").replace("/api", "/ws");
    log.info(`Connecting to ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        log.info("Connected to server");
        this.isConnected = true;
        this.reconnectAttempts = 0;

        this.pendingProjectId = sessionManager.getProjectId();
        this.pendingRoomId = this._safeRoomId();
        void this._authenticate();
      };

      this.ws.onmessage = (event) => this._handleMessage(event.data);
      this.ws.onclose = () => {
        log.info("Disconnected");
        this.isConnected = false;
        // A close the app itself initiated (disconnect()) must not schedule
        // a reconnect — that's the entire point of "intentional".
        if (this._intentionalDisconnect) return;
        this._scheduleReconnect();
      };
      this.ws.onerror = (error) => log.error("WebSocket error", error);
    } catch (error) {
      log.error("Failed to connect", error);
      this._scheduleReconnect();
    }
  }

  _handleMessage(data) {
    try {
      const message = JSON.parse(data);
      log.debug(`Received: ${message.type}`, message);
      const handler = this.handlers.get(message.type);
      if (handler) handler(message);
    } catch (error) {
      log.error("Failed to parse message", error);
    }
  }

  _setupDefaultHandlers() {
    this.on("connected", () => log.debug("Server hello received"));
    this.on("auth:success", (msg) => {
      log.info(`Authenticated as ${msg.userId}`);
      // Store the database userId in sessionManager and locally for watermark scoping
      sessionManager.setUserInfo(msg.userId, msg.email || null);
      this._userId = msg.userId || null;
      // _userId wasn't known the first time setWorkspaceId() ran (it's set
      // above, right here) — re-restore now that both halves of the
      // watermark's storage key are available.
      this._restoreWatermark();
      // Request a delta unconditionally, not just reactively on the next
      // live message's sequence gap: a reconnect after any time offline may
      // have missed events, and a quiet room might not produce a live
      // message for a while (or ever) to reveal that reactively.
      this._triggerDeltaFetch();
      if (this.pendingProjectId) {
        this._send({ type: "join:project", projectId: this.pendingProjectId });
      }
      // Room channel join lives here rather than in connect(): connect()
      // only runs once per socket, but auth:success fires on every
      // (re)authentication including reconnects, so this is what makes a
      // reconnect actually re-join the room channel. Without it,
      // wsManager.roomChannels never gets a member and room-scoped
      // broadcasts (VR) reach nobody — see serverSync.joinRoom.test.js.
      if (this.pendingRoomId) {
        this._send({ type: "join:room", roomId: this.pendingRoomId });
      }
    });
    this.on("auth:error", (msg) => {
      log.warn(`Authentication failed: ${msg.error || "unknown error"}`);
    });
    this.on("project:join-error", (msg) => {
      log.warn(`Project join failed: ${msg.error || "unknown error"}`);
    });
    this.on("project:joined", (msg) =>
      log.info(`Joined project ${msg.projectId}`)
    );
    this.on("room:join-error", (msg) => {
      // Loud, and re-broadcast as a DOM event, because this single failure
      // silently disables ALL room-scoped collaboration. A denied join means
      // this socket is never added to wsManager.roomChannels, so every
      // broadcastToRoom() message — the whole vr:session-created /
      // vr:participant-joined / vr:lease-changed family — hits
      // `if (!channel) return;` server-side and reaches nobody. Two headsets
      // in one room then look perfectly healthy while being completely
      // unable to see each other. This used to be a log.warn nobody would
      // ever read on a headset.
      const reason = msg.error || "unknown error";
      log.error(
        `Room join FAILED (${reason}) — room-scoped collaboration (VR sessions, participants, presence) is DISABLED for this session.`
      );
      try {
        window.dispatchEvent(
          new CustomEvent("cia:room-join-error", {
            detail: { error: reason, roomId: msg.roomId },
          })
        );
      } catch {
        // Event dispatch is best-effort — never let it mask the log above.
      }
    });
    this.on("room:joined", (msg) =>
      log.info(`Joined room ${msg.roomId}`)
    );

    // File events
    this.on("file:added", async (msg) => {
      log.info(`File added: ${msg.file.filename}`);
      if (this.datasetManager) {
        await this.datasetManager._addDatasetFromServer(msg.file);
      }
    });

    this.on("file:removed", (msg) => {
      log.info(`File removed: ${msg.fileId}`);
      if (this.datasetManager) {
        this.datasetManager.removeDataset(msg.fileId);
      }
    });

    // Annotation events - forward to AnnotationManager and dispatch window
    // events for the useServerSyncEvents('annotation', ...) hook path
    this.on("annotation:created", (msg) => {
      log.info(`Annotation created on ${msg.fileId}`);
      this._recordSyncLatency("annotation-created", msg);
      const { shouldSkip, shouldDefer } = this._checkSequenceGap(msg.syncEventId);
      if (shouldSkip || shouldDefer) return;

      // Skip echo of our own creation - the creator already added it locally
      const myUserId = sessionManager.getUserId?.() || this._userId;
      if (msg.actorUserId && myUserId && msg.actorUserId === myUserId) {
        log.debug(`Skipping own annotation:created echo`);
        this._advanceWatermark(msg.syncEventId); // already applied locally
        return;
      }
      try {
        if (this.annotationManager) {
          this.annotationManager.handleServerBroadcast("annotation:created", msg);
        }
        this._advanceWatermark(msg.syncEventId);
      } catch (err) {
        log.warn(`Failed to apply annotation:created for ${msg.annotation?.id}: ${err.message}`);
        return; // do NOT advance — the gap on the next event triggers back-fill
      }
      window.dispatchEvent(
        new CustomEvent("ws:annotation:created", { detail: msg })
      );
    });
    this.on("annotation:updated", (msg) => {
      log.info(`Annotation updated: ${msg.annotation?.id}`);
      this._recordSyncLatency("annotation-updated", msg);
      const { shouldSkip, shouldDefer } = this._checkSequenceGap(msg.syncEventId);
      if (shouldSkip || shouldDefer) return;

      const myUserId = sessionManager.getUserId?.() || this._userId;
      if (msg.actorUserId && myUserId && msg.actorUserId === myUserId) {
        log.debug(`Skipping own annotation:updated echo`);
        this._advanceWatermark(msg.syncEventId); // already applied locally
        return;
      }
      try {
        if (this.annotationManager) {
          this.annotationManager.handleServerBroadcast("annotation:updated", msg);
        }
        this._advanceWatermark(msg.syncEventId);
      } catch (err) {
        log.warn(`Failed to apply annotation:updated for ${msg.annotation?.id}: ${err.message}`);
        return; // do NOT advance — the gap on the next event triggers back-fill
      }
      window.dispatchEvent(
        new CustomEvent("ws:annotation:updated", { detail: msg })
      );
    });
    this.on("annotation:deleted", (msg) => {
      log.info(`Annotation deleted: ${msg.annotationId}`);
      this._recordSyncLatency("annotation-deleted", msg);
      const { shouldSkip, shouldDefer } = this._checkSequenceGap(msg.syncEventId);
      if (shouldSkip || shouldDefer) return;

      const myUserId = sessionManager.getUserId?.() || this._userId;
      if (msg.actorUserId && myUserId && msg.actorUserId === myUserId) {
        log.debug(`Skipping own annotation:deleted echo`);
        this._advanceWatermark(msg.syncEventId); // already applied locally
        return;
      }
      try {
        if (this.annotationManager) {
          this.annotationManager.handleServerBroadcast("annotation:deleted", msg);
        }
        this._advanceWatermark(msg.syncEventId);
      } catch (err) {
        log.warn(`Failed to apply annotation:deleted for ${msg.annotationId}: ${err.message}`);
        return; // do NOT advance — the gap on the next event triggers back-fill
      }
      window.dispatchEvent(
        new CustomEvent("ws:annotation:deleted", { detail: msg })
      );
    });

    // Saved-filter events - dispatch window events for useServerSyncEvents('filter', ...)
    this.on("filter:created", (msg) => {
      log.info(`Filter created: ${msg.filter?.name || msg.filter?.id}`);
      this._recordSyncLatency("filter-created", msg);
      window.dispatchEvent(
        new CustomEvent("ws:filter:created", { detail: msg })
      );
    });
    this.on("filter:updated", (msg) => {
      log.info(`Filter updated: ${msg.filter?.id}`);
      this._recordSyncLatency("filter-updated", msg);
      window.dispatchEvent(
        new CustomEvent("ws:filter:updated", { detail: msg })
      );
    });
    this.on("filter:deleted", (msg) => {
      log.info(`Filter deleted: ${msg.filterId}`);
      this._recordSyncLatency("filter-deleted", msg);
      window.dispatchEvent(
        new CustomEvent("ws:filter:deleted", { detail: msg })
      );
    });

    // View events - forward to ViewConfigurationManager
    this.on("view:created", (msg) => {
      log.info(`View created: ${msg.view?.name || msg.view?.id}`);
      const { shouldSkip, shouldDefer } = this._checkSequenceGap(msg.syncEventId);
      if (shouldSkip || shouldDefer) return;
      try {
        if (this.viewConfigurationManager) {
          this.viewConfigurationManager.handleServerBroadcast("view:created", msg);
        }
        this._advanceWatermark(msg.syncEventId);
      } catch (err) {
        log.warn(`Failed to apply view:created for ${msg.view?.id}: ${err.message}`);
      }
    });

    this.on("view:updated", (msg) => {
      const viewId = msg.view?.id;
      log.info(`View updated: ${viewId}`);

      // Skip echo of our own mutations to prevent double-apply
      const myUserId = sessionManager.getUserId?.() || this._userId;
      if (msg.actorUserId && myUserId && msg.actorUserId === myUserId) {
        log.debug(`Skipping own view:updated echo for ${viewId}`);
        this._advanceWatermark(msg.syncEventId);
        return;
      }

      {
        const { shouldSkip, shouldDefer } = this._checkSequenceGap(msg.syncEventId);
        if (shouldSkip || shouldDefer) return; // deferred event is re-applied via back-fill
      }

      try {
        if (this.viewConfigurationManager) {
          this.viewConfigurationManager.handleServerBroadcast("view:updated", msg);
        }
        this._advanceWatermark(msg.syncEventId);
      } catch (err) {
        log.warn(`Failed to apply view:updated for view ${viewId}: ${err.message}`);
        // Do NOT advance watermark — the gap on the next event will trigger back-fill
      }
    });

    this.on("view:deleted", (msg) => {
      log.info(`View deleted: ${msg.viewId}`);
      const { shouldSkip, shouldDefer } = this._checkSequenceGap(msg.syncEventId);
      if (shouldSkip || shouldDefer) return;
      try {
        if (this.viewConfigurationManager) {
          this.viewConfigurationManager.handleServerBroadcast("view:deleted", msg);
        }
        this._advanceWatermark(msg.syncEventId);
      } catch (err) {
        log.warn(`Failed to apply view:deleted for ${msg.viewId}: ${err.message}`);
      }
    });

    // Canvas events - forward to CanvasManager
    this.on("canvas:created", (msg) => {
      log.info(`Canvas created: ${msg.canvas?.name || msg.canvasId}`);
      if (this.canvasManager) {
        this.canvasManager.handleServerBroadcast(msg);
      }
    });
    this.on("canvas:updated", (msg) => {
      log.info(`Canvas updated: ${msg.canvasId}`);
      if (this.canvasManager) {
        this.canvasManager.handleServerBroadcast(msg);
      }
    });
    this.on("canvas:deleted", (msg) => {
      log.info(`Canvas deleted: ${msg.canvasId}`);
      if (this.canvasManager) {
        this.canvasManager.handleServerBroadcast(msg);
      }
    });

    // Placement events - forward to CanvasManager
    this.on("placement:added", (msg) => {
      log.info(`Placement added to canvas ${msg.canvasId}`);
      if (this.canvasManager) {
        this.canvasManager.handleServerBroadcast(msg);
      }
    });
    this.on("placement:updated", (msg) => {
      log.info(`Placement updated: ${msg.placement?.id}`);
      if (this.canvasManager) {
        this.canvasManager.handleServerBroadcast(msg);
      }
    });
    this.on("placement:removed", (msg) => {
      log.info(`Placement removed: ${msg.placementId}`);
      if (this.canvasManager) {
        this.canvasManager.handleServerBroadcast(msg);
      }
    });

    // Subset events - forward to SubsetManager
    this.on("subset:created", (msg) => {
      log.info(`Subset created: ${msg.subset?.name || msg.subsetId}`);
      if (this.subsetManager) {
        this.subsetManager.handleServerBroadcast(msg);
      }
    });
    this.on("subset:updated", (msg) => {
      log.info(`Subset updated: ${msg.subsetId}`);
      if (this.subsetManager) {
        this.subsetManager.handleServerBroadcast(msg);
      }
    });
    this.on("subset:deleted", (msg) => {
      log.info(`Subset deleted: ${msg.subsetId}`);
      if (this.subsetManager) {
        this.subsetManager.handleServerBroadcast(msg);
      }
    });

    // Member events
    this.on("member:joined", (msg) => log.debug(`User ${msg.userId} joined`));
    this.on("member:left", (msg) => log.debug(`User ${msg.userId} left`));

    // Thumbnail events - dispatch custom events for UI components to listen to
    this.on("thumbnail:ready", (msg) => {
      log.debug(`Thumbnail ready for view ${msg.viewId}`);
      // Dispatch event for useThumbnail hook and other listeners
      window.dispatchEvent(
        new CustomEvent("cia:thumbnail-ready", {
          detail: { viewId: msg.viewId, snapshotId: msg.snapshotId },
        })
      );
    });

    this.on("thumbnail:file-updated", (msg) => {
      log.info(`File thumbnail updated: ${msg.fileId}`);
      // Dispatch event for FilesTab and other file thumbnail displays
      window.dispatchEvent(
        new CustomEvent("cia:file-thumbnail-updated", {
          detail: { fileId: msg.fileId, storageKey: msg.storageKey },
        })
      );
      // Also update dataset manager if available
      if (this.datasetManager) {
        this.datasetManager.notifyThumbnailUpdated(msg.fileId);
      }
    });

    this.on("thumbnail:view-updated", (msg) => {
      log.debug(`View thumbnail updated: ${msg.viewId}`);
      // Dispatch event for view thumbnail displays
      window.dispatchEvent(
        new CustomEvent("cia:thumbnail-ready", {
          detail: { viewId: msg.viewId, fileId: msg.fileId },
        })
      );
    });

    // Compute job events
    this.on("compute:progress", (msg) => {
      log.debug(`Compute progress: ${msg.jobId} - ${msg.progress}%`);
      const { updateProgress, getJob } = useComputeJobStore.getState();
      updateProgress(msg.jobId, msg.progress, msg.message);

      // Show toast at key milestones only (to avoid spam)
      if (msg.progress === 50) {
        const job = getJob(msg.jobId);
        if (job) {
          toast.info(`Processing ${job.fileName || "file"}... 50%`, 2000);
        }
      }
    });

    this.on("compute:complete", async (msg) => {
      log.info(`Compute complete: ${msg.jobId}`);
      const { completeJob, getJob } = useComputeJobStore.getState();

      // Get job info BEFORE marking complete (for toast message)
      const job = getJob(msg.jobId);
      const jobName = job?.fileName || "Processing";
      const operation = job?.operation?.replace(/-/g, " ") || "Operation";

      completeJob(msg.jobId, msg.result);

      // Show success toast
      toast.success(`${jobName}: ${operation} complete!`, 4000);

      // If a derived file was created, add it to DatasetManager
      if (msg.result?.derivedFileId && this.datasetManager) {
        try {
          const response = await fetch(
            `${config.apiBaseUrl}/files/${msg.result.derivedFileId}`
          );
          if (response.ok) {
            const { file } = await response.json();
            await this.datasetManager._addDatasetFromServer(file);
            log.info(`Added derived dataset: ${file.filename}`);

            // Additional toast for derived file
            toast.info(`New file created: ${file.filename}`, 3000);
          }
        } catch (error) {
          log.error("Failed to fetch derived dataset:", error);
        }
      }
    });

    this.on("compute:failed", (msg) => {
      log.error(`Compute failed: ${msg.jobId} - ${msg.error}`);
      const { failJob, getJob } = useComputeJobStore.getState();

      // Get job info for toast
      const job = getJob(msg.jobId);
      const jobName = job?.fileName || "Processing";

      failJob(msg.jobId, msg.error);

      // Show error toast (longer duration for errors)
      toast.error(`${jobName} failed: ${msg.error || "Unknown error"}`, 6000);
    });

    // VR Session events - dispatch custom events for UI components
    this.on("vr:session-created", (msg) => {
      log.info(`VR session created: ${msg.session?.id}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-session-created", {
          detail: msg,
        })
      );
    });

    this.on("vr:session-updated", (msg) => {
      log.info(`VR session updated: ${msg.sessionId}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-session-updated", {
          detail: msg,
        })
      );
    });

    this.on("vr:session-ended", (msg) => {
      log.info(`VR session ended: ${msg.sessionId}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-session-ended", {
          detail: msg,
        })
      );
    });

    this.on("vr:participant-joined", (msg) => {
      log.info(`VR participant joined: ${msg.participant?.userName}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-participant-joined", {
          detail: msg,
        })
      );
    });

    this.on("vr:participant-left", (msg) => {
      log.info(`VR participant left: ${msg.userId}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-participant-left", {
          detail: msg,
        })
      );
    });

    // Phase D3 (VRManipulationLock server lease): every acquire/heartbeat/
    // release/grant on the manipulation lease broadcasts this so a peer's
    // grant is visible to the grantee without waiting on its own network
    // round trip — see VRManipulationLock._handleLeaseChangedEvent.
    this.on("vr:lease-changed", (msg) => {
      log.debug(`VR lease changed: session ${msg.sessionId}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-lease-changed", {
          detail: msg,
        })
      );
    });

    this.on("vr:snapshot-created", (msg) => {
      log.info(`VR snapshot created: ${msg.snapshot?.name}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-snapshot-created", {
          detail: msg,
        })
      );
    });

    // VR Preprocessing events
    this.on("vr:preprocessing-started", (msg) => {
      log.info(`VR preprocessing started: ${msg.datasetId}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-preprocessing-started", {
          detail: msg,
        })
      );
    });

    this.on("vr:preprocessing-progress", (msg) => {
      log.debug(`VR preprocessing progress: ${msg.datasetId} - ${msg.progress}%`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-preprocessing-progress", {
          detail: msg,
        })
      );
    });

    this.on("vr:preprocessing-complete", (msg) => {
      log.info(`VR preprocessing complete: ${msg.datasetId}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-preprocessing-complete", {
          detail: msg,
        })
      );
    });

    this.on("vr:preprocessing-failed", (msg) => {
      log.error(`VR preprocessing failed: ${msg.datasetId}`);
      window.dispatchEvent(
        new CustomEvent("cia:vr-preprocessing-failed", {
          detail: msg,
        })
      );
    });
  }

  async _authenticate() {
    try {
      const token = await authService.getAccessToken();
      const isDevBypass =
        config.devBypassAuth === true || config.devBypassAuth === "true";
      if (!token && !isDevBypass) {
        this._waitForAuth();
        return;
      }
      const user = authService.getUser?.();
      this._send({
        type: "auth",
        token,
        userId: user?.id,
        userName: user?.name,
        userEmail: user?.email,
      });
    } catch (error) {
      log.warn("Failed to authenticate WebSocket:", error.message);
    }
  }

  _waitForAuth() {
    if (this._authUnsubscribe) {
      return;
    }

    this._authUnsubscribe = authService.onAuthStateChange(async (event) => {
      if (event === "authenticated") {
        const unsubscribe = this._authUnsubscribe;
        this._authUnsubscribe = null;
        if (unsubscribe) {
          unsubscribe();
        }
        await this._authenticate();
      } else if (event === "logout" || event === "session_expired") {
        const unsubscribe = this._authUnsubscribe;
        this._authUnsubscribe = null;
        if (unsubscribe) {
          unsubscribe();
        }
      }
    });
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  _send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Indefinite capped exponential backoff with jitter — never gives up.
   * A permanent give-up (the old 5-attempt cap) meant a Quest that slept or
   * lost Wi-Fi for longer than ~31s never resumed broadcasts without a page
   * reload; the online/visibility/focus listeners above are the fast path,
   * this is the fallback that keeps retrying even if none of those fire.
   */
  _scheduleReconnect() {
    const exp = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts));
    // 50%-100% of the computed delay, so many clients reconnecting after a
    // shared outage don't all retry in lockstep (thundering herd).
    const delay = exp * (0.5 + Math.random() * 0.5);
    this.reconnectAttempts++;
    log.info(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // ============================================================================
  // SYNC LATENCY INSTRUMENTATION
  // ============================================================================

  /**
   * Record end-to-end sync latency for a WS broadcast: delta between the
   * server's origin timestamp (`msg.timestamp`, an ISO string set when the
   * server broadcast the event) and "now" (apply time on this client).
   *
   * Clock-skew caveat: `msg.timestamp` is stamped by the server's wall
   * clock; `Date.now()` here is this browser's wall clock. On a single
   * machine (server + browser, or multiple tabs against one local dev
   * server) these share one clock and the delta is a valid latency
   * measurement. Across different machines, NTP drift can add tens of
   * milliseconds of error (see module JSDoc in metricsService.js).
   *
   * try/catch-safe no-op: metrics must never be able to break sync.
   * @param {string} category
   * @param {{timestamp?: string}} msg
   * @private
   */
  _recordSyncLatency(category, msg) {
    try {
      if (!msg || !msg.timestamp) return;
      metricsService.recordFromOrigin(category, msg.timestamp);
    } catch (err) {
      log.debug?.("metrics: failed to record sync latency (ignored)", err);
    }
  }

  // ============================================================================
  // DR1: WATERMARK HELPERS
  // ============================================================================

  /**
   * Advance the local watermark after successfully processing a WS event.
   * Scoped by both workspaceId and userId to prevent cross-user reuse.
   * @param {string|number|null} syncEventId
   */
  _advanceWatermark(syncEventId) {
    if (!syncEventId || !this._workspaceId) return;
    const id = parseInt(syncEventId, 10);
    if (isNaN(id) || id <= this._lastWatermark) return;
    this._lastWatermark = id;
    saveSyncWatermark(this._workspaceId, id, this._userId);
  }

  /**
   * Sequence-gap check shared by every event type that carries a
   * `syncEventId` — was only inlined in the `view:updated` handler before,
   * so every other event type (annotations, view:created/deleted) had no
   * gap detection at all and would silently miss events on message loss.
   * @param {string|number|null|undefined} syncEventId
   * @returns {{shouldSkip: boolean, shouldDefer: boolean}} shouldSkip: duplicate/
   *   already-applied, caller should return without applying. shouldDefer: a
   *   gap was detected and a back-fill was scheduled — caller should return
   *   without applying; the back-fill re-applies this event's data itself.
   */
  _checkSequenceGap(syncEventId) {
    if (!syncEventId) return { shouldSkip: false, shouldDefer: false };
    const incoming = parseInt(syncEventId, 10);
    if (this._lastWatermark > 0 && incoming <= this._lastWatermark) {
      log.debug(`Skipping already-applied event ${incoming} (watermark=${this._lastWatermark})`);
      return { shouldSkip: true, shouldDefer: false };
    }
    if (this._lastWatermark > 0 && incoming > this._lastWatermark + 1) {
      log.warn(`Event gap detected (${this._lastWatermark} → ${incoming}); scheduling delta back-fill`);
      this._scheduleDeltaFetch();
      return { shouldSkip: false, shouldDefer: true };
    }
    return { shouldSkip: false, shouldDefer: false };
  }

  /**
   * Debounced entry point for triggering a delta back-fill.
   * Multiple calls within DELTA_BACKFILL_DEBOUNCE_MS collapse into one fetch.
   */
  _scheduleDeltaFetch() {
    if (this._deltaFetchTimer) clearTimeout(this._deltaFetchTimer);
    this._deltaFetchTimer = setTimeout(() => {
      this._deltaFetchTimer = null;
      this._triggerDeltaFetch();
    }, DELTA_BACKFILL_DEBOUNCE_MS);
  }

  /**
   * Execute a delta back-fill fetch immediately.
   * Only one fetch runs at a time (_deltaFetchPending guard).
   * Advances watermark only to the last successfully applied event id.
   */
  _triggerDeltaFetch() {
    if (this._deltaFetchPending || !this._workspaceId) return;
    this._deltaFetchPending = true;

    import("@Services/syncService.js").then(({ fetchDeltaSince, applyDeltaEvents, saveSyncWatermark: save }) => {
      fetchDeltaSince(this._workspaceId, this._lastWatermark).then(async (delta) => {
        this._deltaFetchPending = false;
        if (delta.requiresFullResync) {
          log.warn("Delta back-fill: full resync required");
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("cia:sync-full-resync-required", {
              detail: { reason: delta.reason },
            }));
          }
          return;
        }
        const { lastAppliedEventId } = await applyDeltaEvents(
          delta.events || [],
          { viewConfigurationManager: this.viewConfigurationManager, annotationManager: this.annotationManager },
          this._userId
        );
        if (lastAppliedEventId != null && lastAppliedEventId > this._lastWatermark) {
          this._lastWatermark = lastAppliedEventId;
          save(this._workspaceId, lastAppliedEventId, this._userId);
        }
      }).catch((err) => {
        this._deltaFetchPending = false;
        log.warn("Delta back-fill fetch failed:", err.message);
      });
    }).catch(() => {
      this._deltaFetchPending = false;
    });
  }

  /**
   * Deliberately close the connection and keep it closed — e.g. on sign-out.
   * Marks the close as intentional (see _intentionalDisconnect) so onclose
   * and the online/visibility/focus resume listeners don't immediately
   * reconnect, and removes those listeners so they don't leak past this
   * disconnect. A later connect() (e.g. re-login) clears the flag and
   * re-attaches listeners via _setupNetworkResumeListeners as normal.
   */
  disconnect() {
    this._intentionalDisconnect = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._deltaFetchTimer) {
      clearTimeout(this._deltaFetchTimer);
      this._deltaFetchTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this._authUnsubscribe) {
      this._authUnsubscribe();
      this._authUnsubscribe = null;
    }

    if (typeof window !== "undefined") {
      if (this._onNetworkResume) {
        window.removeEventListener("online", this._onNetworkResume);
        window.removeEventListener("focus", this._onNetworkResume);
      }
      if (this._onVisibilityChange) {
        document.removeEventListener("visibilitychange", this._onVisibilityChange);
      }
    }
    this._onNetworkResume = null;
    this._onVisibilityChange = null;
    this._resumeListenersAttached = false;
  }
}

export const serverSync = new ServerSyncService();
