// src/services/__tests__/visualizationSyncService.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('@Init/appInitializer.js', () => ({
  getViewConfigurationManager: vi.fn(),
}));

vi.mock('@Collaboration/yjs/yjsSetup.js', () => ({
  syncCameraToYjs: vi.fn(),
  syncVisualizationToYjs: vi.fn(),
}));

vi.mock('@Collaboration/presence/userManagement.js', () => ({
  getUserId: vi.fn().mockReturnValue('user-1'),
}));

vi.mock('@Core/data/managers/WorkspaceManager.js', () => ({
  workspaceManager: { getActiveWorkspace: vi.fn() },
}));

vi.mock('@Services/permissionService.js', () => ({
  permissionService: {
    getCachedRole: vi.fn(),
    fetchWorkspaceRole: vi.fn().mockResolvedValue('editor'),
    hasPermission: vi.fn(),
  },
  PERMISSIONS: { VIEW_MODIFY_CONFIGURATION: 'view:modify_configuration' },
}));

import { getViewConfigurationManager } from '@Init/appInitializer.js';
import { syncCameraToYjs, syncVisualizationToYjs } from '@Collaboration/yjs/yjsSetup.js';
import { workspaceManager } from '@Core/data/managers/WorkspaceManager.js';
import { permissionService } from '@Services/permissionService.js';
import {
  pushSharedCameraUpdate,
  pushSharedVisualizationUpdate,
  pushSharedWidgetToggle,
  resolveActiveWorkspaceId,
  canModifyActiveView,
  resolveShareMode,
  getPermissionDeniedReason,
} from '../visualizationSyncService.js';

function mockActiveWorkspace(id) {
  workspaceManager.getActiveWorkspace.mockReturnValue(
    id ? { getEffectiveId: () => id } : null
  );
}

describe('visualizationSyncService', () => {
  let mockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager = {
      updateCamera: vi.fn(),
      updateVisualization: vi.fn(),
      getView: vi.fn(),
      updateWidget: vi.fn(),
      addWidget: vi.fn(),
    };
    getViewConfigurationManager.mockReturnValue(mockManager);
  });

  describe('resolveActiveWorkspaceId', () => {
    test('returns the active workspace id', () => {
      mockActiveWorkspace('ws-1');
      expect(resolveActiveWorkspaceId()).toBe('ws-1');
    });

    test('returns null when no workspace is active', () => {
      mockActiveWorkspace(null);
      expect(resolveActiveWorkspaceId()).toBeNull();
    });
  });

  describe('share mode', () => {
    // No workspace is not a denial — there is no role to deny. Treating it as
    // one is what silently broke every locally-loaded VTP: VR was refused and
    // told the user their *role* was read-only, for a role that did not exist,
    // while the desktop tools (which bypassed this gate entirely) synced fine.
    test('no workspace resolves to ephemeral, not blocked', () => {
      mockActiveWorkspace(null);
      expect(resolveShareMode()).toBe('ephemeral');
      expect(canModifyActiveView()).toBe(true);
      expect(getPermissionDeniedReason()).toBeNull();
    });

    test('workspace + permission resolves to full', () => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('editor');
      permissionService.hasPermission.mockReturnValue(true);

      expect(resolveShareMode()).toBe('full');
      expect(getPermissionDeniedReason()).toBeNull();
    });

    // The role check stays exactly as strict as before whenever a workspace
    // DOES exist.
    test('workspace + denied role resolves to blocked', () => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('viewer');
      permissionService.hasPermission.mockReturnValue(false);

      expect(resolveShareMode()).toBe('blocked');
      expect(canModifyActiveView()).toBe(false);
      expect(getPermissionDeniedReason()).toBe('View is read-only for your role');
    });
  });

  describe('ephemeral mode (no active workspace)', () => {
    // Distinct view ids per test: the Y.js send throttle keys its leading-edge
    // state by viewId and is module-level, so reusing 'view-1' here would defer
    // the first send of the tests further down into a timer.
    beforeEach(() => {
      mockActiveWorkspace(null);
    });

    test('visualization transmits over Y.js but skips the durable persist', () => {
      const result = pushSharedVisualizationUpdate('view-eph-viz', { opacity: 0.5 }, 'dataset-1');

      expect(syncVisualizationToYjs).toHaveBeenCalledWith(
        'view-eph-viz', 'user-1', { opacity: 0.5 }, 'dataset-1'
      );
      expect(mockManager.updateVisualization).not.toHaveBeenCalled();
      // transmitted:true is what stops callers reporting a working sync as a
      // failure — VR flashes a "not shared" notice on !persisted alone.
      expect(result).toEqual({
        persisted: false,
        transmitted: true,
        reason: 'no-active-workspace',
      });
    });

    test('camera transmits over Y.js but skips the durable persist', () => {
      const result = pushSharedCameraUpdate('view-eph-cam', { position: [0, 0, 5] }, 'dataset-1');

      expect(syncCameraToYjs).toHaveBeenCalledWith(
        'view-eph-cam', 'user-1', { position: [0, 0, 5] }, 'dataset-1'
      );
      expect(mockManager.updateCamera).not.toHaveBeenCalled();
      expect(result.transmitted).toBe(true);
    });
  });

  describe('permission gating', () => {
    test('canModifyActiveView reflects permissionService.hasPermission', () => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('editor');
      permissionService.hasPermission.mockReturnValue(true);

      expect(canModifyActiveView()).toBe(true);
      expect(permissionService.hasPermission).toHaveBeenCalledWith('ws-1', 'view:modify_configuration');
    });

    test('kicks off a background role fetch when nothing is cached yet', () => {
      mockActiveWorkspace('ws-2');
      permissionService.getCachedRole.mockReturnValue(null);
      permissionService.hasPermission.mockReturnValue(false);

      canModifyActiveView();

      expect(permissionService.fetchWorkspaceRole).toHaveBeenCalledWith('ws-2');
    });
  });

  describe('pushSharedCameraUpdate', () => {
    test('pushes to Y.js and the manager when permitted', () => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('editor');
      permissionService.hasPermission.mockReturnValue(true);

      const result = pushSharedCameraUpdate('view-1', { position: [0, 0, 5] });

      expect(syncCameraToYjs).toHaveBeenCalledWith('view-1', 'user-1', { position: [0, 0, 5] }, null);
      expect(mockManager.updateCamera).toHaveBeenCalledWith('view-1', { position: [0, 0, 5] });
      expect(result).toEqual({ persisted: true });
    });

    test('does not push when permission is denied', () => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('viewer');
      permissionService.hasPermission.mockReturnValue(false);

      const result = pushSharedCameraUpdate('view-1', { position: [0, 0, 5] });

      expect(syncCameraToYjs).not.toHaveBeenCalled();
      expect(mockManager.updateCamera).not.toHaveBeenCalled();
      expect(result).toEqual({ persisted: false, reason: 'permission-denied' });
    });

    test('no-ops when there is no active view', () => {
      const result = pushSharedCameraUpdate(null, { position: [0, 0, 5] });
      expect(result).toEqual({ persisted: false, reason: 'no-active-view' });
      expect(syncCameraToYjs).not.toHaveBeenCalled();
    });
  });

  describe('pushSharedVisualizationUpdate', () => {
    test('pushes to Y.js and the manager when permitted', () => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('editor');
      permissionService.hasPermission.mockReturnValue(true);

      const result = pushSharedVisualizationUpdate('view-1', { opacity: 0.5 });

      expect(syncVisualizationToYjs).toHaveBeenCalledWith('view-1', 'user-1', { opacity: 0.5 }, null);
      expect(mockManager.updateVisualization).toHaveBeenCalledWith('view-1', { opacity: 0.5 });
      expect(result).toEqual({ persisted: true });
    });

    test('does not push when permission is denied', () => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('viewer');
      permissionService.hasPermission.mockReturnValue(false);

      const result = pushSharedVisualizationUpdate('view-1', { opacity: 0.5 });

      expect(syncVisualizationToYjs).not.toHaveBeenCalled();
      expect(mockManager.updateVisualization).not.toHaveBeenCalled();
      expect(result.persisted).toBe(false);
    });
  });

  describe('pushSharedWidgetToggle', () => {
    beforeEach(() => {
      mockActiveWorkspace('ws-1');
      permissionService.getCachedRole.mockReturnValue('editor');
      permissionService.hasPermission.mockReturnValue(true);
    });

    test('calls updateWidget when a widget of that type already exists', () => {
      mockManager.getView.mockReturnValue({
        widgets: [{ id: 'w1', type: 'line', active: false }],
      });

      pushSharedWidgetToggle('view-1', 'line', true);

      expect(mockManager.updateWidget).toHaveBeenCalledWith('view-1', 'w1', { active: true });
      expect(mockManager.addWidget).not.toHaveBeenCalled();
    });

    test('calls addWidget when no widget of that type exists yet', () => {
      mockManager.getView.mockReturnValue({ widgets: [] });

      pushSharedWidgetToggle('view-1', 'angle', true);

      expect(mockManager.addWidget).toHaveBeenCalledWith('view-1', { type: 'angle', active: true });
      expect(mockManager.updateWidget).not.toHaveBeenCalled();
    });

    test('does not push when permission is denied', () => {
      permissionService.hasPermission.mockReturnValue(false);

      pushSharedWidgetToggle('view-1', 'plane', true);

      expect(mockManager.getView).not.toHaveBeenCalled();
      expect(mockManager.addWidget).not.toHaveBeenCalled();
      expect(mockManager.updateWidget).not.toHaveBeenCalled();
    });
  });
});
