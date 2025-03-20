// For streamlined VR development install the WebXR emulator extension
// https://github.com/MozillaReality/WebXR-emulator-extension

import '@kitware/vtk.js/favicon';

// Load the rendering pieces we want to use (for both WebGL and WebGPU)
import '@kitware/vtk.js/Rendering/Profiles/Geometry';

import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkCalculator from '@kitware/vtk.js/Filters/General/Calculator';
import vtkConeSource from '@kitware/vtk.js/Filters/Sources/ConeSource';
import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkWebXRRenderWindowHelper from '@kitware/vtk.js/Rendering/WebXR/RenderWindowHelper';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPolyDataReader from '@kitware/vtk.js/IO/Legacy/PolyDataReader';
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
});

// ----------------------------------------------------------------------------
// Example code
// ----------------------------------------------------------------------------
// create a filter on the fly, sort of cool, this is a random scalars
// filter we create inline, for a simple cone you would not need
// this
// ----------------------------------------------------------------------------

// const coneSource = vtkConeSource.newInstance({ height: 100.0, radius: 50 });

// Handle the file upload
function handleFileUpload(event) {
  const file = event.target.files[0];  // Get the selected file
  if (!file) {
    alert('No file selected!');
    return;
  }

  const reader = vtkPolyDataReader.newInstance();
  
  // Use FileReader to read the uploaded file as ArrayBuffer
  const fileReader = new FileReader();

  fileReader.onload = function(e) {
    const arrayBuffer = e.target.result;

    // Parse the file using vtkPolyDataReader
    reader.parseAsArrayBuffer(arrayBuffer)
      .then(() => {
        const polydata = reader.getOutputData(0);
        const mapper = vtkMapper.newInstance();
        const actor = vtkActor.newInstance();

        mapper.setInputData(polydata);

        // Create a filter (this is the same code you're using for random scalars)
        const filter = vtkCalculator.newInstance();
        filter.setInputConnection(reader.getOutputPort());
        filter.setFormula({
          getArrays: (inputDataSets) => ({
            input: [],
            output: [
              {
                location: FieldDataTypes.CELL,
                name: 'Random',
                dataType: 'Float32Array',
                attribute: AttributeTypes.SCALARS,
              },
            ],
          }),
          evaluate: (arraysIn, arraysOut) => {
            const [scalars] = arraysOut.map((d) => d.getData());
            for (let i = 0; i < scalars.length; i++) {
              scalars[i] = Math.random();
            }
          },
        });

        mapper.setInputConnection(filter.getOutputPort());

        actor.setMapper(mapper);
        actor.setPosition(0.0, 0.0, -20.0);

        // Clear existing actors and add the new actor
        renderer.removeAllActors();
        renderer.addActor(actor);
        renderer.resetCamera();
        renderWindow.render();
      })
      .catch((err) => {
        alert('Error reading or parsing the file: ' + err);
      });
  };

  // Read the file as an ArrayBuffer
  fileReader.readAsArrayBuffer(file);
}

  // -----------------------------------------------------------
  // UI control handling
  // -----------------------------------------------------------

  fullScreenRenderer.addController(controlPanel);
  const representationSelector = document.querySelector('.representations');
  const vrbutton = document.querySelector('.vrbutton');
  const fileInput = document.getElementById("fileInput");


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
fileInput.addEventListener('change', handleFileUpload);
// -----------------------------------------------------------
// Make some variables global so that you can inspect and
// modify objects in your browser's developer console:
// -----------------------------------------------------------

// global.source = coneSource;
// global.mapper = mapper;
// global.actor = actor;
// global.renderer = renderer;
// global.renderWindow = renderWindow;
global.fullScreenRenderer = fullScreenRenderer;