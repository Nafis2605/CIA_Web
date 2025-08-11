// For streamlined VR development install the WebXR emulator extension
// https://github.com/MozillaReality/WebXR-emulator-extension

import '@kitware/vtk.js/favicon';

// Load the rendering pieces we want to use (for both WebGL and WebGPU)
import '@kitware/vtk.js/Rendering/Profiles/Geometry';

import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkCalculator from '@kitware/vtk.js/Filters/General/Calculator';
import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkWebXRRenderWindowHelper from '@kitware/vtk.js/Rendering/WebXR/RenderWindowHelper';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkPolyDataNormals from '@kitware/vtk.js/Filters/Core/PolyDataNormals';
import vtkRemoteView from '@kitware/vtk.js/Rendering/Misc/RemoteView';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor';
import vtkInteractorStyleTrackballCamera from '@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera';

import { AttributeTypes } from '@kitware/vtk.js/Common/DataModel/DataSetAttributes/Constants';
import { FieldDataTypes } from '@kitware/vtk.js/Common/DataModel/DataSet/Constants';
import { XrSessionTypes } from '@kitware/vtk.js/Rendering/WebXR/RenderWindowHelper/Constants';

// Force DataAccessHelper to have access to various data source
import '@kitware/vtk.js/IO/Core/DataAccessHelper/HtmlDataAccessHelper';
import '@kitware/vtk.js/IO/Core/DataAccessHelper/HttpDataAccessHelper';
import '@kitware/vtk.js/IO/Core/DataAccessHelper/JSZipDataAccessHelper';

import vtkResourceLoader from '@kitware/vtk.js/IO/Core/ResourceLoader';

//Yjs setup
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

// Custom UI controls, including button to start XR session
import controlPanel from './controller.html';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import { colorSpaceToWorking } from 'three/tsl';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
// Dynamically load WebXR polyfill from CDN for WebVR and Cardboard API backwards compatibility
if (navigator.xr === undefined) {
  vtkResourceLoader
    .loadScript(
      'https://cdn.jsdelivr.net/npm/webxr-polyfill@latest/build/webxr-polyfill.js'
    )
    .then(() => {
      // eslint-disable-next-line no-new, no-undef
      new WebXRPolyfill();
    });
}

// ----------------------------------------------------------------------------
//  Set up Yjs doc + provider
// ----------------------------------------------------------------------------

const ydoc = new Y.Doc();
const provider = new WebsocketProvider('ws://localhost:8080', 'vtk-room', ydoc);
const yActor = ydoc.getMap('actor');
const yFile = ydoc.getMap('fileData');

// ----------------------------------------------------------------------------
// Standard rendering code setup
// ----------------------------------------------------------------------------

const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance({
  background: [0, 0, 0],
});
const renderer = fullScreenRenderer.getRenderer();
const renderWindow = fullScreenRenderer.getRenderWindow();
const XRHelper = vtkWebXRRenderWindowHelper.newInstance({
  renderWindow: fullScreenRenderer.getApiSpecificRenderWindow(),
  drawControllersRay: true,
});

// const remoteView = vtkRemoteView.newInstance({
//   container: fullScreenRenderer.getContainer(),
//   background: [0,0,0],
// });

// const socket = new WebSocket('ws://localhost:9001');
// socket.binaryType = 'arraybuffer'; // Set binaryType to 'arraybuffer' to receive binary data

// const remoteSession = createRemoteSession();
// remoteView.setSession(remoteSession);
const interactor = renderWindow.getInteractor();

const camera = renderer.getActiveCamera();

let currentActor = null;
let isDraggingActor = false;

let mouseStartPos = null;

let axes = null
let axesPosition = null;

let actorStartOrient = null;

let isLocalFileLoad = false;

interactor.onMouseMove((callData) => {
  if (isDraggingActor && currentActor) {
    const mousePos = callData.position;
    const deltaX = mousePos.x - mouseStartPos.x;
    const deltaY = mousePos.y - mouseStartPos.y;

    currentActor.setOrientation(
      actorStartOrient[0] - deltaY * 0.1,
      actorStartOrient[1] + deltaX * 0.1, // flip Y
      actorStartOrient[2]
    );

    if(axes){
      axes.setOrientation(...currentActor.getOrientation());
      axes.setPosition(...axesPosition);
    }

    renderer.resetCameraClippingRange();
    renderWindow.render();

    sendActorPosition();
  }
});


interactor.onLeftButtonPress((callData) => {
  if (!currentActor)return;
    isDraggingActor = true;
    actorStartOrient = [...currentActor.getOrientation()];
    mouseStartPos = callData.position;  // Store the starting mouse position
});

interactor.onLeftButtonRelease(() => {
  isDraggingActor = false;
  actorStartOrient = null;
  mouseStartPos = null;
  renderer.resetCamera();

});

// ----------------------------------------------------------------------------
// Yjs Observer: File Data
// ----------------------------------------------------------------------------
yFile.observe(event => {
  if(isLocalFileLoad){
    isLocalFileLoad = false;
    return;
  }

  const b64 = yFile.get('polydata');
  if (b64) {
    const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    updateScene(binary);
  }
});

// ----------------------------------------------------------------------------
// Yjs Observer: Actor Orientation
// ----------------------------------------------------------------------------
yActor.observe(event => {
  if (!currentActor) return;

  const orient = yActor.get('orientation');
  if (orient) {
    currentActor.setOrientation(...orient);

    if (axes) {
      axes.setOrientation(...orient);
      axes.setPosition(...axesPosition);
    }

    renderer.resetCameraClippingRange();
    renderWindow.render();
  }
});

// ----------------------------------------------------------------------------
// WebSocket Setup
// ----------------------------------------------------------------------------

// function createRemoteSession(){

//   socket.onopen = function(){
//     console.log('WebSocket connection established');
//     // You can send or receive data here to update the remote view or trigger actions
//   };

//   socket.onmessage = function(event){
//     // Handle incoming messages, update the renderering as necessary
//     const data = event.data;
//     console.log(data);
//     // Make sure fileData is an ArrayBuffer before passing it to vtkXMLPolyDataReader
//     if (data instanceof ArrayBuffer) {
//       console.log('Received binary data (VTK file)');
//       updateScene(data);
//       return;
//     } 
//     // Try to parse JSON messages
//     try {
//       const message = JSON.parse(data);

//       if (message.type === 'actor-update') {
//         if (currentActor) {
//           // Apply the new actor position received from WebSocket
//           currentActor.setOrientation(...message.orientation);
//           axes.setOrientation(...currentActor.getOrientation());
//           renderer.resetCameraClippingRange();
//           renderWindow.render();
//           receiveCount++;
//           console.log("updates received: ", receiveCount);
//         }
//       }
//     } catch (err) {
//       console.error('Failed to parse message:', err);
//     }
//   };

//   socket.onclose = function(){
//     console.log('WebSocket connetion closed');
//   };

//   socket.onerror = function(error){
//     console.error('WebSocket error: ', error);
//   };

//   return socket;
// }

function createOrientationMarker(){
  // create axes
  axes = vtkAnnotatedCubeActor.newInstance();
  axes.setDefaultStyle({
    text: '+X',
    fontStyle: 'bold',
    fontFamily: 'Arial',
    fontColor: 'black',
    fontSizeScale: (res) => res / 2,
    faceColor: '#0000ff',
    faceRotation: 0,
    edgeThickness: 0.1,
    edgeColor: 'black',
    resolution: 400,
  });
  // axes.setXPlusFaceProperty({ text: '+X' });
  axes.setXMinusFaceProperty({
    text: '-X',
    faceColor: '#ffff00',
    faceRotation: 90,
    fontStyle: 'italic',
  });
  axes.setYPlusFaceProperty({
    text: '+Y',
    faceColor: '#00ff00',
    fontSizeScale: (res) => res / 4,
  });
  axes.setYMinusFaceProperty({
    text: '-Y',
    faceColor: '#00ffff',
    fontColor: 'white',
  });
  axes.setZPlusFaceProperty({
    text: '+Z',
    edgeColor: 'yellow',
  });
  axes.setZMinusFaceProperty({ text: '-Z', faceRotation: 45, edgeThickness: 0 });
  axesPosition = axes.getPosition();

  // create orientation widget
  const orientationWidget = vtkOrientationMarkerWidget.newInstance({
    actor: axes,
    interactor: interactor,
  });
  orientationWidget.setEnabled(true);
  orientationWidget.setViewportCorner(
    vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT
  );
  orientationWidget.setViewportSize(0.10);
  orientationWidget.setMinPixelSize(100);
  orientationWidget.setMaxPixelSize(300);
}


// Function to update the scene in response to received data
function updateScene(fileData) {
  // Clear the current scene by removing all actors
  renderer.removeAllActors();  // This clears all actors from the scene
  
  // Parse and update the VTK scene with the received file data
  const vtpReader = vtkXMLPolyDataReader.newInstance();
  vtpReader.parseAsArrayBuffer(fileData);
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(vtpReader.getOutputData(0));

  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);

  createOrientationMarker();
  
  // Reset the camera and render the scene
  renderer.addActor(actor);
  renderer.resetCamera();

  // defaultCameraPosition = camera.getPosition();
  // defaultCameraFocalPoint = camera.getFocalPoint();
  // defaultCameraviewUp = camera.getViewUp();

  // console.log('cam position: ', defaultCameraPosition);
  // console.log('cam focal: ', defaultCameraFocalPoint);
  // console.log('cam view up: ', defaultCameraviewUp);

  renderWindow.render();

  currentActor = actor;
  // console.log("Actor Orientation ", actor.getOrientation());
}

// Function to send updated actor position to WebSocket

function sendActorPosition(){
  if (currentActor) {
    const orient = currentActor.getOrientation();
    yActor.set('orientation', orient);
  }
}
// ----------------------------------------------------------------------------
// Example code
// ----------------------------------------------------------------------------
// create a filter on the fly, sort of cool, this is a random scalars
// filter we create inline, for a simple cone you would not need
// this
// ----------------------------------------------------------------------------

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}


function handleFile(e){
  preventDefaults(e);
  const dataTransfer = e.dataTransfer;
  const file = (e.target.files || dataTransfer.files)[0];
  if (!file) return;
  const fileReader = new FileReader();

  fileReader.onload = function onLoad(e){
    const fileData = fileReader.result;
    const b64 = arrayBufferToBase64(fileData);

    isLocalFileLoad = true; //mark as a local change
    //set the polydata to the fileData
    //overwrite the polydata if it already exists
    yFile.set('polydata', b64); 

    //Update the local scene with the uploaded file
    updateScene(fileData);
  };
  fileReader.readAsArrayBuffer(file);
}

// -----------------------------------------------------------
// UI control handling
// -----------------------------------------------------------
fullScreenRenderer.addController(controlPanel);
const representationSelector = document.querySelector('.representations');
const vrbutton = document.querySelector('.vrbutton');
const fileInput = document.getElementById('fileInput');

fileInput.addEventListener('change', handleFile);

representationSelector.addEventListener('change', (e) => {
  const newRepValue = Number(e.target.value);
  actor.getProperty().setRepresentation(newRepValue);
  renderWindow.render();
});

vrbutton.addEventListener('click', (e) => {
  if (vrbutton.textContent === 'Send To VR') {
    XRHelper.startXR(XrSessionTypes.HmdVR);
    vrbutton.textContent = 'Return From VR';
  } else {
    XRHelper.stopXR();
    vrbutton.textContent = 'Send To VR';
  }
});