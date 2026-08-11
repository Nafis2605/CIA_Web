// src/services/__tests__/serverSync.watermarkRestore.test.js
// A reconnect (page reload, network drop, sleep/wake) used to leave
// _lastWatermark at its constructor default of 0 no matter what had already
// been persisted (via saveSyncWatermark -> localStorage), and did nothing
// proactive to catch up on events missed while disconnected — the only
// back-fill path was REACTIVE (a gap in a later live message's syncEventId).
// This pins the fix: setWorkspaceId()/auth:success restore the persisted
// watermark, and auth:success unconditionally requests a delta.
import { describe, test, expect, beforeEach, vi } from "vitest";

vi.mock("@Core/config/clientConfig.js", () => ({
  config: {
    apiBaseUrl: "/api",
    defaultSessionId: "test-session",
  },
}));

vi.mock("@Core/session/sessionManager.js", () => ({
  sessionManager: {
    getProjectId: vi.fn().mockReturnValue("project-1"),
    getUserId: vi.fn().mockReturnValue("user-me"),
    setUserInfo: vi.fn(),
  },
}));

vi.mock("@Services/authService.js", () => ({
  authService: { getToken: vi.fn(), onAuthChange: vi.fn() },
}));

vi.mock("@UI/react/store/computeJobStore.js", () => ({
  useComputeJobStore: { getState: vi.fn().mockReturnValue({}) },
}));

vi.mock("@UI/react/store/toastStore.js", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const mockGetSyncWatermark = vi.fn().mockReturnValue(0);
const mockSaveSyncWatermark = vi.fn();
const mockFetchDeltaSince = vi.fn().mockResolvedValue({ events: [] });
const mockApplyDeltaEvents = vi.fn().mockResolvedValue({ lastAppliedEventId: null });
vi.mock("@Services/syncService.js", () => ({
  getSyncWatermark: (...a) => mockGetSyncWatermark(...a),
  saveSyncWatermark: (...a) => mockSaveSyncWatermark(...a),
  fetchDeltaSince: (...a) => mockFetchDeltaSince(...a),
  applyDeltaEvents: (...a) => mockApplyDeltaEvents(...a),
}));

import { serverSync } from "../serverSync.js";

function deliver(message) {
  serverSync._handleMessage(JSON.stringify(message));
}

describe("serverSync — watermark restore + delta fetch on auth", () => {
  beforeEach(() => {
    serverSync._setupDefaultHandlers();
    serverSync._workspaceId = null;
    serverSync._userId = null;
    serverSync._lastWatermark = 0;
    serverSync._deltaFetchPending = false;
    if (serverSync._deltaFetchTimer) {
      clearTimeout(serverSync._deltaFetchTimer);
      serverSync._deltaFetchTimer = null;
    }
    mockGetSyncWatermark.mockClear();
    mockGetSyncWatermark.mockReturnValue(0);
    mockSaveSyncWatermark.mockClear();
    mockFetchDeltaSince.mockClear();
    mockFetchDeltaSince.mockResolvedValue({ events: [] });
    mockApplyDeltaEvents.mockClear();
  });

  test("setWorkspaceId restores the persisted watermark instead of leaving it at 0", () => {
    mockGetSyncWatermark.mockReturnValue(42);

    serverSync.setWorkspaceId("workspace-1");

    expect(mockGetSyncWatermark).toHaveBeenCalledWith("workspace-1", null);
    expect(serverSync._lastWatermark).toBe(42);
  });

  test("auth:success re-restores the watermark now that userId is known, scoped by both ids", () => {
    mockGetSyncWatermark.mockReturnValue(7);
    serverSync.setWorkspaceId("workspace-1"); // userId not known yet -> scoped by null
    mockGetSyncWatermark.mockClear();
    mockGetSyncWatermark.mockReturnValue(99);

    deliver({ type: "auth:success", userId: "user-me" });

    expect(mockGetSyncWatermark).toHaveBeenCalledWith("workspace-1", "user-me");
    expect(serverSync._lastWatermark).toBe(99);
  });

  test("auth:success requests a delta unconditionally, not just reactively on a later gap", async () => {
    serverSync.setWorkspaceId("workspace-1");

    deliver({ type: "auth:success", userId: "user-me" });
    // _triggerDeltaFetch resolves its work via a dynamic import() of
    // syncService.js — flush both the import and its .then() chain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetchDeltaSince).toHaveBeenCalledTimes(1);
  });

  test("does not throw or fetch a delta when no workspace is set yet", () => {
    expect(() => deliver({ type: "auth:success", userId: "user-me" })).not.toThrow();
    expect(mockFetchDeltaSince).not.toHaveBeenCalled();
  });
});
