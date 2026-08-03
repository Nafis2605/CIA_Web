// src/collaboration/presence/__tests__/userManagement.identity.test.js
// In dev bypass, every browser used to resolve to the same mock user
// (CIA Admin, ...0002), which collapsed two headsets into one Y.js participant.
// The dev fallback must now be the per-device identity — while an explicitly
// selected mock identity (?devUser=alice) still wins, and the production path
// is untouched.
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (all module-level imports of userManagement.js) -------------------

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  });
  return { presence: mkLog(), app: mkLog(), createLogger: () => mkLog() };
});

vi.mock("@Utils/idGenerator.js", () => ({
  generateUserId: vi.fn(() => "generated-local-id"),
}));

// Mutable so each test can flip dev mode / the revert flag.
const mockConfig = { devBypassAuth: true, identity: { deviceFallback: true } };
vi.mock("@Core/config/clientConfig.js", () => ({
  config: mockConfig,
}));

const mockGetAuthUser = vi.fn(() => null);
vi.mock("@Services/authService.js", () => ({
  authService: { getUser: mockGetAuthUser },
}));

const mockGetStoredMockUserId = vi.fn(() => null);
const DEFAULT_MOCK_USER = {
  id: "00000000-0000-0000-0000-000000000002",
  email: "admin@cia-web.local",
  name: "CIA Admin",
};
const ALICE = {
  id: "00000000-0000-0000-0000-000000000003",
  email: "alice@cia-web.local",
  name: "Alice Analyst",
};
vi.mock("@Config/mockUsers.js", () => ({
  getStoredMockUserId: () => mockGetStoredMockUserId(),
  getDefaultMockUser: () => DEFAULT_MOCK_USER,
  getMockUser: (id) => (id === ALICE.id ? ALICE : undefined),
}));

const DEVICE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const mockHasDeviceName = vi.fn(() => false);
vi.mock("@Core/identity/deviceIdentity.js", () => ({
  getDeviceId: () => DEVICE_ID,
  getDeviceName: () => "Quest 3 aaaa",
  getDeviceEmail: () => `device-${DEVICE_ID}@cia-web.local`,
  hasDeviceName: () => mockHasDeviceName(),
}));

// Imported AFTER the mocks are registered.
const userManagement = await import("@Collaboration/presence/userManagement.js");
const {
  getUserId,
  getUserName,
  getUserEmail,
  needsDisplayNamePrompt,
  clearUserName,
  setUserName,
} = userManagement;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.devBypassAuth = true;
  mockConfig.identity = { deviceFallback: true };
  mockGetStoredMockUserId.mockReturnValue(null);
  mockGetAuthUser.mockReturnValue(null);
  mockHasDeviceName.mockReturnValue(false);
  clearUserName();
});

describe("userManagement identity — dev bypass with an explicit mock user", () => {
  it("returns the stored mock id, name and email (?devUser= still wins)", () => {
    mockGetStoredMockUserId.mockReturnValue(ALICE.id);

    expect(getUserId()).toBe(ALICE.id);
    expect(getUserName()).toBe(ALICE.name);
    expect(getUserEmail()).toBe(ALICE.email);
  });

  it("never prompts for a display name when a mock identity is selected", () => {
    mockGetStoredMockUserId.mockReturnValue(ALICE.id);
    expect(needsDisplayNamePrompt()).toBe(false);
  });
});

describe("userManagement identity — dev bypass with nothing stored", () => {
  it("returns the per-device id, NOT the shared default mock user", () => {
    expect(getUserId()).toBe(DEVICE_ID);
    expect(getUserId()).not.toBe("00000000-0000-0000-0000-000000000002");
  });

  it("returns the device name and the deterministic device email", () => {
    expect(getUserName()).toBe("Quest 3 aaaa");
    expect(getUserEmail()).toBe(`device-${DEVICE_ID}@cia-web.local`);
  });

  it("prefers an explicitly typed display name over the derived one", () => {
    setUserName("Fahim");
    expect(getUserName()).toBe("Fahim");
    // The id is unaffected by the display name.
    expect(getUserId()).toBe(DEVICE_ID);
  });

  it("prompts for a display name until one has been chosen", () => {
    expect(needsDisplayNamePrompt()).toBe(true);

    setUserName("Fahim");
    expect(needsDisplayNamePrompt()).toBe(false);

    clearUserName();
    mockHasDeviceName.mockReturnValue(true);
    expect(needsDisplayNamePrompt()).toBe(false);
  });
});

describe("userManagement identity — revert flag", () => {
  it("restores the default mock user when identity.deviceFallback is false", () => {
    mockConfig.identity = { deviceFallback: false };

    expect(getUserId()).toBe(DEFAULT_MOCK_USER.id);
    expect(getUserName()).toBe(DEFAULT_MOCK_USER.name);
    expect(getUserEmail()).toBe(DEFAULT_MOCK_USER.email);
  });
});

describe("userManagement identity — production path unchanged", () => {
  beforeEach(() => {
    mockConfig.devBypassAuth = false;
  });

  it("uses the authenticated user and never the dev fallbacks", () => {
    mockGetAuthUser.mockReturnValue({
      id: "keycloak-user-1",
      name: "Real User",
      email: "real@example.com",
    });

    expect(getUserId()).toBe("keycloak-user-1");
    expect(getUserName()).toBe("Real User");
    expect(getUserEmail()).toBe("real@example.com");
    expect(mockGetStoredMockUserId).not.toHaveBeenCalled();
  });

  it("falls back to the locally generated id when nobody is signed in", () => {
    const id = getUserId();
    expect(id).not.toBe(DEVICE_ID);
    expect(id).not.toBe(DEFAULT_MOCK_USER.id);
    expect(getUserEmail()).toBeNull();
  });

  it("does not prompt for a display name when signed in", () => {
    mockGetAuthUser.mockReturnValue({ id: "keycloak-user-1" });
    expect(needsDisplayNamePrompt()).toBe(false);
  });
});
