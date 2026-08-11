// useVoiceTab.channelNaming.test.js
// handleChannelSelect used to call voiceRoomService.joinRoom(channelId, ...)
// with the RAW channel id, bypassing getVoiceRoomName() — unlike every other
// join call site (handleJoin two lines up, useVoiceBar.js,
// voiceCommandHandlers.js, VRExplorationManager.js). That landed a mid-call
// channel switch in a session-unscoped LiveKit room ("breakout-1") instead
// of the canonical `${sessionRoomId}:breakout-1` every other participant's
// getVoiceRoomName(channel) call converges on.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserName: vi.fn(() => "Alice"),
}));

vi.mock("@UI/react/store/toastStore.js", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mockJoinRoom = vi.fn().mockResolvedValue(undefined);
const mockGetVoiceRoomName = vi.fn((channel) =>
  channel && channel !== "main" ? `session-1:${channel}` : "session-1"
);

vi.mock("@Services/voice/voiceRoomService.js", () => ({
  voiceRoomService: {
    getConnectionState: vi.fn(() => "connected"),
    isMuted: false,
    isDeafened: false,
    getCurrentRoom: vi.fn(() => "session-1:breakout-1"),
    initialize: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
    onParticipantUpdate: vi.fn(() => () => {}),
    onParticipantJoined: vi.fn(() => () => {}),
    onParticipantLeft: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    getParticipants: vi.fn(() => []),
    joinRoom: (...a) => mockJoinRoom(...a),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn().mockResolvedValue(false),
    toggleDeafen: vi.fn(() => false),
    setMuted: vi.fn(),
  },
  VoiceConnectionState: {
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    RECONNECTING: "reconnecting",
    ERROR: "error",
  },
  getVoiceRoomName: (...a) => mockGetVoiceRoomName(...a),
}));

import { useVoiceTab } from "../useVoiceTab.js";

describe("useVoiceTab — handleChannelSelect canonical naming", () => {
  beforeEach(() => {
    mockJoinRoom.mockClear();
    mockGetVoiceRoomName.mockClear();
  });

  it("routes handleChannelSelect through getVoiceRoomName, not the raw channel id", async () => {
    const { result } = renderHook(() => useVoiceTab({}));

    await act(async () => {
      await result.current.handleChannelSelect("breakout-2");
    });

    expect(mockGetVoiceRoomName).toHaveBeenCalledWith("breakout-2");
    expect(mockJoinRoom).toHaveBeenCalledWith("session-1:breakout-2", "Alice");
    // The bug this pins: joinRoom must NEVER be called with the bare channel
    // id once getVoiceRoomName would have transformed it.
    expect(mockJoinRoom).not.toHaveBeenCalledWith("breakout-2", "Alice");
  });
});
