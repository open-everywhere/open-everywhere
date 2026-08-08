import dnsPromises from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import { Agent } from "undici";
import type { BindableContext } from "../identity/binding.js";
import type { ReachableHost } from "./resolver.js";
import { resolveAccessFor } from "./request.js";
import { narrowByConnectorOverride } from "./connector-scope.js";
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

const DEFAULT_TOOL_LABEL = "post_file";

function parseHttpUrl(raw: string, tool: string = DEFAULT_TOOL_LABEL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${tool}: "${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${tool}: only http(s) URLs may be fetched — got "${url.protocol}".`);
  }
  if (isLiteralPrivateHost(url.hostname)) {
    throw new Error(`${tool}: refusing to fetch an internal/loopback/link-local host ("${url.hostname}").`);
  }
  return url;
}

async function pinResolvedIp(url: URL, tool: string = DEFAULT_TOOL_LABEL): Promise<{ url: URL; dispatcher: Agent }> {
  const addrs = await resolveAll(url.hostname);
  if (addrs.length === 0) {
    throw new Error(`${tool}: "${url.hostname}" did not resolve to any address.`);
  }
  for (const ip of addrs) {
    if (isDeniedIp(ip)) {
      throw new Error(
        `${tool}: "${url.hostname}" resolves to a blocked internal/loopback/link-local address (${ip}) — refusing (DNS-rebinding guard).`,
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

export async function assertSafeFetchUrl(raw: string, tool: string = DEFAULT_TOOL_LABEL): Promise<{ url: URL; dispatcher: Agent }> {
  const url = parseHttpUrl(raw, tool);
  return pinResolvedIp(url, tool);
}

export function hostReachable(hostname: string, hosts: readonly ReachableHost[]): boolean {
  const h = hostname.toLowerCase();
  return hosts.some((rh) => rh.host.toLowerCase() === h);
}

function reachableEntry(hostname: string, hosts: readonly ReachableHost[]): ReachableHost | undefined {
  const h = hostname.toLowerCase();
  return hosts.find((rh) => rh.host.toLowerCase() === h);
}

export const EGRESS_REPORT_PROTOCOL =
  "This is policy, not an outage: a retry, a mirror, a proxy, a different port and a different DNS " +
  "name all fail the same way. Report it in your answer instead, naming the host you needed and " +
  "what you needed it for. Widening is not something either of us can do at runtime — a reachable " +
  "host is config-as-code, and it changes by reviewed pull request against the bundle that grants " +
  "it (a `domains` entry for an uncredentialed host, or a connection's `allowedWebsites` for a " +
  "credentialed one). It then lands on the session's next turn.";

export type ReachDenyReason = "not-allowlisted" | "connector-revoked";

export function egressReachDenial(tool: string, host: string, reason: ReachDenyReason): string {
  const cause =
    reason === "not-allowlisted"
      ? `host "${host}" is not on this session's egress allow-list`
      : `host "${host}" is reachable only through a connection that has been revoked (break-glass \`revoke_connector\`)`;
  return `${tool}: ${cause}, so the request was refused before it was made. ${EGRESS_REPORT_PROTOCOL}`;
}

export interface ReachDeps {
  readonly tool?: string;
  readonly hosts?: (ctx: BindableContext) => readonly ReachableHost[];
  readonly narrow?: (ctx: BindableContext, ids: readonly string[]) => Promise<readonly string[] | null>;
}

export async function assertEgressReach(ctx: BindableContext, rawUrl: string, deps: ReachDeps = {}): Promise<URL> {
  const tool = deps.tool ?? DEFAULT_TOOL_LABEL;
  const url = parseHttpUrl(rawUrl, tool);
  const hosts = (deps.hosts ?? ((c: BindableContext) => resolveAccessFor(c).reachableHosts))(ctx);
  const entry = reachableEntry(url.hostname, hosts);
  const deny = async (reason: ReachDenyReason): Promise<never> => {
    await auditToolAction(ctx, "egress.hostside.deny", { host: url.hostname, reason, tool });
    throw new Error(egressReachDenial(tool, url.hostname, reason));
  };
  if (!entry) return deny("not-allowlisted");
  if (entry.viaConnection !== null) {
    const narrow = deps.narrow ?? narrowByConnectorOverride;
    const granted = await narrow(ctx, [entry.viaConnection]);
    if (granted === null || !granted.includes(entry.viaConnection)) return deny("connector-revoked");
  }
  return url;
}

export interface OeFetchOpts {
  readonly auditAs?: string;
  readonly tool?: string;
}

export async function oeFetch(ctx: BindableContext, rawUrl: string, opts: OeFetchOpts = {}): Promise<Response> {
  const tool = opts.tool ?? DEFAULT_TOOL_LABEL;
  const parsed = await assertEgressReach(ctx, rawUrl, { tool });
  let pinned: { url: URL; dispatcher: Agent };
  try {
    pinned = await pinResolvedIp(parsed, tool);
  } catch (err) {
    await auditToolAction(ctx, "egress.hostside.deny", { host: parsed.hostname, reason: "ssrf", tool });
    throw err;
  }
  const { url, dispatcher } = pinned;
  await auditToolAction(ctx, opts.auditAs ?? "egress.hostside.allow", { host: url.hostname, tool });
  return fetch(url, { dispatcher, redirect: "error", headers: {} } as unknown as RequestInit);
}
