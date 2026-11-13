"""Continuous Dante metering helper: writes levels.json about 5x per second.

What it sends to devices
  - CMC metering_start (and later metering_stop) to every reachable device that does not publish
    passive signal presence, naming this Mac and UDP port METER_PORT (default 8762; Dante Controller
    holds 8752). Renewed every RENEW_S seconds. Non-persistent: changes no settings or routes.
  - Nothing else beyond netaudio's normal discovery/controller registration (same as `device list`).
  With --dry-run it sends NO metering requests (passive heartbeat levels only).

What it reads
  - Metering packets on 224.0.0.231:METER_PORT (devices we asked).
  - Passive per-channel signal presence in heartbeats on 224.0.0.233:8708 (e.g. Fourier transform.engine).

Output (atomic write):  {"updated": <unix>, "interface": "en11",
                         "devices": {"<name>": {"t": <unix time of last packet>, "source": "detailed"|"passive",
                                                "tx": [raw...], "rx": [raw...]}}}
  raw byte per channel, channel 1 first; raw/2 = -dBFS, 0 = clip, 254/255 = muted/no signal.
  Names match live_snapshot.json.

Lifecycle
  - SIGINT/SIGTERM: send metering_stop to every device we started, then exit 0.
  - Any error inside a session: metering_stop is still sent (finally), then the session restarts after 5 s.
  - Device set (reachable names in live_snapshot.json) changes: session restarts with fresh discovery.
  - Dante interface changes: exit code 3 so run_meter_daemon.sh restarts with the new interface
    (the en-interface socket shim is fixed per process).
  - If the process is killed with SIGKILL, devices stop streaming by themselves once renewals stop.

Run via run_meter_daemon.sh (sets DANTE_IF / PYTHONPATH=shim). Files live in $DV_DATA when set
(the Mac app sets it), otherwise next to this script. Tied to netaudio 0.5.7 internals.
"""
import argparse
import asyncio
import json
import logging
import os
import signal
import socket
import struct
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DV_DATA") or HERE)
IFACE = os.environ.get("DANTE_IF", "en9")
log = logging.getLogger("meter_daemon")

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=str(DATA / "levels.json"))
ap.add_argument("--snapshot", default=str(DATA / "live_snapshot.json"))
ap.add_argument("--port", type=int, default=int(os.environ.get("NETAUDIO_METERING_PORT", 8762)))
ap.add_argument("--renew", type=float, default=3.0, help="seconds between metering_start renewals")
ap.add_argument("--write-hz", type=float, default=5.0)
ap.add_argument("--dry-run", action="store_true", help="send no metering requests (passive levels only)")
ap.add_argument("--max-session", type=float, default=0, help="restart the session after N s (0 = never)")
args = ap.parse_args()
os.environ["NETAUDIO_METERING_PORT"] = str(args.port)

from netaudio import core  # noqa: E402
from netaudio.common.app_config import settings as app_settings  # noqa: E402
from netaudio.cli_support.execution import _command_context  # noqa: E402
from netaudio.dante.const import MULTICAST_GROUP_CONTROL_MONITORING  # noqa: E402
from netaudio.dante.service import DanteMulticastService  # noqa: E402

app_settings.interface = IFACE
app_settings.mdns_timeout = 3.0
app_settings.metering_port = args.port
core.require()

IFACE_IP = None
for line in os.popen(f"ifconfig {IFACE} 2>/dev/null"):
    if line.strip().startswith("inet "):
        IFACE_IP = line.split()[1]
        break

levels: dict[str, dict] = {}   # name -> {"t", "source", "tx", "rx"}
ip_to_name: dict[str, str] = {}
stats: dict[str, int] = {}
stopping = asyncio.Event()


def snapshot_state():
    """(interface, frozenset of reachable device names) from live_snapshot.json, or (None, None)."""
    try:
        snap = json.loads(Path(args.snapshot).read_text())
    except Exception:
        return None, None
    names = frozenset(d["name"] for d in snap.get("devices", []) if d.get("reachable", True) and d.get("ipv4"))
    return (snap.get("interface") or {}).get("name"), names


def snapshot_ips():
    """ipv4 -> name for reachable devices in live_snapshot.json (so passive levels map even if discovery missed one)."""
    try:
        snap = json.loads(Path(args.snapshot).read_text())
    except Exception:
        return {}
    return {d["ipv4"]: d["name"] for d in snap.get("devices", []) if d.get("ipv4") and d.get("reachable", True)}


def write_levels():
    tmp = Path(args.out).with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"updated": time.time(), "interface": IFACE, "devices": levels}, separators=(",", ":")))
    os.replace(tmp, args.out)


def on_meter_packet(data: bytes, addr):
    name = ip_to_name.get(addr[0])
    if not name:
        return
    try:
        p = core.parse_response("metering", data)
    except Exception:
        return
    levels[name] = {"t": time.time(), "source": "detailed", "tx": list(p["tx_levels"]), "rx": list(p["rx_levels"])}
    stats[name] = stats.get(name, 0) + 1


def on_heartbeat(sock):
    try:
        data, addr = sock.recvfrom(65535)
    except BlockingIOError:
        return
    name = ip_to_name.get(addr[0])
    if not name:
        return
    try:
        recs = core.parse_response("signal_presence", data)
    except Exception:
        return
    if not recs:
        return
    cur = levels.get(name)
    if cur and cur.get("source") == "detailed" and time.time() - cur["t"] < 2:
        return  # detailed metering is flowing; prefer it
    r = recs[0]
    tx = list(cur["tx"]) if cur and cur.get("source") == "passive" else []
    rx = list(cur["rx"]) if cur and cur.get("source") == "passive" else []
    for side, arr in (("tx", tx), ("rx", rx)):
        first = r.get(f"{side}_first_channel_index", 0) or 0
        vals = r[f"{side}_levels"]
        need = first + len(vals)
        arr.extend([255] * (need - len(arr)))
        arr[first:need] = vals
    levels[name] = {"t": time.time(), "source": "passive", "tx": tx, "rx": rx}
    stats[name] = stats.get(name, 0) + 1


def heartbeat_socket():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    s.bind(("", 8708))
    if IFACE_IP:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                     struct.pack("4s4s", socket.inet_aton("224.0.0.233"), socket.inet_aton(IFACE_IP)))
    s.setblocking(False)
    return s


async def writer():
    while not stopping.is_set():
        try:
            write_levels()
        except Exception as e:
            log.warning("write failed: %s", e)
        await asyncio.sleep(1 / args.write_hz)


async def session():
    """One discovery + metering session. Returns 'iface' if the Dante interface changed."""
    snap_iface, snap_names = snapshot_state()
    async with _command_context(discover_devices=True, populate_controls=False) as (devices, application):
        ip_to_name.clear()
        ip_to_name.update(snapshot_ips())
        targets = []
        for server_name, d in devices.items():
            if not d.ipv4:
                continue
            name = d.name or server_name.removesuffix(".local.")
            ip_to_name[str(d.ipv4)] = name
            if d.per_channel_signal_presence_supported is True:
                continue  # passive levels in heartbeats, no request needed
            if d.detailed_metering_supported is False:
                continue
            targets.append((server_name, d, name))
        # forget devices that left
        discovered = {d.name or k.removesuffix(".local.") for k, d in devices.items() if d.ipv4}
        missed = set(snap_names or ()) - discovered
        if missed:
            log.info("discovery missed %s; will retry discovery in 20 s", ", ".join(sorted(missed)))
        for gone in set(levels) - set(ip_to_name.values()):
            levels.pop(gone, None)
        log.info("session: %d devices, metering %d%s: %s", len(ip_to_name), len(targets),
                 " (dry run, not sent)" if args.dry_run else "", ", ".join(n for _, _, n in targets))

        listener = DanteMulticastService(MULTICAST_GROUP_CONTROL_MONITORING, args.port,
                                         interface_name=IFACE, on_packet=on_meter_packet)
        await listener.start()
        hb = heartbeat_socket()
        loop = asyncio.get_running_loop()
        loop.add_reader(hb.fileno(), on_heartbeat, hb)
        started = []
        idents = {}
        try:
            began = time.time()
            next_renew = 0.0
            while not stopping.is_set():
                now = time.time()
                if not args.dry_run and now >= next_renew:
                    async def start_one(server_name, d, name):
                        ip = str(d.ipv4)
                        if ip not in idents:
                            idents[ip] = application.cmc.controller_identity(ip)
                        host_ip, host_mac = idents[ip]
                        await application.cmc.start_metering(ip, name, host_ip, host_mac, args.port,
                                                             ports=d._service_ports())
                        if (server_name, d, name) not in started:
                            started.append((server_name, d, name))
                    res = await asyncio.gather(*(start_one(*t) for t in targets), return_exceptions=True)
                    for t, r in zip(targets, res):
                        if isinstance(r, Exception):
                            log.warning("metering_start failed for %s: %s", t[2], r)
                    next_renew = now + args.renew
                # device set or interface changed?
                i2, n2 = snapshot_state()
                if i2 and i2 != IFACE:
                    log.info("interface changed %s -> %s", IFACE, i2)
                    return "iface"
                if n2 is not None and snap_names is not None and n2 != snap_names:
                    log.info("device set changed; restarting session")
                    return "devices"
                if missed and now - began > 20:
                    return "missed"
                if args.max_session and now - began > args.max_session:
                    return "timer"
                try:
                    await asyncio.wait_for(stopping.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
        finally:
            loop.remove_reader(hb.fileno())
            hb.close()
            if started:
                async def stop_one(server_name, d, name):
                    ip = str(d.ipv4)
                    host_ip, host_mac = idents.get(ip) or application.cmc.controller_identity(ip)
                    await application.cmc.stop_metering(ip, name, host_ip, host_mac, args.port,
                                                        ports=d._service_ports())
                res = await asyncio.gather(*(asyncio.wait_for(stop_one(*t), 3) for t in started),
                                           return_exceptions=True)
                ok = [t[2] for t, r in zip(started, res) if not isinstance(r, Exception)]
                bad = [(t[2], repr(r)) for t, r in zip(started, res) if isinstance(r, Exception)]
                log.info("metering_stop sent to %s%s", ", ".join(ok) or "none",
                         f"; FAILED for {bad}" if bad else "")
            await listener.stop()


async def stats_logger():
    last = {}
    while not stopping.is_set():
        await asyncio.sleep(10)
        rates = {n: (c - last.get(n, 0)) / 10 for n, c in stats.items()}
        last = dict(stats)
        log.info("packets/s: %s", ", ".join(f"{n} {r:.1f}" for n, r in sorted(rates.items())))


def interface_gone():
    """True when this helper should restart on another interface: ours has disappeared,
    or the snapshot now comes from a different one."""
    present = os.popen("ifconfig -l").read().split()
    if IFACE not in present:
        return True
    snap_iface, _ = snapshot_state()
    return bool(snap_iface and snap_iface != IFACE)


async def main():
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        loop.add_signal_handler(sig, stopping.set)
    w = asyncio.create_task(writer())
    s = asyncio.create_task(stats_logger())
    code = 0
    try:
        while not stopping.is_set():
            if interface_gone():
                log.info("interface %s is gone or no longer the Dante one; restarting to re-detect", IFACE)
                code = 3
                break
            try:
                why = await session()
                if why == "iface":
                    code = 3
                    break
            except Exception as e:
                log.exception("session error: %s; retrying in 5 s", e)
                try:
                    await asyncio.wait_for(stopping.wait(), timeout=5)
                except asyncio.TimeoutError:
                    pass
    finally:
        stopping.set()
        w.cancel()
        s.cancel()
    return code


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for noisy in ("netaudio", "zeroconf"):
        logging.getLogger(noisy).setLevel(logging.ERROR)
    log.info("interface %s (%s), port %d, renew %.1fs%s", IFACE, IFACE_IP, args.port, args.renew,
             ", DRY RUN" if args.dry_run else "")
    sys.exit(asyncio.run(main()))
