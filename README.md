# CIA_Web


## WebXR With Trame Backend

This project integrates WebXR with a **Trame backend** to enable immersive visualization in Virtual Reality (VR) using **Three.js** and **VTK.js**.

## Installation

### 1. Install Python Dependencies
Ensure you have Python installed, then install the required Python packages:
```sh
pip install trame trame-vtk trame-client flask-socketio
```

### 2. Install JavaScript Dependencies
Install the required JavaScript libraries using npm:
```sh
npm install three@latest @webxr/webxr-polyfill vtk.js
```

## Running the Server from VS Code Terminal

Start the Trame server by executing from terminal:
```sh
python app.py
```

## Accessing WebXR

### Supported Browsers
- **Google Chrome** (Recommended)
- **Microsoft Edge**
- **Firefox Nightly**

### Browser Settings
Before running the WebXR experience, enable the following flags in Chrome/Edge:
1. Open `chrome://flags` (or `edge://flags` in Edge).
2. Enable **WebXR**.
3. Enable **WebGL 2.0**.
4. Restart the browser.

### Entering VR Mode
1. Open the application in a WebXR-compatible browser.
2. Click the **'Enter VR'** button.
3. Put on your VR headset and enjoy the experience!
