"""Derive raw_channels.json and raw_subscriptions.json from one `netaudio device list -o json` (saves two discovery passes)."""
import json, sys
src, outdir = sys.argv[1], sys.argv[2]
devs = json.load(open(src))["dante"]
chans, subs = {}, []
def conv(d, number):
    return {"number": int(d.get("number") or d.get("media_local_id") or number), "name": d.get("name") or str(number),
            "friendly_name": d.get("friendly_name"), "factory_name": d.get("factory_name")}
for key, v in devs.items():
    ch = v.get("channels") or {}
    chans[key] = {"name": v.get("name"),
                  "tx_channels": {k: conv(c, k) for k, c in (ch.get("transmitters") or {}).items()},
                  "rx_channels": {k: conv(c, k) for k, c in (ch.get("receivers") or {}).items()}}
    subs += v.get("subscriptions") or []
json.dump(chans, open(f"{outdir}/raw_channels.json", "w"), indent=1)
json.dump(subs, open(f"{outdir}/raw_subscriptions.json", "w"), indent=1)
