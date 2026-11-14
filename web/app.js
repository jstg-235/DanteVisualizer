import { parsePresetXml, buildRoutes, rangeText } from "./model.js";
import { initMonitor, toggleSidebar, showMonitorTab, monitorRendered, monitorState } from "./monitor.js";
import { routesMbps, deviceTraffic, mbpsText } from "./bandwidth.js";
import { mountHistory, closeHistory } from "./history.js";

// ---------- geometry ----------
const W = 250;          // block width
const HEADER = 48;      // block header height
const ROW = 16;         // channel row height when expanded
const SUMMARY = 52;     // collapsed body height
const SVGNS = "http://www.w3.org/2000/svg";

const PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6"];

// ---------- state ----------
const state = {
  model: null,
  routes: [],
  mode: load("dv.mode", "network"),      // "network" | "flow"
  expanded: new Set(),
  positions: {},                          // per mode: { nodeId: {x, y} }
  view: { x: 40, y: 40, k: 1 },
  selected: null,                         // node id
  hoverRoute: null,
  trace: null,           // what was clicked: {kind:'channel',device,side,ch} | {kind:'route',id} | {kind:'bundle',key}
  colors: new Map(),
  levels: null,                           // { device: { tx: [dB|null], rx: [dB|null], age } }
  badges: {},                             // from the monitor: { device: [{ kind: "clock"|"ip", severity, text }] }
  view$: "diagram",                       // "diagram" | "monitor"
  bandwidth: load("dv.bandwidth", false),  // show estimated Mb/s on the wires
};

// Elements that show signal, collected on each render and updated in place
// whenever new levels arrive (several times a second), without a full redraw.
const live = { dots: [], wires: [], bundles: [], counts: [] };

const svg = document.getElementById("canvas");
const viewport = document.getElementById("viewport");
const wiresLayer = document.getElementById("wires");
const labelsLayer = document.getElementById("labels");
const nodesLayer = document.getElementById("nodes");
const tooltip = document.getElementById("tooltip");
const panel = document.getElementById("panel");

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
const layoutKey = () => `dv.layout.${state.model?.name || "net"}`;

// ---------- nodes ----------
// Network view: one block per device with inputs on the left and outputs on the right.
// Signal flow view: each device is split into an "outputs" block (left column)
// and an "inputs" block (right column), so every wire runs left to right.
function nodes() {
  const out = [];
  for (const d of state.model.devices) {
    if (state.mode === "network") {
      out.push({ id: d.name, device: d, rx: true, tx: true });
    } else {
      if (d.tx.length) out.push({ id: `${d.name}::tx`, device: d, rx: false, tx: true });
      if (d.rx.length) out.push({ id: `${d.name}::rx`, device: d, rx: true, tx: false });
    }
  }
  return out;
}
const nodeIdFor = (deviceName, side) => (state.mode === "network" ? deviceName : `${deviceName}::${side}`);

function nodeHeight(n) {
  if (!state.expanded.has(n.id)) return HEADER + SUMMARY;
  const rows = Math.max(n.rx ? n.device.rx.length : 0, n.tx ? n.device.tx.length : 0, 1);
  return HEADER + rows * ROW + 8;
}

function portPos(n, side, channelId) {
  const p = state.positions[state.mode][n.id];
  const x = side === "rx" ? p.x : p.x + W;
  if (!state.expanded.has(n.id)) return { x, y: p.y + HEADER + SUMMARY / 2 };
  const list = side === "rx" ? n.device.rx : n.device.tx;
  const idx = Math.max(0, list.findIndex((c) => c.id === channelId));
  return { x, y: p.y + HEADER + idx * ROW + ROW / 2 + 4 };
}

// ---------- auto layout ----------
function autoLayout() {
  const ns = nodes();
  const pos = {};
  const gapY = 50, colGap = 340;
  const stack = (list, x) => {
    const total = list.reduce((s, n) => s + nodeHeight(n) + gapY, -gapY);
    let y = -total / 2;
    for (const n of list) { pos[n.id] = { x, y }; y += nodeHeight(n) + gapY; }
  };

  if (state.mode === "flow") {
    const order = deviceOrder();
    const txs = ns.filter((n) => n.tx).sort((a, b) => order(a) - order(b));
    const rxs = ns.filter((n) => n.rx).sort((a, b) => order(a) - order(b));
    stack(txs, 0);
    stack(rxs, W + colGap + 120);
  } else {
    // Put the busiest device (the hub) in the middle. Devices that mostly feed it go left,
    // devices it mostly feeds go right; ties alternate to keep the columns balanced.
    const totals = new Map(ns.map((n) => [n.id, 0]));
    for (const r of state.routes) {
      if (totals.has(r.srcDevice)) totals.set(r.srcDevice, totals.get(r.srcDevice) + 1);
      totals.set(r.dstDevice, totals.get(r.dstDevice) + 1);
    }
    const hub = [...ns].sort((a, b) => totals.get(b.id) - totals.get(a.id))[0];
    const left = [], right = [];
    const others = ns.filter((n) => n !== hub).sort((a, b) => totals.get(b.id) - totals.get(a.id));
    for (const n of others) {
      const toHub = state.routes.filter((r) => r.srcDevice === n.id && r.dstDevice === hub.id).length;
      const fromHub = state.routes.filter((r) => r.srcDevice === hub.id && r.dstDevice === n.id).length;
      if (toHub > fromHub) left.push(n);
      else if (fromHub > toHub) right.push(n);
      else (left.length <= right.length ? left : right).push(n);
    }
    stack(left, 0);
    stack([hub], W + colGap);
    stack(right, 2 * (W + colGap));
  }
  state.positions[state.mode] = pos;
  persistLayout();
}

// Order devices so the busiest is first; used by the signal flow view.
function deviceOrder() {
  const counts = new Map();
  for (const r of state.routes) {
    counts.set(r.srcDevice, (counts.get(r.srcDevice) || 0) + 1);
    counts.set(r.dstDevice, (counts.get(r.dstDevice) || 0) + 1);
  }
  const names = state.model.devices.map((d) => d.name).sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
  return (n) => names.indexOf(n.device.name);
}

// Open or close a block's channel list. Blocks below it in the same column move
// down (or back up) by the change in height so nothing ends up hidden underneath.
function toggleExpanded(id, open = !state.expanded.has(id)) {
  if (open === state.expanded.has(id)) return;
  const n = nodes().find((x) => x.id === id);
  const pos = state.positions[state.mode];
  if (!n || !pos?.[id]) { open ? state.expanded.add(id) : state.expanded.delete(id); return; }
  const before = nodeHeight(n);
  open ? state.expanded.add(id) : state.expanded.delete(id);
  const delta = nodeHeight(n) - before;
  const p = pos[id];
  for (const [otherId, q] of Object.entries(pos)) {
    if (otherId === id) continue;
    const overlapsX = q.x < p.x + W && q.x + W > p.x;
    if (overlapsX && q.y >= p.y + Math.min(before, before + delta) - 1) q.y += delta;
  }
}

function persistLayout() {
  save(layoutKey(), { positions: state.positions, expanded: [...state.expanded] });
}

// ---------- rendering ----------
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// A wire from an output port (a) to an input port (b). When the input is to the left
// of the output (signal going "backwards"), loop underneath both blocks in its own lane
// instead of cutting across them.
function curve(a, b, laneY) {
  if (b.x >= a.x + 40 || laneY == null) {
    const dx = Math.max(70, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }
  const r = 60;
  return `M${a.x},${a.y} C${a.x + r},${a.y} ${a.x + r},${laneY} ${a.x},${laneY} L${b.x},${laneY} C${b.x - r},${laneY} ${b.x - r},${b.y} ${b.x},${b.y}`;
}
const isBackward = (a, b) => b.x < a.x + 40;

function nodeBottom(n) { return state.positions[state.mode][n.id].y + nodeHeight(n); }
// Lowest edge of any block between two x positions, so a looping wire passes under all of them.
function floorBetween(ns, x0, x1) {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  let y = -Infinity;
  for (const n of ns) {
    const p = state.positions[state.mode][n.id];
    if (p.x + W >= lo - 70 && p.x <= hi + 70) y = Math.max(y, p.y + nodeHeight(n));
  }
  return y;
}

// Put a bundle label on the path where it doesn't sit on top of another label.
// Labels are about 20 px tall and `w` wide, so two clash when they're closer than that.
function placeLabel(path, placed, w = 60) {
  const len = path.getTotalLength();
  const clear = (p) => placed.every((q) => Math.abs(q.x - p.x) > (q.w + w) / 2 + 4 || Math.abs(q.y - p.y) > 24);
  for (const t of [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8, 0.12, 0.88]) {
    const p = path.getPointAtLength(len * t);
    if (clear(p)) { placed.push({ x: p.x, y: p.y, w }); return p; }
  }
  const p = path.getPointAtLength(len * 0.5);
  placed.push({ x: p.x, y: p.y, w });
  return p;
}
const labelWidth = (text) => text.length * 7.2 + 16;

function render() {
  if (!state.model) return;
  const ns = nodes();
  const byId = new Map(ns.map((n) => [n.id, n]));
  // Make sure every node has a position (new devices land below the others).
  const pos = state.positions[state.mode] || (state.positions[state.mode] = {});
  if (ns.some((n) => !pos[n.id])) {
    if (Object.keys(pos).length === 0) autoLayout();
    else {
      let maxY = Math.max(0, ...Object.values(pos).map((p) => p.y + 200));
      for (const n of ns) if (!pos[n.id]) { pos[n.id] = { x: 0, y: maxY }; maxY += nodeHeight(n) + 50; }
    }
  }

  wiresLayer.replaceChildren();
  labelsLayer.replaceChildren();
  live.dots = []; live.wires = []; live.bundles = []; live.counts = [];
  const placed = [];
  let lane = 0;
  nodesLayer.replaceChildren();
  const sel = state.selected;
  const selDevice = sel ? byId.get(sel)?.device.name : null;
  const related = (r) => !selDevice || r.srcDevice === selDevice || r.dstDevice === selDevice;
  // A click on a channel, wire or bundle traces those routes: they light up, the rest fade.
  const traced = tracedRoutes();
  const tracing = !!traced;
  const isTraced = (r) => traced?.has(r.id);
  live.ends = tracing ? endsOf(traced) : null;

  // Group routes by block pair so collapsed blocks get one thick bundle.
  const groups = new Map();
  for (const r of state.routes) {
    const dstNode = byId.get(nodeIdFor(r.dstDevice, "rx"));
    const srcNode = r.missing ? null : byId.get(nodeIdFor(r.srcDevice, "tx"));
    if (!dstNode) continue;
    const key = `${srcNode ? srcNode.id : "?" + r.srcDevice}=>${dstNode.id}`;
    if (!groups.has(key)) groups.set(key, { srcNode, dstNode, routes: [], srcName: r.srcDevice });
    groups.get(key).routes.push(r);
  }

  for (const g of groups.values()) {
    const color = state.colors.get(g.srcName) || "#888";
    const dim = tracing ? !g.routes.some(isTraced) : selDevice && !g.routes.some(related);
    const lit = tracing && g.routes.some(isTraced);
    const key = `${g.srcNode ? g.srcNode.id : "?" + g.srcName}=>${g.dstNode.id}`;
    if (!g.srcNode) {
      // Subscribed to a device that isn't on the network right now.
      const b = portPos(g.dstNode, "rx", g.routes[0].dstChannel);
      const a = { x: b.x - 90, y: b.y };
      const stub = el("path", { d: `M${a.x},${a.y} L${b.x},${b.y}`, class: "wire missing" + (dim ? " dim" : "") + (lit ? " traced" : "") }, wiresLayer);
      clickable(stub, { kind: "bundle", key }, a, b, null);
      const t = el("text", { x: a.x - 6, y: a.y + 4, class: "wire-label missing-label", "text-anchor": "end" }, wiresLayer);
      t.textContent = `${g.srcName} (not found) · ${g.routes.length} ch`;
      continue;
    }
    const bothCollapsed = !state.expanded.has(g.srcNode.id) && !state.expanded.has(g.dstNode.id);
    if (bothCollapsed) {
      const a = portPos(g.srcNode, "tx"), b = portPos(g.dstNode, "rx");
      // With bandwidth on, the thickness follows the estimated Mb/s instead of the channel count.
      const bw = state.bandwidth ? routesMbps(g.routes, state.model) : null;
      const width = bw != null ? 1.5 + Math.log2(1 + bw) * 1.5 : 2 + Math.log2(g.routes.length) * 1.6;
      const laneY = isBackward(a, b) ? floorBetween(ns, a.x, b.x) + 40 + 26 * lane++ : null;
      const failed = g.routes.filter((r) => r.failed).length;
      const d = curve(a, b, laneY);
      const path = el("path", { d, class: "wire bundle" + (dim ? " dim" : "") + (lit ? " traced" : "") + (failed ? " failed" : ""), stroke: color, "stroke-width": width }, wiresLayer);
      clickable(path, { kind: "bundle", key }, null, null, d, Math.max(12, width + 6));
      const bwText = bw != null ? ` · ${mbpsText(bw)}` : "";
      const mid = placeLabel(path, placed, labelWidth(`${g.routes.length}/${g.routes.length} live` + bwText + (failed ? ` · ${failed} failed` : "")));
      const label = el("g", { class: "bundle-label" + (dim ? " dim" : "") + (lit ? " traced" : "") + (failed ? " failed" : ""), transform: `translate(${mid.x},${mid.y})` }, labelsLayer);
      const text = `${g.routes.length} ch` + bwText + (failed ? ` · ${failed} failed` : "");
      el("rect", { x: -(text.length * 3.6 + 8), y: -10, width: text.length * 7.2 + 16, height: 20, rx: 10, stroke: color }, label);
      const t = el("text", { x: 0, y: 4, "text-anchor": "middle" }, label);
      t.textContent = text;
      clickable(label, { kind: "bundle", key });
      live.bundles.push({ path, label, text: t, rect: label.firstChild, routes: g.routes, total: g.routes.length, failed, bwText });
    } else {
      const laneBase = floorBetween(ns, portPos(g.srcNode, "tx").x, portPos(g.dstNode, "rx").x) + 40 + 26 * lane;
      let usedLane = false;
      const groupPaths = [];
      for (const r of g.routes) {
        const a = portPos(g.srcNode, "tx", r.srcChannel), b = portPos(g.dstNode, "rx", r.dstChannel);
        const back = isBackward(a, b);
        usedLane ||= back;
        const hot = state.hoverRoute === r.id;
        const d = curve(a, b, back ? laneBase : null);
        const faded = tracing ? !isTraced(r) : dim && !related(r);
        const path = el("path", { d, class: "wire single" + (faded ? " dim" : "") + (isTraced(r) ? " traced" : "") + (hot ? " hot" : "") + (r.failed ? " failed" : ""), stroke: color }, wiresLayer);
        clickable(path, { kind: "route", id: r.id }, null, null, d, 10);
        live.wires.push({ path, route: r });
        groupPaths.push(path);
      }
      if (usedLane) lane++;
      // Bandwidth on: one label per device pair, on the middle wire of the group.
      if (state.bandwidth) {
        const mid = groupPaths[Math.floor(groupPaths.length / 2)];
        if (mid) {
          const text = mbpsText(routesMbps(g.routes, state.model));
          const p = placeLabel(mid, placed, labelWidth(text));
          const label = el("g", { class: "bundle-label bw-label" + (dim ? " dim" : "") + (lit ? " traced" : ""), transform: `translate(${p.x},${p.y})` }, labelsLayer);
          el("rect", { x: -(text.length * 3.6 + 8), y: -10, width: text.length * 7.2 + 16, height: 20, rx: 10, stroke: color }, label);
          el("text", { x: 0, y: 4, "text-anchor": "middle" }, label).textContent = text;
          clickable(label, { kind: "bundle", key });
        }
      }
    }
  }

  for (const n of ns) drawNode(n, groups);
  applyLevels();
  updateExpandButton();
  viewport.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
  renderPanel(byId);
  updateTraceCard();
}

function drawNode(n, groups) {
  const p = state.positions[state.mode][n.id];
  const h = nodeHeight(n);
  const d = n.device;
  const color = state.colors.get(d.name);
  const expanded = state.expanded.has(n.id);
  const g = el("g", { class: "node" + (d.online ? "" : " offline") + (state.selected === n.id ? " selected" : ""), transform: `translate(${p.x},${p.y})`, "data-id": n.id }, nodesLayer);
  el("rect", { class: "body", width: W, height: h, rx: 10 }, g);
  el("rect", { class: "accent", width: 6, height: h, rx: 3, fill: color }, g);
  const header = el("g", { class: "header" }, g);
  el("rect", { class: "header-hit", width: W, height: HEADER, rx: 10 }, header);
  const title = el("text", { x: 16, y: 20, class: "title" }, header);
  title.textContent = shorten(d.name, (state.badges[d.name] || []).length ? 17 : 25);
  const sub = el("text", { x: 16, y: 37, class: "subtitle" }, header);
  const sideLabel = state.mode === "flow" ? (n.tx ? "Outputs · " : "Inputs · ") : "";
  sub.textContent = shorten(sideLabel + [d.manufacturer, d.model].filter(Boolean).join(" ") + (d.online ? "" : " · offline"), 36);
  // Clock and IP problems from the monitor: small badges at the top right of the block.
  let bx = W - 26;
  for (const b of [...(state.badges[d.name] || [])].reverse()) {
    const label = b.kind === "clock" ? "CLOCK" : "IP";
    const bw = label.length * 6.4 + 10;
    bx -= bw;
    const bg = el("g", { class: `nbadge ${b.severity}`, transform: `translate(${bx},8)` }, header);
    el("rect", { width: bw, height: 15, rx: 7.5 }, bg);
    const bt = el("text", { x: bw / 2, y: 11, "text-anchor": "middle" }, bg);
    bt.textContent = label;
    const tt = el("title", {}, bg);
    tt.textContent = `${b.kind === "clock" ? "Clock problem" : "IP problem"}: ${b.text}`;
    bx -= 4;
  }
  const chev = el("text", { x: W - 14, y: 28, class: "chevron", "text-anchor": "end" }, header);
  chev.textContent = expanded ? "▾" : "▸";
  const tip = el("title", {}, header);
  tip.textContent = `${d.name}\nClick to ${expanded ? "collapse" : "show"} channels, drag to move`;

  if (!expanded) {
    const parts = [];
    if (n.rx) parts.push(`${d.rx.filter((c) => c.subDevice).length}/${d.rx.length} in routed`);
    if (n.tx) {
      const used = new Set(state.routes.filter((r) => r.srcDevice === d.name && r.srcChannel != null).map((r) => r.srcChannel));
      parts.push(`${used.size}/${d.tx.length} out used`);
    }
    const s = el("text", { x: 16, y: HEADER + 21, class: "summary" }, g);
    s.textContent = parts.join("  ·  ");
    const lc = el("text", { x: 16, y: HEADER + 40, class: "live-count" }, g);
    live.counts.push({ el: lc, device: d.name, rx: n.rx, tx: n.tx });
    if (n.rx) el("circle", { cx: 0, cy: HEADER + SUMMARY / 2, r: 5, class: "port" }, g);
    if (n.tx) el("circle", { cx: W, cy: HEADER + SUMMARY / 2, r: 5, class: "port" }, g);
  } else {
    el("line", { x1: 0, x2: W, y1: HEADER, y2: HEADER, class: "divider" }, g);
    const rows = (list, side) => list.forEach((c, i) => {
      const y = HEADER + i * ROW + ROW / 2 + 4;
      const routed = side === "rx" ? !!c.subDevice : state.routes.some((r) => r.srcDevice === d.name && r.srcChannel === c.id);
      const failed = side === "rx" && c.state === "error";
      const end = live.ends?.has(`${d.name}|${side}|${c.id}`);
      const picked = state.trace?.kind === "channel" && state.trace.device === d.name && state.trace.side === side && state.trace.ch === c.id;
      if (end || picked) el("rect", { x: side === "rx" ? 6 : W / 2, y: y - ROW / 2, width: W / 2 - 6, height: ROW, rx: 4, class: "row-traced" + (picked ? " picked" : "") }, g);
      const label = el("text", {
        x: side === "rx" ? 22 : W - 22, y: y + 4, "text-anchor": side === "rx" ? "start" : "end",
        class: "chan" + (routed ? "" : " unused") + (failed ? " failed" : "") + (end || picked ? " traced" : ""),
      }, g);
      label.textContent = `${c.id} ${shorten(c.name === String(c.id).padStart(2, "0") || c.name === String(c.id) ? "" : c.name, 16)}`.trim();
      el("circle", { cx: side === "rx" ? 0 : W, cy: y, r: routed ? 3 : 2, class: "port" + (routed ? "" : " unused") }, g);
      const dot = el("circle", { cx: side === "rx" ? 13 : W - 13, cy: y, r: 3.6, class: "sig" }, g);
      live.dots.push({ el: dot, device: d.name, side, ch: c.id });
      // Click anywhere on the row (not just the text) to trace it.
      const hit = el("rect", { x: side === "rx" ? 0 : W / 2, y: y - ROW / 2, width: W / 2, height: ROW, class: "row-hit" }, g);
      clickable(hit, { kind: "channel", device: d.name, side, ch: c.id });
    });
    if (n.rx) rows(d.rx, "rx");
    if (n.tx) rows(d.tx, "tx");
  }
  makeDraggable(header, n);
}

// ---------- signal levels ----------
// Levels arrive in dBFS per channel (null = muted or no reading).
const SIGNAL_DB = -60;     // at or above this counts as signal present
function levelOf(device, side, ch) {
  const d = state.levels?.[device];
  if (!d || d.stale) return undefined;           // unknown
  const v = d[side]?.[ch - 1];
  return v === undefined ? undefined : v;
}
function sigClass(db) {
  if (db === undefined) return "unknown";
  if (db === null || db < SIGNAL_DB) return "off";
  if (db >= -0.5) return "clip";
  if (db >= -6) return "hot";
  return "on";
}
const dbText = (db) => (db === undefined ? "no reading" : db === null || db < SIGNAL_DB ? "no signal" : `${db.toFixed(1)} dBFS`);

function applyLevels() {
  const have = !!state.levels;
  document.body.classList.toggle("has-levels", have);
  for (const x of live.dots) x.el.setAttribute("class", "sig " + sigClass(levelOf(x.device, x.side, x.ch)));
  for (const x of live.wires) {
    const r = x.route;
    const c = sigClass(levelOf(r.srcDevice, "tx", r.srcChannel));
    x.path.classList.toggle("live", !r.failed && c !== "off" && c !== "unknown");
  }
  for (const b of live.bundles) {
    let on = 0, known = 0;
    for (const r of b.routes) {
      const c = sigClass(levelOf(r.srcDevice, "tx", r.srcChannel));
      if (c !== "unknown") known++;
      if (!r.failed && c !== "off" && c !== "unknown") on++;
    }
    b.path.classList.toggle("live", on > 0);
    b.label.classList.toggle("live", on > 0);
    const text = (known ? `${on}/${b.total} live` : `${b.total} ch`) + (b.bwText || "") + (b.failed ? ` · ${b.failed} failed` : "");
    if (b.text.textContent !== text) {
      b.text.textContent = text;
      b.rect.setAttribute("x", -(text.length * 3.6 + 8));
      b.rect.setAttribute("width", text.length * 7.2 + 16);
    }
  }
  for (const x of live.counts) {
    const d = state.levels?.[x.device];
    if (!d || d.stale) { x.el.textContent = have ? "No signal reading" : ""; x.el.setAttribute("class", "live-count"); continue; }
    const count = (arr) => (arr || []).filter((v) => v != null && v >= SIGNAL_DB).length;
    const parts = [];
    if (x.rx) parts.push(`${count(d.rx)} in`);
    if (x.tx) parts.push(`${count(d.tx)} out`);
    x.el.textContent = `● Signal on ${parts.join(" · ")}`;
    x.el.setAttribute("class", "live-count" + (count(d.rx) + count(d.tx) ? " on" : ""));
  }
}

function shorten(s, max) { return s.length > max ? s.slice(0, max - 1) + "…" : s; }

// ---------- side panel ----------
function renderPanel(byId) {
  const n = state.selected && byId.get(state.selected);
  if (!n) { panel.hidden = true; return; }
  panel.hidden = false;
  const d = n.device;
  const into = groupBy(state.routes.filter((r) => r.dstDevice === d.name), (r) => r.srcDevice);
  const outOf = groupBy(state.routes.filter((r) => r.srcDevice === d.name), (r) => r.dstDevice);
  const row = (other, rs, dir) => {
    const mine = rangeText(rs.map((r) => (dir === "in" ? r.dstChannel : r.srcChannel)).filter((x) => x != null));
    const theirs = rangeText(rs.map((r) => (dir === "in" ? r.srcChannel : r.dstChannel)).filter((x) => x != null));
    return `<li><span class="swatch" style="background:${state.colors.get(other) || "#888"}"></span>
      <div><b>${esc(other)}</b> <span class="muted">${rs.length} ch</span><br>
      <span class="muted">${dir === "in" ? `their out ${theirs} → in ${mine}` : `out ${mine} → their in ${theirs}`}</span></div></li>`;
  };
  panel.innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <h2>${esc(d.name)}</h2>
    <p class="muted">${esc([d.manufacturer, d.model].filter(Boolean).join(" "))}${d.sampleRate ? ` · ${d.sampleRate / 1000} kHz` : ""} · ${d.rx.length} in / ${d.tx.length} out</p>
    ${(state.badges[d.name] || []).map((b) => `<p class="sev-text-${b.severity}"><b>${b.kind === "clock" ? "Clock problem" : "IP problem"}:</b> ${esc(b.text)}</p>`).join("")}
    ${state.routes.some((r) => r.dstDevice === d.name && r.failed) ? `<p class="sev-text-critical"><b>Failed routes:</b> in ${rangeText(state.routes.filter((r) => r.dstDevice === d.name && r.failed).map((r) => r.dstChannel))}</p>` : ""}
    <dl class="dev-info"></dl>
    ${canIdentify(d) ? `<p><button class="identify" title="Blink this device's identify LED so you can find it in the rack">Identify</button> <span class="muted identify-msg"></span></p>` : ""}
    <h3>Receiving from</h3>
    <ul>${[...into].map(([o, rs]) => row(o, rs, "in")).join("") || '<li class="muted">Nothing</li>'}</ul>
    <h3>Sending to</h3>
    <ul>${[...outOf].map(([o, rs]) => row(o, rs, "out")).join("") || '<li class="muted">Nothing</li>'}</ul>`;
  panel.querySelector(".close").onclick = () => { state.selected = null; render(); };
  fillDeviceInfo(d);
  const idBtn = panel.querySelector(".identify");
  if (idBtn) idBtn.onclick = () => identify(d.name, idBtn, panel.querySelector(".identify-msg"));
}

// ---------- device info ----------
// What we know about the selected device, from the network itself (netaudio), the monitor
// (ping, switch port, clock) and the routes (estimated bandwidth). Updated in place every
// couple of seconds while the panel is open.
function fillDeviceInfo(d) {
  const box = panel.querySelector(".dev-info");
  if (!box) return;
  const info = d.info || {};
  const m = monitorState()?.devices?.find((x) => x.name === d.name);
  const rows = [];
  const add = (k, v) => { if (v != null && v !== "") rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };
  const isLive = ["live", "offline"].includes(state.model?.source);
  if (isLive) add("Status", d.online ? (m && !m.online ? `<span class="sev-text-warning">not answering ping</span>` : "Online") : `<span class="sev-text-critical">Offline</span>`);
  add("IP", d.ipv4 || m?.ip ? `<span class="mono">${esc(d.ipv4 || m.ip)}</span>` : null);
  add("MAC", info.mac || m?.mac ? `<span class="mono">${esc(info.mac || m.mac)}</span>` : null);
  if (m?.port) add("Switch port", `${esc(m.port.where || `${m.port.switch} ${m.port.name}`)}${m.port.up ? (m.port.speed_mbps ? ` · ${m.port.speed_mbps < 1000 ? `<span class="sev-text-warning">${m.port.speed_mbps} Mb/s</span>` : `${m.port.speed_mbps / 1000} Gb/s`}` : "") : ` · <span class="sev-text-critical">no link</span>`}`);
  if (m && m.rtt_ms != null) add("Ping", `${m.rtt_ms.toFixed(2)} ms${m.ping_loss ? ` · <span class="sev-text-warning">${m.ping_loss}% lost</span>` : ""}`);
  add("Sample rate", d.sampleRate ? `${d.sampleRate / 1000} kHz` : null);
  const enc = info.encoding != null ? String(info.encoding).replace(/^PCM\s*/i, "") : null;
  add("Bit depth", enc ? `${esc(enc)}${/^\d+$/.test(enc) ? "-bit" : ""}` : null);
  const lat = info.latencyMs != null ? +info.latencyMs : m?.latencies?.length ? m.latencies[0] / 1e6 : null;
  add("Latency", lat != null && !isNaN(lat) ? `${lat} ms` : null);
  const role = m?.is_leader ? "Leader" : info.clockRole;
  add("Clock", role ? esc(String(role).replace(/^\w/, (c) => c.toUpperCase())) : null);
  add("Firmware", info.firmware ? esc(info.firmware) : null);
  add("Redundancy", info.redundancy != null ? (info.redundancy === true ? "Yes" : info.redundancy === false ? "No" : esc(info.redundancy)) : null);
  if (info.txFlows != null || info.rxFlows != null) add("Flows", `${info.txFlows ?? "?"} out · ${info.rxFlows ?? "?"} in`);
  add("Channels", `${d.tx.length} out · ${d.rx.length} in`);
  const bw = deviceTraffic(state.model, state.routes)[d.name];
  if (bw && (bw.out || bw.in)) add("Bandwidth", `${bw.out ? `sends ~${mbpsText(bw.out)}` : ""}${bw.out && bw.in ? " · " : ""}${bw.in ? `receives ~${mbpsText(bw.in)}` : ""} <span class="muted">(estimated)</span>`);
  const html = rows.join("");
  if (box.innerHTML !== html) box.innerHTML = html;
}

// ---------- identify ----------
// Only on the live network through the netaudio daemon, and only for devices that support it.
function canIdentify(d) {
  return state.model?.source === "live" && state.model.via === "daemon" && d.online && d.canIdentify !== false;
}
async function identify(name, btn, msg) {
  btn.disabled = true;
  msg.textContent = "Sending…";
  try {
    const res = await fetch("api/identify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: name }),
    });
    const data = await res.json().catch(() => ({}));
    msg.textContent = res.ok ? "Look for the blinking light" : `Couldn't identify: ${data.error || res.statusText}`;
  } catch {
    msg.textContent = "Couldn't reach the server";
  }
  setTimeout(() => { btn.disabled = false; }, 3000);
}
function groupBy(list, f) {
  const m = new Map();
  for (const x of list) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- tooltips ----------
function showTip(e, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = svg.getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  if (x + tw > r.width - 8) x = e.clientX - r.left - tw - 14;
  if (y + th > r.height - 8) y = e.clientY - r.top - th - 14;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}
function hideTip() { tooltip.hidden = true; }

function routeText(r) {
  const lv = state.levels ? `<br><span class="muted">Signal: ${dbText(levelOf(r.srcDevice, "tx", r.srcChannel))} sent, ${dbText(levelOf(r.dstDevice, "rx", r.dstChannel))} received</span>` : "";
  const bad = r.failed ? `<br><b class="sev-text-critical">Route failed${r.stateLabel ? ": " + esc(r.stateLabel) : ""}</b>` : "";
  return `<b>${esc(r.srcDevice)}</b> out ${r.srcChannel ?? "?"} <span class="muted">${esc(r.srcChannelName)}</span><br>→ <b>${esc(r.dstDevice)}</b> in ${r.dstChannel} <span class="muted">${esc(r.dstChannelName)}</span>${bad}${lv}`;
}
function failedText(rs) {
  const f = rs.filter((r) => r.failed);
  if (!f.length) return "";
  const why = [...new Set(f.map((r) => r.stateLabel).filter(Boolean))].join(", ");
  return `<b class="sev-text-critical">${f.length} failed${why ? ": " + esc(why) : ""}</b> <span class="muted">(in ${rangeText(f.map((r) => r.dstChannel))})</span><br>`;
}
// ---------- click to trace ----------
// Nothing pops up on hover (it got in the way). A click on a channel row, a wire or a
// bundle traces it: its routes light up at both ends, everything else fades, and a small
// card says where the signal comes from and goes to. Click the background or press Esc to clear.
function tracedRoutes() {
  const t = state.trace;
  if (!t || !state.model) return null;
  let rs = [];
  if (t.kind === "route") rs = state.routes.filter((r) => r.id === t.id);
  else if (t.kind === "channel")
    rs = state.routes.filter((r) => t.side === "rx" ? r.dstDevice === t.device && r.dstChannel === t.ch
                                                     : r.srcDevice === t.device && r.srcChannel === t.ch);
  else if (t.kind === "bundle") rs = state.routes.filter((r) => bundleKey(r) === t.key);
  return new Set(rs.map((r) => r.id));
}
function bundleKey(r) {
  const dst = nodeIdFor(r.dstDevice, "rx");
  const src = r.missing ? "?" + r.srcDevice : nodeIdFor(r.srcDevice, "tx");
  return `${src}=>${dst}`;
}
function endsOf(ids) {
  const ends = new Set();
  for (const r of state.routes) if (ids.has(r.id)) {
    ends.add(`${r.dstDevice}|rx|${r.dstChannel}`);
    if (r.srcChannel != null) ends.add(`${r.srcDevice}|tx|${r.srcChannel}`);
  }
  return ends;
}
// Make an element clickable for tracing. Thin wires get a wider invisible twin to click.
function clickable(elm, trace, _a, _b, d, hitWidth) {
  let target = elm;
  if (d) {
    target = el("path", { d, class: "wire-hit", "stroke-width": hitWidth || 10 }, elm.parentNode);
    target.addEventListener("mouseenter", () => elm.classList.add("hot"));
    target.addEventListener("mouseleave", () => elm.classList.remove("hot"));
  }
  target.addEventListener("pointerdown", (e) => e.stopPropagation());
  target.addEventListener("click", (e) => {
    e.stopPropagation();
    const same = JSON.stringify(state.trace) === JSON.stringify(trace);
    state.trace = same ? null : trace;
    traceCard.at = same ? null : { x: e.clientX, y: e.clientY };
    render();
  });
}
function clearTrace() {
  if (!state.trace) return false;
  state.trace = null;
  traceCard.at = null;
  render();
  return true;
}

const traceCard = { at: null };
function updateTraceCard() {
  const ids = tracedRoutes();
  if (state.view$ !== "diagram") { tooltip.hidden = true; closeHistory(); return; }
  if (!state.trace || (state.trace.kind !== "channel" && !ids?.size)) {
    if (state.trace) state.trace = null;    // the route went away
    tooltip.hidden = true;
    closeHistory();
    return;
  }
  const rs = state.routes.filter((r) => ids.has(r.id));
  const t = state.trace;
  let html;
  if (t.kind === "route") html = routeText(rs[0]);
  else if (t.kind === "channel") html = channelText(t, rs);
  else html = bundleText(rs);
  const targets = historyTargets(t, rs);
  tooltip.innerHTML = `<button class="close" aria-label="Close">×</button>` + html + (targets.length ? `<div class="hist-slot"></div>` : "");
  tooltip.classList.add("pinned");
  tooltip.hidden = false;
  tooltip.querySelector(".close").onclick = () => clearTrace();
  if (targets.length) mountHistory(tooltip.querySelector(".hist-slot"), targets, () => traceCard.at && placeCard(traceCard.at));
  else closeHistory();
  if (traceCard.at) placeCard(traceCard.at);
}
// Which channels' level history the click card shows: the clicked channel, or both ends of
// a clicked wire. Only for the live network (or a frozen view of it): that's what's recorded.
function historyTargets(t, rs) {
  if (!["live", "offline"].includes(state.model?.source)) return [];
  if (t.kind === "channel") return [{ device: t.device, side: t.side, ch: t.ch, label: t.side === "tx" ? "Sent" : "Received" }];
  if (t.kind === "route" && rs[0]) {
    const r = rs[0];
    const out = [];
    if (!r.missing && r.srcChannel != null) out.push({ device: r.srcDevice, side: "tx", ch: r.srcChannel, label: "Sent" });
    out.push({ device: r.dstDevice, side: "rx", ch: r.dstChannel, label: "Received" });
    return out;
  }
  return [];
}
function placeCard(at) {
  const r = svg.getBoundingClientRect();
  let x = at.x - r.left + 14, y = at.y - r.top + 14;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  if (x + tw > r.width - 8) x = Math.max(8, at.x - r.left - tw - 14);
  if (y + th > r.height - 8) y = Math.max(8, at.y - r.top - th - 14);
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}
function channelText(t, rs) {
  const d = state.model.devices.find((x) => x.name === t.device);
  const c = d?.[t.side]?.find((x) => x.id === t.ch) || { id: t.ch, name: "" };
  const lv = state.levels ? ` · ${dbText(levelOf(t.device, t.side, t.ch))}` : "";
  if (t.side === "rx") {
    const r = rs[0];
    return `<b>${esc(t.device)}</b> in ${c.id} <span class="muted">${esc(c.name)}</span>${lv}<br>` +
      (r ? `<span class="muted">Source:</span> ${esc(r.srcDevice)} out ${r.srcChannel ?? "?"} <span class="muted">${esc(r.srcChannelName)}</span>` +
           (r.missing ? ` <span class="muted">(not found)</span>` : "")
         : `<span class="muted">Not routed</span>`) +
      (r?.failed ? `<br><b class="sev-text-critical">Route failed${r.stateLabel ? ": " + esc(r.stateLabel) : ""}</b>` : "");
  }
  return `<b>${esc(t.device)}</b> out ${c.id} <span class="muted">${esc(c.name)}</span>${lv}<br>` +
    (rs.length ? `<span class="muted">Destination${rs.length > 1 ? `s (${rs.length})` : ""}:</span><br>` +
                 rs.map((r) => `→ ${esc(r.dstDevice)} in ${r.dstChannel} <span class="muted">${esc(r.dstChannelName)}</span>`).join("<br>")
               : `<span class="muted">Not routed</span>`);
}
function bundleText(rs) {
  const max = 12;
  const lines = rs.slice(0, max).map((r) => `${r.srcChannel ?? "?"} ${esc(shorten(r.srcChannelName || "", 14))} → ${r.dstChannel} ${esc(shorten(r.dstChannelName || "", 14))}`);
  const bw = rs.some((r) => !r.missing && !r.failed) ? routesMbps(rs, state.model) : 0;
  const multi = rs.some((r) => /multicast/i.test(r.stateLabel || ""));
  return `<b>${esc(rs[0].srcDevice)}</b> → <b>${esc(rs[0].dstDevice)}</b> · ${rs.length} channel${rs.length > 1 ? "s" : ""}<br>` +
    (bw ? `<span class="muted">About ${mbpsText(bw)} on the network (estimated${multi ? ", multicast" : ""})</span><br>` : "") +
    `<span class="muted">out ${rangeText(rs.map((r) => r.srcChannel).filter((x) => x != null))} → in ${rangeText(rs.map((r) => r.dstChannel))}</span><br>` +
    failedText(rs) + `<div class="trace-list">${lines.join("<br>")}${rs.length > max ? `<br><span class="muted">… and ${rs.length - max} more</span>` : ""}</div>`;
}

// ---------- interaction ----------
function toCanvas(e) {
  const r = svg.getBoundingClientRect();
  return { x: (e.clientX - r.left - state.view.x) / state.view.k, y: (e.clientY - r.top - state.view.y) / state.view.k };
}

// Dragging redraws the diagram on every move, which replaces the block's elements.
// So the move/up listeners live on the window, not on the block being dragged.
let dragging = false;
function makeDraggable(handle, n) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const start = toCanvas(e);
    const id = n.id, mode = state.mode;
    const orig = { ...state.positions[mode][id] };
    let moved = false;
    dragging = true;
    const move = (ev) => {
      const c = toCanvas(ev);
      if (!moved && Math.hypot(c.x - start.x, c.y - start.y) < 4) return;
      moved = true;
      const p = state.positions[mode][id];
      p.x = Math.round(orig.x + c.x - start.x);
      p.y = Math.round(orig.y + c.y - start.y);
      render();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      dragging = false;
      if (moved) persistLayout();
      else {
        // A click: select the device and toggle its channel list.
        state.selected = id;
        toggleExpanded(id);
        persistLayout();
        render();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

// Pan by dragging the background, zoom with the wheel or trackpad pinch.
svg.addEventListener("pointerdown", (e) => {
  if (e.target !== svg && e.target.id !== "bg") return;
  const start = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
  let moved = false;
  svg.setPointerCapture(e.pointerId);
  svg.classList.add("panning");
  const move = (ev) => {
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) moved = true;
    state.view.x = start.vx + ev.clientX - start.x;
    state.view.y = start.vy + ev.clientY - start.y;
    viewport.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
  };
  const up = () => {
    svg.removeEventListener("pointermove", move);
    svg.removeEventListener("pointerup", up);
    svg.classList.remove("panning");
    if (!moved && (state.selected || state.trace)) { state.selected = null; state.trace = null; traceCard.at = null; render(); }
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", up);
});
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.min(3, Math.max(0.05, state.view.k * Math.exp(-e.deltaY * 0.0015)));
  state.view.x = mx - (mx - state.view.x) * (k / state.view.k);
  state.view.y = my - (my - state.view.y) * (k / state.view.k);
  state.view.k = k;
  viewport.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
}, { passive: false });

function fit() {
  if (!state.model) return;
  const r = svg.getBoundingClientRect();
  // The canvas can still be zero-sized on first load; try again once it has a size.
  if (r.width < 50 || r.height < 50) { requestAnimationFrame(fit); return; }
  render();
  // Measure everything drawn, including wires that loop below the blocks and
  // "not found" stubs, not just the blocks themselves.
  const b = viewport.getBBox();
  if (!b.width || !b.height) return;
  const pad = 24;
  const k = Math.min(1.4, Math.max(0.05, Math.min((r.width - pad * 2) / b.width, (r.height - pad * 2) / b.height)));
  state.view.k = k;
  state.view.x = (r.width - b.width * k) / 2 - b.x * k;
  state.view.y = (r.height - b.height * k) / 2 - b.y * k;
  viewport.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
}

// ---------- toolbar ----------
const $ = (id) => document.getElementById(id);
function setMode(m) {
  state.mode = m;
  save("dv.mode", m);
  $("mode-network").setAttribute("aria-pressed", m === "network");
  $("mode-flow").setAttribute("aria-pressed", m === "flow");
  state.selected = null;
  render();
  fit();
}
$("mode-network").onclick = () => setMode("network");
$("mode-flow").onclick = () => setMode("flow");
$("btn-layout").onclick = () => { autoLayout(); render(); fit(); };
$("btn-fit").onclick = fit;
function setBandwidth(on) {
  state.bandwidth = on;
  save("dv.bandwidth", on);
  $("btn-bw").setAttribute("aria-pressed", String(on));
  render();
}
$("btn-bw").onclick = () => setBandwidth(!state.bandwidth);
$("btn-bw").setAttribute("aria-pressed", String(state.bandwidth));
// Label the button with what it will do next.
function updateExpandButton() {
  if (!state.model) return;
  const allOpen = nodes().every((n) => state.expanded.has(n.id));
  $("btn-expand").textContent = allOpen ? "Collapse all" : "Expand all";
}
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (state.view$ !== "diagram") return;
  if (e.key === "Escape") clearTrace();
  if (e.key === "e" || e.key === "E") $("btn-expand").click();
  if (e.key === "b" || e.key === "B") $("btn-bw").click();
});
$("btn-expand").onclick = () => {
  const ns = nodes();
  const allOpen = ns.every((n) => state.expanded.has(n.id));
  // Work from the bottom up so each block's shift carries the ones below it.
  const pos = state.positions[state.mode] || {};
  const order = [...ns].sort((a, b) => (pos[b.id]?.y ?? 0) - (pos[a.id]?.y ?? 0));
  for (const n of order) toggleExpanded(n.id, !allOpen);
  persistLayout();
  render();
};
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) openFileText(await f.text(), f.name);
  e.target.value = "";
});
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dropping"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("dropping");
  const f = e.dataTransfer.files[0];
  if (f) openFileText(await f.text(), f.name);
});

function openFileText(text, filename = "") {
  try {
    if (text.trimStart().startsWith("{")) openSetup(JSON.parse(text), filename);
    else { goOffline(); setModel(parsePresetXml(text)); }
  } catch (err) { showStatus(err.message || String(err), true); }
}

// ---------- saved setups ----------
// A setup file holds the layout (block positions for both views, opened blocks,
// colours, zoom) together with the network it was made for, so it can be reopened
// on its own or laid over the live network.
const SETUP_FORMAT = "dante-visualizer-setup";

function currentSetup() {
  return {
    format: SETUP_FORMAT,
    version: 1,
    name: state.model.name,
    savedAt: new Date().toISOString(),
    mode: state.mode,
    view: state.view,
    positions: state.positions,
    expanded: [...state.expanded],
    colors: Object.fromEntries(state.colors),
    network: { ...state.model, levels: undefined },
  };
}

function saveSetup() {
  if (!state.model) return;
  const setup = currentSetup();
  const stamp = setup.savedAt.slice(0, 16).replace("T", " ").replace(":", "-");
  const safe = state.model.name.replace(/[^\w .()-]+/g, "_").trim() || "network";
  const blob = new Blob([JSON.stringify(setup, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safe} setup ${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showStatus(`Saved setup for ${state.model.name}`);
}

function openSetup(setup, filename) {
  if (setup?.format !== SETUP_FORMAT || !setup.network?.devices) throw new Error(`${filename || "This file"} isn't a Dante Visualizer setup.`);
  const applyLayout = () => {
    state.positions = structuredClone(setup.positions || {});
    state.expanded = new Set(setup.expanded || []);
    for (const [name, color] of Object.entries(setup.colors || {})) state.colors.set(name, color);
    state.mode = setup.mode === "flow" ? "flow" : "network";
    save("dv.mode", state.mode);
    $("mode-network").setAttribute("aria-pressed", state.mode === "network");
    $("mode-flow").setAttribute("aria-pressed", state.mode === "flow");
    if (setup.view) state.view = { ...setup.view };
    persistLayout();
  };
  const live = state.model?.source === "live" && live$.wanted;
  if (live) {
    // Keep showing the live network, arranged the way the setup says.
    // Devices the setup doesn't know about are placed below the others.
    applyLayout();
    const known = state.model.devices.filter((d) => setup.network.devices.some((x) => x.name === d.name)).length;
    render();
    showStatus(`Live: ${state.model.name} · laid out from "${setup.name}" (${known}/${state.model.devices.length} devices matched)`);
  } else {
    goOffline();
    setModel({ ...setup.network, source: "setup", name: setup.name || setup.network.name }, { keepLayout: true });
    applyLayout();
    render();
  }
}

$("btn-save").onclick = saveSetup;

// ---------- data ----------
function setModel(model, { keepLayout = false } = {}) {
  const first = !state.model || state.model.name !== model.name;
  state.model = model;
  state.routes = buildRoutes(model);
  model.devices.forEach((d, i) => { if (!state.colors.has(d.name)) state.colors.set(d.name, PALETTE[state.colors.size % PALETTE.length]); });
  if (first && !keepLayout) {
    const saved = load(layoutKey(), null);
    state.positions = saved?.positions || {};
    state.expanded = new Set(saved?.expanded || []);
  }
  document.body.classList.add("loaded");
  const missing = state.routes.filter((r) => r.missing).length;
  const via = model.via === "daemon" ? " (instant updates)" : "";
  showStatus(`${{ live: "Live" + via, setup: "Saved setup", offline: "Offline" }[model.source] || "Preset"}: ${model.name} · ${model.devices.length} devices · ${state.routes.length} routes` + (missing ? ` · ${missing} to devices not found` : ""));
  render();
  if (first && !keepLayout) fit();
}

function showStatus(text, error = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", error);
}

// ---------- live / offline ----------
// Live: following the network (devices, routes and signal levels).
// Offline: a still picture of the last live view, a preset or a saved setup; nothing is polled,
// and in the Mac app the devices are asked to stop sending levels.
const STALE_MS = 60000;           // a snapshot older than this is "last seen", not live
const live$ = {
  wanted: true,                   // the toggle: follow the network?
  available: null,                // does this server have a live network? null = don't know yet
  lastOk: 0,                      // when the server last answered with the live network
  searching: false,               // live server is up but hasn't found devices yet
};

function liveFresh() {
  if (state.model?.source !== "live") return false;
  if (Date.now() - live$.lastOk > 40000) return false;            // server not answering
  if (state.model.via === "daemon") return true;                   // pushed the moment it changes
  const t = Date.parse(state.model.capturedAt || "");
  return !t || Date.now() - t < STALE_MS;
}

function updateLiveButton() {
  const b = $("btn-live");
  const label = b.querySelector(".live-label");
  let cls, text, title;
  if (!live$.wanted) {
    cls = "off"; text = "Offline";
    title = live$.available === false
      ? "No live network here: open the app or start the server on a computer on the Dante network"
      : "Showing a still view, a preset or a saved setup. Click to follow the live network.";
  } else if (state.model?.source === "live" && liveFresh()) {
    cls = "on"; text = "Live"; title = "Following the live network. Click to freeze this view and go offline.";
  } else if (state.model?.source === "live") {
    const t = new Date(Math.min(Date.parse(state.model.capturedAt || "") || live$.lastOk, live$.lastOk || Infinity));
    cls = "stale"; text = `Live · last seen ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    title = "The network hasn't answered for a while (cable out, or the wrong network port?). Click to go offline.";
  } else {
    cls = "wait"; text = live$.searching ? "Looking for devices…" : "Connecting…";
    title = "Waiting for the live network. Click to stay offline.";
  }
  b.className = "live-btn " + cls;
  b.disabled = live$.available === false && !live$.wanted;
  b.setAttribute("aria-pressed", String(live$.wanted));
  b.title = title;
  if (label.textContent !== text) label.textContent = text;
}

// Tell the Mac app (if this page is inside it) so it can start or stop metering.
function tellApp(on) {
  try { window.webkit?.messageHandlers?.dv?.postMessage({ live: on }); } catch {}
}

function goOffline() {
  if (!live$.wanted) return;
  live$.wanted = false;
  stopPolling();
  stopLevels();
  state.levels = null;
  applyLevels();
  if (state.model?.source === "live") {
    // Keep the last live picture on screen, without signal indicators.
    state.model = { ...state.model, source: "offline", frozenAt: new Date().toISOString() };
    setModel(state.model, { keepLayout: true });
  }
  tellApp(false);
  updateLiveButton();
}

function goLive() {
  if (live$.wanted) return;
  live$.wanted = true;
  tellApp(true);
  updateLiveButton();
  poll();
  pollLevels();
}

$("btn-live").onclick = () => (live$.wanted ? goOffline() : goLive());
setInterval(updateLiveButton, 5000);

let pollTimer = null;
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; pollGen++; }
let pollGen = 0;                  // bumps on stop, so a request still in flight is ignored
// With the netaudio daemon behind the server, each request waits until the network changes
// (long poll on the model's version), so routes and devices update the moment they change.
// Otherwise the server's snapshot is re-read every 2 s.
async function poll() {
  clearTimeout(pollTimer);
  const gen = pollGen;
  const live = state.model?.source === "live";
  const wait = live && state.model.via === "daemon" ? `?wait=${state.model.version}` : "";
  const again = (ms) => { if (gen === pollGen && live$.wanted) pollTimer = setTimeout(poll, ms); };
  try {
    const res = await fetch("api/snapshot" + wait, { cache: "no-store" });
    if (gen !== pollGen || !live$.wanted) return;   // went offline meanwhile
    if (res.status === 503) {
      // The live server is up but hasn't found the network yet (just started, or switching ports).
      live$.available = true;
      live$.searching = true;
      if (!state.model) showStatus("Looking for Dante devices…");
      updateLiveButton();
      return again(2000);
    }
    if (!res.ok) throw new Error(res.statusText);
    const model = await res.json();
    if (gen !== pollGen || !live$.wanted) return;
    live$.searching = false;
    if (model.source !== "live") {
      // A server showing a fixed preset: nothing to follow.
      live$.available = false;
      live$.wanted = false;
      if (!state.model) setModel(model);
      updateLiveButton();
      return;
    }
    live$.available = true;
    live$.lastOk = Date.now();
    // Redraw only when the network itself changed, not just the capture time or version.
    const same = (a, b) => a && b && JSON.stringify({ ...a, capturedAt: 0, version: 0 }) === JSON.stringify({ ...b, capturedAt: 0, version: 0 });
    if (dragging) return again(300); // apply after the drag, without losing the change
    if (!same(model, state.model)) setModel(model);
    else Object.assign(state.model, { version: model.version, capturedAt: model.capturedAt });
    updateLiveButton();
    again(model.via === "daemon" ? 0 : 2000);
  } catch {
    if (gen !== pollGen) return;
    if (!state.model && live$.available === null) {
      // No server (opened from a file) or one without a network: offline until one is opened.
      live$.available = false;
      live$.wanted = false;
      showStatus("Open a Dante Controller preset (.xml) or start the server to see your network.");
    } else {
      again(3000);
    }
    updateLiveButton();
  }
}

// Poll signal levels several times a second when the server provides them.
let levelsMisses = 0;
let levelsTimer = null;
function stopLevels() { clearTimeout(levelsTimer); levelsTimer = null; }
async function pollLevels() {
  clearTimeout(levelsTimer);
  let delay = 250;
  try {
    const res = await fetch("api/levels", { cache: "no-store" });
    if (!live$.wanted) return;
    if (res.status === 404) { state.levels = null; applyLevels(); return; } // server has no levels feed
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (!live$.wanted) return;
    state.levels = data.devices || {};
    levelsMisses = 0;
    if (!dragging) applyLevels();
  } catch {
    if (!live$.wanted) return;
    if (++levelsMisses > 8) { state.levels = null; applyLevels(); delay = 3000; }
  }
  levelsTimer = setTimeout(pollLevels, delay);
}

// ---------- monitor: Diagram / Monitor views, sidebar and problem count ----------
function setView(v) {
  state.view$ = v;
  save("dv.view", v);
  document.body.classList.toggle("view-monitor", v === "monitor");
  $("monitor").hidden = v !== "monitor";
  $("view-diagram").setAttribute("aria-pressed", String(v === "diagram"));
  $("view-monitor").setAttribute("aria-pressed", String(v === "monitor"));
  hideTip();
  if (v === "monitor") monitorRendered();
  else render();
}
$("view-diagram").onclick = () => setView("diagram");
$("view-monitor").onclick = () => setView("monitor");

// Show a device on the diagram: switch to it, select the block and bring it to the middle.
function selectDevice(name) {
  setView("diagram");
  if (!state.model) return;
  const ns = nodes();
  const n = ns.find((x) => x.id === nodeIdFor(name, "rx")) || ns.find((x) => x.id === nodeIdFor(name, "tx")) ||
    ns.find((x) => x.device.name === name);
  if (!n) { showStatus(`${name} isn't on the diagram right now`); return; }
  state.selected = n.id;
  render();
  const p = state.positions[state.mode][n.id];
  const k = state.view.k;
  state.view.x = svg.clientWidth / 2 - (p.x + W / 2) * k;
  state.view.y = svg.clientHeight / 2 - (p.y + nodeHeight(n) / 2) * k;
  userMoved = true;
  viewport.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
}

function updateProblems(mon) {
  const b = $("btn-problems");
  const n = mon.issues.length;
  const worst = mon.issues[0]?.severity;
  const crit = mon.issues.filter((i) => i.severity === "critical").length;
  b.hidden = false;
  b.className = "problems-btn " + (n ? (worst === "critical" ? "critical" : "warning") : "ok");
  b.querySelector(".plabel").textContent = !n ? "All good" : crit ? `${n} problem${n === 1 ? "" : "s"}` : `${n} warning${n === 1 ? "" : "s"}`;
  b.title = n ? mon.issues.slice(0, 6).map((i) => `${i.subject}: ${i.message}`).join("\n") + "\n\nClick for details" : "No problems. Click to open the monitor sidebar.";
}
$("btn-problems").onclick = () => {
  if (state.view$ === "monitor") showMonitorTab("overview");
  else toggleSidebar();
};

initMonitor({
  onState(mon) {
    updateProblems(mon);
    if (state.selected && !panel.hidden) {
      const n = nodes().find((x) => x.id === state.selected);
      if (n) fillDeviceInfo(n.device);
    }
    const badges = mon.badges || {};
    if (JSON.stringify(badges) !== JSON.stringify(state.badges)) {
      state.badges = badges;
      if (state.view$ === "diagram" && !dragging) render();
    }
  },
  onSelectDevice: selectDevice,
  hasDevice: (name) => !!state.model?.devices.some((d) => d.name === name),
  onOpenView: () => setView("monitor"),
  onSidebar: (open) => $("btn-problems").setAttribute("aria-pressed", String(open)),
  getNetwork: () => (state.model ? { model: state.model, routes: state.routes } : null),
  onAvailable(yes) { if (!yes && state.view$ === "monitor") setView("diagram"); },
});

setMode(state.mode);
if (load("dv.view", "diagram") === "monitor") setView("monitor");
updateLiveButton();
tellApp(true);   // the app may still have metering off from before a reload
poll();
pollLevels();
window.addEventListener("resize", () => render());
// Re-fit when the canvas first gets its real size, until the user pans or zooms.
let userMoved = false;
svg.addEventListener("wheel", () => { userMoved = true; }, { passive: true });
svg.addEventListener("pointerdown", () => { userMoved = true; });
new ResizeObserver(() => { if (!userMoved) fit(); }).observe(svg);
