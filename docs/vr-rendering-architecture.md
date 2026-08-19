# ADR: VR Rendering Architecture — Server Preprocesses, Headset Renders Locally

> Related: [`docs/server-rendering.md`](./server-rendering.md) documents the separate desktop
> server-rendered viewport (PNG-over-WebSocket). See its "Not connected to VR" paragraph for why
> that path does not and cannot currently back VR — this document is the fuller ADR for the VR
> side of that boundary, and the two are meant to be read together.

## Status

Accepted. Already implemented — this document records the decision that is currently running in
the code, not a proposal.

## Context

Two hard constraints collide for VR on this platform:

1. **Headset GPU limits.** The supported VR clients (Meta Quest 2, Apple Vision Pro/Safari) are
   mobile-class GPUs. Scientific datasets loaded elsewhere in CIA Web routinely run into the tens
   or hundreds of millions of points/polygons (see `THRESHOLDS.POINTS_HIGH` = 10M,
   `THRESHOLDS.POLYGONS_HIGH` = 5M in `server/src/services/vrPreprocessing.js`) — well beyond what
   a standalone headset can hold in memory or rasterize at a stereo-VR-acceptable frame rate.
2. **WebXR needs a local, low-latency render loop.** A headset render loop must turn head pose
   into a new stereo frame in well under the ~20ms motion-to-photon budget most WebXR runtimes
   expect, or users get simulator sickness. That loop has to run against a GPU context physically
   attached to the display.

Those two constraints look like they pull in opposite directions — "the dataset is too big for
the headset" suggests moving rendering off the headset, but "stereo VR needs a local low-latency
loop" says rendering has to stay on the headset. The resolution is to split what "too big" means:
it's a *dataset-size* problem, not a *per-frame-rendering* problem, and each half is solved
independently (see Decision).

## Decision

- **The server preprocesses; the headset renders.** `server/src/services/vrPreprocessing.js`
  reduces dataset complexity ahead of time — LOD mesh generation (`levels: [1.0, 0.5, 0.25, 0.1]`,
  `PreprocessingOps.LOD_GENERATION`), octree construction for large point clouds
  (`PreprocessingOps.OCTREE_BUILD`), bounds/centroid calculation
  (`PreprocessingOps.BOUNDS_CALC`), and texture compression (`PreprocessingOps.TEXTURE_COMPRESS`).
  This is queued through BullMQ (`startPreprocessing`) and tracked to completion
  (`getPreprocessingStatus` / `isReadyForVR`).
- **VR always renders locally via WebXR**, using the reduced data. `VRExplorationManager`
  requires a local WebGL/VTK rendering context and hands it directly to
  `vrManager.enterVR(glContext, ...)`; there is no server-rendered-frame fallback path for VR.
  This holds regardless of `RENDER_MODE` — VR does not participate in the desktop
  server-rendering feature at all.

## Rationale

**Head-locked stereo motion-to-photon latency is a different problem class from a mouse-driven 2D
viewport.** The desktop server-rendering path (`RemoteRenderClient.js` /
`ServerRenderedViewport.jsx`, documented in `docs/server-rendering.md`) tolerates real,
user-visible latency: a mouse-drag camera update round-trips over a WebSocket, the server
re-renders, and a new PNG arrives — a gap of tens to low-hundreds of milliseconds reads as "a bit
laggy," not as sickness-inducing, because the viewer's head isn't the input device and there's no
vestibular mismatch. Stereo VR has no such tolerance: the frame has to track head pose essentially
instantly or the user's inner ear disagrees with their eyes.

**The existing streaming protocol is nowhere near what stereo VR would need.** The desktop path's
protocol (`server/render_server/`, `src/services/RemoteRenderClient.js`) is a discrete
`loadDataset|cameraUpdate|frame` exchange: one flat base64-encoded PNG per request, no concept of
"eye," no pose prediction, no frame pacing tied to a display's vsync/refresh, and no compositor
integration. Retrofitting it for VR would not be a protocol tweak — it would require an entirely
new delivery mechanism (see Rejected Alternative).

**No WebRTC exists in this repo.** A search of the codebase (as of this writing) turns up zero
references to `RTCPeerConnection`, WebRTC, or a video-track based transport anywhere — including
inside `src/core/vr/`, which has zero references to `RemoteRenderClient.js` or
`ServerRenderedViewport.jsx` in either direction. There is no half-built streaming-stereo path to
extend; the "server renders VR frames" alternative would start from nothing.

## Consequences

- **The local-WebGL-context requirement is an architecture boundary, not a bug.**
  `VRExplorationManager` throwing when no local WebGL/VTK context is available (e.g. when the app
  is running in server-render mode) is the system correctly refusing to do something it was never
  designed to do, not a missing fallback that should be patched over. Any error messaging at that
  throw site should name this boundary explicitly rather than reading as a generic
  misconfiguration.
- **Dataset size is handled ahead of the render loop, not by relocating the renderer.** The answer
  to "this dataset is too big for the headset" is to make the dataset smaller before VR entry
  (preprocessing), never to move the per-frame rendering off the headset. This is why
  `isReadyForVR` (`server/src/services/vrPreprocessing.js`) exists as a pre-entry gate rather than
  a runtime fallback: the intervention point is "before the headset ever tries to render this,"
  not "while it's struggling to render this."
- **VR and the desktop server-rendering feature are, and should remain, independent.** Changes to
  `RemoteRenderClient.js` / `ServerRenderedViewport.jsx` / `server/render_server/` should not be
  expected to affect VR, and VR changes should not need to touch that path. If a future stereo
  requirement changes this, it should start from the Rejected Alternative below, not from
  extending the PNG-over-WebSocket protocol incrementally.
- **Preprocessing completeness becomes a real precondition for a good VR experience** on large
  datasets, which is why the readiness contract (`isReadyForVR`) needs to distinguish "never
  preprocessed because it's small" from "never preprocessed but needs it" — see the inline
  documentation on `isReadyForVR` in `server/src/services/vrPreprocessing.js` for that logic.

## Rejected Alternative: WebRTC Stereo Streaming

Streaming server-rendered stereo frames to the headset over WebRTC (analogous to cloud-gaming
services) was considered and rejected for this round. It remains a legitimate future option if
requirements change (e.g. datasets that no amount of LOD/octree preprocessing can bring into
headset budget), but it is a ground-up subsystem, not an extension of anything that exists today.
It would concretely require:

- **A WebRTC transport layer.** `RTCPeerConnection` signaling (offer/answer, ICE), a media server
  or SFU, and NAT traversal (STUN/TURN) — none of which exists in this repo today. The current
  desktop streaming path uses a plain WebSocket carrying JSON + base64 PNG, which is not a
  substitute.
- **Per-eye stereo frame generation and encoding**, doubling server-side render and encode cost
  per frame versus the single-viewport desktop case, plus a video codec pipeline (e.g. H.264/AV1
  hardware encode) in `server/render_server/` in place of PNG snapshotting.
- **Pose prediction**, so the frame the server renders corresponds to where the user's head *will
  be* when the frame displays, not where it was when the pose was sampled — required to keep
  motion-to-photon latency inside the WebXR comfort budget over a network round-trip. This has no
  analog in the current architecture; the desktop path renders for the pose it just received, with
  no prediction, because the visible latency is not an emergency there.
- **A WebXR compositor/frame-submission integration** on the client to hand decoded video frames
  to `XRWebGLLayer` (or an equivalent) in sync with the display's own render loop, replacing
  `VRManager`'s current local `_onXRFrame` render loop for at least the streamed content.
- **A synchronized interaction protocol** so controller input, tool state, and navigation — all
  currently local and instantaneous inside `VRExplorationManager` — round-trip to the server
  and back inside the same latency budget, rather than being purely local state as they are today.

Given the size of that lift and that server-side preprocessing already solves the dataset-size
half of the problem without touching the render loop, this alternative was not pursued.
