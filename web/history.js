// Level history: the strip chart in the click card, and the data for the dropouts list.
//
// The server keeps each channel's loudest level per second for the last hour
// (/api/history). Clicking a channel or a wire shows that record here: the level over
// time, red ticks where it clipped and grey bands where it was silent. Clicking on the
// chart reads off the level at that moment. Nothing appears on hover.

const NO_SIGNAL = 254, NO_READING = 255;
const FLOOR_DB = -60;           // the bottom of the chart; quieter counts as silent
const CLIP_RAW = 1;             // -0.5 dBFS and up counts as clipping
const W = 300, H = 92, PAD_L = 4, PAD_R = 30, PAD_T = 8, PAD_B = 16;
const WINDOWS = [[60, "1 min"], [600, "10 min"], [3600, "1 hour"]];
const SERIES_COLORS = ["var(--h-sent)", "var(--h-recv)"];

const toDb = (raw) => -raw / 2;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// One chart is open at a time. It's built once per traced channel or wire, and moved into
// the click card each time the card is redrawn, so it doesn't flicker or refetch.
let current = null;   // { key, root, targets, data, timer, seconds, pick }

export function mountHistory(holder, targets, onDraw) {
  if (!holder) return;
  const key = JSON.stringify(targets.map((t) => [t.device, t.side, t.ch]));
  if (!current || current.key !== key) {
    closeHistory();
    current = { key, targets, data: [], seconds: load("dv.history.window", 600), pick: null, root: document.createElement("div") };
    current.root.className = "hist";
    refresh();
    current.timer = setInterval(() => {
      if (!current?.root.isConnected) return closeHistory();
      refresh();
    }, 1000);
  }
  current.onDraw = onDraw;
  holder.replaceWith(current.root);
}

export function closeHistory() {
  if (!current) return;
  clearInterval(current.timer);
  current = null;
}

async function refresh() {
  const c = current;
  if (!c) return;
  try {
    const data = await Promise.all(c.targets.map(async (t) => {
      const q = new URLSearchParams({ device: t.device, side: t.side, ch: t.ch, seconds: c.seconds });
      const r = await fetch("api/history?" + q, { cache: "no-store" });
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    }));
    if (c !== current) return;
    c.data = data;
    c.missing = false;
  } catch {
    if (c !== current) return;
    c.missing = true;
  }
  draw();
}

function draw() {
  const c = current;
  const root = c.root;
  if (c.missing) { root.innerHTML = `<div class="hist-note muted">Level history isn't available from this server.</div>`; return; }
  const n = c.seconds;
  const x = (i) => PAD_L + (i / (n - 1)) * (W - PAD_L - PAD_R);
  const y = (db) => PAD_T + (Math.max(FLOOR_DB, Math.min(0, db)) / FLOOR_DB) * (H - PAD_T - PAD_B);
  const parts = [];
  // Grid: 0, -20, -40 dBFS and the silence floor.
  for (const db of [0, -20, -40, -60]) {
    parts.push(`<line class="h-grid" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(db)}" y2="${y(db)}"/>`);
    parts.push(`<text class="h-axis" x="${W - PAD_R + 4}" y="${y(db) + 3.5}">${db}</text>`);
  }
  const first = c.data[0]?.peaks || [];
  // Silent stretches of the first series as grey bands.
  runs(first, (v) => v === NO_SIGNAL).forEach(([a, b]) => {
    parts.push(`<rect class="h-silent" x="${x(a)}" y="${PAD_T}" width="${Math.max(1.5, x(b) - x(a) + (W - PAD_L - PAD_R) / n)}" height="${H - PAD_T - PAD_B}"/>`);
  });
  // A line per series; gaps where there was no reading.
  c.data.forEach((d, si) => {
    let path = "";
    let pen = false;
    (d.peaks || []).forEach((v, i) => {
      if (v === NO_READING) { pen = false; return; }
      const yy = v === NO_SIGNAL ? y(FLOOR_DB) : y(toDb(v));
      path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${yy.toFixed(1)}`;
      pen = true;
    });
    if (path) parts.push(`<path class="h-line${si ? " second" : ""}" d="${path}" stroke="${SERIES_COLORS[si]}"/>`);
  });
  // Clipping: red ticks along the top.
  c.data.forEach((d) => (d.peaks || []).forEach((v, i) => {
    if (v <= CLIP_RAW) parts.push(`<line class="h-clip" x1="${x(i)}" x2="${x(i)}" y1="${PAD_T - 6}" y2="${PAD_T + 2}"/>`);
  }));
  const label = WINDOWS.find(([s]) => s === n)?.[1] || `${n} s`;
  parts.push(`<text class="h-axis" x="${PAD_L}" y="${H - 3}">−${label}</text>`);
  parts.push(`<text class="h-axis" x="${W - PAD_R}" y="${H - 3}" text-anchor="end">now</text>`);
  if (c.pick != null && c.pick < n) parts.push(`<line class="h-pick" x1="${x(c.pick)}" x2="${x(c.pick)}" y1="${PAD_T}" y2="${H - PAD_B}"/>`);

  const hasAny = c.data.some((d) => (d.peaks || []).some((v) => v !== NO_READING));
  const recording = c.data.some((d) => d.recording);
  const legend = c.targets.length > 1
    ? `<div class="hist-legend">${c.targets.map((t, i) => `<span><i style="background:${SERIES_COLORS[i]}"></i>${esc(t.label)}</span>`).join("")}</div>` : "";
  root.innerHTML = `
    <div class="hist-head"><b>Level history</b>
      <span class="hist-win">${WINDOWS.map(([s, l]) => `<button data-s="${s}" aria-pressed="${s === n}">${l}</button>`).join("")}</span></div>
    ${hasAny ? `<svg class="hist-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Level over the last ${label}">${parts.join("")}</svg>${legend}
      <div class="hist-stats">${statsText(c.data, c.targets)}</div>
      <div class="hist-pick muted">${pickText(c)}</div>`
      : `<div class="hist-note muted">${recording ? "No readings for this channel yet." : "Nothing recorded yet. Levels are recorded while the diagram is live with signal levels on."}</div>`}`;
  root.querySelectorAll(".hist-win button").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    c.seconds = +b.dataset.s;
    c.pick = null;
    save("dv.history.window", c.seconds);
    refresh();
  }));
  const svgEl = root.querySelector(".hist-chart");
  if (svgEl) svgEl.onclick = (e) => {
    e.stopPropagation();
    const r = svgEl.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD_L) / (W - PAD_L - PAD_R)) * (n - 1));
    c.pick = i < 0 || i >= n || c.pick === i ? null : i;
    draw();
  };
  c.onDraw?.();
}

function runs(vals, test) {
  const out = [];
  for (let i = 0; i < vals.length; ) {
    if (!test(vals[i])) { i++; continue; }
    let j = i;
    while (j + 1 < vals.length && test(vals[j + 1])) j++;
    out.push([i, j]);
    i = j + 1;
  }
  return out;
}

function statsText(data, targets) {
  return data.map((d, i) => {
    const p = d.peaks || [];
    const levels = p.filter((v) => v < NO_SIGNAL);
    const peak = levels.length ? toDb(Math.min(...levels)) : null;
    const clips = runs(p, (v) => v <= CLIP_RAW).length;
    const silent = p.filter((v) => v === NO_SIGNAL).length;
    const who = targets.length > 1 ? `${esc(targets[i].label)}: ` : "";
    return `${who}peak ${peak == null ? "none" : peak.toFixed(1) + " dBFS"}` +
      (clips ? ` · <span class="sev-text-critical">clipped ${clips}×</span>` : "") +
      (silent ? ` · silent ${durText(silent)}` : "");
  }).join("<br>");
}

function pickText(c) {
  if (c.pick == null) return "Click the chart to read a moment.";
  const end = c.data[0]?.end;
  if (end == null) return "";
  const t = new Date((end - (c.seconds - 1 - c.pick)) * 1000);
  const vals = c.data.map((d, i) => {
    const v = d.peaks?.[c.pick];
    const s = v == null || v === NO_READING ? "no reading" : v === NO_SIGNAL ? "silent" : `${toDb(v).toFixed(1)} dBFS`;
    return c.targets.length > 1 ? `${esc(c.targets[i].label)} ${s}` : s;
  });
  return `${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${vals.join(", ")}`;
}

export function durText(s) {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

// ---------- dropouts ----------
export async function fetchDropouts() {
  const r = await fetch("api/dropouts", { cache: "no-store" });
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}
export async function clearDropouts() {
  await fetch("api/dropouts/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}
