// src/services/builtInDatasets.js
// Loads the built-in VTP sample dataset manifest from public/vtp_files/manifest.json
// and registers each entry with DatasetManager so the app always shows them.
//
// Called non-blocking during Phase 1 init — a manifest failure never blocks startup.

import { dataset as log } from '@Utils/logger.js';
import { apiClient } from '@Services/apiClient.js';

const MANIFEST_URL = '/vtp_files/manifest.json';

// Bundled manifest ids all use this prefix (public/vtp_files/manifest.json —
// "builtin-lungs", "builtin-bones", etc.). Checking for the prefix
// specifically — rather than "isn't a UUID" — matters: plenty of code paths
// (and test fixtures) use short non-UUID placeholder ids like "ds-1" that
// are neither real dataset UUIDs nor bundled datasets; treating "not a UUID"
// as "is bundled" would wrongly trigger a resolve round-trip for those.
const BUILTIN_KEY_PREFIX = 'builtin-';

/** Memoized builtinKey -> UUID map, resolved once per page load. */
let _builtinIdCachePromise = null;

/**
 * Whether `id` is a bundled dataset's manifest key (e.g. "builtin-lungs"),
 * as opposed to a real dataset UUID or an unrelated placeholder id.
 * @param {string} id
 * @returns {boolean}
 */
export function isBuiltInDatasetId(id) {
  return typeof id === 'string' && id.startsWith(BUILTIN_KEY_PREFIX);
}

/**
 * Resolve a bundled dataset's manifest id (e.g. "builtin-lungs") to its real,
 * stable server-side UUID — see migrations/020_bundled_dataset_ids.sql and
 * GET /api/files/builtin. Memoized for the page's lifetime; a failed fetch
 * is not cached, so a later call can retry once connectivity returns.
 *
 * @param {string} builtinKey
 * @returns {Promise<string|null>} the dataset UUID, or null if unresolvable
 */
export async function resolveBuiltInDatasetId(builtinKey) {
  if (!builtinKey) return null;

  if (!_builtinIdCachePromise) {
    _builtinIdCachePromise = apiClient
      .get('/files/builtin')
      .then((data) => new Map((data?.datasets || []).map((d) => [d.builtin_key, d.id])))
      .catch((err) => {
        log.warn('resolveBuiltInDatasetId: failed to fetch /files/builtin:', err.message);
        _builtinIdCachePromise = null; // allow a retry on the next call
        return new Map();
      });
  }

  const cache = await _builtinIdCachePromise;
  return cache.get(builtinKey) || null;
}

/**
 * Fetch the built-in dataset manifest and register each entry with DatasetManager.
 *
 * @param {import('@Core/data/managers/DatasetManager').DatasetManager} datasetManager
 * @returns {Promise<number>} Number of datasets registered
 */
export async function loadBuiltInDatasets(datasetManager) {
  if (!datasetManager) {
    log.warn('builtInDatasets: DatasetManager not ready, skipping');
    return 0;
  }

  let manifest;
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    manifest = await res.json();
  } catch (err) {
    log.warn(`builtInDatasets: Failed to load manifest (${MANIFEST_URL}):`, err.message);
    // Emit a non-fatal app event so UI can show a soft warning
    window.dispatchEvent(
      new CustomEvent('cia:builtin-datasets-unavailable', {
        detail: { reason: err.message },
      })
    );
    return 0;
  }

  if (!Array.isArray(manifest)) {
    log.warn('builtInDatasets: manifest.json is not an array — skipping');
    return 0;
  }

  let count = 0;
  for (const entry of manifest) {
    if (!entry.id || !entry.path) {
      log.warn('builtInDatasets: Skipping malformed manifest entry:', entry);
      continue;
    }
    try {
      datasetManager.addBuiltInDataset(entry);
      count++;
    } catch (err) {
      log.warn(`builtInDatasets: Failed to register "${entry.name}":`, err.message);
    }
  }

  log.info(`builtInDatasets: Registered ${count} built-in dataset(s)`);
  return count;
}
