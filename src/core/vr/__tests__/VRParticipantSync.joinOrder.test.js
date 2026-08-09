// src/core/vr/__tests__/VRParticipantSync.joinOrder.test.js
// H4 fix: host election used to tie-break on each client's local `joinedAt`
// (Date.now(), never broadcast), so clients could disagree on who joined
// first. This pins the replacement — a shared, append-only join-order
// Y.Array whose insertion order is CRDT-consistent across every synced
// replica — and the append-once guard that keeps a rejoin from re-racing it.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

const { mockYMaps, mockYArrays } = vi.hoisted(() => ({ mockYMaps: new Map(), mockYArrays: new Map() }));
vi.mock("@Collaboration/yjs/yjsSetup.js", () => ({
  ydoc: {
    getMap: (name) => {
      if (!mockYMaps.has(name)) {
        const store = new Map();
        mockYMaps.set(name, {
          _store: store,
          get: (k) => store.get(k),
          set: (k, v) => store.set(k, v),
          delete: (k) => store.delete(k),
          forEach: (fn) => store.forEach(fn),
          observe: vi.fn(),
          unobserve: vi.fn(),
        });
      }
      return mockYMaps.get(name);
    },
    getArray: (name) => {
      if (!mockYArrays.has(name)) {
        const items = [];
        mockYArrays.set(name, {
          _items: items,
          toArray: () => items.slice(),
          push: (values) => items.push(...values),
          observe: vi.fn(),
          unobserve: vi.fn(),
        });
      }
      return mockYArrays.get(name);
    },
  },
}));

let currentParticipantId = "local-user";
vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: vi.fn(() => "local-user"),
  getParticipantId: vi.fn(() => currentParticipantId),
  getParticipantName: vi.fn(() => "Local"),
  isSelfIdentity: vi.fn((id) => id === "local-user"),
}));

import { VRParticipantSync } from "../VRParticipantSync.js";
import { VRExplorationSession, PARTICIPATION_MODE } from "@Core/data/models/VRExplorationSession.js";

function makeSession(id = "vrsession_test") {
  const session = new VRExplorationSession({ id });
  session.addParticipant("local-user", "Me", "#ff0000", PARTICIPATION_MODE.VR_EXPLORER);
  return session;
}

describe("VRParticipantSync join order", () => {
  beforeEach(() => {
    mockYMaps.clear();
    mockYArrays.clear();
    currentParticipantId = "local-user";
  });

  it("start() appends exactly one record for the local participant", () => {
    const session = makeSession();
    const sync = new VRParticipantSync(session);
    sync.start();

    const order = sync.getJoinOrder();
    expect(order).toHaveLength(1);
    expect(order[0].participantId).toBe("local-user");
    expect(typeof order[0].joinedAt).toBe("number");
  });

  it("a rejoin (same stable participant id) does not duplicate the append", () => {
    const session = makeSession();

    // First "join" — e.g. an earlier browser session.
    const first = new VRParticipantSync(session);
    first.start();

    // Rejoin — same device, same getParticipantId(), simulating a reconnect.
    const second = new VRParticipantSync(session);
    second.start();

    const order = second.getJoinOrder();
    expect(order).toHaveLength(1);
    expect(order.filter((r) => r.participantId === "local-user")).toHaveLength(1);
  });

  it("getJoinOrder returns entries in insertion order across multiple participants", () => {
    const session = makeSession();
    const sync = new VRParticipantSync(session);
    sync.start();

    currentParticipantId = "remote-user";
    const remoteSync = new VRParticipantSync(session);
    remoteSync.start();

    const order = sync.getJoinOrder();
    expect(order.map((r) => r.participantId)).toEqual(["local-user", "remote-user"]);
  });

  it("getJoinOrder returns [] before start() has run", () => {
    const session = makeSession();
    const sync = new VRParticipantSync(session);
    expect(sync.getJoinOrder()).toEqual([]);
  });

  it("rekey(newSessionId) appends into the new session's own join-order array", () => {
    const session = makeSession("vrsession_old");
    const sync = new VRParticipantSync(session);
    sync.start();
    expect(sync.getJoinOrder()).toHaveLength(1);

    session.id = "vrsession_new";
    sync.rekey("vrsession_new");

    const newOrder = sync.getJoinOrder();
    expect(newOrder).toHaveLength(1);
    expect(newOrder[0].participantId).toBe("local-user");

    // The old session's array is untouched — a fresh one backs the new session.
    const oldOrder = mockYArrays.get("vr-join-order-vrsession_old").toArray();
    expect(oldOrder).toHaveLength(1);
  });
});
