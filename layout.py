import trame
from trame.ui.vuetify import SinglePageLayout, vApp, vMain, vContainer, vBtn
from trame.widgets import html

# Create a Trame app instance
app = trame.App()

# Define the layout of the page
def layout():
    # Using Vuetify's VApp as the main wrapper
    with vApp():
        # SinglePageLayout provides the framework for header, sidebar, and content
        with SinglePageLayout() as layout:
            # Define header content
            layout.header = html.Div()  # You can put your HTML content here

            # Define the sidebar
            layout.sidebar = html.Div()  # This will be a custom HTML sidebar
            
            # Define the footer (optional)
            layout.footer = html.Div()  # Your footer content
            
            # Define the main content
            layout.main = html.Div(
                """<h2>Custom HTML Inside Trame</h2>
                <p>This is your custom HTML content!</p>
                <button id="myButton">Click me!</button>"""
            )

# Add JavaScript inside the layout
@trame.route
def javascript_code():
    # JavaScript to handle button click inside the Trame application
    return """
        document.getElementById('myButton').addEventListener('click', function() {
            alert('Button clicked!');
        });
    """

# Add the layout to the app
layout()

# Run the app
if __name__ == "__main__":
    app.run()
