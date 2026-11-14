// Compare with preset: lays a Dante Controller preset (or a saved setup) over the
// network on screen. What the preset would route differently is drawn as dashed
// "ghost" wires, and the unit matcher pairs preset units with units on the network
// when the names don't line up.
//
// Read-only: nothing is sent to any device. Unit picks are kept in this browser only
// (localStorage), never in the repo.

import { parsePresetXml } from "./model.js";
import { matchUnits, comparePreset, candidatesFor, unitNotes } from "./compare.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

const KIND = {
  differs: { label: "differ", long: "Routed differently" },
  presetOnly: { label: "only in preset", long: "Only the preset routes these" },
  liveOnly: { label: "only on network", long: "Only the network routes these" },
  unplaced: { label: "can't show", long: "Can't be shown (unit or channel not on the network)" },
  same: { label: "same", long: "Same as the preset" },
};

let o = {};
let cmp = null;     // { preset, manual, matches, result, showGhosts }
let tab = "diff";
let filter = load("dv.cmp.filter", "all");

export function initCompare(opts) {
  o = opts;
  $("cmp-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) openCompareText(await f.text(), f.name);
    e.target.value = "";
  });
  $("cmp-close").onclick = closeCompare;
  $("cmp-ghosts").onchange = (e) => { if (!cmp) return; cmp.showGhosts = e.target.checked; save("dv.cmp.ghosts", cmp.showGhosts); o.redraw(); };
  $("cmp-units-btn").onclick = () => togglePanel("units");
  $("cmp-diff-btn").onclick = () => togglePanel("diff");
  $("cmp-panel").addEventListener("click", onPanelClick);
  $("cmp-panel").addEventListener("change", onPanelChange);
}

export const compareActive = () => !!cmp;
export const ghostRoutes = () => (cmp?.showGhosts ? cmp.result.ghosts : []);
// "differs" | "liveOnly" | "" for a route on the network.
export const liveMark = (routeId) => (cmp ? cmp.result.liveStatus.get(routeId) || "" : "");

// Open a preset (.xml) or a saved setup (.json, its network is used) to compare with.
export function openCompareText(text, filename = "") {
  try {
    let preset;
    if (text.trimStart().startsWith("{")) {
      const s = JSON.parse(text);
      if (!s?.network?.devices) throw new Error(`${filename || "This file"} isn't a preset or a Dante Visualizer setup.`);
      preset = { ...s.network, source: "preset", name: s.name || s.network.name || "Setup" };
    } else preset = parsePresetXml(text);
    if (!o.getModel()) throw new Error("Open the network (or a preset) first, then compare another preset with it.");
    cmp = { preset, manual: load(mapKey(preset), {}), showGhosts: load("dv.cmp.ghosts", true), matches: null, result: null };
    recompute();
    // Units that couldn't be matched by name: start in the matcher so they get looked at first.
    const byName = [...cmp.matches.values()].every((m) => m.how === "name" || m.how === "manual" || (m.how === "none" && m.manual));
    tab = byName ? "diff" : "units";
    showPanel(true);
    o.redraw();
  } catch (err) {
    o.status(err.message || String(err), true);
  }
}

export function closeCompare() {
  cmp = null;
  showPanel(false);
  $("cmp-bar").hidden = true;
  document.body.classList.remove("comparing");
  o.redraw();
}

// The network on screen changed (live update, or another file opened).
export function refreshCompare() {
  if (!cmp) return;
  recompute();
}

const mapKey = (preset) => `dv.unitmap.${preset.name}`;

function recompute() {
  const model = o.getModel();
  cmp.matches = matchUnits(cmp.preset, model, cmp.manual);
  cmp.result = comparePreset(cmp.preset, model, o.getRoutes(), cmp.matches);
  renderBar();
  if (!$("cmp-panel").hidden) renderPanel();
}

// ---------- bar ----------
function renderBar() {
  const bar = $("cmp-bar");
  bar.hidden = false;
  document.body.classList.add("comparing");
  const c = cmp.result.counts;
  const model = o.getModel();
  const against = model.source === "live" ? "the live network" : `“${model.name}”`;
  const units = [...cmp.matches.values()];
  const matched = units.filter((m) => m.live).length;
  const unsure = units.filter((m) => m.how === "suggested" || (m.how === "none" && !m.manual)).length;
  const pill = (kind) => `<button class="cmp-pill k-${kind}" data-filter="${kind}" ${c[kind] ? "" : "disabled"}><b>${c[kind]}</b> ${KIND[kind].label}</button>`;
  $("cmp-summary").innerHTML =
    `<span class="cmp-title">Preset <b>${esc(cmp.preset.name)}</b> vs ${esc(against)}</span>` +
    `<span class="cmp-pill k-same"><b>${c.same}</b> same</span>` +
    pill("differs") + pill("presetOnly") + pill("liveOnly") + (c.unplaced ? pill("unplaced") : "");
  $("cmp-units-btn").innerHTML = `Units ${matched}/${units.length}` + (unsure ? ` <span class="cmp-flag">${unsure} to check</span>` : "");
  $("cmp-ghosts").checked = cmp.showGhosts;
  bar.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { filter = b.dataset.filter; save("dv.cmp.filter", filter); tab = "diff"; showPanel(true); }));
}

// ---------- panel ----------
function togglePanel(which) {
  const open = !$("cmp-panel").hidden;
  if (open && tab === which) return showPanel(false);
  tab = which;
  showPanel(true);
}
function showPanel(open) {
  $("cmp-panel").hidden = !open;
  $("cmp-units-btn").setAttribute("aria-pressed", String(open && tab === "units"));
  $("cmp-diff-btn").setAttribute("aria-pressed", String(open && tab === "diff"));
  if (open) { o.closeOthers?.(); renderPanel(); }
}
export function hideComparePanel() { if (cmp) showPanel(false); }

function renderPanel() {
  if (!cmp) return;
  $("cmp-units-btn").setAttribute("aria-pressed", String(tab === "units"));
  $("cmp-diff-btn").setAttribute("aria-pressed", String(tab === "diff"));
  $("cmp-panel-body").innerHTML = tab === "units" ? unitsHtml() : diffHtml();
}

function diffHtml() {
  const items = cmp.result.items.filter((it) => it.kind !== "same" && (filter === "all" || it.kind === filter));
  const chips = ["all", "differs", "presetOnly", "liveOnly", "unplaced"]
    .filter((k) => k === "all" || cmp.result.counts[k])
    .map((k) => `<button data-setfilter="${k}" aria-pressed="${filter === k}">${k === "all" ? "All" : KIND[k].label}</button>`).join("");
  if (!items.length) {
    return `<h2>Differences</h2><div class="cmp-chips">${chips}</div>` +
      `<p class="cmp-good">${cmp.result.counts.same ? "Everything the preset routes is routed the same way here." : "Nothing to compare yet: match the preset's units first."}</p>` + readOnlyNote();
  }
  const byDev = new Map();
  for (const it of items) { if (!byDev.has(it.dstDevice)) byDev.set(it.dstDevice, []); byDev.get(it.dstDevice).push(it); }
  let html = `<h2>Differences</h2><div class="cmp-chips">${chips}</div>`;
  for (const [dev, list] of byDev) {
    list.sort((a, b) => a.dstChannel - b.dstChannel);
    html += `<h3>${esc(dev)} <span class="muted">${list.length}</span></h3><ul class="cmp-list">`;
    for (const it of list.slice(0, 200)) {
      const src = (s) => s ? `${esc(s.srcDevice)} out ${s.srcChannel ?? esc(s.srcChannelName)}` : `<span class="muted">nothing</span>`;
      const can = it.kind !== "unplaced";
      html += `<li class="k-${it.kind}${can ? " can" : ""}" ${can ? `data-dev="${esc(it.dstDevice)}" data-ch="${it.dstChannel}"` : ""}>
        <span class="cmp-dot"></span><div><b>in ${it.dstChannel}</b>
        ${it.kind === "unplaced" ? `<span class="muted">${esc(it.why)}</span>` :
          `<span class="muted">preset</span> ${src(it.want)} · <span class="muted">now</span> ${src(it.live)}`}</div></li>`;
    }
    if (list.length > 200) html += `<li class="muted">… and ${list.length - 200} more</li>`;
    html += `</ul>`;
  }
  return html + readOnlyNote();
}

function unitsHtml() {
  const model = o.getModel();
  const liveUsed = new Set();
  let rows = "";
  for (const p of cmp.preset.devices) {
    const m = cmp.matches.get(p.name);
    if (m.live) liveUsed.add(m.live);
    const l = m.live ? model.devices.find((d) => d.name === m.live) : null;
    const opts = candidatesFor(p, model).map((c) =>
      `<option value="${esc(c.name)}" ${c.name === m.live ? "selected" : ""}>${esc(c.name)}${c.model ? ` · ${esc(c.model)}` : ""}</option>`).join("");
    const badge = { name: ["ok", "same name"], manual: ["ok", "your pick"], suggested: ["check", m.tied ? "best guess, several fit" : "suggested"], none: [m.manual ? "off" : "missing", m.manual ? "not on this network" : "no match"] }[m.how];
    const notes = unitNotes(p, l);
    rows += `<li class="cmp-unit">
      <div class="cmp-unit-head"><b>${esc(p.name)}</b> <span class="cmp-badge b-${badge[0]}">${badge[1]}</span></div>
      <div class="muted">${esc([p.manufacturer, p.model].filter(Boolean).join(" "))} · ${p.rx.length} in / ${p.tx.length} out</div>
      <label class="cmp-pick"><span class="muted">is</span>
        <select data-unit="${esc(p.name)}"><option value="" ${m.live ? "" : "selected"}>Not on this network</option>${opts}</select></label>
      ${m.how === "suggested" ? `<div class="muted">Why: ${esc(m.why.join(", "))}</div>` : ""}
      ${notes.length ? `<div class="sev-text-warning">${esc(notes.join(" · "))}</div>` : ""}
    </li>`;
  }
  const extra = model.devices.filter((d) => !liveUsed.has(d.name));
  const anyManual = Object.keys(cmp.manual).length;
  const toCheck = [...cmp.matches.values()].filter((m) => m.how === "suggested").length;
  return `<h2>Match units</h2>
    <p class="muted">Pick which unit on this network plays each preset unit's part. The comparison and ghost wires follow your picks.</p>
    <div class="cmp-actions">
      ${toCheck ? `<button data-act="accept">Accept ${toCheck} suggestion${toCheck > 1 ? "s" : ""}</button>` : ""}
      ${anyManual ? `<button data-act="reset">Back to suggestions</button>` : ""}
    </div>
    <ul class="cmp-units">${rows}</ul>
    ${extra.length ? `<h3>On the network, not in the preset</h3><p>${extra.map((d) => esc(d.name)).join(", ")}</p>` : ""}
    ${readOnlyNote()}`;
}
const readOnlyNote = () => `<p class="cmp-note muted">Compare only: nothing is sent to the devices.</p>`;

function onPanelClick(e) {
  const t = e.target.closest("button, li.can");
  if (!t) return;
  if (t.id === "cmp-panel-close") return showPanel(false);
  if (t.dataset.setfilter) { filter = t.dataset.setfilter; save("dv.cmp.filter", filter); return renderPanel(); }
  if (t.dataset.act === "reset") { cmp.manual = {}; save(mapKey(cmp.preset), cmp.manual); return afterMatch(); }
  if (t.dataset.act === "accept") {
    for (const [p, m] of cmp.matches) if (m.how === "suggested") cmp.manual[p] = m.live;
    save(mapKey(cmp.preset), cmp.manual);
    return afterMatch();
  }
  if (t.dataset.dev) o.focusChannel(t.dataset.dev, +t.dataset.ch);
}
function onPanelChange(e) {
  const s = e.target.closest("select[data-unit]");
  if (!s) return;
  const p = s.dataset.unit, pick = s.value;
  // One network unit plays one preset unit: whoever had it loses it.
  if (pick) for (const [other, m] of cmp.matches) if (other !== p && m.live === pick) cmp.manual[other] = "";
  cmp.manual[p] = pick;
  save(mapKey(cmp.preset), cmp.manual);
  afterMatch();
}
function afterMatch() {
  recompute();
  renderPanel();
  o.redraw();
}

// ---------- for the trace card ----------
// One line on what the preset says about a clicked input or output.
export function compareLine(device, side, ch) {
  if (!cmp) return "";
  const r = cmp.result;
  if (side === "rx") {
    const it = r.items.find((x) => x.dstDevice === device && x.dstChannel === ch && x.kind !== "unplaced");
    if (!it) return "";
    if (it.kind === "same") return `<br><span class="cmp-line k-same">Preset: same</span>`;
    if (it.kind === "liveOnly") return `<br><span class="cmp-line k-liveOnly">Preset: not routed</span>`;
    return `<br><span class="cmp-line k-${it.kind}">Preset: ${esc(it.want.srcDevice)} out ${it.want.srcChannel ?? esc(it.want.srcChannelName)}</span>`;
  }
  const to = r.ghosts.filter((g) => g.srcDevice === device && g.srcChannel === ch);
  if (!to.length) return "";
  return `<br><span class="cmp-line k-presetOnly">Preset also sends it to:</span><br>` +
    to.map((g) => `⇢ ${esc(g.dstDevice)} in ${g.dstChannel}`).join("<br>");
}

export function ghostText(gs) {
  const g = gs[0];
  const one = (x) => `${esc(x.srcDevice)} out ${x.srcChannel ?? "?"} <span class="muted">${esc(x.srcChannelName || "")}</span> → ${esc(x.dstDevice)} in ${x.dstChannel}`;
  let html = `<b>Preset ${esc(cmp.preset.name)}</b><br>`;
  if (gs.length === 1) {
    html += one(g) + "<br>" + (g.live
      ? `<span class="muted">Now:</span> ${esc(g.live.srcDevice)} out ${g.live.srcChannel ?? "?"} <span class="muted">${esc(g.live.srcChannelName || "")}</span>`
      : `<span class="muted">Now: not routed</span>`);
    if (g.problem) html += `<br><span class="sev-text-warning">${esc(g.problem)}</span>`;
  } else {
    const differ = gs.filter((x) => x.live).length;
    html += `${esc(g.srcDevice)} → ${esc(g.dstDevice)} · ${gs.length} channel${gs.length > 1 ? "s" : ""}` +
      `<br><span class="muted">${gs.length - differ} not routed now${differ ? `, ${differ} routed from elsewhere now` : ""}</span>` +
      `<div class="trace-list">${gs.slice(0, 12).map((x) => `${x.srcChannel ?? "?"} → ${x.dstChannel}` + (x.live ? ` <span class="muted">(now ${esc(x.live.srcDevice)} ${x.live.srcChannel ?? "?"})</span>` : "")).join("<br>")}` +
      `${gs.length > 12 ? `<br><span class="muted">… and ${gs.length - 12} more</span>` : ""}</div>`;
  }
  return html + `<br><span class="muted">Preview only, nothing is sent.</span>`;
}
