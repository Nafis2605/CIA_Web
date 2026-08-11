// src/core/instances/types/vtk/features/VTKGlyphFeature.js

/**
 * VTK Glyph Rendering Feature
 *
 * Renders glyphs (arrows, cones, spheres, etc.) at data points.
 * Useful for:
 * - Vector field visualization (arrows show direction/magnitude)
 * - Tensor field visualization
 * - Point attribute visualization (size by scalar, color by scalar)
 *
 * @see https://kitware.github.io/vtk-js/examples/Glyph3DMapper.html
 */

import { FeatureInterface } from "@Core/instances/features/FeatureInterface.js";
import { render as log } from "@Utils/logger.js";

// VTK.js imports
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkArrowSource from "@kitware/vtk.js/Filters/Sources/ArrowSource";
import vtkConeSource from "@kitware/vtk.js/Filters/Sources/ConeSource";
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import vtkCubeSource from "@kitware/vtk.js/Filters/Sources/CubeSource";
import vtkCylinderSource from "@kitware/vtk.js/Filters/Sources/CylinderSource";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Available glyph types
 */
const GLYPH_TYPES = {
  arrow: {
    name: 'Arrow',
    description: 'Directional arrows',
    requiresOrientation: true,
    createSource: () => {
      const source = vtkArrowSource.newInstance();
      source.setTipLength(0.35);
      source.setTipRadius(0.1);
      source.setShaftRadius(0.03);
      return source;
    },
  },
  cone: {
    name: 'Cone',
    description: 'Conical glyphs',
    requiresOrientation: false,
    createSource: () => {
      const source = vtkConeSource.newInstance();
      source.setHeight(1.0);
      source.setRadius(0.25);
      source.setResolution(12);
      return source;
    },
  },
  sphere: {
    name: 'Sphere',
    description: 'Spherical glyphs',
    requiresOrientation: false,
    createSource: () => {
      const source = vtkSphereSource.newInstance();
      source.setRadius(0.5);
      source.setThetaResolution(16);
      source.setPhiResolution(16);
      return source;
    },
  },
  cube: {
    name: 'Cube',
    description: 'Cubic glyphs',
    requiresOrientation: false,
    createSource: () => {
      return vtkCubeSource.newInstance();
    },
  },
  cylinder: {
    name: 'Cylinder',
    description: 'Cylindrical glyphs',
    requiresOrientation: false,
    createSource: () => {
      const source = vtkCylinderSource.newInstance();
      source.setHeight(1.0);
      source.setRadius(0.25);
      source.setResolution(12);
      return source;
    },
  },
  dot: {
    name: 'Dot',
    description: 'Small point markers (no orientation needed)',
    requiresOrientation: false,
    createSource: () => {
      const source = vtkSphereSource.newInstance();
      source.setRadius(0.15);
      source.setThetaResolution(8);
      source.setPhiResolution(8);
      return source;
    },
  },
};

/**
 * Scaling modes. Values match vtk.js's real Glyph3DMapper scale-mode enum
 * (Rendering/Core/Glyph3DMapper/Constants.js: SCALE_BY_CONSTANT=0,
 * SCALE_BY_MAGNITUDE=1, SCALE_BY_COMPONENTS=2) — there is no mode 3. An
 * older version of this map used keys 'scalar'/'vector' that didn't match
 * vtk.js's actual semantics ('vector' pointed at mode 2, i.e. component
 * scaling, not magnitude/vector-length scaling), which made every
 * magnitude-scaled glyph render as an uncontrolled per-axis stretch. Any
 * stored config using the old key names falls back to the default via
 * normalizeGlyphConfig below, rather than being silently misinterpreted.
 */
const SCALING_MODES = {
  off: { name: 'No Scaling', mode: 0 },
  magnitude: { name: 'By Magnitude', mode: 1 },
  components: { name: 'By Components', mode: 2 },
};

/**
 * Orientation modes
 */
const ORIENTATION_MODES = {
  direction: { name: 'By Direction', mode: 0 },
  rotation: { name: 'By Rotation', mode: 1 },
  matrix: { name: 'By Matrix', mode: 2 },
};

/**
 * Default settings
 */
const DEFAULT_SETTINGS = {
  enabled: false,
  glyphType: 'arrow',
  scaleFactor: 1.0,
  scalingMode: 'magnitude',
  orientationMode: 'direction',
  orientationArray: null,
  scaleArray: null,
  colorArray: null,
  colorMode: 'solid', // 'solid' or 'scalar'
  solidColor: [0.2, 0.4, 0.9],
  density: 1.0, // fraction of points rendered: 1.0 = every point, 0.1 = ~10%
};

// Fraction below which density is meaningless (avoids near-zero glyph counts / div-by-huge-stride)
const MIN_DENSITY = 0.001;

// Point count above which density auto-limits, preserving the old "maxGlyphs" safety behavior
const AUTO_DENSITY_POINT_THRESHOLD = 10000;

/**
 * Deterministic (not fixed-phase) offset within a stride window, used by
 * _buildSubsampledPolydata. Same windowIndex always yields the same offset —
 * subsampling stays reproducible across renders/collaborators of the same
 * dataset+density — while not always picking index 0 of every window, which
 * biased subsampling toward whatever spatial/structural pattern correlates
 * with point-insertion order (e.g. always the same row/column of a
 * structured grid).
 * @param {number} windowIndex
 * @param {number} stride
 * @returns {number} offset in [0, stride)
 */
function _deterministicStrideOffset(windowIndex, stride) {
  if (stride <= 1) return 0;
  const h = (Math.imul(windowIndex + 0x9e3779b9, 0x85ebca6b) >>> 0);
  // The final >>> 0 matters: `^` coerces operands to SIGNED 32-bit before
  // XORing, so without it the result can be negative, making `% stride`
  // return a negative offset (JS % keeps the dividend's sign) — an
  // out-of-range, sometimes negative srcIndex.
  return (((h >>> 15) ^ h) >>> 0) % stride;
}

// =============================================================================
// VTK GLYPH FEATURE
// =============================================================================

export class VTKGlyphFeature extends FeatureInterface {
  constructor() {
    super();
    this.instanceStates = new Map();
  }

  /**
   * Get feature metadata
   */
  getMetadata() {
    return {
      id: 'VTKGlyphFeature',
      name: 'Glyph Rendering',
      description: 'Render glyphs at data points for vector/tensor visualization',
      version: '1.0.0',
      author: 'CIA Team',
    };
  }

  /**
   * Check if feature is available
   */
  isAvailable(instanceId, instanceData) {
    // Available for any mesh data with point or cell data
    return instanceData?.sceneObjects?.mapper != null;
  }

  /**
   * Initialize glyph feature
   */
  async initialize(instanceId, instanceData) {
    const { sceneObjects } = instanceData;

    if (!sceneObjects) {
      log.warn(`Cannot initialize glyph feature: no sceneObjects for ${instanceId}`);
      return;
    }

    const state = {
      ...DEFAULT_SETTINGS,
      sceneObjects,
      // Glyph rendering objects
      glyphMapper: null,
      glyphActor: null,
      glyphSource: null,
      colorTransferFunction: null,
      // Available arrays
      vectorArrays: [],
      scalarArrays: [],
      // Polydata references for density/subsampling
      basePolydata: null, // full-resolution polydata passed to enableGlyphs; owned by the dataset pipeline, never deleted here
      derivedPolydata: null, // strided subsample currently fed to glyphMapper input 0, or null when density === 1
      // Source-dataset point index a VR tool currently has selected (e.g. an
      // in-progress annotation/measurement anchor). Local-only — never synced
      // via getConfigForSync — so subsampling never silently hides the exact
      // point the user is interacting with. See setSelectedPoint.
      selectedSourcePointId: null,
    };

    this.instanceStates.set(instanceId, state);
    log.debug(`Glyph feature initialized for instance: ${instanceId}`);
  }

  /**
   * Clean up glyph resources
   */
  async cleanup(instanceId) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    this._disableGlyphs(state);

    this.instanceStates.delete(instanceId);
    log.debug(`Glyph feature cleaned up for instance: ${instanceId}`);
  }

  /**
   * Get current state
   */
  getState(instanceId) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return null;

    return {
      enabled: state.enabled,
      glyphType: state.glyphType,
      scaleFactor: state.scaleFactor,
      scalingMode: state.scalingMode,
      orientationArray: state.orientationArray,
      scaleArray: state.scaleArray,
      colorArray: state.colorArray,
      colorMode: state.colorMode,
      density: state.density,
      vectorArrays: state.vectorArrays,
      scalarArrays: state.scalarArrays,
    };
  }

  // ===========================================================================
  // ARRAY DISCOVERY
  // ===========================================================================

  /**
   * Scan polydata for vector and scalar arrays
   */
  scanAvailableArrays(instanceId, polydata) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    const pointData = polydata.getPointData();

    const vectorArrays = [];
    const scalarArrays = [];

    for (let i = 0; i < pointData.getNumberOfArrays(); i++) {
      const array = pointData.getArrayByIndex(i);
      if (!array) continue;

      const name = pointData.getArrayName(i) || `Array ${i}`;
      const numComponents = array.getNumberOfComponents();

      // A 3-component array is offered as a vector (orientation/scale)
      // candidate UNLESS its name looks like RGB color data — vtk.js data
      // arrays carry no reliable "this is color" flag, so this is a
      // heuristic, but it keeps an actual color array from being handed to
      // setOrientationArray as if it were a direction field.
      if (numComponents === 3 && !/^(rgb|rgba|colors?)$/i.test(name)) {
        vectorArrays.push({ name, index: i, components: numComponents });
      } else if (numComponents === 1) {
        // Scalar array
        const range = array.getRange();
        scalarArrays.push({ name, index: i, components: numComponents, range: [range[0], range[1]] });
      }
    }

    state.vectorArrays = vectorArrays;
    state.scalarArrays = scalarArrays;

    log.debug(`Found ${vectorArrays.length} vector arrays, ${scalarArrays.length} scalar arrays for glyphs`);

    return { vectorArrays, scalarArrays };
  }

  // ===========================================================================
  // GLYPH CONTROLS
  // ===========================================================================

  /**
   * Enable glyph rendering
   */
  enableGlyphs(instanceId, polydata, options = {}) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    const { sceneObjects } = state;
    const { renderer, renderWindow, actor } = sceneObjects;

    if (!renderer) {
      log.warn('Cannot enable glyphs: no renderer');
      return;
    }

    // Capture the main actor's visibility/point-size ONCE, before glyphs ever
    // touch it, so disableGlyphs can restore whatever threshold/isosurface/
    // user styling had set — rather than unconditionally forcing them to
    // fixed values. Guarded so repeated enable calls (e.g. changing glyph
    // type) without an intervening disable don't overwrite the real
    // pre-glyph snapshot with a glyph-era one.
    if (actor && !state._preGlyphStateCaptured) {
      state.preGlyphActorVisibility =
        typeof actor.getVisibility === 'function' ? actor.getVisibility() : true;
      state.preGlyphPointSize =
        typeof actor.getProperty === 'function' ? actor.getProperty().getPointSize() : 1;
      state._preGlyphStateCaptured = true;
    }

    // Merge options with defaults
    Object.assign(state, options);

    // Create glyph source
    const glyphTypeConfig = GLYPH_TYPES[state.glyphType];
    const glyphSource = glyphTypeConfig.createSource();

    // Track the full-resolution source; not owned/deleted by this feature
    state.basePolydata = polydata;

    // Auto-limit density for very large datasets unless caller specified one explicitly
    const numPoints = polydata.getNumberOfPoints();
    if (options.density === undefined && numPoints > AUTO_DENSITY_POINT_THRESHOLD) {
      state.density = AUTO_DENSITY_POINT_THRESHOLD / numPoints;
      log.warn(`Too many points (${numPoints}), auto-limiting glyph density to ${state.density.toFixed(3)}`);
    }

    // Build the mapper input: subsampled polydata when density < 1, otherwise the base polydata directly
    const mapperInput = state.density >= 1
      ? polydata
      : this._buildSubsampledPolydata(polydata, state.density, state.selectedSourcePointId);
    state.derivedPolydata = mapperInput === polydata ? null : mapperInput;

    // Create glyph mapper
    const glyphMapper = vtkGlyph3DMapper.newInstance();
    glyphMapper.setInputData(mapperInput, 0);
    glyphMapper.setInputConnection(glyphSource.getOutputPort(), 1);
    glyphMapper.setScaleFactor(state.scaleFactor);

    // Configure scaling mode — only if a usable backing array actually
    // exists, otherwise vtk.js's own Glyph3DMapper.buildArrays errors
    // internally (components mode with no valid 3-component array) or
    // silently scales by whatever active scalars happen to be present
    // (magnitude mode with no scaleArray and no active scalars). Degrade to
    // 'off' rather than misconfigure the mapper.
    const scalingConfig = SCALING_MODES[state.scalingMode];
    const mapperPointData = mapperInput.getPointData();
    if (scalingConfig.mode !== 0 && !this._hasUsableScaleArray(mapperPointData, scalingConfig.mode, state.scaleArray)) {
      log.warn(
        `Glyph scaling mode '${state.scalingMode}' has no usable array (scaleArray: ${state.scaleArray || 'none'}) — degrading to 'off'`
      );
      state.scalingMode = 'off';
    }
    const effectiveScalingConfig = SCALING_MODES[state.scalingMode];
    glyphMapper.setScaling(effectiveScalingConfig.mode !== 0);
    glyphMapper.setScaleMode(effectiveScalingConfig.mode);

    // Set orientation array if specified
    if (state.orientationArray) {
      glyphMapper.setOrientationArray(state.orientationArray);
      glyphMapper.setOrientationMode(0); // Direction mode
    }

    // Set scale array if specified
    if (state.scaleArray) {
      glyphMapper.setScaleArray(state.scaleArray);
    }

    // Create actor
    const glyphActor = vtkActor.newInstance();
    glyphActor.setMapper(glyphMapper);

    // Set color
    let colorTransferFunction = null;
    if (state.colorMode === 'solid') {
      glyphActor.getProperty().setColor(...state.solidColor);
      glyphMapper.setScalarVisibility(false);
    } else if (state.colorArray) {
      colorTransferFunction = this._configureScalarColoring(glyphMapper, mapperInput, state.colorArray);
    }

    // Add to renderer
    renderer.addActor(glyphActor);

    // Store references
    state.glyphSource = glyphSource;
    state.glyphMapper = glyphMapper;
    state.glyphActor = glyphActor;
    state.colorTransferFunction = colorTransferFunction;
    state.enabled = true;

    renderWindow?.render();

    log.debug(`Glyphs enabled: ${state.glyphType}`);
  }

  /**
   * Disable glyph rendering
   */
  disableGlyphs(instanceId) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    // Restore whatever visibility/point-size the main actor had BEFORE
    // glyphs were ever enabled (captured once in enableGlyphs), instead of
    // unconditionally forcing visible/size-5 — which could override
    // threshold/isosurface or user styling that had the actor hidden or
    // sized differently on purpose.
    const { actor } = state.sceneObjects || {};
    if (actor && state._preGlyphStateCaptured) {
      actor.setVisibility(state.preGlyphActorVisibility);
      actor.getProperty().setPointSize(state.preGlyphPointSize);
    }

    this._disableGlyphs(state);

    state.sceneObjects.renderWindow?.render();

    log.debug(`Glyphs disabled for instance: ${instanceId}`);
  }

  /**
   * Internal disable
   */
  _disableGlyphs(state) {
    const { sceneObjects, glyphActor, glyphMapper, glyphSource, colorTransferFunction, derivedPolydata } = state;
    const { renderer } = sceneObjects || {};

    if (glyphActor && renderer) {
      renderer.removeActor(glyphActor);
      glyphActor.delete();
    }

    if (glyphMapper) {
      glyphMapper.delete();
    }

    if (glyphSource) {
      glyphSource.delete();
    }

    if (colorTransferFunction) {
      colorTransferFunction.delete();
    }

    // Derived (subsampled) polydata is owned by this feature; basePolydata belongs to the dataset pipeline
    if (derivedPolydata) {
      derivedPolydata.delete();
    }

    state.glyphActor = null;
    state.glyphMapper = null;
    state.glyphSource = null;
    state.colorTransferFunction = null;
    state.derivedPolydata = null;
    state.basePolydata = null;
    state.enabled = false;
    // Next enableGlyphs() should capture a FRESH pre-glyph snapshot, since
    // the actor's visibility/point-size may have changed while glyphs were on.
    state._preGlyphStateCaptured = false;
    state.preGlyphActorVisibility = undefined;
    state.preGlyphPointSize = undefined;
  }

  /**
   * Set glyph type
   */
  setGlyphType(instanceId, type) {
    const state = this.instanceStates.get(instanceId);
    if (!state || !GLYPH_TYPES[type]) return;

    state.glyphType = type;

    if (state.enabled && state.glyphMapper) {
      // Recreate glyph source
      if (state.glyphSource) {
        state.glyphSource.delete();
      }

      const glyphTypeConfig = GLYPH_TYPES[type];
      const glyphSource = glyphTypeConfig.createSource();
      state.glyphSource = glyphSource;

      state.glyphMapper.setInputConnection(glyphSource.getOutputPort(), 1);
      state.sceneObjects.renderWindow?.render();
    }

    log.debug(`Glyph type set to: ${type}`);
  }

  /**
   * Set scale factor
   */
  setScaleFactor(instanceId, factor) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    state.scaleFactor = Math.max(0.001, factor);

    if (state.glyphMapper) {
      state.glyphMapper.setScaleFactor(state.scaleFactor);
      state.sceneObjects.renderWindow?.render();
    }
  }

  /**
   * Set orientation array
   */
  setOrientationArray(instanceId, arrayName) {
    const state = this.instanceStates.get(instanceId);
    if (!state || !state.glyphMapper) return;

    state.orientationArray = arrayName;

    if (arrayName) {
      state.glyphMapper.setOrientationArray(arrayName);
      state.glyphMapper.setOrientationMode(0);
    }

    state.sceneObjects.renderWindow?.render();
  }

  /**
   * Set solid color
   */
  setSolidColor(instanceId, rgb) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    state.colorMode = 'solid';
    state.solidColor = rgb;

    if (state.glyphActor) {
      state.glyphActor.getProperty().setColor(...rgb);
      state.glyphMapper?.setScalarVisibility(false);
      if (state.colorTransferFunction) {
        state.colorTransferFunction.delete();
        state.colorTransferFunction = null;
      }
      state.sceneObjects.renderWindow?.render();
    }
  }

  /**
   * Set color mode ('solid' or 'scalar') and, for scalar mode, which array to color by
   */
  setColorMode(instanceId, mode, arrayName = null) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    state.colorMode = mode;
    if (mode === 'scalar' && arrayName) {
      state.colorArray = arrayName;
    }

    if (!state.glyphMapper || !state.glyphActor) return;

    if (mode === 'solid') {
      state.glyphActor.getProperty().setColor(...state.solidColor);
      state.glyphMapper.setScalarVisibility(false);
      if (state.colorTransferFunction) {
        state.colorTransferFunction.delete();
        state.colorTransferFunction = null;
      }
    } else if (mode === 'scalar' && state.colorArray) {
      if (state.colorTransferFunction) {
        state.colorTransferFunction.delete();
      }
      const mapperInput = state.glyphMapper.getInputData(0);
      state.colorTransferFunction = this._configureScalarColoring(state.glyphMapper, mapperInput, state.colorArray);
    }

    state.sceneObjects.renderWindow?.render();
  }

  /**
   * Configure scalar coloring on a glyph mapper with an actual lookup table
   * and data range (mirrors VTKScalarColoringFeature's pattern). Without
   * this, vtk.js defaults to scalarRange [0,1] and an auto-generated lookup
   * table, which essentially never matches the real data's range.
   * @returns {object} the created vtkColorTransferFunction (caller owns its lifecycle)
   */
  _configureScalarColoring(mapper, polydata, arrayName) {
    const array = polydata?.getPointData()?.getArrayByName(arrayName);
    const range = array ? array.getRange() : [0, 1];

    const ctfun = vtkColorTransferFunction.newInstance();
    ctfun.addRGBPoint(range[0], 0, 0, 0);
    ctfun.addRGBPoint(range[1], 1, 1, 1);

    mapper.setScalarVisibility(true);
    mapper.setColorByArrayName(arrayName);
    mapper.setLookupTable(ctfun);
    mapper.setScalarRange(range[0], range[1]);

    return ctfun;
  }

  /**
   * Set scaling mode and, optionally, the array it scales by. Re-validates
   * against the currently-bound polydata the same way enableGlyphs does,
   * degrading to 'off' rather than misconfiguring the mapper.
   */
  setScalingMode(instanceId, mode, scaleArray = null) {
    const state = this.instanceStates.get(instanceId);
    if (!state || !SCALING_MODES[mode]) return;

    state.scalingMode = mode;
    if (scaleArray !== undefined) state.scaleArray = scaleArray;

    if (!state.glyphMapper) return;

    const mapperInput = state.glyphMapper.getInputData(0);
    const pointData = mapperInput?.getPointData();
    const scalingConfig = SCALING_MODES[state.scalingMode];
    const usable =
      scalingConfig.mode === 0 ||
      (pointData && this._hasUsableScaleArray(pointData, scalingConfig.mode, state.scaleArray));
    if (!usable) {
      log.warn(`setScalingMode: '${mode}' has no usable array — degrading to 'off'`);
      state.scalingMode = 'off';
    }

    const effective = SCALING_MODES[state.scalingMode];
    state.glyphMapper.setScaling(effective.mode !== 0);
    state.glyphMapper.setScaleMode(effective.mode);
    if (state.scaleArray) {
      state.glyphMapper.setScaleArray(state.scaleArray);
    }

    state.sceneObjects.renderWindow?.render();
  }

  /**
   * Whether polydata has an array that would actually back the given
   * Glyph3DMapper scale mode. 'components' mode strictly needs a genuine
   * 3-component array (a named scaleArray, or the active vectors);
   * 'magnitude' mode accepts any named scaleArray or falls back to whatever
   * active scalars/vectors vtk.js itself would use.
   */
  _hasUsableScaleArray(pointData, mode, scaleArrayName) {
    if (mode === SCALING_MODES.components.mode) {
      const named = scaleArrayName ? pointData.getArrayByName(scaleArrayName) : null;
      if (named && named.getNumberOfComponents() === 3) return true;
      return pointData.getVectors()?.getNumberOfComponents() === 3;
    }
    // magnitude mode
    if (scaleArrayName && pointData.hasArray(scaleArrayName)) return true;
    return !!(pointData.getScalars() || pointData.getVectors());
  }

  /**
   * Set glyph density (fraction of points rendered, 0 < density <= 1). Rebuilds the mapper's
   * point-data input as a strided subsample and disposes the previous derived polydata.
   */
  setDensity(instanceId, density) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    state.density = Math.min(1, Math.max(MIN_DENSITY, density));

    if (!state.enabled || !state.glyphMapper || !state.basePolydata) return;

    const previousDerived = state.derivedPolydata;
    const nextInput = state.density >= 1
      ? state.basePolydata
      : this._buildSubsampledPolydata(state.basePolydata, state.density, state.selectedSourcePointId);

    state.glyphMapper.setInputData(nextInput, 0);
    state.derivedPolydata = nextInput === state.basePolydata ? null : nextInput;

    if (previousDerived && previousDerived !== nextInput) {
      previousDerived.delete();
    }

    state.sceneObjects.renderWindow?.render();
    log.debug(`Glyph density set to ${state.density} for ${instanceId}`);
  }

  /**
   * Mark a source-dataset point index as "currently selected" (e.g. a VR
   * tool's in-progress annotation/measurement anchor), so subsequent glyph
   * subsampling force-includes it rather than silently hiding it. Rebuilds
   * the subsampled input immediately if glyphs are enabled below density 1,
   * mirroring setDensity.
   */
  setSelectedPoint(instanceId, sourcePointId) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    state.selectedSourcePointId = sourcePointId ?? null;
    this._refreshSubsampleForSelection(instanceId);
  }

  /**
   * Clear the current selection (annotation/measurement session ended) so
   * subsampling reverts to its normal stride pattern.
   */
  clearSelectedPoint(instanceId) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    state.selectedSourcePointId = null;
    this._refreshSubsampleForSelection(instanceId);
  }

  /**
   * Shared by setSelectedPoint/clearSelectedPoint: rebuild the glyph
   * mapper's subsampled input so a selection change is reflected immediately,
   * without duplicating setDensity's rebuild/dispose logic.
   * @private
   */
  _refreshSubsampleForSelection(instanceId) {
    const state = this.instanceStates.get(instanceId);
    if (!state?.enabled || !state.glyphMapper || !state.basePolydata || state.density >= 1) {
      return;
    }
    this.setDensity(instanceId, state.density);
  }

  /**
   * Build a subsample of polydata (points + all point-data arrays) for glyph density control.
   * A real derived vtk.js polydata source, not a rendering hack.
   * @param {number|null} [selectedSourcePointId] - a source-dataset point index
   *   that must survive subsampling (e.g. a VR tool's in-progress annotation/
   *   measurement anchor) even if the stride pattern wouldn't otherwise pick
   *   it. Appended as an extra slot when missing, never displaces an already-
   *   sampled point.
   */
  _buildSubsampledPolydata(polydata, density, selectedSourcePointId = null) {
    const points = polydata.getPoints();
    const srcXYZ = points.getData();
    const numPoints = points.getNumberOfPoints();
    const clamped = Math.min(1, Math.max(MIN_DENSITY, density));
    const stride = Math.max(1, Math.round(1 / clamped));

    if (stride <= 1) return polydata;

    const keepCount = Math.max(1, Math.ceil(numPoints / stride));

    // Which source point backs each output slot, computed once. A
    // deterministic (not always-index-0) offset within each stride window
    // avoids systematically favoring whatever spatial/structural pattern
    // correlates with point-insertion order (e.g. always the same row/column
    // of a structured grid) — while staying reproducible across renders of
    // the same dataset+density, unlike true randomness would be.
    const srcIndexList = [];
    for (let d = 0, w = 0; d < keepCount; d++, w++) {
      const offset = _deterministicStrideOffset(w, stride);
      srcIndexList.push(Math.min(w * stride + offset, numPoints - 1));
    }

    // Force-include the currently selected point so it never silently
    // disappears from view just because it fell outside the stride pattern.
    if (
      selectedSourcePointId != null &&
      selectedSourcePointId >= 0 &&
      selectedSourcePointId < numPoints &&
      !srcIndexList.includes(selectedSourcePointId)
    ) {
      srcIndexList.push(selectedSourcePointId);
    }

    const srcIndices = Int32Array.from(srcIndexList);
    const finalCount = srcIndices.length;

    const dstXYZ = new Float32Array(finalCount * 3);
    for (let d = 0; d < finalCount; d++) {
      const srcIndex = srcIndices[d];
      dstXYZ[d * 3] = srcXYZ[srcIndex * 3];
      dstXYZ[d * 3 + 1] = srcXYZ[srcIndex * 3 + 1];
      dstXYZ[d * 3 + 2] = srcXYZ[srcIndex * 3 + 2];
    }

    const newPoints = vtkPoints.newInstance();
    newPoints.setData(dstXYZ, 3);

    const derived = vtkPolyData.newInstance();
    derived.setPoints(newPoints);

    // Carry every point-data array along with the SAME sampled indices so array[i] still matches point[i]
    const srcPointData = polydata.getPointData();
    const dstPointData = derived.getPointData();
    for (let i = 0; i < srcPointData.getNumberOfArrays(); i++) {
      const array = srcPointData.getArrayByIndex(i);
      if (!array) continue;

      const numComponents = array.getNumberOfComponents();
      const srcValues = array.getData();
      const dstValues = new srcValues.constructor(finalCount * numComponents);
      for (let d = 0; d < finalCount; d++) {
        const srcIndex = srcIndices[d];
        for (let c = 0; c < numComponents; c++) {
          dstValues[d * numComponents + c] = srcValues[srcIndex * numComponents + c];
        }
      }

      dstPointData.addArray(vtkDataArray.newInstance({
        name: srcPointData.getArrayName(i) || `Array ${i}`,
        numberOfComponents: numComponents,
        values: dstValues,
      }));
    }

    // addArray alone doesn't assign scalar/vector "role" — preserve whichever
    // array was ACTIVE on the source, so Glyph3DMapper's scale/orient
    // fallback (which reads getScalars()/getVectors()) keeps working on
    // subsampled data even though the named array is present either way.
    const srcScalarsName = srcPointData.getScalars()?.getName();
    const srcVectorsName = srcPointData.getVectors()?.getName();
    if (srcScalarsName) dstPointData.setActiveScalars(srcScalarsName);
    if (srcVectorsName) dstPointData.setActiveVectors(srcVectorsName);

    // Record which source point each surviving glyph came from, so a pick
    // against this (regenerated-on-density-change) geometry can be traced
    // back to a real point index in the original, full-resolution dataset.
    dstPointData.addArray(vtkDataArray.newInstance({
      name: 'SourcePointId',
      numberOfComponents: 1,
      values: srcIndices,
    }));

    return derived;
  }

  // ===========================================================================
  // DECLARATIVE CONFIG SYNC (for collaborative/remote state)
  // ===========================================================================

  /**
   * Current state as a plain, normalized declarative object suitable for pushing to Y.js.
   * Never includes runtime VTK objects or discovered array metadata (peers recompute arrays
   * from their own polydata via scanAvailableArrays).
   */
  getConfigForSync(instanceId) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return normalizeGlyphConfig({});

    return normalizeGlyphConfig({
      enabled: state.enabled,
      glyphType: state.glyphType,
      scaleFactor: state.scaleFactor,
      scalingMode: state.scalingMode,
      orientationArray: state.orientationArray,
      scaleArray: state.scaleArray,
      colorArray: state.colorArray,
      colorMode: state.colorMode,
      solidColor: state.solidColor,
      density: state.density,
    });
  }

  /**
   * Apply an incoming (remote/collaborative) declarative glyph config, normalizing first so
   * malformed or missing fields never throw. Applies only the fields that changed via the
   * existing setters when already enabled, to avoid actor churn/duplication on repeated syncs.
   */
  applyRemoteConfig(instanceId, polydata, rawConfig) {
    const state = this.instanceStates.get(instanceId);
    if (!state) return;

    const config = normalizeGlyphConfig(rawConfig);

    if (!config.enabled) {
      if (state.enabled) this.disableGlyphs(instanceId);
      return;
    }

    if (!polydata) {
      log.warn(`applyRemoteConfig: cannot enable glyphs for ${instanceId}, no polydata available`);
      return;
    }

    if (!state.enabled) {
      this.enableGlyphs(instanceId, polydata, config);
      return;
    }

    // Already enabled — apply only what changed via existing setters
    if (config.glyphType !== state.glyphType) {
      this.setGlyphType(instanceId, config.glyphType);
    }
    if (config.scaleFactor !== state.scaleFactor) {
      this.setScaleFactor(instanceId, config.scaleFactor);
    }
    if (config.orientationArray !== state.orientationArray) {
      this.setOrientationArray(instanceId, config.orientationArray);
    }
    if (config.scalingMode !== state.scalingMode || config.scaleArray !== state.scaleArray) {
      this.setScalingMode(instanceId, config.scalingMode, config.scaleArray);
    }
    if (
      config.colorMode !== state.colorMode ||
      config.colorArray !== state.colorArray ||
      JSON.stringify(config.solidColor) !== JSON.stringify(state.solidColor)
    ) {
      if (config.colorMode === 'solid') {
        this.setSolidColor(instanceId, config.solidColor);
      } else {
        this.setColorMode(instanceId, 'scalar', config.colorArray);
      }
    }
    if (config.density !== state.density) {
      this.setDensity(instanceId, config.density);
    }
  }
}

// =============================================================================
// PURE HELPERS (exported for UI + testing without a feature instance)
// =============================================================================

/**
 * Whether at least one vector (3-component) array is available for orientation
 */
export function isVectorOrientationAvailable(vectorArrays) {
  return Array.isArray(vectorArrays) && vectorArrays.length > 0;
}

/**
 * Whether the glyph feature has anything to render at all. A vector or
 * scalar array unlocks orientation/scaling by data, but even a point-only
 * dataset (no arrays whatsoever) can still render constant-scale sphere/dot
 * glyphs at every point — so `hasPoints` alone is enough to make the
 * feature available, just with fewer glyph-type/scaling options.
 * @param {Array} vectorArrays
 * @param {Array} scalarArrays
 * @param {boolean} [hasPoints=false] whether the dataset has at least one point
 */
export function isGlyphFeatureAvailable(vectorArrays, scalarArrays, hasPoints = false) {
  return (
    isVectorOrientationAvailable(vectorArrays) ||
    (Array.isArray(scalarArrays) && scalarArrays.length > 0) ||
    !!hasPoints
  );
}

/**
 * Glyph type ids that require vector orientation but have no vector array available
 */
export function getDisabledGlyphTypes(vectorArrays) {
  const hasVectors = isVectorOrientationAvailable(vectorArrays);
  return Object.entries(GLYPH_TYPES)
    .filter(([, config]) => config.requiresOrientation && !hasVectors)
    .map(([id]) => id);
}

/**
 * Normalize a plain glyph config object, defaulting/clamping every field so malformed or
 * missing (e.g. old/pre-glyph) config never crashes the caller.
 */
export function normalizeGlyphConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const glyphType = GLYPH_TYPES[source.glyphType] ? source.glyphType : DEFAULT_SETTINGS.glyphType;
  const scalingMode = SCALING_MODES[source.scalingMode] ? source.scalingMode : DEFAULT_SETTINGS.scalingMode;
  const colorMode = source.colorMode === 'scalar' ? 'scalar' : 'solid';
  const scaleFactor = Number.isFinite(source.scaleFactor) && source.scaleFactor > 0
    ? source.scaleFactor
    : DEFAULT_SETTINGS.scaleFactor;
  const density = Number.isFinite(source.density)
    ? Math.min(1, Math.max(MIN_DENSITY, source.density))
    : DEFAULT_SETTINGS.density;
  const solidColor = Array.isArray(source.solidColor) && source.solidColor.length === 3
    ? source.solidColor
    : DEFAULT_SETTINGS.solidColor;

  return {
    enabled: !!source.enabled,
    glyphType,
    scaleFactor,
    scalingMode,
    orientationArray: typeof source.orientationArray === 'string' ? source.orientationArray : null,
    scaleArray: typeof source.scaleArray === 'string' ? source.scaleArray : null,
    colorArray: typeof source.colorArray === 'string' ? source.colorArray : null,
    colorMode,
    solidColor,
    density,
  };
}

// Export singleton instance
export const vtkGlyphFeature = new VTKGlyphFeature();
export default vtkGlyphFeature;
