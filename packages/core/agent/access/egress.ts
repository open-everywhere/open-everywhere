import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { EffectiveAccess, ReachableHost } from "./resolver.js";
import type { Connection } from "./bundle.js";
import { extraEgressHosts } from "./extra-hosts.js";

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

  if (Object.keys(allow).length === 0) return "deny-all";
  return { allow };
}
