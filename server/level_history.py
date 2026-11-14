"""Level history: a rolling record of every channel's level, and a list of dropouts.

The server samples the same levels it serves at /api/levels a few times a second and
keeps, for every channel, the loudest reading of each second for the last hour. That is
what the strip chart shows when a channel or wire is clicked.

From the same record it notices dropouts: a channel that had signal, went silent for a
few seconds, then came back. A receiving channel that went silent while its source kept
sending is marked as lost on the way (a network problem rather than a quiet source).

Everything here is kept in memory only and reads nothing from devices: it just watches
the levels that are already arriving.

Storage: one byte per channel per second, on Dante's own metering scale:
  0..253  peak level, -value/2 dBFS (0 = full scale, clipping)
  254     no signal (muted, or below the meter's floor)
  255     no reading (metering off, device not answering)
"""
import collections
import threading
import time

SECONDS = 3600            # how much history to keep per channel
SAMPLE_EVERY = 0.25       # seconds between samples of the levels
SIGNAL_RAW = 120          # -60 dBFS: at or above this level counts as signal
NO_SIGNAL, NO_READING = 254, 255
DROPOUT_MIN = 2           # a silence this long (seconds) or longer counts...
DROPOUT_MAX = 60          # ...up to this long; longer silences are taken as intentional
SIGNAL_BEFORE = 5         # seconds of signal needed before a silence counts as a dropout
MAX_DROPOUTS = 500


def db_to_raw(db):
    if db is None:
        return NO_SIGNAL
    return max(0, min(253, int(round(-db * 2))))


class _Track:
    __slots__ = ("ring", "signal_since", "silent_since", "last")

    def __init__(self):
        self.ring = bytearray([NO_READING]) * SECONDS
        self.signal_since = None   # second when the current run of signal started
        self.silent_since = None   # second when the current silence started
        self.last = NO_READING


class LevelHistory:
    def __init__(self, get_levels, get_routes, log=print):
        """get_levels() -> /api/levels shape or None; get_routes() -> {(dst, rx ch): (src, tx ch)}."""
        self.get_levels = get_levels
        self.get_routes = get_routes
        self.log = log
        self.lock = threading.Lock()
        self.tracks = {}           # (device, side, ch) -> _Track
        self.sec = None            # the second being filled
        self.dropouts = collections.deque(maxlen=MAX_DROPOUTS)
        self.recording = False     # were levels arriving at the last sample?

    def start(self):
        threading.Thread(target=self._run, name="level-history", daemon=True).start()
        return self

    def _run(self):
        while True:
            try:
                self.sample(self.get_levels(), time.time())
            except Exception as e:  # never stop recording over one bad reading
                self.log(f"level history: {type(e).__name__}: {e}")
            time.sleep(SAMPLE_EVERY)

    # ---- recording ----
    def sample(self, levels, now):
        sec = int(now)
        with self.lock:
            if self.sec is None or sec - self.sec > SECONDS or sec < self.sec:
                # First sample, or the clock jumped (the Mac slept): start the record afresh.
                for t in self.tracks.values():
                    t.ring[:] = bytes([NO_READING]) * SECONDS
                    t.signal_since = t.silent_since = None
                self.sec = sec
            while self.sec < sec:          # one or more seconds have finished
                self._close_second(self.sec)
                self.sec += 1
                for t in self.tracks.values():
                    t.ring[self.sec % SECONDS] = NO_READING
            devices = (levels or {}).get("devices") or {}
            self.recording = bool(devices)
            slot = sec % SECONDS
            for name, d in devices.items():
                if not isinstance(d, dict) or d.get("stale"):
                    continue
                for side in ("tx", "rx"):
                    for i, db in enumerate(d.get(side) or []):
                        key = (name, side, i + 1)
                        t = self.tracks.get(key)
                        if t is None:
                            t = self.tracks[key] = _Track()
                        raw = db_to_raw(db)
                        cur = t.ring[slot]
                        # Keep the loudest reading of the second (a lower raw value is louder;
                        # "no signal" only replaces "no reading").
                        if cur == NO_READING or (raw != NO_SIGNAL and (cur == NO_SIGNAL or raw < cur)):
                            t.ring[slot] = raw

    def _close_second(self, sec):
        """Run dropout detection on the second that just finished."""
        slot = sec % SECONDS
        found = []
        for key, t in self.tracks.items():
            v = t.ring[slot]
            if v == NO_READING:
                t.signal_since = t.silent_since = None
            elif v <= SIGNAL_RAW:
                if t.silent_since is not None and t.signal_since is not None:
                    gap = sec - t.silent_since
                    if DROPOUT_MIN <= gap <= DROPOUT_MAX and t.silent_since - t.signal_since >= SIGNAL_BEFORE:
                        found.append((key, t.silent_since, gap))
                    t.signal_since = sec
                elif t.signal_since is None:
                    t.signal_since = sec
                t.silent_since = None
            else:
                if t.silent_since is None and t.signal_since is not None:
                    t.silent_since = sec
                if t.silent_since is not None and sec - t.silent_since > DROPOUT_MAX:
                    t.signal_since = t.silent_since = None   # the source stopped; not a dropout
            t.last = v
        if found:
            self._record(found)

    def _record(self, found):
        routes = self.get_routes() or {}
        tx_drops = {(k[0], k[2]): (start, gap) for k, start, gap in found if k[1] == "tx"}
        for (device, side, ch), start, gap in found:
            entry = {"t": start, "seconds": gap, "device": device, "side": side, "ch": ch}
            if side == "rx":
                src = routes.get((device, ch))
                if not src:
                    continue                      # not routed: nothing to drop out
                entry["source"] = {"device": src[0], "ch": src[1]}
                if src[1] is not None and (src[0], src[1]) in tx_drops:
                    continue                      # the source itself dropped out; listed once there
                # Did the source keep sending while this input was silent?
                st = self.tracks.get((src[0], "tx", src[1])) if src[1] is not None else None
                if st is not None:
                    vals = [st.ring[s % SECONDS] for s in range(start, start + gap)]
                    entry["sourceKeptSending"] = sum(1 for v in vals if v <= SIGNAL_RAW) >= max(1, gap // 2)
            else:
                # Only outputs that feed something are worth listing.
                if not any(s[0] == device and s[1] == ch for s in routes.values()):
                    continue
            self.dropouts.appendleft(entry)

    # ---- reading ----
    def series(self, device, side, ch, seconds):
        """The last `seconds` seconds of one channel, oldest first, plus the second they end on."""
        seconds = max(10, min(SECONDS, int(seconds)))
        with self.lock:
            end = self.sec if self.sec is not None else int(time.time())
            t = self.tracks.get((device, side, ch))
            if t is None:
                return {"end": end, "peaks": [], "recording": self.recording}
            peaks = [t.ring[s % SECONDS] for s in range(end - seconds + 1, end + 1)]
        return {"end": end, "peaks": peaks, "recording": self.recording}

    def dropout_list(self, limit=200):
        with self.lock:
            return {"recording": self.recording, "dropouts": list(self.dropouts)[:limit],
                    "rules": {"min": DROPOUT_MIN, "max": DROPOUT_MAX, "signalDb": -SIGNAL_RAW / 2}}

    def clear_dropouts(self):
        with self.lock:
            self.dropouts.clear()
