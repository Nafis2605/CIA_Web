// src/core/vr/__tests__/VRExplorationManager.pickBroadcast.test.js
// _pickPointerHit/_computePointerRay carry the full pick identity
// (pointId/cellId/datasetId/actorRole), not just a bare {x,y,z} position —
// this is what rides into VRParticipantSync.updateLocalState so a
// collaborator's remote-avatar hit marker can show not just WHERE a
// participant is pointing but WHAT they've hit (see VRParticipantSync.js's
// _serializePick and SimpleAvatarFallback.js's actorRole tint).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

vi.mock("@Core/vr/VRManager.js", () => ({
  vrManager: { isVRSupported: vi.fn(() => false), on: vi.fn(), off: vi.fn() },
}));

vi.mock("@Core/data/models/VRExplorationSession.js", () => ({
  VRExplorationSession: class {},
  PARTICIPATION_MODE: { VR_EXPLORER: "vr-explorer", DESKTOP_OBSERVER: "desktop-observer" },
  SESSION_STATUS: { ACTIVE: "active" },
}));

vi.mock("@Core/vr/VRParticipantSync.js", () => ({ VRParticipantSync: class {} }));
vi.mock("@Core/vr/tools/VRToolManager.js", () => ({ VRToolManager: class {} }));
vi.mock("@Core/vr/VRSnapshotManager.js", () => ({ VRSnapshotManager: class {} }));
vi.mock("@Core/vr/VRControlManager.js", () => ({ VRControlManager: class {} }));
vi.mock("@Core/vr/navigation/VRNavigationController.js", () => ({
  VRNavigationController: class {},
}));
vi.mock("@Core/instances/workspaceManager.js", () => ({
  workspaceManager: { getInstance: vi.fn() },
}));
vi.mock("@Init/appInitializer.js", () => ({
  getViewConfigurationManager: vi.fn(),
}));
vi.mock("@Collaboration/presence/userManagement.js", () => ({
  getUserId: vi.fn(() => "user-1"),
  getUserName: vi.fn(() => "Tester"),
  getUserColor: vi.fn(() => "#ff0000"),
  getParticipantId: vi.fn(() => "user-1"),
  getParticipantName: vi.fn(() => "Tester"),
  isSelfIdentity: vi.fn((id) => id === "user-1"),
}));
vi.mock("@Core/instances/types/vtk/vr/VTKVRAvatars.js", () => ({
  vrAvatarSystem: { initialize: vi.fn() },
}));

import { vrExplorationManager } from "../VRExplorationManager.js";

function makeController() {
  return { targetRay: { position: { x: 0, y: 0, z: 0 }, matrix: new Array(16).fill(0) } };
}

describe("VRExplorationManager — pick broadcast identity fields", () => {
  beforeEach(() => {
    vrExplorationManager._lastPointerHit = null;
  });

  it("_pickPointerHit carries pointId/cellId/datasetId/actorRole alongside position", () => {
    const raycastVR = vi.fn(() => ({
      hit: true,
      position: { x: 1, y: 2, z: 3 },
      pointId: 42,
      cellId: 7,
      datasetId: "ds-1",
      actorRole: "source",
    }));
    vrExplorationManager._activeContext = { handler: { raycastVR } };

    const pick = vrExplorationManager._pickPointerHit(makeController(), {}, false);

    expect(pick).toEqual({
      position: { x: 1, y: 2, z: 3 },
      pointId: 42,
      cellId: 7,
      datasetId: "ds-1",
      actorRole: "source",
    });
  });

  it("defaults pointId/cellId to -1 and datasetId/actorRole to null when raycastVR omits them", () => {
    const raycastVR = vi.fn(() => ({ hit: true, position: { x: 1, y: 2, z: 3 } }));
    vrExplorationManager._activeContext = { handler: { raycastVR } };

    const pick = vrExplorationManager._pickPointerHit(makeController(), {}, false);

    expect(pick).toEqual({
      position: { x: 1, y: 2, z: 3 },
      pointId: -1,
      cellId: -1,
      datasetId: null,
      actorRole: null,
    });
  });

  it("returns null (not a stale cached pick) on an actual miss", () => {
    const raycastVR = vi.fn(() => null);
    vrExplorationManager._activeContext = { handler: { raycastVR } };

    expect(vrExplorationManager._pickPointerHit(makeController(), {}, false)).toBeNull();
  });

  it("_computePointerRay's hit field is the same rich pick object", () => {
    const raycastVR = vi.fn(() => ({
      hit: true,
      position: { x: 1, y: 2, z: 3 },
      pointId: 5,
      cellId: 2,
      datasetId: "ds-2",
      actorRole: "glyph",
    }));
    vrExplorationManager._activeContext = { handler: { raycastVR } };

    const inputState = {
      controllers: {
        right: {
          pose: { position: { x: 0, y: 1, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          targetRay: { position: { x: 0, y: 1, z: 0 }, matrix: new Array(16).fill(0) },
        },
      },
    };

    const ray = vrExplorationManager._computePointerRay(inputState, {}, {});
    expect(ray.hit).toEqual({
      position: { x: 1, y: 2, z: 3 },
      pointId: 5,
      cellId: 2,
      datasetId: "ds-2",
      actorRole: "glyph",
    });
  });
});
