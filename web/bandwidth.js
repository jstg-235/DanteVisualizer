// Estimated network bandwidth of Dante audio flows, worked out from the routes.
//
// Dante sends audio in flows: a unicast flow carries up to 4 channels from one device to
// another, a multicast flow up to 8 channels to any number of receivers. A packet goes out
// about 3000 times a second (16 samples per channel at 48 kHz), each with ~58 bytes of
// Ethernet, IP, UDP and Dante headers. That gives Audinate's figure of about 6 Mb/s for a
// typical 4-channel, 48 kHz, 24-bit unicast flow. These are estimates, not measurements:
// the switch pages show measured traffic where a switch is added.

const PACKETS_PER_SEC = 3000;
const OVERHEAD_BYTES = 58;
const UNICAST_CHANNELS = 4;
const MULTICAST_CHANNELS = 8;

const isMulticast = (r) => /multicast/i.test(r.stateLabel || "");

function bitsOf(d) {
  const e = d?.info?.encoding;
  const n = typeof e === "number" ? e : parseInt(String(e || "").replace(/\D+/g, ""), 10);
  return n === 16 || n === 24 || n === 32 ? n : 24;
}

// Mb/s of `flows` flows carrying `channels` channels in all.
function mbps(channels, flows, rate, bits) {
  if (!channels) return 0;
  const samplesPerPacket = (rate || 48000) / PACKETS_PER_SEC;
  const bytes = channels * samplesPerPacket * (bits / 8) + flows * OVERHEAD_BYTES;
  return (bytes * PACKETS_PER_SEC * 8) / 1e6;
}

// Bandwidth of a set of routes from one sending device to one receiving device.
// Multicast routes are counted as the share of their flow this receiver takes.
export function routesMbps(routes, model) {
  const live = routes.filter((r) => !r.failed && !r.missing);
  if (!live.length) return 0;
  const src = model.devices.find((d) => d.name === live[0].srcDevice);
  const rate = src?.sampleRate || 48000, bits = bitsOf(src);
  const uni = live.filter((r) => !isMulticast(r)).length;
  const multi = live.length - uni;
  return mbps(uni, Math.ceil(uni / UNICAST_CHANNELS), rate, bits) +
         mbps(multi, Math.ceil(multi / MULTICAST_CHANNELS), rate, bits);
}

// Per device: estimated Mb/s sent and received. A multicast channel is sent once however
// many devices receive it; each receiver still takes it in.
export function deviceTraffic(model, routes) {
  const out = {};
  const get = (n) => (out[n] ||= { out: 0, in: 0, outCh: 0, inCh: 0 });
  const pairs = new Map();
  for (const r of routes) {
    if (r.failed || r.missing) continue;
    const k = `${r.srcDevice}\u0000${r.dstDevice}`;
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(r);
  }
  for (const rs of pairs.values()) {
    const v = routesMbps(rs, model);
    get(rs[0].dstDevice).in += v;
    get(rs[0].dstDevice).inCh += rs.length;
  }
  for (const d of model.devices) {
    const mine = routes.filter((r) => r.srcDevice === d.name && !r.failed && !r.missing);
    if (!mine.length) continue;
    const uniByDst = groupCount(mine.filter((r) => !isMulticast(r)), (r) => r.dstDevice);
    const multiCh = new Set(mine.filter(isMulticast).map((r) => r.srcChannel)).size;
    const rate = d.sampleRate || 48000, bits = bitsOf(d);
    let v = mbps(multiCh, Math.ceil(multiCh / MULTICAST_CHANNELS), rate, bits);
    for (const n of uniByDst.values()) v += mbps(n, Math.ceil(n / UNICAST_CHANNELS), rate, bits);
    get(d.name).out = v;
    get(d.name).outCh = mine.length;
  }
  return out;
}

function groupCount(list, f) {
  const m = new Map();
  for (const x of list) m.set(f(x), (m.get(f(x)) || 0) + 1);
  return m;
}

export function mbpsText(v) {
  if (!v) return "0 Mb/s";
  return v < 10 ? `${v.toFixed(1)} Mb/s` : `${Math.round(v)} Mb/s`;
}
