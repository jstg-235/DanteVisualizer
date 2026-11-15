// Edit mode and patching.
//
// The app is read-only unless Edit is on. The server holds Edit mode (see server/patching.py),
// so this page only shows it and asks for it: the server refuses any patch while it is off,
// turns it off by itself after a few minutes with no patching, when the network changes, or
// when the daemon disconnects. Changes that remove or replace a patch, or more than one
// change at once, come back from the server as a plan, shown here on a confirm card, and are
// only sent again once the person presses Apply. Every change can be undone (Undo, or ⌘Z).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const edit = { available: false, on: false, remaining: 0, network: null, undo: 0, undoLabel: null, demo: false };
let hooks = { canEdit: () => false, changed: () => {}, status: () => {} };
let timer = null;
let busy = false;

export function initEdit(h) {
  hooks = { ...hooks, ...h };
  $("btn-edit").onclick = () => setEdit(!edit.on);
  $("btn-undo").onclick = () => undo();
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && edit.on && !e.target.closest("input, textarea, select")) {
      e.preventDefault();
      undo();
    }
  });
  refresh();
}

// Read Edit mode from the server: every 5 s, every second while it's on (for the countdown).
export async function refresh() {
  clearTimeout(timer);
  try {
    const res = await fetch("api/edit", { cache: "no-store" });
    if (res.ok) show(await res.json());
    else show({ available: false, on: false });
  } catch {
    show({ available: false, on: false });
  }
  timer = setTimeout(refresh, edit.on ? 1000 : 5000);
}

function show(s) {
  const was = edit.on;
  Object.assign(edit, s);
  const canEdit = edit.available && hooks.canEdit();
  const b = $("btn-edit");
  b.hidden = !edit.available;
  b.disabled = !edit.on && !canEdit;
  b.classList.toggle("on", edit.on);
  b.setAttribute("aria-pressed", String(edit.on));
  const m = Math.floor(edit.remaining / 60), sec = String(edit.remaining % 60).padStart(2, "0");
  b.querySelector(".edit-label").textContent = edit.on ? `Editing · ${m}:${sec}` : "Edit";
  b.title = edit.on
    ? `Patching is on for ${edit.network}. It turns off after ${Math.round(edit.idleLimit / 60)} minutes with no patching. Click to stop editing.`
    : canEdit ? "Read-only. Click to allow patching on the live network."
    : "Patching works only while following the live network.";
  const u = $("btn-undo");
  u.hidden = !edit.on;
  u.disabled = !edit.undo || busy;
  u.title = edit.undo ? `Undo ${edit.undoLabel} (⌘Z)` : "Nothing to undo";
  document.body.classList.toggle("editing", edit.on);
  $("edit-banner").hidden = !edit.on;
  $("edit-banner-text").textContent = `EDITING · ${edit.network || ""} · ` +
    (edit.demo ? "pretend changes, demo only" : "changes go straight to the devices");
  if (was && !edit.on) {
    hooks.status(edit.offReason && edit.offReason !== "turned off" ? `Edit mode off: ${edit.offReason}` : "Edit mode off");
  }
  if (was !== edit.on) hooks.changed();
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (data.edit) show(data.edit);
  return { status: res.status, data };
}

export async function setEdit(on) {
  if (on && !hooks.canEdit()) return;
  const { status, data } = await post("api/edit", { on });
  if (status !== 200) hooks.status(data.error || "Couldn't change Edit mode", true);
  else show(data);
  refresh();
}

// Turn Edit off without asking (going offline, opening a preset).
export function leaveEdit() { if (edit.on) setEdit(false); }

// ---------- patching ----------
const endText = (e) => e ? `${esc(e.device)} out ${e.channel ?? "?"}${e.name && String(e.name) !== String(e.channel) ? ` <span class="muted">${esc(e.name)}</span>` : ""}` : `<span class="muted">nothing</span>`;

export async function patch(changes, label) {
  if (!edit.on || busy) return null;
  busy = true;
  try {
    let { status, data } = await post("api/patch", { changes, label });
    if (status === 409 && data.needsConfirm) {
      const ok = await confirmCard(data.changes, label);
      if (!ok) { hooks.status("Nothing changed"); return null; }
      ({ status, data } = await post("api/patch", { changes, label, confirmed: true }));
    }
    report(status, data, "Patched");
    return data;
  } catch (e) {
    hooks.status(`Patch failed: ${e.message}`, true);
    return null;
  } finally {
    busy = false;
    hooks.changed();
    refresh();
  }
}

export async function undo() {
  if (!edit.on || !edit.undo || busy) return;
  busy = true;
  try {
    const { status, data } = await post("api/patch/undo", {});
    report(status, data, "Undid");
  } catch (e) {
    hooks.status(`Undo failed: ${e.message}`, true);
  } finally {
    busy = false;
    hooks.changed();
    refresh();
  }
}

function report(status, data, verb) {
  if (status !== 200) return hooks.status(data.error || `Refused (HTTP ${status})`, true);
  const n = data.applied?.length || 0, bad = data.failed || [];
  const unseen = (data.applied || []).filter((i) => i.seen === false).length;
  if (!n && !bad.length) return hooks.status(data.note || "Nothing to change");
  let msg = `${verb} ${n} input${n === 1 ? "" : "s"}`;
  if (unseen) msg += ` (${unseen} not showing on the network yet)`;
  if (bad.length) msg += ` · ${bad.length} failed: ${bad[0].rxDevice} in ${bad[0].rxChannel}: ${bad[0].error}`;
  hooks.status(msg, bad.length > 0);
}

// The confirm card: every change as "input: before → after", with what's at risk flagged.
function confirmCard(items, label) {
  return new Promise((resolve) => {
    const dlg = $("confirm");
    const live = items.filter((i) => i.signal).length;
    const removes = items.filter((i) => i.kind === "unpatch").length;
    const replaces = items.filter((i) => i.kind === "replace").length;
    const warn = [];
    if (live) warn.push(`<b class="sev-text-critical">${live} input${live > 1 ? "s are" : " is"} carrying signal now</b>`);
    if (removes) warn.push(`${removes} unpatch${removes > 1 ? "es" : ""}`);
    if (replaces) warn.push(`${replaces} replace${replaces > 1 ? "" : "s"} an existing patch`);
    const rows = items.slice(0, 200).map((i) =>
      `<tr class="${i.signal ? "sig" : ""}"><td><b>${esc(i.rxDevice)}</b> in ${i.rxChannel} <span class="muted">${esc(i.rxName)}</span></td>` +
      `<td>${endText(i.before)}</td><td>→</td><td>${endText(i.after)}</td>` +
      `<td>${i.signal ? '<span class="sig-tag">signal</span>' : ""}</td></tr>`).join("");
    $("confirm-body").innerHTML =
      `<h2>${esc(label ? label[0].toUpperCase() + label.slice(1) : "Apply these changes?")}</h2>` +
      `<p class="muted">${items.length} change${items.length > 1 ? "s" : ""} to ${esc(edit.network || "the live network")}${warn.length ? " · " + warn.join(" · ") : ""}. You can undo it afterwards.</p>` +
      `<div class="confirm-table"><table><thead><tr><th>Input</th><th>Now</th><th></th><th>After</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
      (items.length > 200 ? `<p class="muted">… and ${items.length - 200} more</p>` : "") + `</div>`;
    $("confirm-ok").textContent = `Apply ${items.length} change${items.length > 1 ? "s" : ""}`;
    const done = (ok) => { dlg.close(); resolve(ok); };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
    $("confirm-cancel").focus();   // Return/Space doesn't patch by accident
  });
}

// ---------- the patch controls on an input's click card (Edit mode only) ----------
// "Patch from" lists every output on the network; "Unpatch" removes the patch.
export function mountPatchControls(slot, model, device, ch, route) {
  if (!edit.on || !slot) { if (slot) slot.remove(); return; }
  const dev = model.devices.find((d) => d.name === device);
  const opts = model.devices.filter((d) => d.tx.length && d.online !== false).map((d) =>
    `<optgroup label="${esc(d.name)}">` + d.tx.map((t) =>
      `<option value="${esc(d.name)}|${t.id}"${route && route.srcDevice === d.name && route.srcChannel === t.id ? " selected" : ""}>${esc(d.name)} out ${t.id}${t.name && t.name !== String(t.id) ? " · " + esc(t.name) : ""}</option>`).join("") +
    `</optgroup>`).join("");
  slot.innerHTML = `<div class="patch-row"><label>Patch from <select class="patch-src"><option value="">Choose an output…</option>${opts}</select></label>` +
    (route ? `<button class="patch-un">Unpatch</button>` : "") + `</div>`;
  if (dev?.online === false) { slot.innerHTML = `<p class="muted">Offline: can't patch.</p>`; return; }
  const sel = slot.querySelector(".patch-src");
  sel.onchange = () => {
    if (!sel.value) return;
    const [txDevice, txChannel] = [sel.value.slice(0, sel.value.lastIndexOf("|")), Number(sel.value.slice(sel.value.lastIndexOf("|") + 1))];
    patch([{ rxDevice: device, rxChannel: ch, txDevice, txChannel }],
      `patch ${txDevice} out ${txChannel} to ${device} in ${ch}`);
  };
  const un = slot.querySelector(".patch-un");
  if (un) un.onclick = () => patch([{ rxDevice: device, rxChannel: ch, txDevice: "" }], `unpatch ${device} in ${ch}`);
}
