// src/services/storage/__tests__/storageService.test.js
// Regression coverage for storageService using the real projectId
// (sessionManager.getProjectId()) rather than the room-scoped
// config.defaultSessionId constant.
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@Core/config/clientConfig.js', () => ({
  config: {
    useServerStorage: true,
    apiBaseUrl: 'https://api.test',
    defaultSessionId: 'default-session-id',
  },
}));

const { mockGetProjectId } = vi.hoisted(() => ({ mockGetProjectId: vi.fn() }));
vi.mock('@Core/session/sessionManager.js', () => ({
  sessionManager: { getProjectId: mockGetProjectId },
}));

const { MockServerStorageProvider } = vi.hoisted(() => ({
  MockServerStorageProvider: vi.fn().mockImplementation(function (apiBaseUrl, sessionId) {
    this.apiBaseUrl = apiBaseUrl;
    this.sessionId = sessionId;
    this.initialize = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock('@Core/data/providers/ServerStorageProvider.js', () => ({
  ServerStorageProvider: MockServerStorageProvider,
}));

vi.mock('@Core/data/managers/DatasetManagerAdapter.js', () => ({
  DatasetManagerAdapter: vi.fn().mockImplementation(function () {
    this.initialize = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('@Services/storage/dataCache.js', () => ({
  dataCache: { initialize: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@Utils/logger.js', () => ({
  files: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { initializeStorageProvider, getStorageConfig } from '../storageService.js';

describe('storageService — project id usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectId.mockReturnValue('real-project-id');
  });

  test('initializeStorageProvider() constructs ServerStorageProvider with sessionManager.getProjectId(), not config.defaultSessionId', async () => {
    const { provider, mode } = await initializeStorageProvider();

    expect(mode).toBe('server');
    expect(MockServerStorageProvider).toHaveBeenCalledWith('https://api.test', 'real-project-id');
    expect(provider.sessionId).toBe('real-project-id');
    expect(provider.sessionId).not.toBe('default-session-id');
  });

  test('getStorageConfig() reports sessionManager.getProjectId(), not config.defaultSessionId', () => {
    const result = getStorageConfig();
    expect(result.sessionId).toBe('real-project-id');
    expect(result.sessionId).not.toBe('default-session-id');
  });
});
