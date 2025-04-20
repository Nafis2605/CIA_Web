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

const remoteView = vtkRemoteView.newInstance({
  container: fullScreenRenderer.getContainer(),
  background: [0,0,0],
});

const socket = new WebSocket('ws://localhost:9001');
socket.binaryType = 'arraybuffer'; // Set binaryType to 'arraybuffer' to receive binary data

const remoteSession = createRemoteSession();
remoteView.setSession(remoteSession);

const camera = renderer.getActiveCamera();
// ----------------------------------------------------------------------------
// WebSocket Setup
// ----------------------------------------------------------------------------

let currentActor = null;

function createRemoteSession(){

  socket.onopen = function(){
    console.log('WebSocket connection established');
    // You can send or receive data here to update the remote view or trigger actions
  };

  socket.onmessage = function(event){
    // Handle incoming messages, update the renderering as necessary
    const data = event.data;
    console.log(data);
    // Make sure fileData is an ArrayBuffer before passing it to vtkXMLPolyDataReader
    if (data instanceof ArrayBuffer) {
      console.log('Received binary data (VTK file)');
      updateScene(data);
      return;
    } 
    // Try to parse JSON messages
    try {
      const message = JSON.parse(data);

      if (message.type === 'camera-update') {
        console.log('Received camera update:', data);

        if(!message.position || !message.focalPoint || !message.viewUp){
          console.warn("Incomplete camera data:", data);
          return;
        }
        else{         
          console.log('Message:', message);
          
          // camera.setPosition(message.position[0], message.position[1], message.position[2]);
          // camera.setFocalPoint(message.focalPoint[0], message.focalPoint[1], message.focalPoint[2]);
          // camera.setViewUp(message.viewUp[0], message.viewUp[1], message.viewUp[2]);
          camera.setPosition(...message.position);
          camera.setFocalPoint(...message.focalPoint);
          camera.setViewUp(...message.viewUp);

          console.log(camera.getPosition());
          console.log(camera.getFocalPoint());
          console.log(camera.getViewUp());
          
          renderWindow.render(); 
        }
      }
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  };

  socket.onclose = function(){
    console.log('WebSocket connetion closed');
  };

  socket.onerror = function(error){
    console.error('WebSocket error: ', error);
  };

  return socket;
}

function createOrientationMarker(){
  // create axes
  const axes = vtkAnnotatedCubeActor.newInstance();
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

  // create orientation widget
  const orientationWidget = vtkOrientationMarkerWidget.newInstance({
    actor: axes,
    interactor: renderWindow.getInteractor(),
  });
  orientationWidget.setEnabled(true);
  orientationWidget.setViewportCorner(
    vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT
  );
  orientationWidget.setViewportSize(0.15);
  orientationWidget.setMinPixelSize(100);
  orientationWidget.setMaxPixelSize(300);
}

// Function to update the scene in response to received data
function updateScene(fileData) {
  // Make sure the fileData is an ArrayBuffer before passing it to vtkXMLPolyDataReader
  if (!(fileData instanceof ArrayBuffer)) {
    console.error('Expected ArrayBuffer but received:', fileData);
    return;
  }

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
  renderWindow.render();

  currentActor = actor;

  const interactor = renderWindow.getInteractor();
  const style = vtkInteractorStyleTrackballCamera.newInstance();
  interactor.setInteractorStyle(style);

  style.onInteractionEvent(() => {
    // const camera = renderer.getActiveCamera();

    const cameraState = {
      type: 'camera-update',
      position: camera.getPosition(),
      focalPoint: camera.getFocalPoint(),
      viewUp: camera.getViewUp(),
    };

    // send through WebSocket
    socket.send(JSON.stringify(cameraState));
  });
}
// const mouseEventHandler = (event) => {
//   //handle mouse event and pass it to the remote server

// }

// remoteView.setRpcMouseEvent(mouseEventHandler);
// remoteView.setRpcGestureEvent(gestureEventHandler);

// function update() {
//   const render = renderWindow.render;
//   renderer.resetCamera();
//   render();
// }

// ----------------------------------------------------------------------------
// Example code
// ----------------------------------------------------------------------------
// create a filter on the fly, sort of cool, this is a random scalars
// filter we create inline, for a simple cone you would not need
// this
// ----------------------------------------------------------------------------

// const coneSource = vtkConeSource.newInstance({ height: 100.0, radius: 50 });

// const reader = vtkXMLPolyDataReader.newInstance();

// const vtpReader = vtkXMLPolyDataReader.newInstance();


function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

// const source = vtpReader.getOutputData(0);
// const mapper = vtkMapper.newInstance();
// const actor = vtkActor.newInstance();

// actor.setMapper(mapper);

function handleFile(e){
  preventDefaults(e);
  const dataTransfer = e.dataTransfer;
  const files = e.target.files || dataTransfer.files;
  if (files.length > 0){
    const file = files[0];
    const fileReader = new FileReader();

    fileReader.onload = function onLoad(e){
      const fileData = fileReader.result;

      // Directly send the ArrayBuffer over WebSocket without JSON
      socket.send(fileData);  // No need for JSON.stringify
      //Broadacst the file data to other tabs
      // sendDataToAllTabs({
      //   type: 'file-upload', 
      //   fileData: fileData
      // });

      //Update the local scene with the uploaded file
      updateScene(fileData);
      // vtpReader.parseAsArrayBuffer(fileReader.result);
      // mapper.setInputData(vtpReader.getOutputData(0));
      // renderer.addActor(actor)
      // renderer.resetCamera();
      // renderWindow.render();
    };
    fileReader.readAsArrayBuffer(file);
  }
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

// -----------------------------------------------------------
// Make some variables global so that you can inspect and
// modify objects in your browser's developer console:
// -----------------------------------------------------------

// global.source = coneSource;
// global.mapper = mapper;
// global.actor = actor;
// global.renderer = renderer;
// global.renderWindow = renderWindow;

// global.reader = reader;
// global.fullScreenRenderer = fullScreenRenderer;