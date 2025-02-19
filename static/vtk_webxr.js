import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import { io } from 'socket.io-client';  // Ensure you have socket.io-client installed

// Initialize vtk.js rendering window
const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance();
const renderer = fullScreenRenderer.getRenderer();
const renderWindow = fullScreenRenderer.getRenderWindow();

// Enable WebXR Rendering
const xrRenderer = new THREE.WebGLRenderer({ antialias: true });
xrRenderer.setSize(window.innerWidth, window.innerHeight);
xrRenderer.xr.enabled = true;
document.body.appendChild(xrRenderer.domElement);
document.body.appendChild(VRButton.createButton(xrRenderer));

// Create a 3D Scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 5;
scene.add(camera);

// Create a test cube
const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

// Setup WebXR Controllers
const controller1 = xrRenderer.xr.getController(0);
const controller2 = xrRenderer.xr.getController(1);
scene.add(controller1);
scene.add(controller2);

// Add Event Listener for Object Picking
controller1.addEventListener('selectstart', () => {
    cube.material.color.setHex(0xff0000); // Change cube color when selected
    console.log("Cube selected by controller1!");
});

controller2.addEventListener('selectstart', () => {
    cube.material.color.setHex(0x0000ff); // Change to blue when selected by controller2
    console.log("Cube selected by controller2!");
});

// Setup WebSocket Connection
const socket = io.connect("http://localhost:5000");

socket.on("response_data", function(data) {
    console.log("Received 3D Data:", data);

    // Example: Move cube based on received data
    if (data.position) {
        cube.position.set(data.position.x, data.position.y, data.position.z);
    }

    if (data.rotation) {
        cube.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z);
    }

    if (data.color) {
        cube.material.color.setHex(data.color);
    }
});

// Animation Loop
function animate() {
    xrRenderer.setAnimationLoop(() => {
        cube.rotation.y += 0.01;  // Rotate cube continuously
        xrRenderer.render(scene, camera);
    });
}
animate();

