from trame.app import get_server
from trame.ui.vuetify import SinglePageLayout
from trame.ui import html

# -----------------------------------------------------------------------------
# Get a server to work with
# -----------------------------------------------------------------------------

server = get_server(client_type = "vue2")

# -----------------------------------------------------------------------------
# GUI
# -----------------------------------------------------------------------------

page = """
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Simple HTML Page</title>
</head>
<body>
  <h1>Welcome to My Simple Page</h1>
  <p>This is a simple HTML page without any dependencies like Trame, VTK, or Three.js.</p>
  
  <h2>About Me</h2>
  <p>I'm learning HTML and web development!</p>
  
  <h2>Contact</h2>
  <p>You can contact me at <a href="mailto:example@example.com">example@example.com</a>.</p>
  
  <footer>
    <p>&copy; 2025 My Simple Page</p>
  </footer>
</body>
</html>

"""

with SinglePageLayout(server) as layout:
    layout.title.set_text("Hello trame")
layout.content = page
# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    server.start()