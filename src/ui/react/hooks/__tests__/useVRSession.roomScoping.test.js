// src/ui/react/hooks/__tests__/useVRSession.roomScoping.test.js
// Phase A room scoping made roomId required on GET /vr/sessions
// (resolveRoomAccess() in server/src/routes/vr.js 400s without one), but
// fetchActiveSessions() only ever sent projectId — a param the route doesn't
// even read anymore. Every fetch 400'd and the active-session list stayed
// permanently empty. These pin the fix at the hook boundary: the request
// carries roomId, and the hook skips the request entirely (rather than firing
// one guaranteed to 400) when sessionManager can't resolve a room yet.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const mockGetRoomId = vi.fn();

vi.mock("@Core/vr/VRManager.js", () => ({
  vrManager: {
    isVRSupported: vi.fn(() => false),
    checkVRCapabilities: vi.fn(async () => null),
    isInVR: vi.fn(() => false),
  },
}));

vi.mock("@Core/vr/VRExplorationManager.js", () => ({
  vrExplorationManager: {
    getActiveSession: vi.fn(() => null),
    on: vi.fn(() => () => {}),
    getManipulationHolder: vi.fn(() => null),
    getManipulationRequests: vi.fn(() => []),
  },
}));

vi.mock("@Services/apiClient.js", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock("@Collaboration/presence/userManagement.js", () => ({
  isSelfIdentity: vi.fn(() => false),
}));

vi.mock("@UI/react/store/toastStore.js", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("@Core/session/sessionManager.js", () => ({
  sessionManager: {
    getRoomId: (...args) => mockGetRoomId(...args),
  },
}));

import { useVRSession } from "../useVRSession.js";
import { apiClient } from "@Services/apiClient.js";

describe("useVRSession.fetchActiveSessions — room scoping", () => {
  beforeEach(() => {
    apiClient.get.mockReset();
    apiClient.get.mockResolvedValue([]);
    mockGetRoomId.mockReset();
  });

  it("requests /vr/sessions with roomId when sessionManager resolves one", async () => {
    mockGetRoomId.mockReturnValue("room-1");

    renderHook(() => useVRSession("project-1"));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(apiClient.get).toHaveBeenCalledWith(
      `/vr/sessions?roomId=${encodeURIComponent("room-1")}`
    );
  });

  it("does not request /vr/sessions when no room resolves (getRoomId returns falsy)", async () => {
    mockGetRoomId.mockReturnValue(null);

    renderHook(() => useVRSession("project-1"));

    // Give any pending microtasks/effects a chance to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("does not request /vr/sessions when sessionManager.getRoomId() throws (session not yet initialized)", async () => {
    mockGetRoomId.mockImplementation(() => {
      throw new Error("Session not initialized - call initializeFromURL() first");
    });

    renderHook(() => useVRSession("project-1"));

    await new Promise((r) => setTimeout(r, 0));

    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("fetches on room alone — a missing projectId must NOT block the request", async () => {
    // Regression guard. GET /vr/sessions is room-scoped server-side and does
    // not read projectId at all (server/src/routes/vr.js), but the hook used
    // to early-return on `!projectId` — and its only caller,
    // <VRSessionFloating />, was rendered with no props at all. The result was
    // a permanently empty activeSessions list, so the "Join in VR" popover
    // could never render and joinSession() had no reachable caller.
    mockGetRoomId.mockReturnValue("room-1");

    renderHook(() => useVRSession(null));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(apiClient.get).toHaveBeenCalledWith(
      `/vr/sessions?roomId=${encodeURIComponent("room-1")}`
    );
  });

  it("recovers when the room resolves only after mount", async () => {
    // sessionManager.getRoomId() throws until initializeFromURLAsync()
    // finishes, which can happen after this hook mounts. The old code
    // returned early and never refetched, so a hook that mounted a moment too
    // early stayed empty for its whole lifetime.
    mockGetRoomId.mockImplementation(() => {
      throw new Error("Session not initialized - call initializeFromURL() first");
    });

    renderHook(() => useVRSession(null));

    await new Promise((r) => setTimeout(r, 0));
    expect(apiClient.get).not.toHaveBeenCalled();

    mockGetRoomId.mockReturnValue("room-late");

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(
        `/vr/sessions?roomId=${encodeURIComponent("room-late")}`
      )
    );
  });
});
