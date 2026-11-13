import { parsePresetXml, buildRoutes, rangeText } from "./model.js";

// ---------- geometry ----------
const W = 250;          // block width
const HEADER = 48;      // block header height
const ROW = 16;         // channel row height when expanded
const SUMMARY = 34;     // collapsed body height
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
  colors: new Map(),
};

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
function placeLabel(path, placed) {
  const len = path.getTotalLength();
  for (const t of [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8]) {
    const p = path.getPointAtLength(len * t);
    if (placed.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 34)) { placed.push(p); return p; }
  }
  const p = path.getPointAtLength(len * 0.5);
  placed.push(p);
  return p;
}

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
  const placed = [];
  let lane = 0;
  nodesLayer.replaceChildren();
  const sel = state.selected;
  const selDevice = sel ? byId.get(sel)?.device.name : null;
  const related = (r) => !selDevice || r.srcDevice === selDevice || r.dstDevice === selDevice;

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
    const dim = selDevice && !g.routes.some(related);
    if (!g.srcNode) {
      // Subscribed to a device that isn't on the network right now.
      const b = portPos(g.dstNode, "rx", g.routes[0].dstChannel);
      const a = { x: b.x - 90, y: b.y };
      el("path", { d: `M${a.x},${a.y} L${b.x},${b.y}`, class: "wire missing" + (dim ? " dim" : "") }, wiresLayer);
      const t = el("text", { x: a.x - 6, y: a.y + 4, class: "wire-label missing-label", "text-anchor": "end" }, wiresLayer);
      t.textContent = `${g.srcName} (not found) · ${g.routes.length} ch`;
      continue;
    }
    const bothCollapsed = !state.expanded.has(g.srcNode.id) && !state.expanded.has(g.dstNode.id);
    if (bothCollapsed) {
      const a = portPos(g.srcNode, "tx"), b = portPos(g.dstNode, "rx");
      const width = 2 + Math.log2(g.routes.length) * 1.6;
      const laneY = isBackward(a, b) ? floorBetween(ns, a.x, b.x) + 40 + 26 * lane++ : null;
      const path = el("path", { d: curve(a, b, laneY), class: "wire bundle" + (dim ? " dim" : ""), stroke: color, "stroke-width": width }, wiresLayer);
      hoverBundle(path, g);
      const mid = placeLabel(path, placed);
      const label = el("g", { class: "bundle-label" + (dim ? " dim" : ""), transform: `translate(${mid.x},${mid.y})` }, labelsLayer);
      const text = `${g.routes.length} ch`;
      el("rect", { x: -(text.length * 3.6 + 8), y: -10, width: text.length * 7.2 + 16, height: 20, rx: 10, stroke: color }, label);
      const t = el("text", { x: 0, y: 4, "text-anchor": "middle" }, label);
      t.textContent = text;
      hoverBundle(label, g);
    } else {
      const laneBase = floorBetween(ns, portPos(g.srcNode, "tx").x, portPos(g.dstNode, "rx").x) + 40 + 26 * lane;
      let usedLane = false;
      for (const r of g.routes) {
        const a = portPos(g.srcNode, "tx", r.srcChannel), b = portPos(g.dstNode, "rx", r.dstChannel);
        const back = isBackward(a, b);
        usedLane ||= back;
        const hot = state.hoverRoute === r.id;
        const path = el("path", { d: curve(a, b, back ? laneBase : null), class: "wire single" + (dim && !related(r) ? " dim" : "") + (hot ? " hot" : ""), stroke: color }, wiresLayer);
        hoverRoute(path, r);
      }
      if (usedLane) lane++;
    }
  }

  for (const n of ns) drawNode(n, groups);
  viewport.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
  renderPanel(byId);
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
  title.textContent = shorten(d.name, 25);
  const sub = el("text", { x: 16, y: 37, class: "subtitle" }, header);
  const sideLabel = state.mode === "flow" ? (n.tx ? "Outputs · " : "Inputs · ") : "";
  sub.textContent = shorten(sideLabel + [d.manufacturer, d.model].filter(Boolean).join(" ") + (d.online ? "" : " · offline"), 36);
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
    if (n.rx) el("circle", { cx: 0, cy: HEADER + SUMMARY / 2, r: 5, class: "port" }, g);
    if (n.tx) el("circle", { cx: W, cy: HEADER + SUMMARY / 2, r: 5, class: "port" }, g);
  } else {
    el("line", { x1: 0, x2: W, y1: HEADER, y2: HEADER, class: "divider" }, g);
    const rows = (list, side) => list.forEach((c, i) => {
      const y = HEADER + i * ROW + ROW / 2 + 4;
      const routed = side === "rx" ? !!c.subDevice : state.routes.some((r) => r.srcDevice === d.name && r.srcChannel === c.id);
      const label = el("text", {
        x: side === "rx" ? 12 : W - 12, y: y + 4, "text-anchor": side === "rx" ? "start" : "end",
        class: "chan" + (routed ? "" : " unused"),
      }, g);
      label.textContent = `${c.id} ${shorten(c.name === String(c.id).padStart(2, "0") || c.name === String(c.id) ? "" : c.name, 16)}`.trim();
      el("circle", { cx: side === "rx" ? 0 : W, cy: y, r: routed ? 3 : 2, class: "port" + (routed ? "" : " unused") }, g);
      label.addEventListener("mouseenter", (e) => showChannel(e, d, side, c));
      label.addEventListener("mouseleave", hideTip);
    });
    if (n.rx) rows(d.rx, "rx");
    if (n.tx) rows(d.tx, "tx");
  }
  makeDraggable(header, n);
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
    <h3>Receiving from</h3>
    <ul>${[...into].map(([o, rs]) => row(o, rs, "in")).join("") || '<li class="muted">Nothing</li>'}</ul>
    <h3>Sending to</h3>
    <ul>${[...outOf].map(([o, rs]) => row(o, rs, "out")).join("") || '<li class="muted">Nothing</li>'}</ul>`;
  panel.querySelector(".close").onclick = () => { state.selected = null; render(); };
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
  return `<b>${esc(r.srcDevice)}</b> out ${r.srcChannel ?? "?"} <span class="muted">${esc(r.srcChannelName)}</span><br>→ <b>${esc(r.dstDevice)}</b> in ${r.dstChannel} <span class="muted">${esc(r.dstChannelName)}</span>`;
}
function hoverRoute(path, r) {
  path.addEventListener("mouseenter", (e) => { path.classList.add("hot"); showTip(e, routeText(r)); });
  path.addEventListener("mousemove", (e) => showTip(e, routeText(r)));
  path.addEventListener("mouseleave", () => { path.classList.remove("hot"); hideTip(); });
}
function hoverBundle(elm, g) {
  const rs = g.routes;
  const html = () => `<b>${esc(rs[0].srcDevice)}</b> → <b>${esc(rs[0].dstDevice)}</b> · ${rs.length} channels<br>
    <span class="muted">out ${rangeText(rs.map((r) => r.srcChannel).filter((x) => x != null))} → in ${rangeText(rs.map((r) => r.dstChannel))}</span><br>
    <span class="muted">Click either device to see each channel</span>`;
  elm.addEventListener("mouseenter", (e) => showTip(e, html()));
  elm.addEventListener("mousemove", (e) => showTip(e, html()));
  elm.addEventListener("mouseleave", hideTip);
}
function showChannel(e, d, side, c) {
  if (side === "rx") {
    showTip(e, `<b>${esc(d.name)}</b> in ${c.id} <span class="muted">${esc(c.name)}</span><br>` +
      (c.subDevice ? `← ${esc(c.subDevice)} · ${esc(c.subChannel)}` : `<span class="muted">Not routed</span>`));
  } else {
    const dests = state.routes.filter((r) => r.srcDevice === d.name && r.srcChannel === c.id);
    showTip(e, `<b>${esc(d.name)}</b> out ${c.id} <span class="muted">${esc(c.name)}</span><br>` +
      (dests.length ? dests.map((r) => `→ ${esc(r.dstDevice)} in ${r.dstChannel}`).join("<br>") : `<span class="muted">Not routed</span>`));
  }
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
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
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
    if (!moved && state.selected) { state.selected = null; render(); }
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", up);
});
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.min(3, Math.max(0.15, state.view.k * Math.exp(-e.deltaY * 0.0015)));
  state.view.x = mx - (mx - state.view.x) * (k / state.view.k);
  state.view.y = my - (my - state.view.y) * (k / state.view.k);
  state.view.k = k;
  viewport.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
}, { passive: false });

function fit() {
  if (!state.model) return;
  const pos = state.positions[state.mode];
  const ns = nodes().filter((n) => pos[n.id]);
  if (!ns.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) {
    const p = pos[n.id];
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + W); y1 = Math.max(y1, p.y + nodeHeight(n));
  }
  const r = svg.getBoundingClientRect();
  // The canvas can still be zero-sized on first load; try again once it has a size.
  if (r.width < 50 || r.height < 50) { requestAnimationFrame(fit); return; }
  const pad = 140;
  const k = Math.min(1.4, Math.max(0.15, Math.min(r.width / (x1 - x0 + pad * 2), r.height / (y1 - y0 + 80))));
  state.view.k = k;
  state.view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k;
  state.view.y = (r.height - (y1 - y0) * k) / 2 - y0 * k;
  render();
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
$("btn-expand").onclick = () => {
  const ns = nodes();
  const allOpen = ns.every((n) => state.expanded.has(n.id));
  for (const n of ns) allOpen ? state.expanded.delete(n.id) : state.expanded.add(n.id);
  persistLayout();
  render();
};
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) openPresetText(await f.text());
  e.target.value = "";
});
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dropping"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("dropping");
  const f = e.dataTransfer.files[0];
  if (f) openPresetText(await f.text());
});

function openPresetText(text) {
  try { setModel(parsePresetXml(text)); stopPolling(); }
  catch (err) { showStatus(err.message, true); }
}

// ---------- data ----------
function setModel(model) {
  const first = !state.model || state.model.name !== model.name;
  state.model = model;
  state.routes = buildRoutes(model);
  model.devices.forEach((d, i) => { if (!state.colors.has(d.name)) state.colors.set(d.name, PALETTE[state.colors.size % PALETTE.length]); });
  if (first) {
    const saved = load(layoutKey(), null);
    state.positions = saved?.positions || {};
    state.expanded = new Set(saved?.expanded || []);
  }
  document.body.classList.add("loaded");
  const missing = state.routes.filter((r) => r.missing).length;
  showStatus(`${model.source === "live" ? "Live" : "Preset"}: ${model.name} · ${model.devices.length} devices · ${state.routes.length} routes` + (missing ? ` · ${missing} to devices not found` : ""));
  render();
  if (first) fit();
}

function showStatus(text, error = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", error);
}

let pollTimer = null;
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
async function poll() {
  try {
    const res = await fetch("api/snapshot", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    const model = await res.json();
    // Redraw only when the network itself changed, not just the capture time.
    const same = (a, b) => a && b && JSON.stringify({ ...a, capturedAt: 0 }) === JSON.stringify({ ...b, capturedAt: 0 });
    if (!dragging && !same(model, state.model)) setModel(model);
    if (model.source === "live") pollTimer = setTimeout(poll, 2000);
  } catch {
    if (!state.model) showStatus("Open a Dante Controller preset (.xml) or start the server to see your network.");
  }
}

setMode(state.mode);
poll();
window.addEventListener("resize", () => render());
// Re-fit when the canvas first gets its real size, until the user pans or zooms.
let userMoved = false;
svg.addEventListener("wheel", () => { userMoved = true; }, { passive: true });
svg.addEventListener("pointerdown", () => { userMoved = true; });
new ResizeObserver(() => { if (!userMoved) fit(); }).observe(svg);
