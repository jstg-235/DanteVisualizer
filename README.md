# Dante Visualizer

A whole-network, signal-flow view of a Dante audio network, as an alternative to Dante Controller's per-device view.

## Status

| Step | What | State |
|---|---|---|
| 1 | Prove we can read the network (discovery, channels, routes, signal presence) | Done (probe on the Mac) |
| 2 | Draw the network as a signal flow diagram | Done (this app) |
| 3 | Make it live: online/offline, route changes, signal indicators | In progress |
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

With live signal levels from the metering helper (see below):

```sh
python3 server/serve.py --snapshot probe/live_snapshot.json --refresh-cmd "./probe/refresh_snapshot.sh" \
  --levels probe/levels.json
```

To try the indicators without devices, add `--demo-levels` to a preset run.

## Using the diagram

- **Network** view: each device appears once, inputs on the left and outputs on the right. Signal that goes back to a device on the left loops underneath the blocks in its own lane.
- **Signal flow** view: each device is split into an Outputs block (left column) and an Inputs block (right column), so every wire runs left to right.
- Routes between two devices are bundled into one wire labelled with the channel count. Click a block to open its channel list and draw every route to it. The side panel lists what it receives and sends as channel ranges.
- Hover a wire or channel to see the exact route. Drag blocks to arrange them. Positions and opened blocks are remembered per network in the browser. **Auto layout** resets them.
- Routes to a device that isn't on the network show as a dashed stub labelled "not found".
- **Signal indicators** (when levels are available): each channel gets a dot that is green for signal, yellow above −6 dBFS and red at clip. Hollow dots mean no reading. Wires carrying signal light up and animate. Bundles show how many of their channels are live ("27/32 live"), and closed blocks show a count of channels with signal. Hover a wire or channel to see its level. Signal means −60 dBFS or louder.
- **Save setup** downloads a `.json` file with the block positions for both views, opened blocks, colours, zoom and the network itself. **Open…** takes that file or a Dante Controller preset. When the app is showing the live network, opening a setup rearranges the live diagram to match it, and devices the setup doesn't know are placed below the others. Otherwise it shows the saved network.

## Levels feed

`--levels FILE` reads a JSON file written by the metering helper on the Mac and serves it at `/api/levels`:

```json
{"devices": {"<device name>": {"t": 1794597051.5, "tx": [44, 255], "rx": [60, 254]}}}
```

Each value is Dante's metering byte for that channel, starting from channel 1: `raw / 2` is dB below full scale, and 254 or 255 means muted or no value. A device that hasn't been updated for 3 seconds is shown as having no reading.

## Layout

- `web/` is the app (plain HTML, CSS and JavaScript, no build step). `model.js` reads presets and resolves routes, and `app.js` draws the diagram.
- `server/serve.py` serves the app and `/api/snapshot`, the network model as JSON, from a preset or a live snapshot.
