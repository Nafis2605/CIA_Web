// src/core/instances/types/vtk/features/VTKAnnotationLinesFeature.test.js
// Covers: measurement annotation content parsing, live add/remove lifecycle
// via AnnotationManager events, malformed content handling, and cleanup.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakeCtx } from "@/test/fakeCanvas.js";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { render: mkLog(), createLogger: () => mkLog() };
});

const mockApiClient = { get: vi.fn(async () => ({ annotations: [] })) };
vi.mock("@Services/apiClient.js", () => ({
  get apiClient() {
    return mockApiClient;
  },
}));

let mockAnnotationManager = null;
vi.mock("@Init/appInitializer.js", () => ({
  getAnnotationManager: vi.fn(() => mockAnnotationManager),
}));

const mockResolveBuiltInDatasetId = vi.fn();
vi.mock("@Services/builtInDatasets.js", () => ({
  isBuiltInDatasetId: (id) => typeof id === "string" && id.startsWith("builtin-"),
  resolveBuiltInDatasetId: (id) => mockResolveBuiltInDatasetId(id),
}));

import {
  VTKAnnotationLinesFeature,
  parseMeasurementAnnotation,
  parsePointAnnotation,
} from "./VTKAnnotationLinesFeature.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMeasurementAnnotation(overrides = {}) {
  return {
    id: "annot-1",
    type: "measurement",
    metadata: {
      startPoint: [0, 0, 0],
      endPoint: [3, 4, 0],
      distance: 5,
      unit: "mm",
    },
    ...overrides,
  };
}

/** Minimal fake AnnotationManager exposing the BaseManager on()/_emit() shape. */
function makePointAnnotation(overrides = {}) {
  return {
    id: "pt-1",
    type: "point",
    position: [1, 2, 3],
    text: "VR marker",
    metadata: { source: "vr", vrMode: "marker", color: [1, 0, 0] },
    ...overrides,
  };
}

function makeFakeAnnotationManager() {
  const listeners = new Map();
  return {
    on: vi.fn((event, cb) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return () => {
        const arr = listeners.get(event) || [];
        const i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      };
    }),
    _emit(event, data) {
      for (const cb of listeners.get(event) || []) cb(data);
    },
    _listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
}

function makeMockSceneObjects() {
  const actors = [];
  return {
    renderer: {
      addActor: vi.fn((a) => actors.push(a)),
      removeActor: vi.fn((a) => {
        const i = actors.indexOf(a);
        if (i >= 0) actors.splice(i, 1);
      }),
      // VRTextBillboard.faceCamera() reads this; harmless no-op for tests
      // that don't care about facing direction, required for the ones that do.
      getActiveCamera: vi.fn(() => ({ getPosition: () => [0, 0, 10] })),
      _actors: actors,
    },
    renderWindow: { render: vi.fn() },
  };
}

let getContextSpy;

beforeEach(() => {
  mockAnnotationManager = null;
  mockApiClient.get.mockReset().mockResolvedValue({ annotations: [] });
  mockResolveBuiltInDatasetId.mockReset();

  // Labels are now VRTextBillboards (canvas2D -> vtkTexture), and jsdom has
  // no real <canvas> 2D context -- stub it the same way
  // VTKVRSpatialUI.integration.test.js does, via the shared fake.
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => createFakeCtx());
});

afterEach(() => {
  getContextSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// parseMeasurementAnnotation
// ---------------------------------------------------------------------------

describe("parseMeasurementAnnotation", () => {
  it("extracts line endpoints, distance, and unit from a well-formed annotation", () => {
    const parsed = parseMeasurementAnnotation(makeMeasurementAnnotation());
    expect(parsed).toEqual({
      id: "annot-1",
      startPoint: [0, 0, 0],
      endPoint: [3, 4, 0],
      distance: 5,
      unit: "mm",
    });
  });

  it("defaults unit to 'units' when metadata omits it", () => {
    const parsed = parseMeasurementAnnotation(
      makeMeasurementAnnotation({ metadata: { startPoint: [0, 0, 0], endPoint: [1, 0, 0], distance: 1 } })
    );
    expect(parsed.unit).toBe("units");
  });

  it("recomputes distance from points when metadata.distance is missing", () => {
    const parsed = parseMeasurementAnnotation(
      makeMeasurementAnnotation({
        metadata: { startPoint: [0, 0, 0], endPoint: [3, 4, 0] },
      })
    );
    expect(parsed.distance).toBeCloseTo(5);
  });

  it("returns null for a non-measurement annotation type", () => {
    expect(parseMeasurementAnnotation(makeMeasurementAnnotation({ type: "point" }))).toBeNull();
  });

  it("returns null (does not throw) for missing annotation", () => {
    expect(() => parseMeasurementAnnotation(null)).not.toThrow();
    expect(parseMeasurementAnnotation(null)).toBeNull();
    expect(parseMeasurementAnnotation(undefined)).toBeNull();
  });

  it("returns null (does not throw) when metadata is missing entirely", () => {
    const annotation = makeMeasurementAnnotation({ metadata: undefined });
    expect(() => parseMeasurementAnnotation(annotation)).not.toThrow();
    expect(parseMeasurementAnnotation(annotation)).toBeNull();
  });

  it("returns null for malformed points (wrong length, non-numeric, or missing)", () => {
    expect(
      parseMeasurementAnnotation(
        makeMeasurementAnnotation({ metadata: { startPoint: [0, 0], endPoint: [1, 0, 0] } })
      )
    ).toBeNull();
    expect(
      parseMeasurementAnnotation(
        makeMeasurementAnnotation({ metadata: { startPoint: ["a", "b", "c"], endPoint: [1, 0, 0] } })
      )
    ).toBeNull();
    expect(
      parseMeasurementAnnotation(
        makeMeasurementAnnotation({ metadata: { startPoint: [0, 0, 0], endPoint: null } })
      )
    ).toBeNull();
    expect(
      parseMeasurementAnnotation(
        makeMeasurementAnnotation({ metadata: { startPoint: [0, 0, NaN], endPoint: [1, 0, 0] } })
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parsePointAnnotation
// ---------------------------------------------------------------------------

describe("parsePointAnnotation", () => {
  it("extracts id, position, text, and normalized color from a well-formed point annotation", () => {
    const parsed = parsePointAnnotation(makePointAnnotation());
    expect(parsed).toEqual({
      id: "pt-1",
      position: [1, 2, 3],
      localPosition: null,
      pointId: null,
      cellId: null,
      pickActorRole: null,
      text: "VR marker",
      color: [1, 0, 0],
      authorName: null,
    });
  });

  it("extracts authorName from metadata so a persisted pin can say who placed it", () => {
    const parsed = parsePointAnnotation(
      makePointAnnotation({ metadata: { authorName: "Alice" } })
    );
    expect(parsed.authorName).toBe("Alice");
  });

  it("defaults authorName to null for an annotation created before the field existed", () => {
    const parsed = parsePointAnnotation(
      makePointAnnotation({ metadata: { color: [1, 0, 0] } }) // no authorName key at all
    );
    expect(parsed.authorName).toBeNull();
  });

  it("ignores a non-string authorName rather than propagating garbage", () => {
    const parsed = parsePointAnnotation(
      makePointAnnotation({ metadata: { authorName: 42 } })
    );
    expect(parsed.authorName).toBeNull();
  });

  it("normalizes a hex color string to an [r,g,b] array", () => {
    const parsed = parsePointAnnotation(
      makePointAnnotation({ metadata: { color: "#ff0000" } })
    );
    expect(parsed.color[0]).toBeCloseTo(1);
    expect(parsed.color[1]).toBeCloseTo(0);
    expect(parsed.color[2]).toBeCloseTo(0);
  });

  it("returns null color for an unrecognized color value (caller falls back to default)", () => {
    const parsed = parsePointAnnotation(
      makePointAnnotation({ metadata: { color: 42 } })
    );
    expect(parsed.color).toBeNull();
  });

  it("returns null for a non-point annotation type", () => {
    expect(parsePointAnnotation(makePointAnnotation({ type: "measurement" }))).toBeNull();
  });

  it("returns null (does not throw) for missing or malformed position", () => {
    expect(parsePointAnnotation(null)).toBeNull();
    expect(parsePointAnnotation(makePointAnnotation({ position: undefined }))).toBeNull();
    expect(parsePointAnnotation(makePointAnnotation({ position: [1, 2] }))).toBeNull();
    expect(parsePointAnnotation(makePointAnnotation({ position: [1, 2, NaN] }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Feature lifecycle: initialize / load-on-open / live add / live remove / cleanup
// ---------------------------------------------------------------------------

describe("VTKAnnotationLinesFeature lifecycle", () => {
  it("does nothing (no throw) when sceneObjects has no renderer", async () => {
    const feature = new VTKAnnotationLinesFeature();
    await expect(
      feature.initialize("inst-1", { sceneObjects: {}, datasetId: "ds-1" })
    ).resolves.not.toThrow();
    expect(feature.getState("inst-1")).toBeNull();
  });

  it("fetches existing measurement annotations for the dataset on initialize", async () => {
    mockApiClient.get.mockResolvedValue({
      annotations: [makeMeasurementAnnotation({ id: "annot-existing" })],
    });

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    expect(mockApiClient.get).toHaveBeenCalledWith("/annotations?fileId=ds-1");
    expect(sceneObjects.renderer.addActor).toHaveBeenCalled();
    expect(feature.getState("inst-1").measurementCount).toBe(1);

    await feature.cleanup("inst-1");
  });

  it("subscribes to AnnotationManager and adds a line on annotationAdded for the matching dataset", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    expect(sceneObjects.renderer.addActor).not.toHaveBeenCalled();

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation(),
    });

    // Line actor + label actor both added
    expect(sceneObjects.renderer.addActor).toHaveBeenCalled();
    expect(feature.getState("inst-1").measurementCount).toBe(1);
    expect(sceneObjects.renderWindow.render).toHaveBeenCalled();

    await feature.cleanup("inst-1");
  });

  it("ignores annotationAdded events for a different dataset", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-OTHER",
      annotation: makeMeasurementAnnotation(),
    });

    expect(sceneObjects.renderer.addActor).not.toHaveBeenCalled();
    expect(feature.getState("inst-1").measurementCount).toBe(0);

    await feature.cleanup("inst-1");
  });

  it("ignores malformed measurement content on annotationAdded without throwing", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    expect(() =>
      mockAnnotationManager._emit("annotationAdded", {
        datasetId: "ds-1",
        annotation: { id: "bad-1", type: "measurement", metadata: { startPoint: [1] } },
      })
    ).not.toThrow();

    expect(sceneObjects.renderer.addActor).not.toHaveBeenCalled();
    expect(feature.getState("inst-1").measurementCount).toBe(0);

    await feature.cleanup("inst-1");
  });

  it("removes the line actor on annotationRemoved for the matching dataset", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "annot-1" }),
    });
    expect(feature.getState("inst-1").measurementCount).toBe(1);
    expect(sceneObjects.renderer._actors.length).toBeGreaterThan(0);

    mockAnnotationManager._emit("annotationRemoved", {
      datasetId: "ds-1",
      annotationId: "annot-1",
    });

    expect(feature.getState("inst-1").measurementCount).toBe(0);
    expect(sceneObjects.renderer._actors.length).toBe(0);

    await feature.cleanup("inst-1");
  });

  it("ignores annotationRemoved events for a different dataset", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "annot-1" }),
    });
    expect(feature.getState("inst-1").measurementCount).toBe(1);

    mockAnnotationManager._emit("annotationRemoved", {
      datasetId: "ds-OTHER",
      annotationId: "annot-1",
    });

    expect(feature.getState("inst-1").measurementCount).toBe(1);

    await feature.cleanup("inst-1");
  });

  it("unsubscribes from AnnotationManager and removes all actors on cleanup", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "annot-1" }),
    });
    expect(sceneObjects.renderer._actors.length).toBeGreaterThan(0);
    expect(mockAnnotationManager._listenerCount("annotationAdded")).toBe(1);

    await feature.cleanup("inst-1");

    expect(sceneObjects.renderer._actors.length).toBe(0);
    expect(mockAnnotationManager._listenerCount("annotationAdded")).toBe(0);
    expect(feature.getState("inst-1")).toBeNull();

    // Events after cleanup must not resurrect actors or throw
    expect(() =>
      mockAnnotationManager._emit("annotationAdded", {
        datasetId: "ds-1",
        annotation: makeMeasurementAnnotation({ id: "annot-2" }),
      })
    ).not.toThrow();
    expect(sceneObjects.renderer._actors.length).toBe(0);
  });

  it("renders a sphere marker on annotationAdded for a point annotation and removes it on annotationRemoved", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-1" }),
    });

    expect(sceneObjects.renderer.addActor).toHaveBeenCalled();
    expect(feature.getState("inst-1").pointCount).toBe(1);
    expect(feature.getState("inst-1").measurementCount).toBe(0);

    mockAnnotationManager._emit("annotationRemoved", {
      datasetId: "ds-1",
      annotationId: "pt-1",
    });

    expect(feature.getState("inst-1").pointCount).toBe(0);
    expect(sceneObjects.renderer._actors.length).toBe(0);

    await feature.cleanup("inst-1");
  });

  it("renders both measurement lines and point markers from the initial fetch", async () => {
    mockApiClient.get.mockResolvedValue({
      annotations: [
        makeMeasurementAnnotation({ id: "m-1" }),
        makePointAnnotation({ id: "pt-1" }),
        { id: "note-1", type: "text", position: [0, 0, 0] }, // non-renderable type skipped
      ],
    });

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    const state = feature.getState("inst-1");
    expect(state.measurementCount).toBe(1);
    expect(state.pointCount).toBe(1);

    await feature.cleanup("inst-1");
  });

  it("ignores malformed point content on annotationAdded without throwing", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    expect(() =>
      mockAnnotationManager._emit("annotationAdded", {
        datasetId: "ds-1",
        annotation: { id: "bad-pt", type: "point", position: [1] },
      })
    ).not.toThrow();

    expect(feature.getState("inst-1").pointCount).toBe(0);

    await feature.cleanup("inst-1");
  });

  it("cleanup removes point markers along with lines", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-1" }),
    });
    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "m-1" }),
    });
    expect(sceneObjects.renderer._actors.length).toBeGreaterThan(1);

    await feature.cleanup("inst-1");

    expect(sceneObjects.renderer._actors.length).toBe(0);
    expect(feature.getState("inst-1")).toBeNull();
  });

  it("re-initializing the same instance does not leak actors from the prior initialize()", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();
    mockApiClient.get.mockResolvedValue({
      annotations: [makeMeasurementAnnotation({ id: "annot-1" })],
    });

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();

    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });
    const firstCount = sceneObjects.renderer._actors.length;
    expect(firstCount).toBeGreaterThan(0);

    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    // Same annotation set re-fetched; actor count should not have doubled
    expect(sceneObjects.renderer._actors.length).toBe(firstCount);

    await feature.cleanup("inst-1");
  });

  it("clears all lines and refetches when the dataset scope changes via setDatasetId", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();
    mockApiClient.get.mockResolvedValueOnce({ annotations: [] });

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "annot-1" }),
    });
    expect(feature.getState("inst-1").measurementCount).toBe(1);

    mockApiClient.get.mockResolvedValueOnce({
      annotations: [makeMeasurementAnnotation({ id: "annot-ds2" })],
    });
    await feature.setDatasetId("inst-1", "ds-2");

    expect(feature.getState("inst-1").datasetId).toBe("ds-2");
    expect(feature.getState("inst-1").measurementCount).toBe(1);

    // The ds-1 annotation must no longer be tracked
    mockAnnotationManager._emit("annotationRemoved", {
      datasetId: "ds-1",
      annotationId: "annot-1",
    });
    expect(feature.getState("inst-1").measurementCount).toBe(1);

    await feature.cleanup("inst-1");
  });
});

// ---------------------------------------------------------------------------
// Pickability: persisted annotations must never absorb a raycast (see
// VTKInstanceHandler._getVRPickTargets, which filters renderer.getActors()
// on getPickable() && getVisibility() && getMapper()).
// ---------------------------------------------------------------------------

describe("VTKAnnotationLinesFeature actor pickability", () => {
  it("marks the line actor and its label billboard unpickable", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "annot-1" }),
    });

    const entry = feature.instanceStates.get("inst-1").lines.get("annot-1");
    expect(entry.actor.getPickable()).toBe(false);
    expect(entry.labelBillboard.getActor().getPickable()).toBe(false);

    await feature.cleanup("inst-1");
  });

  it("marks the point actor and its label billboard unpickable", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-1", text: "Anomaly here" }),
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-1");
    expect(entry.actor.getPickable()).toBe(false);
    expect(entry.labelBillboard.getActor().getPickable()).toBe(false);

    await feature.cleanup("inst-1");
  });
});

// ---------------------------------------------------------------------------
// Label text: vtkVectorText silently rendered nothing (no opentype.js font
// is ever supplied). Labels are now VRTextBillboard -- assert the stored
// entry exposes a real, text-bearing billboard rather than an empty
// vtkVectorText source/mapper/actor trio.
// ---------------------------------------------------------------------------

describe("VTKAnnotationLinesFeature label billboards", () => {
  it("renders the measurement distance as billboard text", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "annot-1" }),
    });

    const entry = feature.instanceStates.get("inst-1").lines.get("annot-1");
    expect(entry.labelBillboard).toBeTruthy();
    expect(typeof entry.labelBillboard.getText).toBe("function");
    expect(entry.labelBillboard.getText()).toBe("5.000 mm");
    // The old vtkVectorText trio no longer exists on the entry.
    expect(entry.labelSource).toBeUndefined();
    expect(entry.labelActor).toBeUndefined();
    expect(entry.labelMapper).toBeUndefined();

    await feature.cleanup("inst-1");
  });

  it("renders custom point annotation text as billboard text", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-1", text: "Anomaly here" }),
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-1");
    expect(entry.labelBillboard).toBeTruthy();
    expect(entry.labelBillboard.getText()).toBe("Anomaly here");

    await feature.cleanup("inst-1");
  });

  it("appends the author's name to the billboard text so OTHER participants see who placed it", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({
        id: "pt-1",
        text: "Anomaly here",
        metadata: { authorName: "Bob" },
      }),
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-1");
    expect(entry.labelBillboard.getText()).toBe("Anomaly here — Bob");

    await feature.cleanup("inst-1");
  });

  it("omits the author suffix when the pin carries no authorName (pre-existing annotations)", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-1", text: "Anomaly here" }),
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-1");
    expect(entry.labelBillboard.getText()).toBe("Anomaly here");

    await feature.cleanup("inst-1");
  });

  it("skips the label billboard for the default 'VR marker' placeholder text", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-1" }), // default text: "VR marker"
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-1");
    expect(entry.labelBillboard).toBeNull();

    await feature.cleanup("inst-1");
  });

  it("disposes the label billboard (and removes its actor) when the annotation is removed", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeMeasurementAnnotation({ id: "annot-1" }),
    });

    const entry = feature.instanceStates.get("inst-1").lines.get("annot-1");
    const labelActor = entry.labelBillboard.getActor();
    expect(sceneObjects.renderer._actors).toContain(labelActor);

    mockAnnotationManager._emit("annotationRemoved", {
      datasetId: "ds-1",
      annotationId: "annot-1",
    });

    // A leaked billboard actor would stay in the shared renderer forever --
    // both the line's geometry actor AND its label billboard must be gone.
    expect(sceneObjects.renderer._actors).not.toContain(labelActor);
    expect(sceneObjects.renderer._actors.length).toBe(0);

    await feature.cleanup("inst-1");
  });

  it("disposes point label billboards on cleanup, along with everything else", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-1", text: "Anomaly here" }),
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-1");
    const labelActor = entry.labelBillboard.getActor();
    expect(sceneObjects.renderer._actors).toContain(labelActor);

    await feature.cleanup("inst-1");

    expect(sceneObjects.renderer._actors).not.toContain(labelActor);
    expect(sceneObjects.renderer._actors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _computePointRadius: must derive from the DATA actor's bounds, not the
// renderer's -- in VR, computeVisiblePropBounds() also includes VR chrome
// (spatial menu, keyboard panel) placed in data space, which would
// otherwise inflate every marker.
// ---------------------------------------------------------------------------

describe("VTKAnnotationLinesFeature _computePointRadius", () => {
  function makeState({ actorBounds, rendererBounds } = {}) {
    return {
      pointRadiusFraction: 0.01,
      pointRadiusFallback: 0.05,
      sceneObjects: {
        actor: actorBounds ? { getBounds: vi.fn(() => actorBounds) } : undefined,
        renderer: {
          computeVisiblePropBounds: rendererBounds
            ? vi.fn(() => rendererBounds)
            : vi.fn(() => undefined),
        },
      },
    };
  }

  it("uses the data actor's bounds, not the renderer's (which include VR chrome)", () => {
    const feature = new VTKAnnotationLinesFeature();
    // Actor: 10-unit diagonal. Renderer (inflated by VR menu/keyboard panels
    // placed in data space): 100-unit diagonal. If the fix regressed to
    // renderer bounds, this radius would come out 10x too large.
    const state = makeState({
      actorBounds: [0, 10, 0, 0, 0, 0],
      rendererBounds: [0, 100, 0, 0, 0, 0],
    });

    const radius = feature._computePointRadius(state);

    expect(radius).toBeCloseTo(10 * 0.01);
  });

  it("falls back to renderer bounds when there is no data actor", () => {
    const feature = new VTKAnnotationLinesFeature();
    const state = makeState({ rendererBounds: [0, 100, 0, 0, 0, 0] });

    const radius = feature._computePointRadius(state);

    expect(radius).toBeCloseTo(100 * 0.01);
  });

  it("falls back to renderer bounds when the actor has no getBounds()", () => {
    const feature = new VTKAnnotationLinesFeature();
    const state = makeState({ rendererBounds: [0, 100, 0, 0, 0, 0] });
    state.sceneObjects.actor = {}; // no getBounds function

    const radius = feature._computePointRadius(state);

    expect(radius).toBeCloseTo(100 * 0.01);
  });

  it("falls back to the fixed default when neither bounds source is available", () => {
    const feature = new VTKAnnotationLinesFeature();
    const state = makeState();

    expect(feature._computePointRadius(state)).toBe(0.05);
  });

  it("never throws, even if the actor's getBounds() itself throws", () => {
    const feature = new VTKAnnotationLinesFeature();
    const state = makeState({ rendererBounds: [0, 100, 0, 0, 0, 0] });
    state.sceneObjects.actor = {
      getBounds: () => {
        throw new Error("boom");
      },
    };

    expect(() => feature._computePointRadius(state)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Built-in dataset id resolution: instanceData.datasetId carries the local
// manifest key (e.g. "builtin-lungs") for built-in datasets, but
// AnnotationManager's events and the /annotations REST endpoint key on the
// dataset's real server UUID. Without resolving up front, live events never
// match state.datasetId and the initial fetch sends the wrong id.
// ---------------------------------------------------------------------------

describe("VTKAnnotationLinesFeature built-in dataset id resolution", () => {
  it("resolves a built-in datasetId to its server UUID before the initial fetch", async () => {
    mockResolveBuiltInDatasetId.mockResolvedValue("server-uuid-lungs");
    mockApiClient.get.mockResolvedValue({ annotations: [] });

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "builtin-lungs" });

    expect(mockResolveBuiltInDatasetId).toHaveBeenCalledWith("builtin-lungs");
    expect(mockApiClient.get).toHaveBeenCalledWith("/annotations?fileId=server-uuid-lungs");
    expect(feature.getState("inst-1").datasetId).toBe("server-uuid-lungs");

    await feature.cleanup("inst-1");
  });

  it("does not filter out a live event carrying the resolved UUID as datasetId", async () => {
    mockResolveBuiltInDatasetId.mockResolvedValue("server-uuid-lungs");
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "builtin-lungs" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "server-uuid-lungs",
      annotation: makeMeasurementAnnotation(),
    });

    expect(feature.getState("inst-1").measurementCount).toBe(1);

    await feature.cleanup("inst-1");
  });

  it("falls back to the raw local key when resolution fails, rather than nulling the scope out", async () => {
    mockResolveBuiltInDatasetId.mockResolvedValue(null);
    mockApiClient.get.mockResolvedValue({ annotations: [] });

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "builtin-lungs" });

    expect(feature.getState("inst-1").datasetId).toBe("builtin-lungs");
    expect(mockApiClient.get).toHaveBeenCalledWith("/annotations?fileId=builtin-lungs");

    await feature.cleanup("inst-1");
  });

  it("resolves a built-in datasetId in setDatasetId too", async () => {
    mockResolveBuiltInDatasetId.mockResolvedValue("server-uuid-bones");
    mockApiClient.get.mockResolvedValue({ annotations: [] });

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    await feature.setDatasetId("inst-1", "builtin-bones");

    expect(mockResolveBuiltInDatasetId).toHaveBeenCalledWith("builtin-bones");
    expect(feature.getState("inst-1").datasetId).toBe("server-uuid-bones");

    await feature.cleanup("inst-1");
  });

  it("does not resolve (and does not call the service) for a non-built-in datasetId", async () => {
    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjects();
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    expect(mockResolveBuiltInDatasetId).not.toHaveBeenCalled();
    expect(feature.getState("inst-1").datasetId).toBe("ds-1");

    await feature.cleanup("inst-1");
  });
});

// ---------------------------------------------------------------------------
// Actor-parenting: a point annotation with a recoverable local-space point
// (metadata.localPosition) gets its marker actor's UserMatrix set to the
// data actor's CURRENT matrix, so it stays glued to the mesh when that actor
// is later rotated/translated/scaled (VR two-hand twist) instead of staying
// pinned at a world position baked in at pick time. Annotations without a
// recoverable local point (glyph/derived-actor picks, legacy annotations)
// render exactly as before — world-space center, never re-anchored.
// ---------------------------------------------------------------------------

describe("VTKAnnotationLinesFeature actor-parenting", () => {
  function makeMockSceneObjectsWithActor(matrix) {
    const sceneObjects = makeMockSceneObjects();
    const dataActor = vtkActor.newInstance();
    dataActor.setUserMatrix(matrix);
    sceneObjects.actor = dataActor;
    return sceneObjects;
  }

  const MATRIX_A = [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // translate +5 X
  const MATRIX_B = [1, 0, 0, 0, 0, 1, 0, 9, 0, 0, 1, 0, 0, 0, 0, 1]; // translate +9 Y

  function makeAnchoredPointAnnotation(overrides = {}) {
    return makePointAnnotation({
      id: "pt-anchored",
      metadata: {
        source: "vr",
        color: [1, 0, 0],
        pointId: 3,
        cellId: 7,
        pickActorRole: "source",
        localPosition: [0.1, 0.2, 0.3],
      },
      ...overrides,
    });
  }

  it("sets the marker actor's UserMatrix to the data actor's current matrix at creation", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjectsWithActor(MATRIX_A);
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeAnchoredPointAnnotation(),
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-anchored");
    expect(entry.anchored).toBe(true);
    expect(entry.actor.getMatrix()).toEqual(sceneObjects.actor.getMatrix());

    await feature.cleanup("inst-1");
  });

  it("syncActorTransforms re-applies a NEW data-actor matrix to anchored markers only", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjectsWithActor(MATRIX_A);
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makeAnchoredPointAnnotation(),
    });
    // A non-anchored marker (no localPosition) — must be left untouched.
    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-unanchored" }),
    });

    // getMatrix() returns a live internal array that vtk.js mutates in
    // place on the next recompute — snapshot a COPY, or "before" would
    // silently become "after" once the actor's matrix changes underneath it.
    const anchoredBefore = Array.from(
      feature.instanceStates.get("inst-1").points.get("pt-anchored").actor.getMatrix()
    );
    const unanchoredBefore = Array.from(
      feature.instanceStates.get("inst-1").points.get("pt-unanchored").actor.getMatrix()
    );

    sceneObjects.actor.setUserMatrix(MATRIX_B);
    feature.syncActorTransforms("inst-1");

    const anchoredEntry = feature.instanceStates.get("inst-1").points.get("pt-anchored");
    const unanchoredEntry = feature.instanceStates.get("inst-1").points.get("pt-unanchored");
    expect(Array.from(anchoredEntry.actor.getMatrix())).toEqual(Array.from(sceneObjects.actor.getMatrix()));
    expect(Array.from(anchoredEntry.actor.getMatrix())).not.toEqual(anchoredBefore);
    // Non-anchored marker's transform is untouched by the sync call.
    expect(Array.from(unanchoredEntry.actor.getMatrix())).toEqual(unanchoredBefore);

    await feature.cleanup("inst-1");
  });

  it("syncActorTransforms is a no-op (no throw) for an unknown instance or a data actor with no getMatrix", async () => {
    const feature = new VTKAnnotationLinesFeature();
    expect(() => feature.syncActorTransforms("no-such-instance")).not.toThrow();

    mockAnnotationManager = makeFakeAnnotationManager();
    const sceneObjects = makeMockSceneObjects(); // no `actor` at all
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });
    expect(() => feature.syncActorTransforms("inst-1")).not.toThrow();

    await feature.cleanup("inst-1");
  });

  it("renders exactly as before (world-space center, never anchored) for an annotation with no recoverable local position", async () => {
    mockAnnotationManager = makeFakeAnnotationManager();

    const feature = new VTKAnnotationLinesFeature();
    const sceneObjects = makeMockSceneObjectsWithActor(MATRIX_A);
    await feature.initialize("inst-1", { sceneObjects, datasetId: "ds-1" });

    mockAnnotationManager._emit("annotationAdded", {
      datasetId: "ds-1",
      annotation: makePointAnnotation({ id: "pt-legacy" }), // no metadata.localPosition
    });

    const entry = feature.instanceStates.get("inst-1").points.get("pt-legacy");
    expect(entry.anchored).toBe(false);
    expect(entry.sphereSource.getCenter()).toEqual([1, 2, 3]); // world position, per makePointAnnotation
    // Regression guard: setUserMatrix was never called on this actor, so its
    // matrix stays plain identity, NOT the data actor's matrix.
    expect(entry.actor.getMatrix()).not.toEqual(sceneObjects.actor.getMatrix());

    await feature.cleanup("inst-1");
  });
});
