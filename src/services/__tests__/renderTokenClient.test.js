// src/services/__tests__/renderTokenClient.test.js
// Replaces the old shared, unscoped, non-expiring RENDER_SERVER_TOKEN baked
// into the bundle — this pins that tokens are minted via the authenticated
// API endpoint, cached per dataset scope, and re-minted once stale.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPost = vi.fn();
vi.mock("@Services/apiClient.js", () => ({
  apiClient: { post: (...a) => mockPost(...a) },
}));

import { fetchRenderToken, renderTokenHeader, fetchRenderTokenHeader } from "../renderTokenClient.js";

describe("renderTokenClient", () => {
  beforeEach(() => {
    mockPost.mockReset();
    vi.useRealTimers();
  });

  it("mints a token via POST /render/token, scoped to the given dataset", async () => {
    mockPost.mockResolvedValue({ token: "tok-abc", expiresAt: Date.now() + 60_000 });

    const token = await fetchRenderToken("ds-1");

    expect(mockPost).toHaveBeenCalledWith("/render/token", { datasetId: "ds-1" });
    expect(token).toBe("tok-abc");
  });

  it("omits datasetId from the request body when unscoped", async () => {
    mockPost.mockResolvedValue({ token: "tok-unscoped", expiresAt: Date.now() + 60_000 });

    await fetchRenderToken();

    expect(mockPost).toHaveBeenCalledWith("/render/token", { datasetId: undefined });
  });

  it("reuses a cached token for the same scope instead of re-minting", async () => {
    mockPost.mockResolvedValue({ token: "tok-cached", expiresAt: Date.now() + 3_600_000 });

    const first = await fetchRenderToken("ds-2");
    const second = await fetchRenderToken("ds-2");

    expect(first).toBe("tok-cached");
    expect(second).toBe("tok-cached");
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("re-mints once the cached token is close to expiry", async () => {
    mockPost
      .mockResolvedValueOnce({ token: "tok-old", expiresAt: Date.now() + 1000 }) // already within the refresh margin
      .mockResolvedValueOnce({ token: "tok-new", expiresAt: Date.now() + 60_000 });

    const first = await fetchRenderToken("ds-3");
    const second = await fetchRenderToken("ds-3");

    expect(first).toBe("tok-old");
    expect(second).toBe("tok-new");
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("different dataset scopes get independent cache entries", async () => {
    mockPost
      .mockResolvedValueOnce({ token: "tok-a", expiresAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ token: "tok-b", expiresAt: Date.now() + 60_000 });

    const a = await fetchRenderToken("ds-a");
    const b = await fetchRenderToken("ds-b");

    expect(a).toBe("tok-a");
    expect(b).toBe("tok-b");
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("returns null (not a throw) when minting fails", async () => {
    mockPost.mockRejectedValue(new Error("network down"));

    const token = await fetchRenderToken("ds-4");

    expect(token).toBeNull();
  });

  it("renderTokenHeader builds an X-Render-Token header, or {} for null", () => {
    expect(renderTokenHeader("tok-x")).toEqual({ "X-Render-Token": "tok-x" });
    expect(renderTokenHeader(null)).toEqual({});
  });

  it("fetchRenderTokenHeader combines minting and header-building", async () => {
    mockPost.mockResolvedValue({ token: "tok-y", expiresAt: Date.now() + 60_000 });

    const headers = await fetchRenderTokenHeader("ds-5");

    expect(headers).toEqual({ "X-Render-Token": "tok-y" });
  });
});
