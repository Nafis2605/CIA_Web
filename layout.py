from trame.app import get_server
from trame.ui.vuetify import SinglePageLayout
from trame.widgets import vtk, vuetify, html
from vtkmodules.vtkFiltersSources import vtkConeSource
from vtkmodules.vtkRenderingCore import (
    vtkActor,
    vtkPolyDataMapper,
    vtkRenderer,
    vtkRenderWindow
)
# Required for rendering initialization, not necessary for local rendering
import vtkmodules.vtkRenderingOpenGL2  # noqa

# -------------------------------------------------------------------------
# VTK Pipeline
# -------------------------------------------------------------------------

renderer = vtkRenderer()
renderWindow = vtkRenderWindow()
renderWindow.AddRenderer(renderer)

# Simple VTK geometry (cone)
cone_source = vtkConeSource()
mapper = vtkPolyDataMapper()
mapper.SetInputConnection(cone_source.GetOutputPort())
actor = vtkActor()
actor.SetMapper(mapper)

renderer.AddActor(actor)
renderer.ResetCamera()

# -------------------------------------------------------------------------
# Trame Server Setup
# -------------------------------------------------------------------------

server = get_server(client_type="vue2")

with SinglePageLayout(server) as layout:
    layout.title.set_text("WebXR with VTK LocalView")

    with layout.content:
        with vuetify.VContainer(
            fluid=True,
            classes="pa-0 fill-height",
        ):
            # Local VTK view
            view = vtk.VtkLocalView(renderWindow)

            # Add WebXR Button to enter VR mode
            
            with vuetify.VBtn(icon=False, click=startVR):
                vuetify.VTextField("VR START")
                    
            

            # JavaScript for enabling WebXR and integrating VTK with WebXR
            layout.content.children += [
                html.Script("""
                    async function startVR() {
                        if ('xr' in navigator) {
                            const session = await navigator.xr.requestSession('immersive-vr', {
                                requiredFeatures: ['local', 'viewer']
                            });

                            session.addEventListener('end', () => {
                                console.log("VR session ended");
                            });

                            // Get the WebXR rendering context
                            const xrContext = session.renderState.baseLayer;

                            // Associate VTK's render window with the WebXR context
                            const canvas = document.querySelector('canvas');
                            xrContext.getContext('webgl').bindFramebuffer(xrContext.framebuffer);

                            // The WebXR session should handle rendering the VTK scene from here
                            // The VTK rendering should be updated via the WebXR interface
                            session.requestAnimationFrame((time, xrFrame) => {
                                // Apply VTK render updates
                                renderWindow.Render();
                            });

                            console.log('VR session started');
                        } else {
                            console.warn('WebXR not supported in this browser.');
                        }
                    }
                """)
            ]

# -------------------------------------------------------------------------
# Main
# -------------------------------------------------------------------------

if __name__ == "__main__":
    server.start()
