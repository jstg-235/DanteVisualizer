"""Find Dante devices on the network using mDNS (Bonjour), the same way
Dante Controller does. Read-only: it only asks "who's out there?" and listens.

Dante devices advertise these Bonjour services:
  _netaudio-arc._udp   one per device (routing; TXT has manufacturer + model)
  _netaudio-cmc._udp   one per device (control/monitoring)
  _netaudio-chan._udp  one per transmit channel ("channel@device"; TXT has rate etc.)
"""
import socket
import struct
import threading
import time

MDNS_GROUP = "224.0.0.251"
MDNS_PORT = 5353

T_A, T_PTR, T_TXT, T_SRV, T_ANY = 1, 12, 16, 33, 255

SERVICES = [
    "_netaudio-arc._udp.local",
    "_netaudio-cmc._udp.local",
    "_netaudio-chan._udp.local",
]


# ---------------------------------------------------------------- packet code
def encode_name(name):
    out = b""
    for label in name.rstrip(".").split("."):
        raw = label.encode("utf-8")
        out += bytes([len(raw)]) + raw
    return out + b"\x00"


def build_query(questions):
    """questions: list of (name, qtype)."""
    header = struct.pack("!HHHHHH", 0, 0, len(questions), 0, 0, 0)
    body = b""
    for name, qtype in questions:
        body += encode_name(name) + struct.pack("!HH", qtype, 1)
    return header + body


def _read_name(data, offset, depth=0):
    labels = []
    jumped = False
    end = offset
    while True:
        if offset >= len(data) or depth > 20:
            raise ValueError("bad name")
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            pointer = struct.unpack("!H", data[offset:offset + 2])[0] & 0x3FFF
            if not jumped:
                end = offset + 2
            jumped = True
            offset = pointer
            depth += 1
            continue
        offset += 1
        labels.append(data[offset:offset + length].decode("utf-8", "replace"))
        offset += length
    if not jumped:
        end = offset
    return ".".join(labels), end


def parse_packet(data):
    """Return list of resource records as dicts. Ignores questions."""
    if len(data) < 12:
        return []
    _id, flags, qd, an, ns, ar = struct.unpack("!HHHHHH", data[:12])
    if not flags & 0x8000:  # not a response
        return []
    offset = 12
    for _ in range(qd):
        _, offset = _read_name(data, offset)
        offset += 4
    records = []
    for _ in range(an + ns + ar):
        name, offset = _read_name(data, offset)
        rtype, rclass, ttl, rdlen = struct.unpack("!HHIH", data[offset:offset + 10])
        offset += 10
        rdata_start = offset
        rdata = data[offset:offset + rdlen]
        offset += rdlen
        rec = {"name": name.lower(), "rawname": name, "type": rtype, "ttl": ttl}
        try:
            if rtype == T_A and rdlen == 4:
                rec["ip"] = socket.inet_ntoa(rdata)
            elif rtype == T_PTR:
                rec["target"], _ = _read_name(data, rdata_start)
            elif rtype == T_SRV:
                prio, weight, port = struct.unpack("!HHH", rdata[:6])
                rec["port"] = port
                rec["host"], _ = _read_name(data, rdata_start + 6)
                rec["host"] = rec["host"].lower()
            elif rtype == T_TXT:
                txt, i = {}, 0
                while i < len(rdata):
                    ln = rdata[i]
                    item = rdata[i + 1:i + 1 + ln].decode("utf-8", "replace")
                    i += 1 + ln
                    if "=" in item:
                        k, v = item.split("=", 1)
                        txt[k] = v
                    elif item:
                        txt[item] = ""
                rec["txt"] = txt
            else:
                continue
        except Exception:
            continue
        records.append(rec)
    return records


# ---------------------------------------------------------------- discovery
class DanteDiscovery:
    """Keeps a live picture of Dante devices seen through mDNS."""

    def __init__(self, interface_ip=None, log=print):
        self.interface_ip = interface_ip
        self.log = log
        self.lock = threading.Lock()
        self.ptr = {}       # service -> {instance_name: last_seen}
        self.srv = {}       # instance -> (host, port, t)
        self.txt = {}       # instance -> (dict, t)
        self.a = {}         # host -> (ip, t)
        self.goodbye = {}   # instance -> t (device said it is leaving)
        self.display = {}   # instance (lowercase) -> name as the device spells it
        self.sock = None
        self.running = False

    # -- socket setup
    def _open_socket(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        try:
            s.bind(("", MDNS_PORT))
            self.shared_port = True
        except OSError:
            s.bind(("", 0))  # fall back to "legacy" one-shot queries
            self.shared_port = False
        iface = self.interface_ip or "0.0.0.0"
        try:
            mreq = socket.inet_aton(MDNS_GROUP) + socket.inet_aton(iface)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        except OSError:
            pass
        if self.interface_ip:
            try:
                s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(self.interface_ip))
            except OSError:
                pass
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        s.settimeout(1.0)
        return s

    def start(self):
        self.sock = self._open_socket()
        self.running = True
        threading.Thread(target=self._listen, daemon=True, name="mdns-listen").start()
        threading.Thread(target=self._query_loop, daemon=True, name="mdns-query").start()

    def stop(self):
        self.running = False

    def _send(self, questions):
        try:
            self.sock.sendto(build_query(questions), (MDNS_GROUP, MDNS_PORT))
        except OSError as e:
            self.log("mDNS send failed: %s" % e)

    def _query_loop(self):
        while self.running:
            for svc in SERVICES:
                self._send([(svc, T_PTR)])
                time.sleep(0.3)
            time.sleep(1.5)
            # Ask directly for anything we heard about but couldn't resolve.
            with self.lock:
                missing_inst = [i for s in self.ptr.values() for i in s
                                if i not in self.srv or i not in self.txt]
                hosts = {h for (h, _p, _t) in self.srv.values()}
                missing_host = [h for h in hosts if h not in self.a]
            for name in missing_inst[:40]:
                self._send([(name, T_SRV), (name, T_TXT)])
            for host in missing_host[:40]:
                self._send([(host, T_A)])
            time.sleep(8)

    def _listen(self):
        while self.running:
            try:
                data, _addr = self.sock.recvfrom(9000)
            except socket.timeout:
                continue
            except OSError:
                time.sleep(0.5)
                continue
            try:
                self.ingest(parse_packet(data))
            except Exception:
                pass

    def ingest(self, records, now=None):
        now = now or time.time()
        with self.lock:
            for r in records:
                if r["type"] == T_PTR:
                    svc = r["name"]
                    if svc in SERVICES:
                        inst = r["target"].lower()
                        self.display[inst] = r["target"]
                        if r["ttl"] == 0:
                            self.goodbye[inst] = now
                            self.ptr.setdefault(svc, {}).pop(inst, None)
                        else:
                            self.ptr.setdefault(svc, {})[inst] = now
                            self.goodbye.pop(inst, None)
                elif r["type"] == T_SRV:
                    self.srv[r["name"]] = (r["host"], r["port"], now)
                elif r["type"] == T_TXT:
                    self.txt[r["name"]] = (r["txt"], now)
                elif r["type"] == T_A:
                    self.a[r["name"]] = (r["ip"], now)

    # -- results
    def devices(self):
        """Return {device_name: {...}} built from everything heard so far."""
        out = {}
        with self.lock:
            for svc in ("_netaudio-arc._udp.local", "_netaudio-cmc._udp.local"):
                for inst, seen in self.ptr.get(svc, {}).items():
                    label = self._instance_label(inst, svc)
                    dev = out.setdefault(label.lower(), {"name": label, "last_seen": 0, "txt": {},
                                                         "ip": None, "channels": 0, "rates": set(),
                                                         "latencies": set()})
                    dev["last_seen"] = max(dev["last_seen"], seen)
                    if inst in self.srv:
                        host = self.srv[inst][0]
                        dev["host"] = host
                        if host in self.a:
                            dev["ip"] = self.a[host][0]
                            dev["last_seen"] = max(dev["last_seen"], self.a[host][1])
                    if inst in self.txt:
                        dev["txt"].update(self.txt[inst][0])
            for inst, seen in self.ptr.get("_netaudio-chan._udp.local", {}).items():
                label = self._instance_label(inst, "_netaudio-chan._udp.local")
                if "@" not in label:
                    continue
                devname = label.split("@", 1)[1].lower()
                dev = out.get(devname)
                if not dev:
                    continue
                dev["channels"] += 1
                txt = self.txt.get(inst, ({}, 0))[0]
                if txt.get("rate"):
                    dev["rates"].add(txt["rate"])
                if txt.get("latency_ns"):
                    dev["latencies"].add(txt["latency_ns"])
        for dev in out.values():
            dev["rates"] = sorted(dev["rates"])
            dev["latencies"] = sorted(dev["latencies"])
            dev["manufacturer"] = dev["txt"].get("mf", "")
            dev["model"] = dev["txt"].get("model", "")
        return out

    def _instance_label(self, inst, svc):
        # The original (case-preserved) label is everything before ".<service>"
        suffix = "." + svc
        shown = self.display.get(inst, inst)
        return shown[:-len(suffix)] if shown.lower().endswith(suffix) else shown
