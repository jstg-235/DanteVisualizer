// The Monitor view and sidebar: Dante Monitor's dashboard inside Dante Visualizer.
//
// Reads /api/monitor/* from the same server as the diagram. It only shows things;
// the only settings it changes are the monitor's own (switch list, notifications).
// The diagram gets just three things from here, through onState: the problem count,
// and clock and IP badges for its blocks (state.badges).

import { routesMbps, deviceTraffic, mbpsText } from "./bandwidth.js";
import { fetchDropouts, clearDropouts, durText } from "./history.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sevLabel = { critical: "Problem", warning: "Warning", info: "Info", ok: "OK" };
const RANK = { critical: 3, warning: 2, info: 1, ok: 0 };

let mon = null;            // latest /api/monitor/state
let events = [];
let setup = null;
let available = null;      // does this server run the monitor?
let opts = {};
let tab = load("dv.monitor.tab", "overview");

function load(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, v); } catch {} }

function ago(ts) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m ago";
  return Math.floor(s / 86400) + "d ago";
}
const when = (ts) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

// ---------- shared bits ----------
function deviceLink(name) {
  return `<a href="#" class="dev-link" data-device="${esc(name)}" title="Show ${esc(name)} on the diagram">${esc(name)}</a>`;
}
function issueHtml(i, compact = false) {
  const devs = (i.devices || []).filter((d) => mon?.devices.some((x) => x.name === d) || opts.hasDevice?.(d));
  const subj = devs.length === 1 && devs[0] === i.subject ? deviceLink(i.subject) : esc(i.subject);
  const others = devs.filter((d) => d !== i.subject);
  return `<div class="m-issue"><span class="m-bar sev-${i.severity}"></span>
    <div class="m-issue-body"><div class="m-subj sev-text-${i.severity}">${subj}${i.source === "netaudio" ? ' <span class="m-tag">netaudio</span>' : ""}</div>
    <div>${esc(i.message)}</div>
    ${others.length ? `<div class="muted">Devices: ${others.map(deviceLink).join(", ")}</div>` : ""}
    ${!compact && i.fix ? `<div class="muted">${esc(i.fix)}</div>` : ""}</div>
    ${i.since ? `<span class="m-when">${ago(i.since)}</span>` : ""}</div>`;
}
function wireLinks(root) {
  root.querySelectorAll(".dev-link").forEach((a) => (a.onclick = (e) => { e.preventDefault(); opts.onSelectDevice?.(a.dataset.device); }));
}

function spark(vals) {
  const w = 120, h = 22, pts = (vals || []).slice(-24);
  if (!pts.length) return "";
  const nums = pts.filter((v) => v != null), max = Math.max(2, ...nums);
  const step = w / Math.max(1, pts.length - 1);
  let path = "", miss = "";
  pts.forEach((v, i) => {
    const x = (i * step).toFixed(1);
    if (v == null) miss += `<line x1="${x}" x2="${x}" y1="2" y2="${h}" class="spark-miss"/>`;
    else path += (path ? "L" : "M") + x + "," + (h - 2 - (v / max) * (h - 6)).toFixed(1);
  });
  return `<svg class="spark" width="${w}" height="${h}" aria-label="Ping times, last 2 minutes">${miss}<path d="${path}" class="spark-line"/></svg>`;
}

// ---------- tabs ----------
function renderOverview() {
  const el = $("m-issues");
  el.innerHTML = mon.issues.length ? mon.issues.map((i) => issueHtml(i)).join("") : `<div class="m-allgood">● Everything looks healthy</div>`;
  wireLinks(el);
  const d = mon.devices, online = d.filter((x) => x.online).length;
  const sw = mon.switches, swOk = sw.filter((s) => s.reachable).length;
  const portsUp = sw.reduce((n, s) => n + s.ports.filter((p) => p.up).length, 0);
  const lossy = d.filter((x) => x.ping_loss > 0).length;
  const act = mon.clock.v1_active || [];
  const leaderTxt = act.length > 1 ? `<span class="sev-text-critical">${act.length} leaders</span>` : esc(mon.leader || "—");
  $("m-tiles").innerHTML = [
    ["Devices online", `${online}<span class="muted small"> / ${d.length}</span>`, d.length ? (online === d.length ? "all present" : `${d.length - online} missing`) : "searching…"],
    ["Clock leader", leaderTxt, mon.clock.listening ? "listening to the clock" : mon.clock.error || "not listening"],
    ["Switches", `${swOk}<span class="muted small"> / ${sw.length}</span>`, sw.length ? `${portsUp} ports up` : "add one in Setup"],
    ["Ping trouble", lossy, lossy ? "devices dropping replies" : "no lost replies"],
  ].map(([k, v, s]) => `<div class="m-tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${esc(s)}</div></div>`).join("");
  $("m-recent").innerHTML = events.slice(0, 8).map(eventRow).join("") || `<tr><td class="m-empty">Nothing yet.</td></tr>`;
}

function renderDevices() {
  const rows = mon.devices;
  const el = $("m-devices");
  if (!rows.length) { el.innerHTML = `<tr><td colspan="9" class="m-empty">Looking for Dante devices…</td></tr>`; return; }
  el.innerHTML = rows.map((r) => {
    const st = r.online ? r.status : "critical";
    const port = r.port ? `${esc(r.port.switch)} <b class="mono">${esc(r.port.name)}</b>${r.port.speed_mbps && r.port.speed_mbps < 1000 ? ` <span class="sev-text-warning">${r.port.speed_mbps}M</span>` : ""}` : `<span class="muted">—</span>`;
    return `<tr><td><span class="m-dot sev-${st}"></span>${deviceLink(r.name)}${r.is_leader ? '<span class="m-badge leader">clock leader</span>' : ""}${r.online ? "" : '<span class="m-badge crit">offline</span>'}</td>
      <td>${esc(r.manufacturer)} ${esc(r.model)}</td><td class="mono">${esc(r.ip || "—")}</td><td class="mono">${esc(r.mac || "—")}</td><td>${port}</td>
      <td class="num">${r.rtt_ms != null ? r.rtt_ms.toFixed(2) + " ms" : "—"}</td><td>${spark(r.rtt_history)}</td>
      <td class="num ${r.ping_loss > 0 ? "sev-text-warning" : ""}">${r.ping_loss != null ? r.ping_loss + "%" : "—"}</td>
      <td class="mono">${r.rates.map((x) => x / 1000 + "k").join(", ") || "—"}</td></tr>`;
  }).join("");
  wireLinks(el);
}

function renderClock() {
  const c = mon.clock, act = c.v1_active || [];
  const leader = act[0];
  $("m-clock-tiles").innerHTML = [
    ["Leader", act.length > 1 ? `<span class="sev-text-critical">${act.length} competing</span>` : esc(leader ? leader.name : "none heard"), leader ? leader.source : ""],
    ["Sync interval", leader && leader.interval_ms ? leader.interval_ms + " ms" : "—", "how often the leader sends time"],
    ["Arrival jitter", leader && leader.jitter_ms != null ? leader.jitter_ms + " ms" : "—", "lower is better"],
    ["Followers heard", (c.followers || []).length, "devices checking in with the leader"],
  ].map(([k, v, s]) => `<div class="m-tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s mono">${esc(s)}</div></div>`).join("");
  const all = [...(c.v1_sources || []), ...(c.v2_sources || [])];
  $("m-clock-sources").innerHTML = all.length ? all.map((s) => {
    const live = s.age != null && s.age < 3;
    return `<tr><td><span class="m-dot sev-${live ? "ok" : "info"}"></span>${esc(s.name)}</td><td>v${s.version}${s.version === 2 ? " (AES67)" : ""}</td>
      <td class="mono">${esc(s.source)}</td><td class="num">${s.interval_ms ?? "—"} ms</td><td class="num">${s.jitter_ms ?? "—"} ms</td>
      <td class="num ${s.missed ? "sev-text-warning" : ""}">${s.missed}</td><td class="num ${s.late ? "sev-text-warning" : ""}">${s.late}</td>
      <td class="num">${live ? "now" : s.age != null ? Math.round(s.age) + "s ago" : "—"}</td></tr>`;
  }).join("") : `<tr><td colspan="8" class="m-empty">${esc(c.error || "No clock messages heard yet.")}</td></tr>`;
}

const recentErr = (p) => p.last_error_ts && Date.now() / 1000 - p.last_error_ts < 300;
const NEAR_CAPACITY = 0.7;    // estimated Dante traffic above this share of the link speed turns amber

// Estimated Dante traffic through each port of a switch, worked out from the routes:
// a device's port carries what it sends (into the switch) and what it receives (out of it).
// The uplink carries every flow between this switch's devices and devices elsewhere; that's
// only filled in when the switch has a single uplink, so it's clear which port it uses.
function expectedByPort(s) {
  const net = opts.getNetwork?.();
  const out = new Map();
  if (!net) return out;
  const traffic = deviceTraffic(net.model, net.routes);
  const here = new Set(mon.devices.filter((d) => d.port?.switch_id === s.id).map((d) => d.name));
  for (const p of s.ports) {
    if (p.device && traffic[p.device]) out.set(p.index, { in: traffic[p.device].out, out: traffic[p.device].in });
  }
  const uplinks = s.ports.filter((p) => p.uplink);
  if (uplinks.length === 1 && here.size) {
    const pairs = new Map();
    for (const r of net.routes) {
      if (r.failed || r.missing || here.has(r.srcDevice) === here.has(r.dstDevice)) continue;
      const k = r.srcDevice + "\u0000" + r.dstDevice;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k).push(r);
    }
    let up = 0, down = 0;
    for (const rs of pairs.values()) {
      const v = routesMbps(rs, net.model);
      if (here.has(rs[0].srcDevice)) up += v; else down += v;
    }
    out.set(uplinks[0].index, { in: down, out: up });
  }
  return out;
}
const nearCap = (e, p) => e && p.speed_mbps && Math.max(e.in, e.out) >= p.speed_mbps * NEAR_CAPACITY;

function renderSwitches() {
  const el = $("m-switches");
  if (!mon.switches.length) { el.innerHTML = `<div class="m-panel m-empty">No switches added yet. Add your Netgear or Luminex switches in Setup.</div>`; return; }
  el.innerHTML = mon.switches.map((s) => {
    const status = s.reachable === false ? `<span class="sev-text-critical">not answering</span>` : s.reachable ? `<span class="sev-text-ok">connected</span>` : `<span class="muted">connecting…</span>`;
    const exp = expectedByPort(s);
    const ports = s.ports.map((p) => {
      const cls = ["m-port", p.up ? "up" : "", recentErr(p) ? "err" : "", p.uplink ? "uplink" : "", p.up && p.speed_mbps && p.speed_mbps < 1000 ? "slow" : "", nearCap(exp.get(p.index), p) ? "near" : ""].join(" ");
      const tot = Object.entries(p.errors_total).filter(([, v]) => v).map(([k, v]) => `${k.replace("_", " ")}: ${v}`).join(", ");
      const tip = `${p.name}${p.alias ? " (" + p.alias + ")" : ""}\n${p.up ? "Up at " + p.speed_mbps + " Mb/s" : "Down"}${p.in_mbps != null ? `\nIn ${p.in_mbps} / Out ${p.out_mbps} Mb/s` : ""}${p.mcast_pps != null ? `\nMulticast ${p.mcast_pps} pkt/s` : ""}${p.device ? "\nDante: " + p.device : ""}${p.lldp ? "\nNeighbour: " + p.lldp : ""}${tot ? "\nErrors since start: " + tot : ""}`;
      return `<div class="${cls}" title="${esc(tip)}"><b>${esc(p.name)}</b><div class="dev">${esc(p.device || (p.uplink ? "uplink" : p.alias))}</div></div>`;
    }).join("");
    const load = (p) => Math.max(p.util_pct || 0, exp.get(p.index) && p.speed_mbps ? (100 * Math.max(exp.get(p.index).in, exp.get(p.index).out)) / p.speed_mbps : 0);
    const busy = s.ports.filter((p) => p.up).sort((a, b) => load(b) - load(a)).slice(0, 12);
    const rows = busy.map((p) => {
      const e = exp.get(p.index);
      const est = e ? `<td class="num ${nearCap(e, p) ? "sev-text-warning" : ""}">${mbpsText(e.in).replace(" Mb/s", "")} / ${mbpsText(e.out).replace(" Mb/s", "")}${nearCap(e, p) ? ` <span class="m-badge warn">near capacity</span>` : ""}</td>` : `<td class="num muted">—</td>`;
      return `<tr><td class="mono">${esc(p.name)}</td><td>${esc(p.device || p.alias || (p.uplink ? "uplink" : ""))}</td>
      <td class="num">${p.speed_mbps}</td>${est}<td class="num">${p.in_mbps ?? "—"}</td><td class="num">${p.out_mbps ?? "—"}</td>
      <td class="num ${p.util_pct >= 70 ? "sev-text-warning" : ""}">${p.util_pct ?? "—"}%</td><td class="num">${p.mcast_pps ?? "—"}</td>
      <td class="num ${Object.values(p.errors_total).some((v) => v) ? "sev-text-critical" : ""}">${Object.values(p.errors_total).reduce((a, b) => a + b, 0)}</td></tr>`;
    }).join("");
    return `<div class="m-panel m-gap">
      <div class="m-swhead"><span class="t">${esc(s.label)}</span><span class="muted">${esc(s.type_label)} · <span class="mono">${esc(s.ip)}</span></span><span>${status}</span><span class="muted m-right">${esc(s.sys?.descr || "")}</span></div>
      ${s.reachable === false ? `<p class="m-hint">${esc(s.error || "")}<br>${esc(s.setup)}</p>` : ""}
      <div class="m-ports">${ports}</div>
      <div class="m-legend"><span class="l-up">up</span><span class="l-down">down</span><span class="l-err">errors (last 5 min)</span><span class="l-slow">below 1 Gb/s</span><span class="l-uplink">uplink</span><span class="l-near">Dante traffic near capacity</span></div>
      ${rows ? `<div class="m-scroll"><table><thead><tr><th>Port</th><th>Connected to</th><th class="num">Speed</th><th class="num" title="Estimated from the routes: in to the switch / out of it">Dante est. in / out</th><th class="num">In Mb/s</th><th class="num">Out Mb/s</th><th class="num">Busy</th><th class="num">Multicast/s</th><th class="num">Errors</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    </div>`;
  }).join("");
}

// ---------- cables: the physical view ----------
// Each switch is a long block with its ports along the top. Every Dante device sits above
// the port it's plugged into, joined by its cable. A cable with no link is red, one with
// recent errors amber, a link under 1 Gb/s is labelled, and the busier the port the
// thicker the cable. Switches that see each other over LLDP are joined by their uplink.
function renderCables() {
  const el = $("m-cables");
  const sws = mon.switches;
  if (!sws.length) {
    el.innerHTML = `<div class="m-panel m-empty">Add your switches in Setup to see which port each device is plugged into.</div>`;
    return;
  }
  const PW = 30, GAP = 6, DEVW = 142, DEVH = 38, ROWH = 250, LEFT = 30;
  const svgParts = [];
  const portX = new Map();     // "swid:index" -> x centre
  const swBox = new Map();
  let y = 30, width = 600;
  const placed = new Set();
  sws.forEach((s, si) => {
    // Ports worth drawing: anything up, anything with a device, and uplinks.
    const ports = s.ports.filter((p) => p.up || p.device || p.uplink);
    const devPorts = ports.filter((p) => p.device);
    const slotW = Math.max(PW + GAP, DEVW + 14);
    const w = Math.max(240, ports.length * (PW + GAP) + 40, devPorts.length * slotW + 40);
    width = Math.max(width, w + LEFT * 2);
    const top = y + DEVH + 70;   // switch block top
    swBox.set(s.id, { x: LEFT, y: top, w, label: s.label, sys: s.sys?.name || "" });
    svgParts.push(`<g class="c-switch${s.reachable === false ? " down" : ""}"><rect x="${LEFT}" y="${top}" width="${w}" height="62" rx="8"/>
      <text x="${LEFT + 12}" y="${top + 52}" class="c-swname">${esc(s.label)}</text>
      <text x="${LEFT + w - 12}" y="${top + 52}" class="c-swsub" text-anchor="end">${esc(s.type_label)} · ${esc(s.ip)}${s.reachable === false ? " · not answering" : ""}</text></g>`);
    // Ports along the top edge, spread evenly.
    const step = ports.length > 1 ? (w - 40 - PW) / (ports.length - 1) : 0;
    ports.forEach((p, i) => {
      const x = LEFT + 20 + i * Math.min(step, PW + GAP + 30);
      portX.set(`${s.id}:${p.index}`, x + PW / 2);
      const cls = ["c-port", p.up ? "up" : "down", recentErr(p) ? "err" : "", p.uplink ? "uplink" : ""].join(" ");
      svgParts.push(`<g class="${cls}"><title>${esc(`${p.name}${p.alias ? " (" + p.alias + ")" : ""} · ${p.up ? p.speed_mbps + " Mb/s" : "no link"}${p.util_pct != null ? " · " + p.util_pct + "% busy" : ""}${p.lldp ? "\nNeighbour: " + p.lldp : ""}`)}</title>
        <rect x="${x}" y="${top + 8}" width="${PW}" height="22" rx="3"/><text x="${x + PW / 2}" y="${top + 23}" text-anchor="middle">${esc(p.name.length > 4 ? p.name.slice(-4) : p.name)}</text></g>`);
    });
    // Devices above their ports; spread them so their boxes don't overlap.
    const devs = mon.devices.filter((d) => d.port && d.port.switch_id === s.id)
      .sort((a, b) => (portX.get(`${s.id}:${a.port.index}`) || 0) - (portX.get(`${s.id}:${b.port.index}`) || 0));
    let nextFree = LEFT;
    devs.forEach((d) => {
      const px = portX.get(`${s.id}:${d.port.index}`) ?? LEFT + 20;
      const dx = Math.max(nextFree, px - DEVW / 2);
      nextFree = dx + DEVW + 10;
      width = Math.max(width, nextFree + LEFT);
      const p = d.port;
      const util = p.util_pct || 0;
      const sw = 1.5 + Math.min(8, util / 8);
      const cls = !p.up || !d.online ? "dead" : recentErr(p) ? "errs" : "ok";
      const cx = dx + DEVW / 2, cy = y + DEVH;
      const py = top + 8;
      svgParts.push(`<path class="c-cable ${cls}" d="M${cx},${cy} C${cx},${cy + 40} ${px},${py - 40} ${px},${py}" stroke-width="${sw}"><title>${esc(`${d.name} → ${p.where}\n${p.up ? `Link up at ${p.speed_mbps} Mb/s` : "No link: unplugged, powered off or bad cable"}${util ? ` · ${util}% busy` : ""}${recentErr(p) ? "\nErrors in the last 5 minutes" : ""}`)}</title></path>`);
      if (p.up && p.speed_mbps && p.speed_mbps < 1000) {
        svgParts.push(`<text class="c-speed" x="${(cx + px) / 2 + 10}" y="${(cy + py) / 2 + 4}">${p.speed_mbps} Mb/s</text>`);
      }
      const st = d.online ? d.status : "critical";
      svgParts.push(`<g class="c-dev sev-${st}" data-device="${esc(d.name)}"><title>${esc(`${d.name}\n${d.manufacturer || ""} ${d.model || ""}\n${d.ip || ""}${d.is_leader ? "\nClock leader" : ""}\nClick to show on the diagram`)}</title>
        <rect x="${dx}" y="${y}" width="${DEVW}" height="${DEVH}" rx="6"/><circle cx="${dx + 11}" cy="${y + 13}" r="4" class="c-led"/>
        <text x="${dx + 20}" y="${y + 17}" class="c-devname">${esc(d.name.length > 17 ? d.name.slice(0, 16) + "…" : d.name)}</text>
        <text x="${dx + 10}" y="${y + 31}" class="c-devsub">${esc(d.ip || "")}${d.is_leader ? " · clock leader" : ""}</text></g>`);
      placed.add(d.name);
    });
    y = top + 62 + 60;
  });
  // Switch-to-switch links from LLDP: an uplink port whose neighbour names another switch.
  for (const s of sws) {
    for (const p of s.ports) {
      if (!p.lldp) continue;
      const other = sws.find((o) => o.id !== s.id && (p.lldp.startsWith(o.label) || (o.sys?.name && p.lldp.startsWith(o.sys.name))));
      if (!other || sws.indexOf(other) < sws.indexOf(s)) continue;
      const a = swBox.get(s.id), b = swBox.get(other.id);
      svgParts.push(`<path class="c-trunk${p.up ? "" : " dead"}" d="M${a.x + a.w},${a.y + 31} C${a.x + a.w + 50},${a.y + 31} ${b.x + b.w + 50},${b.y + 31} ${b.x + b.w},${b.y + 31}"><title>${esc(`${s.label} port ${p.name} ↔ ${p.lldp}`)}</title></path>`);
      width = Math.max(width, a.x + a.w + 70);
    }
  }
  const unplaced = mon.devices.filter((d) => !placed.has(d.name));
  el.innerHTML = `<div class="m-panel"><div class="m-scroll"><svg class="c-svg" width="${width}" height="${y}" viewBox="0 0 ${width} ${y}">${svgParts.join("")}</svg></div>
    <div class="m-legend"><span class="l-cable-ok">cable OK (thicker = busier)</span><span class="l-cable-err">errors in the last 5 min</span><span class="l-cable-dead">no link or device offline</span></div></div>
    ${unplaced.length ? `<h3 class="m-h">Not found on a switch</h3><div class="m-panel m-hint">${unplaced.map((d) => deviceLink(d.name)).join(", ")}<br>
      <span class="muted">The switch hasn't learned these devices' addresses yet, or they're on a switch that isn't added in Setup.</span></div>` : ""}`;
  el.querySelectorAll(".c-dev").forEach((g) => (g.onclick = () => opts.onSelectDevice?.(g.dataset.device)));
  wireLinks(el);
}

// ---------- dropouts ----------
let dropouts = null;
async function refreshDropouts() {
  try { dropouts = await fetchDropouts(); } catch { dropouts = { missing: true }; }
  if (tab === "dropouts" && !$("monitor").hidden) renderDropouts();
}
function renderDropouts() {
  const body = $("m-dropouts");
  if (!dropouts) { body.innerHTML = `<tr><td colspan="4" class="m-empty">Loading…</td></tr>`; return; }
  if (dropouts.missing) { body.innerHTML = `<tr><td colspan="4" class="m-empty">This server doesn't keep level history.</td></tr>`; return; }
  const list = dropouts.dropouts || [];
  $("m-drop-meta").textContent = dropouts.recording ? "Watching levels now" : "Not watching: levels are off or the diagram is offline";
  const r = dropouts.rules || {};
  $("m-drop-hint").textContent = `A dropout is a routed channel that had signal, went silent (below ${r.signalDb ?? -60} dBFS) for ${r.min ?? 2} to ${r.max ?? 60} seconds, then came back. ` +
    "Longer silences are taken as intentional. \"Lost on the way\" means an input went silent while its source kept sending. The list is kept until the app quits.";
  body.innerHTML = list.length ? list.map((d) => {
    const ch = `${deviceLink(d.device)} ${d.side === "tx" ? "out" : "in"} ${d.ch}`;
    const what = d.side === "tx" ? "The source went silent"
      : d.sourceKeptSending ? `<span class="sev-text-warning">Lost on the way</span>: ${esc(d.source.device)} out ${d.source.ch ?? "?"} kept sending`
      : `Input went silent <span class="muted">(from ${esc(d.source?.device)} out ${d.source?.ch ?? "?"})</span>`;
    return `<tr><td class="time mono muted">${when(d.t)}</td><td class="num">${durText(d.seconds)}</td><td>${ch}</td><td>${what}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="m-empty">No dropouts${dropouts.recording ? " so far" : ""}.</td></tr>`;
  wireLinks(body);
}

function eventRow(e) {
  return `<tr><td class="time mono muted">${when(e.ts)}</td><td class="sev"><span class="m-dot sev-${e.severity}"></span>${sevLabel[e.severity] || e.severity}</td>
    <td><b>${esc(e.subject)}</b></td><td>${esc(e.message)}</td></tr>`;
}
function renderHistory() {
  const f = $("m-sev").value, q = $("m-search").value.toLowerCase();
  const list = events.filter((e) => (!f || RANK[e.severity] >= RANK[f]) && (!q || (e.subject + " " + e.message).toLowerCase().includes(q)));
  $("m-history").innerHTML = list.map(eventRow).join("") || `<tr><td colspan="4" class="m-empty">No matching events.</td></tr>`;
}

async function loadSetup() {
  try { setup = await (await fetch("api/monitor/setup", { cache: "no-store" })).json(); } catch { return; }
  $("m-iface").textContent = setup.demo ? "Demo network" : setup.interface || "not found yet";
  $("m-notif").checked = !!setup.notifications;
  $("m-swtype").innerHTML = Object.entries(setup.switch_types).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  swTypeChanged();
  const st = Object.fromEntries((mon?.switches || []).map((s) => [s.id, s]));
  $("m-swlist").innerHTML = setup.switches.map((s) => {
    const live = st[s.id];
    const status = !live ? "—" : live.reachable === false ? `<span class="sev-text-critical">not answering</span>` : live.reachable ? `<span class="sev-text-ok">connected</span>` : "connecting…";
    return `<tr><td>${esc(s.name || "—")}</td><td>${esc(setup.switch_types[s.type]?.label || s.type)}</td><td class="mono">${esc(s.ip)}</td><td>${status}</td>
      <td class="num"><button data-remove="${esc(s.id)}">Remove</button></td></tr>`;
  }).join("") || `<tr><td colspan="5" class="m-empty">No switches yet.</td></tr>`;
  document.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Stop monitoring this switch?")) return;
    await post("api/monitor/switches/remove", { id: b.dataset.remove });
    await refresh();
    loadSetup();
  }));
}
function swTypeChanged() {
  const t = setup?.switch_types[$("m-swtype").value];
  if (!t) return;
  $("m-swcomm").value = t.community;
  $("m-swsetup").textContent = "Before adding: " + t.setup;
}
const swForm = () => ({ type: $("m-swtype").value, ip: $("m-swip").value.trim(), name: $("m-swname").value.trim(), community: $("m-swcomm").value.trim() });

// ---------- sidebar ----------
function renderSidebar() {
  const el = $("m-side-body");
  const act = mon.clock.v1_active || [];
  const clock = act.length > 1
    ? `<span class="sev-text-critical">${act.length} devices acting as leader</span>`
    : mon.leader ? `⏱ ${deviceLink(mon.leader)}` : `<span class="muted">${esc(mon.clock.error || "No leader heard yet")}</span>`;
  const online = mon.devices.filter((d) => d.online).length;
  el.innerHTML = `<p class="m-side-line"><b>Clock leader</b><br>${clock}</p>
    <p class="m-side-line"><b>Devices</b><br>${online} of ${mon.devices.length} online</p>
    <h3>Problems</h3>
    ${mon.issues.length ? mon.issues.map((i) => issueHtml(i, true)).join("") : `<div class="m-allgood">● Everything looks healthy</div>`}`;
  wireLinks(el);
}

// ---------- refresh ----------
function renderAll() {
  if (!mon) return;
  $("m-demo").hidden = !mon.demo;
  const up = mon.uptime;
  $("m-meta").textContent = `monitoring ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m · ${mon.interface_ip || "all ports"}${mon.netaudio === false ? " · netaudio issues unavailable" : ""}`;
  const n = mon.issues.length;
  const c = $("m-tab-count");
  c.hidden = !n;
  c.textContent = n;
  const visible = !$("monitor").hidden;
  if (visible) {
    ({ overview: renderOverview, devices: renderDevices, clock: renderClock, switches: renderSwitches, cables: renderCables, history: renderHistory, dropouts: renderDropouts }[tab] || (() => {}))();
  }
  if (!$("m-side").hidden) renderSidebar();
}

async function refresh() {
  try {
    const r = await fetch("api/monitor/state", { cache: "no-store" });
    if (r.status === 404) { setAvailable(false); return; }
    if (!r.ok) throw new Error(r.statusText);
    mon = await r.json();
    setAvailable(true);
    renderAll();
    opts.onState?.(mon);
  } catch {
    if (available) $("m-meta").textContent = "Lost connection to the monitor";
  }
}
async function refreshEvents() {
  if (!available) return;
  try { events = await (await fetch("api/monitor/events?limit=500", { cache: "no-store" })).json(); } catch { return; }
  if (!$("monitor").hidden && (tab === "history" || tab === "overview")) renderAll();
}

function setAvailable(yes) {
  if (available === yes) return;
  available = yes;
  document.body.classList.toggle("has-monitor", yes);
  opts.onAvailable?.(yes);
}

function showTab(t) {
  tab = t;
  save("dv.monitor.tab", t);
  document.querySelectorAll("#m-nav button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === t)));
  document.querySelectorAll(".m-tab").forEach((s) => (s.hidden = s.id !== "m-tab-" + t));
  if (t === "setup") loadSetup();
  if (t === "dropouts") refreshDropouts();
  renderAll();
}

export function showMonitorTab(t) { showTab(t); }
export function monitorRendered() { renderAll(); }
export function toggleSidebar(open = $("m-side").hidden) {
  $("m-side").hidden = !open;
  save("dv.monitor.sidebar", open ? "1" : "0");
  if (open && mon) renderSidebar();
  opts.onSidebar?.(open);
}

export function initMonitor(o) {
  opts = o;
  document.querySelectorAll("#m-nav button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("m-sev").onchange = renderHistory;
  $("m-search").oninput = renderHistory;
  $("m-clear").onclick = async () => { if (confirm("Delete all saved monitor history?")) { await post("api/monitor/events/clear", {}); refreshEvents(); } };
  $("m-swtype").onchange = swTypeChanged;
  $("m-notif").onchange = async () => {
    const r = await post("api/monitor/notifications", { on: $("m-notif").checked });
    $("m-notif").checked = !!r.notifications;
  };
  $("m-swtest").onclick = async () => {
    const f = swForm();
    if (!f.ip) { $("m-swresult").innerHTML = `<span class="sev-text-warning">Enter the switch's IP address first.</span>`; return; }
    $("m-swresult").textContent = "Testing…";
    const r = await post("api/monitor/switches/test", f);
    $("m-swresult").innerHTML = r.ok ? `<span class="sev-text-ok">Connected: ${esc(r.name)} — ${esc(r.descr)}</span>` : `<span class="sev-text-critical">${esc(r.error)}</span><br><span class="muted">${esc(r.setup)}</span>`;
  };
  $("m-swadd").onclick = async () => {
    const f = swForm();
    if (!f.ip) { $("m-swresult").innerHTML = `<span class="sev-text-warning">Enter the switch's IP address first.</span>`; return; }
    const r = await post("api/monitor/switches/add", f);
    $("m-swresult").innerHTML = r.ok ? `<span class="sev-text-ok">Added. It appears on the Switches and Cables tabs within a few seconds.</span>` : `<span class="sev-text-critical">${esc(r.error)}</span>`;
    $("m-swip").value = "";
    $("m-swname").value = "";
    await refresh();
    loadSetup();
  };
  $("m-side-close").onclick = () => toggleSidebar(false);
  $("m-side-open").onclick = () => opts.onOpenView?.();
  showTab(tab);
  if (load("dv.monitor.sidebar", "0") === "1") $("m-side").hidden = false;
  refresh();
  refreshEvents();
  setInterval(refresh, 2000);
  setInterval(refreshEvents, 5000);
  setInterval(() => { if (tab === "dropouts" && !$("monitor").hidden) refreshDropouts(); }, 3000);
  $("m-drop-clear").onclick = async () => { await clearDropouts(); refreshDropouts(); };
}

export const monitorState = () => mon;
