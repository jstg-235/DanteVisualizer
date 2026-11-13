#!/usr/bin/env python3
"""Serve the Dante Visualizer web app and the network model it draws.

Data sources (pick one):
  --preset FILE.xml     A Dante Controller preset (a saved picture of the network).
  --snapshot FILE.json  A live snapshot written by the probe (probe/live_snapshot.json).
                        The file is re-read whenever it changes, so anything that keeps
                        rewriting it (see --refresh-cmd) makes the diagram live.
  --refresh-cmd CMD     With --snapshot: run CMD every --refresh seconds to rewrite the snapshot.

Only reads the network; never changes routes or settings.

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
import xml.etree.ElementTree as ET
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


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
    iface = (snap.get("interface") or {}).get("name")
    return {"source": "live", "name": "Live network" + (f" ({iface})" if iface else ""),
            "capturedAt": snap.get("captured_at"), "devices": devices}


class Source:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.model = None
        self.mtime = None
        self.error = None

    def get(self):
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
    while True:
        started = time.time()
        try:
            subprocess.run(cmd, shell=True, check=False, timeout=max(30, every * 4))
        except subprocess.TimeoutExpired:
            print("refresh command timed out", file=sys.stderr)
        time.sleep(max(0.5, every - (time.time() - started)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--preset")
    src.add_argument("--snapshot")
    ap.add_argument("--refresh-cmd")
    ap.add_argument("--refresh", type=float, default=5.0, help="seconds between refreshes (default 5)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    if args.refresh_cmd and not args.snapshot:
        ap.error("--refresh-cmd needs --snapshot")

    source = Source(args)
    if args.refresh_cmd:
        threading.Thread(target=refresher, args=(args.refresh_cmd, args.refresh), daemon=True).start()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(WEB), **kw)

        def do_GET(self):
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
    print(f"Dante Visualizer on http://{args.host}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
