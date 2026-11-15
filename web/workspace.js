// Workspaces: one per Dante network. The server recognises the network from its devices and
// asks (in the bar under the toolbar) before switching; it never switches by itself.
// The Workspace button opens a card to rename, clear, start a new one, forget a missing
// device, switch to another or delete one. Everything opens on click, never on hover.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const ws = { active: null, suggest: null, workspaces: [], online: 0, settling: null, demo: false };
let hooks = { live: () => false, status: () => {}, changed: () => {} };
let timer = null;
let busy = false;
let armed = null;          // a button waiting for its second click: { id, until }

export function initWorkspace(h) {
  hooks = { ...hooks, ...h };
  $("btn-ws").onclick = (e) => { e.stopPropagation(); togglePop(); };
  document.addEventListener("pointerdown", (e) => {
    const pop = $("ws-pop");
    if (!pop.hidden && !pop.contains(e.target) && !$("btn-ws").contains(e.target)) pop.hidden = true;
  });
  // The Mac app's File menu clicks these.
  $("ws-menu-new").onclick = () => openPop("new");
  $("ws-menu-clear").onclick = () => openPop("clear");
  $("ws-menu-list").onclick = () => openPop();
  refresh();
}

export async function refresh() {
  clearTimeout(timer);
  if (hooks.live()) {
    try {
      const res = await fetch("api/workspace", { cache: "no-store" });
      show(res.ok ? await res.json() : null);
    } catch { show(null); }
  } else show(null);
  timer = setTimeout(refresh, 3000);
}

function show(s) {
  const was = ws.active?.id;
  Object.assign(ws, { active: null, suggest: null, workspaces: [], online: 0, settling: null }, s || {});
  const b = $("btn-ws");
  b.hidden = !ws.active;
  if (ws.active) {
    b.querySelector(".ws-label").textContent = ws.active.name;
    const miss = ws.active.expected - ws.active.matched;
    b.classList.toggle("missing", miss > 0);
    b.title = `Workspace for this network: ${ws.active.matched} of ${ws.active.expected} devices online` +
      (miss ? ` (${miss} missing)` : "") + ". Click to rename, clear or switch.";
  }
  renderBar();
  const pop = $("ws-pop");
  if (!pop.hidden && !pop.contains(document.activeElement)) renderPop();
  if (was && ws.active && ws.active.id !== was) hooks.changed(ws.active);
}

async function post(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function run(path, body, okText) {
  if (busy) return null;
  busy = true;
  try {
    const { status, data } = await post(path, body);
    if (status !== 200) { hooks.status(data.error || `Refused (HTTP ${status})`, true); return null; }
    if (okText) hooks.status(typeof okText === "function" ? okText(data) : okText, false);
    if ("workspaces" in data) show(data);
    return data;
  } catch (e) {
    hooks.status(`Workspace: ${e.message}`, true);
    return null;
  } finally {
    busy = false;
    refresh();
  }
}

const unsoloText = (d) => {
  const u = d.unsolo;
  if (!u) return "";
  if (u.error) return ` · couldn't unsolo: ${u.error}`;
  return u.failed?.length ? ` · unsolo: ${u.failed.length} input${u.failed.length > 1 ? "s" : ""} not put back (${u.failed[0].error})` : " · unsoloed first";
};

export function switchTo(id, name) {
  return run("api/workspace/switch", { id }, (d) => `Switched to ${name || d.workspace?.name}${unsoloText(d)}`);
}
function startNew(name) {
  return run("api/workspace/switch", { new: true, name }, (d) => `Started a workspace for ${d.workspace?.name}${unsoloText(d)}`);
}
export function forgetDevice(name) {
  return run("api/workspace/forget", { device: name }, `Forgot ${name}: it's no longer expected on this network`)
    .then((d) => { if (d) hooks.changed(ws.active, { forgot: name }); return d; });
}
export const isExpectedMissing = (name) => !!ws.active?.missing?.includes(name);

// ---------- the bar: what the server noticed, and the choice ----------
function renderBar() {
  const bar = $("ws-bar");
  const s = hooks.live() ? ws.suggest : null;
  bar.hidden = !s;
  if (!s) { bar.innerHTML = ""; return; }
  const cur = ws.active ? esc(ws.active.name) : "this workspace";
  let html, key;
  if (s.kind === "switch") {
    key = `switch:${s.to}`;
    html = `<span class="ws-msg">This looks like a different network: <b>${esc(s.toName)}</b> (${s.matched} of its ${s.expected} devices are here).</span>
      <button class="primary" data-act="switch">Switch to ${esc(s.toName)}</button>
      <button data-act="keep">Keep ${cur}</button>
      <button data-act="new">New workspace</button>`;
  } else if (s.kind === "new") {
    key = "new";
    html = `<span class="ws-msg">${ws.active ? "A different network" : "A new network"}: ${s.online} device${s.online === 1 ? "" : "s"}, none of them in ${cur}.</span>
      <label class="ws-name">Name <input id="ws-new-name" value="${esc(s.name)}" maxlength="60"></label>
      <button class="primary" data-act="start">Start workspace</button>
      ${ws.active ? `<button data-act="keep">Keep ${cur}</button>` : ""}`;
  } else if (s.kind === "add") {
    key = `add:${s.devices.join(",")}`;
    html = `<span class="ws-msg">${s.devices.length} new devices on ${cur}: ${esc(s.devices.slice(0, 4).join(", "))}${s.devices.length > 4 ? "…" : ""}</span>
      <button class="primary" data-act="add">Add them to ${cur}</button>
      <button data-act="new">New workspace</button>
      <button data-act="keep">Not now</button>`;
  }
  // Don't redraw under the person's cursor (or a name being typed) every 3 s.
  if (bar.dataset.key === key && bar.innerHTML) return;
  bar.dataset.key = key;
  bar.innerHTML = html;
  bar.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === "switch") switchTo(s.to, s.toName);
      else if (act === "keep") run("api/workspace/keep", {}, `Staying on ${ws.active?.name || "this workspace"}`);
      else if (act === "add") run("api/workspace/add", {}, `Added ${s.devices.length} devices to ${ws.active?.name}`);
      else if (act === "new") openPop("new");
      else if (act === "start") startNew(($("ws-new-name")?.value || "").trim() || s.name);
    };
  });
}

// ---------- the card ----------
function togglePop() {
  const pop = $("ws-pop");
  if (pop.hidden) openPop(); else pop.hidden = true;
}

function openPop(focus) {
  const pop = $("ws-pop");
  pop.hidden = false;
  pop.dataset.focus = focus || "";
  renderPop();
  if (focus === "new") pop.querySelector("#ws-new-input")?.focus();
}

function confirmTwice(id, btn, text) {
  if (armed && armed.id === id && Date.now() < armed.until) { armed = null; return true; }
  armed = { id, until: Date.now() + 4000 };
  btn.textContent = text;
  btn.classList.add("armed");
  setTimeout(() => { if (armed?.id === id) { armed = null; renderPop(); } }, 4000);
  return false;
}

function renderPop() {
  const pop = $("ws-pop");
  const a = ws.active;
  let html = `<button class="close" aria-label="Close">×</button><h3>Workspace</h3>`;
  if (!hooks.live()) {
    html += `<p class="muted">Workspaces follow the live network. Go live to see this network's workspace.</p>`;
  } else if (a) {
    html += `<div class="ws-row"><input id="ws-rename" value="${esc(a.name)}" maxlength="60" aria-label="Workspace name"><button id="ws-rename-btn">Rename</button></div>
      <p class="muted">${a.matched} of ${a.expected} devices online${ws.settling ? ` · checking the network (${ws.settling} s)` : ""}. Layout, solo monitor output and monitor history are kept for this network.</p>`;
    if (a.missing?.length) {
      html += `<h3>Missing</h3><ul class="ws-missing">${a.missing.map((n) =>
        `<li><span>${esc(n)}</span><button data-forget="${esc(n)}" title="Stop expecting this device on this network">Forget</button></li>`).join("")}</ul>`;
    }
    html += `<h3>Start again</h3>
      <p><button id="ws-clear">Clear workspace</button> <span class="muted">forgets the devices it expected, the monitor's problems and the levels, and rebuilds from what's online now. Layout and solo output stay.</span></p>
      <div class="ws-row"><input id="ws-new-input" placeholder="Name for a new workspace" maxlength="60"><button id="ws-new-btn">New workspace</button></div>
      <p class="muted">A new workspace starts empty for the network on the cable now.</p>`;
  } else {
    html += `<p class="muted">${ws.online ? "Working out which network this is…" : "No devices yet."}</p>`;
  }
  const others = ws.workspaces.filter((w) => w.id !== a?.id);
  if (others.length) {
    html += `<h3>Other networks</h3><ul class="ws-list">${others.map((w) =>
      `<li><span><b>${esc(w.name)}</b> <span class="muted">${w.devices} devices${w.iface ? ` · ${esc(w.iface)}` : ""}</span></span>
        <span><button data-switch="${esc(w.id)}">Switch</button><button data-export="${esc(w.id)}" title="Save this workspace to a file">Export</button><button data-delete="${esc(w.id)}" class="danger">Delete</button></span></li>`).join("")}</ul>`;
  }
  if (a) html += `<p><button data-export="${esc(a.id)}">Export this workspace…</button></p>`;
  if (ws.demo) html += `<h3>Demo</h3><p><button id="ws-demo-move">Move the cable to the other network</button> <span class="muted">(now on ${esc(ws.demoNetwork)})</span></p>`;
  pop.innerHTML = html;

  pop.querySelector(".close").onclick = () => { pop.hidden = true; };
  const rn = pop.querySelector("#ws-rename-btn");
  if (rn) rn.onclick = () => run("api/workspace/rename", { id: a.id, name: pop.querySelector("#ws-rename").value }, "Renamed");
  pop.querySelector("#ws-rename")?.addEventListener("keydown", (e) => { if (e.key === "Enter") rn.click(); });
  const clr = pop.querySelector("#ws-clear");
  if (clr) clr.onclick = () => {
    if (!confirmTwice("clear", clr, "Click again to clear")) return;
    run("api/workspace/clear", {}, (d) => `Cleared ${a.name}: rebuilt from the ${d.active?.expected ?? ""} devices online`)
      .then((d) => { if (d) hooks.changed(ws.active, { cleared: true }); });
  };
  const nb = pop.querySelector("#ws-new-btn");
  if (nb) nb.onclick = () => {
    const name = pop.querySelector("#ws-new-input").value.trim();
    if (!name) { pop.querySelector("#ws-new-input").focus(); return; }
    startNew(name).then((d) => { if (d) pop.hidden = true; });
  };
  pop.querySelector("#ws-new-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") nb.click(); });
  pop.querySelectorAll("[data-forget]").forEach((btn) => {
    btn.onclick = () => { if (confirmTwice("forget:" + btn.dataset.forget, btn, "Sure?")) forgetDevice(btn.dataset.forget); };
  });
  pop.querySelectorAll("[data-switch]").forEach((btn) => {
    btn.onclick = () => { const w = ws.workspaces.find((x) => x.id === btn.dataset.switch); switchTo(btn.dataset.switch, w?.name).then((d) => { if (d) pop.hidden = true; }); };
  });
  pop.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.onclick = () => { if (confirmTwice("del:" + btn.dataset.delete, btn, "Click again to delete")) run("api/workspace/delete", { id: btn.dataset.delete }, "Workspace deleted"); };
  });
  pop.querySelectorAll("[data-export]").forEach((btn) => { btn.onclick = () => exportWs(btn.dataset.export); });
  const dm = pop.querySelector("#ws-demo-move");
  if (dm) dm.onclick = () => run("api/monitor/demo/network", {}, (d) => `Demo: the cable now goes to network ${d.network}. Give it 15 seconds.`);
  if (pop.dataset.focus === "clear") pop.querySelector("#ws-clear")?.focus();
}

async function exportWs(id) {
  try {
    const res = await fetch(`api/workspace/export?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const safe = (data.workspace?.name || "workspace").replace(/[\\/:*?"<>|]+/g, "-");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `${safe} workspace.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    hooks.status(`Export failed: ${e.message}`, true);
  }
}
