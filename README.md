# Dante Visualizer

A whole-network, signal-flow view of a Dante audio network, as an alternative to Dante Controller's per-device view.

## Status

| Step | What | State |
|---|---|---|
| 1 | Prove we can read the network (discovery, channels, routes, signal presence) | Done (probe on the Mac) |
| 2 | Draw the network as a signal flow diagram | Done (this app) |
| 3 | Make it live: online/offline, route changes, signal indicators | Planned |
| 4 | Use it on a real system, then decide on a standalone Mac app | Planned |

The app only reads the network. It never changes routes or settings.

## Run it

Needs Python 3 (no packages) and a browser.

From a Dante Controller preset:

```sh
python3 server/serve.py --preset "path/to/My Network preset.xml"
open http://127.0.0.1:8770
```

You can also open `web/index.html` through any local web server and drop a preset onto the page.

From the live network, using the probe's snapshot (re-read whenever the file changes):

```sh
python3 server/serve.py --snapshot probe/live_snapshot.json \
  --refresh-cmd "./probe/run_probe.sh" --refresh 5
```

## Using the diagram

- **Network** view: each device appears once, inputs on the left and outputs on the right. Signal that goes back to a device on the left loops underneath the blocks in its own lane.
- **Signal flow** view: each device is split into an Outputs block (left column) and an Inputs block (right column), so every wire runs left to right.
- Routes between two devices are bundled into one wire labelled with the channel count. Click a block to open its channel list and draw every route to it. The side panel lists what it receives and sends as channel ranges.
- Hover a wire or channel to see the exact route. Drag blocks to arrange them. Positions and opened blocks are remembered per network in the browser. **Auto layout** resets them.
- Routes to a device that isn't on the network show as a dashed stub labelled "not found".

## Layout

- `web/` is the app (plain HTML, CSS and JavaScript, no build step). `model.js` reads presets and resolves routes, and `app.js` draws the diagram.
- `server/serve.py` serves the app and `/api/snapshot`, the network model as JSON, from a preset or a live snapshot.
