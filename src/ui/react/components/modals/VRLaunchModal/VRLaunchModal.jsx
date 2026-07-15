/**
 * @file VRLaunchModal.jsx
 * @description Modal for configuring and launching a VR exploration session.
 *
 * Features:
 * - Choose navigation mode (fly, teleport, walk, orbit)
 * - Set initial VR scale
 * - Launch VR session
 */

import React, { memo, useState, useCallback, useEffect, useMemo } from "react";
import { Icon, getIconComponent } from "@UI/react/components/atoms/Icon";
import { Modal } from "../Modal";
import { Button } from "@UI/react/components/atoms/Button";
import { vrManager } from "@Core/vr/VRManager.js";
import { vrExplorationManager } from "@Core/vr/VRExplorationManager.js";
import { toast } from "@UI/react/store/toastStore.js";
import "./VRLaunchModal.scss";

/**
 * Navigation mode options
 */
const NAVIGATION_MODES = [
  {
    id: "fly",
    label: "Fly",
    description: "Free movement in 3D space",
    icon: "plane",
  },
  {
    id: "teleport",
    label: "Teleport",
    description: "Point-and-click movement",
    icon: "cursor",
  },
  {
    id: "walk",
    label: "Walk",
    description: "Ground-based movement",
    icon: "footprints",
  },
  {
    id: "orbit",
    label: "Orbit",
    description: "Rotate around center point",
    icon: "orbit",
  },
];

/**
 * Scale preset options
 */
// vrScale follows VTKInstanceHandler._updateCameraFromVRPose's mapping
// (dataPos = xrPos/vrScale + vrOrigin): a SMALL vrScale means a given
// physical step covers a LARGE data-space distance (overview — the whole
// dataset fits in a normal room), a LARGE vrScale means a physical step
// covers only a tiny data-space distance (zoomed into fine detail). Matches
// the auto-fit/isolation convention (vrScale = 2.5 / dataset diagonal).
const SCALE_PRESETS = [
  { id: "overview", label: "Overview", scale: 0.1, description: "See the whole dataset" },
  { id: "normal", label: "Normal", scale: 1.0, description: "1:1 scale" },
  { id: "detail", label: "Detail", scale: 10.0, description: "10x magnification" },
  { id: "micro", label: "Micro", scale: 100.0, description: "100x magnification" },
];

/**
 * VRLaunchModal - Modal for launching VR exploration sessions
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether modal is visible
 * @param {() => void} props.onClose - Close handler
 * @param {string} props.instanceId - The workspace instance to explore in VR
 * @param {Object} props.dataset - The dataset to explore
 * @param {Object} props.viewConfig - Current view configuration
 * @param {string} props.projectId - Project ID for the session
 * @param {Function} props.onLaunch - Callback when session is launched
 * @param {string} props.className - Additional CSS class
 */
function VRLaunchModal({
  isOpen,
  onClose,
  instanceId,
  dataset,
  viewConfig,
  projectId,
  onLaunch,
  className = "",
}) {
  // VR support state
  const [vrSupported, setVrSupported] = useState(null);
  const [vrCapabilities, setVrCapabilities] = useState(null);
  const [checkingSupport, setCheckingSupport] = useState(true);

  // Configuration state
  const [navigationMode, setNavigationMode] = useState("teleport");
  const [scalePreset, setScalePreset] = useState("normal");
  const [customScale, setCustomScale] = useState(1.0);
  const [useCustomScale, setUseCustomScale] = useState(false);

  // UI state
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState("");

  // Check VR support when modal opens
  useEffect(() => {
    if (isOpen) {
      checkVRSupport();
    }
  }, [isOpen]);

  /**
   * Check VR capabilities
   */
  const checkVRSupport = useCallback(async () => {
    setCheckingSupport(true);
    setError("");

    try {
      const isSupported = vrManager.isVRSupported();
      setVrSupported(isSupported);

      if (isSupported) {
        const capabilities = await vrManager.checkVRCapabilities();
        setVrCapabilities(capabilities);
      }
    } catch (err) {
      console.error("VR support check failed:", err);
      setError("Failed to check VR support");
      setVrSupported(false);
    } finally {
      setCheckingSupport(false);
    }
  }, []);

  // Derive effective scale
  const effectiveScale = useMemo(() => {
    if (useCustomScale) {
      return customScale;
    }
    const preset = SCALE_PRESETS.find((p) => p.id === scalePreset);
    return preset?.scale || 1.0;
  }, [useCustomScale, customScale, scalePreset]);

  /**
   * Handle launching the VR session.
   *
   * Delegates everything to vrExplorationManager.startExploration(), which
   * is the single path that: registers the session with the server (via
   * apiClient, not a raw unauthenticated fetch), requests the XR session
   * through VRManager (the sole session owner), and enters VR exploration
   * on the handler with a working WebGL/XRWebGLLayer already attached.
   */
  const handleLaunch = useCallback(async () => {
    if (!vrSupported || !dataset || !instanceId) return;

    setIsLaunching(true);
    setError("");

    try {
      const sessionConfig = {
        viewConfigurationId: viewConfig?.id,
        datasetId: dataset.id,
        projectId,
        explorationMode: navigationMode,
        vrScale: effectiveScale,
      };

      const session = await vrExplorationManager.startExploration(instanceId, sessionConfig);

      toast.success("VR session started");

      // Notify parent
      if (onLaunch) {
        onLaunch(session);
      }

      onClose();
    } catch (err) {
      console.error("Failed to launch VR session:", err);
      setError(err.message || "Failed to launch VR session");
      toast.error(`VR launch failed: ${err.message}`);
    } finally {
      setIsLaunching(false);
    }
  }, [
    vrSupported,
    dataset,
    instanceId,
    viewConfig,
    projectId,
    navigationMode,
    effectiveScale,
    onLaunch,
    onClose,
  ]);

  // Build class names
  const contentClassNames = ["vr-launch-modal", className].filter(Boolean).join(" ");

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Launch VR Exploration"
      icon={getIconComponent("vr")}
      severity="info"
      size="md"
      footer={
        <div className="vr-launch-modal__footer">
          <Button variant="ghost" onClick={onClose} disabled={isLaunching}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleLaunch}
            loading={isLaunching}
            disabled={!vrSupported || checkingSupport || isLaunching || !instanceId}
            icon={getIconComponent("vr")}
          >
            {isLaunching ? "Launching..." : "Enter VR"}
          </Button>
        </div>
      }
    >
      <div className={contentClassNames}>
        {/* VR Support Status */}
        {checkingSupport && (
          <div className="vr-launch-modal__status vr-launch-modal__status--checking">
            <Icon name="loader" size={16} className="vr-launch-modal__spinner" />
            <span>Checking VR support...</span>
          </div>
        )}

        {!checkingSupport && !vrSupported && (
          <div className="vr-launch-modal__status vr-launch-modal__status--unsupported">
            <Icon name="warning" size={16} />
            <span>WebXR is not supported in this browser or no VR headset is connected.</span>
          </div>
        )}

        {!checkingSupport && vrSupported && vrCapabilities && (
          <div className="vr-launch-modal__status vr-launch-modal__status--supported">
            <Icon name="check" size={16} />
            <span>VR headset detected (Meta Quest Browser recommended)</span>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="vr-launch-modal__error" role="alert">
            <Icon name="alertCircle" size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* Dataset info */}
        {dataset && (
          <div className="vr-launch-modal__section">
            <h4 className="vr-launch-modal__section-title">Dataset</h4>
            <div className="vr-launch-modal__dataset-info">
              <Icon name="cube" size={16} />
              <span>{dataset.filename || dataset.name}</span>
            </div>
          </div>
        )}

        {/* Navigation Mode */}
        <div className="vr-launch-modal__section">
          <h4 className="vr-launch-modal__section-title">Navigation Mode</h4>
          <div className="vr-launch-modal__mode-grid">
            {NAVIGATION_MODES.map((mode) => (
              <button
                key={mode.id}
                className={`vr-launch-modal__mode-option ${navigationMode === mode.id ? "vr-launch-modal__mode-option--active" : ""}`}
                onClick={() => setNavigationMode(mode.id)}
                disabled={!vrSupported}
              >
                <Icon name={mode.icon} size={20} />
                <span className="vr-launch-modal__mode-label">{mode.label}</span>
                <span className="vr-launch-modal__mode-desc">{mode.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Scale Settings */}
        <div className="vr-launch-modal__section">
          <h4 className="vr-launch-modal__section-title">Initial Scale</h4>
          <div className="vr-launch-modal__scale-presets">
            {SCALE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`vr-launch-modal__scale-preset ${!useCustomScale && scalePreset === preset.id ? "vr-launch-modal__scale-preset--active" : ""}`}
                onClick={() => {
                  setScalePreset(preset.id);
                  setUseCustomScale(false);
                }}
                disabled={!vrSupported}
                title={preset.description}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="vr-launch-modal__custom-scale">
            <label>
              <input
                type="checkbox"
                checked={useCustomScale}
                onChange={(e) => setUseCustomScale(e.target.checked)}
                disabled={!vrSupported}
              />
              Custom scale:
            </label>
            <input
              type="number"
              min="0.001"
              max="100"
              step="0.1"
              value={customScale}
              onChange={(e) => setCustomScale(parseFloat(e.target.value) || 1.0)}
              disabled={!vrSupported || !useCustomScale}
              className="vr-launch-modal__scale-input"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default memo(VRLaunchModal);
export { VRLaunchModal };
