# Title Options

1. **OpenCIVAN: A Collaborative Immersive Analytics Toolkit for Cross-Device Scientific Visualization** *(preferred)*
2. **OpenCIVAN: Layered State Synchronization for Collaborative Browser-Based Scientific Visualization**
3. **OpenCIVAN: Research Infrastructure for Shared Scientific Analysis Across Desktop and WebXR Clients**

# Abstract

Collaborative immersive scientific visualization is difficult to build because a system must coordinate scientific data, analytical views, transient user activity, durable artifacts, heterogeneous input devices, and recovery after disconnection. Existing visualization, XR interaction, and shared-editing frameworks each address parts of this problem, but reusable infrastructure that connects them remains difficult to assemble. We present OpenCIVAN, an open-source research toolkit for browser-based collaborative immersive analytics. The implementation separates declarative analytical state from client-local rendering resources and combines a Y.js WebSocket document for live shared state with revisioned REST resources, an application WebSocket, an ordered synchronization-event log, and PostgreSQL persistence. This layered model supports room-scoped presence, shared cameras and visualization parameters, durable annotations, cross-device desktop/WebXR participation, manipulation arbitration, text and voice communication, and reconnection recovery. Scientific views are rendered locally with VTK.js, while an independent Python VTK service can stream rendered frames for VTP, VTU, and VTI datasets. Repository tests cover state merging, reconnection watermarks, concurrency, VR-session convergence, manipulation locks, and replay components; no performance or user-study results are present. We therefore describe the implemented architecture and workflows and outline an evaluation plan. OpenCIVAN demonstrates a reusable foundation for studying collaboration mechanisms in immersive scientific visualization, rather than a finished end-user platform.

# 1. Introduction

## 1.1 Problem Context

Scientific interpretation is often a collective activity. Researchers inspect complex spatial data, compare explanations for observed structures, revisit earlier parameter choices, and coordinate attention around regions of interest. The analytical object is not only the dataset: it also includes a view of that dataset, the camera from which a feature was noticed, the filter or clipping state that exposed it, the annotations that record an interpretation, and the conversational context in which a decision was made.

Immersive displays can provide useful spatial context for volumetric and geometric data, but they also enlarge the systems problem. A collaborator in a head-mounted display produces head, hand, ray, and object-manipulation state; a desktop collaborator instead produces mouse, keyboard, and viewport events. Participants may have different rendering capabilities and may join late, disconnect, or deliberately choose independent cameras. A collaborative immersive analytics toolkit must consequently distinguish shared analytical state from per-device rendering state, fast-changing presence from durable artifacts, and coordination cues from authoritative project records.

## 1.2 Toolkit Gap

The repository suggests five coupled implementation problems. First, a shared session needs stable project, room, workspace, user, and device identities. Second, high-frequency activity such as cursors and immersive poses should not be persisted or conflict-checked like an annotation or saved view. Third, a visualization must be reproducible from a compact declarative state without transferring browser or GPU objects. Fourth, desktop and immersive users need a common state model while retaining device-specific controls. Fifth, missed durable changes must be recoverable after reconnection.

These concerns cross the boundaries of rendering libraries, collaboration middleware, databases, media systems, and XR APIs. A reusable toolkit must make those boundaries explicit enough that researchers can change one analytical or interaction component without reimplementing the full collaboration stack.

## 1.3 OpenCIVAN Overview

OpenCIVAN is an open-source research infrastructure prototype for constructing shared scientific visualization workflows in the browser. A project provides the durable access and data scope; rooms establish collaboration contexts; workspaces organize analytical canvases; view configurations describe how datasets should be presented; and local instance handlers realize those configurations as interactive renderers. Users can participate through a desktop browser or, when the browser exposes the required WebXR capability, an immersive session.

Collaboration is represented as multiple related forms of state rather than one replicated scene graph. Y.js maps and awareness carry live cameras, visualization fields, active-dataset choice, presence, pointers, immersive participants, and control records. Revisioned server resources carry views, view groups, annotations, workspace drawings, room membership, and other durable records. An application WebSocket broadcasts accepted server mutations, and an ordered event log lets reconnecting clients request changes after a stored watermark. A custom Y.js server also snapshots durable Y.js roots while removing explicitly transient roots. Voice is handled separately through LiveKit, and live text chat uses a room-specific Y.js array.

The present rendering implementation registers a VTK.js handler with a modular collection of scientific visualization features. Browser parsing, server upload validation, and server-side rendering have different format sets; the toolkit should therefore be understood as a set of explicit paths rather than as a single universal loader. The client also contains a server-rendered canvas placement whose mouse interactions request PNG frames from a per-viewport Python VTK render session.

## 1.4 Contributions

- **A layered collaboration architecture** that combines field-level CRDT updates, revisioned server resources, WebSocket broadcasts, durable event logs, and reconnect hydration rather than treating every state item identically.
- **A collaboration-oriented visualization model** separating dataset identity, shared `ViewConfiguration` state, and per-client VTK.js/graphics objects, with exact-view or dataset-derived synchronization keys connecting independently created local views.
- **A cross-device interaction implementation** in which desktop and WebXR participants share presence, cameras, visualization changes, annotations, and immersive participant poses, while session-scoped control and manipulation records arbitrate conflicting changes.
- **An extensible research prototype and test base** containing a renderer registry, modular VTK features, VR tools, REST/WebSocket services, replay components, and tests for merging, recovery, concurrency, and immersive-session convergence.

## Table 1 — Implementation Evidence Map

| Paper claim | Supporting files/modules | Notes |
|---|---|---|
| Room-scoped Y.js collaboration and awareness | `src/collaboration/yjs/yjsSetup.js`; `src/collaboration/yjs/yjsObservers.js`; `server.js` | One Y document is joined by room identifier; observers route shared maps into managers. |
| Durable mutation broadcast and reconnect recovery | `server/src/services/websocket.js`; `src/services/serverSync.js`; `src/services/syncService.js`; `server/src/services/syncEventService.js` | Revisioned REST mutations are broadcast; clients restore ordered deltas after a per-workspace watermark. |
| Shared declarative views, local render instances | `src/core/data/models/ViewConfiguration.js`; `src/core/data/models/InstanceWindow.js`; `src/core/instances/types/vtk/VTKInstanceHandler.js` | Cameras and visualization parameters are data; VTK render windows, actors, and GPU resources remain local. |
| Cross-device WebXR collaboration | `src/core/vr/VRManager.js`; `src/core/vr/VRExplorationManager.js`; `src/core/vr/VRParticipantSync.js` | WebXR poses and tool actions are connected to the same session and analytical state as desktop clients. |
| Concurrent manipulation coordination | `src/core/vr/VRManipulationLock.js`; `src/core/vr/VRControlManager.js` | Session-scoped Y.js records coordinate control ownership and stale-holder recovery. |
| Durable spatial and workspace annotations | `src/core/data/models/Annotation.js`; `server/src/routes/annotations.js`; `server/src/routes/workspaceAnnotations.js` | Dataset-anchored annotations and canvas drawings are revisioned server resources. |
| Browser and remote scientific rendering paths | `src/core/instances/types/vtk/VTKInstanceHandler.js`; `src/rendering/ServerRenderedViewport.jsx`; `server/render_server/vtk_renderer.py` | VTK.js renders locally; an independent Python VTK path streams PNG frames. Their format and feature coverage differ. |
| Human communication is separated from visualization state | `src/collaboration/communication/textChat.js`; `src/services/voice/voiceRoomService.js`; `src/services/voice/voiceAvatarBridge.js` | Text uses Y.js; audio uses a LiveKit media room and only speaking/mute metadata joins presence. |
| Recording and replay infrastructure | `server/src/services/recordingService.js`; `server/src/services/replayEventService.js`; `src/services/replayService.js`; `src/ui/react/components/organisms/SessionReplayPanel/SessionReplayPanel.jsx` | Explicit recordings and workspace event-log replay are related but distinct mechanisms. |

**Figure 1 placeholder: OpenCIVAN overview.** The figure should place a durable project/workspace/room context at the center; show desktop and WebXR participants around it; separate the Y.js live-state path, REST/application-WebSocket durable path, LiveKit audio path, and optional remote-render frame path; and label representative state on each path. It should avoid implying that clients exchange VTK or GPU objects.

# 2. Related Work Placeholder

## 2.1 Immersive Analytics and Scientific Visualization

TODO: Add citations and discussion.

## 2.2 Collaborative Visualization and Shared Analytical Workspaces

TODO: Add citations and discussion.

## 2.3 WebXR and Cross-Device Immersive Systems

TODO: Add citations and discussion.

## 2.4 Visualization Toolkits and Authoring Frameworks

TODO: Add citations and discussion.

Based on the implementation, OpenCIVAN should be positioned at the intersection of browser scientific visualization, shared analytical workspaces, and multi-user XR infrastructure. A later literature review should compare synchronization granularity, late-join behavior, cross-device roles, and extension mechanisms rather than claim novelty solely from the use of VTK.js, Y.js, WebXR, or LiveKit. No comparative study in the repository supports stronger claims.

# 3. Design Rationale and Requirements

## 3.1 Design Rationale

The strongest design logic visible in the code is that collaboration state has several lifetimes and authorities. Cursor coordinates, head poses, and manipulation heartbeats lose value quickly. Saved views and annotations must survive a browser closing. Cameras and visualization settings occupy both regimes: peers benefit from immediate changes during joint inspection, while a saved configuration should also be available after reconnection. OpenCIVAN therefore does not implement a strict binary split in which Y.js is only ephemeral and the database is the only durable system. Instead, selected analytical fields travel through both a live CRDT path and a revisioned persistence path, while the Y.js server snapshots durable roots and strips named transient roots.

The second recurring choice is to synchronize descriptions, not rendering machinery. A dataset identifier and `ViewConfiguration` can be stored, compared, and replayed. A VTK render window, WebGL context, mapper, actor, or XR reference space cannot usefully be replicated between browsers. `VTKInstanceHandler.applySharedState` translates shared fields into local VTK operations while guarding against feedback loops. This arrangement enables heterogeneous clients to use a common analytical vocabulary without requiring identical local interface state.

The third rationale is that collaborative identity is contextual. The code distinguishes account identity, per-device participant identity, room identity, workspace identity, view identity, and immersive-session identity. The distinction prevents a second device from evicting the first from voice or VR presence and allows the same account to occupy more than one participation context. Finally, the registry and feature patterns indicate a research-toolkit intent: collaboration services are not confined to one monolithic renderer, even though VTK is the only renderer registered by default.

## 3.2 Design Requirements

### DR1 — Maintain explicit collaboration scopes and participant identities

**Rationale.** Updates should reach the intended project, workspace, room, immersive session, view, and device participant. Cross-device participation also requires distinguishing one account from several concurrent device instances.

**Implementation evidence.** `sessionManager.js` resolves canonical project/room URLs and validates them through the API. Server room and workspace routes check membership. The application WebSocket supports project and room joins and workspace-targeted broadcasts. Presence and voice use per-device participant identifiers; VR participant maps are scoped by exploration-session identifier.

**Current limitation.** Some client-side membership helpers remain less complete than the server routes, room switching currently relies on page reload behavior, and the exact vocabulary of VR roles differs between a client model and the database migration. Fine-grained permissions for individual analytical operations are not consistently represented.

### DR2 — Combine responsive shared interaction with durable, recoverable state

**Rationale.** Joint manipulation needs rapidly propagated field updates, while analytical artifacts need revision checks, persistence, and recovery of missed changes.

**Implementation evidence.** `visualizationSyncService.js` applies changes locally, throttles Y.js transmission, and persists permitted changes through `ViewConfigurationManager`. Nested Y.js maps merge changes to disjoint visualization fields; active dataset choice uses last-writer-wins semantics. REST routes use revision counters and return conflicts for stale writes. `serverSync.js` detects sequence gaps and asks `syncService.js` for ordered deltas, with full hydration when a watermark is absent or expired. The Y.js server sends sync state to late joiners and stores snapshots of durable roots.

**Current limitation.** There are no measured propagation or recovery times. Same-field CRDT writes and active-dataset choices still resolve by last writer. Conflict UI exists for view records, but conflict treatment is not uniform across every resource. The two live/durable paths can temporarily disagree and require more systematic end-to-end testing.

### DR3 — Separate shared analytical descriptions from device-local rendering

**Rationale.** Collaborators need common cameras, filters, and scene parameters, but graphics resources and interaction surfaces must be created for each client.

**Implementation evidence.** `Dataset`, `ViewConfiguration`, and `InstanceWindow` form three distinct layers. `workspaceManager.js` maps remote shared state to exact view identifiers or synchronization keys; `VTKInstanceHandler.js` applies camera, representation, opacity, scalar, transform, slice, threshold, clipping, glyph, window/level, and widget fields to a local pipeline. `cameraSharePolicy.js` permits shared or personal camera modes, and `followService.js` provides an explicit temporary override.

**Current limitation.** Equivalent configuration does not guarantee pixel-identical output across hardware and rendering paths. The default dataset-derived synchronization key can conflate views of the same dataset unless a more specific collaboration-view identity is used. Rendering-consistency checks are present as UI/test scaffolding, not empirical validation.

### DR4 — Support coordinated desktop and immersive participation

**Rationale.** A collaborative immersive workflow should include colleagues who remain at desktop displays and should preserve common analytical artifacts across device-specific input modalities.

**Implementation evidence.** `VRManager.js` requests `immersive-vr` with floor and optional hand-tracking capabilities and handles tracked and transient-pointer sources. `VRParticipantSync.js` publishes head, hand, pointer, origin, and scale state at a throttled rate. `VRExplorationManager.js` connects immersive tools to shared view changes and server annotations. `VRManipulationLock.js` and `VRControlManager.js` coordinate ownership, heartbeat, requests, and stale-holder recovery. Desktop presence and avatars consume the same session records.

**Current limitation.** The repository includes a hardware validation checklist stating that Apple Vision Pro behavior was derived from code rather than tested on a device. In-immersive controls are narrower than the desktop interface, and the server-rendered viewport is a separate 2D canvas path rather than a verified immersive fallback.

### DR5 — Provide scientific rendering paths with inspectable extension boundaries

**Rationale.** Collaborative infrastructure is useful only when it can present scientific geometry or volumes and can be extended for new formats, analyses, or rendering constraints.

**Implementation evidence.** The instance-type registry selects handlers by manifest and capability. The registered VTK handler contains modular features for surface, volume, slice, scalar color, isosurface, glyph, clipping, threshold, transfer function, measurement, annotation, and other operations. The browser parser handles VTP, VTI, legacy VTK, STL, PLY, OBJ, and VTKJS datasets/series. A Python VTK renderer handles VTP, VTU, and VTI through an independent WebSocket frame service.

**Current limitation.** The handler manifest advertises VTU, but its browser parser explicitly rejects VTU in the installed VTK.js build and advises conversion; VTU is available in the Python render path. Upload acceptance is broader than renderability, so accepted DICOM, NIfTI, CSV, JSON, glTF, or other files are not evidence of one common interactive renderer. Progressive large-data behavior and path equivalence have not been evaluated.

### DR6 — Preserve collaborative artifacts and separate analytical state from human communication

**Rationale.** Collaboration includes asynchronous marks and later review as well as synchronous speech and text. These records require different storage, ordering, and transport from view manipulation.

**Implementation evidence.** Dataset-anchored annotations and workspace drawings are revisioned REST resources and application-WebSocket events. `sync_events` provides an ordered workspace history; `SessionReplayPanel` and `replayService` expose read-only filtering, stepping, scrubbing, and playback. Explicit session recordings write timestamped events and can be exported. Room text chat uses a Y.js array, while LiveKit carries audio and a bridge maps speaking/mute state into presence.

**Current limitation.** Replay is implemented but its fidelity under backward seeks, long sessions, and interleaved entity dependencies has not been evaluated. The client names chat arrays `chatMessages_${roomId}`, while the root Y.js server's inspected persistence observer attaches to `chatMessages`; therefore live chat is verified but room-chat persistence through that observer is ambiguous. No video or caption path was found.

## Table 2 — Design Requirements and Implementation Evidence

| Requirement | Rationale | Implementation evidence | Current limitation |
|---|---|---|---|
| DR1 — Maintain explicit collaboration scopes and participant identities | Prevent state leakage and distinguish accounts, devices, rooms, views, and XR sessions | `src/core/session/sessionManager.js`; `server/src/routes/rooms.js`; `server/src/routes/workspaces.js`; `server/src/services/websocket.js`; `src/collaboration/presence/presenceSystem.js` | Uneven role vocabulary and incomplete fine-grained analytical permissions |
| DR2 — Combine responsive shared interaction with durable, recoverable state | Support joint manipulation, late joins, persistence, and reconnection | `src/services/visualizationSyncService.js`; `src/services/serverSync.js`; `src/services/syncService.js`; `server.js`; revisioned routes | No latency measurements; temporary cross-path divergence and LWW fields remain |
| DR3 — Separate shared analytical descriptions from device-local rendering | Share reproducible intent without transmitting graphics resources | `Dataset.js`; `ViewConfiguration.js`; `InstanceWindow.js`; `workspaceManager.js`; `VTKInstanceHandler.js` | Rendering equivalence is not enforced; view-key ambiguity is possible |
| DR4 — Support coordinated desktop and immersive participation | Include heterogeneous devices in one analytical session | `VRManager.js`; `VRExplorationManager.js`; `VRParticipantSync.js`; `VRManipulationLock.js` | Limited on-device evidence and narrower immersive UI |
| DR5 — Provide scientific rendering paths with inspectable extension boundaries | Make collaboration useful for scientific data while permitting new handlers/features | `instanceTypeRegistry.js`; `VTKInstanceHandler.js`; `vtk/features/`; `server/render_server/vtk_renderer.py` | Format sets differ by path; no large-data or parity evaluation |
| DR6 — Preserve collaborative artifacts and separate analytical state from human communication | Support asynchronous review, history, text, and speech with suitable transports | annotation routes; `recordingService.js`; `replayService.js`; `textChat.js`; `voiceRoomService.js` | Replay fidelity and chat persistence require verification; no video/captions found |

# 4. OpenCIVAN Toolkit Model

OpenCIVAN's collaboration model can be read as a graph of durable analytical objects joined to transient participation records. Project, room, and workspace identifiers define scope. Datasets and view configurations define what is analyzed and how it is shown. Local instances render that description. Users create one or more device participants whose presence, cursors, poses, and media status have shorter lifetimes. Annotations and event records outlive those participants.

## Table 3 — Toolkit Abstractions

| Abstraction | Purpose | Implementation evidence | Collaborative role |
|---|---|---|---|
| Project | Durable membership and data-access scope | project routes and `projects` / `project_members` schema | Bounds access to datasets, rooms, and project broadcasts |
| Room | Canonical live collaboration context | `server/src/routes/rooms.js`; `src/core/session/sessionManager.js`; `rooms` / `room_members` | Selects the Y.js document, presence population, chat, and voice-room identity |
| Workspace | Organizes personal, project, or breakout analytical canvases | `src/core/data/models/Workspace.js`; workspace routes | Scopes canvases, view-group changes, workspace annotations, and delta watermarks |
| Dataset | Identifies raw scientific content and metadata | `src/core/data/models/Dataset.js`; dataset/file routes | Gives collaborators a common data reference without transferring parsed VTK objects through the sync layer |
| ViewConfiguration | Declarative, durable analytical view | `src/core/data/models/ViewConfiguration.js`; `ViewConfigurationManager.js`; view routes | Carries camera, visualization, filter, link, and compatibility state across clients and time |
| InstanceWindow / handler | Local realization of a view | `src/core/data/models/InstanceWindow.js`; `VTKInstanceHandler.js` | Applies shared state to one client's renderer and emits local interaction changes |
| View link / synchronization key | Relates views that should receive common changes | `src/core/instances/viewSyncKey.js`; `ViewLinkingService.js`; view-group routes | Routes camera/filter/widget updates across equivalent or explicitly linked views |
| User and participant | Represents an account and a device-specific session presence | `presenceSystem.js`; `VRParticipantSync.js`; voice services | Supports multi-device presence without reducing all devices to one connection |
| VR exploration session | Binds an immersive activity to a view/dataset and participant set | `src/core/data/models/VRExplorationSession.js`; `server/src/routes/vr.js` | Scopes poses, join order, host/control state, tools, and snapshots |
| Annotation | Anchors a typed interpretation or measurement to dataset coordinates | `src/core/data/models/Annotation.js`; annotation routes | Creates a durable reference that desktop and immersive participants can share |
| Y.js room document | Holds live replicated maps/arrays and awareness | `yjsSetup.js`; `yjsObservers.js`; `server.js` | Merges field updates, supplies late-join state, and removes transient participant records on disconnect |
| Sync event / recording event | Orders durable workspace mutations or captures an explicit session record | `syncEventService.js`; `recordingService.js`; replay services | Supports missed-event recovery, retrospective navigation, and exportable session traces |

Together, these abstractions model collaborative analysis as the interaction of a durable analytical graph, a live replicated room document, and device-local renderers. A scene is therefore not a single authoritative graphics object. It is a reconstruction from dataset references and shared analytical fields, contextualized by transient collaborators and durable marks.

# 5. Collaborative Workflow Pipeline

The implemented workflow has six stages. They form a loop once participants begin manipulating a view.

## 5.1 Scope and Session Initialization

The client resolves a project and room from the canonical URL, validates access, derives a room identifier, initializes Y.js, authenticates the application WebSocket, joins project/room channels, and loads a workspace. Presence advertises user, participant, room, workspace, activity, voice, and immersive status. A late joiner receives the current Y.js document/awareness state and durable resources from REST hydration rather than waiting for peers to repeat actions. This stage provides the boundary within which later updates are meaningful.

## 5.2 Data Ingestion and Reference Creation

Files pass through server validation and are associated with dataset metadata and storage records. The accepted upload categories are broader than any one renderer. On the client, a dataset retains identifiers, metadata, load state, and runtime caches. The collaborative purpose is referential: view configurations and annotations point to a stable dataset rather than embed locally parsed geometry in collaboration messages. Unsupported combinations must be converted or routed to a compatible renderer.

## 5.3 View Construction

A view configuration selects a dataset and declares camera and visualization state. The instance registry chooses a handler, and the VTK handler parses supported browser formats and creates local actors, mappers, widgets, and render windows. The handler then applies persisted/shared state. A server-render placement follows a different route: it opens one `RemoteRenderClient` WebSocket per viewport, asks the Python renderer to load a registered VTP, VTU, or VTI path, and presents returned PNG frames.

## 5.4 Cross-Device Participation

Desktop users interact through canvas viewports and panels. A capable browser may enter `immersive-vr`; the toolkit gathers head, hand/controller, or gaze-pinch input and maps it to the active exploration session. VR origin and scale stay in the participant record, allowing another client to interpret poses. Device-specific UI and graphics resources remain local, while analytical actions are translated into shared camera, visualization, annotation, or measurement operations.

## 5.5 Collaborative Interaction Loop

A local action first updates the local renderer. If the field is shareable and the role permits modification, the client publishes a throttled Y.js patch and queues durable view persistence. Remote Y.js observers route the field to matching views and apply it under a remote-update guard. Server-accepted durable changes are broadcast through the application WebSocket and appended to `sync_events`. Presence, pointers, and XR poses follow transient Y.js maps or awareness. Shared immersive manipulation additionally passes through a session lock/control gate; annotations and measurements are additive server records and do not require exclusive manipulation ownership.

## 5.6 Communication, Artifacts, and Review

Participants can create dataset annotations and workspace drawings, exchange live text, and join a room-scoped LiveKit audio session. Speaking state is reflected in presence/avatar metadata, but audio packets are not visualization-state events. Accepted analytical mutations become part of the recovery/replay log. A replay panel can filter entity classes and play, step, or scrub a read-only application of workspace events. Separately, a host may start an explicit recording whose timestamped events can be stopped and exported.

**Figure 2 placeholder: Collaborative workflow pipeline.** The figure should show: identity and scope resolution; upload/storage and dataset-reference creation; `ViewConfiguration` construction; local VTK.js or remote-frame rendering; the repeating local-action → live-patch → remote-apply → durable-write loop; and annotation/chat/voice/replay outputs. Distinct arrows should identify dataset bytes, declarative state, presence, audio media, and rendered frames.

# 6. System Architecture and Implementation

## 6.1 Architecture Overview

OpenCIVAN comprises a React/browser client, an Express application API, a custom Y.js WebSocket service, PostgreSQL, object storage, queue/worker infrastructure, LiveKit integration, and an optional Python VTK render service. Redis/BullMQ supports background jobs, and the repository contains authentication middleware for OIDC/Keycloak JWTs with an explicit development bypass mode. This is a service-oriented research deployment, not a measured claim of horizontal scalability.

The architecture has four communication planes. The Y.js plane replicates live maps and awareness. The application plane combines REST commands with accepted-mutation broadcasts and delta recovery. The media plane uses LiveKit for audio. The remote-render plane exchanges camera commands and encoded frames with the Python service. Keeping these planes distinct avoids placing binary media or rendered imagery into the analytical-state document.

**Figure 3 placeholder: System architecture.** The figure should contain a browser client box with React canvas UI, local VTK.js handler, WebXR manager, collaboration observers, durable managers, and voice client. Server boxes should show Express/API WebSocket, Y.js room server, PostgreSQL, object storage, Redis/workers, LiveKit, and Python VTK rendering. Four visually distinct network paths should be labeled with the state they carry and their persistence behavior.

## 6.2 Client Layer

The client organizes workspace canvases containing view placements. `InstanceViewport` and `CanvasCell` mount local views, notes, images, subsets, or a dedicated server-render placement. `DatasetManager`, `ViewConfigurationManager`, `ViewGroupManager`, and `AnnotationManager` maintain domain objects and consume server broadcasts. The VTK instance handler is both a rendering adapter and a collaboration boundary: it emits normalized state from local interactions and applies normalized remote state without serializing VTK objects.

`visualizationSyncService` provides the main shared-view write path. It applies changes immediately for interaction responsiveness, checks role information, throttles a latest live patch, and delegates durable storage to the view manager. If workspace role information is not yet available, it retains a pending latest patch and replays it once permissions resolve. Widget records use a durable route rather than the continuous Y.js path. Camera policy is explicit: shared mode sends/accepts camera state; personal mode suppresses outgoing and ignores ordinary incoming camera changes; follow mode temporarily accepts a selected collaborator's camera.

The XR client is layered over the same view state. `VRManager` owns WebXR session/reference-space and input-source mechanics. `VRExplorationManager` owns analytical lifecycle and tool routing. Participant, avatar, cursor, control, and manipulation modules own session networking. This separation prevents WebXR frame objects from becoming collaboration data.

## 6.3 Server Layer

The Express server exposes project, room, workspace, file, view, view-group/link, annotation, VR-session, recording, sync, and related routes. Protected routes obtain an authenticated user (or a clearly configured development identity) and check project/workspace/room access. View and annotation resources carry revisions. Accepted changes produce application-WebSocket broadcasts and, for replayable workspace entities, ordered `sync_events` records containing entity type, operation, previous/next revision, actor, correlation information, patch or snapshot, and timestamp.

The application WebSocket maps connections to users, projects, and room channels. Workspace broadcasts first resolve the appropriate project and access scope. Ping/pong heartbeats remove dead connections. The client reconnects with exponential backoff and jitter and reacts to browser online/visibility changes.

The custom Y.js service maintains one document and awareness instance per active room. In production it validates a JWT and checks database-backed room/project access. It loads saved document state before accepting normal participation, broadcasts Y updates, supplies synchronization and awareness state to late joiners, removes disconnected awareness states, and snapshots documents. Before storage, it removes roots classified as transient—cursors, avatars, controllers, view presence, VR participant/control/lock maps, and similar activity—while retaining analytical roots such as cameras, visualization state, active dataset, collaboration-view claims, and chat structures. This selective persistence is central: the Y.js plane is a mixed-lifetime live document, not merely an ephemeral cursor bus.

The Python render service only opens registered server-side dataset paths and issues short-lived scoped render tokens through the API. Each WebSocket creates an independent render session, limiting camera/dataset interference between viewports. It uses Python VTK readers and off-screen rendering to return base64-encoded PNG frames. This service is an alternative 2D viewport path; the repository does not show its integration into the WebXR scene.

## 6.4 Collaboration and Synchronization Model

### Session creation and joining

The durable server creates and validates rooms, workspaces, and immersive-session records. The client derives the Y.js room name from `sessionManager`, connects with user and project information, then initializes observers idempotently. The application WebSocket separately authenticates and joins a project, and optionally a room channel. A VR exploration session points to a view configuration/dataset, registers participants through REST, and claims a corresponding Y.js registry entry. Join order is stored in a session-scoped CRDT array for convergence and host recovery.

### Identity and presence

Presence awareness contains account/user identity, per-device participant identity, display metadata, room/workspace, activity status, voice status, and immersive status. VR participant state is keyed by device participant, publishes pose/pointer/origin/scale data at a 50 ms throttle, and distinguishes stale from gone records. Graceful leave deletes the participant's own entry; the host can prune stale shared records. Avatar metadata and speaking status are separated from the higher-frequency pose record.

### Shared state placement and triggers

Camera changes arise from local interactors; visualization changes arise from controls and tools; active-dataset changes arise from view selection; annotations arise from confirmed desktop or immersive actions. Camera and visualization fields use nested Y.js maps, so changes to disjoint fields can merge without replacing an entire view record. An active dataset is a deliberately singular last-writer-wins selection, and the UI can surface a remote override. The view manager persists a throttled/serialized representation through revisioned REST requests. Remote application flags prevent a received patch from being retransmitted as a new local action.

View routing is nontrivial because two clients may create different local view identifiers after opening the same dataset. `workspaceManager` first uses an exact view identifier and otherwise resolves a synchronization key, normally derived from dataset identity. Collaboration-view claims provide a route toward more explicit identity, while persistent view links/view groups express camera, filter, widget, or other linking relationships.

### Late join, reconnection, and conflict behavior

Y.js protocol synchronization supplies the current shared document, and awareness supplies current peers. Durable resources hydrate through REST. The client stores a per-workspace/per-user sequence watermark, checks every application-WebSocket sequence, and schedules a delta fetch when it detects a gap or reconnect. Deltas are applied in order and idempotently by resource manager; the watermark advances only across successfully applied events. If the server can no longer serve the requested range, the client performs fuller hydration.

At the CRDT layer, disjoint nested fields merge; same-field writes follow Y.js conflict resolution, and single-choice records use last writer. At the REST layer, base/next revisions implement optimistic concurrency. The view workflow can present a conflict-resolution dialog with server, overwrite, or save-copy choices; some same-user retries are bounded and automatic. VR manipulation uses a different semantic tool: a session lock with holder tokens, requests, heartbeats, and host recovery. This does not serialize all collaboration—annotations and measurements remain additive—but it limits competing transforms or shared visualization gestures.

### Communication separation

Text chat is live room data in a Y.js array. Audio is a LiveKit WebRTC media stream using a canonical room-derived name and per-device participant identity. Only speaking, mute, and call-state indicators feed the presence/avatar layer. Neither audio packets nor local renderer frames are written into visualization maps. No implemented video collaboration path was found.

## Table 4 — Synchronization Scope

| State type | Synchronized or local-only | Mechanism | Supporting files | Notes/limitations |
|---|---|---|---|---|
| Project/room/workspace membership | Synchronized durable server state | REST, PostgreSQL, application-WebSocket broadcasts | project/room/workspace routes; `websocket.js` | Access checks exist; fine-grained analytical roles are incomplete. |
| User/device presence and activity | Synchronized transient state | Y.js awareness and participant records | `presenceSystem.js`; `yjsSetup.js` | Cleaned on disconnect/staleness; not an authoritative history. |
| Desktop cursor / 3D pointer | Synchronized transient state | Throttled Y.js map plus awareness cursor metadata | `src/collaboration/presence/cursors.js`; `yjsSetup.js` | Sampling and renderer-dependent raycast; cursor events may be recorded when recording is active. |
| VR head, hand, ray, origin, and scale | Synchronized transient state | Session-scoped Y.js maps, 50 ms publishing throttle | `VRParticipantSync.js`; `AvatarNetworkSync.js` | Stale/gone timers provide backstop; perceived smoothness is unevaluated. |
| Camera | Synchronized live and durable, or deliberately personal | Nested Y.js camera map plus revisioned view persistence | `visualizationSyncService.js`; `cameraSharePolicy.js`; `ViewConfigurationManager.js` | Personal mode suppresses normal sharing; explicit follow can override locally. |
| Visualization parameters | Synchronized live and durable | Per-field Y.js maps plus revisioned `ViewConfiguration` REST writes | `visualizationSyncService.js`; `VTKInstanceHandler.js` | Includes representation, opacity, scalar/color, transform, threshold, glyph, slice, window/level, `slicePlane`, and `clipBox`; same-field conflicts are LWW/CRDT-resolved. |
| Widgets | Synchronized durable | View-configuration persistence and server broadcasts | `visualizationSyncService.js`; `ViewConfiguration.js` | Intentionally excluded from continuous Y.js transmission. |
| Active dataset selection | Synchronized live | Y.js map keyed by room | `yjsSetup.js`; `workspaceManager.js` | Explicit last-writer-wins choice; remote override is surfaced. |
| Dataset metadata and bytes | Metadata synchronized/persisted; bytes fetched, not replicated as scene state | REST/PostgreSQL and object/static storage | `Dataset.js`; file/dataset routes | Upload acceptance does not guarantee a compatible interactive renderer. |
| Arbitrary semantic selection / probe value | Mostly local-only in inspected paths | Local tool/instance state | VR probe and VTK feature modules | Active dataset and pointer hit are shared, but a general durable selection model was not verified; VR probe is session-local. |
| Object transforms and controlled VR manipulation | Synchronized live and durable view state | Visualization patches plus session manipulation/control Y.js maps | `VRExplorationManager.js`; `VRManipulationLock.js` | Lock recovery depends on heartbeats/host behavior and needs multi-client testing. |
| Dataset annotations and measurements | Synchronized durable | Revisioned REST, `sync_events`, application WebSocket | annotation routes; `AnnotationManager`; VR annotation/measure tools | Additive actions are not gated by the manipulation lock; concurrent editing still uses revisions. |
| Workspace drawings/labels | Synchronized durable | REST, snapshots, application WebSocket and delta events | workspace-annotation routes | Coordinate semantics are canvas/workspace based, not 3D dataset based. |
| Text chat | Live synchronized; persistence ambiguous | Room-specific Y.js array; server chat/database infrastructure | `textChat.js`; `server.js` | Client/server shared-root naming mismatch needs verification before claiming durable history. |
| Audio | Synchronized media plus presence metadata | LiveKit WebRTC; Y.js/awareness speaking state | `voiceRoomService.js`; `voiceAvatarBridge.js` | Separate from analytical state; no video/captions found. |
| Durable mutation history and replay | Synchronized/persisted | PostgreSQL `sync_events`, delta and replay REST, local read-only application | `syncEventService.js`; `replayEventService.js`; `replayService.js` | Replay UI exists; exact reconstruction fidelity is not evaluated. |
| Explicit session recording | Persisted when started | Buffered `recording_events`, optional object-store export | `recordingService.js`; recording routes; Y.js server hooks | Distinct from workspace replay and not evidence of complete scene reconstruction. |
| VTK/WebGL/XR objects and frame loop | Local-only | Per-client renderer/handler and WebXR session | `VTKInstanceHandler.js`; `VRManager.js` | Reconstructed from shared data; never replicated as graphics objects. |

**Figure 4 placeholder: Shared-state and synchronization model.** The figure should classify each state family along two axes—lifetime (frame/transient, session-live, durable) and authority (CRDT field, revisioned server resource, media service, local-only). It should show the dual path for camera/visualization state, the delta watermark recovery loop, late-join Y.js sync, and the remote-application guard. A callout should contrast LWW choices, nested-field merging, optimistic revision conflicts, and VR manipulation locks.

## 6.5 Rendering and Visualization Layer

Only the VTK instance type is registered during default initialization, although the registry accepts additional handlers with file types and capabilities. The VTK handler imports readers for XML polydata and image data, legacy polydata, STL, PLY, OBJ, and VTKJS datasets/series. Its parser explicitly handles VTP, VTI, legacy VTK, STL, PLY, OBJ, and VTKJS. Despite a manifest declaration, browser VTU parsing throws an explanatory conversion error in the current installed VTK.js build. This distinction is important for reproducibility.

Feature modules cover scene setup, surface and volume representations, slicing/reslicing, scalar arrays and color maps, isosurfaces, glyphs, clipping, thresholding, transfer functions and scalar bars, PBR and normals, measurement/annotation widgets, image cropping, cleaning, and reduction/orientation operations. Shared-state application translates normalized fields into these feature calls. Not all module capabilities are necessarily exposed equivalently in desktop, VR, and remote-render interfaces.

The server renderer has deliberately narrower and different semantics. It loads VTP, VTU, and VTI through Python VTK, maintains a per-connection camera and scene, performs off-screen rendering (optionally EGL), and returns encoded PNGs. `ServerRenderedViewport` converts mouse drag and wheel input into server camera commands. It does not reconstruct the full VTK.js feature set and should not be described as an automatic or equivalent fallback.

## 6.6 Communication Layer

Human communication is deliberately outside the view-state transaction model. Room text messages are inserted into a Y.js array and observed by chat UI. Optional Matrix bridge code and database mappings indicate a federation direction, but do not establish end-to-end encrypted or fully deployed federation. LiveKit provides audio transport; voice state is joined to presence so an avatar or user list can indicate speaking. Voice re-entry helpers account for browser audio lifecycle around immersive transitions. No evidence supports claims of video conferencing, transcription, or captions.

## 6.7 Extensibility Points

The renderer registry (`instanceTypeRegistry.js`, `instanceTypesInit.js`) is the primary path for another visualization type: a handler declares supported file types/capabilities and implements lifecycle and shared-state adaptation. Within VTK, a new feature follows the modules under `src/core/instances/types/vtk/features/` and must be initialized and included in state application if it is collaborative. A new shared continuous field requires representation in `ViewConfiguration`, publication in `visualizationSyncService`, a Y.js observer path, remote routing in `workspaceManager`, and local application in the handler; durable replay additionally requires a server resource/event representation.

VR tools follow the classes under `src/core/vr/tools/` and are routed by `VRExplorationManager`. Developers must decide explicitly whether a tool result is local (probe), live shared (gesture state), durable (annotation/measurement/view field), or lock-controlled (competing transformations). New durable object types require an access-checked REST route, revision policy, server broadcast, sync-event treatment, and manager-side delta application. Backend computations can use the queue/worker services, but their result should enter collaboration through a durable object rather than through an opaque renderer mutation.

# 7. Interfaces and User/Developer Levels

## 7.1 Analyst or Domain Scientist Interface

The analyst-facing interface is a workspace canvas of dataset-backed views plus panels for properties, collaboration, annotations, voice, and replay. An analyst can open supported data, navigate a VTK view, change representation and scientific display parameters, place dataset annotations, create workspace marks, and save or link views. The paper should avoid presenting every loaded format as interactively equivalent: the browser, remote-render, and validation paths differ.

## 7.2 Collaborator Interface

The collaboration interface consists of shareable room/project context, presence and participant lists, pointers, camera sharing/personal/follow choices, shared visualization changes, chat, audio, annotations, and immersive-session join/control state. A collaborator can stay on a personal camera while observing shared artifacts or explicitly follow another camera. A remote active-dataset override is surfaced rather than being entirely silent. These are coordination policies, not simply network features.

## 7.3 Developer Interface

The developer-facing surface is code-level: model and manager classes, an instance-handler registry, VTK feature modules, visualization-state adapters, Y.js maps/observers, VR tools, REST routes, application-WebSocket event types, and worker queues. There is no evidence of a stable external plugin package API or compatibility promise. Extensions currently require coordinated changes across the appropriate state lifetime and authority boundaries.

## 7.4 Session Host or Administrator Interface

The current implementation supports project/room/workspace creation and membership routes, room roles, immersive-session host/control state, recording lifecycle, and deployment-time authentication/configuration. Host-specific immersive recovery and control operations exist. Fine-grained moderator controls and a uniform policy that distinguishes analytical editor from observer across every subsystem remain future work; development authentication bypass must not be confused with a deployed access policy.

# 8. Demonstration Scenarios

## Scenario 1 — Shared Inspection with Independent and Follow Cameras

A host opens a browser-supported VTP dataset and creates a saved view. A colleague joins the same room from another desktop. Y.js initialization supplies the active dataset, live presence, and camera/visualization maps; REST hydration supplies the durable view and annotations. The host changes scalar coloring and a threshold. Each action applies locally, then propagates as field updates and is queued for durable view persistence. The colleague first keeps a personal camera, sees the host's pointer and shared parameters, and then elects to follow the host's camera while discussing a feature over audio. The colleague confirms a dataset-anchored annotation, which is written as a revisioned server object, broadcast, and included in the workspace event history.

**Takeaway.** OpenCIVAN supports collaboration without requiring every participant to surrender local navigation, while preserving selected shared analytical changes as durable records.

## Scenario 2 — Desktop and WebXR Co-analysis

A desktop participant starts an exploration session for an already opened view, and a headset browser joins it. The immersive client requests a WebXR session, publishes head/hand or transient-pointer state under a device participant identifier, and reconstructs the dataset locally. The desktop participant sees immersive presence and spatial pointing. When the immersive user adjusts a shared clip plane or object transform, the manipulation lock limits competing gestures, the change travels through the visualization-state path, and a final state is persisted to the view. A measurement or annotation is instead created as an additive annotation record. The desktop collaborator can alter another unlocked visualization field or discuss the observation through the same room's LiveKit audio.

The scenario depends on compatible local rendering and actual headset/browser support. It does not use the remote PNG viewport inside WebXR, and Apple Vision Pro behavior remains a validation target rather than a demonstrated result.

**Takeaway.** Cross-device collaboration is expressed through shared analytical semantics and participant records, while rendering and input remain device-specific.

## Scenario 3 — Adding a Collaborative Scientific Control

A developer adds a new VTK feature with a normalized parameter. The feature owns only local VTK objects. The corresponding declarative field is added to `ViewConfiguration`, handled by the visualization sync service, represented in a nested Y.js visualization map for live sharing, routed to matching views, applied in `VTKInstanceHandler` under the remote guard, and serialized in durable view persistence. If competing XR gestures can modify the field, the tool consults the manipulation lock. Tests exercise two disjoint fields, a same-field update, reconnect hydration, and persistence after a late join.

**Takeaway.** The extension unit is not only a rendering module; a collaborative extension must define its scope, lifetime, merge rule, durable representation, and device-specific interaction path.

**Figure 5 placeholder: Cross-device collaborative scenario.** The figure should depict Scenario 2 as a sequence: durable view creation; headset join and WebXR capability check; participant pose publication; desktop observation; lock acquisition; live clip/transform patches; durable final view write; additive annotation creation; and optional audio conversation. Local renderers should be drawn separately, with only normalized state and participant data crossing between them.

# 9. Evaluation Plan / Placeholder

The repository contains substantial unit and integration test scaffolding but no benchmark report, deployment study, or participant study. Relevant tests include Y.js field merging and observer idempotence, visualization synchronization, view-key routing, WebSocket reconnect/watermark restoration, optimistic concurrency, VR participant/session convergence, manipulation locks, tool persistence, recording/replay services, and replay UI behavior. These tests are evidence that failure modes are represented in executable specifications; they are not evidence of performance, usability, or real-device validity.

## 9.1 Technical Performance

TODO: Measure browser and remote-render frame rate, dataset load/parse time, Y.js and durable-event propagation latency, reconnect recovery time, concurrent participant count, database/Y.js memory growth, recording throughput, and server resource use. Measurements should separate desktop VTK.js, WebXR local rendering, and Python-rendered frame paths and report dataset size/structure, device, browser, network, and feature configuration.

## 9.2 Synchronization Correctness

Existing tests such as `yjsObservers.visualizationMerge.test.js`, `visualizationSyncService.test.js`, `workspaceManager.viewSync.test.js`, `serverSync.reconnect.test.js`, `serverSync.watermarkRestore.test.js`, server concurrency tests, VR convergence tests, and replay tests provide a starting point. TODO: add multi-browser fault-injection experiments covering delayed/reordered updates, offline edits, same-field conflicts, stale locks, late join during active manipulation, permission changes, Y.js snapshot restart, and REST/Y.js temporary disagreement.

## 9.3 Collaborative Workflow Evaluation

TODO: Conduct expert walkthroughs and controlled pilot sessions with visualization researchers or domain scientists. Tasks should compare independent cameras, explicit follow, shared filtering/clipping, annotation handoff, desktop–headset pointing, and replay-based review. Record both outcome quality and coordination breakdowns; do not treat user preference alone as evidence of analytical benefit.

## 9.4 Comparative Capability Analysis

TODO: Compare OpenCIVAN with relevant scientific visualization, collaborative analytics, and multi-user XR systems using a matrix of state granularity, persistence/recovery, cross-device participation, scientific rendering path, collaboration artifacts, deployment requirements, and extension cost. Literature selection and citations remain outside the code-derived evidence in this draft.

## Table 5 — Requirement-to-Evaluation Plan

| Requirement | Current evidence | Evaluation method needed | Metrics or qualitative evidence |
|---|---|---|---|
| DR1 — Maintain explicit collaboration scopes and participant identities | Access checks, room/project joins, per-device presence, scoped VR maps, and authorization tests | Multi-room/multi-workspace isolation tests with one account on several devices and role changes | Cross-scope leakage count; join correctness; duplicate/evicted participant rate; authorization failures |
| DR2 — Combine responsive shared interaction with durable, recoverable state | Merge, reconnect, watermark, delta, revision, and conflict tests | Controlled latency/loss/reordering experiments and server restart tests | Live propagation distribution; recovery time; missed/duplicate events; final-state convergence |
| DR3 — Separate shared analytical descriptions from device-local rendering | Model/handler separation and shared-state application tests | Cross-device/configuration rendering comparison and view-key collision study | State equivalence; pixel/feature differences; incorrect routing frequency |
| DR4 — Support coordinated desktop and immersive participation | WebXR, pose sync, session convergence, locks, and VR-tool tests; hardware checklist only | Real-headset paired tasks across controller, hand, and gaze-pinch input | Join success; pose/update continuity; conflict rate; task outcome; coordination observations |
| DR5 — Provide scientific rendering paths with inspectable extension boundaries | Browser readers, modular VTK features, Python VTK service, capability tests | Format-by-path compatibility suite, large-data benchmarks, and extension case study | Parse/load success; frame rate; memory; feature parity; developer effort and changed modules |
| DR6 — Preserve collaborative artifacts and separate analytical state from human communication | Annotation, recording, sync-event, replay, chat, and voice implementations/tests | Long-session replay fidelity, chat persistence restart, recording export, and mixed voice/state workflow study | Reconstructed-event accuracy; artifact loss; restart retention; annotation utility; communication breakdowns |

# 10. Discussion

## 10.1 What the Toolkit Enables

OpenCIVAN provides a concrete substrate for experiments in collaboration policy rather than only a multi-user rendering demonstration. Researchers can study when cameras should be shared, how collaborators identify equivalent views, which XR gestures require exclusive ownership, how live changes become durable artifacts, and how an interrupted participant catches up. The same implementation permits synchronous coordination through pointers, shared state, speech, and text, and asynchronous coordination through views, annotations, workspace marks, event history, and recordings.

The state/render separation also makes cross-device participation conceptually tractable. A desktop and headset do not need the same UI or reference space; they need an agreed dataset reference, view semantics, transform conventions, participant coordinates, and merge rules. The toolkit implements those pieces for one VTK-centered prototype and exposes the seams at which future renderers or collaboration techniques can be attached.

## 10.2 Design Trade-offs

**Immediate local response versus global authority.** Applying an interaction locally before permission and persistence complete preserves responsiveness, but creates a window in which the local display may show a change that cannot become durable. Pending-role queues and server recovery reduce this risk without eliminating it.

**CRDT fields versus revisioned objects.** Nested Y.js fields allow concurrent changes to different properties, while REST revisions provide explicit stale-write detection and history. The combined path is more expressive than either alone, but it requires duplicate representations, feedback guards, and reconciliation policy.

**Shared context versus personal exploration.** A universally synchronized camera would make joint attention easy but prevent independent inspection. Shared, personal, and follow policies make that choice explicit at the cost of more state and possible confusion about what colleagues currently see.

**Browser access versus rendering breadth.** VTK.js and WebXR reduce installation barriers, but supported readers, memory ceilings, XR availability, and rendering details vary by browser/device. The Python renderer expands one format path—especially VTU—but streams images and implements a smaller interaction/feature surface.

**General infrastructure versus simple deployment.** PostgreSQL, object storage, Y.js, Express, LiveKit, Redis/workers, authentication, and an optional render service separate concerns but increase operational complexity. This architecture should not be called scalable until participant, document, and service-load measurements are available.

## 10.3 Current Limitations

- No formal user study, expert evaluation, reported performance benchmark, synchronization-latency measurement, or large-concurrency result is present.
- Browser format claims must be path-specific: VTU is declared but rejected by the current browser parser, while it is supported by the Python VTK renderer; upload validation accepts still broader types.
- Rendering parity across VTK.js versions, GPUs, browser/WebXR paths, and PNG-streamed remote views is not established.
- Physical Apple Vision Pro behavior is unverified in the repository, and WebXR availability remains browser/device dependent.
- The server-rendered viewport is independent of immersive rendering and is not an automatic equivalent fallback.
- Y.js rooms are maintained in process; durable snapshots aid restart/late join but do not by themselves establish multi-node operation or a concurrent-user limit.
- Dataset-derived view synchronization keys can be ambiguous when multiple views intentionally use the same dataset; collaboration-view identity appears additive rather than universally authoritative.
- Simultaneous same-field updates, active-dataset selection, and some control claims resolve through last-writer or token/heartbeat semantics. Their user-visible behavior needs study.
- The view conflict dialog is not a universal conflict interface for all resource types.
- Replay UI exists, but exact reconstruction, backward seeking, long histories, and correspondence between explicit recordings and `sync_events` replay require validation.
- Live room chat is implemented; its inspected server persistence observer uses a different root name from the room-specific client array, making persistence an open implementation question.
- Authentication and authorization code exists, but development bypass mode, deployment configuration, and incomplete fine-grained analytical permissions preclude a blanket security claim.
- No video, captioning, stable external plugin API, or empirically validated accessibility workflow was found.

## 10.4 Future Work

Immediate research work should begin with instrumentation: timestamp the origin, live receipt, durable acceptance, delta recovery, and final renderer application of an operation. A fault-injection harness can then characterize temporary disagreement and convergence across the two state paths. Multi-user tests should evaluate lock expiry, host loss, rapid room switching, permission changes, and repeated offline/online cycles.

The rendering layer would benefit from a capability contract that reports parser, feature, memory, and XR support per client and negotiates a supported view rather than relying on a broad upload type. A conversion service could normalize VTU and domain-specific formats into browser-compatible representations. An adaptive remote/local policy should only be added after feature-parity and network-cost measurements.

Collaboration research can extend the current camera policies, view identities, roles, and replay. Promising directions include semantic regions of interest, richer selection models, annotation threads, provenance graphs linking view forks to session events, replay summaries, and facilitation roles for structured team analysis. Chat-root naming and replay reconstruction should be hardened before those records are used as research evidence. Finally, real-device studies should include desktop/headset pairs, accessibility needs, and mixed input modes, with task designs capable of revealing both coordination benefit and analytical error.

# 11. Conclusion

OpenCIVAN is an open-source research toolkit for collaborative, browser-based scientific visualization across desktop and WebXR participation contexts. Its implementation demonstrates a layered collaboration model: live Y.js maps and awareness, revisioned server resources and broadcasts, ordered recovery events, selectively durable room documents, separate audio media, and device-local rendering driven by shared analytical descriptions. This model supports shared and personal cameras, visualization parameters, pointers and immersive poses, manipulation coordination, durable annotations, communication, and early replay/recording workflows.

The repository provides substantial implementation and test evidence for these mechanisms, but it does not establish performance, scale, rendering equivalence, usability, or on-device effectiveness. Format support also varies among browser parsing, upload validation, and Python rendering, and several persistence and conflict behaviors need end-to-end verification. OpenCIVAN should therefore be understood as reusable research infrastructure: a concrete foundation on which collaborative visualization techniques can be implemented, instrumented, compared, and evaluated, rather than as a completed analytical platform.
