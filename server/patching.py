"""Patching: make and remove Dante subscriptions, behind an Edit mode.

The app is read-only unless Edit mode is on. Edit mode lives here, in the server, so a stray
click, a second window or a stale page can't patch anything while it is off:

  - Edit is off when the server starts, and turns itself off after IDLE_S seconds with no
    patching, when the network changes (another port, or the daemon reconnects to a different
    set of devices), and when the netaudio daemon disconnects.
  - Every change is planned first. A change that removes or replaces a patch, or a group of
    more than one change, is refused with the plan (HTTP 409, "needsConfirm") until the page
    sends it again with "confirmed": true, after the person has seen it on the confirm card.
    A single new patch on an empty input goes straight through.
  - Every applied group goes on an undo list (cleared when the network changes) and, when a
    data folder is given, into patch-log.jsonl there: time, network, what was there before,
    what it is now, and whether the device took it.

Changes reach devices only through the netaudio daemon (POST /subscribe and /unsubscribe).
In demo mode (--monitor-demo with no daemon) they change a pretend overlay instead.

A change is {"rxDevice": name, "rxChannel": n, "txDevice": name, "txChannel": n} to patch,
or the same with txDevice "" (or missing) to unpatch. Channels are channel numbers.
"""
import json
import threading
import time
from pathlib import Path

IDLE_S = 300          # Edit mode turns off after this long with no patching
VERIFY_S = 5.0        # how long to wait for the network to show a change


class PatchError(Exception):
    def __init__(self, status, body):
        super().__init__(body.get("error", ""))
        self.status, self.body = status, body


class Patcher:
    def __init__(self, get_model, get_levels, feed=None, demo=False, log_dir=None, log=print):
        self.get_model = get_model      # () -> the model on screen (with overlay applied), or None
        self.get_levels = get_levels    # () -> /api/levels shape, or None
        self.feed = feed
        self.demo = demo and not feed
        self.log_path = Path(log_dir) / "patch-log.jsonl" if log_dir else None
        self.log = log
        self.lock = threading.RLock()   # one change at a time
        self.on = False
        self.last_used = 0.0
        self.network = None             # the network Edit mode was turned on for
        self.undo_stack = []            # [{"label", "items": [...]}]
        self.overlay = {}               # demo only: (device, rx) -> (txDevice, txChannelName)
        self.off_reason = None
        threading.Thread(target=self._ticker, name="patch-edit", daemon=True).start()

    # ---- availability and Edit mode ----
    def available(self):
        """Patching works only on the live network through the daemon (or the demo)."""
        if self.demo:
            return True
        return bool(self.feed and self.feed.connected)

    def _network_key(self, model=None):
        model = model or self.get_model()
        if not model or model.get("source") != "live":
            return None
        return model.get("name")

    def status(self):
        with self.lock:
            remaining = max(0, int(self.last_used + IDLE_S - time.time())) if self.on else 0
            top = self.undo_stack[-1] if self.undo_stack else None
            return {
                "available": self.available(),
                "on": self.on,
                "remaining": remaining,
                "idleLimit": IDLE_S,
                "network": self.network if self.on else self._network_key(),
                "undo": len(self.undo_stack),
                "undoLabel": top["label"] if top else None,
                "demo": self.demo,
                "offReason": self.off_reason,
            }

    def set_edit(self, on):
        with self.lock:
            if on:
                if not self.available():
                    raise PatchError(409, {"error": "Patching needs the live network through the netaudio daemon."})
                net = self._network_key()
                if net is None:
                    raise PatchError(409, {"error": "Go live first: patching only works on the live network."})
                if net != self.network:
                    self.undo_stack.clear()
                self.on, self.network, self.last_used, self.off_reason = True, net, time.time(), None
                self.log(f"patching: Edit mode on for {net}")
            elif self.on:
                self._turn_off("turned off")
            return self.status()

    def _turn_off(self, reason):
        self.on = False
        self.off_reason = reason
        self.log(f"patching: Edit mode off ({reason})")

    def _ticker(self):
        while True:
            time.sleep(1)
            try:
                with self.lock:
                    if not self.on:
                        continue
                    if time.time() - self.last_used > IDLE_S:
                        self._turn_off(f"no patching for {IDLE_S // 60} minutes")
                    elif not self.available():
                        self._turn_off("the netaudio daemon disconnected")
                    elif self._network_key() != self.network:
                        self._turn_off("the network changed")
                        self.undo_stack.clear()
            except Exception as e:   # never let the ticker die
                self.log(f"patching: {e}")

    # ---- demo overlay ----
    def apply_overlay(self, model):
        if not self.demo or not model or not self.overlay:
            return model
        devices = []
        for d in model["devices"]:
            rx = []
            for c in d["rx"]:
                o = self.overlay.get((d["name"], c["id"]))
                if o is not None:
                    c = {**c, "subDevice": o[0], "subChannel": o[1],
                         "state": "connected" if o[0] else None,
                         "stateLabel": "Subscribed (unicast)" if o[0] else None}
                rx.append(c)
            devices.append({**d, "rx": rx})
        return {**model, "devices": devices}

    # ---- planning ----
    @staticmethod
    def _find(model, name):
        return next((d for d in model["devices"] if d["name"] == name), None)

    @staticmethod
    def _tx_by_name(dev, name):
        if not dev or not name:
            return None
        return next((t for t in dev["tx"] if t["name"] == name), None) or \
            next((t for t in dev["tx"] if str(t["id"]) == str(name)), None)

    def _signal(self, device, ch):
        try:
            lv = (self.get_levels() or {}).get("devices", {}).get(device)
            v = lv["rx"][ch - 1] if lv and not lv.get("stale") else None
            return v is not None
        except (IndexError, KeyError, TypeError):
            return False

    def plan(self, changes):
        """Normalise and check changes against the network. Returns the items to apply
        (no-ops dropped). Raises PatchError for anything that can't be done."""
        model = self.get_model()
        if not model:
            raise PatchError(503, {"error": "no network yet"})
        if not isinstance(changes, list) or not changes:
            raise PatchError(400, {"error": "no changes given"})
        if len(changes) > 512:
            raise PatchError(400, {"error": "too many changes at once (512 at most)"})
        items, seen = [], set()
        for ch in changes:
            if not isinstance(ch, dict):
                raise PatchError(400, {"error": "each change must be an object"})
            rx_dev = self._find(model, str(ch.get("rxDevice") or ""))
            try:
                rx_n = int(ch.get("rxChannel"))
            except (TypeError, ValueError):
                raise PatchError(400, {"error": "rxChannel must be a channel number"})
            if not rx_dev:
                raise PatchError(404, {"error": f"no device called {ch.get('rxDevice')!r}"})
            rx = next((c for c in rx_dev["rx"] if c["id"] == rx_n), None)
            if not rx:
                raise PatchError(404, {"error": f"{rx_dev['name']} has no input {rx_n}"})
            if (rx_dev["name"], rx_n) in seen:
                raise PatchError(400, {"error": f"{rx_dev['name']} input {rx_n} is changed twice"})
            seen.add((rx_dev["name"], rx_n))
            if rx_dev.get("online") is False:
                raise PatchError(409, {"error": f"{rx_dev['name']} is offline"})
            tx_name = str(ch.get("txDevice") or "")
            to = None
            if tx_name:
                tx_dev = self._find(model, tx_name)
                if not tx_dev:
                    raise PatchError(404, {"error": f"no device called {tx_name!r}"})
                try:
                    tx_n = int(ch.get("txChannel"))
                except (TypeError, ValueError):
                    raise PatchError(400, {"error": "txChannel must be a channel number"})
                tx = next((t for t in tx_dev["tx"] if t["id"] == tx_n), None)
                if not tx:
                    raise PatchError(404, {"error": f"{tx_name} has no output {tx_n}"})
                if tx_dev.get("online") is False:
                    raise PatchError(409, {"error": f"{tx_name} is offline"})
                to = {"device": tx_name, "channel": tx_n, "name": tx["name"]}
            before = None
            if rx.get("subDevice"):
                src = self._find(model, rx["subDevice"])
                t = self._tx_by_name(src, rx.get("subChannel"))
                before = {"device": rx["subDevice"], "channel": t["id"] if t else None,
                          "name": rx.get("subChannel") or ""}
            same = (before is None and to is None) or (
                before and to and before["device"] == to["device"] and before["name"] == to["name"])
            if same:
                continue
            items.append({
                "rxDevice": rx_dev["name"], "rxChannel": rx_n, "rxName": rx["name"],
                "before": before, "after": to,
                "kind": "patch" if before is None else ("unpatch" if to is None else "replace"),
                "signal": bool(before) and self._signal(rx_dev["name"], rx_n),
            })
        return items

    @staticmethod
    def needs_confirm(items):
        return len(items) > 1 or any(i["kind"] != "patch" for i in items)

    # ---- applying ----
    def apply(self, changes, confirmed=False, label=None):
        with self.lock:
            if not self.on:
                raise PatchError(403, {"error": "Edit mode is off. Turn on Edit to patch."})
            if not self.available():
                raise PatchError(503, {"error": "the netaudio daemon isn't connected"})
            items = self.plan(changes)
            if not items:
                return {"applied": [], "failed": [], "note": "nothing to change"}
            if self.needs_confirm(items) and not confirmed:
                raise PatchError(409, {"needsConfirm": True, "changes": items, "label": label})
            self.last_used = time.time()
            done, failed = self._run(items)
            if done:
                self.undo_stack.append({"label": label or describe(done), "items": done, "t": time.time()})
                del self.undo_stack[:-50]
            self._write_log("patch", label, done, failed)
            self.last_used = time.time()
            return {"applied": done, "failed": failed}

    def undo(self):
        with self.lock:
            if not self.on:
                raise PatchError(403, {"error": "Edit mode is off. Turn on Edit to undo."})
            if not self.undo_stack:
                raise PatchError(409, {"error": "nothing to undo"})
            group = self.undo_stack[-1]
            model = self.get_model()
            back, skipped = [], []
            for i in group["items"]:
                # Only put back inputs that still show what we left there.
                cur = self._current(model, i["rxDevice"], i["rxChannel"])
                want = (i["after"]["device"], i["after"]["name"]) if i["after"] else None
                if cur != want:
                    skipped.append({**i, "error": "changed since"})
                    continue
                b = i["before"]
                back.append({"rxDevice": i["rxDevice"], "rxChannel": i["rxChannel"],
                             "txDevice": b["device"] if b else "", "txChannel": b["channel"] if b else None})
            items = self.plan(back) if back else []
            self.last_used = time.time()
            done, failed = self._run(items)
            self.undo_stack.pop()
            self._write_log("undo", group["label"], done, failed + skipped)
            return {"applied": done, "failed": failed + skipped, "label": group["label"]}

    @staticmethod
    def _current(model, device, ch):
        d = next((x for x in (model or {}).get("devices", []) if x["name"] == device), None)
        c = next((x for x in (d or {}).get("rx", []) if x["id"] == ch), None)
        return (c["subDevice"], c["subChannel"]) if c and c.get("subDevice") else None

    def _run(self, items):
        done, failed = [], []
        for i in items:
            try:
                if self.demo:
                    a = i["after"]
                    self.overlay[(i["rxDevice"], i["rxChannel"])] = (a["device"], a["name"]) if a else ("", "")
                else:
                    self._send(i)
                done.append(i)
            except PatchError as e:
                failed.append({**i, "error": e.body.get("error") or "refused"})
            except Exception as e:
                failed.append({**i, "error": f"{type(e).__name__}: {e}"})
        if done and not self.demo:
            for i in done:
                i["seen"] = False
            self._verify(done)
        return done, failed

    def _send(self, i):
        sn = self.feed.server_name(i["rxDevice"])
        if not sn:
            raise PatchError(404, {"error": f"the daemon doesn't know {i['rxDevice']}"})
        if i["after"]:
            body = {"rx_device": sn, "rx_channel": i["rxChannel"],
                    "tx_device": i["after"]["device"], "tx_channel": self._daemon_tx_name(i["after"])}
            status, data = self.feed._post("/subscribe", body)
        else:
            status, data = self.feed._post("/unsubscribe", {"rx_device": sn, "rx_channel": i["rxChannel"]})
        if status != 200 or data.get("success") is False or data.get("error"):
            raise PatchError(502, {"error": str(data.get("error") or data.get("message") or f"HTTP {status}")})

    def _daemon_tx_name(self, after):
        """The transmit channel's Dante name as the daemon knows it (the diagram may show a label)."""
        sn = self.feed.server_name(after["device"])
        d = self.feed.devices.get(sn) or {}
        for k, c in ((d.get("channels") or {}).get("transmitters") or {}).items():
            for v in (c.get("number"), c.get("media_local_id"), k):
                try:
                    if int(v) == after["channel"]:
                        return c.get("name") or after["name"]
                except (TypeError, ValueError):
                    continue
        return after["name"]

    def _verify(self, done):
        """Wait (briefly) for the network to show each change."""
        end = time.time() + VERIFY_S
        while time.time() < end:
            model = self.get_model()
            for i in done:
                if not i["seen"]:
                    cur = self._current(model, i["rxDevice"], i["rxChannel"])
                    a = i["after"]
                    i["seen"] = (cur is None) if a is None else bool(cur and cur[0] == a["device"])
            if all(i["seen"] for i in done):
                return
            time.sleep(0.25)

    def _write_log(self, action, label, done, failed):
        for i in done + failed:
            self.log(f"patching: {action} {line(i)}" + (f" FAILED: {i['error']}" if i.get("error") else ""))
        if not self.log_path:
            return
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a") as f:
                f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "action": action,
                                    "network": self.network, "label": label,
                                    "applied": done, "failed": failed}) + "\n")
        except OSError as e:
            self.log(f"patching: can't write the change log: {e}")


def end(e):
    return f"{e['device']} out {e['channel']}" if e else "nothing"


def line(i):
    return f"{i['rxDevice']} in {i['rxChannel']}: {end(i['before'])} -> {end(i['after'])}"


def describe(items):
    if len(items) == 1:
        i = items[0]
        if i["after"]:
            return f"patch {i['after']['device']} out {i['after']['channel']} to {i['rxDevice']} in {i['rxChannel']}"
        return f"unpatch {i['rxDevice']} in {i['rxChannel']}"
    return f"{len(items)} changes"
