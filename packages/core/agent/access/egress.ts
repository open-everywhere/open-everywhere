import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { EffectiveAccess, ReachableHost } from "./resolver.js";
import { EgressHostCollisionError } from "./resolver.js";
import { egressHostsOverlap, normaliseEgressHost, type Connection } from "./bundle.js";
import { extraEgressHosts } from "./extra-hosts.js";
import { browserEgressHosts, type BrowserHostDeclaration } from "./browser-hosts.js";
import { GIT_BROKER_HOSTS } from "./reserved-hosts.js";
import { DEFAULT_NETWORK_ACCESS_LEVEL, TRUSTED_ACCESS_HOSTS, type NetworkAccessLevel } from "./network-access.js";

export { GIT_BROKER_HOSTS } from "./reserved-hosts.js";

export type EgressPlane = "sandbox" | "host";

export type EgressRowUnit = "call" | "policy";

export type EgressOutcome = "allowed" | "denied" | "failed" | "granted";

export interface EgressAuditRow {
  readonly plane: EgressPlane;
  readonly unit: EgressRowUnit;
  readonly host: string;
  readonly verb: readonly string[] | "any";
  readonly credential: string | null;
  readonly outcome: EgressOutcome;
}

export const EGRESS_AUDIT_ROW_FIELDS = ["plane", "unit", "host", "verb", "credential", "outcome"] as const;

export function normaliseVerbs(verbs: readonly string[] | "any"): readonly string[] | "any" {
  if (verbs === "any") return "any";
  return [...new Set(verbs.map((v) => v.toUpperCase()))].sort();
}

export function egressAuditFields(row: EgressAuditRow): Record<string, unknown> {
  return {
    plane: row.plane,
    unit: row.unit,
    host: row.host.toLowerCase(),
    verb: normaliseVerbs(row.verb),
    credential: row.credential,
    outcome: row.outcome,
  };
}

export function hostCallAuditFields(args: {
  readonly host: string;
  readonly verb: string;
  readonly outcome: EgressOutcome;
  readonly credential?: string | null;
}): Record<string, unknown> {
  return egressAuditFields({
    plane: "host",
    unit: "call",
    host: args.host,
    verb: [args.verb],
    credential: args.credential ?? null,
    outcome: args.outcome,
  });
}

export function sandboxPolicyAuditFields(args: {
  readonly host: string;
  readonly verb: readonly string[] | "any";
  readonly credential: string | null;
}): Record<string, unknown> {
  return egressAuditFields({
    plane: "sandbox",
    unit: "policy",
    host: args.host,
    verb: args.verb,
    credential: args.credential,
    outcome: "granted",
  });
}

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

async function browserHostRules(
  byId: ReadonlyMap<string, Connection>,
  grantedIds: ReadonlySet<string> | null,
  resolveHeaders: ResolveHeaders,
): Promise<Record<string, EgressRule[]>> {
  const armed = browserEgressHosts();

  const collisions: string[] = [];
  for (const row of armed) {
    const claimed = normaliseEgressHost(row.host);
    for (const host of GIT_BROKER_HOSTS) {
      if (!egressHostsOverlap(claimed, host)) continue;
      const where = claimed === host ? host : `${claimed} overlaps ${host}`;
      collisions.push(`${where} (declared browser host, and the git read-broker, which replaces that host's rules mid-turn)`);
    }
  }
  if (collisions.length > 0) throw new EgressHostCollisionError(collisions);

  const out: Record<string, EgressRule[]> = {};
  for (const row of armed) {
    const method = [...row.methods];
    if (row.credential === undefined) {
      out[row.host] = [{ match: { method }, transform: [] }];
      continue;
    }
    if (grantedIds === null || !grantedIds.has(row.credential)) continue;
    const conn = byId.get(row.credential);
    if (conn === undefined) continue;
    const headers = await resolveHeaders(conn);
    if (Object.keys(headers).length === 0) continue;
    out[row.host] = [{ match: { method }, transform: [{ headers }] }];
  }
  return out;
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

  for (const [host, rules] of Object.entries(await browserHostRules(byId, grantedIds, resolveHeaders))) {
    if (!(host in allow)) allow[host] = rules;
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
  readonly credential: string | null;
  readonly credentialed: boolean;
  readonly verb: readonly string[] | "any";
}

export function ruleStampsCredential(rule: { readonly transform?: readonly unknown[] }): boolean {
  return (rule.transform ?? []).length > 0;
}

const WRITE_HOSTS_ROW_CAP = 20;

export function writeHostsAuditFields(writeHosts: readonly OpenWriteHost[]): Record<string, unknown> {
  const listed = writeHosts.slice(0, WRITE_HOSTS_ROW_CAP).map((h) => ({
    ...sandboxPolicyAuditFields({ host: h.host, verb: h.verb, credential: h.credential }),
    credentialed: h.credentialed,
  }));
  return {
    writeHostCount: writeHosts.length,
    ...(listed.length > 0 ? { writeHosts: listed } : {}),
    ...(writeHosts.length > WRITE_HOSTS_ROW_CAP ? { writeHostsTruncated: true } : {}),
  };
}

export function openWriteHosts(
  policy: SandboxNetworkPolicy,
  reachableHosts: readonly ReachableHost[] = [],
  browserHosts: readonly BrowserHostDeclaration[] = [],
): readonly OpenWriteHost[] {
  if (typeof policy === "string") {
    return policy === "allow-all" ? [{ host: "*", credential: null, credentialed: false, verb: "any" }] : [];
  }
  const allow = (policy as { allow?: readonly string[] | Record<string, EgressRule[]> }).allow;
  if (!allow) return [];
  const viaByHost = new Map<string, string | null>(browserHosts.map((h) => [h.host, h.credential ?? null]));
  for (const h of reachableHosts) viaByHost.set(h.host, h.viaConnection);
  const byHost = (a: { host: string }, b: { host: string }): number => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
  if (Array.isArray(allow)) {
    return allow.map((host) => ({ host, credential: null, credentialed: false, verb: "any" as const })).sort(byHost);
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
      credential: credentialed ? (viaByHost.get(host) ?? null) : null,
      credentialed,
      verb: unrestricted ? "any" : [...methods].sort(),
    });
  }
  return out.sort(byHost);
}
