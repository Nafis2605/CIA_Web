// src/core/vr/tools/__tests__/VRProbeTool.test.js
// Covers VRProbeTool passing the raycast hit's actor through to
// probeDataVR (Phase 3, item D's follow-on fix): probeDataVR previously
// always read the primary source actor's polydata regardless of what was
// actually hit, so probing a glyph/threshold/isosurface surface silently
// misread the (possibly hidden) source dataset.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@Utils/logger.js", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
  return { vr: mkLog(), app: mkLog(), sync: mkLog(), view: mkLog(), createLogger: () => mkLog() };
});

import { VRProbeTool } from "../VRProbeTool.js";

function makeInputState({ triggerPressed = false, triggerValue = 0 } = {}) {
  return {
    controllers: {
      right: {
        targetRay: { position: { x: 0, y: 0, z: 0 }, matrix: new Array(16).fill(0) },
        triggerPressed,
        triggerValue,
        thumbstick: { x: 0, y: 0 },
        buttons: {},
      },
    },
  };
}

describe("VRProbeTool — actor threading to probeDataVR", () => {
  let tool;
  let raycastVR;
  let probeDataVR;
  const hitActor = { id: "glyph-actor" };

  beforeEach(async () => {
    tool = new VRProbeTool();
    raycastVR = vi.fn(() => ({ position: { x: 1, y: 2, z: 3 }, actor: hitActor }));
    probeDataVR = vi.fn(() => ({ position: [1, 2, 3], pointId: 5, values: {} }));
    await tool.activate({
      handler: { raycastVR, probeDataVR },
      vrContext: {},
    });
  });

  it("passes the raycast hit's actor through to probeDataVR on a single trigger-press probe", () => {
    tool.handleInput(makeInputState({ triggerPressed: true }), {});

    expect(probeDataVR).toHaveBeenCalledWith(
      expect.anything(),
      { x: 1, y: 2, z: 3 },
      hitActor
    );
  });

  it("passes the raycast hit's actor through to probeDataVR in continuous-probe mode", () => {
    tool._continuousMode = true;
    tool.handleInput(makeInputState({ triggerValue: 0.9 }), {});

    expect(probeDataVR).toHaveBeenCalledWith(
      expect.anything(),
      { x: 1, y: 2, z: 3 },
      hitActor
    );
  });

  it("falls back to the fallback probe shape when probeDataVR returns nothing", () => {
    probeDataVR.mockReturnValue(null);
    const action = tool.handleInput(makeInputState({ triggerPressed: true }), {});
    expect(action.data.data.pointId).toBeNull();
  });
});
