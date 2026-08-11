// src/services/__tests__/serverSync.reconnect.test.js
// H9: the reconnect backoff used to permanently give up after 5 attempts
// (~31s), so a Quest that slept or lost Wi-Fi longer than that never resumed
// broadcasts without a page reload. This pins: (1) reconnection never stops,
// (2) the delay is capped with jitter, (3) online/visibility/focus signals
// short-circuit a pending backoff wait instead of leaving the client stuck.
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

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

vi.mock("@Services/syncService.js", () => ({
  saveSyncWatermark: vi.fn(),
  fetchDeltaSince: vi.fn().mockResolvedValue({ events: [] }),
  applyDeltaEvents: vi.fn().mockResolvedValue({ lastAppliedEventId: null }),
}));

class MockWebSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  send() {}
}

import { serverSync } from "../serverSync.js";

describe("serverSync reconnect backoff and network-resume listeners", () => {
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    serverSync.isConnected = false;
    serverSync.reconnectAttempts = 0;
    serverSync.ws = null;
    serverSync._reconnectTimer = null;
    serverSync._resumeListenersAttached = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.WebSocket = originalWebSocket;
  });

  test("reconnection keeps being scheduled past 6+ consecutive onclose events (no permanent give-up)", () => {
    serverSync.connect();
    for (let i = 0; i < 7; i++) {
      const current = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      current.close();
      vi.advanceTimersToNextTimer();
    }

    // A permanent give-up would mean no new WebSocket gets constructed past
    // attempt 5 — assert we're still opening fresh sockets on attempt 7.
    expect(MockWebSocket.instances.length).toBeGreaterThan(7);
    expect(serverSync.reconnectAttempts).toBeGreaterThan(5);
  });

  test("the backoff delay is capped at maxReconnectDelay with jitter on later attempts", () => {
    serverSync.reconnectAttempts = 10; // well past where 2^n would exceed the cap
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    serverSync._scheduleReconnect();

    const delay = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1][1];
    expect(delay).toBeGreaterThanOrEqual(serverSync.maxReconnectDelay * 0.5);
    expect(delay).toBeLessThanOrEqual(serverSync.maxReconnectDelay);
    setTimeoutSpy.mockRestore();
  });

  test("an 'online' event cancels a pending backoff wait and reconnects immediately", () => {
    serverSync._setupNetworkResumeListeners();
    serverSync.connect();
    const first = MockWebSocket.instances[0];
    first.close(); // schedules a backoff wait

    expect(MockWebSocket.instances.length).toBe(1); // no new socket yet — still waiting

    window.dispatchEvent(new Event("online"));

    expect(MockWebSocket.instances.length).toBe(2); // reconnected immediately, bypassing the wait
    expect(serverSync.reconnectAttempts).toBe(0); // reset on resume
  });

  test("visibilitychange to 'visible' triggers the same immediate-reconnect path", () => {
    serverSync._setupNetworkResumeListeners();
    serverSync.connect();
    MockWebSocket.instances[0].close();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(MockWebSocket.instances.length).toBe(2);
  });

  test("resume listeners are not attached twice across repeated initialize() calls", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    serverSync._setupNetworkResumeListeners();
    const callsAfterFirst = addSpy.mock.calls.length;
    serverSync._setupNetworkResumeListeners();

    expect(addSpy.mock.calls.length).toBe(callsAfterFirst);
    addSpy.mockRestore();
  });

  test("a resume signal while already connected is a no-op", () => {
    serverSync._setupNetworkResumeListeners();
    serverSync.connect();
    MockWebSocket.instances[0].readyState = MockWebSocket.OPEN;
    serverSync.isConnected = true;

    window.dispatchEvent(new Event("online"));

    expect(MockWebSocket.instances.length).toBe(1); // no extra connect attempt
  });
});

// ---------------------------------------------------------------------------
// Intentional disconnect (e.g. sign-out) vs. a network drop. Before this fix,
// disconnect() closed the socket but never removed the online/visibility/
// focus listeners (a leak), and neither onclose nor those listeners checked
// for a deliberate close before reconnecting — so disconnect() didn't
// actually keep the connection closed.
// ---------------------------------------------------------------------------
describe("serverSync intentional disconnect", () => {
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    serverSync.isConnected = false;
    serverSync.reconnectAttempts = 0;
    serverSync.ws = null;
    serverSync._reconnectTimer = null;
    serverSync._resumeListenersAttached = false;
    serverSync._intentionalDisconnect = false;
    serverSync._onNetworkResume = null;
    serverSync._onVisibilityChange = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.WebSocket = originalWebSocket;
  });

  test("disconnect() removes the online/visibilitychange/focus listeners", () => {
    serverSync._setupNetworkResumeListeners();
    const removeWindowSpy = vi.spyOn(window, "removeEventListener");
    const removeDocSpy = vi.spyOn(document, "removeEventListener");

    serverSync.disconnect();

    expect(removeWindowSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(removeWindowSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeDocSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    removeWindowSpy.mockRestore();
    removeDocSpy.mockRestore();
  });

  test("a stray online/focus event after disconnect() does not reconnect", () => {
    serverSync._setupNetworkResumeListeners();
    serverSync.connect();
    serverSync.disconnect();

    const countAfterDisconnect = MockWebSocket.instances.length;
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));

    // Listeners were removed, so these events shouldn't even reach
    // tryResumeNow — but assert the outcome either way: no new socket.
    expect(MockWebSocket.instances.length).toBe(countAfterDisconnect);
  });

  test("onclose does not schedule a reconnect for a self-initiated disconnect()", () => {
    serverSync.connect(); // ws.close() inside disconnect() below fires onclose synchronously in the mock
    const countBeforeDisconnect = MockWebSocket.instances.length;

    serverSync.disconnect();
    vi.advanceTimersByTime(60000); // well past maxReconnectDelay if a reconnect HAD been scheduled

    expect(serverSync.reconnectAttempts).toBe(0);
    expect(MockWebSocket.instances.length).toBe(countBeforeDisconnect); // no new socket
  });

  test("connect() clears the intentional-disconnect flag, allowing a later legitimate reconnect", () => {
    serverSync.connect();
    serverSync.disconnect();
    expect(serverSync._intentionalDisconnect).toBe(true);

    serverSync.connect();

    expect(serverSync._intentionalDisconnect).toBe(false);
  });

  test("resume listeners can be re-attached after disconnect() (not left permanently blocked)", () => {
    serverSync._setupNetworkResumeListeners();
    serverSync.disconnect();
    expect(serverSync._resumeListenersAttached).toBe(false);

    serverSync._setupNetworkResumeListeners();

    expect(serverSync._resumeListenersAttached).toBe(true);
  });
});
