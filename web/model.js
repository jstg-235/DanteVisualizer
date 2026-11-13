// Network model shared by the preset loader and the live server.
//
// Model shape:
// {
//   source: "preset" | "live",
//   name: string,
//   devices: [{
//     name, model, manufacturer, sampleRate, online,
//     tx: [{ id, name }],                       // id = Dante channel number
//     rx: [{ id, name, subDevice, subChannel, state?, stateLabel? }] // subDevice/subChannel empty when unrouted;
//                                               // state "error" = the subscription failed
//   }],
//   levels?: { [deviceName]: { tx: number[], rx: number[] } } // step 3
// }

export function parsePresetXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("This file is not valid XML.");
  const root = doc.documentElement;
  if (root.nodeName !== "preset") throw new Error("This doesn't look like a Dante Controller preset.");
  const own = (el, tag) => {
    for (const c of el.children) if (c.nodeName === tag) return c.textContent.trim();
    return "";
  };
  const devices = [];
  for (const d of root.children) {
    if (d.nodeName !== "device") continue;
    const tx = [], rx = [];
    for (const c of d.children) {
      if (c.nodeName === "txchannel") {
        tx.push({ id: +c.getAttribute("danteId"), name: own(c, "label") || own(c, "name") || c.getAttribute("danteId") });
      } else if (c.nodeName === "rxchannel") {
        rx.push({
          id: +c.getAttribute("danteId"),
          name: own(c, "name") || c.getAttribute("danteId"),
          subDevice: own(c, "subscribed_device"),
          subChannel: own(c, "subscribed_channel"),
        });
      }
    }
    tx.sort((a, b) => a.id - b.id);
    rx.sort((a, b) => a.id - b.id);
    devices.push({
      name: own(d, "name"),
      model: own(d, "model_name"),
      manufacturer: own(d, "manufacturer_name"),
      sampleRate: +own(d, "samplerate") || null,
      online: true,
      tx, rx,
    });
  }
  return { source: "preset", name: own(root, "name") || "Preset", devices };
}

// Resolve every rx subscription to a concrete tx channel.
// Routes to devices that aren't in the model (offline or outside the preset)
// are kept with src.missing = true so the diagram can show them as dangling.
export function buildRoutes(model) {
  const byName = new Map(model.devices.map((d) => [d.name, d]));
  const routes = [];
  for (const dst of model.devices) {
    for (const rx of dst.rx) {
      if (!rx.subDevice) continue;
      const src = byName.get(rx.subDevice);
      let tx = null;
      if (src) {
        tx = src.tx.find((t) => t.name === rx.subChannel) ||
             src.tx.find((t) => String(t.id) === rx.subChannel) || null;
      }
      routes.push({
        id: `${dst.name}#${rx.id}`,
        srcDevice: rx.subDevice,
        srcChannel: tx ? tx.id : null,
        srcChannelName: rx.subChannel,
        dstDevice: dst.name,
        dstChannel: rx.id,
        dstChannelName: rx.name,
        missing: !src || !tx,
        // The receiver reports the subscription as failed (netaudio state "error").
        failed: rx.state === "error",
        stateLabel: rx.stateLabel || "",
      });
    }
  }
  return routes;
}

// Collapse consecutive channels into ranges, e.g. [1,2,3,7] -> "1–3, 7".
export function rangeText(ids) {
  const s = [...ids].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}
