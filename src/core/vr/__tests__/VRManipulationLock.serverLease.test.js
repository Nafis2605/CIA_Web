// src/core/vr/__tests__/VRManipulationLock.serverLease.test.js
// Phase D3: VRManipulationLock as a client of the server manipulation lease
// (server/src/routes/vr.js POST/DELETE .../lease, .../lease/heartbeat,
// .../lease/grant). Companion to VRManipulationLock.test.js, which continues
// to exercise the ORIGINAL Y.js-only behavior against non-server session ids
// (see that file's ids, e.g. "test-session-1") — this file exercises the new
// server-lease path, which only ever engages for a real (UUID-shaped) server
// session id. See VRManipulationLock.js's class docstring for why the two
// coexist: a local `vrsession_*` id has no server row, so a lease must never
// be attempted against one, and canManipulate() falls back to the original
// Y.js mutual-exclusion in that case.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

const mockUserId = vi.fn(() => "host-1");
// Device-grain override for the Issue 5 gate tests below. Defaults to null
// (no suffix) so getParticipantId() stays a bare id — i.e. EVERY existing
// test in this file keeps its original identity model untouched; only the
// dedicated "claimAsHost() device-grain gate" describe block opts a
// composite participant id in via mockReturnValue("device-1").
const mockDeviceSuffix = vi.fn(() => null);
vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: (...a) => mockUserId(...a),
  getUserName: () => "Hostess",
  getUserColor: () => "#ff0000",
  getParticipantId: () => {
    const suffix = mockDeviceSuffix();
    return suffix ? `${mockUserId()}#${suffix}` : mockUserId();
  },
  getParticipantName: () => "Hostess",
  // Mirrors the real contract (src/collaboration/presence/userManagement.js):
  // a composite id (contains '#') must match getParticipantId() EXACTLY; a
  // bare id matches on the account (mockUserId()) alone.
  isSelfIdentity: (id) => {
    if (!id) return false;
    const value = String(id);
    const suffix = mockDeviceSuffix();
    const participantId = suffix ? `${mockUserId()}#${suffix}` : mockUserId();
    if (value.includes("#")) return value === participantId;
    return value === mockUserId();
  },
}));

vi.mock("@Core/identity/deviceIdentity.js", () => ({
  getDeviceId: vi.fn(() => "device-1"),
}));

const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock("@Services/apiClient.js", () => ({
  apiClient: {
    post: (...a) => mockPost(...a),
    delete: (...a) => mockDelete(...a),
  },
}));

import { VRManipulationLock, isServerSessionId } from "../VRManipulationLock.js";
import { ydoc } from "@Collaboration/yjs/yjsSetup.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SERVER_ID = "22222222-2222-4222-8222-222222222222";

function makeSession(id, overrides = {}) {
  return { id, ownerUserId: "host-1", ownerUserName: "Hostess", ...overrides };
}

/** A rejection shaped like apiClient's ApiError: {status, message, details}. */
function apiError(status, details = {}) {
  const err = new Error(details.error || `HTTP ${status}`);
  err.status = status;
  err.details = details;
  return err;
}

function acquireResponse(overrides = {}) {
  return {
    holder: { participantId: "host-1", userName: "Hostess" },
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    epoch: 1,
    revision: 1,
    ...overrides,
  };
}

describe("VRManipulationLock — public API surface", () => {
  it("is unchanged by the server-lease rewrite", () => {
    const proto = VRManipulationLock.prototype;
    const publicMethods = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== "constructor" && !name.startsWith("_"))
      .sort();

    expect(publicMethods).toEqual(
      [
        "approveRequest",
        "canManipulate",
        "claimAsHost",
        "denyRequest",
        "getHolder",
        "getRequests",
        "grantTo",
        "heartbeat",
        "isHeldByMe",
        "isHost",
        "onChange",
        "rekey",
        "release",
        "requestControl",
        "start",
        "stop",
      ].sort()
    );
  });
});

describe("isServerSessionId", () => {
  it("accepts a UUID and rejects local/test ids", () => {
    expect(isServerSessionId(SERVER_ID)).toBe(true);
    expect(isServerSessionId("vrsession_abc123")).toBe(false);
    expect(isServerSessionId("test-session-1")).toBe(false);
    expect(isServerSessionId(null)).toBe(false);
    expect(isServerSessionId(undefined)).toBe(false);
  });
});

describe("VRManipulationLock — server session (UUID id)", () => {
  let lock;

  beforeEach(() => {
    mockUserId.mockReturnValue("host-1");
    mockPost.mockReset();
    mockDelete.mockReset();
    lock = new VRManipulationLock(makeSession(SERVER_ID));
  });

  afterEach(() => {
    try {
      lock.stop();
    } catch {
      /* already stopped */
    }
    mockDeviceSuffix.mockReturnValue(null);
    ydoc.getMap(`vr-manipulation-${SERVER_ID}`).clear();
    ydoc.getMap(`vr-manipulation-${OTHER_SERVER_ID}`).clear();
  });

  it("canManipulate() is false when not held", () => {
    lock.start();
    expect(lock.canManipulate()).toBe(false);
  });

  it("claimAsHost() writes the Y.js echo synchronously and acquires the lease in the background", async () => {
    // Issue 5: claimAsHost() on a SERVER session now also requires
    // ownerUserId to be device-grained-and-mine (_isHostAtDeviceGrain) — see
    // the dedicated "claimAsHost() device-grain gate" describe below for the
    // bare-id refusal this guards against. Opt this test's identity into a
    // composite participant id so the claim itself is still exercised here.
    mockDeviceSuffix.mockReturnValue("device-1");
    lock = new VRManipulationLock(makeSession(SERVER_ID, { ownerUserId: "host-1#device-1" }));
    mockPost.mockResolvedValueOnce(
      acquireResponse({ holder: { participantId: "host-1#device-1", userName: "Hostess" } })
    );
    lock.start();

    lock.claimAsHost();
    // Synchronous echo — same guarantee the pre-lease implementation gave,
    // and what VRExplorationManager.sessionConvergence.realManagers.test.js
    // asserts immediately after calling claimAsHost() with no await.
    expect(lock.getHolder()).toMatchObject({ holderUserId: "host-1#device-1" });
    expect(mockPost).toHaveBeenCalledWith(`/vr/sessions/${SERVER_ID}/lease`, {
      deviceId: "device-1",
    });
    // But authority (canManipulate) only flips once the server confirms it.
    expect(lock.canManipulate()).toBe(false);

    await vi.waitFor(() => expect(lock.canManipulate()).toBe(true));
  });

  it("a 409 lease-held on acquire is a definitive not-held", async () => {
    mockPost.mockRejectedValueOnce(
      apiError(409, {
        error: "lease-held",
        holder: { participantId: "peer-2", userName: "Bob" },
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      })
    );
    lock.start();

    await lock._acquireLease();
    expect(lock.canManipulate()).toBe(false);
  });

  it("offline grace allows within the last known expiresAt and denies after it lapses", async () => {
    mockPost.mockResolvedValueOnce(
      acquireResponse({ expiresAt: new Date(Date.now() + 50).toISOString() })
    );
    lock.start();
    await lock._acquireLease();
    expect(lock.canManipulate()).toBe(true);

    // The next heartbeat can't reach the server at all — network failure,
    // status 0. This teaches us nothing definitive, so leaseState goes
    // 'unknown' rather than 'not-held'.
    mockPost.mockRejectedValueOnce(apiError(0, { originalError: "network down" }));
    await lock._sendLeaseHeartbeat();
    expect(lock.canManipulate()).toBe(true); // still inside the 50ms grace window

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(lock.canManipulate()).toBe(false); // grace window has lapsed
  });

  it("a 5xx also drops to offline grace rather than a definitive denial", async () => {
    mockPost.mockResolvedValueOnce(
      acquireResponse({ expiresAt: new Date(Date.now() + 5000).toISOString() })
    );
    lock.start();
    await lock._acquireLease();

    mockPost.mockRejectedValueOnce(apiError(500, { error: "internal" }));
    await lock._sendLeaseHeartbeat();
    expect(lock.canManipulate()).toBe(true); // grace — 5000ms window still open
  });

  it("a stale-epoch heartbeat 409 (lease-lost) drops the hold, no offline grace", async () => {
    mockPost.mockResolvedValueOnce(acquireResponse());
    lock.start();
    await lock._acquireLease();
    expect(lock.canManipulate()).toBe(true);

    mockPost.mockRejectedValueOnce(apiError(409, { error: "lease-lost" }));
    await lock._sendLeaseHeartbeat();
    // A 409 is a definitive answer, not a network hiccup — must NOT fall
    // back to offline grace even though expiresAt (in real time) hasn't
    // passed yet.
    expect(lock.canManipulate()).toBe(false);
  });

  it("heartbeat() (the public per-frame method) refreshes the lease TTL while held", async () => {
    // Issue 5: claimAsHost() on a server session requires a composite,
    // device-grained-and-mine ownerUserId — see the test above.
    mockDeviceSuffix.mockReturnValue("device-1");
    lock = new VRManipulationLock(makeSession(SERVER_ID, { ownerUserId: "host-1#device-1" }));
    mockPost.mockResolvedValueOnce(
      acquireResponse({ holder: { participantId: "host-1#device-1", userName: "Hostess" } })
    );
    lock.start();
    lock.claimAsHost();
    await vi.waitFor(() => expect(lock.canManipulate()).toBe(true));

    mockPost.mockClear();
    mockPost.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      epoch: 1,
      revision: 2,
    });
    lock._lastHeartbeatAt = 0; // bypass the 1s throttle so the test doesn't sleep
    lock.heartbeat();

    await vi.waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`/vr/sessions/${SERVER_ID}/lease/heartbeat`, {
        deviceId: "device-1",
        epoch: 1,
      })
    );
  });

  it("consumes the vr:lease-changed broadcast to learn a peer's grant reached us", () => {
    lock.start();
    expect(lock.canManipulate()).toBe(false);

    window.dispatchEvent(
      new CustomEvent("cia:vr-lease-changed", {
        detail: {
          sessionId: SERVER_ID,
          lease: {
            holderParticipantId: "host-1",
            holderName: "Hostess",
            expiresAt: new Date(Date.now() + 10000).toISOString(),
            epoch: 3,
          },
        },
      })
    );

    expect(lock.canManipulate()).toBe(true);
    expect(lock.getHolder()).toMatchObject({ holderUserId: "host-1" });
  });

  it("a vr:lease-changed broadcast naming someone else revokes our hold", async () => {
    mockPost.mockResolvedValueOnce(acquireResponse());
    lock.start();
    await lock._acquireLease();
    expect(lock.canManipulate()).toBe(true);

    window.dispatchEvent(
      new CustomEvent("cia:vr-lease-changed", {
        detail: {
          sessionId: SERVER_ID,
          lease: {
            holderParticipantId: "peer-2",
            holderName: "Bob",
            expiresAt: new Date(Date.now() + 10000).toISOString(),
            epoch: 2,
          },
        },
      })
    );

    expect(lock.canManipulate()).toBe(false);
    expect(lock.getHolder()).toMatchObject({ holderUserId: "peer-2" });
  });

  it("ignores a lease-changed broadcast for a different session id", () => {
    lock.start();
    window.dispatchEvent(
      new CustomEvent("cia:vr-lease-changed", {
        detail: {
          sessionId: OTHER_SERVER_ID,
          lease: {
            holderParticipantId: "host-1",
            holderName: "Hostess",
            expiresAt: new Date(Date.now() + 10000).toISOString(),
            epoch: 1,
          },
        },
      })
    );
    expect(lock.canManipulate()).toBe(false);
  });

  it("stop() releases a held server lease (best-effort)", async () => {
    mockPost.mockResolvedValueOnce(acquireResponse());
    lock.start();
    await lock._acquireLease();
    expect(lock.canManipulate()).toBe(true);

    mockDelete.mockResolvedValueOnce(null);
    lock.stop();

    await vi.waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(`/vr/sessions/${SERVER_ID}/lease`, {
        body: { deviceId: "device-1" },
      })
    );
  });
});

describe("VRManipulationLock — rekey and the server lease", () => {
  let lock;

  beforeEach(() => {
    mockUserId.mockReturnValue("host-1");
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    try {
      lock.stop();
    } catch {
      /* already stopped */
    }
    ydoc.getMap(`vr-manipulation-${SERVER_ID}`).clear();
    ydoc.getMap(`vr-manipulation-${OTHER_SERVER_ID}`).clear();
    ydoc.getMap("vr-manipulation-vrsession_fallback").clear();
  });

  it("rekey onto a local vrsession_* id releases the old server lease but never attempts one against the new id", async () => {
    lock = new VRManipulationLock(makeSession(SERVER_ID));
    mockPost.mockResolvedValueOnce(acquireResponse());
    lock.start();
    await lock._acquireLease();
    expect(lock.canManipulate()).toBe(true);

    mockPost.mockClear();
    mockDelete.mockResolvedValueOnce(null);

    lock.rekey("vrsession_fallback");

    // The OLD (real) server lease is released...
    await vi.waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(`/vr/sessions/${SERVER_ID}/lease`, {
        body: { deviceId: "device-1" },
      })
    );
    // ...but no acquire is EVER attempted against the local fallback id —
    // there is no server row to hold a lease on.
    expect(mockPost).not.toHaveBeenCalled();
    // canManipulate() falls back to the local-session (Y.js) rule, which
    // reads as permissive here since nobody has claimed the new map.
    expect(lock.canManipulate()).toBe(true);
  });

  it("rekey between two server ids releases the old lease and re-acquires the new one", async () => {
    lock = new VRManipulationLock(makeSession(SERVER_ID));
    mockPost.mockResolvedValueOnce(acquireResponse());
    lock.start();
    await lock._acquireLease();

    mockDelete.mockResolvedValueOnce(null);
    mockPost.mockResolvedValueOnce(acquireResponse({ epoch: 2, revision: 2 }));

    lock.rekey(OTHER_SERVER_ID);

    await vi.waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`/vr/sessions/${OTHER_SERVER_ID}/lease`, {
        deviceId: "device-1",
      })
    );
    await vi.waitFor(() => expect(lock.canManipulate()).toBe(true));
  });

  it("rekey from a local id to a server id does not attempt a release (nothing was ever leased)", () => {
    lock = new VRManipulationLock(makeSession("vrsession_start"));
    lock.start();
    expect(lock.canManipulate()).toBe(true); // local-session bypass

    lock.rekey(SERVER_ID);

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    // Now bound to a real server session with nothing claimed yet.
    expect(lock.canManipulate()).toBe(false);

    ydoc.getMap(`vr-manipulation-vrsession_start`).clear();
  });
});

describe("VRManipulationLock — local session (vrsession_* id), no server row", () => {
  let lock;
  const sessionId = "vrsession_local_test";

  beforeEach(() => {
    mockUserId.mockReturnValue("host-1");
    mockPost.mockReset();
    mockDelete.mockReset();
    lock = new VRManipulationLock(makeSession(sessionId));
    lock.start();
  });

  afterEach(() => {
    try {
      lock.stop();
    } catch {
      /* already stopped */
    }
    ydoc.getMap(`vr-manipulation-${sessionId}`).clear();
  });

  it("canManipulate() fails OPEN exactly like the pre-lease implementation — no lease ever attempted", () => {
    expect(lock.canManipulate()).toBe(true);

    lock.claimAsHost();
    expect(mockPost).not.toHaveBeenCalled();
    expect(lock.canManipulate()).toBe(true);

    const yLock = ydoc.getMap(`vr-manipulation-${sessionId}`);
    yLock.set("holder", {
      holderUserId: "peer-9",
      holderUserName: "P9",
      grantedBy: "peer-9",
      grantedAt: Date.now(),
      heartbeat: Date.now(),
    });
    expect(lock.canManipulate()).toBe(false);
  });

  it("heartbeat() never sends a network heartbeat for a local session", () => {
    lock.claimAsHost();
    lock._lastHeartbeatAt = 0;
    lock.heartbeat();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("stop() never attempts a lease release for a local session", () => {
    lock.claimAsHost();
    lock.stop();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

// Issue 5 — device-grained host identity. A legacy pre-021 row (or any row
// that fell back to the bare owner_user_id — see src/core/vr/
// vrSessionOwner.js) carries only the ACCOUNT id in ownerUserId.
// isSelfIdentity() deliberately tolerates that bare id (isHost() wants "is
// this my account's session" for roster/grant/release), so BOTH devices
// signed into that account pass isHost() — the exact two-headsets-one-
// account bug. claimAsHost() (authority SEIZURE) additionally requires
// _isHostAtDeviceGrain(): ownerUserId must contain the participant-id
// separator AND match getParticipantId() exactly. Scoped to server sessions
// only (isServerSessionId) — see the "local session" describe above, which
// stays entirely unaffected by this gate.
describe("VRManipulationLock — claimAsHost() device-grain gate (server sessions only)", () => {
  let lock;

  beforeEach(() => {
    mockUserId.mockReturnValue("host-1");
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    try {
      lock.stop();
    } catch {
      /* already stopped */
    }
    mockDeviceSuffix.mockReturnValue(null);
    ydoc.getMap(`vr-manipulation-${SERVER_ID}`).clear();
  });

  it("refuses to claim when ownerUserId is a bare (account-only) id, even though isHost() passes", () => {
    lock = new VRManipulationLock(makeSession(SERVER_ID, { ownerUserId: "host-1" }));
    lock.start();

    expect(lock.isHost()).toBe(true); // isSelfIdentity still tolerates the bare id
    expect(lock.claimAsHost()).toBe(false);
    expect(lock.getHolder()).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("claims when ownerUserId is composite and exactly matches this device's participant id", async () => {
    mockDeviceSuffix.mockReturnValue("device-1");
    mockPost.mockResolvedValueOnce(
      acquireResponse({ holder: { participantId: "host-1#device-1", userName: "Hostess" } })
    );
    lock = new VRManipulationLock(makeSession(SERVER_ID, { ownerUserId: "host-1#device-1" }));
    lock.start();

    expect(lock.claimAsHost()).toBe(true);
    expect(lock.getHolder()).toMatchObject({ holderUserId: "host-1#device-1" });
    await vi.waitFor(() => expect(lock.canManipulate()).toBe(true));
  });

  it("refuses a composite ownerUserId for a DIFFERENT device on the same account (device grain, not just account grain)", () => {
    lock = new VRManipulationLock(makeSession(SERVER_ID, { ownerUserId: "host-1#device-2" }));
    lock.start();

    // Same account (bare id matches), different device — this is really
    // just isHost() correctly saying no, included for completeness since
    // it's the scenario the whole fix exists to prevent.
    expect(lock.isHost()).toBe(false);
    expect(lock.claimAsHost()).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("release() vacates outright rather than writing an unaddressable bare host id", () => {
    // The holder (this device) is NOT the host — ownerUserId is a bare
    // legacy id — so release() must hand the token back to the host. But a
    // bare id can never be matched by isHeldByMe()/getHolder() again, so it
    // must vacate instead of writing "host-1" as the new holder.
    mockDeviceSuffix.mockReturnValue("device-1"); // this device: host-1#device-1
    lock = new VRManipulationLock(makeSession(SERVER_ID, { ownerUserId: "host-1" }));
    lock.start();

    const yLock = ydoc.getMap(`vr-manipulation-${SERVER_ID}`);
    yLock.set("holder", {
      holderUserId: "host-1#device-1",
      holderUserName: "Hostess",
      grantedBy: "host-1#some-other-device",
      grantedAt: Date.now(),
      heartbeat: Date.now(),
    });
    expect(lock.isHeldByMe()).toBe(true);

    expect(lock.release()).toBe(true);
    expect(lock.getHolder()).toBeNull();
    expect(yLock.get("holder")).toBeUndefined();
  });
});
