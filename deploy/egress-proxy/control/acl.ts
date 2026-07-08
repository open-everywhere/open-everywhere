export type NetworkTransformer = { headers?: Record<string, string> };
export type PolicyMatch = {
  path?: { exact?: string; startsWith?: string; regex?: string };
  method?: string[];
};
export type PolicyRule = { match?: PolicyMatch; transform?: NetworkTransformer[] };
export type EgressPolicy =
  | "allow-all"
  | "deny-all"
  | {
      allow?: string[] | Record<string, PolicyRule[]>;
      subnets?: { allow?: string[]; deny?: string[] };
    };

export interface AclRequest {
  host: string;
  method?: string;
  path?: string;
}

export interface AclDecision {
  readonly allow: boolean;
  readonly matchedHost?: string;
  readonly headers?: Record<string, string>;
}

const DENY: AclDecision = { allow: false };

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  const m = h.match(/^(.*):(\d+)$/);
  if (m && !h.includes("::")) h = m[1];
  if (h.startsWith("[") && h.includes("]")) h = h.slice(1, h.indexOf("]"));
  return h;
}

export function normalizeSourceIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  return v.startsWith("::ffff:") ? v.slice("::ffff:".length) : v;
}

export function hostKeyMatches(key: string, host: string): boolean {
  const k = normalizeHost(key);
  const h = normalizeHost(host);
  if (k === "*") return true;
  if (k.startsWith("*.")) {
    const suffix = k.slice(1);
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return k === h;
}

function ruleAllows(rule: PolicyRule, req: AclRequest): boolean {
  const m = rule.match;
  if (!m) return true;
  if (m.method && m.method.length > 0 && req.method !== undefined) {
    const want = m.method.map((x) => x.toUpperCase());
    if (!want.includes(req.method.toUpperCase())) return false;
  }
  if (m.path && req.path !== undefined) {
    const p = req.path;
    if (m.path.exact !== undefined && p !== m.path.exact) return false;
    if (m.path.startsWith !== undefined && !p.startsWith(m.path.startsWith)) return false;
    if (m.path.regex !== undefined) {
      try {
        if (!new RegExp(m.path.regex).test(p)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

function mergeHeaders(rule: PolicyRule): Record<string, string> | undefined {
  if (!rule.transform || rule.transform.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const t of rule.transform) {
    if (t.headers) for (const [k, v] of Object.entries(t.headers)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function decide(policy: EgressPolicy | undefined, req: AclRequest): AclDecision {
  if (policy === undefined) return DENY;
  if (policy === "deny-all") return DENY;
  if (policy === "allow-all") return { allow: true };
  const allow = policy.allow;
  if (!allow) return DENY;

  if (Array.isArray(allow)) {
    for (const key of allow) {
      if (hostKeyMatches(key, req.host)) return { allow: true, matchedHost: normalizeHost(key) };
    }
    return DENY;
  }

  for (const [key, rules] of Object.entries(allow)) {
    if (!hostKeyMatches(key, req.host)) continue;
    if (!rules || rules.length === 0) return { allow: true, matchedHost: normalizeHost(key) };
    for (const rule of rules) {
      if (ruleAllows(rule, req)) {
        return { allow: true, matchedHost: normalizeHost(key), headers: mergeHeaders(rule) };
      }
    }
    return DENY;
  }
  return DENY;
}

export class PolicyStore {
  private readonly byIp = new Map<string, EgressPolicy>();

  set(sourceIp: string, policy: EgressPolicy): void {
    this.byIp.set(normalizeSourceIp(sourceIp), policy);
  }

  get(sourceIp: string): EgressPolicy | undefined {
    return this.byIp.get(normalizeSourceIp(sourceIp));
  }

  delete(sourceIp: string): boolean {
    return this.byIp.delete(normalizeSourceIp(sourceIp));
  }

  size(): number {
    return this.byIp.size;
  }

  decide(sourceIp: string, req: AclRequest): AclDecision {
    return decide(this.get(sourceIp), req);
  }
}

export function validatePolicy(input: unknown): EgressPolicy {
  if (input === "allow-all" || input === "deny-all") return input;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const allow = obj.allow;
    if (allow === undefined || Array.isArray(allow) || (allow && typeof allow === "object")) {
      return input as EgressPolicy;
    }
  }
  throw new Error('policy must be "allow-all", "deny-all", or an object with an `allow` list/map');
}
