// src/ui/react/hooks/__tests__/useVRSession.joinError.test.js
// Phase B of the room-scoping/join-correctness plan: useVRSession's
// joinSession() used to check only `result.joined`, so a hard 4xx from
// either the session lookup (GET /vr/sessions/:id, which can now 403/409
// post-Phase A) or the join itself (POST /vr/sessions/:id/join, see
// VRExplorationManager.joinSession's rewritten contract) reported "Joined VR
// session as an observer" instead of surfacing as an error. These pin the
// fix: a hard failure rejects, sets a structured `joinError`, and
// 'ready-press-enter' (an auto-load that deliberately didn't enter VR) is
// treated as success, not an observer join.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

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
    joinSession: vi.fn(),
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
    getRoomId: vi.fn(() => "room-1"),
  },
}));

import { useVRSession } from "../useVRSession.js";
import { apiClient } from "@Services/apiClient.js";
import { vrExplorationManager } from "@Core/vr/VRExplorationManager.js";

// useVRSession also fires GET /vr/sessions?roomId=... on mount (see
// fetchActiveSessions) — routing apiClient.get by URL, rather than using
// mockResolvedValueOnce/mockRejectedValueOnce, keeps that call from
// consuming the mock value meant for joinSession's own GET
// /vr/sessions/:id lookup.
function mockApiGet({ singleResult = undefined, singleError = undefined } = {}) {
  apiClient.get.mockImplementation((url) => {
    if (typeof url === "string" && url.startsWith("/vr/sessions?")) {
      return Promise.resolve([]);
    }
    if (singleError) return Promise.reject(singleError);
    return Promise.resolve(singleResult);
  });
}

describe("useVRSession.joinSession — join error surfacing", () => {
  beforeEach(() => {
    apiClient.get.mockReset();
    apiClient.post.mockReset();
    vrExplorationManager.joinSession.mockReset();
  });

  it("a 403 from GET /vr/sessions/:id rejects and sets a structured joinError, not an observer-join toast", async () => {
    // Not in activeSessions (empty on mount) — joinSession must fetch it,
    // and that fetch is what 403s.
    const apiError = Object.assign(new Error("not-a-room-member"), {
      status: 403,
      details: { error: "not-a-room-member" },
    });
    mockApiGet({ singleError: apiError });

    const { result } = renderHook(() => useVRSession("project-1"));

    await act(async () => {
      await expect(result.current.joinSession("session-1")).rejects.toThrow();
    });

    expect(vrExplorationManager.joinSession).not.toHaveBeenCalled();
    expect(result.current.joinError).toEqual({
      code: "not-a-room-member",
      message: "You don't have access to this session's room",
    });
  });

  it("a hard 4xx from VRExplorationManager.joinSession (cross-room) rejects and names the room to switch to", async () => {
    mockApiGet({ singleResult: { id: "session-2", room_id: "room-A" } });
    vrExplorationManager.joinSession.mockResolvedValueOnce({
      joined: false,
      vrEntered: false,
      error: "cross-room",
      detail: { error: "cross-room", roomId: "room-A", roomName: "Room A" },
    });

    const { result } = renderHook(() => useVRSession("project-1"));

    await act(async () => {
      await expect(result.current.joinSession("session-2")).rejects.toThrow();
    });

    expect(vrExplorationManager.joinSession).toHaveBeenCalledWith(
      { id: "session-2", room_id: "room-A" },
      "desktop-observer"
    );
    expect(result.current.joinError).toEqual({
      code: "cross-room",
      message: 'This session is in room "Room A" — switch rooms to join',
    });
  });

  it("'ready-press-enter' (auto-load succeeded, VR entry deliberately deferred) resolves as success, not an observer join", async () => {
    mockApiGet({ singleResult: { id: "session-3" } });
    vrExplorationManager.joinSession.mockResolvedValueOnce({
      joined: true,
      vrEntered: false,
      session: { id: "session-3" },
      reason: "ready-press-enter",
      instanceId: "inst-1",
    });

    const { result } = renderHook(() => useVRSession("project-1"));

    let joinResult;
    await act(async () => {
      joinResult = await result.current.joinSession("session-3", "vr-explorer");
    });

    expect(joinResult.joined).toBe(true);
    expect(joinResult.reason).toBe("ready-press-enter");
    expect(result.current.joinError).toBeNull();
  });
});
