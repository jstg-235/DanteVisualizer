"""Combine netaudio read-only outputs (raw_*.json) into live_snapshot.json.

Usage: build_snapshot.py [RAW_DIR] [OUTPUT]   (defaults: this folder, this folder/live_snapshot.json)
raw_clock.json and passive_listen.json are optional extras from the original probe.
"""
import json, datetime, os, pathlib, sys

here = pathlib.Path(__file__).parent
raw = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here
out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else here / "live_snapshot.json"

def load(name, default):
    p = raw / name
    return json.load(open(p)) if p.exists() else default

devs = load("raw_device_list.json", {"dante": {}})["dante"]
chans = load("raw_channels.json", {})
subs = load("raw_subscriptions.json", [])
clock = load("raw_clock.json", {})
passive = load("passive_listen.json", {})

KEEP = ["name", "server_name", "ipv4", "mac_address", "manufacturer", "model", "model_id", "product_version",
        "tx_count", "rx_count", "sample_rate_hz", "encoding", "latency_ms", "clock_role", "online", "last_seen",
        "network_redundancy", "detailed_metering_supported", "per_channel_signal_presence_supported",
        "rx_flow_count", "tx_flow_count"]

snapshot = {"captured_at": datetime.datetime.now().astimezone().isoformat(),
            "interface": {"name": os.environ.get("DANTE_IF", "en9"), "ipv4": os.environ.get("DANTE_IP")},
            "devices": []}

for key, d in devs.items():
    # Unreachable devices (seen by mDNS only) have no name/channels: fall back to the mDNS server name.
    name = d.get("name") or key.removesuffix(".local.").removesuffix(".local")
    c = chans.get(key, {})
    dev = {k: d.get(k) for k in KEEP}
    dev["name"] = name
    dev["reachable"] = d.get("tx_count") is not None or bool(c.get("tx_channels") or c.get("rx_channels"))
    dev["services"] = {"arc": 4440, "dbc": 4455, "cmc": 8800}
    dev["clock"] = clock.get(key)
    dev["tx_channels"] = [{"n": v["number"], "name": v["name"], "label": v.get("friendly_name") or v["name"],
                           "factory_name": v.get("factory_name")}
                          for v in sorted(c.get("tx_channels", {}).values(), key=lambda x: x["number"])]
    rx = []
    for v in sorted(c.get("rx_channels", {}).values(), key=lambda x: x["number"]):
        s = next((s for s in subs if s["rx_device"] == name and s["rx_channel_number"] == v["number"]), None)
        rx.append({"n": v["number"], "name": v["name"], "factory_name": v.get("factory_name"),
                   "subscription": None if not s or not s.get("tx_channel") else {
                       "tx_device": s["tx_device"], "tx_channel": s["tx_channel"],
                       "state": (s.get("status") or {}).get("state"),
                       "label": (s.get("status") or {}).get("label"),
                       "status_code": (s.get("status") or {}).get("code"),
                       "transport": (s.get("status") or {}).get("transport")}})
    dev["rx_channels"] = rx
    sp = passive.get("signal_presence_latest", {}).get(d.get("ipv4"))
    if sp:
        dev["signal_presence_sample"] = {"tx_raw": sp[0]["tx_levels"], "rx_raw": sp[0]["rx_levels"],
                                         "note": "raw/2 = -dBFS; 254/255 = muted/no signal"}
    snapshot["devices"].append(dev)

snapshot["routes"] = [{"tx_device": s["tx_device"], "tx_channel": s["tx_channel"],
                       "rx_device": s["rx_device"], "rx_channel": s["rx_channel"],
                       "rx_channel_number": s["rx_channel_number"],
                       "state": (s.get("status") or {}).get("state")} for s in subs if s.get("tx_channel")]
out.parent.mkdir(parents=True, exist_ok=True)
tmp = out.with_name("." + out.name + ".tmp")  # write then rename, so readers never see a partial file
json.dump(snapshot, open(tmp, "w"), indent=1, default=str)
os.replace(tmp, out)
print(len(snapshot["devices"]), "devices,", len(snapshot["routes"]), "routes")
