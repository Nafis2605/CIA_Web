// server.js - Y.js WebSocket Server with PostgreSQL Persistence
//
// Phase 2E: Adds persistence for chat audit trail, session recording foundation,
// and state hydration on reconnect.
//
// Architecture:
// - Y.js handles presence data only (cursors, avatars, chat)
// - PostgreSQL stores snapshots (fast hydration), updates (recording), chat (audit)
// - Datasets, views, annotations use REST API (not Y.js)

// MUST precede the auth middleware require below, which computes
// DEV_BYPASS_AUTH once at import time from NODE_ENV + DEV_BYPASS_AUTH.
// Started as a bare `node server.js` (package.json "websocket"), nothing else
// loaded .env for it, so both read as unset and DEV_BYPASS_AUTH was false —
// meaning authenticateSocket() closed EVERY Y.js connection with 1008
// "Missing access token". Y.js carries all collaboration state (avatar poses,
// participant roster, visualization sync), so multi-user collaboration was
// entirely dead in dev while the app otherwise looked healthy.
//
// NOTE the PORT handling further down: .env defines PORT for the API server,
// so this file deliberately reads YJS_PORT instead of inheriting it.
require("dotenv").config();

const WebSocket = require("ws");
const http = require("http");
const Y = require("yjs");
const { encoding, decoding } = require("lib0");
const syncProtocol = require("y-protocols/sync");
const awarenessProtocol = require("y-protocols/awareness");
const { createLogger } = require("./server/src/utils/logger");
const { DEV_BYPASS_AUTH, verifyJwtToken } = require("./server/src/middleware/auth");
const {
  YjsPersistenceService,
} = require("./server/src/services/yjsPersistence");
const { createMatrixBridge } = require("./server/src/services/matrixBridge");

const wsLog = createLogger("ws");
const serverLog = createLogger("server");
const syncLog = createLogger("sync");
const recordingLog = createLogger("recording");
const matrixLog = createLogger("matrix-bridge");

// Message types (Y.js protocol)
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

// Sentinel transactionOrigin for the initial DB-hydration update in
// Room.loadFromDB(). Lets the centralized doc.on("update") listener (see the
// Room constructor) recognize "these bytes just came FROM the database" and
// skip re-persisting them, without skipping the broadcast (harmless — by the
// time loadFromDB() runs, getOrCreateRoom()'s readyPromise guarantees no
// client has connected to this room yet).
const DB_LOAD_ORIGIN = Symbol("yjs-db-load");

// Build database connection config from environment
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME || "cia_analytics",
  user: process.env.DB_USER || "ciauser",
  password: process.env.DB_PASSWORD || "ciadevpassword",
};

// Initialize persistence service
let persistence = null;
try {
  persistence = YjsPersistenceService.create(dbConfig);
  syncLog.info("Y.js persistence service initialized");
} catch (err) {
  syncLog.error("Failed to initialize persistence:", err.message);
  syncLog.warn("Running without persistence - data will not be saved");
}

// Initialize Matrix bridge (if enabled)
let matrixBridge = null;
if (process.env.MATRIX_FEDERATION_ENABLED === 'true' && persistence) {
  try {
    matrixBridge = createMatrixBridge({
      enabled: true,
      homeserverUrl: process.env.MATRIX_BASE_URL || 'http://localhost:8008',
      serverName: process.env.MATRIX_SERVER_NAME || 'matrix.cia-web.local',
      asToken: process.env.MATRIX_AS_TOKEN,
      hsToken: process.env.MATRIX_HS_TOKEN,
      senderLocalpart: 'cia_bridge',
    });

    // Initialize Matrix bridge asynchronously
    (async () => {
      try {
        await matrixBridge.initialize(persistence, persistence.pool);

        // Set Matrix bridge on persistence service
        persistence.setMatrixBridge(matrixBridge);

        // Set up callback for inbound Matrix messages
        matrixBridge.onMessageFromMatrix = (messageData) => {
          // Find the Y.js room for this message
          const room = rooms.get(messageData.roomId);
          if (!room) {
            matrixLog.warn('Received Matrix message for unknown room:', messageData.roomId);
            return;
          }

          // Add the message to the Y.js chatMessages array
          const chatArray = room.doc.getArray('chatMessages');

          // Create message object matching Y.js chat format.
          // IMPORTANT: metadata.federation_source must be set to 'matrix' here — this is
          // the exact field matrixBridge.syncToMatrix() checks to suppress echo (relaying
          // a Matrix-origin message back to Matrix). It also tells Room.persistChatMessage
          // (below) to skip re-persisting, since this message was already stored in
          // chat_messages by matrixBridge._handleIncomingMatrixMessage().
          const yjsMessage = {
            id: messageData.messageId,
            userName: messageData.username,
            text: messageData.message,
            timestamp: messageData.timestamp.toISOString(),
            messageType: 'text',
            metadata: {
              isFederated: true,
              federation_source: 'matrix',
              matrix_event_id: messageData.federation?.eventId,
              matrix_sender: messageData.federation?.sender,
            },
          };

          // Add to Y.js array (this will sync to all connected clients)
          chatArray.push([yjsMessage]);

          matrixLog.info('Broadcast Matrix message to Y.js clients:', messageData.roomId);
        };

        // Set up callback for federated membership changes (Matrix user joined/left a
        // bridged room). Surfaced as a system-style chat entry so clients see federated
        // presence without needing a separate wire protocol.
        matrixBridge.onMembershipChange = (change) => {
          const room = rooms.get(change.roomId);
          if (!room) {
            matrixLog.debug('Membership change for unknown room:', change.roomId);
            return;
          }

          const chatArray = room.doc.getArray('chatMessages');

          const verb = change.type === 'member_joined' ? 'joined' : 'left';
          const systemMessage = {
            id: `matrix-membership-${change.userId}-${Date.now()}`,
            userName: 'system',
            text: `${change.displayName || change.userId} ${verb} via Matrix federation`,
            timestamp: new Date().toISOString(),
            messageType: 'system',
            metadata: {
              isFederated: true,
              federationEvent: change.type,
              matrixUserId: change.userId,
              matrixRoomId: change.matrixRoomId,
            },
          };

          chatArray.push([systemMessage]);

          matrixLog.info('Broadcast Matrix membership change to Y.js clients:', {
            roomId: change.roomId,
            type: change.type,
            userId: change.userId,
          });
        };

        matrixLog.info('Matrix federation enabled for Y.js chat');
      } catch (error) {
        matrixLog.error('Failed to initialize Matrix bridge:', error.message);
        matrixLog.warn('Chat will continue without Matrix federation');
      }
    })();
  } catch (error) {
    matrixLog.error('Failed to create Matrix bridge:', error.message);
  }
} else if (process.env.MATRIX_FEDERATION_ENABLED === 'true') {
  matrixLog.warn('Matrix federation enabled but persistence not available');
} else {
  matrixLog.info('Matrix federation disabled');
}

/**
 * Active recording cache
 * Maps projectId -> { recordingId, startTime, eventCount }
 */
const activeRecordings = new Map();

/**
 * Cursor throttling state
 * Maps clientId -> { x, y, z, timestamp }
 */
const lastCursorPositions = new Map();

// Cursor recording settings
const CURSOR_THROTTLE_MS = 66; // ~15 fps

/**
 * Refresh active recordings cache from database
 */
async function refreshActiveRecordings() {
  if (!persistence?.pool) return;

  try {
    const result = await persistence.pool.query(`
      SELECT id, project_id, started_at
      FROM session_recordings
      WHERE status = 'recording'
    `);

    // Clear and rebuild cache
    activeRecordings.clear();

    for (const row of result.rows) {
      activeRecordings.set(row.project_id, {
        recordingId: row.id,
        startTime: new Date(row.started_at).getTime(),
        eventCount: 0,
      });
    }

    if (result.rows.length > 0) {
      recordingLog.debug(`Recording cache: ${result.rows.length} active`);
    }
  } catch (err) {
    recordingLog.error("Failed to refresh recordings cache:", err.message);
  }
}

/**
 * Check if cursor update should be recorded (throttle + delta filter)
 */
function shouldRecordCursor(clientId, cursor) {
  if (!cursor || cursor.x === undefined || cursor.y === undefined) return false;

  const now = Date.now();
  const last = lastCursorPositions.get(clientId);

  // Time throttle (~15 fps)
  if (last && now - last.timestamp < CURSOR_THROTTLE_MS) {
    return false;
  }

  // Delta filter - skip if barely moved (use 2D since we get screen coords)
  if (last) {
    const dx = Math.abs((cursor.x || 0) - (last.x || 0));
    const dy = Math.abs((cursor.y || 0) - (last.y || 0));

    // Screen coordinates - use pixel threshold instead of percentage
    const MIN_PIXEL_MOVEMENT = 5; // 5 pixels
    if (dx < MIN_PIXEL_MOVEMENT && dy < MIN_PIXEL_MOVEMENT) {
      return false;
    }
  }

  // Update last position
  lastCursorPositions.set(clientId, {
    x: cursor.x || 0,
    y: cursor.y || 0,
    timestamp: now,
  });

  return true;
}

/**
 * Clean up cursor state when client disconnects
 */
function cleanupClientCursor(clientId) {
  lastCursorPositions.delete(clientId);
}

/**
 * Store an event to recording_events table
 * @param {string} projectId - Project UUID
 * @param {string} eventType - Type: 'yjs_update', 'chat', 'cursor', 'awareness'
 * @param {string} eventSource - More specific: 'chat:message', 'cursor:move', etc.
 * @param {object} eventData - Event payload
 * @param {string} userId - Optional user UUID
 * @param {number} clientId - Y.js awareness client ID
 */
async function recordEvent(
  projectId,
  eventType,
  eventSource,
  eventData,
  userId = null,
  clientId = null
) {
  const recording = activeRecordings.get(projectId);
  if (!recording || !persistence?.pool) return;

  try {
    const timestampOffset = Date.now() - recording.startTime;

    await persistence.pool.query(
      `INSERT INTO recording_events
       (recording_id, timestamp_offset_ms, event_type, event_source, event_data, user_id, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        recording.recordingId,
        timestampOffset,
        eventType,
        eventSource,
        JSON.stringify(eventData),
        userId,
        clientId ? String(clientId) : null,
      ]
    );

    recording.eventCount++;

    // Log every 100 events
    if (recording.eventCount % 100 === 0) {
      recordingLog.debug(
        `Recording ${recording.recordingId}: ${recording.eventCount} events`
      );
    }
  } catch (err) {
    recordingLog.error("Failed to record event:", err.message);
  }
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

/**
 * Room state - holds Y.Doc and connected clients
 */
class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.clients = new Set();
    this.projectId = null;
    this.isLoaded = false;
    // Set by getOrCreateRoom() immediately after construction — every caller
    // awaits this before touching the room, so the doc is never exposed to
    // sync code until loading has succeeded or definitively failed.
    this.readyPromise = null;
    this.lastUpdateId = null;
    // Track which message IDs we've already persisted to avoid duplicates
    this.persistedMessageIds = new Set();

    // Names of the top-level shared types touched by the most recently applied
    // transaction. Used by detectUpdateOrigin() to classify updates so transient
    // presence/pose/cursor traffic is not persisted or recorded (see below).
    this._lastChangedRoots = new Set();
    this.doc.on("afterTransaction", (tr) => {
      const roots = new Set();
      tr.changed.forEach((_keys, type) => {
        const name = rootNameOf(this.doc, type);
        if (name) roots.add(name);
      });
      this._lastChangedRoots = roots;
    });

    // Centralized propagation point for every accepted Y.Doc mutation,
    // regardless of source: a live update message, a sync-step-2 reconnect
    // replay (readUpdate === readSyncStep2 in y-protocols — identical code
    // path to a plain update), a server-side mutation with no socket (Matrix
    // bridge chat injection), or DB hydration. `afterTransaction` (above)
    // always fires before `update` for the same transaction (yjs's
    // cleanupTransactions emits afterTransaction inside its try block, update
    // later in finally), so detectUpdateOrigin() below always sees this
    // transaction's freshly-populated _lastChangedRoots.
    this.doc.on("update", (update, origin) => {
      const originSocket = origin instanceof WebSocket ? origin : null;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      broadcastToRoom(this, encoding.toUint8Array(encoder), originSocket);

      if (origin === DB_LOAD_ORIGIN) return; // don't re-persist what we just loaded

      const changeOrigin = detectUpdateOrigin(this);
      this.storeUpdate(
        update,
        changeOrigin,
        originSocket?.userId || null,
        originSocket?.clientId || null
      );
    });

    // Track chat messages for persistence
    this.setupChatObserver();
  }

  /**
   * Set up observer to detect new chat messages
   */
  setupChatObserver() {
    const chatArray = this.doc.getArray("chatMessages");

    chatArray.observe((event) => {
      // Process chat message inserts from Y.js delta
      event.changes.delta.forEach((change) => {
        if (change.insert) {
          change.insert.forEach((message) => {
            // Skip if already persisted (by ID)
            if (
              message &&
              message.id &&
              !this.persistedMessageIds.has(message.id)
            ) {
              this.persistedMessageIds.add(message.id);
              this.persistChatMessage(message);
            }
          });
        }
      });
    });

    wsLog.debug("Chat observer set up for room:", this.roomId);
  }

  /**
   * Persist a chat message to the database
   * UPDATED: Also records to recording_events if recording is active
   */
  async persistChatMessage(message) {
    if (!persistence) return;

    try {
      const {
        userName,
        text,
        timestamp,
        messageType,
        metadata,
        id: messageId,
      } = message;

      // Messages that originated from Matrix (inbound federation) are already stored
      // in chat_messages by matrixBridge._handleIncomingMatrixMessage() before being
      // pushed into this Y.js array — skip re-persisting to avoid a duplicate row and
      // (more importantly) avoid re-triggering syncToMatrix's echo-suppression logic
      // being bypassed by a fresh insert with no matrix_event_id linkage.
      if (metadata?.federation_source === "matrix") {
        wsLog.debug(
          "Skipping persistence for already-stored Matrix-federated message:",
          messageId
        );
        return;
      }

      // Federated membership notices (Matrix user joined/left) are ephemeral presence
      // info, not chat content — don't write them to the chat_messages audit trail or
      // sync them back to Matrix.
      if (messageType === "system") {
        wsLog.debug("Skipping persistence for system/presence message:", messageId);
        return;
      }

      await persistence.storeChatMessage(
        this.roomId,
        this.projectId,
        null, // userId - null until proper auth is implemented
        userName || "Anonymous",
        text || "",
        null,
        {
          clientTimestamp: timestamp,
          messageType: messageType || "text",
          ...metadata,
        }
      );

      wsLog.debug("Chat persisted:", userName, "in", this.roomId);

      // Record chat message to recording_events
      if (this.projectId && activeRecordings.has(this.projectId)) {
        await recordEvent(
          this.projectId,
          "chat",
          "chat:message",
          {
            messageId,
            userName,
            text: text?.substring(0, 500), // Truncate for storage
            messageType: messageType || "text",
            timestamp,
          },
          null,
          null
        );
      }
    } catch (err) {
      wsLog.error("Failed to persist chat:", err.message);
    }
  }

  /**
   * Load document state from database
   */
  async loadFromDB() {
    if (!persistence || this.isLoaded) return;

    try {
      const docRecord = await persistence.getOrCreateDocument(
        this.roomId,
        this.projectId
      );

      if (docRecord.documentState && docRecord.documentState.length > 0) {
        Y.applyUpdate(this.doc, docRecord.documentState, DB_LOAD_ORIGIN);
        syncLog.info(
          "Loaded Y.Doc state for room:",
          this.roomId,
          "version:",
          docRecord.snapshotVersion
        );
      }

      this.lastUpdateId = docRecord.lastUpdateId;
      this.isLoaded = true;

      // Schedule periodic snapshots — durable roots only (see
      // buildDurableSnapshotState); this runs continuously for any active
      // room, so an unfiltered encode here was the highest-impact instance
      // of the H8 bug, not just the shutdown-only close() below.
      persistence.scheduleSnapshots(this.roomId, () =>
        buildDurableSnapshotState(this.doc)
      );
    } catch (err) {
      syncLog.error("Failed to load document:", this.roomId, err.message);
    }
  }

  /**
   * Store a Y.js update to the database
   * UPDATED: Also records to recording_events if recording is active
   */
  async storeUpdate(update, origin, userId, clientId) {
    if (!persistence) return;

    try {
      // Existing persistence logic
      const result = await persistence.storeUpdate(
        this.roomId,
        update,
        origin,
        userId,
        clientId
      );

      if (result) {
        this.lastUpdateId = result.id;
      }

      // NEW: Record to recording_events if active
      if (this.projectId && activeRecordings.has(this.projectId)) {
        // Skip noisy cursor/awareness updates unless you want them
        if (
          origin !== "cursor" &&
          origin !== "presence" &&
          origin !== "avatar"
        ) {
          await recordEvent(
            this.projectId,
            "yjs_update",
            origin ? `yjs:${origin}` : "yjs:unknown",
            {
              updateSize: update.length,
              origin,
              sequenceNum: result?.sequenceNum,
            },
            userId,
            clientId
          );
        }
      }
    } catch (err) {
      syncLog.error("Failed to store update:", err.message);
    }
  }

  /**
   * Final snapshot when room is closed
   */
  async close() {
    if (!persistence) return;

    try {
      const state = buildDurableSnapshotState(this.doc);
      await persistence.finalSnapshot(this.roomId, state);
    } catch (err) {
      syncLog.error("Failed to save final snapshot:", err.message);
    }
  }
}

// Store rooms by name
const rooms = new Map();

/**
 * Get or create a room
 */
async function getOrCreateRoom(roomName) {
  let room = rooms.get(roomName);
  if (!room) {
    room = new Room(roomName);
    rooms.set(roomName, room);

    // Assigned synchronously, in the same tick as rooms.set() above and
    // before any await — so a concurrent getOrCreateRoom(roomName) call can
    // only ever observe a room that already has this promise set. EVERY
    // caller (including this one) awaits it below, so no caller can be
    // handed a room whose doc hasn't finished loading (or definitively
    // failed to — loadFromDB()'s own try/catch means this never rejects).
    room.readyPromise = room.loadFromDB().then(() => {
      // The room is registered BEFORE the load above, but has no clients yet
      // — so a client disconnecting during the load sees clients.size === 0
      // and deletes it from `rooms` (see the close handler). Re-registering
      // the instance we built keeps that from happening behind our back.
      //
      // This used to be checked with a plain `rooms.get(roomName)` return,
      // which in exactly that race returned UNDEFINED and crashed the whole
      // server on the caller's `room.clients.add(socket)` — taking every
      // other room's session with it. Chained onto readyPromise so it runs
      // exactly once, regardless of how many callers are concurrently
      // awaiting it.
      if (rooms.get(roomName) !== room) rooms.set(roomName, room);
      return room;
    });
  }

  return room.readyPromise;
}

/**
 * Send sync step 1 to a new client
 */
function sendSyncStep1(socket, doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  send(socket, encoding.toUint8Array(encoder));
}

/**
 * Send awareness update to client
 */
function sendAwarenessUpdate(socket, awareness, changedClients) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
  );
  send(socket, encoding.toUint8Array(encoder));
}

/**
 * Broadcast to all clients in room except sender
 */
function broadcastToRoom(room, message, excludeSocket = null) {
  room.clients.forEach((client) => {
    if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        wsLog.error("Failed to broadcast:", error.message);
      }
    }
  });
}

/**
 * Safe send wrapper
 */
function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(message);
    } catch (error) {
      wsLog.error("Failed to send:", error.message);
    }
  }
}

/**
 * Handle incoming Y.js protocol messages
 */
async function handleMessage(socket, room, message) {
  try {
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC:
        handleSyncMessage(socket, room, decoder);
        break;

      case MESSAGE_AWARENESS:
        handleAwarenessMessage(socket, room, decoder, message);
        break;

      case MESSAGE_QUERY_AWARENESS:
        // Client requesting awareness state
        sendAwarenessUpdate(
          socket,
          room.awareness,
          Array.from(room.awareness.getStates().keys())
        );
        break;

      default:
        wsLog.warn("Unknown message type:", messageType);
    }
  } catch (error) {
    wsLog.error("Error handling message:", error.message);
  }
}

/**
 * Handle Y.js sync protocol messages
 */
function handleSyncMessage(socket, room, decoder) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);

  syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);

  // Broadcasting to other clients and persisting the change are handled
  // uniformly by Room's doc.on("update", ...) listener (see the Room
  // constructor) for every message subtype that actually mutates the doc —
  // sync step 2 (reconnect replay) and update messages apply through the
  // exact same y-protocols code path (readUpdate === readSyncStep2), so there
  // is no propagation logic here to branch on subtype.
  if (encoding.length(encoder) > 1) {
    send(socket, encoding.toUint8Array(encoder));
  }
}

// ============================================================================
// CURSOR RECORDING FIX for server.js (Y.js WebSocket Server)
//
// Replace the handleAwarenessMessage function with this version.
// This fix properly extracts client IDs from awareness updates to record cursors.
// ============================================================================

/**
 * Decode client IDs from an awareness update
 * The awareness update format is:
 * - Number of clients (varUint)
 * - For each client: clientID (varUint), clock (varUint), state (nullable string)
 *
 * @param {Uint8Array} update - The awareness update binary
 * @returns {number[]} Array of client IDs in this update
 */
function decodeAwarenessUpdateClientIds(update) {
  const clientIds = [];
  try {
    const decoder = decoding.createDecoder(update);
    const numClients = decoding.readVarUint(decoder);

    for (let i = 0; i < numClients; i++) {
      const clientId = decoding.readVarUint(decoder);
      clientIds.push(clientId);
      // Skip clock and state - we just need the IDs
      decoding.readVarUint(decoder); // clock
      decoding.readVarString(decoder); // state (JSON string or empty)
    }
  } catch (err) {
    recordingLog.debug("Failed to decode awareness update:", err.message);
  }
  return clientIds;
}

/**
 * Handle awareness protocol messages
 * FIXED: Now properly extracts client IDs and records cursor positions
 */
function handleAwarenessMessage(socket, room, decoder, rawMessage) {
  const update = decoding.readVarUint8Array(decoder);

  // Apply the awareness update
  awarenessProtocol.applyAwarenessUpdate(room.awareness, update, socket);

  // Relay to other clients
  broadcastToRoom(room, rawMessage, socket);

  // Extract client IDs from this update
  const updatedClientIds = decodeAwarenessUpdateClientIds(update);

  // Track every ID this socket has ever announced (a star-topology client
  // only ever announces its own state, but this stays correct even if that
  // ever changes) — this is the set removed on disconnect, below.
  updatedClientIds.forEach((id) => socket.awarenessClientIds.add(id));

  // If this socket doesn't have a clientId yet, try to associate it
  // The first awareness update from a client typically contains their own state
  if (!socket.clientId && updatedClientIds.length > 0) {
    // Find which client ID in this update has user info matching this socket
    const states = room.awareness.getStates();
    for (const clientId of updatedClientIds) {
      const state = states.get(clientId);
      if (
        state?.user?.name === socket.username ||
        state?.userId === socket.userId
      ) {
        socket.clientId = clientId;
        recordingLog.debug(
          `Associated socket with clientId: ${clientId} for user: ${socket.username}`
        );
        break;
      }
    }
    // Fallback: just use the first client ID if we can't match
    if (!socket.clientId && updatedClientIds.length === 1) {
      socket.clientId = updatedClientIds[0];
      recordingLog.debug(
        `Fallback: Associated socket with clientId: ${socket.clientId}`
      );
    }
  }

  // Record cursor if recording is active
  if (room.projectId && activeRecordings.has(room.projectId)) {
    const states = room.awareness.getStates();

    // Check each updated client for cursor data
    for (const clientId of updatedClientIds) {
      const localState = states.get(clientId);

      if (!localState) continue;

      // Debug: Log what keys are in the awareness state
      if (recordingLog.isDebugEnabled?.()) {
        recordingLog.debug(
          `Client ${clientId} awareness keys: ${Object.keys(localState).join(
            ", "
          )}`
        );
      }

      // Check if this client has cursor data and it passes throttle/delta filter
      if (
        localState.cursor &&
        shouldRecordCursor(clientId, localState.cursor)
      ) {
        // Record the cursor event
        recordEvent(
          room.projectId,
          "cursor",
          "cursor:move",
          {
            instanceId: localState.cursor.instanceId,
            x: localState.cursor.x,
            y: localState.cursor.y,
            timestamp: localState.cursor.timestamp,
            user: localState.user
              ? {
                  name: localState.user.userName || localState.user.name,
                  color: localState.user.userColor || localState.user.color,
                }
              : null,
          },
          socket.userId,
          clientId // Use the actual client ID from the update
        );

        recordingLog.debug(
          `Recorded cursor for client ${clientId}: (${localState.cursor.x}, ${localState.cursor.y})`
        );
      }
    }
  }
}

/**
 * Reverse-lookup the root (top-level) name of a shared type in a Y.Doc.
 * All of our collaboration maps/arrays are registered at the document root
 * (doc.getMap(name) / doc.getArray(name)), so doc.share holds name -> type.
 * @returns {string|null}
 */
function rootNameOf(doc, type) {
  for (const [name, t] of doc.share.entries()) {
    if (t === type) return name;
  }
  return null;
}

// Top-level shared types that carry transient presence/pose/cursor state. These
// are self-cleaning, high-frequency, and must NOT be persisted to yjs_updates,
// recorded, or included in a durable snapshot — mapped to the origins that
// storeUpdate()/recordEvent() skip. Single source of truth for both live
// update-origin tagging (detectUpdateOrigin) and snapshot filtering
// (buildDurableSnapshotState) — a root missing from here used to be silently
// treated as durable in BOTH places, which is how stale avatars, VR
// controller poses, manipulation/control locks, and VR session registries
// came back to life after a server restart.
const TRANSIENT_ROOT_ORIGINS = {
  cursors: "cursor",
  vrCursors: "cursor",
  vrHands: "cursor",
  avatars: "avatar",
  manipulatorState: "presence",
  viewPresence: "presence",
  vrControllers: "presence", // yjsSetup.js's yVRControllers
  "vr-sessions": "presence", // yjsSetup.js's yVRSessions — VR session registry
};

// Root names that are minted per-session (`${prefix}${sessionId}`), so they
// can't be listed exactly in TRANSIENT_ROOT_ORIGINS above.
const TRANSIENT_ROOT_PREFIXES = [
  { prefix: "vr-participants-", origin: "presence" }, // VRParticipantSync.js
  { prefix: "vr-manipulation-", origin: "presence" }, // VRManipulationLock.js
  { prefix: "vr-control-", origin: "presence" },      // VRControlManager.js
  { prefix: "vr-join-order-", origin: "presence" },   // VRParticipantSync.js join-order array
];

/**
 * Classify a single top-level shared-type root name.
 * @param {string} name
 * @returns {"cursor"|"avatar"|"presence"|null} the transient origin, or null if durable.
 */
function classifyTransientRoot(name) {
  if (Object.prototype.hasOwnProperty.call(TRANSIENT_ROOT_ORIGINS, name)) {
    return TRANSIENT_ROOT_ORIGINS[name];
  }
  for (const { prefix, origin } of TRANSIENT_ROOT_PREFIXES) {
    if (name.startsWith(prefix)) return origin;
  }
  return null;
}

/**
 * Whether a root belongs in a durable snapshot. `chatMessages` is not in
 * TRANSIENT_ROOT_ORIGINS/PREFIXES (it's persisted+recorded, not skipped —
 * see detectUpdateOrigin's separate "chat" origin below), so it naturally
 * classifies as durable here too, same as visualizationState/cameras/etc.
 * @param {string} name
 */
function isDurableRootName(name) {
  return classifyTransientRoot(name) === null;
}

/**
 * Classify an applied update by which top-level shared types it touched (captured
 * by the room's afterTransaction observer). Returns one of:
 *   - "cursor" | "avatar" | "presence": transient — skipped by persistence/recording
 *   - "chat": chat traffic (persisted + recorded)
 *   - "document": durable view/camera/dataset state (persisted)
 *   - null: unknown — persisted (safe default)
 * If an update touches ANY durable type, it is treated as durable even if it also
 * touched a transient one.
 */
function detectUpdateOrigin(room) {
  const roots = room?._lastChangedRoots;
  if (!roots || roots.size === 0) return null;

  let sawDurable = false;
  let sawChat = false;
  let transient = null;

  for (const name of roots) {
    if (name === "chatMessages") {
      sawChat = true;
      continue;
    }
    const origin = classifyTransientRoot(name);
    if (origin === null) {
      // Any other root (visualizationState, cameras, activeDataset, ...) is
      // durable document state.
      sawDurable = true;
    } else {
      // Prefer the most specific transient label; any is skippable.
      transient = transient === "avatar" ? transient : origin;
    }
  }

  if (sawDurable) return "document";
  if (sawChat) return "chat";
  return transient;
}

/**
 * Build a snapshot Y.js update containing only durable roots — used for both
 * Room.close()'s shutdown snapshot and the periodic scheduleSnapshots
 * callback, so persisted state can never resurrect transient presence/pose/
 * lock/session data after a restart.
 *
 * This works by round-tripping the whole doc through Yjs's own update
 * encoding into a scratch Y.Doc, then deleting the transient roots' content
 * in the copy — NOT by copying wanted values across by reference. Some
 * durable roots (e.g. visualizationState — see syncVisualizationToYjs in
 * yjsSetup.js) nest already-integrated Y.Map/Y.Array values, and a Yjs shared
 * type can only ever belong to one Y.Doc; `scratch.getMap(name).set(key,
 * value)` with such a value throws. Y.applyUpdate always constructs fresh
 * type instances owned by `scratch`, so nothing from `doc` is ever reused,
 * and arbitrary nesting depth is handled automatically. With gc enabled
 * (the default for a plain `new Y.Doc()`), deleting a transient root's
 * entries drops their content from subsequent encodeStateAsUpdate calls —
 * same net effect as the old copy-what's-wanted approach. This collapses
 * per-op CRDT history for every root, which is fine — storeSnapshot already
 * does a full overwrite (`UPDATE ... SET document_state = $2`), i.e.
 * snapshots are squashes today regardless.
 *
 * Root type/name info is read from the ORIGINAL `doc.share` (not
 * `scratch.share`): after Y.applyUpdate, an untouched root in `scratch.share`
 * is a bare AbstractType stub, not yet upgraded to the concrete YMap/YArray
 * subclass — `instanceof Y.Map` would never match, and stubs have no
 * `.clear()`/`.delete()`. Calling `scratch.getMap(name)`/`getArray(name)`
 * upgrades (or creates) the properly-typed instance to actually mutate.
 * @param {Y.Doc} doc
 * @returns {Uint8Array}
 */
function buildDurableSnapshotState(doc) {
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));

  for (const [name, type] of doc.share.entries()) {
    if (isDurableRootName(name)) continue; // keep durable roots as-is

    if (type instanceof Y.Map) {
      scratch.getMap(name).clear();
    } else if (type instanceof Y.Array) {
      const arr = scratch.getArray(name);
      if (arr.length > 0) arr.delete(0, arr.length);
    } else {
      syncLog.warn("Could not strip unrecognized transient root type from snapshot:", name);
    }
  }

  return Y.encodeStateAsUpdate(scratch);
}

/**
 * Authenticate a socket using Keycloak JWT
 */
async function authenticateSocket(socket, url) {
  if (DEV_BYPASS_AUTH) {
    socket.userId =
      url.searchParams.get("userId") || "00000000-0000-0000-0000-000000000001";
    socket.username =
      url.searchParams.get("username") || "Development User";
    return true;
  }

  const token =
    url.searchParams.get("token") || url.searchParams.get("access_token");
  if (!token) {
    wsLog.warn("Missing access token for Y.js connection");
    socket.close(1008, "Missing access token");
    return false;
  }

  try {
    const user = await verifyJwtToken(token);
    socket.userId = user.id;
    socket.username = user.name || user.email || "User";
    return true;
  } catch (error) {
    wsLog.warn("Y.js authentication failed:", error.message);
    socket.close(1008, "Authentication failed");
    return false;
  }
}

/**
 * Check if user can access a project
 */
async function checkProjectAccess(projectId, userId) {
  if (!persistence?.pool) {
    wsLog.warn("Project access check skipped (no DB pool configured)");
    return false;
  }

  try {
    const result = await persistence.pool.query(
      `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId]
    );
    return result.rows.length > 0;
  } catch (error) {
    wsLog.error("Failed to check project access:", error.message);
    return false;
  }
}

const ROOM_DOC_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_DOC_PROJ_PREFIX_RE =
  /^project:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Check if user can access a Y.js room document, and resolve the room's
 * real project id.
 *
 * Access rules:
 * 1. Room membership: if the roomId is a known room UUID, user must be in room_members
 *    OR the room must be public AND user must be a project member (of that room's own project).
 * 2. Legacy fallback: if roomId does NOT match any row in `rooms`, it is treated as a
 *    pre-DR6 room name that IS a project UUID (bare UUID, or "project:<uuid>") — checked
 *    via project_members using the UUID extracted from roomId itself.
 * 3. Otherwise denied.
 *
 * IMPORTANT: this never trusts a client-supplied projectId — the room-to-project
 * relationship is always looked up from the database (or derived deterministically
 * from roomId's own format), never from a separate, independently-controlled
 * parameter. Otherwise a user could pair a private room's UUID with an unrelated
 * project they belong to and slip past the room-membership check.
 *
 * @param {string} roomId Y.js room name (typically a CIA room UUID)
 * @param {string} userId Authenticated user ID
 * @returns {Promise<{allowed: boolean, projectId: string|null}>}
 */
async function checkRoomDocumentAccess(roomId, userId) {
  if (!persistence?.pool) {
    wsLog.warn("Room access check skipped (no DB pool) — denying access");
    return { allowed: false, projectId: null }; // Fail closed — can't verify membership
  }

  try {
    if (ROOM_DOC_UUID_RE.test(roomId)) {
      // Room membership check (private rooms: must be member; public rooms: project member)
      const roomResult = await persistence.pool.query(
        `SELECT r.project_id FROM room_members rm
           JOIN rooms r ON r.id = rm.room_id
         WHERE rm.room_id = $1 AND rm.user_id = $2
         UNION
         SELECT r.project_id FROM rooms r
           JOIN project_members pm ON pm.project_id = r.project_id
         WHERE r.id = $1 AND pm.user_id = $2 AND r.is_public = true`,
        [roomId, userId]
      );
      if (roomResult.rows.length > 0) {
        return { allowed: true, projectId: roomResult.rows[0].project_id };
      }

      // roomId is a real room the user isn't in — don't fall through to the
      // legacy path below for a room that actually exists.
      const roomExists = await persistence.pool.query(
        `SELECT 1 FROM rooms WHERE id = $1`,
        [roomId]
      );
      if (roomExists.rows.length > 0) {
        return { allowed: false, projectId: null };
      }
    }

    // Legacy fallback: pre-DR6 room names ARE project UUIDs (no `rooms` row).
    // Only the UUID embedded in roomId itself is trusted here.
    const projPrefixMatch = ROOM_DOC_PROJ_PREFIX_RE.exec(roomId);
    const legacyProjectId = projPrefixMatch
      ? projPrefixMatch[1]
      : ROOM_DOC_UUID_RE.test(roomId)
        ? roomId
        : null;
    if (!legacyProjectId) return { allowed: false, projectId: null };

    const projResult = await persistence.pool.query(
      `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [legacyProjectId, userId]
    );
    return projResult.rows.length > 0
      ? { allowed: true, projectId: legacyProjectId }
      : { allowed: false, projectId: null };
  } catch (error) {
    wsLog.error("Failed to check room document access:", error.message);
    return { allowed: false, projectId: null };
  }
}

/**
 * Handle new WebSocket connection
 */
wss.on("connection", async (socket, req) => {
  // Liveness tracking for the ping/pong sweep below (see PING_INTERVAL_MS) —
  // must be set for every connection, including ones that never make it past
  // authentication, so a stuck half-open socket still gets reaped.
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  // Parse URL and query params
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawRoomName =
    url.searchParams.get("room") || url.pathname.slice(1) || "default";

  // DR6.5: Sanitize room name to prevent doc key injection or path traversal.
  // Accept standard UUIDs, "project:{uuid}" prefix, or safe alphanumeric keys.
  const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PROJ_RE     = /^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SAFE_KEY_RE = /^[a-z0-9_-]{1,128}$/i;
  if (!UUID_RE.test(rawRoomName) && !PROJ_RE.test(rawRoomName) && !SAFE_KEY_RE.test(rawRoomName)) {
    wsLog.warn("Y.js connection rejected — invalid room name format:", rawRoomName);
    socket.close(1008, "Invalid room name");
    return;
  }
  const roomName = rawRoomName;

  // Authenticate connection
  const isAuthenticated = await authenticateSocket(socket, url);
  if (!isAuthenticated) {
    return;
  }

  // Extract projectId — prefer explicit URL param, fall back to room-name convention.
  // This is only a display/logging hint and a DEV_BYPASS_AUTH convenience — it is
  // never used to authorize room-document access. checkRoomDocumentAccess() below
  // resolves the authoritative project from the room itself and overwrites this.
  let projectId = url.searchParams.get("projectId") || null;
  if (!projectId) {
    if (roomName.startsWith("project:")) {
      projectId = roomName.split(":")[1];
    } else if (roomName.match(/^[0-9a-f-]{36}$/i)) {
      // Legacy: UUID room name treated as projectId (pre-DR6 behavior)
      projectId = roomName;
    }
  }

  // DR6: Room document access check — membership required in production
  if (!DEV_BYPASS_AUTH) {
    const { allowed, projectId: verifiedProjectId } = await checkRoomDocumentAccess(
      roomName,
      socket.userId
    );
    if (!allowed) {
      wsLog.warn(
        "Y.js room access denied:",
        socket.userId,
        "→",
        roomName,
        "(requested project hint:",
        projectId,
        ")"
      );
      socket.close(1008, "Access denied to room document");
      return;
    }
    // Use the DB-verified project association, not the client-supplied hint.
    projectId = verifiedProjectId;
  }

  socket.clientId = null; // Will be set from awareness
  // Every awareness client ID this socket has ever announced (see
  // handleAwarenessMessage) — used on disconnect to remove exactly the right
  // presence entries instead of the shared, unrelated room.doc.clientID.
  socket.awarenessClientIds = new Set();

  wsLog.info("Client connected to room:", roomName, "user:", socket.username);

  // Get or create room
  const room = await getOrCreateRoom(roomName);
  room.clients.add(socket);

  // Set projectId on room if we extracted it
  if (projectId && !room.projectId) {
    room.projectId = projectId;

    // Check if this project has an active recording
    await refreshActiveRecordings();
  }

  wsLog.debug("Total clients in room:", roomName, room.clients.size);

  // Send initial sync step 1 (request client state)
  sendSyncStep1(socket, room.doc);

  // Send current awareness state
  const awarenessStates = Array.from(room.awareness.getStates().keys());
  if (awarenessStates.length > 0) {
    sendAwarenessUpdate(socket, room.awareness, awarenessStates);
  }

  // Handle incoming messages
  socket.on("message", (message) => {
    handleMessage(socket, room, message);
  });

  // Handle disconnection
  socket.on("close", async () => {
    room.clients.delete(socket);

    // Clean up cursor state for every awareness ID this socket ever
    // announced (room.doc.clientID — the room's own Y.Doc identity, never an
    // awareness ID — is not a valid input here or below).
    socket.awarenessClientIds.forEach((id) => cleanupClientCursor(id));

    // Remove from awareness — and actually tell everyone else. Unlike
    // removing on an incoming update, there's no raw client message to relay
    // here, so the removal has to be encoded and broadcast explicitly, or
    // every other client keeps this user's avatar/cursor/presence forever.
    const idsToRemove = Array.from(socket.awarenessClientIds);
    if (idsToRemove.length > 0) {
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        idsToRemove,
        "disconnect"
      );

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, idsToRemove)
      );
      broadcastToRoom(room, encoding.toUint8Array(encoder));
    }

    wsLog.info("Client disconnected from:", roomName);
    wsLog.debug("Remaining clients:", room.clients.size);

    // Clean up empty rooms. Only ever evict the instance we actually hold, and
    // re-check emptiness AFTER the await — a client can connect and join this
    // same room while close() is still storing its snapshot, and dropping it
    // then would strand that client on a room no longer in `rooms`.
    if (room.clients.size === 0 && rooms.get(roomName) === room) {
      // Store final snapshot
      await room.close();

      if (rooms.get(roomName) === room && room.clients.size === 0) {
        rooms.delete(roomName);
        wsLog.debug("Room closed and saved:", roomName);
      } else {
        wsLog.debug("Room re-joined during close; keeping it:", roomName);
      }
    }
  });

  // Handle errors
  socket.on("error", (error) => {
    wsLog.error("WebSocket error:", error.message);
  });
});

// Application-level liveness sweep. A dropped Wi-Fi link or a headset going
// to sleep leaves a half-open TCP connection that neither side's OS reports
// as closed — without this, that socket lingers in room.clients (and its
// presence stays visible to everyone) until the underlying TCP stack times
// out, which can take minutes. Standard ws-library pattern: mark every
// socket dead by default each sweep, revive it on 'pong', and terminate
// whatever's still marked dead — which fires 'close' and runs the normal
// disconnect cleanup above.
const PING_INTERVAL_MS = 30000;
const pingInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      wsLog.warn("Terminating unresponsive Y.js connection (missed ping)");
      return socket.terminate();
    }
    socket.isAlive = false;
    socket.ping();
  });
}, PING_INTERVAL_MS);
wss.on("close", () => clearInterval(pingInterval));

// Listen for awareness changes to broadcast
// This is done per-room when clients join

// Deliberately NOT process.env.PORT. Now that this file loads .env (see the
// note at the top), the generic PORT there belongs to the API server on 3001 —
// inheriting it would make the Y.js server fight the API for the same port and
// fail to bind. Use YJS_PORT to override.
const PORT = process.env.YJS_PORT || 9001;

// Refresh active recordings cache on startup
refreshActiveRecordings();

// Refresh every 30 seconds to catch new recordings
setInterval(refreshActiveRecordings, 30000);

server.listen(PORT, () => {
  serverLog.info("Y.js WebSocket server running on port:", PORT);
  serverLog.info(
    "PostgreSQL persistence:",
    persistence ? "enabled" : "disabled"
  );
  serverLog.info(
    "Recording integration:",
    persistence?.pool ? "enabled" : "disabled"
  );
  serverLog.debug("Database host:", dbConfig.host);
  serverLog.debug("Ready for connections");
});

// Handle server errors
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    serverLog.error("Port already in use:", PORT);
    serverLog.error("Kill the process using port", PORT, "or change the port.");
    process.exit(1);
  } else {
    serverLog.error("Server error:", error);
  }
});

// Graceful shutdown
async function shutdown() {
  serverLog.info("Shutting down server gracefully...");

  // Close all rooms (saves final snapshots)
  for (const [roomName, room] of rooms) {
    serverLog.debug("Closing room:", roomName);
    await room.close();
  }

  // Close all WebSocket connections
  wss.clients.forEach((client) => {
    client.close();
  });

  // Shutdown Matrix bridge
  if (matrixBridge) {
    await matrixBridge.shutdown();
  }

  // Shutdown persistence service
  if (persistence) {
    await persistence.shutdown();
  }

  server.close(() => {
    serverLog.info("Server closed");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

serverLog.info("Starting Y.js WebSocket server with persistence...");

// Additive: exposes helper functions for unit testing (this file has no
// other exports — it's the process entry point, started via `node server.js`,
// not normally required as a module — requiring it still runs the startup
// sequence above; only these functions are useful to import elsewhere).
// checkRoomDocumentAccess reads module-scoped `persistence` internally, so
// tests exercise it by mocking `persistence.pool.query` via the
// YjsPersistenceService mock (see yjsWebsocketServer.test.js).
module.exports = {
  classifyTransientRoot,
  isDurableRootName,
  buildDurableSnapshotState,
  checkRoomDocumentAccess,
};
