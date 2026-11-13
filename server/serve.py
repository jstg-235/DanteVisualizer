#!/usr/bin/env python3
"""Serve the Dante Visualizer web app and the network model it draws.

Data sources (pick one):
  --preset FILE.xml     A Dante Controller preset (a saved picture of the network).
  --snapshot FILE.json  A live snapshot written by the probe (probe/live_snapshot.json).
                        The file is re-read whenever it changes, so anything that keeps
                        rewriting it (see --refresh-cmd) makes the diagram live.
  --refresh-cmd CMD     With --snapshot: run CMD every --refresh seconds to rewrite the snapshot.
  --levels FILE.json    Signal levels written by the metering helper on the Mac:
                        {"devices": {"<name>": {"t": <unix time>, "tx": [raw...], "rx": [raw...]}}}
                        raw is Dante's 1 byte per channel: raw/2 = -dBFS, 254/255 = muted.
                        Served at /api/levels in dBFS; a device not updated for 3 s is marked stale.
  --demo-levels         Make up moving levels on routed channels, for trying the app without devices.
  --daemon [URL]        Follow the netaudio daemon's live event stream (default http://127.0.0.1:4780).
                        Devices, routes and levels then update the moment they change. Can be combined
                        with --snapshot (and --refresh-cmd, --levels), which are used whenever the
                        daemon isn't reachable.

Never changes routes or settings. With --daemon, two things reach devices on request:
POST /api/identify blinks one device's identify LED, and POST /api/metering asks devices
to send levels (the same non-persistent request Dante Controller sends).

  python3 server/serve.py --preset "samples/HY4 Network preset.xml"
  open http://127.0.0.1:8770
"""
import argparse
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import random
import math
import signal
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from daemon_feed import DaemonFeed  # noqa: E402


def model_from_preset(path):
    root = ET.parse(path).getroot()
    devices = []
    for d in root.findall("device"):
        tx = [{"id": int(c.get("danteId")),
               "name": (c.findtext("label") or c.findtext("name") or c.get("danteId")).strip()}
              for c in d.findall("txchannel")]
        rx = [{"id": int(c.get("danteId")),
               "name": (c.findtext("name") or c.get("danteId")).strip(),
               "subDevice": (c.findtext("subscribed_device") or "").strip(),
               "subChannel": (c.findtext("subscribed_channel") or "").strip()}
              for c in d.findall("rxchannel")]
        devices.append({
            "name": d.findtext("name", "").strip(),
            "model": d.findtext("model_name", "").strip(),
            "manufacturer": d.findtext("manufacturer_name", "").strip(),
            "sampleRate": int(d.findtext("samplerate") or 0) or None,
            "online": True,
            "tx": sorted(tx, key=lambda c: c["id"]),
            "rx": sorted(rx, key=lambda c: c["id"]),
        })
    return {"source": "preset", "name": root.findtext("name", "Preset").strip(), "devices": devices}


def model_from_snapshot(path):
    """Convert the probe's live_snapshot.json into the app's model."""
    snap = json.loads(Path(path).read_text())
    devices = []
    for d in snap.get("devices", []):
        tx = [{"id": int(c["n"]), "name": c.get("label") or c.get("name") or str(c["n"])}
              for c in d.get("tx_channels") or []]
        rx = []
        for c in d.get("rx_channels") or []:
            sub = c.get("subscription") or {}
            rx.append({
                "id": int(c["n"]),
                "name": c.get("name") or str(c["n"]),
                "subDevice": sub.get("tx_device") or "",
                "subChannel": sub.get("tx_channel") or "",
                "state": sub.get("state"),
            })
        devices.append({
            "name": d["name"],
            "model": d.get("model") or "",
            "manufacturer": d.get("manufacturer") or "",
            "sampleRate": d.get("sample_rate_hz"),
            "online": d.get("online", True),
            "ipv4": d.get("ipv4"),
            "tx": sorted(tx, key=lambda c: c["id"]),
            "rx": sorted(rx, key=lambda c: c["id"]),
        })
    devices.sort(key=lambda d: d["name"].lower())  # stable order, so unchanged networks don't redraw
    iface = (snap.get("interface") or {}).get("name")
    return {"source": "live", "name": "Live network" + (f" ({iface})" if iface else ""),
            "capturedAt": snap.get("captured_at"), "devices": devices}


STALE_AFTER = 3.0


def raw_to_db(raw):
    """Dante metering byte -> dBFS, or None when muted / no value."""
    if raw is None or raw >= 254:
        return None
    return -raw / 2.0


def levels_from_file(path):
    data = json.loads(Path(path).read_text())
    now = time.time()
    out = {}
    for name, d in (data.get("devices") or {}).items():
        t = d.get("t") or 0
        out[name] = {
            "age": round(now - t, 2),
            "stale": now - t > STALE_AFTER,
            "tx": [raw_to_db(v) for v in d.get("tx") or []],
            "rx": [raw_to_db(v) for v in d.get("rx") or []],
        }
    return {"t": now, "devices": out}


def demo_levels(model):
    """Plausible moving levels: routed channels carry signal, a few sit silent."""
    now = time.time()
    used_tx = {}
    for d in model["devices"]:
        for c in d["rx"]:
            if c["subDevice"]:
                used_tx.setdefault(c["subDevice"], set()).add(c["subChannel"])
    out = {}
    for d in model["devices"]:
        def lvl(seed, active):
            if not active or seed % 7 == 0:
                return None
            v = -30 + 22 * math.sin(now * (0.7 + (seed % 5) * 0.3) + seed) + random.uniform(-3, 3)
            return round(min(0.0, v), 1)
        names = used_tx.get(d["name"], set())
        h = sum(map(ord, d["name"]))
        out[d["name"]] = {
            "age": 0, "stale": False,
            "tx": [lvl(h + c["id"], c["name"] in names or str(c["id"]) in names) for c in d["tx"]],
            "rx": [lvl(h + c["id"], bool(c["subDevice"])) for c in d["rx"]],
        }
    return {"t": now, "devices": out}


class Source:
    def __init__(self, args, feed=None):
        self.args = args
        self.feed = feed
        self.lock = threading.Lock()
        self.model = None
        self.mtime = None
        self.error = None

    def live_name(self):
        iface = None
        if self.args.snapshot:
            try:
                m = os.path.getmtime(self.args.snapshot)
                if getattr(self, "_iface", (None, None))[0] != m:
                    snap = json.loads(Path(self.args.snapshot).read_text())
                    self._iface = (m, (snap.get("interface") or {}).get("name"))
                iface = self._iface[1]
            except (OSError, ValueError):
                pass
        return "Live network" + (f" ({iface})" if iface else "")

    def get(self):
        if self.feed:
            model, version = self.feed.snapshot()
            if model is not None:
                # Same name as the snapshot model, so saved layouts carry over between the two.
                return {**model, "name": self.live_name(), "version": version}
            if not self.args.snapshot:
                self.error = "waiting for the netaudio daemon"
                return None
        with self.lock:
            try:
                if self.args.preset:
                    if self.model is None:
                        self.model = model_from_preset(self.args.preset)
                else:
                    m = os.path.getmtime(self.args.snapshot)
                    if m != self.mtime:
                        self.model = model_from_snapshot(self.args.snapshot)
                        self.mtime = m
                self.error = None
            except Exception as e:  # keep serving the last good model
                self.error = str(e)
            return self.model


def refresher(cmd, every):
    # Keeps running with the daemon too: the snapshot is the fallback, and the metering
    # helper reads device names from it. With the daemon up, `netaudio device list` asks it.
    while True:
        started = time.time()
        try:
            subprocess.run(cmd, shell=True, check=False, timeout=max(30, every * 4))
        except subprocess.TimeoutExpired:
            print("refresh command timed out", file=sys.stderr)
        time.sleep(max(0.5, every - (time.time() - started)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--preset")
    src.add_argument("--snapshot")
    ap.add_argument("--daemon", nargs="?", const="http://127.0.0.1:4780", metavar="URL")
    ap.add_argument("--metering", action="store_true", help="with --daemon: ask devices for levels from the start")
    ap.add_argument("--refresh-cmd")
    ap.add_argument("--levels")
    ap.add_argument("--demo-levels", action="store_true")
    ap.add_argument("--refresh", type=float, default=5.0, help="seconds between refreshes (default 5)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    if args.refresh_cmd and not args.snapshot:
        ap.error("--refresh-cmd needs --snapshot")
    if not (args.preset or args.snapshot or args.daemon):
        ap.error("one of --preset, --snapshot or --daemon is required")
    if args.daemon and args.preset:
        ap.error("--daemon can't be combined with --preset")

    feed = DaemonFeed(args.daemon, log=lambda m: print(m, flush=True)).start() if args.daemon else None
    if feed and args.metering:
        feed.set_metering(True)
    source = Source(args, feed)
    if args.refresh_cmd:
        threading.Thread(target=refresher, args=(args.refresh_cmd, args.refresh), daemon=True).start()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(WEB), **kw)

        def send_json(self, status, obj):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def same_origin(self):
            # Refuse requests that other web pages could make on the viewer's behalf.
            origin = self.headers.get("Origin")
            return not origin or urllib.parse.urlsplit(origin).netloc == self.headers.get("Host")

        def read_json(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}") if n <= 65536 else None
            except ValueError:
                return None

        def do_POST(self):
            path = self.path.split("?")[0]
            if not self.same_origin() or not self.headers.get("Content-Type", "").startswith("application/json"):
                return self.send_json(403, {"error": "forbidden"})
            body = self.read_json()
            if not isinstance(body, dict):
                return self.send_json(400, {"error": "expected a JSON object"})
            if not feed:
                return self.send_json(503, {"error": "needs the netaudio daemon (--daemon)"})
            if path == "/api/identify":
                if not feed.connected:
                    return self.send_json(503, {"error": "the netaudio daemon isn't connected"})
                try:
                    status, data = feed.identify(str(body.get("device") or ""))
                except OSError as e:
                    return self.send_json(502, {"error": f"netaudio daemon: {e}"})
                return self.send_json(status if status in (200, 400, 404, 409) else 502, data)
            if path == "/api/metering":
                feed.set_metering(bool(body.get("on")))
                return self.send_json(200, {"metering": feed.metering})
            return self.send_json(404, {"error": "not found"})

        def do_GET(self):
            path, _, query = self.path.partition("?")
            if path == "/api/status":
                return self.send_json(200, {
                    "daemon": bool(feed and feed.connected),
                    "metering": bool(feed and feed.metering),
                    "canIdentify": bool(feed and feed.connected),
                })
            if path == "/api/snapshot" and feed:
                # Long poll: ?wait=<version> holds the request until the network changes (max 25 s).
                wait = urllib.parse.parse_qs(query).get("wait", [None])[0]
                if wait is not None and wait.isdigit():
                    feed.wait_for_change(int(wait), 25)
            if path == "/api/levels" and feed:
                # The daemon's levels, plus the helper's file (--levels) for devices the daemon
                # has none for: some (e.g. Fourier, Universal Audio) only announce signal presence
                # in their heartbeats, which the daemon doesn't pass on.
                lv = feed.levels()
                if args.levels and feed.metering:
                    try:
                        extra = levels_from_file(args.levels)["devices"]
                    except (OSError, ValueError):
                        extra = {}
                    for name, d in extra.items():
                        if lv is None:
                            lv = {"t": time.time(), "devices": {}}
                        cur = lv["devices"].get(name)
                        if cur is None or (cur["stale"] and not d["stale"]):
                            lv["devices"][name] = d
                if lv is not None:
                    return self.send_json(200, lv)
            if self.path.split("?")[0] == "/api/levels":
                if args.levels:
                    try:
                        return self.send_json(200, levels_from_file(args.levels))
                    except (OSError, ValueError) as e:
                        return self.send_json(503, {"error": str(e)})
                if args.demo_levels and source.get():
                    return self.send_json(200, demo_levels(source.get()))
                return self.send_json(404, {"error": "no levels feed"})
            if self.path.split("?")[0] == "/api/snapshot":
                model = source.get()
                if model is None:
                    body = json.dumps({"error": source.error or "no data yet"}).encode()
                    self.send_response(503)
                else:
                    body = json.dumps(model).encode()
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

        def log_message(self, fmt, *a):
            pass

    httpd = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"Dante Visualizer on http://{args.host}:{args.port}", flush=True)
    # SIGTERM (how the Mac app stops the server) ends like Ctrl-C, so metering is released.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if feed and feed.metering:
            feed.set_metering(False)


if __name__ == "__main__":
    main()
