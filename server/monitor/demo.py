"""Demo mode: a pretend Dante network so you can try the dashboard anywhere.

The fake data goes through the same code as real data (the same mDNS parser,
clock analyser and switch poller), and every so often a problem is staged:
a bad cable, a device dropping off, a clock fight, a sample-rate mismatch.
"""
import random
import threading
import time

from .mdns import DanteDiscovery, T_A, T_PTR, T_SRV, T_TXT
from .ptp import PtpMonitor
from .switches import COLUMNS, SYS_DESCR, SYS_NAME, SYS_UPTIME

DEVICES = [
    # name, manufacturer, model, ip, mac, tx channels, switch, port
    ("FOH-Console", "Yamaha", "CL5", "169.254.10.1", "00:1d:c1:10:00:01", 64, "netgear", 1),
    ("Stagebox-A", "Yamaha", "Rio3224-D2", "169.254.10.2", "00:1d:c1:10:00:02", 32, "luminex", 1),
    ("Stagebox-B", "Yamaha", "Rio3224-D2", "169.254.10.3", "00:1d:c1:10:00:03", 32, "luminex", 2),
    ("Wireless-Rx", "Shure", "ULXD4Q", "169.254.10.4", "00:0e:dd:10:00:04", 4, "luminex", 3),
    ("Amp-Rack-L", "Lab.gruppen", "D 40:4", "169.254.10.5", "00:1d:c1:10:00:05", 0, "luminex", 4),
    ("Amp-Rack-R", "Lab.gruppen", "D 40:4", "169.254.10.6", "00:1d:c1:10:00:06", 0, "luminex", 5),
    ("Record-Mac", "Audinate", "DVS", "169.254.10.7", "00:1d:c1:10:00:07", 64, "netgear", 2),
    ("Playback-Mac", "Audinate", "Dante Virtual Soundcard", "169.254.10.8", "00:1d:c1:10:00:08", 16, "netgear", 3),
    ("Monitor-Console", "Yamaha", "QL5", "169.254.10.9", "00:1d:c1:10:00:09", 64, "netgear", 4),
]
UPLINK = {"netgear": 25, "luminex": 9}


class FakeSwitch:
    """Answers get()/walk() like an SNMP agent would."""

    def __init__(self, world, which, nports, name, descr):
        self.world, self.which, self.nports, self.name, self.descr = world, which, nports, name, descr
        self.boot = time.time() - 86400 * 3
        self.counters = {i: {"in_octets": random.randint(10 ** 9, 10 ** 11), "out_octets": random.randint(10 ** 9, 10 ** 11),
                             "in_mcast": 10 ** 6, "in_bcast": 10 ** 4, "in_errors": 0, "out_errors": 0,
                             "in_discards": 0, "out_discards": 0, "fcs_errors": 0} for i in range(1, nports + 1)}
        self.last = time.time()

    def _advance(self):
        now = time.time()
        dt, self.last = now - self.last, now
        for i, c in self.counters.items():
            if self._link_up(i):
                busy = 300 if i == UPLINK[self.which] else 40
                c["in_octets"] += int(busy * 1e6 / 8 * dt * random.uniform(0.8, 1.2))
                c["out_octets"] += int(busy * 1e6 / 8 * dt * random.uniform(0.8, 1.2))
                c["in_mcast"] += int(1500 * dt)
                c["in_bcast"] += int(3 * dt)
        bad = self.world.scenario_port
        if bad and bad[0] == self.which:
            self.counters[bad[1]]["fcs_errors"] += random.randint(3, 40)
            self.counters[bad[1]]["in_errors"] += random.randint(3, 40)

    def _link_up(self, i):
        if i == UPLINK[self.which]:
            return True
        for d in DEVICES:
            if d[6] == self.which and d[7] == i:
                return d[0] != self.world.offline
        return False

    def get(self, oids):
        self._advance()
        vals = {SYS_DESCR: self.descr.encode(), SYS_NAME: self.name.encode(),
                SYS_UPTIME: int((time.time() - self.boot) * 100)}
        return {o: vals.get(o) for o in oids}

    def walk(self, base):
        base = base.strip(".")
        out = {}
        if base in COLUMNS.values():
            key = [k for k, v in COLUMNS.items() if v == base][0]
            for i in range(1, self.nports + 1):
                c = self.counters[i]
                portname = ("0/%d" % i) if self.which == "netgear" else str(i)
                v = {"descr": portname.encode(), "type": 6, "speed": 1000000000, "high_speed": 1000,
                     "admin": 1, "oper": 1 if self._link_up(i) else 2, "last_change": 0,
                     "name": portname.encode(), "alias": (b"Uplink" if i == UPLINK[self.which] else b"")}.get(key, c.get(key))
                if self.which == "luminex" and key == "high_speed" and self.world.slow_port == i and self._link_up(i):
                    v = 100
                out["%s.%d" % (base, i)] = v
        elif base == "1.3.6.1.2.1.17.1.4.1.2":
            out = {"%s.%d" % (base, i): i for i in range(1, self.nports + 1)}
        elif base == "1.3.6.1.2.1.17.7.1.2.2.1.2":
            for d in DEVICES:
                if d[0] == self.world.offline:
                    continue
                port = d[7] if d[6] == self.which else UPLINK[self.which]
                idx = ".".join(str(int(x, 16)) for x in d[4].split(":"))
                out["%s.1.%s" % (base, idx)] = port
        elif base == "1.0.8802.1.1.2.1.4.1.1.9":
            other = "Stage GigaCore" if self.which == "netgear" else "FOH M4250"
            out["%s.0.%d.1" % (base, UPLINK[self.which])] = other.encode()
        return out


class DemoWorld:
    def __init__(self):
        self.discovery = DanteDiscovery()
        self.ptp = PtpMonitor()
        self.ptp.listening = True
        self.offline = None          # device name currently "unplugged"
        self.scenario_port = None    # (switch, port) with a bad cable
        self.slow_port = 3           # Wireless-Rx negotiates at 100 Mb/s
        self.rate_odd = None         # device at a different sample rate
        self.leaders = ["FOH-Console"]
        self.seq = {}
        self.switches = {"netgear": FakeSwitch(self, "netgear", 30, "FOH M4250", "NETGEAR M4250-26G4F-PoE+"),
                         "luminex": FakeSwitch(self, "luminex", 16, "Stage GigaCore", "Luminex GigaCore 16t")}
        threading.Thread(target=self._mdns_loop, daemon=True).start()
        threading.Thread(target=self._ptp_loop, daemon=True).start()
        threading.Thread(target=self._scenario_loop, daemon=True).start()

    def default_switches(self):
        return [{"id": "demo-ng", "name": "FOH M4250", "ip": "169.254.0.2", "type": "netgear_m4250", "community": ""},
                {"id": "demo-lx", "name": "Stage GigaCore", "ip": "169.254.0.3", "type": "luminex_gigacore", "community": ""}]

    def switch_client(self, sw):
        return self.switches["luminex" if sw["type"] == "luminex_gigacore" else "netgear"]

    def arp_table(self):
        return {d[3]: d[4] for d in DEVICES}

    def ping(self, ip):
        d = next((d for d in DEVICES if d[3] == ip), None)
        if not d or d[0] == self.offline:
            time.sleep(0.2)
            return None
        if d[0] == "Wireless-Rx" and random.random() < 0.02:
            return None
        return round(random.uniform(0.25, 0.9) + (2.5 * random.random() if d[0] == "Wireless-Rx" else 0), 3)

    def _mdns_loop(self):
        while True:
            recs = []
            for name, mf, model, ip, mac, nch, _sw, _p in DEVICES:
                if name == self.offline:
                    continue
                host = name.lower() + ".local"
                for svc, port in (("_netaudio-arc._udp.local", 4440), ("_netaudio-cmc._udp.local", 8800)):
                    inst = "%s.%s" % (name, svc)
                    recs += [{"name": svc, "type": T_PTR, "ttl": 4500, "target": inst},
                             {"name": inst.lower(), "type": T_SRV, "ttl": 120, "host": host, "port": port},
                             {"name": inst.lower(), "type": T_TXT, "ttl": 4500, "txt": {"mf": mf, "model": model}}]
                recs.append({"name": host, "type": T_A, "ttl": 120, "ip": ip})
                rate = "44100" if name == self.rate_odd else "48000"
                for ch in range(1, min(nch, 8) + 1):
                    inst = "%02d@%s._netaudio-chan._udp.local" % (ch, name)
                    recs += [{"name": "_netaudio-chan._udp.local", "type": T_PTR, "ttl": 4500, "target": inst},
                             {"name": inst.lower(), "type": T_TXT, "ttl": 4500,
                              "txt": {"rate": rate, "en": "24", "latency_ns": "1000000"}}]
            self.discovery.ingest(recs)
            time.sleep(5)

    def _ptp_loop(self):
        followers = [d for d in DEVICES]
        while True:
            now = time.time()
            for leader in self.leaders:
                d = next(x for x in DEVICES if x[0] == leader)
                seq = self.seq.get(leader, 0) + 1
                if random.random() < 0.003:
                    seq += 1  # an occasional lost sync
                self.seq[leader] = seq
                self.ptp.ingest({"version": 1, "kind": "sync", "source": d[4], "seq": seq & 0xFFFF,
                                 "grandmaster": d[4], "gm_stratum": 2 if leader == "FOH-Console" else 4,
                                 "gm_identifier": "DFLT", "gm_preferred": leader == "FOH-Console",
                                 "sync_interval": -2}, d[3], now + random.uniform(0, 0.0015))
            f = random.choice(followers)
            if f[0] not in self.leaders and f[0] != self.offline:
                self.ptp.ingest({"version": 1, "kind": "delay_req", "source": f[4], "seq": 0}, f[3], now)
            time.sleep(0.25)

    def _scenario_loop(self):
        time.sleep(25)
        scenes = ["cable", "offline", "leader", "rate", "fight"]
        i = 0
        while True:
            scene = scenes[i % len(scenes)]
            i += 1
            if scene == "cable":
                self.scenario_port = ("luminex", 2)       # Stagebox-B's cable goes bad
                time.sleep(35)
                self.scenario_port = None
            elif scene == "offline":
                self.offline = "Amp-Rack-R"
                time.sleep(50)
                self.offline = None
            elif scene == "leader":
                self.leaders = ["Monitor-Console"]
                time.sleep(30)
                self.leaders = ["FOH-Console"]
            elif scene == "rate":
                self.rate_odd = "Playback-Mac"
                time.sleep(35)
                self.rate_odd = None
            elif scene == "fight":
                self.leaders = ["FOH-Console", "Record-Mac"]
                time.sleep(20)
                self.leaders = ["FOH-Console"]
            time.sleep(30)
