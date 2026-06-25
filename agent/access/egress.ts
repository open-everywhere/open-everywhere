import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { EffectiveAccess, ReachableHost } from "./resolver.js";
import type { Connection } from "./bundle.js";

export type ResolveHeaders = (connection: Connection) => Promise<Record<string, string>>;

type EgressRule = {
  match?: { method?: string[]; path?: { startsWith?: string } };
  transform?: { headers?: Record<string, string> }[];
};

function ruleForHost(
  host: ReachableHost,
  headers: Record<string, string> | null,
): EgressRule[] {
  if (host.viaConnection === null) return [];

  const rule: EgressRule = {};
  const match: NonNullable<EgressRule["match"]> = {};
  if (host.methods && host.methods.length > 0) match.method = [...host.methods];
  if (host.pathPrefixes && host.pathPrefixes.length === 1) {
    match.path = { startsWith: host.pathPrefixes[0] };
  }
  if (Object.keys(match).length > 0) rule.match = match;
  if (headers && Object.keys(headers).length > 0) rule.transform = [{ headers }];
  return [rule];
}

export async function compileNetworkPolicy(
  access: EffectiveAccess,
  resolveHeaders: ResolveHeaders,
): Promise<SandboxNetworkPolicy> {
  const byId = new Map(access.connections.map((c) => [c.id, c]));
  const allow: Record<string, EgressRule[]> = {};

  for (const host of access.reachableHosts) {
    let headers: Record<string, string> | null = null;
    if (host.viaConnection) {
      const conn = byId.get(host.viaConnection);
      headers = conn ? await resolveHeaders(conn) : null;
    }
    allow[host.host] = ruleForHost(host, headers);
  }

  if (access.repos.length > 0 && !allow["github.com"]) allow["github.com"] = [];

  if (Object.keys(allow).length === 0) return "deny-all";
  return { allow };
}
