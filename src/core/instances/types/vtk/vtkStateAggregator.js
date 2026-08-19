// src/core/instances/types/vtk/vtkStateAggregator.js
//
// Closes the asymmetry between VTKInstanceHandler.applySharedState() (which can APPLY a
// rich visualization state) and _getCurrentVTKState() (which, before this module
// existed, only ever PRODUCED camera + visualization.{opacity, representation} +
// reduction). A host's full-state snapshot silently dropped every filter the user had
// actually set, so a newly-joining peer never saw the host's point size, transform,
// slice, window/level, colormap/active-array, glyphs, threshold, slice plane, or clip
// box. This module is the read side that closes that gap.
//
// Scope: this is a read path ONLY, and it mirrors — key for key — the
// `state.visualization.*` branches VTKInstanceHandler.applySharedState() already knows
// how to consume (VTKInstanceHandler.js ~4340-4474). Nothing should be added here
// unless applySharedState has a matching branch; see the "deliberately excluded"
// section at the bottom for features with a getState()/getConfigForSync() but no
// consumer.
//
// NOT handled here (left in VTKInstanceHandler._getCurrentVTKState(), untouched):
//   - camera (position/focalPoint/viewUp/parallelScale/clippingRange/viewAngle)
//   - visualization.opacity / visualization.representation
//   - state.reduction
// Reduction in particular *can't* move here: VTKReductionFeature is instantiated
// per-handler (`this.reductionFeature`, VTKInstanceHandler.js:137), not exported as a
// module-level singleton like every feature below, so a plain `read(instanceId)` source
// table has no way to reach it without a handler reference. That's the reason this is a
// separate module keyed by instanceId rather than a handler method.

import { instanceTools } from "./vtkInstanceTools.js";
import { vtkScalarColoringFeature } from "./features/VTKScalarColoringFeature.js";
import { vtkGlyphFeature } from "./features/VTKGlyphFeature.js";
import { vtkThresholdFeature } from "./features/VTKThresholdFeature.js";
import { vtkSliceFeature } from "./features/VTKSliceFeature.js";
import { vtkClippingFeature } from "./features/VTKClippingFeature.js";
import { sync as log } from "@Utils/logger.js";

// =============================================================================
// SOURCE TABLE
// =============================================================================

/**
 * Declarative table of everything this module knows how to read into a
 * `state.visualization` patch. Each entry names the exact key
 * VTKInstanceHandler.applySharedState() reads it back as, and how to produce it for a
 * given instanceId.
 *
 * `read(instanceId, instanceData)` is called individually, inside its own try/catch, so
 * one throwing/misbehaving feature can never abort the rest of the aggregate.
 *
 * `allowNull: true` marks a source where an explicit `null` is meaningful to
 * applySharedState (as opposed to "nothing to report", which is omitted rather than
 * sent as null — see aggregateVTKVisualizationState below).
 */
export const VTK_STATE_SOURCES = [
  // --- Actor-property tools (VTKInstanceHandler.js:4365-4371) ---------------
  {
    key: "pointSize",
    read: (instanceId) => instanceTools.getPointSize(instanceId),
  },
  {
    key: "lineWidth",
    read: (instanceId) => instanceTools.getLineWidth(instanceId),
  },

  // --- Transform (VTKInstanceHandler.js:4375-4384) ---------------------------
  // applySharedState applies position/rotation/scale independently when present, but
  // instanceTools has no way to report "unset" for any of the three (getPosition etc.
  // fall back to identity defaults, exactly like the pre-existing opacity/representation
  // reads on the same object do), so all three are always included together, mirroring
  // how actor.getProperty().getOpacity() is always included above.
  {
    key: "transform",
    read: (instanceId) => ({
      position: instanceTools.getPosition(instanceId),
      rotation: instanceTools.getRotation(instanceId),
      scale: instanceTools.getScale(instanceId),
    }),
  },

  // --- Legacy slice orientation/position (VTKInstanceHandler.js:4387-4395) ---
  // Distinct from `slicePlane` below — see vtkSliceFeature entry.
  {
    key: "slice",
    read: (instanceId) => ({
      orientation: instanceTools.getSliceOrientation(instanceId),
      position: instanceTools.getSlicePosition(instanceId),
    }),
  },

  // --- Window/level (VTKInstanceHandler.js:4398-4405) -------------------------
  {
    key: "windowLevel",
    read: (instanceId) => instanceTools.getWindowLevel(instanceId),
  },

  // --- Scalar coloring (VTKInstanceHandler.js:4408-4431) ----------------------
  // VTKScalarColoringFeature only exposes getState() (no getConfigForSync()); its
  // getState() shape already matches 1:1 what applySharedState reads, so it's used
  // directly rather than reshaped.
  {
    key: "colormap",
    read: (instanceId) => vtkScalarColoringFeature.getState(instanceId)?.colormap,
  },
  {
    // applySharedState treats `activeArray === null` as an explicit instruction to
    // disable scalar coloring (VTKInstanceHandler.js:4419) — it is NOT the same as "no
    // opinion". VTKScalarColoringFeature.disableScalarColoring() sets state.activeArray
    // back to null, so getState().activeArray is already null exactly when coloring is
    // off. That null must round-trip, not be omitted, or a peer who disabled scalar
    // coloring would never tell newly-joining peers to turn it off.
    key: "activeArray",
    read: (instanceId) => vtkScalarColoringFeature.getState(instanceId)?.activeArray ?? null,
    allowNull: true,
  },
  {
    key: "activeArrayType",
    read: (instanceId) => vtkScalarColoringFeature.getState(instanceId)?.activeArrayType,
  },

  // --- Feature-owned declarative configs --------------------------------------
  // These four use getConfigForSync(), NOT getState(): getConfigForSync() runs the
  // result through the feature's own normalize*Config() and returns exactly the shape
  // applyRemoteConfig() consumes, while getState() carries extra local-only UI state
  // (e.g. clipping's `widgetVisible`) that has no meaning on a remote client and would
  // not round-trip. This is the same convention VRExplorationManager already relies on
  // when it builds VR visualization patches (e.g. vtkClippingFeature.getConfigForSync
  // in VRExplorationManager.js). Verified for all four:
  //   - VTKClippingFeature:  getConfigForSync :464 -> applyRemoteConfig(id, config) :485
  //   - VTKGlyphFeature:     getConfigForSync :884 -> applyRemoteConfig(id, polydata, config) :907
  //   - VTKThresholdFeature: getConfigForSync :525 -> applyRemoteConfig(id, config) :543
  //   - VTKSliceFeature:     getConfigForSync :464 -> applyRemoteConfig(id, imageData, config) :483
  // applyRemoteConfig's extra `polydata`/`imageData` arguments are only needed at APPLY
  // time (to build the geometry when enabling); the read side needs just instanceId.
  {
    key: "glyph",
    read: (instanceId) => vtkGlyphFeature.getConfigForSync(instanceId),
  },
  {
    key: "threshold",
    read: (instanceId) => vtkThresholdFeature.getConfigForSync(instanceId),
  },
  {
    // Volumetric slice viewer — NOT the same key as `slice` above.
    key: "slicePlane",
    read: (instanceId) => vtkSliceFeature.getConfigForSync(instanceId),
  },
  {
    key: "clipBox",
    read: (instanceId) => vtkClippingFeature.getConfigForSync(instanceId),
  },
];

// =============================================================================
// DELIBERATELY EXCLUDED
// =============================================================================
// The following module singletons expose getState() but have no consuming branch in
// VTKInstanceHandler.applySharedState(), so including them would bloat every snapshot
// with data no receiver reads: vtkVolumeFeature, vtkIsosurfaceFeature,
// vtkTransferFunctionFeature, vtkScalarBarFeature, vtkTimeSeriesFeature, vtkPBRFeature,
// vtkNormalsFeature, vtkCutterFeature, vtkThresholdPointsFeature,
// vtkCleanPolyDataFeature, vtkSceneFeature, and the widget features
// (vtkAnnotationWidgetsFeature, vtkResliceCursorFeature, vtkMeasurementWidgetsFeature,
// vtkImplicitPlaneFeature, vtkImageCroppingFeature) — scene/widget-local state with no
// remote-apply path. If a future applySharedState branch is added for one of these,
// add a matching source entry above at the same time.

// =============================================================================
// AGGREGATION
// =============================================================================

/**
 * Read every source in VTK_STATE_SOURCES for a single VTK instance and return a flat
 * object suitable for spreading into `state.visualization` (see
 * VTKInstanceHandler._getCurrentVTKState()).
 *
 * Each source is read independently inside its own try/catch: one feature throwing
 * (e.g. because it was never initialized for this instance, or the instance's
 * sceneObjects are mid-teardown) never prevents the other keys from being reported.
 *
 * A source whose read() returns undefined is omitted — there is nothing meaningful to
 * report. A source whose read() returns null is also omitted UNLESS it is marked
 * `allowNull: true`, in which case the null is meaningful to applySharedState and must
 * be sent explicitly (currently only `activeArray`).
 *
 * @param {string} instanceId
 * @param {object} instanceData - Reserved for sources that need more than instanceId to
 *   read their value. None of the current sources need it (every feature and
 *   instanceTools method here is keyed purely by instanceId), but it's accepted and
 *   threaded through to `read()` so a future source can use it without a signature
 *   change.
 * @returns {object}
 */
export function aggregateVTKVisualizationState(instanceId, instanceData) {
  const out = {};

  for (const source of VTK_STATE_SOURCES) {
    try {
      const value = source.read(instanceId, instanceData);

      if (value === undefined) continue;
      if (value === null && !source.allowNull) continue;

      out[source.key] = value;
    } catch (error) {
      log.warn(
        `vtkStateAggregator: failed to read "${source.key}" for instance ${instanceId}, omitting from snapshot`,
        error
      );
    }
  }

  return out;
}

export default aggregateVTKVisualizationState;
