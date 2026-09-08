import dnsPromises from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { BindableContext } from "../identity/binding.js";
import type { ReachableHost } from "./resolver.js";
import { resolveAccessFor } from "./request.js";
import { narrowByConnectorOverride } from "./connector-scope.js";
import { auditToolAction } from "../audit/tool-action.js";
import { hostCallAuditFields } from "./egress.js";
import { haltScopeForCtx, resolveHalt } from "./halt.js";

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

export type EgressRefusalCause = "resolve-failed";

export type EgressRoute = { readonly via: "direct" } | { readonly via: "proxy"; readonly proxyUrl: string };

export interface EgressDispatch {
  readonly url: URL;
  readonly dispatcher: Dispatcher;
  readonly via: "direct" | "proxy";
  readonly antiRebind: "ip-pin" | "proxy-acl";
}

function noProxyExempts(url: URL, noProxy: string): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const raw of noProxy.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === "*") return true;
    const colon = entry.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
      if (entry.slice(colon + 1) !== port) continue;
      entry = entry.slice(0, colon);
    }
    if (entry.startsWith(".")) entry = entry.slice(1);
    if (entry === "") continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export function resolveEgressRoute(url: URL, env: NodeJS.ProcessEnv = process.env, tool: string = DEFAULT_TOOL_LABEL): EgressRoute {
  const names = url.protocol === "https:" ? (["https_proxy", "HTTPS_PROXY"] as const) : (["http_proxy", "HTTP_PROXY"] as const);
  const key = (env[names[0]] ?? "").trim() !== "" ? names[0] : names[1];
  const proxyUrl = (env[key] ?? "").trim();
  if (proxyUrl === "") return { via: "direct" };
  const noProxy = (env.no_proxy ?? env.NO_PROXY ?? "").trim();
  if (noProxy !== "" && noProxyExempts(url, noProxy)) return { via: "direct" };
  let parsed: URL | undefined;
  try {
    parsed = new URL(proxyUrl);
  } catch {
  }
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    throw new Error(`${tool}: ${key}="${proxyUrl}" is not a valid http(s) proxy URL — refusing to fall back to an unproxied request.`);
  }
  return { via: "proxy", proxyUrl };
}

async function pinResolvedIp(url: URL, tool: string = DEFAULT_TOOL_LABEL): Promise<{ url: URL; dispatcher: Agent }> {
  let addrs: readonly string[];
  try {
    addrs = await resolveAll(url.hostname);
  } catch (err) {
    if (err instanceof Error) (err as { oeEgressCause?: EgressRefusalCause }).oeEgressCause = "resolve-failed";
    throw err;
  }
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

function proxyDispatch(url: URL, proxyUrl: string): EgressDispatch {
  return { url, dispatcher: new ProxyAgent({ uri: proxyUrl }), via: "proxy", antiRebind: "proxy-acl" };
}

async function directDispatch(url: URL, tool: string): Promise<EgressDispatch> {
  const pinned = await pinResolvedIp(url, tool);
  return { url: pinned.url, dispatcher: pinned.dispatcher, via: "direct", antiRebind: "ip-pin" };
}

async function dispatchFor(url: URL, tool: string): Promise<EgressDispatch> {
  const route = resolveEgressRoute(url, process.env, tool);
  return route.via === "proxy" ? proxyDispatch(url, route.proxyUrl) : directDispatch(url, tool);
}

export async function assertSafeFetchUrl(raw: string, tool: string = DEFAULT_TOOL_LABEL): Promise<EgressDispatch> {
  const url = parseHttpUrl(raw, tool);
  return dispatchFor(url, tool);
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

export type ReachDenyReason = "not-allowlisted" | "connector-revoked" | "halted";

export type HostDenyReason = ReachDenyReason | "ssrf" | "resolve-failed" | "redirect-bound";

export const MAX_REDIRECT_HOPS = 5;

export function redirectBoundDenial(tool: string, host: string): string {
  return (
    `${tool}: this request has already followed ${MAX_REDIRECT_HOPS} redirects, and "${host}" is the next one. ` +
    `A chain that long is a loop or a cloak, so the fence stopped it. Fetch the final URL directly instead.`
  );
}

export function egressReachDenial(tool: string, host: string, reason: ReachDenyReason): string {
  const cause =
    reason === "not-allowlisted"
      ? `host "${host}" is not on this session's egress allow-list`
      : reason === "halted"
        ? `a break-glass halt is in force for this deployment, so NO host is reachable until an admin runs \`resume\` — this is not about "${host}"`
        : `host "${host}" is reachable only through a connection that has been revoked (break-glass \`revoke_connector\`)`;
  return `${tool}: ${cause}, so the request was refused before it was made. ${EGRESS_REPORT_PROTOCOL}`;
}

const HOST_PLANE_VERB = "GET";

export interface ReachDeps {
  readonly tool?: string;
  readonly hosts?: (ctx: BindableContext) => readonly ReachableHost[];
  readonly narrow?: (ctx: BindableContext, ids: readonly string[]) => Promise<readonly string[] | null>;
  readonly halted?: (ctx: BindableContext) => Promise<boolean>;
  readonly rowFields?: Readonly<Record<string, unknown>>;
}

export async function assertEgressReach(ctx: BindableContext, rawUrl: string, deps: ReachDeps = {}): Promise<URL> {
  const tool = deps.tool ?? DEFAULT_TOOL_LABEL;
  const url = parseHttpUrl(rawUrl, tool);
  const hosts = (deps.hosts ?? ((c: BindableContext) => resolveAccessFor(c).reachableHosts))(ctx);
  const entry = reachableEntry(url.hostname, hosts);
  const deny = async (reason: ReachDenyReason): Promise<never> => {
    await auditToolAction(ctx, "egress.hostside.deny", {
      ...hostCallAuditFields({ host: url.hostname, verb: HOST_PLANE_VERB, outcome: "denied" }),
      reason,
      tool,
      ...(deps.rowFields ?? {}),
    });
    throw new Error(egressReachDenial(tool, url.hostname, reason));
  };
  const halted = deps.halted ?? ((c: BindableContext) => resolveHalt(haltScopeForCtx(c)).then((s) => s.halted));
  if (await halted(ctx)) return deny("halted");
  if (!entry) return deny("not-allowlisted");
  if (entry.viaConnection !== null) {
    const narrow = deps.narrow ?? narrowByConnectorOverride;
    const granted = await narrow(ctx, [entry.viaConnection]);
    if (granted === null || !granted.includes(entry.viaConnection)) return deny("connector-revoked");
  }
  return url;
}

export async function assertEgressHop(ctx: BindableContext, rawUrl: string, hop: number, deps: ReachDeps = {}): Promise<URL> {
  const tool = deps.tool ?? DEFAULT_TOOL_LABEL;
  const parsed = parseHttpUrl(rawUrl, tool);
  const rowFields = { hop, dispatch: "framework" } as const;
  if (hop > MAX_REDIRECT_HOPS) {
    const reason: HostDenyReason = "redirect-bound";
    await auditToolAction(ctx, "egress.hostside.deny", {
      ...hostCallAuditFields({ host: parsed.hostname, verb: HOST_PLANE_VERB, outcome: "denied" }),
      reason,
      tool,
      ...rowFields,
    });
    throw new Error(redirectBoundDenial(tool, parsed.hostname));
  }
  const url = await assertEgressReach(ctx, rawUrl, { ...deps, rowFields });
  await auditToolAction(ctx, "egress.hostside.allow", {
    ...hostCallAuditFields({ host: url.hostname, verb: HOST_PLANE_VERB, outcome: "allowed" }),
    tool,
    ...rowFields,
  });
  return url;
}

export interface OeFetchOpts {
  readonly auditAs?: string;
  readonly tool?: string;
}

export async function oeFetch(ctx: BindableContext, rawUrl: string, opts: OeFetchOpts = {}): Promise<Response> {
  const tool = opts.tool ?? DEFAULT_TOOL_LABEL;
  const parsed = await assertEgressReach(ctx, rawUrl, { tool });
  const route = resolveEgressRoute(parsed, process.env, tool);
  let dispatch: EgressDispatch;
  if (route.via === "proxy") {
    dispatch = proxyDispatch(parsed, route.proxyUrl);
  } else {
    try {
      dispatch = await directDispatch(parsed, tool);
    } catch (err) {
      const resolveFailed = (err as { oeEgressCause?: EgressRefusalCause })?.oeEgressCause === "resolve-failed";
      const reason: HostDenyReason = resolveFailed ? "resolve-failed" : "ssrf";
      await auditToolAction(ctx, "egress.hostside.deny", {
        ...hostCallAuditFields({ host: parsed.hostname, verb: HOST_PLANE_VERB, outcome: resolveFailed ? "failed" : "denied" }),
        reason,
        tool,
      });
      throw err;
    }
  }
  const { url, dispatcher, via, antiRebind } = dispatch;
  const auditAs = opts.auditAs ?? "egress.hostside.allow";
  let response: Response;
  try {
    response = await fetch(url, { dispatcher, redirect: "error", headers: {} } as unknown as RequestInit);
  } catch (err) {
    await auditToolAction(ctx, auditAs, {
      ...hostCallAuditFields({ host: url.hostname, verb: HOST_PLANE_VERB, outcome: "failed" }),
      tool,
      route: via,
      antiRebind,
    });
    throw err;
  }
  await auditToolAction(ctx, auditAs, {
    ...hostCallAuditFields({ host: url.hostname, verb: HOST_PLANE_VERB, outcome: "allowed" }),
    tool,
    route: via,
    antiRebind,
    status: response.status,
  });
  return response;
}
