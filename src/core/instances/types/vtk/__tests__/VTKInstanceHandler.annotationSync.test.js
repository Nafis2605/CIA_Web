// src/core/instances/types/vtk/__tests__/VTKInstanceHandler.annotationSync.test.js
//
// Covers the wiring that keeps locally-anchored annotation markers glued to
// the data actor through a VR two-hand twist (_applyVRDataRotation) and
// snapped back in sync when VR ends (exitVRExploration) — see
// VTKAnnotationLinesFeature.syncActorTransforms. Spies on the REAL singleton
// (not a full module mock) so the exact call-site wiring in
// VTKInstanceHandler.js is what's under test.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import { vtkAnnotationLinesFeature } from "@VTK/features/VTKAnnotationLinesFeature";
import { VTKInstanceHandler } from "../VTKInstanceHandler.js";

function makeVrContext(actor) {
  return {
    instanceId: "inst-1",
    vrRotation: 0,
    dataCenter: [0, 0, 0],
    sceneObjects: { actor },
  };
}

describe("VTKInstanceHandler — annotation marker transform sync", () => {
  let handler;
  let syncSpy;

  beforeEach(() => {
    handler = new VTKInstanceHandler();
    syncSpy = vi.spyOn(vtkAnnotationLinesFeature, "syncActorTransforms").mockImplementation(() => {});
  });

  afterEach(() => {
    syncSpy.mockRestore();
  });

  it("_applyVRDataRotation syncs annotation transforms on an actual yaw change", () => {
    const actor = vtkActor.newInstance();
    const vrContext = makeVrContext(actor);
    vrContext.vrRotation = Math.PI / 4;

    handler._applyVRDataRotation(vrContext);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith("inst-1");
  });

  it("does NOT re-sync on a frame where the yaw hasn't changed (dirty-check)", () => {
    const actor = vtkActor.newInstance();
    const vrContext = makeVrContext(actor);
    vrContext.vrRotation = Math.PI / 4;

    handler._applyVRDataRotation(vrContext);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    // Same yaw again — dirty-check should skip both the actor matrix update
    // AND the annotation sync.
    handler._applyVRDataRotation(vrContext);
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it("syncs again on a SECOND actual yaw change", () => {
    const actor = vtkActor.newInstance();
    const vrContext = makeVrContext(actor);

    vrContext.vrRotation = Math.PI / 4;
    handler._applyVRDataRotation(vrContext);
    vrContext.vrRotation = Math.PI / 2;
    handler._applyVRDataRotation(vrContext);

    expect(syncSpy).toHaveBeenCalledTimes(2);
  });

  it("exitVRExploration snaps annotation transforms back in sync once, after restoring the actor's original matrix", async () => {
    const actor = vtkActor.newInstance();
    const noop = () => {};
    const vrContext = {
      instanceId: "inst-1",
      originalActorUserMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      originalCameraState: null,
      sceneObjects: {
        actor,
        camera: {},
        renderer: { setViewport: noop },
        renderWindow: { render: noop },
        openGLRenderWindow: {},
        interactor: { returnFromXRAnimation: noop },
      },
    };

    await handler.exitVRExploration(vrContext);

    expect(syncSpy).toHaveBeenCalledWith("inst-1");
  });
});
