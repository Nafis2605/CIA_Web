// src/services/__tests__/RemoteRenderClient.test.js
// H13: RemoteRenderClient used to be exported as one pre-built singleton
// shared by every mounted ServerRenderedViewport — all requests keyed by
// response TYPE in one `_pending` Map, so two viewports racing loadDataset
// overwrote each other's resolver. The fix exports the class so each
// viewport owns its own instance/connection/session; this pins that two
// instances never share state, that disconnecting rejects in-flight
// requests instead of hanging forever, and that requests time out.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@Core/config/clientConfig.js", () => ({
  config: {
    renderMode: "server",
    renderWsUrl: "/render-ws",
    renderServerToken: "",
  },
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
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "test close" });
  }

  /** Test helper: simulate the server accepting the connection. */
  simulateConnected(sessionId = "session-1") {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId }) });
  }

  /** Test helper: simulate an incoming server message. */
  simulateMessage(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

import { RemoteRenderClient } from "../RemoteRenderClient.js";

describe("RemoteRenderClient — per-instance isolation, disconnect rejection, timeouts", () => {
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.WebSocket = originalWebSocket;
  });

  test("two instances have fully independent pending/session state", async () => {
    const a = new RemoteRenderClient();
    const b = new RemoteRenderClient();

    const connectA = a.connect();
    MockWebSocket.instances[0].simulateConnected("session-a");
    await connectA;

    const connectB = b.connect();
    MockWebSocket.instances[1].simulateConnected("session-b");
    await connectB;

    expect(a.sessionId).toBe("session-a");
    expect(b.sessionId).toBe("session-b");

    // Both load a dataset "concurrently" — each must resolve with its OWN
    // response, not whichever instance's frame arrived last (the original bug).
    const loadA = a.loadDataset("dataset-a", "/a.vtp");
    const loadB = b.loadDataset("dataset-b", "/b.vtp");
    // loadDataset awaits _ensureConnected() internally (one microtask hop
    // even when already connected) before it actually registers/sends —
    // flush that before simulating server responses.
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[1].simulateMessage({
      type: "datasetLoaded", datasetId: "dataset-b", metadata: { for: "b" },
    });
    MockWebSocket.instances[1].simulateMessage({
      type: "frame", image: "img-b", width: 10, height: 10,
    });
    MockWebSocket.instances[0].simulateMessage({
      type: "datasetLoaded", datasetId: "dataset-a", metadata: { for: "a" },
    });
    MockWebSocket.instances[0].simulateMessage({
      type: "frame", image: "img-a", width: 10, height: 10,
    });

    const [resultA, resultB] = await Promise.all([loadA, loadB]);
    expect(resultA.metadata).toEqual({ for: "a" });
    expect(resultA.image).toContain("img-a");
    expect(resultB.metadata).toEqual({ for: "b" });
    expect(resultB.image).toContain("img-b");
  });

  test("disconnecting rejects every in-flight request instead of hanging forever", async () => {
    const client = new RemoteRenderClient();
    const connectP = client.connect();
    MockWebSocket.instances[0].simulateConnected();
    await connectP;

    const loadP = client.loadDataset("dataset-a", "/a.vtp");
    const cameraP = client.updateCamera({ position: [0, 0, 1] });
    // Let both requests actually register/send before the connection drops —
    // the realistic "in flight, then disconnected" ordering.
    await vi.advanceTimersByTimeAsync(0);

    client.disconnect();

    await expect(loadP).rejects.toThrow(/connection closed/i);
    await expect(cameraP).rejects.toThrow(/connection closed/i);
  });

  test("a request that never gets a response times out", async () => {
    const client = new RemoteRenderClient();
    const connectP = client.connect();
    MockWebSocket.instances[0].simulateConnected();
    await connectP;

    const loadP = client.loadDataset("dataset-a", "/a.vtp");
    // Swallow the rejection assertion below handles; avoid an unhandled-
    // rejection warning while timers advance.
    loadP.catch(() => {});

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(loadP).rejects.toThrow(/timed out/i);
  });

  test("a response that arrives before the timeout resolves cleanly with no stray rejection later", async () => {
    const client = new RemoteRenderClient();
    const connectP = client.connect();
    MockWebSocket.instances[0].simulateConnected();
    await connectP;

    const loadP = client.loadDataset("dataset-a", "/a.vtp");
    await vi.advanceTimersByTimeAsync(0);
    MockWebSocket.instances[0].simulateMessage({
      type: "datasetLoaded", datasetId: "dataset-a", metadata: { ok: true },
    });
    MockWebSocket.instances[0].simulateMessage({
      type: "frame", image: "img", width: 10, height: 10,
    });

    await expect(loadP).resolves.toMatchObject({ metadata: { ok: true } });

    // The timeout timer from the original send must have been cleared —
    // advancing past it must not throw or reject anything.
    await vi.advanceTimersByTimeAsync(20_000);
  });
});
