# Dante Visualizer

A whole-network, signal-flow view of a Dante audio network, as an alternative to Dante Controller's per-device view.

## Status

| Step | What | State |
|---|---|---|
| 1 | Prove we can read the network (discovery, channels, routes, signal presence) | Done (probe on the Mac) |
| 2 | Draw the network as a signal flow diagram | Done (this app) |
| 3 | Make it live: online/offline, route changes, signal indicators | Done |
| 4 | Standalone Mac app | In progress (`mac/`) |
| 5 | Instant updates from the netaudio daemon, Identify button | Done |

The app never changes routes or settings. The only requests it sends to devices are metering start/stop (the same non-persistent request Dante Controller sends) and identify, when you press **Identify**.

## Mac app

`mac/build_app.sh --install` builds **Dante Visualizer.app** with the Command Line Tools (no Xcode) and copies it to `~/Applications`. The app opens the diagram in its own window and runs everything else itself: the netaudio daemon, and the diagram server on 127.0.0.1.

- **Instant updates.** The app uses a netaudio daemon that's already running on port 4780, or starts one (`netaudio daemon run`, log in `logs/daemon.log`) and stops it on quit. The diagram follows the daemon's live event stream, so a route made or removed in Dante Controller, or a device coming or going, shows within a moment. Levels come from the daemon too.
- The daemon's metering port is set to 8772, because Dante Controller holds the standard 8752 and the daemon won't start without it.
- If the daemon can't start, the app works as before: it re-reads the network every 10 seconds and runs its own metering helper. If the daemon stops while the app runs, the diagram falls back to the 10-second refresh until it's back. **Signal → Live Signal Levels** (⇧⌘M) turns metering on or off, and quitting sends "stop metering" to every device.

- The first launch builds a Python environment with netaudio in `~/Library/Application Support/Dante Visualizer/venv`. That needs Python 3.10 or newer from python.org and an internet connection once.
- Logs: **Dante Visualizer → Show Logs in Finder**.
- Menus: ⌘O open a preset or setup, ⌘S save setup, ⌘1/⌘2 views, ⌘E expand or collapse all, ⌘L auto layout, ⌘0 fit.
- It's arm64 only (netaudio's native core is arm64) and ad-hoc signed, so other Macs will show a Gatekeeper warning until it's signed with a Developer ID.

## Engine (`probe/`)

- `refresh_snapshot.sh` reads devices, channels and routes once (read-only) and writes `live_snapshot.json`.
- `run_meter_daemon.sh` / `meter_daemon.py` keep metering going and write `levels.json` about 5 times a second.
- `dante_iface.sh` finds the network port the Dante devices are on. `shim/` ties Python's sockets to that port, because macOS can have link-local routes on several ports.
- With `DV_PYTHON` and `DV_DATA` unset, they use `probe/.venv` and write next to themselves. The Mac app sets both.

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

From the netaudio daemon (start it with `netaudio daemon run`), with the snapshot as a fallback:

```sh
python3 server/serve.py --daemon --metering --snapshot probe/live_snapshot.json
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
- **Expand all / Collapse all** (or press E) opens or closes every block's channel list.
- Hover a wire or channel to see the exact route. Drag blocks to arrange them. Positions and opened blocks are remembered per network in the browser. **Auto layout** resets them.
- Routes to a device that isn't on the network show as a dashed stub labelled "not found".
- **Identify** (in the side panel, live network through the daemon only): blinks the device's identify LED so you can find it in the rack.
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
- `server/serve.py` serves the app and `/api/snapshot`, the network model as JSON, from a preset, a live snapshot, or the netaudio daemon (`--daemon`). With the daemon, `/api/snapshot?wait=<version>` holds the request until the network changes, `POST /api/identify {"device": name}` blinks a device, and `POST /api/metering {"on": true|false}` starts or stops levels. POSTs from other web pages are refused.
- `server/daemon_feed.py` follows the daemon's `/events` stream and turns it into the same model as a snapshot.
