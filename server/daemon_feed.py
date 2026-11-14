"""Follow the netaudio daemon's live event stream and turn it into the app's model.

The daemon (`netaudio daemon run`, HTTP on 127.0.0.1:4780 by default) keeps every Dante
device, channel and subscription up to date and pushes changes over server-sent events
at GET /events. This module holds one long-lived connection to that stream, applies the
events to its own copy of the devices, and rebuilds the diagram model whenever something
the diagram shows actually changed. Levels come from the same stream (meter_values).

Reads only, except for two calls the app makes on purpose:
  identify(name)          POST /identify       blinks the device's identify LED
  set_metering(on)        POST /metering/start and /metering/stop for each device
                          (the same non-persistent requests Dante Controller sends)
"""
import http.client
import json
import threading
import time
import urllib.parse

READ_TIMEOUT = 60      # seconds without any event before reconnecting (gets a fresh snapshot)
STALE_AFTER = 3.0      # seconds without meter values before a device's levels count as stale
CLIENT_ID = "dante-visualizer"


def _channel_number(key, c):
    for v in (c.get("number"), c.get("media_local_id"), key):
        try:
            return int(v)
        except (TypeError, ValueError):
            continue
    return None


# Facts about a device that the device info panel shows. Only things that rarely change,
# so the diagram isn't redrawn for them.
INFO_FIELDS = {"mac_address": "mac", "product_version": "firmware", "software_version": "software",
               "encoding": "encoding", "latency_ms": "latencyMs", "clock_role": "clockRole",
               "network_redundancy": "redundancy", "tx_flow_count": "txFlows", "rx_flow_count": "rxFlows",
               "model_id": "modelId"}


def device_info(d):
    return {k: d[src] for src, k in INFO_FIELDS.items() if d.get(src) not in (None, "", [], {})}


def model_from_netaudio(devs):
    """Daemon devices ({server_name: device}) -> the app's model (same shape as a snapshot)."""
    devices = []
    for key, d in devs.items():
        if not isinstance(d, dict):
            continue
        name = d.get("name") or key.removesuffix(".local.").removesuffix(".local")
        ch = d.get("channels") or {}
        tx, rx = [], []
        for k, c in (ch.get("transmitters") or {}).items():
            n = _channel_number(k, c)
            if n is not None:
                tx.append({"id": n, "name": c.get("friendly_name") or c.get("name") or str(n)})
        subs = {}
        for s in d.get("subscriptions") or []:
            if s.get("rx_channel_number") is not None:
                subs[int(s["rx_channel_number"])] = s
        for k, c in (ch.get("receivers") or {}).items():
            n = _channel_number(k, c)
            if n is None:
                continue
            s = subs.get(n) or {}
            routed = bool(s.get("tx_channel"))
            rx.append({
                "id": n,
                "name": c.get("name") or str(n),
                "subDevice": (s.get("tx_device") or "") if routed else "",
                "subChannel": s["tx_channel"] if routed else "",
                "state": (s.get("status") or {}).get("state") if routed else None,
                "stateLabel": (s.get("status") or {}).get("label") if routed else None,
            })
        devices.append({
            "name": name,
            "serverName": key,
            "model": d.get("model") or "",
            "manufacturer": d.get("manufacturer") or "",
            "sampleRate": d.get("sample_rate_hz"),
            "online": d.get("online", True) is not False,
            "ipv4": d.get("ipv4"),
            "canIdentify": d.get("identify_supported") is not False,
            "info": device_info(d),
            "tx": sorted(tx, key=lambda c: c["id"]),
            "rx": sorted(rx, key=lambda c: c["id"]),
        })
    devices.sort(key=lambda d: d["name"].lower())  # stable order, so unchanged networks don't redraw
    return {"source": "live", "name": "Live network", "via": "daemon", "devices": devices}


def _sse_events(resp):
    """Yield each JSON object from a text/event-stream response."""
    data = []
    while True:
        line = resp.readline()
        if not line:
            return
        line = line.decode("utf-8", "replace").rstrip("\r\n")
        if not line:
            if data:
                try:
                    event = json.loads("\n".join(data))
                except ValueError:
                    event = None
                if isinstance(event, dict):
                    yield event
            data = []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if field == "data":
            data.append(value[1:] if value.startswith(" ") else value)


class DaemonFeed:
    def __init__(self, url="http://127.0.0.1:4780", log=print):
        u = urllib.parse.urlsplit(url)
        self.host, self.port = u.hostname or "127.0.0.1", u.port or 4780
        self.log = log
        self.cond = threading.Condition()
        self.connected = False     # True once a snapshot has arrived on the current connection
        self.devices = {}          # server_name -> daemon device dict
        self.scale = {}            # metering_source -> [{raw, dbfs, state}...] indexed by raw
        self.meters = {}           # server_name -> {"source", "t", "tx": {n: raw}, "rx": {n: raw}}
        self.model = None
        self.version = 0
        self.metering = False
        self._metered = set()      # server names we asked to meter
        self._metered_at = {}      # server name -> when the daemon accepted our request

    # ---- connection ----
    def start(self):
        threading.Thread(target=self._run, name="daemon-feed", daemon=True).start()
        threading.Thread(target=self._metering_loop, name="daemon-metering", daemon=True).start()
        return self

    def _run(self):
        backoff = 1.0
        while True:
            conn = None
            try:
                conn = http.client.HTTPConnection(self.host, self.port, timeout=3)
                conn.connect()
                sock = conn.sock  # http.client lets go of it once a streamed response starts
                conn.request("GET", "/events?patches=1", headers={"Accept": "text/event-stream"})
                resp = conn.getresponse()
                if resp.status != 200 or not resp.getheader("Content-Type", "").startswith("text/event-stream"):
                    raise OSError(f"event stream refused (HTTP {resp.status})")
                sock.settimeout(READ_TIMEOUT)
                for event in _sse_events(resp):
                    self._apply(event)
                    backoff = 1.0
                raise OSError("event stream closed")
            except Exception as e:  # never let the feed thread die; reconnect instead
                if self.connected:
                    self.log(f"netaudio daemon: disconnected ({e})")
                elif not isinstance(e, OSError):
                    self.log(f"netaudio daemon: {type(e).__name__}: {e}")
            finally:
                if conn:
                    conn.close()
                with self.cond:
                    was = self.connected
                    self.connected = False
                    self._metered.clear()   # a restarted daemon has forgotten our metering requests
                    if was:
                        self.version += 1
                        self.cond.notify_all()
            time.sleep(backoff)
            backoff = min(backoff * 2, 10.0)

    # ---- events ----
    def _apply(self, e):
        kind = e.get("event")
        sn = e.get("server_name")
        with self.cond:
            if kind == "snapshot":
                if not self.connected:
                    self.log(f"netaudio daemon: connected, {len(e.get('devices') or {})} devices")
                self.connected = True
                self.devices = dict(e.get("devices") or {})
                self.scale = e.get("metering_scale") or {}
                self.meters = {}
                for name, m in (e.get("metering") or {}).items():
                    self._merge_meter(name, m)
            elif kind in ("device_discovered", "device_updated") and sn:
                if e.get("device"):
                    self.devices[sn] = e["device"]
                else:
                    self.devices.pop(sn, None)
            elif kind == "device_patch" and sn in self.devices:
                d = {**self.devices[sn], **(e.get("changed") or {})}
                for k in e.get("removed") or []:
                    d.pop(k, None)
                self.devices[sn] = d
            elif kind == "device_removed" and sn:
                self.devices.pop(sn, None)
                self.meters.pop(sn, None)
                self._metered.discard(sn)
            elif kind == "meter_values" and sn:
                self._merge_meter(sn, e)
                return
            else:
                return
            self._rebuild()

    def _merge_meter(self, sn, m):
        prev = self.meters.get(sn)
        keep = prev and prev.get("source") == m.get("metering_source")
        cur = {"source": m.get("metering_source"), "t": time.time(), "tx": {}, "rx": {}}
        for side in ("tx", "rx"):
            if keep:
                cur[side].update(prev[side])
            for k, v in (m.get(side) or {}).items():
                try:
                    cur[side][int(k)] = v
                except (TypeError, ValueError):
                    pass
        self.meters[sn] = cur

    def _rebuild(self):
        model = model_from_netaudio(self.devices)
        if model != self.model:
            self.model = model
            self.version += 1
            self.cond.notify_all()

    # ---- what the server reads ----
    def snapshot(self):
        with self.cond:
            return (self.model if self.connected else None), self.version

    def wait_for_change(self, version, timeout):
        with self.cond:
            self.cond.wait_for(lambda: self.version != version, timeout=timeout)
            return self.version

    def _db(self, source, raw):
        """Raw meter value -> dBFS (0.0 for clipping), None for no signal / muted."""
        if not isinstance(raw, int):
            return None
        table = self.scale.get(source) or []
        entry = table[raw] if 0 <= raw < len(table) else None
        if entry is None:
            return None if raw >= 254 else -raw / 2.0
        if entry.get("state") == "clipping":
            return 0.0
        return entry.get("dbfs")

    def levels(self):
        """Levels in the app's /api/levels shape, keyed by device name, or None without any."""
        with self.cond:
            if not self.connected or not self.meters or not self.metering:
                return None
            now = time.time()
            out = {}
            for sn, m in self.meters.items():
                d = self.devices.get(sn) or {}
                name = d.get("name") or sn.removesuffix(".local.").removesuffix(".local")
                entry = {"age": round(now - m["t"], 2), "stale": now - m["t"] > STALE_AFTER}
                for side in ("tx", "rx"):
                    vals = m[side]
                    size = max(vals) if vals else 0
                    entry[side] = [self._db(m["source"], vals.get(i)) for i in range(1, size + 1)]
                out[name] = entry
            return {"t": now, "devices": out}

    # ---- the two calls that reach devices ----
    def _post(self, path, body, timeout=8):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        try:
            conn.request("POST", path, body=json.dumps(body), headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            raw = resp.read()
            try:
                data = json.loads(raw) if raw else {}
            except ValueError:
                data = {"error": raw.decode("utf-8", "replace")[:200]}
            return resp.status, data
        finally:
            conn.close()

    def server_name(self, device_name):
        with self.cond:
            for sn, d in self.devices.items():
                if d.get("name") == device_name or sn == device_name:
                    return sn
        return None

    def identify(self, device_name):
        sn = self.server_name(device_name)
        if not sn:
            return 404, {"error": "device not found"}
        return self._post("/identify", {"device": sn})

    def set_metering(self, on):
        """Ask the daemon to meter every device (on) or release them all (off).
        New devices are picked up within a few seconds while metering is on."""
        self.metering = bool(on)
        if not on:
            self._stop_metering()

    def _stop_metering(self):
        with self.cond:
            names = list(self._metered)
            self._metered.clear()
        for sn in names:
            try:
                self._post("/metering/stop", {"device": sn, "client_id": CLIENT_ID}, timeout=3)
            except (OSError, http.client.HTTPException):
                pass

    def _metering_loop(self):
        tried = {}   # server name -> time of the last failed start, so failures retry slowly
        while True:
            time.sleep(2)
            if not self.metering:
                continue
            now = time.time()
            with self.cond:
                if not self.connected:
                    continue
                # Was sending levels through the daemon, then went quiet for 10 s (e.g. the Mac's
                # address changed under the daemon): forget it so it is asked again below.
                # Devices that never send through the daemon (their levels come from heartbeats
                # via the helper) are left alone, so they aren't asked every 10 s forever.
                for sn in list(self._metered):
                    m = self.meters.get(sn)
                    if not m:
                        continue
                    last = max(self._metered_at.get(sn, 0), m.get("t", 0))
                    if now - last > 10:
                        self._metered.discard(sn)
                        self.log(f"no levels from {sn} for 10 s; asking again")
                todo = [sn for sn, d in self.devices.items()
                        if sn not in self._metered and now - tried.get(sn, 0) > 30
                        and d.get("online", True) is not False
                        and d.get("detailed_metering_supported") is not False]
            for sn in todo:
                if not self.metering:
                    break
                try:
                    status, data = self._post("/metering/start", {"device": sn, "client_id": CLIENT_ID}, timeout=4)
                    ok = status == 200 and bool(data.get("success"))
                except (OSError, http.client.HTTPException):
                    ok = False
                with self.cond:
                    if ok:
                        self._metered.add(sn)
                        self._metered_at[sn] = time.time()
                        tried.pop(sn, None)
                    else:
                        tried[sn] = now
                if ok and not self.metering:  # switched off while this request was on its way
                    self._stop_metering()
