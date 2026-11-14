"""The Monitor view's data: Dante Monitor's engine running inside the diagram server.

Everything is served from the diagram server's own port under /api/monitor/, so the
diagram and the Monitor view share one server and one picture of the network.

What it adds to Dante Monitor's own checks (pings, clock, switches):
  * the netaudio daemon's open issues (clock sync, address conflicts, failed
    subscriptions...), shown in the same problem list and logged in the same history;
  * per-device badges for clock and IP problems, which the diagram draws on its blocks;
  * in demo mode, a pretend network for the diagram that matches the monitor's demo.

It only listens and reads. Nothing here changes a device or a switch.
"""
import csv
import io
import json
import os
import shutil
import threading
import time
import urllib.request

from monitor import netutil
from monitor.engine import Engine
from monitor.snmp import SnmpClient, SnmpError, text
from monitor.switches import SWITCH_TYPES

# netaudio issue kinds that get a badge on the diagram, and which badge.
CLOCK_KINDS = {"clock_synchronization", "clock_muted", "clock_frequency_variation"}
IP_KINDS = {"address_conflict", "subnet_conflict"}
SEVERITY = {"critical": "critical", "error": "critical", "warning": "warning", "notice": "info", "info": "info"}
RANK = {"critical": 3, "warning": 2, "info": 1, "ok": 0}


def _iso_to_ts(s):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return time.time()


# Where the standalone Dante Monitor app kept its settings and history.
OLD_APP_DIR = os.path.expanduser("~/Library/Application Support/Dante Monitor")


def import_old_app(data_dir, old_dir=OLD_APP_DIR):
    """First run only: carry over the standalone app's switch list and history.
    Its interface choice and notification setting are not carried over: the monitor now
    follows the app's Network menu, and notifications start off."""
    if os.path.exists(os.path.join(data_dir, "config.json")) or not os.path.isdir(old_dir):
        return False
    os.makedirs(data_dir, exist_ok=True)
    try:
        with open(os.path.join(old_dir, "config.json")) as f:
            old = json.load(f)
        cfg = {"interface_ip": "", "notifications": False,
               "switches": old.get("switches") or [], "switch_poll_seconds": old.get("switch_poll_seconds", 10)}
        with open(os.path.join(data_dir, "config.json"), "w") as f:
            json.dump(cfg, f, indent=2)
    except (OSError, ValueError):
        pass
    hist = os.path.join(old_dir, "history.sqlite")
    if os.path.exists(hist) and not os.path.exists(os.path.join(data_dir, "history.sqlite")):
        try:
            shutil.copy2(hist, os.path.join(data_dir, "history.sqlite"))
        except OSError:
            pass
    return True


def _short(name):
    return (name or "").removesuffix(".").removesuffix(".local")


class MonitorService:
    def __init__(self, data_dir, demo=False, daemon_url=None, log=print):
        self.log = log
        self.daemon_url = daemon_url.rstrip("/") if daemon_url else None
        self.world = None
        if demo:
            from monitor.demo import DemoWorld
            self.world = DemoWorld()
            data_dir = os.path.join(data_dir, "demo")
            try:
                os.remove(os.path.join(data_dir, "history.sqlite"))
            except OSError:
                pass
        else:
            import_old_app(data_dir)
        self.engine = Engine(data_dir, demo=self.world)
        if self.world and not self.engine.config.data["switches"]:
            self.engine.config.data["switches"] = self.world.default_switches()
        self.na_issues = {}          # issue_id -> issue dict from the netaudio daemon
        self.na_ok = None            # did the last read of the daemon's issues work?
        self.lock = threading.Lock()

    def start(self):
        self.engine.start()
        if self.daemon_url:
            threading.Thread(target=self._issues_loop, daemon=True, name="netaudio-issues").start()
        return self

    def stop(self):
        self.engine.stop()

    def follow_interface(self, name):
        """Follow the Dante network port the app uses (an interface name such as en7)."""
        if not name or self.world:
            return
        ips = [i["ip"] for i in netutil.list_interfaces() if i["name"] == name]
        if ips:
            ips.sort(key=lambda ip: not ip.startswith("169.254."))   # Dante's own addressing first
            self.engine.follow_interface(ips[0])

    # ------------------------------------------------------------ netaudio issues
    def _issues_loop(self):
        while True:
            try:
                with urllib.request.urlopen(self.daemon_url + "/issues?state=open", timeout=4) as r:
                    data = json.load(r)
                items = data.get("issues", []) if isinstance(data, dict) else data
                fresh = {i["issue_id"]: i for i in items if isinstance(i, dict) and i.get("issue_id")}
                self._log_changes(fresh)
                with self.lock:
                    self.na_issues = fresh
                self.na_ok = True
            except (OSError, ValueError):
                self.na_ok = False       # daemon not running: keep the last list, try again
            time.sleep(4)

    def _log_changes(self, fresh):
        with self.lock:
            old = self.na_issues
        if self.na_ok is None and not old:
            old = {}
        for iid, i in fresh.items():
            if iid not in old:
                sev = SEVERITY.get(str(i.get("severity")), "warning")
                self.engine.log(sev, "netaudio", _short((i.get("scope") or {}).get("device_name")) or "Network",
                                i.get("summary") or i.get("title") or i.get("kind", "issue"))
        for iid, i in old.items():
            if iid not in fresh:
                self.engine.log("ok", "netaudio", _short((i.get("scope") or {}).get("device_name")) or "Network",
                                "Resolved: " + (i.get("title") or i.get("summary") or i.get("kind", "issue")))

    def _netaudio_issues(self):
        with self.lock:
            items = list(self.na_issues.values())
        out = []
        for i in items:
            scope = i.get("scope") or {}
            names = [n for n in {_short(scope.get("device_name")), _short(scope.get("server_name"))} if n]
            out.append({
                "key": "netaudio:" + i["issue_id"],
                "kind": i.get("kind"),
                "severity": SEVERITY.get(str(i.get("severity")), "warning"),
                "subject": names[0] if names else "Network",
                "message": i.get("summary") or i.get("title") or i.get("kind"),
                "fix": i.get("suggested_remediation") or "",
                "since": _iso_to_ts(i.get("first_seen")),
                "devices": names,
                "source": "netaudio",
            })
        return out

    # ------------------------------------------------------------ state
    def state(self):
        st = dict(self.engine.get_state())
        na = self._netaudio_issues()
        issues = [dict(i, source="monitor") for i in st["issues"]] + na
        issues.sort(key=lambda i: (-RANK.get(i["severity"], 0), i.get("since") or 0))
        st["issues"] = issues
        st["netaudio"] = self.na_ok
        st["badges"] = self._badges(st, na)
        return st

    def _badges(self, st, na):
        """{device name: [{kind: "clock"|"ip", severity, text}]} for the diagram."""
        badges = {}

        def add(name, kind, severity, msg):
            for b in badges.setdefault(name, []):
                if b["kind"] == kind:
                    b["text"] += "\n" + msg
                    if RANK[severity] > RANK[b["severity"]]:
                        b["severity"] = severity
                    return
            badges[name].append({"kind": kind, "severity": severity, "text": msg})

        for i in na:
            kind = "clock" if i["kind"] in CLOCK_KINDS else "ip" if i["kind"] in IP_KINDS else None
            if kind:
                for n in i["devices"]:
                    add(n, kind, i["severity"], i["message"])
        for i in st["issues"]:
            if i.get("source") != "monitor":
                continue
            k = i["key"]
            if k.startswith("ip:"):
                for n in i["devices"]:
                    add(n, "ip", i["severity"], i["message"])
            elif k in ("clock:multi", "clock:jitter"):
                for n in i["devices"]:
                    add(n, "clock", i["severity"], i["message"])
        return badges

    # ------------------------------------------------------------ demo network for the diagram
    def demo_model(self):
        """The monitor's demo devices as a diagram model, with routes and one failed route."""
        from monitor.demo import DEVICES
        rx_count = {"FOH-Console": 72, "Monitor-Console": 72, "Amp-Rack-L": 4, "Amp-Rack-R": 4,
                    "Record-Mac": 64, "Playback-Mac": 2, "Stagebox-A": 16, "Stagebox-B": 16, "Wireless-Rx": 0}
        routes = {}   # (dst, rx channel) -> (src, tx channel, state, label)

        def patch(src, src_from, dst, dst_from, n, state="connected", label="Subscribed (unicast)"):
            for k in range(n):
                routes[(dst, dst_from + k)] = (src, str(src_from + k), state, label)

        patch("Stagebox-A", 1, "FOH-Console", 1, 32)
        patch("Stagebox-B", 1, "FOH-Console", 33, 32)
        patch("Wireless-Rx", 1, "FOH-Console", 65, 4)
        patch("Playback-Mac", 1, "FOH-Console", 69, 2)
        patch("Stagebox-A", 1, "Monitor-Console", 1, 32)
        patch("Stagebox-B", 1, "Monitor-Console", 33, 16)
        patch("Wireless-Rx", 1, "Monitor-Console", 65, 4)
        patch("FOH-Console", 1, "Amp-Rack-L", 1, 4)
        patch("FOH-Console", 5, "Amp-Rack-R", 1, 2)
        patch("FOH-Console", 7, "Amp-Rack-R", 3, 2, "error", "No connection")
        patch("FOH-Console", 1, "Record-Mac", 1, 64, label="Subscribed (multicast)")
        patch("Monitor-Console", 1, "Stagebox-A", 1, 16)
        patch("Monitor-Console", 17, "Stagebox-B", 1, 16)
        world = self.world
        devices = []
        for name, mf, model, ip, mac, ntx, _sw, _port in DEVICES:
            rx = []
            for c in range(1, rx_count.get(name, 0) + 1):
                r = routes.get((name, c))
                rx.append({"id": c, "name": f"{c:02d}", "subDevice": r[0] if r else "",
                           "subChannel": r[1] if r else "", "state": r[2] if r else None,
                           "stateLabel": r[3] if r else None})
            devices.append({
                "name": name, "model": model, "manufacturer": mf, "ipv4": ip,
                "info": {"mac": mac, "encoding": 24, "latencyMs": 1.0 if "Mac" in name else 0.25,
                         "firmware": "4.2.1.3", "clockRole": "Leader" if name == "FOH-Console" else "Follower"},
                "sampleRate": 44100 if world and world.rate_odd == name else 48000,
                "online": not (world and world.offline == name),
                "tx": [{"id": c, "name": f"{c:02d}"} for c in range(1, ntx + 1)],
                "rx": rx,
            })
        return {"source": "live", "name": "Demo network",
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "devices": devices}

    # ------------------------------------------------------------ HTTP
    def get(self, path, query):
        """Returns (status, body, content type) or None if the path isn't ours."""
        if path == "/api/monitor/state":
            return 200, self.state(), None
        if path == "/api/monitor/events":
            try:
                limit = max(1, min(5000, int(query.get("limit", ["300"])[0])))
            except ValueError:
                limit = 300
            return 200, self.engine.events.recent(limit), None
        if path == "/api/monitor/setup":
            e = self.engine
            return 200, {
                "interface": e.config.data.get("interface_ip") or e.follow_ip or e.auto_ip or "",
                "switch_types": {k: {"label": v["label"], "community": v["community"], "setup": v["setup"]}
                                 for k, v in SWITCH_TYPES.items()},
                "switches": e.config.data["switches"],
                "notifications": bool(e.config.data.get("notifications", False)),
                "demo": bool(e.demo),
            }, None
        if path == "/api/monitor/events.csv":
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["time", "severity", "category", "subject", "message"])
            for e in reversed(self.engine.events.recent(100000)):
                w.writerow([time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e["ts"])),
                            e["severity"], e["category"], e["subject"], e["message"]])
            return 200, buf.getvalue().encode(), "text/csv"
        return None

    def post(self, path, b):
        e = self.engine
        if path == "/api/monitor/notifications":
            e.config.data["notifications"] = bool(b.get("on"))
            e.config.save()
            return 200, {"ok": True, "notifications": e.config.data["notifications"]}
        if path == "/api/monitor/switches/test":
            stype = b.get("type") if b.get("type") in SWITCH_TYPES else "generic"
            community = str(b.get("community") or SWITCH_TYPES[stype]["community"])
            if self.world:
                return 200, {"ok": True, "name": "Demo switch", "descr": "Pretend switch (demo mode)"}
            try:
                c = SnmpClient(str(b.get("ip", "")).strip(), community, timeout=1.5, retries=1)
                v = c.get(["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"])
                return 200, {"ok": True, "descr": text(v.get("1.3.6.1.2.1.1.1.0")),
                             "name": text(v.get("1.3.6.1.2.1.1.5.0"))}
            except (SnmpError, OSError) as err:
                return 200, {"ok": False, "error": str(err), "setup": SWITCH_TYPES[stype]["setup"]}
        if path == "/api/monitor/switches/add":
            if not b.get("ip") or b.get("type") not in SWITCH_TYPES:
                return 400, {"error": "IP address and switch type are required"}
            sw = e.add_switch(str(b.get("name", "")), str(b["ip"]), b["type"], str(b.get("community", "")))
            return 200, {"ok": True, "switch": sw}
        if path == "/api/monitor/switches/remove":
            e.remove_switch(b.get("id"))
            return 200, {"ok": True}
        if path == "/api/monitor/events/clear":
            e.events.clear()
            return 200, {"ok": True}
        return None
