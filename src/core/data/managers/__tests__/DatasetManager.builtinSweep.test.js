// src/core/data/managers/__tests__/DatasetManager.builtinSweep.test.js
//
// Covers the built-in sample dataset sweep exemption (Work Package 2):
// built-in datasets (ids `builtin-*`, cacheKey 'builtin', metadata.isBuiltIn)
// must never be classified as orphans or ID-migration candidates during
// server reconciliation, otherwise the "Sample Datasets" catalog is deleted
// on every boot.
import { describe, test, expect, beforeEach, vi } from 'vitest';

// ----------------------------------------------------------------------------
// Mocks for heavy dependencies
// ----------------------------------------------------------------------------

vi.mock('@Utils/logger.js', () => {
  const mkLog = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  });
  return {
    dataset: mkLog(),
    logInfo: vi.fn(),
    logSuccess: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
    createLogger: () => mkLog(),
  };
});

vi.mock('@Core/config/clientConfig.js', () => ({
  config: { apiBaseUrl: 'http://localhost:3001/api' },
  default: { apiBaseUrl: 'http://localhost:3001/api' },
}));

vi.mock('@Services/apiClient.js', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

vi.mock('@Services/builtInDatasets.js', () => ({
  isBuiltInDatasetId: (id) => typeof id === 'string' && id.startsWith('builtin-'),
  resolveBuiltInDatasetId: vi.fn(),
}));

import { DatasetManager, isBuiltInDataset } from '../DatasetManager.js';
import { resolveBuiltInDatasetId } from '@Services/builtInDatasets.js';

/**
 * Build a DatasetManager whose IndexedDB-backed methods are stubbed so the
 * reconciliation logic can run without a real database.
 */
function makeManager(serverFiles = []) {
  const storageProvider = {
    listDatasets: vi.fn().mockResolvedValue(serverFiles),
  };
  const mgr = new DatasetManager(storageProvider);
  // Stub persistence side-effects — we only assert in-memory classification.
  mgr._deleteDataset = vi.fn().mockResolvedValue(undefined);
  mgr._persistDataset = vi.fn().mockResolvedValue(undefined);
  mgr._addDatasetFromServer = vi.fn(async (f) => {
    mgr._datasets.set(f.id, f);
    return f;
  });
  return mgr;
}

describe('isBuiltInDataset', () => {
  test('matches cacheKey "builtin"', () => {
    expect(isBuiltInDataset({ id: 'x', cacheKey: 'builtin' })).toBe(true);
  });

  test('matches metadata.isBuiltIn', () => {
    expect(isBuiltInDataset({ id: 'x', metadata: { isBuiltIn: true } })).toBe(true);
  });

  test('matches id prefix "builtin-"', () => {
    expect(isBuiltInDataset({ id: 'builtin-lungs' })).toBe(true);
  });

  test('is false for regular server datasets', () => {
    expect(isBuiltInDataset({ id: 'abc-123', cacheKey: 'abc-123' })).toBe(false);
    expect(isBuiltInDataset(null)).toBe(false);
    expect(isBuiltInDataset(undefined)).toBe(false);
  });
});

describe('DatasetManager.reconcileWithServer — built-in exemption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('built-in datasets are never removed as orphans (empty server)', async () => {
    const mgr = makeManager([]); // server has nothing
    const builtin = {
      id: 'builtin-lungs',
      filename: 'Lungs.vtp',
      name: 'Lungs',
      cacheKey: 'builtin',
      metadata: { isBuiltIn: true },
    };
    mgr._datasets.set(builtin.id, builtin);

    const result = await mgr.reconcileWithServer();

    expect(result.orphansRemoved).toBe(0);
    expect(mgr._deleteDataset).not.toHaveBeenCalled();
    expect(mgr._datasets.has('builtin-lungs')).toBe(true);
  });

  test('built-in datasets are never ID-migrated even when hash matches a server row', async () => {
    // A server row happens to share the builtin content hash — a naive
    // reconciler would migrate the builtin to the server id, stripping its
    // Sample identity. It must stay a builtin instead.
    const serverFiles = [{ id: 'server-uuid-1', hash: 'deadbeef' }];
    const mgr = makeManager(serverFiles);
    const builtin = {
      id: 'builtin-skull',
      filename: 'Skull.vtp',
      name: 'Skull',
      hash: 'deadbeef',
      cacheKey: 'builtin',
      metadata: { isBuiltIn: true },
    };
    mgr._datasets.set(builtin.id, builtin);

    const result = await mgr.reconcileWithServer();

    expect(result.idsMigrated).toBe(0);
    expect(result.orphansRemoved).toBe(0);
    expect(mgr._deleteDataset).not.toHaveBeenCalled();
    expect(mgr._datasets.has('builtin-skull')).toBe(true);
  });

  test('regular orphan datasets are still removed', async () => {
    const mgr = makeManager([]); // server has nothing
    const orphan = {
      id: 'orphan-1',
      filename: 'Old.vtp',
      name: 'Old',
      cacheKey: 'orphan-1',
    };
    mgr._datasets.set(orphan.id, orphan);

    const result = await mgr.reconcileWithServer();

    expect(result.orphansRemoved).toBe(1);
    expect(mgr._deleteDataset).toHaveBeenCalledWith('orphan-1');
    expect(mgr._datasets.has('orphan-1')).toBe(false);
  });
});

describe('DatasetManager — built-in dataset id alias', () => {
  beforeEach(() => {
    resolveBuiltInDatasetId.mockReset();
  });

  test('addBuiltInDataset eagerly resolves and registers the alias, so getDataset finds it by either id', async () => {
    const mgr = makeManager([]);
    let resolveFn;
    resolveBuiltInDatasetId.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve;
      })
    );

    const dataset = mgr.addBuiltInDataset({
      id: 'builtin-lungs',
      name: 'Lungs',
      path: '/vtp_files/Lungs.vtp',
    });

    // Resolution hasn't completed yet — only the local key hits.
    expect(mgr.getDataset('builtin-lungs')).toBe(dataset);
    expect(mgr.getDataset('server-uuid-lungs')).toBeNull();

    resolveFn('server-uuid-lungs');
    await Promise.resolve();
    await Promise.resolve(); // let addBuiltInDataset's .then() run after the resolve

    expect(mgr.getDataset('server-uuid-lungs')).toBe(dataset);
    expect(mgr.getDataset('builtin-lungs')).toBe(dataset);
    expect(dataset.serverId).toBe('server-uuid-lungs');
  });

  test('a failed alias resolution does not throw and leaves local-key lookup working', async () => {
    const mgr = makeManager([]);
    resolveBuiltInDatasetId.mockRejectedValue(new Error('network down'));

    let dataset;
    expect(() => {
      dataset = mgr.addBuiltInDataset({
        id: 'builtin-bones',
        name: 'Bones',
        path: '/vtp_files/Bones.vtp',
      });
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the rejected chain

    expect(mgr.getDataset('builtin-bones')).toBe(dataset);
  });

  test('registerBuiltInDatasetAlias is idempotent', () => {
    const mgr = makeManager([]);
    resolveBuiltInDatasetId.mockReturnValue(new Promise(() => {})); // never resolves — isolate from addBuiltInDataset's own resolution
    const dataset = mgr.addBuiltInDataset({
      id: 'builtin-heart',
      name: 'Heart',
      path: '/vtp_files/Heart.vtp',
    });

    mgr.registerBuiltInDatasetAlias('builtin-heart', 'uuid-heart');
    mgr.registerBuiltInDatasetAlias('builtin-heart', 'uuid-heart');

    expect(mgr.getDataset('uuid-heart')).toBe(dataset);
    expect(dataset.serverId).toBe('uuid-heart');
  });

  test('registerBuiltInDatasetAlias is a no-op when either id is missing', () => {
    const mgr = makeManager([]);
    expect(() => mgr.registerBuiltInDatasetAlias(null, 'uuid-x')).not.toThrow();
    expect(() => mgr.registerBuiltInDatasetAlias('builtin-x', null)).not.toThrow();
    expect(mgr.getDataset('uuid-x')).toBeNull();
  });
});
