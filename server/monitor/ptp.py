"""Listen (passively) to the Dante clock.

Dante keeps every device in sync with PTP. By default it uses PTP version 1
(IEEE 1588-2002); AES67 mode adds PTP version 2. Both are multicast to
224.0.1.129 on UDP ports 319 (timing) and 320 (general). We only listen.

What we learn:
  * which device is the clock leader (and when that changes)
  * whether more than one device thinks it is leader (bad!)
  * whether sync messages arrive on time, or go missing / arrive late
"""
import socket
import statistics
import struct
import threading
import time
from collections import deque

PTP_GROUP = "224.0.1.129"
PTP_PORTS = (319, 320)


def _mac(b):
    return ":".join("%02x" % x for x in b)


def parse_ptp(data):
    """Return a dict describing the packet, or None if it isn't PTP we understand."""
    if len(data) < 34:
        return None
    # ---- PTP version 1: first two bytes are versionPTP = 1
    if data[0] == 0 and data[1] == 1 and len(data) >= 40:
        control = data[32]
        kinds = {0: "sync", 1: "delay_req", 2: "follow_up", 3: "delay_resp", 4: "management"}
        msg = {
            "version": 1,
            "kind": kinds.get(control, "other"),
            "domain": data[4:20].rstrip(b"\x00").decode("ascii", "replace"),
            "source": _mac(data[22:28]),
            "seq": struct.unpack("!H", data[30:32])[0],
        }
        if msg["kind"] == "sync" and len(data) >= 96:
            msg["grandmaster"] = _mac(data[54:60])
            msg["gm_stratum"] = data[67]
            msg["gm_identifier"] = data[68:72].rstrip(b"\x00").decode("ascii", "replace")
            msg["gm_preferred"] = bool(data[77])
            msg["sync_interval"] = struct.unpack("!b", data[83:84])[0]
        return msg
    # ---- PTP version 2: low nibble of byte 1 is versionPTP = 2
    if data[1] & 0x0F == 2 and len(data) >= 34:
        mtype = data[0] & 0x0F
        kinds = {0: "sync", 1: "delay_req", 8: "follow_up", 9: "delay_resp", 11: "announce",
                 12: "signaling", 13: "management", 2: "pdelay_req", 3: "pdelay_resp"}
        clock_id = data[20:28]
        msg = {
            "version": 2,
            "kind": kinds.get(mtype, "other"),
            "domain": str(data[4]),
            "source": clock_id.hex(),
            "seq": struct.unpack("!H", data[30:32])[0],
            "log_interval": struct.unpack("!b", data[33:34])[0],
        }
        if msg["kind"] == "announce" and len(data) >= 64:
            msg["priority1"] = data[47]
            msg["clock_class"] = data[48]
            msg["priority2"] = data[52]
            msg["grandmaster"] = data[53:61].hex()
            msg["steps_removed"] = struct.unpack("!H", data[61:63])[0]
        return msg
    return None


class ClockSource:
    """Statistics for one device that is sending sync messages."""

    def __init__(self, source, version, ip):
        self.source = source
        self.version = version
        self.ip = ip
        self.first_seen = time.time()
        self.last_sync = 0.0
        self.last_seq = None
        self.intervals = deque(maxlen=240)   # seconds between syncs
        self.missed = 0                      # sequence numbers skipped
        self.received = 0
        self.late = 0                        # gaps much longer than usual
        self.info = {}

    def on_sync(self, seq, now):
        if self.last_sync:
            gap = now - self.last_sync
            if self.intervals and len(self.intervals) > 8:
                typical = statistics.median(self.intervals)
                if typical > 0 and gap > typical * 3:
                    self.late += 1
            self.intervals.append(gap)
        if self.last_seq is not None:
            jump = (seq - self.last_seq) & 0xFFFF
            if 1 < jump < 50:   # bigger jumps mean the leader restarted, not lost messages
                self.missed += jump - 1
        self.last_seq = seq
        self.last_sync = now
        self.received += 1

    def summary(self, now):
        iv = list(self.intervals)
        typical = statistics.median(iv) if iv else None
        jitter = statistics.pstdev(iv) * 1000 if len(iv) > 2 else None
        expected = self.received + self.missed
        return {
            "source": self.source,
            "ip": self.ip,
            "version": self.version,
            "age": round(now - self.last_sync, 2) if self.last_sync else None,
            "interval_ms": round(typical * 1000, 1) if typical else None,
            "jitter_ms": round(jitter, 2) if jitter is not None else None,
            "missed": self.missed,
            "late": self.late,
            "loss_pct": round(100.0 * self.missed / expected, 2) if expected else 0.0,
            "info": self.info,
        }


class PtpMonitor:
    def __init__(self, interface_ip=None, log=print, on_event=None):
        self.interface_ip = interface_ip
        self.log = log
        self.on_event = on_event or (lambda *a, **k: None)
        self.lock = threading.Lock()
        self.v1 = {}        # source mac -> ClockSource (devices sending Sync = acting leaders)
        self.v2 = {}        # clock id -> ClockSource (from Announce + Sync)
        self.followers = {}  # source -> (ip, last seen) for delay requests (devices following)
        self.leader_v1 = None
        self.leader_v2 = None
        self.running = False
        self.listening = False
        self.error = None

    def start(self):
        self.running = True
        for port in PTP_PORTS:
            try:
                s = self._open(port)
                threading.Thread(target=self._listen, args=(s,), daemon=True, name="ptp-%d" % port).start()
                self.listening = True
            except OSError as e:
                self.error = "Can't listen on PTP port %d: %s" % (port, e)
                self.log(self.error)

    def stop(self):
        self.running = False

    def _open(self, port):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        s.bind(("", port))
        mreq = socket.inet_aton(PTP_GROUP) + socket.inet_aton(self.interface_ip or "0.0.0.0")
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        s.settimeout(1.0)
        return s

    def _listen(self, s):
        while self.running:
            try:
                data, addr = s.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                time.sleep(0.5)
                continue
            msg = parse_ptp(data)
            if msg:
                self.ingest(msg, addr[0], time.time())

    def ingest(self, msg, ip, now):
        with self.lock:
            if msg["version"] == 1:
                if msg["kind"] == "sync":
                    src = self.v1.get(msg["source"])
                    if not src:
                        src = self.v1[msg["source"]] = ClockSource(msg["source"], 1, ip)
                    src.ip = ip
                    src.on_sync(msg["seq"], now)
                    for k in ("grandmaster", "gm_stratum", "gm_identifier", "gm_preferred", "sync_interval"):
                        if k in msg:
                            src.info[k] = msg[k]
                elif msg["kind"] == "delay_req":
                    self.followers[msg["source"]] = (ip, now)
            else:
                src = self.v2.get(msg["source"])
                if msg["kind"] in ("announce", "sync"):
                    if not src:
                        src = self.v2[msg["source"]] = ClockSource(msg["source"], 2, ip)
                    src.ip = ip
                    if msg["kind"] == "sync":
                        src.on_sync(msg["seq"], now)
                    else:
                        src.last_sync = src.last_sync or now
                        for k in ("priority1", "priority2", "clock_class", "grandmaster", "steps_removed"):
                            src.info[k] = msg[k]
                elif msg["kind"] == "delay_req":
                    self.followers[msg["source"]] = (ip, now)

    def snapshot(self, now=None, stale_after=3.0):
        """Current view of the clock. Leaders are sources that have sent sync recently."""
        now = now or time.time()
        with self.lock:
            v1 = [s.summary(now) for s in self.v1.values()]
            v2 = [s.summary(now) for s in self.v2.values()]
            followers = [{"source": k, "ip": v[0]} for k, v in self.followers.items() if now - v[1] < 30]
        active_v1 = [s for s in v1 if s["age"] is not None and s["age"] < stale_after]
        active_v2 = [s for s in v2 if s["age"] is not None and s["age"] < stale_after]
        return {
            "listening": self.listening,
            "error": self.error,
            "v1_sources": v1,
            "v2_sources": v2,
            "v1_active": active_v1,
            "v2_active": active_v2,
            "followers": followers,
        }
