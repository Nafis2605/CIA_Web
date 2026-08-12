// src/core/data/managers/__tests__/AnnotationManager.builtinDatasetAlias.test.js
//
// Covers the seam between AnnotationManager and a REAL DatasetManager for
// built-in datasets: remote broadcasts carry the dataset's server UUID
// (msg.fileId / annotationData.dataset_id), but built-in datasets are
// registered locally under a manifest key like "builtin-lungs". Without
// DatasetManager's alias (see DatasetManager.builtinSweep.test.js), every
// one of these remote handlers silently drops the event because
// getDataset(uuid) misses the "builtin-*"-keyed map entry.
import { describe, test, expect, vi } from 'vitest';

vi.mock('@Utils/logger.js', () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), success: vi.fn() });
  return {
    dataset: mkLog(), annotation: mkLog(), presence: mkLog(),
    logInfo: vi.fn(), logSuccess: vi.fn(), logWarning: vi.fn(), logError: vi.fn(),
    createLogger: () => mkLog(),
  };
});

vi.mock('@Core/config/clientConfig.js', () => ({
  config: { apiBaseUrl: '/api', debugEnabled: false },
  default: { apiBaseUrl: '/api', debugEnabled: false },
}));

vi.mock('@Services/apiClient.js', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

vi.mock('@Services/builtInDatasets.js', () => ({
  isBuiltInDatasetId: (id) => typeof id === 'string' && id.startsWith('builtin-'),
  resolveBuiltInDatasetId: vi.fn(() => new Promise(() => {})), // never resolves — tests register the alias explicitly
}));

import { DatasetManager } from '../DatasetManager.js';
import { AnnotationManager } from '../AnnotationManager.js';

function makeRealManagers() {
  const datasetManager = new DatasetManager({ listDatasets: vi.fn().mockResolvedValue([]) });
  const dataset = datasetManager.addBuiltInDataset({
    id: 'builtin-lungs',
    name: 'Lungs',
    path: '/vtp_files/Lungs.vtp',
  });
  // Simulate the eager background resolution having already completed.
  datasetManager.registerBuiltInDatasetAlias('builtin-lungs', 'server-uuid-lungs');

  const annotationManager = new AnnotationManager(datasetManager);
  return { datasetManager, dataset, annotationManager };
}

describe('AnnotationManager remote handlers against a real DatasetManager with a built-in alias', () => {
  test('annotation:created resolves the built-in dataset via its server UUID', () => {
    const { dataset, annotationManager } = makeRealManagers();

    annotationManager.handleServerBroadcast('annotation:created', {
      fileId: 'server-uuid-lungs',
      annotation: {
        id: 'ann-1',
        dataset_id: 'server-uuid-lungs',
        type: 'point',
        position: [1, 2, 3],
        text: 'remote note',
        created_by: 'user-2',
      },
    });

    expect(dataset.getAnnotation('ann-1')).toBeTruthy();
    expect(dataset.getAnnotation('ann-1').text).toBe('remote note');
  });

  test('annotation:updated resolves the built-in dataset via its server UUID', () => {
    const { dataset, annotationManager } = makeRealManagers();
    annotationManager.handleServerBroadcast('annotation:created', {
      fileId: 'server-uuid-lungs',
      annotation: { id: 'ann-1', dataset_id: 'server-uuid-lungs', type: 'point', position: [0, 0, 0], text: 'old' },
    });

    annotationManager.handleServerBroadcast('annotation:updated', {
      fileId: 'server-uuid-lungs',
      annotation: { id: 'ann-1', text: 'new text' },
    });

    expect(dataset.getAnnotation('ann-1').text).toBe('new text');
  });

  test('annotation:deleted resolves the built-in dataset via its server UUID', () => {
    const { dataset, annotationManager } = makeRealManagers();
    annotationManager.handleServerBroadcast('annotation:created', {
      fileId: 'server-uuid-lungs',
      annotation: { id: 'ann-1', dataset_id: 'server-uuid-lungs', type: 'point', position: [0, 0, 0] },
    });

    annotationManager.handleServerBroadcast('annotation:deleted', {
      fileId: 'server-uuid-lungs',
      annotationId: 'ann-1',
    });

    expect(dataset.getAnnotation('ann-1')).toBeFalsy();
  });

  test('without the alias registered, the remote event is silently dropped (documents the pre-fix failure mode)', () => {
    const datasetManager = new DatasetManager({ listDatasets: vi.fn().mockResolvedValue([]) });
    const dataset = datasetManager.addBuiltInDataset({
      id: 'builtin-lungs',
      name: 'Lungs',
      path: '/vtp_files/Lungs.vtp',
    });
    // No registerBuiltInDatasetAlias call this time.
    const annotationManager = new AnnotationManager(datasetManager);

    annotationManager.handleServerBroadcast('annotation:created', {
      fileId: 'server-uuid-lungs',
      annotation: { id: 'ann-1', dataset_id: 'server-uuid-lungs', type: 'point', position: [0, 0, 0] },
    });

    expect(dataset.getAnnotation('ann-1')).toBeFalsy();
  });
});
