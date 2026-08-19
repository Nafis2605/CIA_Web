// Tests for the VR ray/polydata intersector that replaced vtkPicker.pick3DPoint.
//
// The bug being guarded against: pick3DPoint derived its tolerance from the
// DISPLAY projection (Picker.js:282 -> computeTolerance -> normalizedDisplayToWorld)
// while being handed a DATA-space Z, which under VR's forced XR projection
// matrix produced a NaN/garbage tolerance that made intersectBox reject every
// prop — annotate/measure/probe missed no matter where the user aimed.
//
// Everything here is pure geometry: no camera, no renderer, no viewport. That
// is the point — these are the properties pick3DPoint could not guarantee.

import { describe, it, expect } from "vitest";
import { buildPickAccel, intersectRay } from "../vrRayPick.js";

/**
 * Minimal vtkPolyData stand-in — only the four accessors buildPickAccel reads.
 *
 * @param {number[]} points - flat xyz
 * @param {number[]} polys - vtk connectivity [n, i0, i1, ..., n, ...]
 * @param {{verts?: number, lines?: number}} [counts]
 */
function fakePolyData(points, polys, { verts = 0, lines = 0 } = {}) {
  return {
    getPoints: () => ({ getData: () => Float32Array.from(points) }),
    getPolys: () => ({ getData: () => Int32Array.from(polys) }),
    getNumberOfVerts: () => verts,
    getNumberOfLines: () => lines,
  };
}

/** A unit quad in the z=0 plane, as two triangles. */
function quadPolyData(opts) {
  return fakePolyData(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    [3, 0, 1, 2, 3, 0, 2, 3],
    opts
  );
}

describe("vrRayPick", () => {
  describe("buildPickAccel", () => {
    it("returns null for polydata with no polys", () => {
      expect(buildPickAccel(fakePolyData([0, 0, 0], []))).toBeNull();
    });

    it("returns null for a malformed polydata", () => {
      expect(buildPickAccel(null)).toBeNull();
      expect(buildPickAccel({})).toBeNull();
    });

    it("fan-triangulates a quad cell into two triangles", () => {
      // One 4-point polygon -> 2 triangles, both carrying the SAME cell id.
      const accel = buildPickAccel(
        fakePolyData([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [4, 0, 1, 2, 3])
      );
      expect(accel.numTriangles).toBe(2);
      expect(Array.from(accel.triCellId)).toEqual([0, 0]);
    });

    it("offsets cell ids past verts and lines", () => {
      // vtkPolyData numbers cells verts -> lines -> polys -> strips
      // (PolyData.js buildCells). A poly at index i is cell nVerts+nLines+i.
      // Getting this wrong would corrupt the downstream
      // polyData.getCellPoints(cellId) lookup rather than merely miss.
      const accel = buildPickAccel(quadPolyData({ verts: 5, lines: 3 }));
      expect(Array.from(accel.triCellId)).toEqual([8, 8 + 1]);
    });
  });

  describe("intersectRay", () => {
    it("hits a quad dead centre and reports the exact intersection", () => {
      const accel = buildPickAccel(quadPolyData());
      const hit = intersectRay(accel, [0.5, 0.5, 5], [0.5, 0.5, -5]);

      expect(hit).not.toBeNull();
      expect(hit.cellId).toBeGreaterThanOrEqual(0);
      expect(hit.point[0]).toBeCloseTo(0.5, 9);
      expect(hit.point[1]).toBeCloseTo(0.5, 9);
      expect(hit.point[2]).toBeCloseTo(0, 9);
    });

    it("misses when the ray passes beside the geometry", () => {
      const accel = buildPickAccel(quadPolyData());
      expect(intersectRay(accel, [5, 5, 5], [5, 5, -5])).toBeNull();
    });

    it("misses when the segment stops short of the geometry", () => {
      // Correct parametric clamping: the ray points at the quad but the
      // segment ends before reaching it.
      const accel = buildPickAccel(quadPolyData());
      expect(intersectRay(accel, [0.5, 0.5, 5], [0.5, 0.5, 1])).toBeNull();
    });

    it("returns the NEAREST of two stacked surfaces", () => {
      // Two parallel quads at z=0 and z=2; a ray from z=5 pointing down must
      // report the z=2 one. Front-to-back DDA ordering is what guarantees this.
      const accel = buildPickAccel(
        fakePolyData(
          [
            0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
            0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2,
          ],
          [3, 0, 1, 2, 3, 0, 2, 3, 3, 4, 5, 6, 3, 4, 6, 7]
        )
      );
      const hit = intersectRay(accel, [0.5, 0.5, 5], [0.5, 0.5, -5]);
      expect(hit).not.toBeNull();
      expect(hit.point[2]).toBeCloseTo(2, 9);
    });

    it("hits a backface — a user inside a surface still gets a pick", () => {
      // Double-sided on purpose. A culled backface would read as exactly the
      // silent miss this module exists to eliminate.
      const accel = buildPickAccel(quadPolyData());
      const hit = intersectRay(accel, [0.5, 0.5, -5], [0.5, 0.5, 5]);
      expect(hit).not.toBeNull();
      expect(hit.point[2]).toBeCloseTo(0, 9);
    });

    it("reports the source point ids of the hit triangle", () => {
      const accel = buildPickAccel(quadPolyData());
      const hit = intersectRay(accel, [0.1, 0.9, 5], [0.1, 0.9, -5]);
      expect(hit).not.toBeNull();
      expect(hit.pointIds).toHaveLength(3);
      hit.pointIds.forEach((id) => {
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(4);
      });
    });

    it("reports a unit-length normal", () => {
      const accel = buildPickAccel(quadPolyData());
      const hit = intersectRay(accel, [0.5, 0.5, 5], [0.5, 0.5, -5]);
      const [nx, ny, nz] = hit.normal;
      expect(Math.sqrt(nx * nx + ny * ny + nz * nz)).toBeCloseTo(1, 9);
    });

    it("handles a perfectly planar (zero-thickness) dataset", () => {
      // The quad has zero extent in z. Without the bounds padding in
      // buildPickAccel this divides by zero and the traversal produces NaN.
      const accel = buildPickAccel(quadPolyData());
      expect(accel.cellSize[2]).toBeGreaterThan(0);
      expect(intersectRay(accel, [0.5, 0.5, 5], [0.5, 0.5, -5])).not.toBeNull();
    });

    it("survives coordinates far from the origin", () => {
      // The exact regime that broke pick3DPoint: a data-space Z in the
      // thousands, fed to a tolerance routine expecting a normalized depth.
      // Pure geometry has no opinion about magnitude.
      const off = 5000;
      const accel = buildPickAccel(
        fakePolyData(
          [
            off, off, off,
            off + 1, off, off,
            off + 1, off + 1, off,
            off, off + 1, off,
          ],
          [3, 0, 1, 2, 3, 0, 2, 3]
        )
      );
      const hit = intersectRay(
        accel,
        [off + 0.5, off + 0.5, off + 10],
        [off + 0.5, off + 0.5, off - 10]
      );
      expect(hit).not.toBeNull();
      expect(hit.point[2]).toBeCloseTo(off, 6);
    });

    it("finds every triangle of a dense mesh (grid traversal completeness)", () => {
      // A 20x20 grid of quads. Aiming at the centre of each one must hit, which
      // only holds if DDA traversal visits every cell the ray crosses and the
      // mailbox never skips a triangle it has not actually tested yet.
      const N = 20;
      const pts = [];
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) pts.push(i, j, 0);
      }
      const polys = [];
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = j * (N + 1) + i;
          polys.push(3, a, a + 1, a + N + 2, 3, a, a + N + 2, a + N + 1);
        }
      }
      const accel = buildPickAccel(fakePolyData(pts, polys));
      expect(accel.numTriangles).toBe(N * N * 2);

      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const hit = intersectRay(
            accel,
            [i + 0.5, j + 0.5, 3],
            [i + 0.5, j + 0.5, -3]
          );
          expect(hit, `expected a hit at cell ${i},${j}`).not.toBeNull();
        }
      }
    });

    it("hits consistently on an oblique ray across a dense mesh", () => {
      // Axis-aligned rays exercise a degenerate DDA path (two axes have
      // step 0). An oblique ray exercises real three-axis traversal.
      const N = 12;
      const pts = [];
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) pts.push(i, j, 0);
      }
      const polys = [];
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = j * (N + 1) + i;
          polys.push(3, a, a + 1, a + N + 2, 3, a, a + N + 2, a + N + 1);
        }
      }
      const accel = buildPickAccel(fakePolyData(pts, polys));

      const hit = intersectRay(accel, [-5, -5, 8], [N + 5, N + 5, -8]);
      expect(hit).not.toBeNull();
      expect(hit.point[2]).toBeCloseTo(0, 6);
      // The z=0 crossing of that segment is at t=0.5, i.e. x=y=(N/2).
      expect(hit.point[0]).toBeCloseTo(N / 2, 6);
      expect(hit.point[1]).toBeCloseTo(N / 2, 6);
    });

    it("returns null instead of throwing on degenerate input", () => {
      const accel = buildPickAccel(quadPolyData());
      expect(intersectRay(accel, [0, 0, 0], [0, 0, 0])).toBeNull();
      expect(intersectRay(null, [0, 0, 1], [0, 0, -1])).toBeNull();
      expect(intersectRay(accel, null, [0, 0, -1])).toBeNull();
    });
  });
});
