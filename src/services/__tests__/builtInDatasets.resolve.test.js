// src/services/__tests__/builtInDatasets.resolve.test.js
// Bundled-dataset id resolution (Phase 3, item G): bundled datasets
// (public/vtp_files/manifest.json, e.g. "builtin-lungs") get a real,
// stable server-side UUID row (migrations/020_bundled_dataset_ids.sql) so
// annotations/measurements on them flow through the normal server-side
// authorization/storage path. resolveBuiltInDatasetId is the client-side
// half: resolving a manifest key to that UUID via GET /api/files/builtin,
// memoized for the page's lifetime.
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@Utils/logger.js', () => ({
  dataset: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockGet = vi.fn();
vi.mock('@Services/apiClient.js', () => ({
  apiClient: { get: (...args) => mockGet(...args) },
}));

describe('isBuiltInDatasetId', () => {
  test('true for bundled manifest keys', async () => {
    const { isBuiltInDatasetId } = await import('../builtInDatasets.js');
    expect(isBuiltInDatasetId('builtin-lungs')).toBe(true);
    expect(isBuiltInDatasetId('builtin-bones')).toBe(true);
  });

  test('false for a real dataset UUID', async () => {
    const { isBuiltInDatasetId } = await import('../builtInDatasets.js');
    expect(isBuiltInDatasetId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  test('false for an unrelated short placeholder id (e.g. a test fixture)', async () => {
    // Regression guard: "not a UUID" must NOT be treated as "is bundled" —
    // plenty of code paths/test fixtures use ids like "ds-1" that are
    // neither real dataset UUIDs nor bundled datasets.
    const { isBuiltInDatasetId } = await import('../builtInDatasets.js');
    expect(isBuiltInDatasetId('ds-1')).toBe(false);
  });

  test('false for null/undefined/non-string input', async () => {
    const { isBuiltInDatasetId } = await import('../builtInDatasets.js');
    expect(isBuiltInDatasetId(null)).toBe(false);
    expect(isBuiltInDatasetId(undefined)).toBe(false);
    expect(isBuiltInDatasetId(42)).toBe(false);
  });
});

describe('resolveBuiltInDatasetId', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGet.mockReset();
  });

  test('resolves a builtin_key to its UUID via GET /files/builtin', async () => {
    mockGet.mockResolvedValue({
      datasets: [
        { id: 'uuid-1', builtin_key: 'builtin-lungs' },
        { id: 'uuid-2', builtin_key: 'builtin-bones' },
      ],
    });
    const { resolveBuiltInDatasetId } = await import('../builtInDatasets.js');

    const result = await resolveBuiltInDatasetId('builtin-lungs');
    expect(result).toBe('uuid-1');
    expect(mockGet).toHaveBeenCalledWith('/files/builtin');
  });

  test('memoizes across calls — only one network request for many resolutions', async () => {
    mockGet.mockResolvedValue({
      datasets: [{ id: 'uuid-1', builtin_key: 'builtin-lungs' }],
    });
    const { resolveBuiltInDatasetId } = await import('../builtInDatasets.js');

    await resolveBuiltInDatasetId('builtin-lungs');
    await resolveBuiltInDatasetId('builtin-lungs');
    await resolveBuiltInDatasetId('builtin-lungs');

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test('returns null for an unresolvable key', async () => {
    mockGet.mockResolvedValue({ datasets: [] });
    const { resolveBuiltInDatasetId } = await import('../builtInDatasets.js');

    expect(await resolveBuiltInDatasetId('builtin-nonexistent')).toBeNull();
  });

  test('returns null for a falsy key without hitting the network', async () => {
    const { resolveBuiltInDatasetId } = await import('../builtInDatasets.js');
    expect(await resolveBuiltInDatasetId(null)).toBeNull();
    expect(await resolveBuiltInDatasetId('')).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('does not cache a failed fetch — a later call can retry', async () => {
    mockGet.mockRejectedValueOnce(new Error('offline'));
    mockGet.mockResolvedValueOnce({
      datasets: [{ id: 'uuid-1', builtin_key: 'builtin-lungs' }],
    });
    const { resolveBuiltInDatasetId } = await import('../builtInDatasets.js');

    const first = await resolveBuiltInDatasetId('builtin-lungs');
    expect(first).toBeNull();

    const second = await resolveBuiltInDatasetId('builtin-lungs');
    expect(second).toBe('uuid-1');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
