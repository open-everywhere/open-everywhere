import { PolicyStore, validatePolicy, type AclRequest, type AclDecision } from "./acl.ts";

export interface PushInput {
  readonly body: unknown;
  readonly remoteAddr: string;
  readonly authOk: boolean;
}

export interface PushResult {
  readonly status: number;
  readonly body: unknown;
  readonly keyed?: string;
}

export function handlePolicyPush(store: PolicyStore, input: PushInput): PushResult {
  if (!input.authOk) return { status: 401, body: { error: "unauthorized" } };
  const body = input.body;
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "expected a JSON object body" } };
  }
  const obj = body as Record<string, unknown>;
  let policy;
  try {
    policy = validatePolicy(obj.policy);
  } catch (err) {
    return { status: 400, body: { error: String(err instanceof Error ? err.message : err) } };
  }
  const explicit = typeof obj.sourceIp === "string" && obj.sourceIp.trim() ? obj.sourceIp.trim() : undefined;
  const key = explicit ?? input.remoteAddr;
  if (!key) return { status: 400, body: { error: "no source IP: set body.sourceIp or connect from the sandbox network" } };
  store.set(key, policy);
  return { status: 200, body: { ok: true, sourceIp: key, policies: store.size() }, keyed: key };
}

export interface AclQuery {
  src?: string;
  host?: string;
  method?: string;
  path?: string;
}

export interface AclResult {
  readonly decision: AclDecision;
  readonly evaluated: boolean;
}

export function handleAcl(store: PolicyStore, q: AclQuery): AclResult {
  const src = clean(q.src);
  const host = clean(q.host);
  if (!src || !host) return { decision: { allow: false }, evaluated: false };
  const req: AclRequest = { host };
  const method = clean(q.method);
  const path = clean(q.path);
  if (method) req.method = method;
  if (path) req.path = path;
  return { decision: store.decide(src, req), evaluated: true };
}

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" || t === "-" ? undefined : t;
}
