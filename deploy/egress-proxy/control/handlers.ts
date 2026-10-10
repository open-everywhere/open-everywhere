import { timingSafeEqual } from "node:crypto";
import { PolicyStore, decide, validatePolicy, validateHostPlanePolicy, normalizeSourceIp, type AclRequest, type AclDecision } from "./acl.ts";

export interface PushInput {
  readonly body: unknown;
  readonly remoteAddr: string;
  readonly authOk: boolean;
}

export const MISSING_TOKEN_FATAL =
  "OE_EGRESS_PROXY_TOKEN is required — the control service writes the egress policy that is the " +
  "only thing standing between the sandbox and the open internet, and it listens on the same " +
  "network the sandbox runs on. Refusing to start without it. Generate one with " +
  "`openssl rand -hex 32` and set it on BOTH the proxy and the app (docker-compose.yml passes " +
  "it to both).";

export function requireControlToken(raw: string | undefined): string {
  const token = raw?.trim();
  if (!token) throw new Error(MISSING_TOKEN_FATAL);
  return token;
}

export function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length), "utf-8");
  const want = Buffer.from(token, "utf-8");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
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
  if (obj.plane !== undefined && obj.plane !== "host" && obj.plane !== "session") {
    return { status: 400, body: { error: 'plane must be "host" or "session"' } };
  }
  if (obj.plane === "host") {
    if (obj.policy !== undefined) return { status: 400, body: { error: "a host-plane push carries `hostPlane`, never `policy`" } };
    let hostPolicy;
    try {
      hostPolicy = validateHostPlanePolicy(obj.hostPlane);
    } catch (err) {
      return { status: 400, body: { error: String(err instanceof Error ? err.message : err) } };
    }
    store.setHostPlane(hostPolicy);
    return { status: 200, body: { ok: true, plane: "host", policies: store.size() }, keyed: "host-plane" };
  }
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
  auth?: string;
}

export interface AclResult {
  readonly decision: AclDecision;
  readonly evaluated: boolean;
}

export function handleAcl(store: PolicyStore, q: AclQuery, token?: string): AclResult {
  const src = clean(q.src);
  const host = clean(q.host);
  if (!src || !host) return { decision: { allow: false }, evaluated: false };
  const req: AclRequest = { host };
  const method = clean(q.method);
  const path = clean(q.path);
  if (method) req.method = method;
  if (path) req.path = path;
  const auth = clean(q.auth);
  if (auth !== undefined) {
    if (token === undefined || !bearerMatches(auth, token)) return { decision: { allow: false }, evaluated: true };
    return { decision: decide(store.hostPlane(), { host }), evaluated: true };
  }
  return { decision: store.decide(src, req), evaluated: true };
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = normalizeSourceIp(addr);
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" || t === "-" ? undefined : t;
}
