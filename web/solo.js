// Solo: listen to a channel by patching it to the monitor output chosen for this network.
// Works with Edit off, but the server only lets it touch the monitor output's inputs.
// Choosing the monitor output needs Edit mode. Everything opens on click, never on hover.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const solo = { available: false, network: null, output: null, active: null };
let hooks = { model: () => null, editOn: () => false, status: () => {}, changed: () => {} };
let timer = null;
let busy = false;

export function initSolo(h) {
  hooks = { ...hooks, ...h };
  $("btn-solo").onclick = (e) => { e.stopPropagation(); togglePop(); };
  document.addEventListener("pointerdown", (e) => {
    const pop = $("solo-pop");
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $("btn-solo") && !$("btn-solo").contains(e.target)) pop.hidden = true;
  });
  refresh();
}

export async function refresh() {
  clearTimeout(timer);
  try {
    const res = await fetch("api/solo", { cache: "no-store" });
    show(res.ok ? await res.json() : { available: false });
  } catch { show({ available: false }); }
  timer = setTimeout(refresh, 5000);
}

const srcText = (srcs) => srcs.map((s) => `${s.txDevice} out ${s.txChannel}`).join(" + ")
  .replace(/^(.*) out (\d+) \+ \1 out (\d+)$/, "$1 out $2/$3");
const outText = (o) => o ? `${o.device} in ${o.left}${o.mode === "mono" ? " (mono)" : ` / ${o.right}`}` : "";

function show(s) {
  Object.assign(solo, { available: false, output: null, active: null }, s);
  const b = $("btn-solo");
  b.hidden = !solo.available;
  b.classList.toggle("on", !!solo.active);
  b.querySelector(".solo-label").textContent = solo.active ? `Solo · ${srcText(solo.active.sources)}` : "Solo";
  b.title = solo.active ? `Soloing to ${outText(solo.output)}. Click for Unsolo.`
    : solo.output ? `Monitor output: ${outText(solo.output)}. Click a channel or wire, then Solo.`
    : "No monitor output chosen yet for this network. Click to set one (needs Edit).";
  // The 5 s refresh re-draws an open popover. Leave it alone while the monitor output form
  // has focus (an open dropdown would close); the picks themselves live in pop.dataset.
  const pop = $("solo-pop");
  if (!pop.hidden && !pop.querySelector(".solo-form")?.contains(document.activeElement)) renderPop();
}

// What's being picked in the monitor output form but not saved yet.
function clearPicks(pop) {
  for (const k of ["dev", "mode", "left", "right"]) delete pop.dataset[k];
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch {}
  if ("output" in data) show(data);
  return { status: res.status, data };
}

async function run(path, body, okText) {
  if (busy) return;
  busy = true;
  try {
    const { status, data } = await post(path, body);
    if (status !== 200) hooks.status(data.error || `Refused (HTTP ${status})`, true);
    else {
      const bad = data.failed || [];
      hooks.status(okText + (bad.length ? ` · ${bad.length} not changed: ${bad[0].error}` : ""), bad.length > 0);
    }
  } catch (e) {
    hooks.status(`Solo failed: ${e.message}`, true);
  } finally {
    busy = false;
    hooks.changed();
    refresh();
  }
}

export const soloOn = (sources) => run("api/solo", { sources }, `Solo: ${srcText(sources)} → ${outText(solo.output)}`);
export const soloOff = () => run("api/solo/off", {}, "Unsolo: monitor output put back");

// ---------- the header popover: what's soloed, Unsolo, and (in Edit mode) the monitor output ----------
function togglePop() {
  const pop = $("solo-pop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) { clearPicks(pop); renderPop(); }
}

function renderPop() {
  const pop = $("solo-pop");
  const model = hooks.model();
  const edit = hooks.editOn();
  let html = `<button class="close" aria-label="Close">×</button><h3>Solo</h3>`;
  if (solo.active) html += `<p><b>${esc(srcText(solo.active.sources))}</b> → ${esc(outText(solo.output))}</p><p><button id="solo-off" class="solo-off">Unsolo</button> <span class="muted">puts back what the monitor output had</span></p>`;
  else html += `<p class="muted">${solo.output ? "Nothing soloed. Click a channel or wire, then <b>Solo</b> on its card." : "Choose a monitor output first."}</p>`;
  html += `<h3>Monitor output</h3>`;
  if (!edit) {
    html += `<p>${solo.output ? esc(outText(solo.output)) : `<span class="muted">Not set for ${esc(solo.network || "this network")}.</span>`}</p>` +
      `<p class="muted">Turn on <b>Edit</b> to choose or change it.</p>`;
  } else if (solo.active) {
    html += `<p>${esc(outText(solo.output))}</p><p class="muted">Unsolo before changing it.</p>`;
  } else {
    const o = solo.output || {};
    const devs = (model?.devices || []).filter((d) => d.rx.length);
    const dev = devs.find((d) => d.name === (pop.dataset.dev || o.device)) || devs[0];
    const chOpts = (sel) => (dev?.rx || []).map((c) => `<option value="${c.id}"${c.id === sel ? " selected" : ""}>in ${c.id}${c.name && c.name !== String(c.id) ? " · " + esc(c.name) : ""}</option>`).join("");
    const same = dev && dev.name === o.device;
    const mode = pop.dataset.mode || o.mode || "stereo";
    const has = (id) => dev?.rx.some((c) => c.id === id);
    const pick = (k) => (pop.dataset[k] ? Number(pop.dataset[k]) : null);
    let left = pick("left") ?? (same ? o.left : dev?.rx[0]?.id);
    if (!has(left)) left = dev?.rx[0]?.id;
    // Right defaults to the input after left (89 -> 90), not to input 2.
    let right = pick("right") ?? (same && o.right && pick("left") == null ? o.right : null);
    if (!has(right) || right === left) {
      const i = dev ? dev.rx.findIndex((c) => c.id === left) : -1;
      right = dev?.rx.find((c) => c.id === left + 1)?.id ?? dev?.rx[i + 1]?.id ?? dev?.rx.find((c) => c.id !== left)?.id;
    }
    html += `<div class="solo-form">
      <label>Device <select id="so-dev">${devs.map((d) => `<option${d === dev ? " selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label>
      <div class="seg" role="group" aria-label="Stereo or mono"><button id="so-st" aria-pressed="${mode === "stereo"}">Stereo</button><button id="so-mo" aria-pressed="${mode === "mono"}">Mono</button></div>
      <label>${mode === "mono" ? "Speaker" : "Left"} <select id="so-l">${chOpts(left)}</select></label>
      ${mode === "mono" ? "" : `<label>Right <select id="so-r">${chOpts(right)}</select></label>`}
      <p class="muted">A mono source plays on both sides (dual mono).</p>
      <p><button id="so-save" class="primary">Save for ${esc(solo.network || "this network")}</button>${solo.output ? ` <button id="so-clear">Clear</button>` : ""}</p>
    </div>`;
  }
  pop.innerHTML = html;
  pop.querySelector(".close").onclick = () => { pop.hidden = true; };
  const q = (id) => pop.querySelector("#" + id);
  if (q("solo-off")) q("solo-off").onclick = () => soloOff();
  if (q("so-dev")) {
    q("so-dev").onchange = () => { pop.dataset.dev = q("so-dev").value; delete pop.dataset.left; delete pop.dataset.right; renderPop(); };
    q("so-l").onchange = () => {
      pop.dataset.left = q("so-l").value;
      if (q("so-r") && !pop.dataset.right) { delete pop.dataset.right; renderPop(); }   // move right along with left
    };
    if (q("so-r")) q("so-r").onchange = () => { pop.dataset.right = q("so-r").value; };
    q("so-st").onclick = () => { pop.dataset.mode = "stereo"; renderPop(); };
    q("so-mo").onclick = () => { pop.dataset.mode = "mono"; renderPop(); };
    q("so-save").onclick = async () => {
      const m = pop.dataset.mode || solo.output?.mode || "stereo";
      const { status, data } = await post("api/solo/output", { device: q("so-dev").value, mode: m, left: Number(q("so-l").value), right: q("so-r") ? Number(q("so-r").value) : null });
      if (status !== 200) hooks.status(data.error || "Couldn't save the monitor output", true);
      else { hooks.status(`Monitor output: ${outText(data.output)}`); clearPicks(pop); }
      renderPop();
    };
    if (q("so-clear")) q("so-clear").onclick = async () => { await post("api/solo/output", { clear: true }); clearPicks(pop); renderPop(); };
  }
}

// ---------- the Solo buttons on a click card ----------
// src: the output to listen to ({device, ch}), from a clicked output, input (its source) or wire.
export function mountSoloControls(slot, model, src) {
  if (!slot) return;
  if (!solo.available || !src) { slot.remove(); return; }
  if (!solo.output) {
    slot.innerHTML = `<p class="muted">Solo: choose a monitor output first (Solo button, top right).</p>`;
    return;
  }
  const dev = model.devices.find((d) => d.name === src.device);
  const next = dev?.tx.find((t) => t.id === src.ch + 1);
  const stereo = solo.output.mode !== "mono";
  const playing = solo.active?.sources?.some((s) => s.txDevice === src.device && s.txChannel === src.ch);
  slot.innerHTML = `<div class="solo-row"><button class="solo-one">🎧 Solo ${esc(src.device)} out ${src.ch}</button>` +
    (stereo && next ? `<button class="solo-pair">Solo pair ${src.ch}/${src.ch + 1}</button>` : "") +
    (solo.active ? `<button class="solo-un">Unsolo</button>` : "") + `</div>` +
    (playing ? `<p class="muted">Soloing now.</p>` : "");
  slot.querySelector(".solo-one").onclick = () => soloOn([{ txDevice: src.device, txChannel: src.ch }]);
  const pair = slot.querySelector(".solo-pair");
  if (pair) pair.onclick = () => soloOn([{ txDevice: src.device, txChannel: src.ch }, { txDevice: src.device, txChannel: src.ch + 1 }]);
  const un = slot.querySelector(".solo-un");
  if (un) un.onclick = () => soloOff();
}
