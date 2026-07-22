// src/core/vr/tools/__tests__/vrPlaneMath.test.js
import { describe, it, expect } from "vitest";

import {
  rotateVectorByQuaternion,
  controllerForward,
  mapXRPointToData,
  quantizeNormalToAxis,
  yawRotateVector,
  buildYawPivotMatrix,
} from "../vrPlaneMath.js";

/** Apply a flat column-major 4x4 matrix (gl-matrix layout) to a point. */
function applyMat4(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };
const Y90_Q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
const X90_Q = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };

describe("rotateVectorByQuaternion", () => {
  it("identity returns the input", () => {
    expect(rotateVectorByQuaternion([1, 2, 3], IDENTITY_Q)).toEqual([1, 2, 3]);
  });

  it("90° about Y sends -Z to -X", () => {
    const [x, y, z] = rotateVectorByQuaternion([0, 0, -1], Y90_Q);
    expect(x).toBeCloseTo(-1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it("90° about X sends +Y to +Z", () => {
    const [x, y, z] = rotateVectorByQuaternion([0, 1, 0], X90_Q);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it("normalizes non-unit quaternions", () => {
    const doubled = { x: 0, y: Math.SQRT1_2 * 2, z: 0, w: Math.SQRT1_2 * 2 };
    const [x, , z] = rotateVectorByQuaternion([0, 0, -1], doubled);
    expect(x).toBeCloseTo(-1);
    expect(z).toBeCloseTo(0);
  });

  it("treats a near-zero quaternion as identity", () => {
    expect(
      rotateVectorByQuaternion([1, 0, 0], { x: 0, y: 0, z: 0, w: 0 })
    ).toEqual([1, 0, 0]);
    expect(rotateVectorByQuaternion([1, 0, 0], null)).toEqual([1, 0, 0]);
  });
});

describe("controllerForward", () => {
  it("identity orientation points down -Z", () => {
    const [x, y, z] = controllerForward(IDENTITY_Q);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
  });
});

describe("yawRotateVector", () => {
  it("theta 0 returns the input", () => {
    expect(yawRotateVector([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  it("leaves the Y component untouched", () => {
    const [, y] = yawRotateVector([1, 7, 0], Math.PI / 3);
    expect(y).toBe(7);
  });

  it("+90° about Y sends +X toward +Z", () => {
    const [x, , z] = yawRotateVector([1, 0, 0], Math.PI / 2);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
  });

  it("is invertible with the negated angle", () => {
    const v = [0.3, -1.2, 0.7];
    const round = yawRotateVector(yawRotateVector(v, 1.1), -1.1);
    expect(round[0]).toBeCloseTo(v[0]);
    expect(round[1]).toBeCloseTo(v[1]);
    expect(round[2]).toBeCloseTo(v[2]);
  });
});

describe("buildYawPivotMatrix", () => {
  it("theta 0 is the identity matrix regardless of pivot", () => {
    const m = buildYawPivotMatrix(0, [5, -3, 9]);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(identity[i]);
    }
  });

  it("defaults to a zero pivot", () => {
    const m = buildYawPivotMatrix(Math.PI / 2);
    const p = applyMat4(m, [1, 2, 3]);
    const expected = yawRotateVector([1, 2, 3], Math.PI / 2);
    expect(p[0]).toBeCloseTo(expected[0]);
    expect(p[1]).toBeCloseTo(expected[1]);
    expect(p[2]).toBeCloseTo(expected[2]);
  });

  it("transforming a point matches pivot + yawRotateVector(point - pivot, theta)", () => {
    const pivot = [10, 4, -6];
    const theta = 1.234;
    const point = [12, 7, -2];
    const m = buildYawPivotMatrix(theta, pivot);
    const actual = applyMat4(m, point);

    const relative = [point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]];
    const rotated = yawRotateVector(relative, theta);
    const expected = [rotated[0] + pivot[0], rotated[1] + pivot[1], rotated[2] + pivot[2]];

    expect(actual[0]).toBeCloseTo(expected[0]);
    expect(actual[1]).toBeCloseTo(expected[1]);
    expect(actual[2]).toBeCloseTo(expected[2]);
  });

  it("leaves the pivot point itself fixed", () => {
    const pivot = [3, -8, 2];
    const m = buildYawPivotMatrix(0.7, pivot);
    const p = applyMat4(m, pivot);
    expect(p[0]).toBeCloseTo(pivot[0]);
    expect(p[1]).toBeCloseTo(pivot[1]);
    expect(p[2]).toBeCloseTo(pivot[2]);
  });

  it("does not move points along the Y axis relative to the pivot", () => {
    const pivot = [1, 5, 1];
    const m = buildYawPivotMatrix(0.9, pivot);
    const p = applyMat4(m, [1, 50, 1]);
    expect(p[1]).toBeCloseTo(50);
  });
});

describe("mapXRPointToData", () => {
  it("applies dataPos = xrPos / vrScale + vrOrigin", () => {
    expect(mapXRPointToData({ x: 2, y: 4, z: -6 }, 2, [10, 20, 30])).toEqual([
      11, 22, 27,
    ]);
  });

  it("defaults to scale 1 and origin 0", () => {
    expect(mapXRPointToData({ x: 1, y: 2, z: 3 })).toEqual([1, 2, 3]);
    expect(mapXRPointToData({ x: 1, y: 2, z: 3 }, 0, null)).toEqual([1, 2, 3]);
  });
});

describe("quantizeNormalToAxis", () => {
  it("picks the dominant axis with sign", () => {
    expect(quantizeNormalToAxis([0.9, 0.1, 0.2])).toEqual({
      axis: 0,
      sign: 1,
      vector: [1, 0, 0],
    });
    expect(quantizeNormalToAxis([0.1, -0.8, 0.2])).toEqual({
      axis: 1,
      sign: -1,
      vector: [0, -1, 0],
    });
    expect(quantizeNormalToAxis([0, 0.2, -0.9])).toEqual({
      axis: 2,
      sign: -1,
      vector: [0, 0, -1],
    });
  });

  it("survives a missing normal", () => {
    expect(quantizeNormalToAxis(null).axis).toBe(1);
  });
});
