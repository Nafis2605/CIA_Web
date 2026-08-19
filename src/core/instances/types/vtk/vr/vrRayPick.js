// src/core/instances/types/vtk/vr/vrRayPick.js
// Projection-independent ray/polydata intersection for VR picking.
//
// WHY THIS EXISTS
// VR picking used to go through vtkPicker.pick3DPoint(), which derives its
// pick tolerance from the DISPLAY projection:
//
//   Picker.js:282
//   const tolerance = computeTolerance(model.selectionPoint[2], aspect, renderer)
//                     * model.tolerance;
//
// computeTolerance() treats its first argument as a NORMALIZED DISPLAY DEPTH
// and runs it through view.displayToNormalizedDisplay() ->
// renderer.normalizedDisplayToWorld(). But pick3DPoint passes
// model.selectionPoint[2] — the ray origin's raw DATA-space Z, which for a
// scientific dataset is routinely in the hundreds or thousands. In VR the
// camera it inverts also carries a force-installed XR projection matrix plus
// setPhysicalScale(1 / vrScale), so the round trip produces a NaN or wildly
// mis-scaled tolerance. That value then flows into
//
//   Picker.js:115  vtkBoundingBox.inflate(mapper.getBounds(), tolerance)
//
// and intersectBox() rejects EVERY prop — the universal cellId === -1 that
// made annotate, measure and probe silently do nothing on both Quest and
// Vision Pro no matter where the user aimed.
//
// There is no way to hand vtk.js an explicit world-space tolerance instead:
// pick3DInternal is module-private, and this vtk.js build ships no
// vtkCellLocator / vtkOBBTree (only point locators). So this module does the
// intersection itself, in pure geometry — nothing here touches a camera, a
// projection matrix or a viewport, which is exactly why it cannot regress the
// way pick3DPoint did.
//
// The caller maps the ray into each actor's LOCAL frame (both endpoints
// through the inverse of prop.getMatrix()), so actor
// Position/Orientation/Scale and the VR-yaw UserMatrix are all honoured
// without this module knowing about them.

/**
 * Grid resolution is derived from triangle count: roughly one cell per
 * ~8 triangles, clamped so tiny meshes don't allocate a big grid and huge
 * meshes don't allocate a pathological one (64^3 = 262144 cells max).
 */
const MIN_GRID_DIM = 4;
const MAX_GRID_DIM = 64;
const TARGET_TRIS_PER_CELL = 8;

/** Guard against degenerate/zero-area triangles in Moller-Trumbore. */
const EPSILON = 1e-12;

/**
 * @typedef {object} PickAccel
 * @property {Float64Array} tri - flattened triangle vertices, 9 floats each
 * @property {Int32Array} triCellId - global vtk cellId per triangle
 * @property {Int32Array} triPointIds - source point ids per triangle, 3 each
 * @property {Float64Array} bounds - [xmin,xmax,ymin,ymax,zmin,zmax]
 * @property {Int32Array} dims - grid dimensions [nx,ny,nz]
 * @property {Float64Array} cellSize - grid cell size per axis
 * @property {Int32Array} cellStart - CSR offsets, length nx*ny*nz+1
 * @property {Int32Array} cellTris - CSR triangle indices
 * @property {Int32Array} mailbox - per-triangle last-visited ray stamp
 * @property {number} numTriangles
 */

/**
 * Read a vtkPolyData's polys into a flat triangle soup.
 *
 * Polygons with more than three points are fan-triangulated, and every
 * resulting triangle keeps the GLOBAL vtk cell id of the polygon it came
 * from. That global id matters: callers feed it straight back into
 * polyData.getCellPoints(cellId), and vtkPolyData numbers its cells
 * verts -> lines -> polys -> strips (PolyData.js buildCells), so a poly at
 * index i is cell nVerts + nLines + i, NOT cell i.
 *
 * Strips are deliberately not handled — vtk.js pipelines in this app deliver
 * triangulated polys, and silently mis-numbering strip cells would corrupt
 * the downstream getCellPoints() lookup rather than merely miss.
 *
 * @param {object} polyData - vtkPolyData
 * @returns {{tri: Float64Array, triCellId: Int32Array, triPointIds: Int32Array, count: number}|null}
 */
function buildTriangleSoup(polyData) {
  const points = polyData?.getPoints?.();
  const polys = polyData?.getPolys?.();
  if (!points || !polys) return null;

  const coords = points.getData();
  const conn = polys.getData();
  if (!coords || !conn || conn.length === 0) return null;

  const cellIdOffset =
    (polyData.getNumberOfVerts?.() || 0) + (polyData.getNumberOfLines?.() || 0);

  // Pass 1 — count triangles so the typed arrays are allocated exactly once.
  let triCount = 0;
  for (let i = 0; i < conn.length; ) {
    const n = conn[i];
    if (n < 3) {
      i += n + 1;
      continue;
    }
    triCount += n - 2;
    i += n + 1;
  }
  if (triCount === 0) return null;

  const tri = new Float64Array(triCount * 9);
  const triCellId = new Int32Array(triCount);
  const triPointIds = new Int32Array(triCount * 3);

  // Pass 2 — fill.
  let t = 0;
  let polyIndex = 0;
  for (let i = 0; i < conn.length; polyIndex++) {
    const n = conn[i];
    if (n < 3) {
      i += n + 1;
      continue;
    }
    const base = i + 1;
    const globalCellId = cellIdOffset + polyIndex;
    const i0 = conn[base];
    for (let k = 1; k < n - 1; k++) {
      const i1 = conn[base + k];
      const i2 = conn[base + k + 1];
      const o = t * 9;
      tri[o] = coords[i0 * 3];
      tri[o + 1] = coords[i0 * 3 + 1];
      tri[o + 2] = coords[i0 * 3 + 2];
      tri[o + 3] = coords[i1 * 3];
      tri[o + 4] = coords[i1 * 3 + 1];
      tri[o + 5] = coords[i1 * 3 + 2];
      tri[o + 6] = coords[i2 * 3];
      tri[o + 7] = coords[i2 * 3 + 1];
      tri[o + 8] = coords[i2 * 3 + 2];
      triCellId[t] = globalCellId;
      triPointIds[t * 3] = i0;
      triPointIds[t * 3 + 1] = i1;
      triPointIds[t * 3 + 2] = i2;
      t++;
    }
    i += n + 1;
  }

  return { tri, triCellId, triPointIds, count: triCount };
}

/**
 * Build a uniform-grid acceleration structure over a polydata's triangles.
 *
 * Uniform grid rather than a BVH on purpose: it builds in one linear pass with
 * no sorting, which matters because this runs on VR entry while the headset is
 * already busy, and DDA traversal gives front-to-back ordering for free so the
 * first hit found is the nearest one.
 *
 * @param {object} polyData - vtkPolyData
 * @returns {PickAccel|null} null when the polydata has no triangulable cells
 */
export function buildPickAccel(polyData) {
  const soup = buildTriangleSoup(polyData);
  if (!soup) return null;

  const { tri, triCellId, triPointIds, count } = soup;

  // Bounds straight from the triangle soup, not polyData.getBounds(): points
  // not referenced by any poly must not inflate the grid.
  const bounds = new Float64Array([
    Infinity,
    -Infinity,
    Infinity,
    -Infinity,
    Infinity,
    -Infinity,
  ]);
  for (let i = 0; i < count * 9; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tri[i + a];
      if (v < bounds[a * 2]) bounds[a * 2] = v;
      if (v > bounds[a * 2 + 1]) bounds[a * 2 + 1] = v;
    }
  }

  // A perfectly flat axis (a planar slice) would give a zero-width cell and
  // divide by zero during traversal — pad every axis by a hair.
  const extent = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const span = bounds[a * 2 + 1] - bounds[a * 2];
    const pad = span > 0 ? span * 1e-6 : 1e-6;
    bounds[a * 2] -= pad;
    bounds[a * 2 + 1] += pad;
    extent[a] = bounds[a * 2 + 1] - bounds[a * 2];
  }

  const target = Math.cbrt(Math.max(1, count / TARGET_TRIS_PER_CELL));
  const dim = Math.max(MIN_GRID_DIM, Math.min(MAX_GRID_DIM, Math.ceil(target)));
  const dims = new Int32Array([dim, dim, dim]);
  const cellSize = new Float64Array([
    extent[0] / dims[0],
    extent[1] / dims[1],
    extent[2] / dims[2],
  ]);
  const numCells = dims[0] * dims[1] * dims[2];

  /** Grid-cell index range a triangle's AABB covers, as [i0,i1,j0,j1,k0,k1]. */
  const range = new Int32Array(6);
  const triRange = (t) => {
    const o = t * 9;
    for (let a = 0; a < 3; a++) {
      let lo = tri[o + a];
      let hi = lo;
      const v1 = tri[o + 3 + a];
      const v2 = tri[o + 6 + a];
      if (v1 < lo) lo = v1;
      if (v1 > hi) hi = v1;
      if (v2 < lo) lo = v2;
      if (v2 > hi) hi = v2;
      let c0 = Math.floor((lo - bounds[a * 2]) / cellSize[a]);
      let c1 = Math.floor((hi - bounds[a * 2]) / cellSize[a]);
      if (c0 < 0) c0 = 0;
      if (c1 > dims[a] - 1) c1 = dims[a] - 1;
      if (c1 < c0) c1 = c0;
      range[a * 2] = c0;
      range[a * 2 + 1] = c1;
    }
  };

  // CSR build: count per cell, prefix-sum into offsets, then scatter.
  const counts = new Int32Array(numCells);
  for (let t = 0; t < count; t++) {
    triRange(t);
    for (let k = range[4]; k <= range[5]; k++) {
      for (let j = range[2]; j <= range[3]; j++) {
        const rowBase = (k * dims[1] + j) * dims[0];
        for (let i = range[0]; i <= range[1]; i++) counts[rowBase + i]++;
      }
    }
  }

  const cellStart = new Int32Array(numCells + 1);
  let running = 0;
  for (let c = 0; c < numCells; c++) {
    cellStart[c] = running;
    running += counts[c];
  }
  cellStart[numCells] = running;

  const cursor = cellStart.slice(0, numCells);
  const cellTris = new Int32Array(running);
  for (let t = 0; t < count; t++) {
    triRange(t);
    for (let k = range[4]; k <= range[5]; k++) {
      for (let j = range[2]; j <= range[3]; j++) {
        const rowBase = (k * dims[1] + j) * dims[0];
        for (let i = range[0]; i <= range[1]; i++) {
          cellTris[cursor[rowBase + i]++] = t;
        }
      }
    }
  }

  return {
    tri,
    triCellId,
    triPointIds,
    bounds,
    dims,
    cellSize,
    cellStart,
    cellTris,
    // A triangle straddling several grid cells is listed in each of them. The
    // mailbox stamps it with the current ray id so the second and later
    // encounters are skipped instead of re-running Moller-Trumbore.
    mailbox: new Int32Array(count).fill(-1),
    numTriangles: count,
  };
}

/**
 * Moller-Trumbore ray/triangle intersection, double-sided.
 *
 * Double-sided deliberately: a VR user can walk inside a closed surface (or
 * aim at a clipped/backfacing region) and still expects a pick there. A culled
 * backface would read as exactly the silent miss this module exists to remove.
 *
 * @param {Float64Array} tri - triangle soup
 * @param {number} t - triangle index
 * @param {number[]} orig - ray origin
 * @param {number[]} dir - ray direction (need not be normalized)
 * @returns {number} parametric distance along dir, or -1 for no hit
 */
function intersectTriangle(tri, t, orig, dir) {
  const o = t * 9;
  const e1x = tri[o + 3] - tri[o];
  const e1y = tri[o + 4] - tri[o + 1];
  const e1z = tri[o + 5] - tri[o + 2];
  const e2x = tri[o + 6] - tri[o];
  const e2y = tri[o + 7] - tri[o + 1];
  const e2z = tri[o + 8] - tri[o + 2];

  const px = dir[1] * e2z - dir[2] * e2y;
  const py = dir[2] * e2x - dir[0] * e2z;
  const pz = dir[0] * e2y - dir[1] * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPSILON && det < EPSILON) return -1;
  const invDet = 1 / det;

  const tx = orig[0] - tri[o];
  const ty = orig[1] - tri[o + 1];
  const tz = orig[2] - tri[o + 2];

  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return -1;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
  if (v < 0 || u + v > 1) return -1;

  return (e2x * qx + e2y * qy + e2z * qz) * invDet;
}

/** Monotonic stamp for the mailbox; wraps harmlessly. */
let rayStamp = 0;

/**
 * Intersect a segment against a polydata's triangles.
 *
 * Both endpoints must already be in the polydata's LOCAL coordinate frame.
 *
 * @param {PickAccel} accel - from buildPickAccel
 * @param {number[]} p1 - segment start, local space
 * @param {number[]} p2 - segment end, local space
 * @returns {{cellId: number, t: number, point: number[], normal: number[],
 *   pointIds: number[]}|null} nearest hit, or null
 */
export function intersectRay(accel, p1, p2) {
  if (!accel || !p1 || !p2) return null;

  const {
    tri,
    triCellId,
    triPointIds,
    bounds,
    dims,
    cellSize,
    cellStart,
    cellTris,
    mailbox,
  } = accel;

  const dir = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const segLen = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
  if (!(segLen > 0)) return null;

  // Clip the segment to the grid AABB (slab test). Everything past this point
  // works in parametric t over [0,1] along p1->p2.
  let tMin = 0;
  let tMax = 1;
  for (let a = 0; a < 3; a++) {
    const lo = bounds[a * 2];
    const hi = bounds[a * 2 + 1];
    if (Math.abs(dir[a]) < EPSILON) {
      if (p1[a] < lo || p1[a] > hi) return null;
      continue;
    }
    const inv = 1 / dir[a];
    let t0 = (lo - p1[a]) * inv;
    let t1 = (hi - p1[a]) * inv;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    if (tMin > tMax) return null;
  }

  const stamp = ++rayStamp;

  // DDA setup — start at the cell containing the entry point.
  const entry = [
    p1[0] + dir[0] * tMin,
    p1[1] + dir[1] * tMin,
    p1[2] + dir[2] * tMin,
  ];
  const cell = new Int32Array(3);
  const step = new Int32Array(3);
  const tDelta = new Float64Array(3);
  const tNext = new Float64Array(3);

  for (let a = 0; a < 3; a++) {
    let c = Math.floor((entry[a] - bounds[a * 2]) / cellSize[a]);
    if (c < 0) c = 0;
    if (c > dims[a] - 1) c = dims[a] - 1;
    cell[a] = c;

    if (Math.abs(dir[a]) < EPSILON) {
      step[a] = 0;
      tDelta[a] = Infinity;
      tNext[a] = Infinity;
    } else {
      const inv = 1 / dir[a];
      step[a] = dir[a] > 0 ? 1 : -1;
      tDelta[a] = Math.abs(cellSize[a] * inv);
      const boundary = bounds[a * 2] + (c + (dir[a] > 0 ? 1 : 0)) * cellSize[a];
      tNext[a] = (boundary - p1[a]) * inv;
    }
  }

  let bestT = Infinity;
  let bestTri = -1;

  for (;;) {
    const cellIndex = (cell[2] * dims[1] + cell[1]) * dims[0] + cell[0];
    const start = cellStart[cellIndex];
    const end = cellStart[cellIndex + 1];

    for (let s = start; s < end; s++) {
      const t = cellTris[s];
      if (mailbox[t] === stamp) continue;
      mailbox[t] = stamp;
      const hit = intersectTriangle(tri, t, p1, dir);
      if (hit >= tMin && hit <= tMax && hit < bestT) {
        bestT = hit;
        bestTri = t;
      }
    }

    // Advance to the next cell along the smallest tNext axis.
    let axis = 0;
    if (tNext[1] < tNext[axis]) axis = 1;
    if (tNext[2] < tNext[axis]) axis = 2;

    // Front-to-back traversal: once the nearest hit is closer than the exit of
    // the current cell, no later cell can beat it.
    if (bestTri >= 0 && bestT <= tNext[axis]) break;

    if (tNext[axis] > tMax || step[axis] === 0) break;
    cell[axis] += step[axis];
    if (cell[axis] < 0 || cell[axis] >= dims[axis]) break;
    tNext[axis] += tDelta[axis];
  }

  if (bestTri < 0) return null;

  const o = bestTri * 9;
  const e1 = [
    tri[o + 3] - tri[o],
    tri[o + 4] - tri[o + 1],
    tri[o + 5] - tri[o + 2],
  ];
  const e2 = [
    tri[o + 6] - tri[o],
    tri[o + 7] - tri[o + 1],
    tri[o + 8] - tri[o + 2],
  ];
  let nx = e1[1] * e2[2] - e1[2] * e2[1];
  let ny = e1[2] * e2[0] - e1[0] * e2[2];
  let nz = e1[0] * e2[1] - e1[1] * e2[0];
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= nLen;
  ny /= nLen;
  nz /= nLen;

  return {
    cellId: triCellId[bestTri],
    t: bestT,
    point: [
      p1[0] + dir[0] * bestT,
      p1[1] + dir[1] * bestT,
      p1[2] + dir[2] * bestT,
    ],
    normal: [nx, ny, nz],
    pointIds: [
      triPointIds[bestTri * 3],
      triPointIds[bestTri * 3 + 1],
      triPointIds[bestTri * 3 + 2],
    ],
  };
}
