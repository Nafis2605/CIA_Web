// src/services/renderTokenClient.js
// Mints (and caches) short-lived, scoped render server credentials via
// POST /api/render/token (server/src/routes/renderToken.js) — replaces the
// single static RENDER_SERVER_TOKEN that used to be baked into the bundle
// via webpack DefinePlugin (visible to anyone who opened devtools) and
// shared, unscoped and non-expiring, by every client/session.
//
// One cache entry per dataset scope (datasetId, or "" for unscoped calls
// like listing datasets) so a viewport loading dataset A doesn't force a
// re-mint for a concurrent listing call, but the same scope's token is
// reused across calls until it's close to expiry.

import { apiClient } from '@Services/apiClient.js';

const REFRESH_MARGIN_MS = 60_000; // refetch a bit before actual expiry
const _cache = new Map(); // scope key -> { token, expiresAt }

/**
 * @param {string|null} [datasetId] - Scope the token to this dataset, or
 *   leave unscoped (null) for calls that don't reference one dataset (e.g.
 *   listing datasets).
 * @returns {Promise<string|null>} The token, or null if minting failed
 *   (caller should proceed unauthenticated — the render server's own gate
 *   simply stays closed in that case).
 */
export async function fetchRenderToken(datasetId = null) {
  const key = datasetId || '';
  const cached = _cache.get(key);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  try {
    const response = await apiClient.post('/render/token', {
      datasetId: datasetId || undefined,
    });
    if (!response?.token) return null;
    _cache.set(key, {
      token: response.token,
      expiresAt: typeof response.expiresAt === 'number' ? response.expiresAt : Date.now() + REFRESH_MARGIN_MS,
    });
    return response.token;
  } catch (err) {
    console.warn('[renderTokenClient] failed to mint render token:', err.message);
    return null;
  }
}

/** @param {string|null} token @returns {{'X-Render-Token': string}|{}} */
export function renderTokenHeader(token) {
  return token ? { 'X-Render-Token': token } : {};
}

/**
 * Convenience: mint (or reuse) a token for `datasetId` and return it as a
 * ready-to-spread headers object.
 * @param {string|null} [datasetId]
 */
export async function fetchRenderTokenHeader(datasetId = null) {
  return renderTokenHeader(await fetchRenderToken(datasetId));
}
