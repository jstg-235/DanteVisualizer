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
  --monitor-data DIR    Run the Monitor view's engine (from Dante Monitor): pings, clock, switches,
                        problem history. Settings and history are kept in DIR. Its data is served
                        under /api/monitor/ on this same port.
  --monitor-demo        A pretend network with staged problems, for the diagram and the Monitor
                        view together. Needs no other source.

Level history: whatever levels are served are also recorded, one peak per channel per
second for the last hour, at /api/history?device=&side=tx|rx&ch=&seconds=, and dropouts
found in them at /api/dropouts (see level_history.py). In memory only.

Never changes routes or settings. With --daemon, two things reach devices on request:
POST /api/identify blinks one device's identify LED, and POST /api/metering asks devices
to send levels (the same non-persistent request Dante Controller sends).
The monitor only listens, pings devices and reads switches over SNMP (read-only).

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
from daemon_feed import DaemonFeed, device_info  # noqa: E402
from level_history import LevelHistory  # noqa: E402


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
            "info": device_info(d),
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
    """Plausible moving levels: routed channels carry signal, a few sit silent.
    Inputs follow their source, so the dropouts list shows the source's dropouts once,
    plus the odd input that drops on its own ("lost on the way")."""
    now = time.time()
    used_tx = {}
    for d in model["devices"]:
        for c in d["rx"]:
            if c["subDevice"]:
                used_tx.setdefault(c["subDevice"], set()).add(c["subChannel"])

    def lvl(seed, active):
        if not active or seed % 7 == 0:
            return None
        if seed % 11 == 3 and (now + seed) % 47 < 4:
            return None      # a staged dropout, for the level history and dropouts list
        v = -30 + 22 * math.sin(now * (0.7 + (seed % 5) * 0.3) + seed) + random.uniform(-3, 3)
        if seed % 13 == 5:
            v += 9           # a hot channel that clips now and then
        return round(min(0.0, v), 1)

    by_name = {d["name"]: d for d in model["devices"]}
    hashes = {d["name"]: sum(map(ord, d["name"])) for d in model["devices"]}
    out = {}
    for d in model["devices"]:
        names = used_tx.get(d["name"], set())
        h = hashes[d["name"]]
        rx = []
        for c in d["rx"]:
            src = by_name.get(c["subDevice"]) if c["subDevice"] else None
            tx = next((t for t in src["tx"] if t["name"] == c["subChannel"] or str(t["id"]) == c["subChannel"]), None) if src else None
            if tx is None or c.get("state") == "error":
                rx.append(None)
            elif (h + c["id"]) % 29 == 4 and (now + c["id"]) % 71 < 3:
                rx.append(None)  # lost on the way: the source keeps sending
            else:
                rx.append(lvl(hashes[src["name"]] + tx["id"], True))
        out[d["name"]] = {
            "age": 0, "stale": False,
            "tx": [lvl(h + c["id"], c["name"] in names or str(c["id"]) in names) for c in d["tx"]],
            "rx": rx,
        }
    return {"t": now, "devices": out}


class Source:
    def __init__(self, args, feed=None, monitor=None):
        self.args = args
        self.feed = feed
        self.monitor = monitor
        self.lock = threading.Lock()
        self.model = None
        self.mtime = None
        self.error = None

    def interface(self):
        """The Dante network port in use: the app's choice, else the one the probe found."""
        if os.environ.get("DANTE_IF"):
            return os.environ["DANTE_IF"]
        self.live_name()
        return getattr(self, "_iface", (None, None))[1]

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
        if self.monitor and self.monitor.world and not (self.feed or self.args.preset or self.args.snapshot):
            return self.monitor.demo_model()
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
    ap.add_argument("--monitor-data", metavar="DIR", help="run the Monitor view's engine, keeping its data in DIR")
    ap.add_argument("--monitor-demo", action="store_true", help="pretend network with staged problems")
    args = ap.parse_args()
    if args.refresh_cmd and not args.snapshot:
        ap.error("--refresh-cmd needs --snapshot")
    if not (args.preset or args.snapshot or args.daemon or args.monitor_demo):
        ap.error("one of --preset, --snapshot or --daemon is required")
    if args.daemon and args.preset:
        ap.error("--daemon can't be combined with --preset")

    feed = DaemonFeed(args.daemon, log=lambda m: print(m, flush=True)).start() if args.daemon else None
    if feed and args.metering:
        feed.set_metering(True)
    monitor = None
    if args.monitor_data or args.monitor_demo:
        from monitor_api import MonitorService
        data = args.monitor_data or str(Path(__file__).resolve().parent.parent / "monitor-data")
        monitor = MonitorService(data, demo=args.monitor_demo, daemon_url=args.daemon,
                                 log=lambda m: print(m, flush=True)).start()
    source = Source(args, feed, monitor)
    if monitor and not args.monitor_demo:
        def follow():
            # Keep the monitor on the same Dante port as the diagram (Network menu or automatic).
            while True:
                try:
                    monitor.follow_interface(source.interface())
                except Exception as e:  # never take the server down over this
                    print(f"monitor: {e}", flush=True)
                time.sleep(10)
        threading.Thread(target=follow, daemon=True, name="monitor-follow").start()
    if args.refresh_cmd:
        threading.Thread(target=refresher, args=(args.refresh_cmd, args.refresh), daemon=True).start()

    def current_levels():
        """Levels in the /api/levels shape, or None when there are none."""
        if feed:
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
                return lv
        if args.levels:
            try:
                return levels_from_file(args.levels)
            except (OSError, ValueError):
                return None
        if args.demo_levels:
            model = source.get()
            return demo_levels(model) if model else None
        return None

    route_cache = {"model": None, "routes": {}}

    def current_routes():
        """{(receiving device, rx channel): (sending device, tx channel or None)} for dropouts."""
        model = source.get()
        if model is None:
            return route_cache["routes"]
        if model is not route_cache["model"]:
            by_name = {d["name"]: d for d in model["devices"]}
            routes = {}
            for d in model["devices"]:
                for c in d["rx"]:
                    if not c.get("subDevice"):
                        continue
                    src = by_name.get(c["subDevice"])
                    tx = None
                    if src:
                        hit = next((t for t in src["tx"] if t["name"] == c["subChannel"]), None) or \
                            next((t for t in src["tx"] if str(t["id"]) == str(c["subChannel"])), None)
                        tx = hit["id"] if hit else None
                    routes[(d["name"], c["id"])] = (c["subDevice"], tx)
            route_cache.update(model=model, routes=routes)
        return route_cache["routes"]

    history = LevelHistory(current_levels, current_routes, log=lambda m: print(m, flush=True)).start()

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
            if path.startswith("/api/monitor/"):
                res = monitor.post(path, body) if monitor else (503, {"error": "the monitor isn't running"})
                return self.send_json(*(res or (404, {"error": "not found"})))
            if path == "/api/identify":
                if not feed:
                    return self.send_json(503, {"error": "needs the netaudio daemon (--daemon)"})
                if not feed.connected:
                    return self.send_json(503, {"error": "the netaudio daemon isn't connected"})
                try:
                    status, data = feed.identify(str(body.get("device") or ""))
                except OSError as e:
                    return self.send_json(502, {"error": f"netaudio daemon: {e}"})
                return self.send_json(status if status in (200, 400, 404, 409) else 502, data)
            if path == "/api/dropouts/clear":
                history.clear_dropouts()
                return self.send_json(200, {"ok": True})
            if not feed:
                return self.send_json(503, {"error": "needs the netaudio daemon (--daemon)"})
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
                    "monitor": bool(monitor),
                })
            if path.startswith("/api/monitor/"):
                res = monitor.get(path, urllib.parse.parse_qs(query)) if monitor else None
                if res is None:
                    return self.send_json(404, {"error": "the monitor isn't running" if not monitor else "not found"})
                status, body, ctype = res
                if ctype is None:
                    return self.send_json(status, body)
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Disposition", 'attachment; filename="dante-monitor-history.csv"')
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/snapshot" and feed:
                # Long poll: ?wait=<version> holds the request until the network changes (max 25 s).
                wait = urllib.parse.parse_qs(query).get("wait", [None])[0]
                if wait is not None and wait.isdigit():
                    feed.wait_for_change(int(wait), 25)
            if path == "/api/levels":
                lv = current_levels()
                if lv is not None:
                    return self.send_json(200, lv)
                if args.levels and not feed:
                    try:
                        levels_from_file(args.levels)
                    except (OSError, ValueError) as e:
                        return self.send_json(503, {"error": str(e)})
                return self.send_json(404, {"error": "no levels feed"})
            if path == "/api/history":
                q = urllib.parse.parse_qs(query)
                try:
                    side = q.get("side", ["tx"])[0]
                    ch = int(q.get("ch", ["0"])[0])
                    seconds = int(q.get("seconds", ["600"])[0])
                except ValueError:
                    return self.send_json(400, {"error": "bad channel or seconds"})
                if side not in ("tx", "rx"):
                    return self.send_json(400, {"error": "side must be tx or rx"})
                return self.send_json(200, history.series(q.get("device", [""])[0], side, ch, seconds))
            if path == "/api/dropouts":
                return self.send_json(200, history.dropout_list())
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
        if monitor:
            monitor.stop()


if __name__ == "__main__":
    main()
