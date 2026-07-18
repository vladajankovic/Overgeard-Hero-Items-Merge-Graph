# Overgeared Item Atlas

The graph reads `item_table.html` directly in the browser; no generated data file or third-party graph library is required. The Pet table is intentionally excluded.

## Run

From this folder, start any static web server. For example:

```powershell
python -m http.server 8000
```

Then open <http://localhost:8000/>.

Opening `index.html` directly also works, but browsers normally block automatic `file://` reads. In that case the app shows a file chooser for `item_table.html`.

## GitHub Pages

The repository is ready to publish as a static GitHub Pages site. Keep this file layout intact, push the repository to GitHub, and configure Pages to deploy from the repository root. The application is served directly by the single root `index.html`.

No build command, package installation, server-side code, or environment variables are required. The `.nojekyll` file ensures GitHub serves the source files directly.

## Controls

- Scroll or use a trackpad to move vertically and horizontally through the graph.
- Click and drag the graph background to pan in any direction.
- On touch screens, drag with one finger and pinch with two fingers to zoom.
- Hold `Shift` while scrolling to move horizontally with a mouse wheel.
- Hold `Ctrl` (or `Cmd` on macOS) while scrolling to zoom around the pointer.
- Hover an item to highlight its immediate merge paths.
- Click an item to frame it with its ingredients and products.
- Use search or the class filter to narrow the graph. Universal items remain visible when a specific class is selected.
- Warrior is selected by default; the complete `Universal + All` view is the final filter option.
- Press `F` to fit the graph and `Escape` to clear a selection.

The interface adapts to desktop, tablet, and phone layouts. On phones, item details open as a bottom sheet so the graph remains usable behind them.
