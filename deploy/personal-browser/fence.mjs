import net from "node:net";
import os from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";

export function parseAllow(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((h) => typeof h === "string").map((h) => h.trim().toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function bareHost(host) {
  return String(host ?? "")
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function hostAllowed(host, allow) {
  const h = bareHost(host);
  if (h.length === 0) return false;
  for (const a of allow) {
    if (a === "*") return true;
    if (a.startsWith("*.")) {
      if (h.endsWith(`.${a.slice(2)}`)) return true;
    } else if (h === a) return true;
  }
  return false;
}

export function internalBlockList(interfaceAddresses = ownInterfaceAddresses()) {
  const b = new net.BlockList();
  b.addSubnet("127.0.0.0", 8, "ipv4");
  b.addSubnet("0.0.0.0", 8, "ipv4");
  b.addSubnet("169.254.0.0", 16, "ipv4");
  b.addAddress("::1", "ipv6");
  b.addAddress("::", "ipv6");
  b.addSubnet("fe80::", 10, "ipv6");
  b.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
  b.addSubnet("::ffff:0.0.0.0", 104, "ipv6");
  b.addSubnet("::ffff:169.254.0.0", 112, "ipv6");
  for (const a of interfaceAddresses) {
    const family = net.isIPv6(a) ? "ipv6" : "ipv4";
    if (net.isIP(a)) b.addAddress(a, family);
  }
  return b;
}

export function ownInterfaceAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) out.push(i.address.split("%")[0]);
  return out;
}

export function isInternalAddress(addr, block = internalBlockList()) {
  const a = bareHost(addr).split("%")[0];
  const family = net.isIPv6(a) ? "ipv6" : net.isIPv4(a) ? "ipv4" : undefined;
  if (family === undefined) return true;
  if (block.check(a, family)) return true;
  const mapped = /^(?:0*:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped !== null && block.check(mapped[1], "ipv4");
}

export function isLoopbackName(host) {
  const h = bareHost(host);
  return h === "localhost" || h.endsWith(".localhost");
}

export async function checkedAddress(host, allow, opts = {}) {
  const h = bareHost(host);
  if (!hostAllowed(h, allow) || isLoopbackName(h)) return undefined;
  const block = opts.block ?? internalBlockList();
  if (net.isIP(h)) return isInternalAddress(h, block) ? undefined : h;
  let addrs;
  try {
    addrs = await (opts.lookup ?? dnsLookup)(h, { all: true, verbatim: true });
  } catch {
    return undefined;
  }
  if (!Array.isArray(addrs) || addrs.length === 0 || addrs.some((x) => isInternalAddress(x.address, block))) return undefined;
  return addrs[0].address;
}

export function upstreamTarget(host, allow, block = internalBlockList()) {
  const h = bareHost(host);
  if (!hostAllowed(h, allow) || isLoopbackName(h)) return undefined;
  if (net.isIP(h) && isInternalAddress(h, block)) return undefined;
  return h;
}

export function parseUpstream(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" || u.hostname === "") return undefined;
  return { host: bareHost(u.hostname), port: Number(u.port || "80") };
}

export function upstreamTunnel(upstream, host, port) {
  return new Promise((resolve) => {
    const sock = net.connect(upstream.port, upstream.host);
    let buf = Buffer.alloc(0);
    const fail = () => {
      sock.destroy();
      resolve(undefined);
    };
    sock.on("error", fail);
    sock.on("connect", () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 16 * 1024) fail();
        return;
      }
      sock.off("data", onData);
      sock.pause();
      sock.off("error", fail);
      if (!/^HTTP\/1\.[01] 200/.test(buf.subarray(0, end).toString("latin1"))) return fail();
      resolve({ socket: sock, head: buf.subarray(end + 4) });
    };
    sock.on("data", onData);
  });
}
