// src/core/session/sessionManager.js
// Centralized management of session identity and routing
// This is the single source of truth for "which room am I in?"
import { config } from "@Core/config/clientConfig.js";
import { auth as log } from "@Utils/logger.js";

class SessionManager {
  constructor() {
    this.projectId = null;
    this.roomId = null;
    this.roomName = null;
    this.userId = null;
    this.sessionStartedAt = null;
  }

  /**
   * Initialize session from URL or default.
   * Synchronous, zero-network — kept as a harmless primitive for tests/callers
   * that don't need project resolution. Does NOT set projectId and does NOT
   * validate room access; use initializeFromURLAsync() for real startup.
   */
  initializeFromURL() {
    const resolved = this._resolveProjectAndRoomFromURL();
    this.roomId = resolved.roomId || config.defaultSessionId;
    return this.roomId;
  }

  /**
   * Resolve project + room identity from available sources in priority order:
   *   1. Canonical URL path   (/projects/{projectId}/rooms/{roomId})
   *   2. Legacy URL path      (/rooms/{roomId} — no project known)
   *   3. Canonical query      (?project=...&room=...)
   *   4. Legacy query         (?room=... — no project known)
   *   5. Paired localStorage  (cia_last_project + cia_last_room)
   *   6. Legacy localStorage  (cia_last_room only — pre-fix visitors)
   *   7. Config default
   *
   * "Legacy" results carry isLegacy: true, signaling the caller must resolve
   * the real projectId via a server lookup before it can be trusted (see
   * _resolveLegacyProjectId). Does NOT write to localStorage — caller is
   * responsible.
   * @private
   * @returns {{projectId: string|null, roomId: string, isLegacy: boolean}}
   */
  _resolveProjectAndRoomFromURL() {
    // 1. Canonical URL path
    const canonicalMatch = window.location.pathname.match(
      /^\/projects\/([^/]+)\/rooms\/([^/]+)/
    );
    if (canonicalMatch) {
      const [, projectId, roomId] = canonicalMatch;
      this.roomName = roomId;
      log.info(`Session resolved from canonical URL: project=${projectId} room=${roomId}`);
      return { projectId, roomId, isLegacy: false };
    }

    // 2. Legacy URL path (no project prefix)
    const legacyMatch = window.location.pathname.match(/^\/rooms\/([^/]+)/);
    if (legacyMatch) {
      const roomId = legacyMatch[1];
      this.roomName = roomId;
      log.info(`Session resolved from legacy URL path (no project): ${roomId}`);
      return { projectId: null, roomId, isLegacy: true };
    }

    // 3/4. Query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get("room");
    const projectParam = urlParams.get("project");
    if (roomParam && projectParam) {
      this.roomName = roomParam;
      log.info(`Session resolved from query params: project=${projectParam} room=${roomParam}`);
      return { projectId: projectParam, roomId: roomParam, isLegacy: false };
    }
    if (roomParam) {
      this.roomName = roomParam;
      log.info(`Session resolved from legacy query param (no project): ${roomParam}`);
      return { projectId: null, roomId: roomParam, isLegacy: true };
    }

    // 5/6. localStorage
    const savedProject = localStorage.getItem("cia_last_project");
    const savedRoom = localStorage.getItem("cia_last_room");
    if (savedRoom && savedProject) {
      this.roomName = savedRoom;
      log.info(`Session resolved from localStorage (paired): project=${savedProject} room=${savedRoom}`);
      return { projectId: savedProject, roomId: savedRoom, isLegacy: false };
    }
    if (savedRoom) {
      this.roomName = savedRoom;
      log.info(`Session resolved from legacy localStorage (no project): ${savedRoom}`);
      return { projectId: null, roomId: savedRoom, isLegacy: true };
    }

    // 7. Default
    this.roomName = "Demo Project";
    log.info(`Session resolved to default project/room: ${config.defaultProjectId}`);
    return { projectId: config.defaultProjectId, roomId: config.defaultSessionId, isLegacy: false };
  }

  /**
   * Resolve a bare (legacy) room id to its owning project via the compat-only
   * GET /api/rooms/:roomId endpoint. Returns null if the room can't be found
   * or the request fails — caller falls back to the default project.
   * @private
   * @param {string} roomId
   * @returns {Promise<{projectId: string}|null>}
   */
  async _resolveLegacyProjectId(roomId) {
    try {
      const headers = this._cachedToken
        ? { Authorization: `Bearer ${this._cachedToken}` }
        : {};
      const resp = await fetch(`/api/rooms/${roomId}`, { headers });
      if (!resp.ok) return null;
      const room = await resp.json();
      return room?.project_id ? { projectId: room.project_id } : null;
    } catch (err) {
      log.warn("Legacy room→project lookup failed:", err?.message);
      return null;
    }
  }

  /**
   * Rewrite the visible URL to the canonical /projects/:projectId/rooms/:roomId
   * form via replaceState (no reload, no new history entry) whenever the
   * current path doesn't already match — e.g. after resolving a legacy link.
   * @private
   */
  _canonicalizeURL() {
    if (!this.projectId || !this.roomId) return;
    const canonical = `/projects/${this.projectId}/rooms/${this.roomId}`;

    // Strip the resolved project/room query params (now redundant with the
    // path) but keep any other query params the URL may have carried.
    const params = new URLSearchParams(window.location.search);
    params.delete("project");
    params.delete("room");
    const remaining = params.toString();
    const newSearch = remaining ? `?${remaining}` : "";

    if (window.location.pathname !== canonical || window.location.search !== newSearch) {
      window.history.replaceState({}, "", canonical + newSearch);
    }
  }

  /**
   * Initialize session from URL with server-side room access validation.
   * Resolves both projectId and roomId (see _resolveProjectAndRoomFromURL),
   * resolving a legacy (project-less) URL/localStorage value via one
   * compat-only lookup first. Validates the resolved room against the API;
   * falls back to the project's main room if the room is inaccessible
   * (403/404) or deleted. localStorage is updated ONLY after successful
   * validation. Canonicalizes the visible URL once projectId+roomId are known.
   *
   * Call this instead of initializeFromURL() from real startup flows.
   *
   * @returns {Promise<string>} The validated (or fallback) room ID.
   */
  async initializeFromURLAsync() {
    const resolved = this._resolveProjectAndRoomFromURL();
    let { projectId, roomId } = resolved;

    if (resolved.isLegacy) {
      const legacy = await this._resolveLegacyProjectId(roomId);
      if (legacy) {
        projectId = legacy.projectId;
      } else {
        log.warn(`Legacy room ${roomId} could not be resolved — falling back to default project`);
        projectId = config.defaultProjectId;
        const mainRoom = await this._fetchMainRoom(projectId);
        this.projectId = projectId;
        this.roomId = mainRoom?.id || config.defaultSessionId;
        this.roomName = mainRoom?.name || "Main Room";
        this._canonicalizeURL();
        return this.roomId;
      }
    }

    if (!projectId || !roomId) {
      this.projectId = projectId || config.defaultProjectId;
      this.roomId = roomId || config.defaultSessionId;
      return this.roomId;
    }

    try {
      const headers = this._cachedToken
        ? { Authorization: `Bearer ${this._cachedToken}` }
        : {};

      const resp = await fetch(
        `/api/projects/${projectId}/rooms/${roomId}`,
        { headers }
      );

      if (resp.status === 401) {
        // No auth token exists yet — this runs before authService.initialize()
        // (appInitializer.js Phase 1 is documented as needing no auth). Not a
        // rejection: proceed optimistically. revalidateAccess() re-checks
        // with a real token once auth completes and corrects course if
        // access is actually denied.
        log.debug(`Room ${roomId} validation deferred pending authentication`);
        this.projectId = projectId;
        this.roomId = roomId;
        return this.roomId;
      }

      if (!resp.ok) {
        log.warn(
          `Room ${roomId} not accessible (${resp.status}), ` +
          `falling back to main room for project ${projectId}`
        );
        const mainRoom = await this._fetchMainRoom(projectId);
        this.projectId = projectId;
        this.roomId = mainRoom?.id || config.defaultSessionId;
        this.roomName = mainRoom?.name || "Main Room";
        // Do NOT persist the unauthorized room to localStorage
        this._canonicalizeURL();
        return this.roomId;
      }

      // Validated — safe to persist
      this.projectId = projectId;
      this.roomId = roomId;
      localStorage.setItem("cia_last_project", projectId);
      localStorage.setItem("cia_last_room", roomId);
      this._canonicalizeURL();
      return this.roomId;
    } catch (err) {
      // Network error — the server is unreachable, so there is no way to
      // verify the URL-resolved project/room. Trusting it would let a
      // crafted link into an arbitrary project be silently accepted
      // whenever the network happens to be down. Use the safe, static
      // default instead (skips a second network call to _fetchMainRoom,
      // which would almost certainly fail the same way).
      log.warn("Room validation request failed (network?):", err?.message);
      this.projectId = config.defaultProjectId;
      this.roomId = config.defaultSessionId;
      this.roomName = "Main Room";
      return this.roomId;
    }
  }

  /**
   * Re-validate room access now that a real auth token is available. This is
   * the check that actually enforces access — see initializeFromURLAsync()'s
   * 401 handling above for why the pre-auth check can only be optimistic.
   * @returns {Promise<boolean>} true if the room changed (caller should
   *   reload to reconnect Y.js/UI against the corrected room).
   */
  async revalidateAccess() {
    if (!this.projectId || !this.roomId) return false;

    try {
      const headers = this._cachedToken
        ? { Authorization: `Bearer ${this._cachedToken}` }
        : {};
      const resp = await fetch(
        `/api/projects/${this.projectId}/rooms/${this.roomId}`,
        { headers }
      );

      if (resp.ok) return false;

      log.warn(
        `Room ${this.roomId} not accessible after authentication (${resp.status}), ` +
        `falling back to main room for project ${this.projectId}`
      );
      const mainRoom = await this._fetchMainRoom(this.projectId);
      const newRoomId = mainRoom?.id || config.defaultSessionId;
      if (newRoomId === this.roomId) return false;

      this.roomId = newRoomId;
      this.roomName = mainRoom?.name || "Main Room";
      localStorage.setItem("cia_last_project", this.projectId);
      localStorage.setItem("cia_last_room", this.roomId);
      this._canonicalizeURL();
      return true;
    } catch (err) {
      log.warn("Post-auth room revalidation failed (network?):", err?.message);
      return false;
    }
  }

  /**
   * Fetch the main room for a project from the server.
   * @private
   * @param {string} projectId
   * @returns {Promise<{id: string, name: string}|null>}
   */
  async _fetchMainRoom(projectId) {
    try {
      const headers = this._cachedToken
        ? { Authorization: `Bearer ${this._cachedToken}` }
        : {};
      const resp = await fetch(
        `/api/projects/${projectId}/rooms`,
        { headers }
      );
      if (!resp.ok) return null;
      const rooms = await resp.json();
      const list = Array.isArray(rooms) ? rooms : rooms?.rooms ?? [];
      return list.find((r) => r.is_main || r.room_type === "main") ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get the current room ID
   * This is what gets passed to Y.js WebsocketProvider
   */
  getRoomId() {
    if (!this.roomId) {
      throw new Error(
        "Session not initialized - call initializeFromURL() first"
      );
    }
    return this.roomId;
  }

  /**
   * Get the current project ID — the authoritative project this room belongs
   * to. Non-throwing (mirrors getRoomName(), not getRoomId()'s throw): many
   * callers use optional chaining and expect a usable default rather than an
   * exception. Falls back to config.defaultProjectId if not yet resolved.
   */
  getProjectId() {
    return this.projectId || config.defaultProjectId;
  }

  /**
   * Get the display name for the current room
   * This is what gets shown in the UI
   */
  getRoomName() {
    return this.roomName || this.roomId;
  }

  /**
   * Update the room name (display name only, doesn't change the room)
   * Useful when you fetch project metadata from a server later
   */
  setRoomDisplayName(displayName) {
    this.roomName = displayName;
    log.debug(`Room display name updated: ${displayName}`);
  }

  /**
   * Save current project+room to localStorage so returning users go to the
   * same room.
   */
  saveCurrentRoomToStorage() {
    if (this.projectId) {
      localStorage.setItem("cia_last_project", this.projectId);
    }
    if (this.roomId) {
      localStorage.setItem("cia_last_room", this.roomId);
    }
  }

  /**
   * Navigate to a different room (this will reload the page).
   * In the future, this might use client-side routing instead.
   * @param {string} newRoomId
   * @param {string} [projectId] Defaults to the current project — there is no
   *   live project-switcher UI today, so an in-app "switch room" action is
   *   always within the same project unless the caller says otherwise (e.g.
   *   parsing a pasted cross-project share link).
   */
  switchRoom(newRoomId, projectId = this.projectId) {
    const targetProjectId = projectId || config.defaultProjectId;

    // Save the new project+room as the last visited
    localStorage.setItem("cia_last_project", targetProjectId);
    localStorage.setItem("cia_last_room", newRoomId);

    // Update URL to reflect new project+room
    const newUrl = `/projects/${targetProjectId}/rooms/${newRoomId}`;
    window.history.pushState({}, "", newUrl);

    // For now, we need to reload to reconnect Y.js
    // In the future, you might implement hot room switching
    log.info(`Switching to room: ${newRoomId} (project: ${targetProjectId})`);
    window.location.reload();
  }

  /**
   * Generate a fresh UUID-based session and navigate to it, within the
   * current project. Creates a shareable /projects/{projectId}/rooms/{uuid}
   * URL and reloads the page.
   * @returns {string} The new session ID
   */
  generateNewSession() {
    const newId = (window.crypto || crypto).randomUUID();
    log.info(`Generating new session: ${newId}`);
    this.switchRoom(newId);
    return newId;
  }

  /*
   * Get current user ID
   * Returns CIA Admin user ID if not set (for development)
   * Note: System user (000001) is reserved for automated processes
   */
  getUserId() {
    return this.userId || "00000000-0000-0000-0000-000000000002";
  }

  /**
   * Get current user email
   * Returns CIA Admin email if not set (for development)
   */
  getUserEmail() {
    return this.userEmail || "admin@cia-web.local";
  }

  /**
   * Set user info (called after authentication)
   */
  setUserInfo(userId, email) {
    this.userId = userId;
    this.userEmail = email;
    log.debug(`User info set: ${email} (${userId})`);
  }

  /**
   * Set the cached auth token (called by authService on auth success/refresh)
   */
  setToken(token) {
    this._cachedToken = token;
  }

  /**
   * Get the current auth token (cached for sync access)
   * This is used by CanvasManager and other services for authenticated API calls
   */
  getToken() {
    return this._cachedToken || null;
  }

  /**
   * Clear session (useful for logout or switching contexts)
   */
  clearSession() {
    this.projectId = null;
    this.roomId = null;
    this.roomName = null;
    this.userId = null;
    this.userEmail = null;
    this._cachedToken = null;
    localStorage.removeItem("cia_last_project");
    localStorage.removeItem("cia_last_room");
  }

  /**
   * Get complete session info for debugging
   */
  getSessionInfo() {
    return {
      projectId: this.projectId,
      roomId: this.roomId,
      roomName: this.roomName,
      userId: this.userId,
      sessionStartedAt: this.sessionStartedAt,
      url: window.location.href,
    };
  }
}

// Export singleton instance
export const sessionManager = new SessionManager();

// Convenience export for backward compatibility
export function getRoomName() {
  return sessionManager.getRoomName();
}
