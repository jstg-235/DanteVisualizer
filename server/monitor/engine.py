"""The brain: combines Dante discovery, the clock, pings and switch data,
decides what counts as a problem, and keeps the event history.
"""
import json
import os
import sqlite3
import statistics
import subprocess
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from . import netutil
from .mdns import DanteDiscovery
from .ptp import PtpMonitor
from .switches import SWITCH_TYPES, SwitchMonitor

SEVERITY_RANK = {"critical": 3, "warning": 2, "info": 1, "ok": 0}
OFFLINE_AFTER = 30       # seconds without hearing from a device
PING_EVERY = 5


class EventLog:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("""CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY, ts REAL, severity TEXT, category TEXT, subject TEXT, message TEXT)""")
        self.db.commit()

    def add(self, severity, category, subject, message, ts=None):
        with self.lock:
            self.db.execute("INSERT INTO events (ts, severity, category, subject, message) VALUES (?,?,?,?,?)",
                            (ts or time.time(), severity, category, subject, message))
            self.db.commit()

    def recent(self, limit=300, since=None):
        with self.lock:
            if since:
                rows = self.db.execute("SELECT id, ts, severity, category, subject, message FROM events "
                                       "WHERE ts >= ? ORDER BY id DESC LIMIT ?", (since, limit)).fetchall()
            else:
                rows = self.db.execute("SELECT id, ts, severity, category, subject, message FROM events "
                                       "ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(zip(("id", "ts", "severity", "category", "subject", "message"), r)) for r in rows]

    def clear(self):
        with self.lock:
            self.db.execute("DELETE FROM events")
            self.db.commit()


class Config:
    DEFAULTS = {"interface_ip": "", "switches": [], "notifications": True, "switch_poll_seconds": 10}

    def __init__(self, path):
        self.path = path
        self.data = dict(self.DEFAULTS)
        if os.path.exists(path):
            try:
                with open(path) as f:
                    self.data.update(json.load(f))
            except Exception:
                pass

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=2)
        os.replace(tmp, self.path)


class Engine:
    def __init__(self, data_dir, demo=None):
        os.makedirs(data_dir, exist_ok=True)
        self.config = Config(os.path.join(data_dir, "config.json"))
        self.events = EventLog(os.path.join(data_dir, "history.sqlite"))
        self.demo = demo
        self.lock = threading.RLock()
        self.started = time.time()
        self.discovery = None
        self.ptp = None
        self.switches = {}
        self.known = {}          # device key -> remembered info (so we notice when it vanishes)
        self.pings = {}          # device key -> deque of (t, rtt or None)
        self.issues = {}         # key -> issue dict
        self.leader = None
        self.last_missed = {}
        self.last_notify = 0
        self.arp = {}
        self.port_devices = {}   # (switch id, ifIndex) -> device name
        self.ping_pool = ThreadPoolExecutor(max_workers=16)
        self.running = False

    # --------------------------------------------------------------- control
    def start(self):
        self.running = True
        self._start_listeners()
        for sw in self.config.data["switches"]:
            self._start_switch(sw)
        threading.Thread(target=self._loop, daemon=True, name="engine").start()
        threading.Thread(target=self._ping_loop, daemon=True, name="pinger").start()
        self.log("info", "monitor", "Dante Monitor", "Monitoring started%s." % (" in DEMO mode" if self.demo else ""))

    def _start_listeners(self):
        ip = self.config.data.get("interface_ip") or None
        if self.demo:
            self.discovery, self.ptp = self.demo.discovery, self.demo.ptp
            return
        if not ip:
            # Automatic: prefer a link-local (169.254.x.x) port - Dante's default addressing.
            ll = [i for i in netutil.list_interfaces() if i["ip"].startswith("169.254.")]
            ip = ll[0]["ip"] if ll else None
        self.auto_ip = ip
        self.discovery = DanteDiscovery(ip, log=print)
        self.discovery.start()
        self.ptp = PtpMonitor(ip, log=print)
        self.ptp.start()
        if self.ptp.error:
            self.log("warning", "clock", "Clock listener", self.ptp.error +
                     " (Is Dante Virtual Soundcard or another monitor using the clock ports?)")

    def set_interface(self, ip):
        self.config.data["interface_ip"] = ip
        self.config.save()
        if not self.demo:
            if self.discovery:
                self.discovery.stop()
            if self.ptp:
                self.ptp.stop()
            time.sleep(1.2)
            self._start_listeners()
        self.log("info", "monitor", "Dante Monitor", "Listening on network interface %s." % (ip or "auto"))

    def _start_switch(self, sw):
        client = self.demo.switch_client(sw) if self.demo else None
        mon = SwitchMonitor(sw, self._switch_event, self.config.data.get("switch_poll_seconds", 10), client=client)
        mon.port_device = lambda idx, sid=sw["id"]: self.port_devices.get((sid, idx), "")
        self.switches[sw["id"]] = mon
        mon.start()

    def add_switch(self, name, ip, stype, community=""):
        sid = "sw%d" % int(time.time() * 1000)
        sw = {"id": sid, "name": name.strip(), "ip": ip.strip(), "type": stype, "community": community.strip()}
        self.config.data["switches"].append(sw)
        self.config.save()
        self._start_switch(sw)
        self.log("info", "switch", sw["name"] or sw["ip"], "Added %s at %s." % (SWITCH_TYPES[stype]["label"], ip))
        return sw

    def remove_switch(self, sid):
        mon = self.switches.pop(sid, None)
        if mon:
            mon.stop()
        self.config.data["switches"] = [s for s in self.config.data["switches"] if s["id"] != sid]
        self.config.save()
        for key in [k for k in self.issues if k.startswith("switch:%s" % sid)]:
            self.issues.pop(key)

    # --------------------------------------------------------------- logging
    def log(self, severity, category, subject, message):
        self.events.add(severity, category, subject, message)
        if severity in ("critical", "warning"):
            self._notify(severity, subject, message)

    def _switch_event(self, severity, category, subject, message):
        self.log(severity, category, subject, message)

    def _notify(self, severity, subject, message):
        if not self.config.data.get("notifications") or self.demo or not netutil.IS_MAC:
            return
        now = time.time()
        if now - self.last_notify < 5:
            return
        self.last_notify = now
        title = ("Dante problem: " if severity == "critical" else "Dante warning: ") + subject
        script = 'display notification %s with title %s' % (json.dumps(message[:200]), json.dumps(title[:100]))
        try:
            subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

    # --------------------------------------------------------------- pinging
    def _ping_loop(self):
        ping = self.demo.ping if self.demo else netutil.ping
        while self.running:
            targets = []
            with self.lock:
                for key, d in self.known.items():
                    if d.get("ip"):
                        targets.append((key, d["ip"]))
            futures = [(k, self.ping_pool.submit(ping, ip)) for k, ip in targets]
            now = time.time()
            for key, fut in futures:
                try:
                    rtt = fut.result(timeout=5)
                except Exception:
                    rtt = None
                self.pings.setdefault(key, deque(maxlen=120)).append((now, rtt))
            arp = self.demo.arp_table() if self.demo else netutil.arp_table()
            with self.lock:
                self.arp.update(arp)
            time.sleep(PING_EVERY)

    # --------------------------------------------------------------- analysis
    def _loop(self):
        time.sleep(3)
        while self.running:
            try:
                self.evaluate()
            except Exception as e:
                print("evaluate error:", e)
            time.sleep(2)

    def evaluate(self, now=None):
        now = now or time.time()
        found = self.discovery.devices() if self.discovery else {}
        clock = self.ptp.snapshot(now) if self.ptp else {"v1_active": [], "v2_active": [], "v1_sources": []}
        new_issues = {}

        def issue(key, severity, subject, message):
            new_issues[key] = {"key": key, "severity": severity, "subject": subject, "message": message}

        # PTP v1 identifies devices by MAC address - another way to learn MACs
        for s in clock.get("v1_sources", []) + clock.get("followers", []):
            if len(s.get("source", "")) == 17 and s.get("ip"):
                self.arp.setdefault(s["ip"], s["source"])
        with self.lock:
            # --- remember devices so we notice them disappearing
            for key, d in found.items():
                if key not in self.known:
                    self.log("info", "device", d["name"], "Found %s %s at %s." %
                             (d.get("manufacturer") or "", d.get("model") or "device", d.get("ip") or "unknown IP"))
                prev = self.known.get(key, {})
                self.known[key] = dict(d, first_seen=prev.get("first_seen", now), last_port=prev.get("last_port"))

            # --- per-device health
            rows = []
            ip_owner = {}
            for key, d in sorted(self.known.items()):
                age = now - d.get("last_seen", 0)
                hist = list(self.pings.get(key, []))[-24:]
                replies = [r for _, r in hist if r is not None]
                loss = 100.0 * (len(hist) - len(replies)) / len(hist) if hist else None
                last_ping_ok = bool(hist) and hist[-1][1] is not None
                online = age < OFFLINE_AFTER or last_ping_ok
                was_down = any(("device:%s:%s" % (key, k)) in self.issues for k in ("offline", "link"))
                if was_down and last_ping_ok:
                    # Back after an outage: start the ping statistics fresh so the outage
                    # isn't reported again as "unstable connection".
                    self.pings[key] = deque([hist[-1]], maxlen=120)
                    hist = [hist[-1]]
                    replies = [hist[-1][1]]
                    loss = 0.0
                rtt_avg = round(statistics.mean(replies), 2) if replies else None
                rtt_jit = round(statistics.pstdev(replies), 2) if len(replies) > 2 else None
                mac = self._mac_for(d)
                port = self._port_for(mac, d.get("last_port"))
                if port:
                    self.known[key]["last_port"] = (port["switch_id"], port["index"])
                row = {
                    "key": key, "name": d["name"], "ip": d.get("ip"), "mac": mac,
                    "manufacturer": d.get("manufacturer"), "model": d.get("model"),
                    "channels": d.get("channels"), "rates": d.get("rates", []),
                    "latencies": d.get("latencies", []), "online": online, "last_seen_age": round(age, 1),
                    "ping_loss": round(loss, 1) if loss is not None else None, "rtt_ms": rtt_avg,
                    "rtt_jitter_ms": rtt_jit, "rtt_history": [r for _, r in hist], "port": port,
                    "is_leader": False, "status": "ok", "notes": [],
                }
                if d.get("ip"):
                    ip_owner.setdefault(d["ip"], []).append(d["name"])
                if port and not port["up"]:
                    issue("device:%s:link" % key, "critical", d["name"],
                          "Its switch port (%s) has no link - unplugged, powered off or bad cable." % port["where"])
                elif not online:
                    issue("device:%s:offline" % key, "critical", d["name"],
                          "Not heard from for %ds and not answering ping." % age)
                elif loss is not None and len(hist) >= 6 and (
                        loss >= 10 or (loss >= 5 and "device:%s:loss" % key in self.issues)):
                    issue("device:%s:loss" % key, "warning", d["name"],
                          "Missing %d%% of ping replies - unstable connection." % loss)
                if port and port.get("speed_mbps") and port["speed_mbps"] < 1000 and port.get("up"):
                    row["notes"].append("Connected at %d Mb/s" % port["speed_mbps"])
                if port and port.get("last_error_ts") and now - port["last_error_ts"] < 300:
                    issue("device:%s:porterr" % key, "warning", d["name"],
                          "Errors seen on its switch port (%s) in the last 5 minutes." % port["where"])
                rows.append(row)

            for ip, names in ip_owner.items():
                if len(names) > 1:
                    issue("ip:%s" % ip, "critical", ip, "IP address conflict: %s all use %s." % (", ".join(names), ip))

            # --- sample rate consistency
            rates = {}
            for r in rows:
                for rate in r["rates"]:
                    rates.setdefault(rate, []).append(r["name"])
            if len(rates) > 1:
                summary = "; ".join("%s Hz: %s" % (k, ", ".join(v[:6]) + ("..." if len(v) > 6 else ""))
                                    for k, v in sorted(rates.items()))
                issue("rates", "warning", "Sample rates", "Devices are not all at the same sample rate (" + summary +
                      "). Devices at different rates can't share audio.")

            # --- clock
            active = clock.get("v1_active", [])
            name_by_ip = {r["ip"]: r["name"] for r in rows if r["ip"]}
            for s in clock.get("v1_sources", []) + clock.get("v2_sources", []):
                s["name"] = name_by_ip.get(s["ip"], s["ip"])
            leader = active[0] if len(active) == 1 else None
            # A brief overlap during a normal hand-over is fine; only flag it if it lasts.
            if len(active) > 1:
                self.multi_since = getattr(self, "multi_since", None) or now
            else:
                self.multi_since = None
            if len(active) > 1 and now - self.multi_since >= 5:
                issue("clock:multi", "critical", "Clock", "%d devices are all acting as clock leader (%s). "
                      "This causes clicks and dropouts - check preferred-leader settings and network splits."
                      % (len(active), ", ".join(s["name"] for s in active)))
            if not active and rows and (now - self.started) > 15:
                if clock.get("listening"):
                    issue("clock:none", "critical", "Clock", "No clock leader heard on the network.")
            leader_name = leader["name"] if leader else None
            # Remember the last single leader, so a change is reported even if there was a gap
            # (no leader, or several) in between.
            if leader_name and leader_name != self.leader:
                if self.leader:
                    self.log("warning", "clock", "Clock", "Clock leader changed from %s to %s." % (self.leader, leader_name))
                else:
                    self.log("info", "clock", "Clock", "Clock leader is %s." % leader_name)
                self.leader = leader_name
            for s in active:
                # Report missing sync messages at most once a minute, as a total.
                rec = self.last_missed.setdefault(s["source"], {"reported": s["missed"], "t": now})
                if s["missed"] > rec["reported"] and now - rec["t"] >= 60:
                    n = s["missed"] - rec["reported"]
                    self.log("warning", "clock", "Clock", "%d clock sync message(s) from leader %s went missing "
                             "in the last %d min." % (n, s["name"], max(1, round((now - rec["t"]) / 60))))
                    rec["reported"], rec["t"] = s["missed"], now
                elif s["missed"] == rec["reported"] and now - rec["t"] >= 60:
                    rec["t"] = now
                if s.get("jitter_ms") is not None and s["jitter_ms"] > 5:
                    issue("clock:jitter", "warning", "Clock", "Clock messages from %s are arriving unevenly "
                          "(jitter %.1f ms). Possible network congestion or QoS not set up." % (s["name"], s["jitter_ms"]))
            for r in rows:
                if leader and r["ip"] == leader["ip"]:
                    r["is_leader"] = True

            # --- switches
            switches = [m.snapshot() for m in self.switches.values()]
            for sw in switches:
                if sw["reachable"] is False:
                    issue("switch:%s:down" % sw["id"], "critical", sw["label"], "Not answering SNMP: %s" % (sw["error"] or ""))
                for p in sw["ports"]:
                    p["device"] = ""
                    for r in rows:
                        if r["port"] and r["port"]["switch_id"] == sw["id"] and r["port"]["index"] == p["index"]:
                            p["device"] = r["name"]
                    self.port_devices[(sw["id"], p["index"])] = p["device"]

            # --- open/close issues, logging the changes
            for key, iss in new_issues.items():
                if key not in self.issues:
                    iss["since"] = now
                    if not key.startswith("switch:"):   # switch poller logs its own
                        self.log(iss["severity"], key.split(":")[0], iss["subject"], iss["message"])
                else:
                    iss["since"] = self.issues[key]["since"]
            for key, old in self.issues.items():
                if key not in new_issues and not key.startswith("switch:"):
                    msg = {"clock:multi": "Back to a single clock leader.",
                           "clock:none": "Clock leader heard again.",
                           "rates": "All devices are at the same sample rate again."}.get(key)
                    self.log("ok", key.split(":")[0], old["subject"], msg or "Resolved: " + old["message"])
            self.issues = new_issues

            for r in rows:
                worst = "ok"
                for iss in new_issues.values():
                    if iss["subject"] == r["name"] and SEVERITY_RANK[iss["severity"]] > SEVERITY_RANK[worst]:
                        worst = iss["severity"]
                r["status"] = worst if r["online"] else "critical"

            self.state = {
                "time": now, "demo": bool(self.demo), "uptime": round(now - self.started),
                "interface_ip": self.config.data.get("interface_ip", "") or
                ("auto: " + getattr(self, "auto_ip", None) if getattr(self, "auto_ip", None) else ""),
                "devices": rows, "clock": clock, "leader": leader_name, "switches": switches,
                "issues": sorted(new_issues.values(), key=lambda i: (-SEVERITY_RANK[i["severity"]], i["since"])),
                "notifications": self.config.data.get("notifications", True),
            }
        return self.state

    def _mac_for(self, d):
        if d.get("mac"):
            return d["mac"]
        return self.arp.get(d.get("ip")) if d.get("ip") else None

    def _port_for(self, mac, last_port=None):
        found = []
        if mac:
            for sid, mon in self.switches.items():
                idx, p = mon.port_for_mac(mac)
                if p:
                    found.append((sid, mon, idx, p))
        if not found and last_port and last_port[0] in self.switches:
            # The switch forgets a device's address when its link drops; remember where it was.
            mon = self.switches[last_port[0]]
            p = mon.ports.get(last_port[1])
            if p:
                found.append((last_port[0], mon, last_port[1], p))
        for sid, mon, idx, p in found:
            if p:
                where = "%s %s" % (mon.label, p["name"])
                return {"switch_id": sid, "switch": mon.label, "index": idx, "name": p["name"], "where": where,
                        "up": p["up"], "speed_mbps": p["speed_mbps"], "errors_new": p["errors_new"],
                        "errors_total": p["errors_total"], "util_pct": p["util_pct"],
                        "last_error_ts": p.get("last_error_ts")}
        return None

    def get_state(self):
        with self.lock:
            return getattr(self, "state", None) or self.evaluate()
