/**
 * @file RemoteRenderClient.js
 * @description WebSocket client for the CIA_Web Python VTK render server.
 *
 * Manages connection, session lifecycle, dataset loading, camera updates,
 * and frame streaming. One instance = one WebSocket = one server-side render
 * session (its own dataset + camera). The server already creates an
 * independent RenderSession per connection, so each ServerRenderedViewport
 * must own its own client instance — sharing one instance across viewports
 * made them overwrite each other's in-flight requests and share one dataset.
 *
 * Protocol:
 *   Client → Server: loadDataset | cameraUpdate | setRepresentation | resetCamera | ping
 *   Server → Client: connected | datasetLoaded | frame | error | pong
 */

import { config } from '@Core/config/clientConfig.js';
import { fetchRenderToken } from '@Services/renderTokenClient.js';

const DEFAULT_WS_URL = '/render-ws';
const PING_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

class RemoteRenderClient {
    constructor() {
        this._ws = null;
        this._sessionId = null;
        this._connected = false;
        this._connecting = false;

        /**
         * Pending promise resolvers keyed by request id (see _sendAndAwait).
         * Previously keyed by response TYPE ('datasetLoaded'/'cameraFrame'/
         * 'resetFrame'), which assumed at most one request per type could be
         * in flight at once — a second concurrent cameraUpdate (e.g. a drag
         * and a wheel-zoom firing close together) silently overwrote the
         * first pending entry, so the first caller's promise never resolved
         * until timeout. Keying by id gives every request its own slot.
         */
        this._pending = new Map();
        /** datasetLoaded metadata waiting for its paired frame, keyed by request id */
        this._pendingMetaById = new Map();
        /** Monotonic counter feeding _nextRequestId */
        this._reqCounter = 0;

        this._frameCallbacks = new Set();
        this._errorCallbacks = new Set();
        this._connectWaiters = [];
        this._pingInterval = null;
    }

    get isConnected() {
        return this._connected && this._ws?.readyState === WebSocket.OPEN;
    }

    get sessionId() {
        return this._sessionId;
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Open WebSocket connection to the render server.
     * @param {string|null} [datasetId] - When known up front (loadDataset
     *   already knows it), the minted token is scoped to this dataset (see
     *   server/src/routes/renderToken.js and app.py's loadDataset scope
     *   check). Omitted for camera-only reconnects, where the connection is
     *   expected to already exist.
     * @returns {Promise<string>} Resolves with session ID.
     */
    async connect(datasetId = null) {
        console.log('[RenderMode]', config.renderMode);

        if (this.isConnected) {
            console.log('[RenderServer] already connected, session:', this._sessionId);
            return this._sessionId;
        }

        if (this._connecting) {
            return new Promise((resolve, reject) => {
                this._connectWaiters.push({ resolve, reject });
            });
        }

        this._connecting = true;
        const baseWsUrl = config.renderWsUrl || DEFAULT_WS_URL;

        const token = await fetchRenderToken(datasetId);
        // Browsers can't set custom headers on a WS handshake, so the token
        // rides along as a query param instead.
        const wsUrl = token
            ? `${baseWsUrl}?token=${encodeURIComponent(token)}`
            : baseWsUrl;
        console.log('[RenderServer] connecting to', baseWsUrl);

        return new Promise((resolve, reject) => {
            try {
                this._ws = new WebSocket(wsUrl);

                this._ws.onopen = () => {
                    console.log('[RenderServer] WebSocket open');
                };

                this._ws.onmessage = (ev) => this._handleMessage(ev.data);

                this._ws.onclose = (ev) => {
                    console.log('[RenderServer] WebSocket closed:', ev.code, ev.reason);
                    this._onDisconnect();
                };

                this._ws.onerror = () => {
                    console.warn('[RenderServer] WebSocket error — is the render server running?');
                    this._connecting = false;
                    const err = new Error(
                        'Render server unreachable. Start: cd server/render_server && uvicorn app:app --port 7000'
                    );
                    reject(err);
                    this._connectWaiters.forEach(w => w.reject(err));
                    this._connectWaiters = [];
                };

                // Will be resolved when 'connected' message arrives
                this._pending.set('connected', {
                    resolve: (sid) => {
                        resolve(sid);
                        this._connectWaiters.forEach(w => w.resolve(sid));
                        this._connectWaiters = [];
                    },
                    reject,
                });
            } catch (err) {
                this._connecting = false;
                reject(err);
            }
        });
    }

    disconnect() {
        this._stopPing();
        this._ws?.close();
        this._ws = null;
        this._onDisconnect();
        console.log('[RenderServer] disconnected');
    }

    /**
     * Load a dataset on the render server.
     * @param {string} datasetId  - Dataset id known to the server
     * @param {string} path       - Absolute path on the server's filesystem
     * @returns {Promise<{ metadata, image, width, height, camera }>}
     */
    async loadDataset(datasetId, path) {
        await this._ensureConnected(datasetId);
        console.log('[RenderServer] loading dataset:', { id: datasetId, path });
        console.log('[RenderServer] session:', this._sessionId);

        return this._sendAndAwait({ type: 'loadDataset', datasetId, path });
    }

    /**
     * Send a camera update and receive a new frame.
     * @param {{ position, focalPoint, viewUp, zoom? }} camera
     * @returns {Promise<{ image, width, height, camera? }>}
     */
    async updateCamera(camera) {
        await this._ensureConnected();
        return this._sendAndAwait({ type: 'cameraUpdate', camera });
    }

    /**
     * Reset camera to fit the loaded dataset.
     * @returns {Promise<{ image, width, height, camera }>}
     */
    async resetCamera() {
        await this._ensureConnected();
        return this._sendAndAwait({ type: 'resetCamera' });
    }

    /**
     * Change visual representation.
     * @param {'surface'|'wireframe'|'points'} representation
     */
    async setRepresentation(representation) {
        await this._ensureConnected();
        this._send({ type: 'setRepresentation', representation });
    }

    /**
     * Register a live frame callback (fires on every incoming frame).
     * @param {Function} cb - Called with { image: dataUrl, width, height, camera? }
     * @returns {Function} Unsubscribe
     */
    onFrame(cb) {
        this._frameCallbacks.add(cb);
        return () => this._frameCallbacks.delete(cb);
    }

    /**
     * Register an error callback.
     * @param {Function} cb - Called with { message, stage }
     * @returns {Function} Unsubscribe
     */
    onError(cb) {
        this._errorCallbacks.add(cb);
        return () => this._errorCallbacks.delete(cb);
    }

    // =========================================================================
    // PRIVATE
    // =========================================================================

    async _ensureConnected(datasetId = null) {
        if (!this.isConnected) {
            await this.connect(datasetId);
        }
    }

    _send(msg) {
        if (this._ws?.readyState !== WebSocket.OPEN) {
            console.warn('[RenderServer] send skipped (not connected):', msg.type);
            return;
        }
        this._ws.send(JSON.stringify(msg));
        console.log('[RenderServer] sent:', msg.type);
    }

    /**
     * Assign this client's next request id. A plain incrementing counter,
     * scoped to this client instance/connection — the server only needs to
     * echo it back, never interpret it.
     * @private
     */
    _nextRequestId() {
        return `${Date.now()}-${++this._reqCounter}`;
    }

    /**
     * Send a message and await its response, keyed by request id in
     * `_pending` — the server echoes back the same `id` on every reply to
     * this message (see server/render_server/app.py). Rejects if no
     * response arrives within `timeoutMs`, or immediately if the connection
     * drops first (see `_onDisconnect`).
     * @param {object} message - sent via `_send`, with `id` attached
     */
    _sendAndAwait(message, timeoutMs = REQUEST_TIMEOUT_MS) {
        const id = this._nextRequestId();
        const withId = { ...message, id };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._pending.get(id)) {
                    this._pending.delete(id);
                    this._pendingMetaById.delete(id);
                    reject(new Error(`Render server request timed out: ${message.type}`));
                }
            }, timeoutMs);

            this._pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (err) => { clearTimeout(timer); reject(err); },
            });
            this._send(withId);
        });
    }

    _handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            console.warn('[RenderServer] unparseable message:', raw);
            return;
        }

        const { type } = msg;
        console.log('[RenderServer] received:', type);

        switch (type) {
            case 'connected': {
                this._sessionId = msg.sessionId;
                this._connected = true;
                this._connecting = false;
                console.log('[RenderServer] session:', this._sessionId);
                this._startPing();
                const r = this._pending.get('connected');
                if (r) {
                    this._pending.delete('connected');
                    r.resolve(this._sessionId);
                }
                break;
            }

            case 'datasetLoaded': {
                console.log('[RenderServer] server response metadata:', msg.metadata);
                // loadDataset's reply arrives as TWO messages sharing the
                // same request id — this one (metadata) and the 'frame'
                // that follows (image) — stashed here until the frame
                // arrives to complete it (see the 'frame' case below).
                if (msg.id != null) this._pendingMetaById.set(msg.id, msg);
                break;
            }

            case 'frame': {
                const dataUrl = `data:image/png;base64,${msg.image}`;
                const size = msg.image?.length ?? 0;
                console.log('[RenderServer] frame received, size:', size, 'bytes (base64)');

                const frame = {
                    image: dataUrl,
                    width: msg.width,
                    height: msg.height,
                    camera: msg.camera,
                };

                // Notify live frame subscribers
                this._frameCallbacks.forEach(cb => cb(frame));

                // Resolve whichever request this frame answers, identified
                // by the id the server echoed back — not by guessing from
                // which response TYPE happens to be pending, which broke
                // under concurrent requests (see _pending's doc comment).
                const id = msg.id;
                const pending = id != null ? this._pending.get(id) : null;
                if (pending) {
                    this._pending.delete(id);
                    const meta = this._pendingMetaById.get(id);
                    if (meta) {
                        this._pendingMetaById.delete(id);
                        pending.resolve({ ...meta, ...frame });
                    } else {
                        pending.resolve(frame);
                    }
                }
                break;
            }

            case 'error': {
                console.warn('[RenderServer] error:', msg.message, '| stage:', msg.stage);
                this._errorCallbacks.forEach(cb => cb({ message: msg.message, stage: msg.stage }));
                // An error tied to a specific request (server echoes its id)
                // only rejects THAT request, leaving unrelated concurrent
                // requests alone. An id-less error (e.g. malformed JSON,
                // rejected before any request could be parsed) falls back to
                // rejecting everything in flight — there's no way to know
                // which request it was about.
                if (msg.id != null && this._pending.has(msg.id)) {
                    this._pending.get(msg.id).reject(new Error(msg.message));
                    this._pending.delete(msg.id);
                    this._pendingMetaById.delete(msg.id);
                    break;
                }
                // Reject all pending promises except 'connected'
                for (const [key, r] of this._pending) {
                    if (key !== 'connected') {
                        r.reject(new Error(msg.message));
                        this._pending.delete(key);
                    }
                }
                break;
            }

            case 'pong':
                break;

            default:
                console.log('[RenderServer] unknown message type:', type);
        }
    }

    _onDisconnect() {
        this._connected = false;
        this._connecting = false;
        this._sessionId = null;
        this._stopPing();

        // Nothing left waiting on this connection will ever hear back —
        // reject rather than leave callers hanging forever.
        const err = new Error('Render server connection closed');
        for (const [, r] of this._pending) r.reject(err);
        this._pending.clear();
        this._pendingMetaById.clear();

        this._connectWaiters.forEach(w => w.reject(err));
        this._connectWaiters = [];
    }

    _startPing() {
        this._stopPing();
        this._pingInterval = setInterval(() => {
            if (this.isConnected) this._send({ type: 'ping' });
        }, PING_INTERVAL_MS);
    }

    _stopPing() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
    }
}

/** One instance per viewport — see the file header for why. */
export { RemoteRenderClient };
export default RemoteRenderClient;
