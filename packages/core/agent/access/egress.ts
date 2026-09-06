import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { EffectiveAccess, ReachableHost } from "./resolver.js";
import type { Connection } from "./bundle.js";
import { extraEgressHosts } from "./extra-hosts.js";
import { DEFAULT_NETWORK_ACCESS_LEVEL, TRUSTED_ACCESS_HOSTS, type NetworkAccessLevel } from "./network-access.js";

export type ResolveHeaders = (connection: Connection) => Promise<Record<string, string>>;

export type NarrowConnections = (connectionIds: readonly string[]) => Promise<readonly string[] | null>;

export type EgressRule = {
  match?: { method?: string[]; path?: { startsWith?: string } };
  transform: { headers?: Record<string, string> }[];
};

function ruleForHost(
  host: ReachableHost,
  headers: Record<string, string> | null,
): EgressRule[] {
  if (host.viaConnection === null) return [];

  const method = host.methods && host.methods.length > 0 ? [...host.methods] : undefined;
  const transform = headers && Object.keys(headers).length > 0 ? [{ headers }] : [];

  const prefixes = host.pathPrefixes ?? [];
  if (prefixes.length > 0) {
    return prefixes.map((prefix) => {
      const rule: EgressRule = { match: { path: { startsWith: prefix } }, transform };
      if (method) rule.match!.method = method;
      return rule;
    });
  }

  const rule: EgressRule = { transform };
  if (method) rule.match = { method };
  return [rule];
}

export async function compileNetworkPolicy(
  access: EffectiveAccess,
  resolveHeaders: ResolveHeaders,
  narrowConnections: NarrowConnections,
  networkAccessLevel: NetworkAccessLevel = DEFAULT_NETWORK_ACCESS_LEVEL,
): Promise<SandboxNetworkPolicy> {
  const byId = new Map(access.connections.map((c) => [c.id, c]));
  const allow: Record<string, EgressRule[]> = {};

  const connectionIds = [...byId.keys()];
  const granted = connectionIds.length > 0 ? await narrowConnections(connectionIds) : [];
  const grantedIds = granted === null ? null : new Set(granted);

  for (const host of access.reachableHosts) {
    if (host.viaConnection !== null && (grantedIds === null || !grantedIds.has(host.viaConnection))) {
      continue;
    }
    let headers: Record<string, string> | null = null;
    if (host.viaConnection) {
      const conn = byId.get(host.viaConnection);
      headers = conn ? await resolveHeaders(conn) : null;
    }
    allow[host.host] = ruleForHost(host, headers);
  }

  for (const host of extraEgressHosts()) {
    if (!(host in allow)) allow[host] = [];
  }

  if (access.repos.length > 0 && !allow["github.com"]) allow["github.com"] = [];

  if (networkAccessLevel === "trusted") {
    for (const host of TRUSTED_ACCESS_HOSTS) if (!(host in allow)) allow[host] = [];
  } else if (networkAccessLevel === "full") {
    if (!("*" in allow)) allow["*"] = [];
  }

  if (Object.keys(allow).length === 0) return "deny-all";
  return { allow };
}

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OpenWriteHost {
  readonly host: string;
  readonly via: string | null;
  readonly credentialed: boolean;
  readonly methods: readonly string[] | "any";
}

export function ruleStampsCredential(rule: { readonly transform?: readonly unknown[] }): boolean {
  return (rule.transform ?? []).length > 0;
}

export const WRITE_HOSTS_ROW_CAP = 20;

export function writeHostsAuditFields(writeHosts: readonly OpenWriteHost[]): Record<string, unknown> {
  return {
    writeHostCount: writeHosts.length,
    ...(writeHosts.length > 0 ? { writeHosts: writeHosts.slice(0, WRITE_HOSTS_ROW_CAP) } : {}),
    ...(writeHosts.length > WRITE_HOSTS_ROW_CAP ? { writeHostsTruncated: true } : {}),
  };
}

export function openWriteHosts(
  policy: SandboxNetworkPolicy,
  reachableHosts: readonly ReachableHost[] = [],
): readonly OpenWriteHost[] {
  if (typeof policy === "string") {
    return policy === "allow-all" ? [{ host: "*", via: null, credentialed: false, methods: "any" }] : [];
  }
  const allow = (policy as { allow?: readonly string[] | Record<string, EgressRule[]> }).allow;
  if (!allow) return [];
  const viaByHost = new Map(reachableHosts.map((h) => [h.host, h.viaConnection]));
  const byHost = (a: { host: string }, b: { host: string }): number => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
  if (Array.isArray(allow)) {
    return allow.map((host) => ({ host, via: null, credentialed: false, methods: "any" as const })).sort(byHost);
  }
  const out: OpenWriteHost[] = [];
  for (const [host, rules] of Object.entries(allow)) {
    let unrestricted = false;
    let credentialed = false;
    const methods = new Set<string>();
    for (const rule of rules ?? []) {
      if (ruleStampsCredential(rule)) credentialed = true;
      const declared = rule.match?.method;
      if (!declared || declared.length === 0) {
        unrestricted = true;
        continue;
      }
      for (const m of declared) methods.add(m.toUpperCase());
    }
    if ((rules ?? []).length === 0) unrestricted = true;
    const writes = unrestricted || [...methods].some((m) => !READ_ONLY_METHODS.has(m));
    if (!writes) continue;
    out.push({
      host,
      via: credentialed ? (viaByHost.get(host) ?? null) : null,
      credentialed,
      methods: unrestricted ? "any" : [...methods].sort(),
    });
  }
  return out.sort(byHost);
}
