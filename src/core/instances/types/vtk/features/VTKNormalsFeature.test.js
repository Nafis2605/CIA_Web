import { describe, it, expect, vi } from "vitest";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { VTKNormalsFeature } from "./VTKNormalsFeature.js";

// Normal-vector arrows are a rendering overlay, not part of the dataset. A
// VR raycast (annotation/measurement/probe) must hit the underlying surface,
// not an arrow glyph — this is only guaranteed if the glyph actor is marked
// unpickable at creation, since VTKInstanceHandler's pick-target filter
// (_getVRPickTargets) relies on actor.getPickable() to exclude overlays.
function makePolydataWithNormals(n = 4) {
  const xyz = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    xyz[i * 3] = i;
    normals[i * 3 + 2] = 1;
  }
  const points = vtkPoints.newInstance();
  points.setData(xyz, 3);
  const pd = vtkPolyData.newInstance();
  pd.setPoints(points);
  pd.getPointData().setNormals(
    vtkDataArray.newInstance({ name: "Normals", numberOfComponents: 3, values: normals })
  );
  return pd;
}

function makeMockSceneObjects(polydata) {
  const actors = [];
  return {
    mapper: { getInputData: () => polydata },
    renderer: { addActor: vi.fn((a) => actors.push(a)), removeActor: vi.fn() },
    renderWindow: { render: vi.fn() },
    _actors: actors,
  };
}

describe("VTKNormalsFeature — glyph actor pickability", () => {
  it("creates the normal-glyph actor as unpickable", async () => {
    const feature = new VTKNormalsFeature();
    const polydata = makePolydataWithNormals();
    const sceneObjects = makeMockSceneObjects(polydata);
    const instanceId = "instance-1";

    await feature.initialize(instanceId, { sceneObjects });
    feature.showNormalGlyphs(instanceId);

    const state = feature.instanceStates.get(instanceId);
    expect(state.glyphActor).toBeTruthy();
    expect(state.glyphActor.getPickable()).toBe(false);
  });
});
