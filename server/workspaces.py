"""Workspaces: one per Dante network, so switching networks doesn't mix them up.

The app used to name the live network after the port it was on ("Live network (en11)"), so
two networks on the same port shared one layout, one solo monitor output and one monitor
history, and devices from the network you'd just left lingered as missing. Now each network
gets a workspace, which remembers:

  - its fingerprint: the devices it has (name and MAC address) and its clock leader;
  - the page's layout (block positions, opened blocks, colours, view);
  - its solo monitor output (solo.json, keyed by the workspace) and its own monitor history.

How a network is recognised (`observe`, called with each live model):

  - The online devices have to hold still for SETTLE_S seconds first, so a slow device or a
    cable being moved doesn't trigger anything.
  - Same network: at least MATCH of the devices the active workspace expects are online.
    Missing devices then really are missing, and stay on the diagram as offline.
  - Different network: the active workspace doesn't match, and another one does. The page
    shows a banner asking to switch; it never switches by itself.
  - New network: nothing matches and most of what's online is unknown to this workspace.
    The page offers to start a workspace for it.
  - Offline devices that the active workspace doesn't expect are hidden (the daemon can keep
    a device that left without saying goodbye; after a switch those belong to the old network).

Switching, clearing and forgetting live in serve.py, which also unsolos, turns Edit off and
resets the monitor and level history. Nothing here talks to a device.

Everything is kept in DIR/workspaces/ (index.json plus a folder per workspace), never in the
repository. Without a data folder (the demo) it's kept in memory only.
"""
import json
import re
import threading
import time
import uuid
from pathlib import Path

SETTLE_S = 15.0       # the online device list must hold still this long before it's judged
MATCH = 0.6           # share of a workspace's devices that must be online for it to match
NEW_SHARE = 0.5       # share of online devices unknown to the workspace that means "a new network"
LEARN_MAX = 0.3       # more new devices than this share of the workspace: ask before adding them


def _key(iface):
    return iface or "default"


class Workspaces:
    def __init__(self, data_dir=None, log=print, settle=SETTLE_S):
        self.dir = Path(data_dir) / "workspaces" if data_dir else None
        self.log = log
        self.settle = settle
        self.lock = threading.RLock()
        self.data = {"version": 1, "workspaces": {}, "active": {}}
        self.layouts = {}           # memory only (no data folder)
        self.seen = {}              # iface -> {"names", "macs", "since"}
        self.suggest = {}           # iface -> suggestion dict, or absent
        self.dismissed = {}         # iface -> frozenset of names the person said "keep" for
        self.on_switch = []         # callbacks(old_id, new_id, iface), run outside the lock
        self.on_create = []         # callbacks(ws, legacy_name), for carrying over old state
        self._cache = (None, None, None)
        self.rev = 0                # bumps on every change, so the shaped model is rebuilt
        if self.dir:
            try:
                d = json.loads((self.dir / "index.json").read_text())
                if isinstance(d, dict) and isinstance(d.get("workspaces"), dict):
                    self.data.update(workspaces=d["workspaces"], active=d.get("active") or {})
            except (OSError, ValueError):
                pass

    # ------------------------------------------------------------ storage
    def _save(self):
        self.rev += 1
        if not self.dir:
            return
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            tmp = self.dir / "index.tmp"
            tmp.write_text(json.dumps(self.data, indent=1))
            tmp.replace(self.dir / "index.json")
        except OSError as e:
            self.log(f"workspaces: can't save: {e}")

    def folder(self, ws_id):
        """The workspace's own folder (its layout and monitor history), or None in memory mode."""
        if not self.dir or not ws_id:
            return None
        p = self.dir / re.sub(r"[^A-Za-z0-9_-]", "", ws_id)
        p.mkdir(parents=True, exist_ok=True)
        return p

    def history_path(self, ws_id):
        f = self.folder(ws_id)
        return str(f / "history.sqlite") if f else None

    def get_layout(self, ws_id):
        with self.lock:
            if ws_id not in self.data["workspaces"]:
                return None
            f = self.folder(ws_id)
            if not f:
                return self.layouts.get(ws_id)
            try:
                return json.loads((f / "layout.json").read_text())
            except (OSError, ValueError):
                return None

    def set_layout(self, ws_id, layout):
        with self.lock:
            if ws_id not in self.data["workspaces"]:
                raise KeyError(ws_id)
            f = self.folder(ws_id)
            if not f:
                self.layouts[ws_id] = layout
                return
            tmp = f / "layout.tmp"
            tmp.write_text(json.dumps(layout))
            tmp.replace(f / "layout.json")

    # ------------------------------------------------------------ helpers
    @staticmethod
    def network_key(ws_id):
        """The key patching and solo use for this network."""
        return "ws:" + ws_id

    def active(self, iface):
        with self.lock:
            ws_id = self.data["active"].get(_key(iface))
            return self.data["workspaces"].get(ws_id) if ws_id else None

    @staticmethod
    def _online(model):
        names, macs = set(), {}
        for d in model.get("devices") or []:
            if d.get("online", True) is not False:
                names.add(d["name"])
                mac = (d.get("info") or {}).get("mac")
                if mac:
                    macs[d["name"]] = str(mac).lower()
        return names, macs

    @staticmethod
    def _leader(model):
        for d in model.get("devices") or []:
            if str((d.get("info") or {}).get("clockRole") or "").lower() == "leader" and d.get("online", True) is not False:
                return d["name"]
        return None

    @staticmethod
    def score(ws, names, macs):
        """(matched, expected): how many of the workspace's devices are online (by name or MAC)."""
        exp = ws.get("devices") or {}
        if not exp:
            return 0, 0
        mac_set = set(macs.values())
        hit = sum(1 for n, e in exp.items() if n in names or (e.get("mac") and e["mac"] in mac_set))
        return hit, len(exp)

    def _known(self, ws, name, macs):
        exp = ws.get("devices") or {}
        if name in exp:
            return True
        mac = macs.get(name)
        return bool(mac and any(e.get("mac") == mac for e in exp.values()))

    @staticmethod
    def suggest_name(model, names):
        """A first name for a new workspace: the clock leader, else the first device."""
        leader = Workspaces._leader(model)
        base = leader or (sorted(names, key=str.lower)[0] if names else "Network")
        return base[:60]

    def _create(self, name, names, macs, leader, iface):
        ws_id = uuid.uuid4().hex[:12]
        now = time.time()
        ws = {"id": ws_id, "name": (name or "Network").strip()[:60] or "Network", "iface": iface,
              "created": now, "lastUsed": now, "leader": leader,
              "devices": {n: {"mac": macs.get(n), "added": now} for n in sorted(names)}}
        self.data["workspaces"][ws_id] = ws
        return ws

    # ------------------------------------------------------------ the live model goes through here
    def observe(self, model, iface):
        """Judge the live model, and return it named after its workspace, with offline devices
        the workspace doesn't expect left out."""
        if not model or model.get("source") != "live":
            return model
        k = _key(iface)
        legacy = None
        with self.lock:
            now = time.time()
            before = self.data["active"].get(k)
            names, macs = self._online(model)
            seen = self.seen.get(k)
            if not seen or seen["names"] != names:
                self.seen[k] = seen = {"names": names, "macs": macs, "since": now}
                self.suggest.pop(k, None)
            settled = now - seen["since"] >= self.settle
            ws = self.active(iface)
            if ws is None and names and (settled or not self.data["workspaces"]):
                ws, legacy = self._first(model, names, macs, iface)
            elif ws is not None and settled and names:
                self._judge(ws, model, names, macs, k)
            out = self._shape(model, ws, iface)
            after = self.data["active"].get(k)
        if legacy:
            for cb in self.on_create:
                try:
                    cb(ws, legacy)
                except Exception as e:
                    self.log(f"workspaces: {e}")
        if after and after != before:
            self._fire_switch(before, after, iface)
        return out

    def _first(self, model, names, macs, iface):
        """No workspace is active for this port: pick up an obvious match, start the very first
        one silently (carrying over what the app kept per port before), or ask."""
        best = self._best(names, macs, exclude=None)
        if best and best[1] >= max(MATCH, 0.8):
            ws = best[0]
            self.data["active"][_key(iface)] = ws["id"]
            ws["lastUsed"] = time.time()
            self._save()
            self.log(f"workspaces: {ws['name']} on {_key(iface)}")
            return ws, None
        if not self.data["workspaces"]:
            ws = self._create(self.suggest_name(model, names), names, macs, self._leader(model), iface)
            self.data["active"][_key(iface)] = ws["id"]
            self._save()
            self.log(f"workspaces: started {ws['name']} for {_key(iface)}")
            return ws, "Live network" + (f" ({iface})" if iface else "")
        self.suggest[_key(iface)] = self._suggestion(model, names, macs, None)
        return None, None

    def _best(self, names, macs, exclude):
        best = None
        for ws in self.data["workspaces"].values():
            if exclude and ws["id"] == exclude:
                continue
            hit, total = self.score(ws, names, macs)
            if not total:
                continue
            share = hit / total
            # The share of what's online that this workspace knows: two networks of a similar
            # size that share a device or two shouldn't be mistaken for each other.
            cover = hit / max(1, len(names))
            if share >= MATCH and cover >= 0.5 and (not best or (share, hit) > (best[1], best[2])):
                best = (ws, share, hit, total)
        return best

    def _suggestion(self, model, names, macs, current):
        best = self._best(names, macs, exclude=current["id"] if current else None)
        if best:
            ws, _share, hit, total = best
            return {"kind": "switch", "to": ws["id"], "toName": ws["name"], "matched": hit, "expected": total,
                    "online": len(names)}
        return {"kind": "new", "online": len(names), "name": self.suggest_name(model, names)}

    def _judge(self, ws, model, names, macs, k):
        if k in self.suggest:
            return
        if self.dismissed.get(k) == frozenset(names):
            return
        hit, total = self.score(ws, names, macs)
        unknown = [n for n in names if not self._known(ws, n, macs)]
        if total and hit / total >= MATCH:
            # Same network. A few new devices join it; a crowd of them is asked about.
            if unknown and len(unknown) <= max(2, LEARN_MAX * total):
                now = time.time()
                for n in unknown:
                    ws["devices"][n] = {"mac": macs.get(n), "added": now}
                self._save()
                self.log(f"workspaces: {ws['name']} now has {', '.join(sorted(unknown))}")
            elif unknown:
                self.suggest[k] = {"kind": "add", "devices": sorted(unknown), "online": len(names)}
            for n in names & set(ws["devices"]):
                mac = macs.get(n)
                if mac and ws["devices"][n].get("mac") != mac:
                    ws["devices"][n]["mac"] = mac
                    self._save()
            return
        if not total or len(unknown) / max(1, len(names)) >= NEW_SHARE or self._best(names, macs, ws["id"]):
            self.suggest[k] = self._suggestion(model, names, macs, ws)
        # Otherwise most of the network is just missing (powered down, a switch out):
        # that's a real fault on this network, and the diagram shows it.

    def _shape(self, model, ws, iface):
        # The same network comes through many times a second: reuse the last answer. The
        # cache holds on to the device list it was made from, so its id can't be reused.
        key = (id(model.get("devices")), model.get("version"), model.get("capturedAt"),
               ws and ws["id"], self.rev)
        if self._cache[0] == key:
            return self._cache[1]
        out = dict(model)
        out["legacyName"] = model.get("name")
        port = f" ({iface})" if iface else ""
        if ws:
            exp = ws["devices"]
            out["devices"] = [d for d in model["devices"]
                              if d.get("online", True) is not False or d["name"] in exp]
            out["hidden"] = len(model["devices"]) - len(out["devices"])
            out["name"] = ws["name"] + port
            out["networkKey"] = self.network_key(ws["id"])
            out["workspace"] = {"id": ws["id"], "name": ws["name"]}
        else:
            # Not decided yet: keep the old name, so nothing is saved against the wrong network.
            out["networkKey"] = None
        self._cache = (key, out, model.get("devices"))
        return out

    # ------------------------------------------------------------ what the page asks
    def status(self, iface):
        with self.lock:
            k = _key(iface)
            ws = self.active(iface)
            seen = self.seen.get(k) or {"names": set(), "macs": {}, "since": time.time()}
            names, macs = seen["names"], seen["macs"]
            cur = None
            if ws:
                hit, total = self.score(ws, names, macs)
                missing = sorted(n for n, e in ws["devices"].items()
                                 if n not in names and not (e.get("mac") and e["mac"] in set(macs.values())))
                cur = {"id": ws["id"], "name": ws["name"], "matched": hit, "expected": total, "missing": missing}
            items = sorted(self.data["workspaces"].values(), key=lambda w: -w.get("lastUsed", 0))
            return {
                "iface": iface,
                "active": cur,
                "online": len(names),
                "settling": max(0, round(self.settle - (time.time() - seen["since"]))) if names else None,
                "suggest": self.suggest.get(k),
                "workspaces": [{"id": w["id"], "name": w["name"], "devices": len(w["devices"]),
                                "lastUsed": w.get("lastUsed"), "iface": w.get("iface")} for w in items],
            }

    def keep(self, iface):
        """The person chose to stay on this workspace: don't ask again until the network changes."""
        with self.lock:
            k = _key(iface)
            self.suggest.pop(k, None)
            if k in self.seen:
                self.dismissed[k] = frozenset(self.seen[k]["names"])

    def add_seen(self, iface):
        """Add the new devices in an "add" suggestion to the active workspace."""
        with self.lock:
            k = _key(iface)
            ws = self.active(iface)
            seen = self.seen.get(k)
            if not ws or not seen:
                raise LookupError("no active workspace")
            now = time.time()
            for n in seen["names"]:
                if not self._known(ws, n, seen["macs"]):
                    ws["devices"][n] = {"mac": seen["macs"].get(n), "added": now}
            self.suggest.pop(k, None)
            self._save()
            return ws

    def switch(self, iface, ws_id=None, new_name=None):
        """Make a workspace active on this port: an existing one, or a new one built from the
        devices online now. Returns (old id, new workspace)."""
        with self.lock:
            k = _key(iface)
            old = self.data["active"].get(k)
            seen = self.seen.get(k) or {"names": set(), "macs": {}}
            if ws_id:
                ws = self.data["workspaces"].get(ws_id)
                if not ws:
                    raise LookupError("no such workspace")
            else:
                ws = self._create(new_name or "Network", seen["names"], seen["macs"], None, iface)
            ws["lastUsed"] = time.time()
            ws["iface"] = iface
            self.data["active"][k] = ws["id"]
            self.suggest.pop(k, None)
            self.dismissed.pop(k, None)
            self._save()
        self.log(f"workspaces: {k} switched to {ws['name']}")
        if old != ws["id"]:
            self._fire_switch(old, ws["id"], iface)
        return old, ws

    def clear(self, iface):
        """Start the active workspace's device list again from what's online now."""
        with self.lock:
            k = _key(iface)
            ws = self.active(iface)
            if not ws:
                raise LookupError("no active workspace")
            seen = self.seen.get(k) or {"names": set(), "macs": {}}
            now = time.time()
            ws["devices"] = {n: {"mac": seen["macs"].get(n), "added": now} for n in sorted(seen["names"])}
            self.suggest.pop(k, None)
            self.dismissed.pop(k, None)
            self._save()
            self.log(f"workspaces: cleared {ws['name']} ({len(ws['devices'])} devices online)")
            return ws

    def forget(self, iface, device):
        with self.lock:
            ws = self.active(iface)
            if not ws or device not in ws["devices"]:
                raise LookupError(f"{device} isn't in this workspace")
            ws["devices"].pop(device)
            self._save()
            self.log(f"workspaces: {ws['name']} forgot {device}")
            return ws

    def rename(self, ws_id, name):
        name = str(name or "").strip()[:60]
        if not name:
            raise ValueError("give it a name")
        with self.lock:
            ws = self.data["workspaces"].get(ws_id)
            if not ws:
                raise LookupError("no such workspace")
            ws["name"] = name
            self._save()
            return ws

    def delete(self, ws_id):
        with self.lock:
            if ws_id not in self.data["workspaces"]:
                raise LookupError("no such workspace")
            if ws_id in self.data["active"].values():
                raise ValueError("switch to another workspace first")
            self.data["workspaces"].pop(ws_id)
            self._save()
            f = self.dir / ws_id if self.dir else None
            if f and f.is_dir():
                for p in f.iterdir():
                    try:
                        p.unlink()
                    except OSError:
                        pass
                try:
                    f.rmdir()
                except OSError:
                    pass
            self.layouts.pop(ws_id, None)

    def export(self, ws_id):
        with self.lock:
            ws = self.data["workspaces"].get(ws_id)
            if not ws:
                raise LookupError("no such workspace")
            return {"format": "dante-visualizer-workspace", "version": 1, "workspace": ws,
                    "layout": self.get_layout(ws_id)}

    def _fire_switch(self, old, new, iface):
        for cb in self.on_switch:
            try:
                cb(old, new, iface)
            except Exception as e:
                self.log(f"workspaces: {e}")
