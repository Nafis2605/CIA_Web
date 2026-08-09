// src/collaboration/presence/__tests__/participantIdentity.test.js
// The account-vs-device identity split.
//
// getUserId() answers "whose account?" and must keep meaning exactly that —
// ownership, permissions and server rows depend on it. getParticipantId()
// answers "which connected device?", which is what every presence key needs:
// two headsets signed into ONE account share a getUserId(), so keying presence
// on it collapsed them into a single Y.js entry that each device then skipped
// as its own, leaving them invisible to each other.

import { describe, test, expect, vi, beforeEach } from "vitest";

const mockAuthUser = vi.fn(() => ({ id: "account-uuid", name: "Fahim" }));
vi.mock("@Services/authService.js", () => ({
  authService: { getUser: (...a) => mockAuthUser(...a) },
}));

// Device fallback OFF in these tests: with devBypassAuth false, getUserId()
// takes the authenticated branch, which is the production path where the
// collision actually occurred.
vi.mock("@Core/config/clientConfig.js", () => ({
  config: { devBypassAuth: false, identity: { deviceFallback: true } },
  default: { devBypassAuth: false, identity: { deviceFallback: true } },
}));

const mockDeviceId = vi.fn(() => "device-uuid");
const mockDeviceName = vi.fn(() => "Quest 3 a41f");
vi.mock("@Core/identity/deviceIdentity.js", () => ({
  getDeviceId: (...a) => mockDeviceId(...a),
  getDeviceName: (...a) => mockDeviceName(...a),
  getDeviceEmail: vi.fn(() => "device-uuid@cia-web.local"),
  hasDeviceName: vi.fn(() => false),
}));

vi.mock("@Config/mockUsers.js", () => ({
  getStoredMockUserId: vi.fn(() => null),
  getDefaultMockUser: vi.fn(() => ({ id: "mock-1", name: "CIA Admin", email: "admin@localhost" })),
  getMockUser: vi.fn(() => null),
}));

vi.mock("@Utils/logger.js", () => ({
  presence: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@Utils/idGenerator.js", () => ({
  generateUserId: vi.fn(() => "generated-uuid"),
}));

import {
  getUserId,
  getParticipantId,
  getParticipantName,
  getAccountId,
  isSelfIdentity,
} from "../userManagement.js";

describe("getParticipantId", () => {
  beforeEach(() => {
    mockDeviceId.mockReturnValue("device-uuid");
    mockAuthUser.mockReturnValue({ id: "account-uuid", name: "Fahim" });
  });

  test("combines the account and the device", () => {
    expect(getParticipantId()).toBe("account-uuid#device-uuid");
  });

  test("getUserId is unchanged — it still returns the bare account id", () => {
    expect(getUserId()).toBe("account-uuid");
  });

  // The whole point: same account, two devices, two identities.
  test("two devices on one account produce different participant ids", () => {
    const headsetA = getParticipantId();
    mockDeviceId.mockReturnValue("device-other");
    const headsetB = getParticipantId();

    expect(headsetA).not.toBe(headsetB);
    expect(getAccountId(headsetA)).toBe(getAccountId(headsetB));
  });
});

describe("getAccountId", () => {
  test("recovers the account half of a participant id", () => {
    expect(getAccountId("account-uuid#device-uuid")).toBe("account-uuid");
  });

  // Server rows store the bare account id (owner_user_id comes from the auth
  // token), so this has to pass those through untouched.
  test("passes a bare account id through unchanged", () => {
    expect(getAccountId("account-uuid")).toBe("account-uuid");
  });

  test("tolerates null and undefined", () => {
    expect(getAccountId(null)).toBe("");
    expect(getAccountId(undefined)).toBe("");
  });
});

describe("isSelfIdentity", () => {
  beforeEach(() => {
    mockDeviceId.mockReturnValue("device-uuid");
    mockAuthUser.mockReturnValue({ id: "account-uuid", name: "Fahim" });
  });

  test("matches this exact device", () => {
    expect(isSelfIdentity("account-uuid#device-uuid")).toBe(true);
  });

  // A composite id from the OTHER headset on the same account is someone else.
  test("rejects a different device on the same account", () => {
    expect(isSelfIdentity("account-uuid#device-other")).toBe(false);
  });

  // A bare id can only have come from the server, where it means the account.
  test("matches a bare account id on the account", () => {
    expect(isSelfIdentity("account-uuid")).toBe(true);
    expect(isSelfIdentity("someone-else")).toBe(false);
  });

  test("is false for empty input", () => {
    expect(isSelfIdentity(null)).toBe(false);
    expect(isSelfIdentity("")).toBe(false);
  });
});

describe("getParticipantName", () => {
  beforeEach(() => {
    mockAuthUser.mockReturnValue({ id: "account-uuid", name: "Fahim" });
    mockDeviceName.mockReturnValue("Quest 3 a41f");
  });

  // Without this both headsets render an avatar labelled "Fahim".
  test("appends the device label when authenticated", () => {
    expect(getParticipantName()).toBe("Fahim (Quest 3 a41f)");
  });

  test("does not double up when the names already agree", () => {
    mockDeviceName.mockReturnValue("Fahim");
    expect(getParticipantName()).toBe("Fahim");
  });

  test("falls back to the device label when there is no account name", () => {
    mockAuthUser.mockReturnValue({ id: "account-uuid" });
    expect(getParticipantName()).toBe("Quest 3 a41f");
  });
});
