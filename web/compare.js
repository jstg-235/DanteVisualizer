// Preset vs live: the shared logic behind preset preview (ghost wires) and the unit matcher.
//
// Read-only: this only works out how a preset differs from the network on screen.
// Nothing here talks to devices. The unit map it builds (preset unit -> network unit)
// is the same map later steps (offline patching) will use to turn a preset into patches.

import { buildRoutes } from "./model.js";

// ---------- unit matching ----------
const norm = (s) => String(s || "").toLowerCase().replace(/\d+/g, (n) => String(+n)).replace(/[^a-z0-9]+/g, "");
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); }
  return out;
}
// Dice similarity of two names, 0..1, ignoring case, punctuation and leading zeros.
export function nameSimilarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let both = 0;
  for (const [k, n] of A) both += Math.min(n, B.get(k) || 0);
  const total = Math.max(1, x.length - 1 + y.length - 1);
  return (2 * both) / total;
}
// Channel labels that say something (not just "01" or "3").
const realLabels = (list) => new Set(list.map((c) => c.name).filter((n) => n && !/^\d+$/.test(n)).map((n) => n.toLowerCase()));

// How well a network unit fits a preset unit, with the reasons. Higher is better.
export function unitScore(p, l) {
  let score = 0;
  const why = [];
  const sim = nameSimilarity(p.name, l.name);
  if (sim === 1) { score += 60; why.push("same name"); }
  else if (sim >= 0.5) { score += Math.round(sim * 30); why.push("similar name"); }
  const pm = (p.model || "").toLowerCase(), lm = (l.model || "").toLowerCase();
  if (pm && lm && pm === lm) { score += 35; why.push("same model"); }
  else if (pm && lm) score -= 25;
  if (p.tx.length === l.tx.length && p.rx.length === l.rx.length) { score += 15; why.push("same channel count"); }
  else score -= Math.min(20, Math.abs(p.tx.length - l.tx.length) + Math.abs(p.rx.length - l.rx.length));
  const pl = new Set([...realLabels(p.tx), ...realLabels(p.rx)]);
  if (pl.size) {
    const ll = new Set([...realLabels(l.tx), ...realLabels(l.rx)]);
    const hit = [...pl].filter((x) => ll.has(x)).length / pl.size;
    if (hit >= 0.5) { score += Math.round(hit * 20); why.push("same channel labels"); }
  }
  return { score, why };
}

const SUGGEST_AT = 45;   // below this a network unit isn't suggested at all

// Match every preset unit to at most one network unit (and vice versa).
// manual: { presetName: networkName | "" } — the user's own picks ("" = not on this network).
// Returns Map presetName -> { live: name | null, how: "name" | "manual" | "suggested" | "none", why: [], tied }.
export function matchUnits(preset, live, manual = {}) {
  const out = new Map();
  const taken = new Set();
  const liveByName = new Map(live.devices.map((d) => [d.name, d]));
  // 1. The user's picks win.
  for (const p of preset.devices) {
    if (!(p.name in manual)) continue;
    const pick = manual[p.name];
    if (pick && liveByName.has(pick) && !taken.has(pick)) {
      out.set(p.name, { live: pick, how: "manual", why: ["your pick"] });
      taken.add(pick);
    } else if (pick === "") out.set(p.name, { live: null, how: "none", why: ["you marked it as not on this network"], manual: true });
  }
  // 2. Exact same name.
  for (const p of preset.devices) {
    if (out.has(p.name) || !liveByName.has(p.name) || taken.has(p.name)) continue;
    out.set(p.name, { live: p.name, how: "name", why: ["same name"] });
    taken.add(p.name);
  }
  // 3. Best remaining fits, best first.
  const pairs = [];
  for (const p of preset.devices) {
    if (out.has(p.name)) continue;
    for (const l of live.devices) {
      if (taken.has(l.name)) continue;
      const s = unitScore(p, l);
      if (s.score >= SUGGEST_AT) pairs.push({ p: p.name, l: l.name, ...s });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.p.localeCompare(b.p) || a.l.localeCompare(b.l));
  for (const x of pairs) {
    if (out.has(x.p) || taken.has(x.l)) continue;
    // Several network units fit equally well (e.g. ten identical stage boxes): flag it.
    const tied = pairs.some((y) => y.p === x.p && y.l !== x.l && y.score === x.score && !taken.has(y.l));
    out.set(x.p, { live: x.l, how: "suggested", why: x.why, tied });
    taken.add(x.l);
  }
  for (const p of preset.devices) if (!out.has(p.name)) out.set(p.name, { live: null, how: "none", why: ["no unit on this network fits"] });
  return out;
}

// Network units a preset unit could be matched to, best fit first (for the matcher's menus).
export function candidatesFor(p, live) {
  return live.devices
    .map((l) => ({ name: l.name, model: l.model, ...unitScore(p, l) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// Differences between a preset unit and the network unit it's matched to, in words.
export function unitNotes(p, l) {
  if (!l) return [];
  const notes = [];
  if (p.model && l.model && p.model.toLowerCase() !== l.model.toLowerCase()) notes.push(`different model (${l.model})`);
  if (l.rx.length < p.rx.length) notes.push(`fewer inputs (${l.rx.length} vs ${p.rx.length})`);
  if (l.tx.length < p.tx.length) notes.push(`fewer outputs (${l.tx.length} vs ${p.tx.length})`);
  if (p.sampleRate && l.sampleRate && p.sampleRate !== l.sampleRate) notes.push(`${l.sampleRate / 1000} kHz, preset says ${p.sampleRate / 1000} kHz`);
  return notes;
}

// ---------- routes ----------
// The preset's routes, written in network names: each preset route becomes the
// network input it would land on and the network output it would come from.
// Channels keep their numbers (a matched unit is the same kind of unit). A route
// whose source isn't in the preset is looked up on the network by name.
export function translatePreset(preset, live, matches) {
  const liveByName = new Map(live.devices.map((d) => [d.name, d]));
  const out = [];
  for (const r of buildRoutes(preset)) {
    const dstLive = matches.get(r.dstDevice)?.live || null;
    const srcMatch = matches.get(r.srcDevice);
    const srcLive = srcMatch ? srcMatch.live : (liveByName.has(r.srcDevice) ? r.srcDevice : null);
    const dstDev = dstLive && liveByName.get(dstLive);
    const srcDev = srcLive && liveByName.get(srcLive);
    const rx = dstDev?.rx.find((c) => c.id === r.dstChannel);
    let tx = null;
    if (srcDev) {
      tx = (r.srcChannel != null && srcDev.tx.find((c) => c.id === r.srcChannel)) ||
           srcDev.tx.find((c) => c.name === r.srcChannelName) ||
           srcDev.tx.find((c) => String(c.id) === r.srcChannelName) || null;
    }
    let problem = "";
    if (!dstLive) problem = `${r.dstDevice} isn't matched to a unit on this network`;
    else if (!rx) problem = `${dstLive} has no input ${r.dstChannel}`;
    else if (!srcLive) problem = `source ${r.srcDevice} isn't on this network`;
    else if (!tx) problem = `${srcLive} has no output ${r.srcChannel ?? r.srcChannelName}`;
    out.push({
      preset: r,
      dstDevice: dstLive || r.dstDevice,
      dstChannel: r.dstChannel,
      dstChannelName: rx?.name ?? r.dstChannelName,
      srcDevice: srcLive || r.srcDevice,
      srcChannel: tx ? tx.id : null,
      srcChannelName: tx ? tx.name : r.srcChannelName,
      placeable: !!rx,          // there's an input on the network to draw it into
      problem,
    });
  }
  return out;
}

// Compare the preset with the network, input by input.
// kind: "same" | "differs" (both route it, from different sources) | "presetOnly" (only the preset routes it)
//       | "liveOnly" (only the network routes it; only on units that are in the preset) | "unplaced" (can't be shown)
export function comparePreset(preset, live, liveRoutes, matches) {
  const want = translatePreset(preset, live, matches);
  const liveByDst = new Map(liveRoutes.map((r) => [`${r.dstDevice}#${r.dstChannel}`, r]));
  const items = [];
  const seen = new Set();
  for (const w of want) {
    if (!w.placeable) { items.push({ kind: "unplaced", want: w, live: null, dstDevice: w.dstDevice, dstChannel: w.dstChannel, why: w.problem }); continue; }
    const key = `${w.dstDevice}#${w.dstChannel}`;
    seen.add(key);
    const r = liveByDst.get(key) || null;
    let kind;
    if (!r) kind = "presetOnly";
    else if (r.srcDevice === w.srcDevice && (r.srcChannel != null && w.srcChannel != null ? r.srcChannel === w.srcChannel : r.srcChannelName === w.srcChannelName)) kind = "same";
    else kind = "differs";
    items.push({ kind, want: w, live: r, dstDevice: w.dstDevice, dstChannel: w.dstChannel, why: w.problem });
  }
  // Inputs the network routes but the preset leaves empty, on units the preset covers.
  const covered = new Set([...matches.values()].map((m) => m.live).filter(Boolean));
  for (const r of liveRoutes) {
    const key = `${r.dstDevice}#${r.dstChannel}`;
    if (!covered.has(r.dstDevice) || seen.has(key)) continue;
    items.push({ kind: "liveOnly", want: null, live: r, dstDevice: r.dstDevice, dstChannel: r.dstChannel, why: "" });
  }
  const counts = { same: 0, differs: 0, presetOnly: 0, liveOnly: 0, unplaced: 0 };
  for (const it of items) counts[it.kind]++;
  // Ghost wires: what the preset would route where the network doesn't already do the same.
  const ghosts = items.filter((it) => it.kind === "differs" || it.kind === "presetOnly").map((it) => ({
    id: `ghost:${it.dstDevice}#${it.dstChannel}`,
    ghost: true,
    kind: it.kind,
    srcDevice: it.want.srcDevice,
    srcChannel: it.want.srcChannel,
    srcChannelName: it.want.srcChannelName,
    dstDevice: it.dstDevice,
    dstChannel: it.dstChannel,
    dstChannelName: it.want.dstChannelName,
    missing: it.want.srcChannel == null,          // source not on the network: drawn as a stub
    problem: it.want.problem,
    live: it.live,
  }));
  // How each network route stands against the preset (for marking live wires).
  const liveStatus = new Map();
  for (const it of items) if (it.live && it.kind !== "same") liveStatus.set(it.live.id, it.kind);
  return { items, counts, ghosts, liveStatus };
}
