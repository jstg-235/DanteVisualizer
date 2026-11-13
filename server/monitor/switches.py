"""Switch monitoring over SNMP, with a profile per switch type.

Each profile holds the defaults and tips for one switch family. All of them
use the standard SNMP tables (IF-MIB, BRIDGE-MIB, LLDP-MIB), which both
Netgear M4250 and Luminex GigaCore switches support.
"""
import threading
import time

from .snmp import SnmpClient, SnmpError, table_by_index, text

SWITCH_TYPES = {
    "netgear_m4250": {
        "label": "Netgear M4250 (AV Line)",
        "community": "public",
        "version": "2c",
        "setup": ("In the M4250's main web interface (not the AV UI), go to System > SNMP and make sure "
                  "SNMP v1/v2c is on with a read-only community (default 'public')."),
    },
    "luminex_gigacore": {
        "label": "Luminex GigaCore",
        "community": "Public",
        "version": "2c",
        "setup": ("SNMP is OFF by default on GigaCores. Turn it on in Araneo or the switch's web interface. "
                  "GigaCores use SNMP v1/v2c with the fixed community 'Public' (capital P)."),
    },
    "generic": {
        "label": "Other managed switch (SNMP)",
        "community": "public",
        "version": "2c",
        "setup": "Enable SNMP v2c with a read-only community on the switch.",
    },
}

# Standard OIDs
SYS_DESCR = "1.3.6.1.2.1.1.1.0"
SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
SYS_NAME = "1.3.6.1.2.1.1.5.0"
IF = "1.3.6.1.2.1.2.2.1."
IFX = "1.3.6.1.2.1.31.1.1.1."
COLUMNS = {
    "descr": IF + "2", "type": IF + "3", "speed": IF + "5", "admin": IF + "7", "oper": IF + "8",
    "last_change": IF + "9", "in_discards": IF + "13", "in_errors": IF + "14",
    "out_discards": IF + "19", "out_errors": IF + "20",
    "name": IFX + "1", "in_octets": IFX + "6", "in_mcast": IFX + "8", "in_bcast": IFX + "9",
    "out_octets": IFX + "10", "high_speed": IFX + "15", "alias": IFX + "18",
    "fcs_errors": "1.3.6.1.2.1.10.7.2.1.3",
}
COUNTERS = ("in_discards", "in_errors", "out_discards", "out_errors", "fcs_errors")
RATES = ("in_octets", "out_octets", "in_mcast", "in_bcast")
Q_FDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2"   # dot1qTpFdbPort  (vlan.mac -> bridge port)
D_FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"       # dot1dTpFdbPort  (mac -> bridge port)
BASE_PORT_IFINDEX = "1.3.6.1.2.1.17.1.4.1.2"
LLDP_REM_SYSNAME = "1.0.8802.1.1.2.1.4.1.1.9"
LLDP_REM_PORTDESC = "1.0.8802.1.1.2.1.4.1.1.8"
ETHERNET_TYPES = {6, 62, 69, 117}


def _mac_from_index(parts):
    return ":".join("%02x" % int(p) for p in parts)


class SwitchMonitor:
    def __init__(self, cfg, emit, poll_seconds=10, client=None):
        """cfg: {'id','name','ip','type','community'}; emit(severity, category, subject, message)"""
        self.cfg = cfg
        prof = SWITCH_TYPES.get(cfg.get("type"), SWITCH_TYPES["generic"])
        self.profile = prof
        self.client = client or SnmpClient(cfg["ip"], cfg.get("community") or prof["community"],
                                           version=prof["version"])
        self.emit = emit
        self.poll_seconds = poll_seconds
        self.lock = threading.Lock()
        self.reachable = None
        self.error = None
        self.sys = {}
        self.ports = {}          # ifIndex -> dict
        self.prev = {}           # ifIndex -> previous raw counters
        self.prev_time = None
        self.prev_uptime = None
        self.mac_port = {}       # mac -> ifIndex
        self.lldp = {}           # ifIndex -> neighbour text
        self.last_fdb = 0
        self.running = False
        self.polls = 0
        self.port_device = lambda idx: ""   # set by the engine: which Dante device is on a port
        self.pending_errors = {}            # ifIndex -> error counts not yet reported

    @property
    def label(self):
        return self.cfg.get("name") or self.sys.get("name") or self.cfg["ip"]

    def start(self):
        self.running = True
        threading.Thread(target=self._loop, daemon=True, name="switch-%s" % self.cfg["ip"]).start()

    def stop(self):
        self.running = False

    def _loop(self):
        while self.running:
            try:
                self.poll()
            except Exception as e:  # never let one bad poll kill the thread
                self.error = str(e)
            for _ in range(int(self.poll_seconds * 10)):
                if not self.running:
                    return
                time.sleep(0.1)

    # ------------------------------------------------------------------ poll
    def poll(self, now=None):
        now = now or time.time()
        try:
            sysv = self.client.get([SYS_DESCR, SYS_UPTIME, SYS_NAME])
            raw = {}
            for key, col in COLUMNS.items():
                try:
                    raw[key] = table_by_index(self.client.walk(col), col)
                except SnmpError:
                    if key in ("descr", "oper"):
                        raise
                    raw[key] = {}
        except SnmpError as e:
            if self.reachable is not False:
                self.emit("critical", "switch", self.label,
                          "Switch not answering SNMP. %s" % self.profile["setup"])
            self.reachable = False
            self.error = str(e)
            return
        if self.reachable is False:
            self.emit("ok", "switch", self.label, "Switch is answering again.")
        self.reachable = True
        self.error = None
        uptime = sysv.get(SYS_UPTIME) or 0
        self.sys = {"descr": text(sysv.get(SYS_DESCR)), "name": text(sysv.get(SYS_NAME)),
                    "uptime_s": uptime / 100.0}
        rebooted = self.prev_uptime is not None and uptime < self.prev_uptime
        if rebooted:
            self.emit("warning", "switch", self.label, "Switch restarted (uptime went back to %s)."
                      % _fmt_duration(uptime / 100.0))
            self.prev = {}
        self.prev_uptime = uptime

        if now - self.last_fdb > 60 or self.polls == 0:
            self._read_fdb_and_lldp(raw)
            self.last_fdb = now

        dt = (now - self.prev_time) if self.prev_time else None
        ports = {}
        for idx, descr in raw["descr"].items():
            iftype = raw["type"].get(idx)
            if iftype not in ETHERNET_TYPES:
                continue
            speed = raw["high_speed"].get(idx) or ((raw["speed"].get(idx) or 0) // 1_000_000)
            p = {
                "index": idx,
                "name": text(raw["name"].get(idx)) or text(descr),
                "descr": text(descr),
                "alias": text(raw["alias"].get(idx)),
                "up": raw["oper"].get(idx) == 1,
                "admin_up": raw["admin"].get(idx) == 1,
                "speed_mbps": speed,
                "lldp": self.lldp.get(idx, ""),
                "macs": sorted(m for m, i in self.mac_port.items() if i == idx),
            }
            counters = {k: raw[k].get(idx) for k in COUNTERS + RATES}
            old = self.prev.get(idx)
            p["errors_new"] = {}
            p["in_mbps"] = p["out_mbps"] = p["mcast_pps"] = p["bcast_pps"] = None
            if old and dt and dt > 0:
                for k in COUNTERS:
                    d = _delta(old.get(k), counters.get(k))
                    if d:
                        p["errors_new"][k] = d
                for k, outk, scale in (("in_octets", "in_mbps", 8 / 1e6), ("out_octets", "out_mbps", 8 / 1e6),
                                       ("in_mcast", "mcast_pps", 1), ("in_bcast", "bcast_pps", 1)):
                    d = _delta(old.get(k), counters.get(k), wrap=2 ** 64)
                    if d is not None:
                        p[outk] = round(d * scale / dt, 2 if scale != 1 else 0)
            totals = self.ports.get(idx, {}).get("errors_total", {}) if not rebooted else {}
            p["errors_total"] = {k: totals.get(k, 0) + p["errors_new"].get(k, 0) for k in COUNTERS}
            if speed and p["in_mbps"] is not None:
                p["util_pct"] = round(100 * max(p["in_mbps"], p["out_mbps"] or 0) / speed, 1)
            else:
                p["util_pct"] = None
            p["uplink"] = len(p["macs"]) >= 3   # several devices behind one port = link to another switch
            p["last_error_ts"] = now if p["errors_new"] else self.ports.get(idx, {}).get("last_error_ts")
            self._port_events(p, self.ports.get(idx))
            self.prev[idx] = counters
            ports[idx] = p
        with self.lock:
            self.ports = ports
        self.prev_time = now
        self.polls += 1

    def _port_events(self, p, before):
        where = "%s port %s" % (self.label, p["name"])
        if p["alias"]:
            where += " (%s)" % p["alias"]
        device = self.port_device(p["index"])
        if device:
            where += " -> " + device
        if before is None:
            return
        if before["up"] and not p["up"]:
            self.emit("critical", "port", where, "Link went DOWN.")
        elif not before["up"] and p["up"]:
            self.emit("ok", "port", where, "Link came up at %s." % _fmt_speed(p["speed_mbps"]))
        elif p["up"] and before["speed_mbps"] and p["speed_mbps"] != before["speed_mbps"]:
            self.emit("warning", "port", where, "Link speed changed %s -> %s (bad cable or connector?)."
                      % (_fmt_speed(before["speed_mbps"]), _fmt_speed(p["speed_mbps"])))
        # Errors: report the first ones straight away, then at most one summary every 2 minutes.
        pend = self.pending_errors.setdefault(p["index"], {"counts": {}, "last_emit": 0})
        for k, v in p["errors_new"].items():
            pend["counts"][k] = pend["counts"].get(k, 0) + v
        now = time.time()
        if pend["counts"] and now - pend["last_emit"] >= 120:
            names = {"in_errors": "receive errors", "out_errors": "transmit errors",
                     "fcs_errors": "CRC/FCS errors (usually cabling)", "in_discards": "dropped incoming packets",
                     "out_discards": "dropped outgoing packets (congestion)"}
            parts = ["%d %s" % (v, names[k]) for k, v in pend["counts"].items()]
            sev = "warning" if set(pend["counts"]) <= {"in_discards"} else "critical"
            lead = "New: " if not pend["last_emit"] or now - pend["last_emit"] > 600 else "Still happening (last 2 min): "
            self.emit(sev, "port", where, lead + ", ".join(parts) + ".")
            pend["counts"] = {}
            pend["last_emit"] = now
        if p["util_pct"] is not None and p["util_pct"] >= 70 and (before.get("util_pct") or 0) < 70:
            self.emit("warning", "port", where, "Port is %s%% busy - getting close to full." % p["util_pct"])

    def _read_fdb_and_lldp(self, raw):
        mac_port = {}
        try:
            base = table_by_index(self.client.walk(BASE_PORT_IFINDEX), BASE_PORT_IFINDEX)
        except SnmpError:
            base = {}
        try:
            q = table_by_index(self.client.walk(Q_FDB_PORT), Q_FDB_PORT)
            for index, bport in q.items():
                parts = index.split(".")
                if len(parts) == 7 and bport:
                    mac_port[_mac_from_index(parts[1:])] = str(base.get(str(bport), bport))
        except SnmpError:
            pass
        if not mac_port:
            try:
                d = table_by_index(self.client.walk(D_FDB_PORT), D_FDB_PORT)
                for index, bport in d.items():
                    parts = index.split(".")
                    if len(parts) == 6 and bport:
                        mac_port[_mac_from_index(parts)] = str(base.get(str(bport), bport))
            except SnmpError:
                pass
        self.mac_port = mac_port
        lldp = {}
        try:
            names = table_by_index(self.client.walk(LLDP_REM_SYSNAME), LLDP_REM_SYSNAME)
            pdesc = table_by_index(self.client.walk(LLDP_REM_PORTDESC), LLDP_REM_PORTDESC)
            for index, name in names.items():
                parts = index.split(".")
                if len(parts) >= 3:
                    local = parts[1]
                    label = text(name)
                    port = text(pdesc.get(index))
                    lldp[local] = label + (" / " + port if port else "")
        except SnmpError:
            pass
        self.lldp = lldp

    # ------------------------------------------------------------- results
    def snapshot(self):
        with self.lock:
            ports = sorted(self.ports.values(), key=lambda p: _natural(p["index"]))
        return {
            "id": self.cfg["id"], "ip": self.cfg["ip"], "label": self.label, "type": self.cfg.get("type"),
            "type_label": self.profile["label"], "reachable": self.reachable, "error": self.error,
            "setup": self.profile["setup"], "sys": self.sys, "ports": ports,
        }

    def port_for_mac(self, mac):
        """Return (ifIndex, port dict) for a device MAC learned on an edge port, else (None, None)."""
        idx = self.mac_port.get(mac)
        if idx is None:
            return None, None
        p = self.ports.get(idx)
        if p and p.get("uplink"):
            return None, None
        return idx, p


def _delta(a, b, wrap=2 ** 32):
    if a is None or b is None:
        return None
    d = b - a
    if d < 0:
        d += wrap if a < wrap else 0
        if d < 0 or d > wrap // 2:
            return None
    return d


def _natural(s):
    try:
        return (0, int(s))
    except ValueError:
        return (1, s)


def _fmt_speed(mbps):
    if not mbps:
        return "unknown speed"
    return "%g Gb/s" % (mbps / 1000) if mbps >= 1000 else "%d Mb/s" % mbps


def _fmt_duration(s):
    s = int(s)
    if s < 120:
        return "%ds" % s
    if s < 7200:
        return "%dm" % (s // 60)
    return "%dh %dm" % (s // 3600, (s % 3600) // 60)
