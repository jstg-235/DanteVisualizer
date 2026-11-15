// Offline patching: a draft of patch changes on an offline view, a preset or a saved setup.
//
// Edit on a view that isn't the live network edits a draft. Nothing is sent: the draft only
// changes the picture on screen, where every changed input is marked (dashed amber wires and
// an amber row). The draft bar counts the changes and offers Undo, Discard and Push to live.
// Push maps the draft's units onto the live network (same names, or the unit matcher's picks
// from Compare), and sends only the inputs that differ from the network today, through the
// usual confirm card. Nothing reaches a device until Apply is pressed there.

import { matchUnits } from "./compare.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const key = (dev, ch) => `${dev}#${ch}`;

// changes: key -> { rxDevice, rxChannel, rxName, before: {device, channel, name}|null, after: same|null }
export const draft = { on: false, base: null, changes: new Map(), groups: [] };
let hooks = { model: () => null, redraw: () => {}, status: () => {}, push: async () => {} };

export function initDraft(h) {
  hooks = { ...hooks, ...h };
  $("draft-undo").onclick = () => undoDraft();
  $("draft-discard").onclick = () => discardDraft();
  $("draft-push").onclick = () => hooks.push();
  showBar();
}

export const isDrafted = (dev, ch) => draft.changes.has(key(dev, ch));

function rxOf(model, dev, ch) {
  const d = model?.devices.find((x) => x.name === dev);
  return d && d.rx.find((c) => c.id === ch);
}
function endOf(model, devName, chName) {
  if (!devName) return null;
  const d = model.devices.find((x) => x.name === devName);
  const t = d && (d.tx.find((c) => c.name === chName) || d.tx.find((c) => String(c.id) === String(chName)));
  return { device: devName, channel: t ? t.id : null, name: chName };
}

// Start (or keep) the draft for this view.
export function setDraftEditing(on) {
  const model = hooks.model();
  if (on && model && draft.base !== model.name) { draft.changes.clear(); draft.groups = []; draft.base = model.name; }
  draft.on = !!on;
  showBar();
}

// A new view was opened: keep the draft if it is the same network, else drop it.
// Called with the new model before it is drawn; puts the draft's changes on it.
export function onModel(model) {
  if (model.source !== "live" && draft.base && draft.base !== model.name) {
    draft.changes.clear(); draft.groups = []; draft.base = null; draft.on = false;
  }
  if (model.source === "live") draft.on = false;      // live edits go to the devices, not the draft
  else if (draft.base === model.name) for (const c of draft.changes.values()) put(model, c.rxDevice, c.rxChannel, c.after);
  showBar();
}

function put(model, dev, ch, end) {
  const c = rxOf(model, dev, ch);
  if (!c) return;
  c.subDevice = end ? end.device : "";
  c.subChannel = end ? end.name : "";
  c.state = end ? "draft" : null;
  c.stateLabel = end ? "Draft" : null;
}

// Apply changes ({rxDevice, rxChannel, txDevice, txChannel}) to the draft. Returns a result
// shaped like the server's, so the page reports it the same way.
export function draftPatch(changes, label) {
  const model = hooks.model();
  const group = [];
  const applied = [], failed = [];
  for (const ch of changes) {
    const rx = rxOf(model, ch.rxDevice, ch.rxChannel);
    if (!rx) { failed.push({ ...ch, error: "no such input" }); continue; }
    let after = null;
    if (ch.txDevice) {
      const d = model.devices.find((x) => x.name === ch.txDevice);
      const t = d?.tx.find((x) => x.id === Number(ch.txChannel));
      if (!t) { failed.push({ ...ch, error: "no such output" }); continue; }
      after = { device: d.name, channel: t.id, name: t.name };
    }
    const k = key(ch.rxDevice, ch.rxChannel);
    const prev = draft.changes.get(k);
    const now = { subDevice: rx.subDevice, subChannel: rx.subChannel, state: rx.state, stateLabel: rx.stateLabel };
    const before = prev ? prev.before : endOf(model, rx.subDevice, rx.subChannel);
    const same = (a, b) => (!a && !b) || (a && b && a.device === b.device && (a.channel === b.channel || a.name === b.name));
    if (same(endOf(model, rx.subDevice, rx.subChannel), after)) continue;
    group.push({ k, prev, now, rxDevice: ch.rxDevice, rxChannel: ch.rxChannel });
    if (same(before, after)) draft.changes.delete(k);
    else draft.changes.set(k, { rxDevice: ch.rxDevice, rxChannel: ch.rxChannel, rxName: rx.name, before, after });
    put(model, ch.rxDevice, ch.rxChannel, after);
    applied.push({ rxDevice: ch.rxDevice, rxChannel: ch.rxChannel, after });
  }
  if (group.length) draft.groups.push({ label, items: group });
  hooks.redraw();
  showBar();
  return { applied, failed };
}

export function undoDraft() {
  const g = draft.groups.pop();
  if (!g) return;
  const model = hooks.model();
  for (const it of [...g.items].reverse()) {
    if (it.prev) draft.changes.set(it.k, it.prev); else draft.changes.delete(it.k);
    const c = rxOf(model, it.rxDevice, it.rxChannel);
    if (c) Object.assign(c, it.now);
  }
  hooks.status(`Draft: undid ${g.label || "the last change"}`);
  hooks.redraw();
  showBar();
}

export function discardDraft() {
  while (draft.groups.length) undoDraft();
  draft.changes.clear();
  hooks.status("Draft discarded");
  showBar();
}

export function clearDraft() {
  draft.changes.clear(); draft.groups = []; draft.on = false; draft.base = null;
  showBar();
}

function showBar() {
  const bar = $("draft-bar");
  if (!bar) return;
  const n = draft.changes.size;
  bar.hidden = !n && !draft.on;
  $("draft-summary").innerHTML = n
    ? `<b>Draft</b> for ${esc(draft.base)}: ${n} input${n > 1 ? "s" : ""} changed · nothing sent yet`
    : `<b>Draft</b> for ${esc(draft.base || "this view")}: click an output then an input to patch, shift-click to cascade`;
  $("draft-undo").disabled = !draft.groups.length;
  $("draft-discard").disabled = !n;
  $("draft-push").disabled = !n;
}

// ---------- push ----------
// Turn the draft into changes for the live network: map units, keep only what differs.
export function planPush(live, picks = {}) {
  const base = hooks.model();
  const sameNames = [...draft.changes.values()].every((c) =>
    live.devices.some((d) => d.name === c.rxDevice) && (!c.after || live.devices.some((d) => d.name === c.after.device)));
  const map = sameNames ? null : matchUnits(base, live, picks);
  const to = (name) => (map ? map.get(name)?.live || null : name);
  const changes = [], skipped = [];
  for (const c of draft.changes.values()) {
    const rxDev = to(c.rxDevice);
    const txDev = c.after ? to(c.after.device) : "";
    if (!rxDev || (c.after && !txDev)) {
      skipped.push(`${c.rxDevice} in ${c.rxChannel}: ${!rxDev ? c.rxDevice : c.after.device} isn't matched to a unit on the live network`);
      continue;
    }
    const ld = live.devices.find((d) => d.name === rxDev);
    if (!ld?.rx.some((x) => x.id === c.rxChannel)) { skipped.push(`${rxDev} has no input ${c.rxChannel}`); continue; }
    if (c.after) {
      const td = live.devices.find((d) => d.name === txDev);
      if (!td?.tx.some((x) => x.id === c.after.channel)) { skipped.push(`${txDev} has no output ${c.after.channel}`); continue; }
    }
    changes.push({ rxDevice: rxDev, rxChannel: c.rxChannel, txDevice: txDev, txChannel: c.after ? c.after.channel : null });
  }
  return { changes, skipped, mapped: !!map };
}
