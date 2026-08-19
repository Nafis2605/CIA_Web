// src/ui/react/hooks/__tests__/useVRSession.endSession.test.js
// Issue 6 (session lifecycle): POST /sessions/:id/leave now ends a session
// transactionally when the leaving participant is the last one (see
// server/src/routes/vr.js). That means a subsequent owner-initiated
// DELETE /vr/sessions/:id (endSession's server call) can now legitimately
// 404 — the row is already 'ended' — where it previously always found the
// row and silently re-stamped ended_at. endSession must treat that 404 as
// success, not surface "Failed to end session" to the user.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@Core/vr/VRManager.js", () => ({
  vrManager: {
    isVRSupported: vi.fn(() => false),
    checkVRCapabilities: vi.fn(async () => null),
    isInVR: vi.fn(() => false),
  },
}));

vi.mock("@Core/vr/VRExplorationManager.js", () => ({
  vrExplorationManager: {
    getActiveSession: vi.fn(),
    on: vi.fn(() => () => {}),
    getManipulationHolder: vi.fn(() => null),
    getManipulationRequests: vi.fn(() => []),
    leaveSession: vi.fn(async () => {}),
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
import { toast } from "@UI/react/store/toastStore.js";

describe("useVRSession.endSession — 404-as-success (Issue 6)", () => {
  beforeEach(() => {
    apiClient.get.mockReset();
    apiClient.get.mockResolvedValue([]);
    apiClient.delete.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();

    vrExplorationManager.getActiveSession.mockReturnValue({
      id: "server-session-1",
      ownerUserId: "user-1",
      participants: [],
    });
  });

  it("treats a 404 from DELETE /vr/sessions/:id as success, not an error toast", async () => {
    const notFound = Object.assign(new Error("Session not found"), {
      status: 404,
      details: { error: "Session not found" },
    });
    apiClient.delete.mockRejectedValueOnce(notFound);

    const { result } = renderHook(() => useVRSession("project-1"));
    await waitFor(() => expect(result.current.currentSession?.id).toBe("server-session-1"));

    await act(async () => {
      await result.current.endSession();
    });

    expect(apiClient.delete).toHaveBeenCalledWith("/vr/sessions/server-session-1");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("VR session ended");
  });

  it("still surfaces a genuine (non-404) DELETE failure as an error", async () => {
    const serverError = Object.assign(new Error("boom"), { status: 500 });
    apiClient.delete.mockRejectedValueOnce(serverError);

    const { result } = renderHook(() => useVRSession("project-1"));
    await waitFor(() => expect(result.current.currentSession?.id).toBe("server-session-1"));

    await act(async () => {
      await result.current.endSession();
    });

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Failed to end session: boom");
  });
});
