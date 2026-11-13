"""Small network helpers: list interfaces, read the ARP table, ping a host.

Uses only the Python standard library and the tools built into macOS
(ifconfig, arp, ping), so nothing extra needs to be installed.
"""
import platform
import re
import subprocess

IS_MAC = platform.system() == "Darwin"


def _run(cmd, timeout=5):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout
    except Exception:
        return ""


def list_interfaces():
    """Return [{'name': 'en0', 'ip': '169.254.1.2', 'netmask': ...}, ...] (IPv4 only)."""
    result = []
    if IS_MAC:
        text = _run(["ifconfig"])
        current = None
        for line in text.splitlines():
            m = re.match(r"^(\S+?):\s+flags=", line)
            if m:
                current = m.group(1)
                continue
            m = re.search(r"\binet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-f]+)", line)
            if m and current:
                mask_int = int(m.group(2), 16)
                mask = ".".join(str((mask_int >> s) & 255) for s in (24, 16, 8, 0))
                result.append({"name": current, "ip": m.group(1), "netmask": mask})
    else:
        text = _run(["ip", "-4", "-o", "addr"])
        for line in text.splitlines():
            m = re.search(r"^\d+:\s+(\S+)\s+inet (\d+\.\d+\.\d+\.\d+)/(\d+)", line)
            if m:
                bits = int(m.group(3))
                mask_int = (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF
                mask = ".".join(str((mask_int >> s) & 255) for s in (24, 16, 8, 0))
                result.append({"name": m.group(1), "ip": m.group(2), "netmask": mask})
    return [r for r in result if not r["ip"].startswith("127.")]


def arp_table():
    """Return {ip: 'aa:bb:cc:dd:ee:ff'} from the computer's ARP cache."""
    table = {}
    text = _run(["arp", "-an"]) if IS_MAC else _run(["ip", "neigh"])
    for line in text.splitlines():
        ip = re.search(r"(\d+\.\d+\.\d+\.\d+)", line)
        mac = re.search(r"(([0-9a-fA-F]{1,2}:){5}[0-9a-fA-F]{1,2})", line)
        if ip and mac:
            table[ip.group(1)] = normalize_mac(mac.group(1))
    return table


def normalize_mac(mac):
    """'0:1d:c1:a:b:c' -> '00:1d:c1:0a:0b:0c'"""
    parts = re.split(r"[:\-]", mac.strip().lower())
    if len(parts) != 6:
        return mac.lower()
    return ":".join(p.zfill(2) for p in parts)


def ping(ip, timeout_s=1):
    """Ping once. Returns round-trip time in milliseconds, or None if no reply."""
    if IS_MAC:
        cmd = ["ping", "-c", "1", "-t", str(max(1, int(timeout_s))), "-W", str(int(timeout_s * 1000)), ip]
    else:
        cmd = ["ping", "-c", "1", "-W", str(max(1, int(timeout_s))), ip]
    text = _run(cmd, timeout=timeout_s + 2)
    m = re.search(r"time[=<]([\d.]+)\s*ms", text)
    return float(m.group(1)) if m else None
