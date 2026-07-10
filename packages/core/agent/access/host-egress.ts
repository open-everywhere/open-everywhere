import dnsPromises from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import { Agent } from "undici";
import type { BindableContext } from "../identity/binding.js";
import type { ReachableHost } from "./resolver.js";
import { resolveAccessFor } from "./request.js";
import { auditToolAction } from "../audit/tool-action.js";

export type HostLookup = (hostname: string) => Promise<readonly string[]>;
let lookupImpl: HostLookup | undefined;
export function setHostEgressLookup(fn: HostLookup | undefined): void {
  lookupImpl = fn;
}
async function resolveAll(hostname: string): Promise<readonly string[]> {
  if (lookupImpl) return lookupImpl(hostname);
  const records = await dnsPromises.lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

function isDeniedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function firstHextet(ip: string): number {
  const addr = ip.split("%")[0];
  if (addr.startsWith("::")) return 0;
  const g = addr.split(":")[0];
  return g ? parseInt(g, 16) : 0;
}

export function isDeniedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isDeniedIpv4(ip);
  if (fam === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
    if (mapped) return isDeniedIpv4(mapped[1]);
    if (lower === "::1") return true;
    if (lower === "::") return true;
    const first = firstHextet(lower);
    if (first >= 0xfc00 && first <= 0xfdff) return true;
    if (first >= 0xfe80 && first <= 0xfebf) return true;
    return false;
  }
  return true;
}

function isLiteralPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal") return true;
  if (net.isIP(h) !== 0 && isDeniedIp(h)) return true;
  return false;
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`post_file: "${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`post_file: only http(s) URLs may be fetched — got "${url.protocol}".`);
  }
  if (isLiteralPrivateHost(url.hostname)) {
    throw new Error(`post_file: refusing to fetch an internal/loopback/link-local host ("${url.hostname}").`);
  }
  return url;
}

async function pinResolvedIp(url: URL): Promise<{ url: URL; dispatcher: Agent }> {
  const addrs = await resolveAll(url.hostname);
  if (addrs.length === 0) {
    throw new Error(`post_file: "${url.hostname}" did not resolve to any address.`);
  }
  for (const ip of addrs) {
    if (isDeniedIp(ip)) {
      throw new Error(
        `post_file: "${url.hostname}" resolves to a blocked internal/loopback/link-local address (${ip}) — refusing (DNS-rebinding guard).`,
      );
    }
  }
  const pinned = addrs[0];
  const family = net.isIP(pinned);
  const lookup: LookupFunction = (_hostname, options, callback): void => {
    if ((options as { all?: boolean }).all) callback(null, [{ address: pinned, family }]);
    else callback(null, pinned, family);
  };
  const dispatcher = new Agent({ connect: { lookup } });
  return { url, dispatcher };
}

export async function assertSafeFetchUrl(raw: string): Promise<{ url: URL; dispatcher: Agent }> {
  const url = parseHttpUrl(raw);
  return pinResolvedIp(url);
}

export function hostReachable(hostname: string, hosts: readonly ReachableHost[]): boolean {
  const h = hostname.toLowerCase();
  return hosts.some((rh) => rh.host.toLowerCase() === h);
}

export interface OeFetchOpts {
  readonly auditAs?: string;
}

export async function oeFetch(ctx: BindableContext, rawUrl: string, opts: OeFetchOpts = {}): Promise<Response> {
  const parsed = parseHttpUrl(rawUrl);
  const access = resolveAccessFor(ctx);
  if (!hostReachable(parsed.hostname, access.reachableHosts)) {
    await auditToolAction(ctx, "egress.hostside.deny", { host: parsed.hostname, reason: "not-allowlisted" });
    throw new Error(`post_file: host "${parsed.hostname}" is not reachable from this session's egress allowlist.`);
  }
  let pinned: { url: URL; dispatcher: Agent };
  try {
    pinned = await pinResolvedIp(parsed);
  } catch (err) {
    await auditToolAction(ctx, "egress.hostside.deny", { host: parsed.hostname, reason: "ssrf" });
    throw err;
  }
  const { url, dispatcher } = pinned;
  await auditToolAction(ctx, opts.auditAs ?? "egress.hostside.allow", { host: url.hostname });
  return fetch(url, { dispatcher, redirect: "error", headers: {} } as unknown as RequestInit);
}
