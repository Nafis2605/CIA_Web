from trame.app import get_server
from trame.ui.vuetify import SinglePageLayout
from trame.widgets.vtk import VtkRemoteView  # Correct import for VtkRemoteView
from trame.widgets import html
import vtk  # Standard VTK import for render window setup

# Initialize Trame server
server = get_server()
server.client_type = "vue2"

# Create a VTK renderer and render window
render_window = vtk.vtkRenderWindow()
renderer = vtk.vtkRenderer()
render_window.AddRenderer(renderer)

# Define UI layout
with SinglePageLayout(server) as layout:
    layout.title = "WebXR with Trame"
    layout.content.children += [
        html.Script(src="/static/vtk_webxr.js"),
        VtkRemoteView(render_window),  # Fixed import
        html.Script(
            """
            async function enableVR() {
                // Check if WebXR is available
                if ('xr' in navigator) {
                    const vrButton = document.createElement('button');
                     vrButton.textContent = 'Enter VR';
                    vrButton.style.position = 'absolute';
                    vrButton.style.top = '10px';
                    vrButton.style.left = '10px';
                    
                    vrButton.onclick = async () => {
                        try {
                            const xrSession = await navigator.xr.requestSession('immersive-vr');
                            console.log('VR Session Started:', xrSession);
                        } catch (err) {
                            console.error('Failed to start VR session:', err);
                        }
                    };
                    
                    document.body.appendChild(vrButton);
                } else {
                    console.warn('WebXR not supported in this browser.');
                }
            }
            enableVR();
            """
        ),
    ]

# Start the Trame server
if __name__ == "__main__":
    server.start()