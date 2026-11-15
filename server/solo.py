"""Solo: listen to any channel by patching it to a chosen monitor output.

Solo is the one change allowed while Edit mode is off, and it can only ever touch the
monitor output's inputs:

  - The monitor output is chosen per network (saved with it, in solo.json in the data
    folder): a device and its left input, plus a right input unless it is set to mono
    (one speaker). Choosing or changing it needs Edit mode, since it decides what solo
    may change.
  - Solo on a channel patches it to both sides (dual mono), or to the left input only in
    mono. Solo on a pair patches the first to the left and the second to the right
    (a mono output gets the first).
  - Before the first solo, whatever the monitor inputs had is remembered. Soloing
    something else just switches the source. Unsolo puts back what was there before,
    on each input still showing the solo (one someone has re-patched since is left alone).
  - Solo changes are written to the change log (patch-log.jsonl) but not to the undo list.
"""
import json
import time
from pathlib import Path

from patching import PatchError


class Solo:
    def __init__(self, patcher, data_dir=None):
        self.p = patcher
        self.path = Path(data_dir) / "solo.json" if data_dir else None
        self.data = {"outputs": {}, "active": {}}   # per network name
        if self.path:
            try:
                d = json.loads(self.path.read_text())
                if isinstance(d, dict):
                    self.data["outputs"] = d.get("outputs") or {}
                    self.data["active"] = d.get("active") or {}
            except (OSError, ValueError):
                pass

    def _save(self):
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=1))
            tmp.replace(self.path)
        except OSError as e:
            self.p.log(f"solo: can't save {self.path}: {e}")

    def migrate(self, old_key, new_key):
        """Carry a monitor output (and an active solo) saved under the old per-port name
        over to the network's workspace, the first time it gets one."""
        with self.p.lock:
            moved = False
            for part in ("outputs", "active"):
                if old_key in self.data[part] and new_key not in self.data[part]:
                    self.data[part][new_key] = self.data[part][old_key]
                    moved = True
            if moved:
                self._save()
                self.p.log(f"solo: carried {old_key}'s monitor output over to {new_key}")

    def _net(self):
        net = self.p._network_key()
        if net is None:
            raise PatchError(409, {"error": "Solo works only on the live network."})
        return net

    # ---- status ----
    def status(self):
        with self.p.lock:
            net = self.p._network_key()
            out = self.data["outputs"].get(net) if net else None
            act = self.data["active"].get(net) if net else None
            return {"network": net, "output": out, "active": act and {k: act[k] for k in ("sources", "t")},
                    "available": self.p.available() and net is not None}

    # ---- the monitor output ----
    def set_output(self, body):
        with self.p.lock:
            if not self.p.on:
                raise PatchError(403, {"error": "Turn on Edit to choose the monitor output."})
            net = self._net()
            if body.get("clear"):
                if self.data["active"].get(net):
                    raise PatchError(409, {"error": "Unsolo first."})
                self.data["outputs"].pop(net, None)
                self._save()
                return self.status()
            model = self.p.get_model()
            dev = self.p._find(model, str(body.get("device") or ""))
            if not dev:
                raise PatchError(404, {"error": "choose a device"})
            mode = "mono" if body.get("mode") == "mono" else "stereo"
            ids = {c["id"] for c in dev["rx"]}
            try:
                left = int(body.get("left"))
                right = int(body.get("right")) if mode == "stereo" else None
            except (TypeError, ValueError):
                raise PatchError(400, {"error": "choose the input channel(s)"})
            if left not in ids or (right is not None and right not in ids):
                raise PatchError(404, {"error": f"{dev['name']} has no such input"})
            if right == left:
                raise PatchError(400, {"error": "left and right must be different inputs"})
            if self.data["active"].get(net):
                raise PatchError(409, {"error": "Unsolo before changing the monitor output."})
            self.data["outputs"][net] = {"device": dev["name"], "left": left, "right": right, "mode": mode}
            self._save()
            self.p.last_used = time.time()
            self.p.log(f"solo: monitor output for {net} is {dev['name']} in {left}" + (f"/{right}" if right else " (mono)"))
            return self.status()

    # ---- solo / unsolo ----
    def solo(self, sources):
        with self.p.lock:
            net = self._net()
            out = self.data["outputs"].get(net)
            if not out:
                raise PatchError(409, {"error": "Choose a monitor output first (Edit mode)."})
            if not self.p.available():
                raise PatchError(503, {"error": "the netaudio daemon isn't connected"})
            if not isinstance(sources, list) or not 1 <= len(sources) <= 2:
                raise PatchError(400, {"error": "solo one channel or a pair"})
            srcs = []
            for s in sources:
                try:
                    srcs.append({"txDevice": str(s["txDevice"]), "txChannel": int(s["txChannel"])})
                except (KeyError, TypeError, ValueError):
                    raise PatchError(400, {"error": "each source needs txDevice and txChannel"})
            targets = [out["left"]] + ([out["right"]] if out.get("mode") != "mono" and out.get("right") else [])
            changes = []
            for k, rx in enumerate(targets):
                s = srcs[min(k, len(srcs) - 1)]   # one source: dual mono
                changes.append({"rxDevice": out["device"], "rxChannel": rx, **s})
            # Only the monitor inputs, whatever was sent: that's what makes solo safe outside Edit.
            assert all(c["rxDevice"] == out["device"] and c["rxChannel"] in targets for c in changes)
            model = self.p.get_model()
            active = self.data["active"].get(net)
            if not active:
                before = {}
                for rx in targets:
                    cur = self.p._current(model, out["device"], rx)
                    if cur:
                        src = self.p._find(model, cur[0])
                        t = self.p._tx_by_name(src, cur[1])
                        before[str(rx)] = {"txDevice": cur[0], "txChannel": t["id"] if t else None}
                    else:
                        before[str(rx)] = None
                active = {"before": before}
            items = self.p.plan(changes)
            done, failed = self.p._run(items)
            if failed and not done:
                raise PatchError(502, {"error": failed[0]["error"], "failed": failed})
            active.update(sources=srcs, t=time.time(), device=out["device"], targets=targets)
            self.data["active"][net] = active
            self._save()
            what = ", ".join("%s out %s" % (s["txDevice"], s["txChannel"]) for s in srcs)
            self.p._write_log("solo", "solo " + what, done, failed)
            return {**self.status(), "applied": done, "failed": failed}

    def unsolo(self):
        with self.p.lock:
            net = self._net()
            active = self.data["active"].get(net)
            if not active:
                return {**self.status(), "applied": [], "failed": []}
            model = self.p.get_model()
            dev = self.p._find(model or {"devices": []}, active.get("device") or "")
            if not dev or dev.get("online") is False:
                # The monitor output isn't on the network on the cable now (it was left, or is
                # off). Keep the solo on record so Unsolo can put it back once it's here again.
                failed = [{"rxDevice": active.get("device"), "rxChannel": rx,
                           "error": f"{active.get('device')} isn't reachable; unsolo it when you're back on this network"}
                          for rx in active.get("targets") or []]
                self.p._write_log("unsolo", "unsolo (monitor output not reachable)", [], failed)
                return {**self.status(), "applied": [], "failed": failed}
            changes, skipped = [], []
            srcs = active.get("sources") or []
            for k, rx in enumerate(active.get("targets") or []):
                s = srcs[min(k, len(srcs) - 1)] if srcs else None
                cur = self.p._current(model, active["device"], rx)
                src_dev = self.p._find(model, s["txDevice"]) if s else None
                tx = next((t for t in (src_dev or {}).get("tx", []) if t["id"] == s["txChannel"]), None) if s else None
                if not cur or not tx or cur[0] != s["txDevice"] or cur[1] != tx["name"]:
                    skipped.append({"rxDevice": active["device"], "rxChannel": rx, "error": "re-patched since; left alone"})
                    continue
                b = (active.get("before") or {}).get(str(rx))
                if b and b.get("txChannel") is None:
                    b = None
                changes.append({"rxDevice": active["device"], "rxChannel": rx,
                                "txDevice": b["txDevice"] if b else "", "txChannel": b["txChannel"] if b else None})
            done, failed = [], []
            if changes:
                try:
                    items = self.p.plan(changes)
                except PatchError as e:
                    items, failed = [], [{"error": e.body.get("error")}]
                done, f2 = self.p._run(items)
                failed += f2
            self.data["active"].pop(net, None)
            self._save()
            self.p._write_log("unsolo", "unsolo", done, failed + skipped)
            return {**self.status(), "applied": done, "failed": failed + skipped}
