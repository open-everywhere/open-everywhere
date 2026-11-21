import type { SandboxNetworkPolicy } from "eve/sandbox";

import { getSettings } from "../settings/settings.js";
import { operatorSecret } from "../credentials/operator-secrets.js";

import { resolveSelfHostBackendKind, sandboxOnVercel } from "../sandbox/backend-select.js";

import { onVercel } from "./platform.js";
export { onVercel };

const EGRESS_PROXY_TOKEN_SECRET = "OE_EGRESS_PROXY_TOKEN";

export function egressProxyUrl(): string | undefined {
  const raw = getSettings().egress.proxyUrl.trim();
  return raw ? raw : undefined;
}

function egressSourceIp(): string | undefined {
  return getSettings().egress.sourceIp.trim() || undefined;
}

export function useSelfHostEgress(): boolean {
  return !sandboxOnVercel() && egressProxyUrl() !== undefined;
}

export interface EgressBootLog {
  readonly fatal?: string;
  readonly warn?: string;
  readonly info: string;
}

export const DOCKER_BEHIND_PROXY_FATAL =
  "[open-everywhere:egress] refusing to boot: sandbox.selfHostBackend \"docker\" with egress.proxyUrl set. The docker backend starts each session container " +
  "on the Docker daemon's default network, outside the egress proxy, so the proxy cannot enforce that session's egress. " +
  "Declare sandbox.selfHostBackend \"justbash\" behind the proxy (its egress leaves through this app process), or run docker without egress.proxyUrl " +
  "(docker then applies only the coarse \"deny-all\", and a session that needs a host allow-list aborts), or deploy on Vercel.";

export function selfHostEgressBootLog(proxyUrl: string | undefined = egressProxyUrl()): EgressBootLog {
  const proxy = (proxyUrl ?? "").trim();
  const allowUnenforced = getSettings().egress.allowUnenforced;
  if (proxy) {
    if (resolveSelfHostBackendKind() === "docker") {
      return { fatal: DOCKER_BEHIND_PROXY_FATAL, info: "[open-everywhere:egress] self-host egress posture = refused (docker backend behind the proxy)" };
    }
    return {
      info: "[open-everywhere:egress] self-host egress ENFORCED via proxy sidecar (egress.proxyUrl set) — the compiled policy is pushed to the proxy natively; `egress.allowUnenforced` is not needed. The app's own model call is decided against its host-plane list, never against a session policy (OPE-2406).",
    };
  }
  if (allowUnenforced) {
    return {
      warn:
        "[open-everywhere:egress] ⚠ UNENFORCED egress — no egress.proxyUrl and `egress.allowUnenforced: true` in agent/settings.ts: the agent runs WITHOUT a network firewall " +
        "(default-deny egress + at-boundary credential injection are OFF). Dev/testing ONLY — wire the egress-proxy sidecar (docker-compose.yml) for real deployments.",
      info: "[open-everywhere:egress] self-host egress posture = unenforced (egress.allowUnenforced)",
    };
  }
  return {
    warn:
      "[open-everywhere:egress] ⚠ egress NOT enforceable — no egress.proxyUrl configured and `egress.allowUnenforced` is off: any session that resolves a HOST ALLOW-LIST will ABORT at session.started (fail-closed). " +
      "Neither wired backend applies a fine-grained policy: justbash rejects every setNetworkPolicy, and docker accepts only the coarse \"allow-all\"/\"deny-all\" strings. A session that reaches nothing compiles to \"deny-all\", which docker DOES apply — that session boots, with no network at all. " +
      "Wire the egress-proxy sidecar (docker-compose.yml / docs/deploy/platforms/self-host-egress.md) and declare `egress: { proxyUrl }`, or declare `egress: { allowUnenforced: true }` in agent/settings.ts to run unenforced in dev.",
    info: "[open-everywhere:egress] self-host egress posture = none (a session needing any host fails closed until a proxy is wired or egress.allowUnenforced is declared)",
  };
}

export async function egressProxyToken(): Promise<string | undefined> {
  return (await operatorSecret(EGRESS_PROXY_TOKEN_SECRET))?.trim() || undefined;
}

export interface PushPolicyBody {
  readonly policy: SandboxNetworkPolicy;
  readonly sourceIp?: string;
  readonly sessionId?: string;
}

export interface HostPlanePushBody {
  readonly plane: "host";
  readonly hostPlane: { readonly allow: readonly string[] };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export async function postPolicy(
  fetchImpl: FetchLike,
  proxyUrl: string,
  token: string | undefined,
  body: PushPolicyBody | HostPlanePushBody,
): Promise<void> {
  const url = `${proxyUrl.replace(/\/+$/, "")}/policy`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`egress-proxy push failed (network): ${String(err)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`egress-proxy push rejected (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
}

export async function pushEgressPolicy(
  policy: SandboxNetworkPolicy,
  opts?: { sourceIp?: string; sessionId?: string },
): Promise<void> {
  const proxyUrl = egressProxyUrl();
  if (!proxyUrl) {
    throw new Error("pushEgressPolicy called with no egress.proxyUrl set (self-host egress not configured)");
  }
  const token = await egressProxyToken();
  await postPolicy(
    globalThis.fetch as unknown as FetchLike,
    proxyUrl,
    token,
    { policy, sourceIp: opts?.sourceIp ?? egressSourceIp(), sessionId: opts?.sessionId },
  );
}

export function boxDockerNetwork(): string | undefined {
  return getSettings().sandbox.boxDockerNetwork.trim() || undefined;
}

export function boxEgressBehindProxy(): boolean {
  return useSelfHostEgress() && boxDockerNetwork() !== undefined;
}

export async function pushBoxEgressPolicy(sourceIp: string, policy: SandboxNetworkPolicy, opts?: { readonly sessionId?: string }): Promise<void> {
  if (sourceIp.trim() === "") throw new Error("pushBoxEgressPolicy needs the container's IP");
  await pushEgressPolicy(policy, { sourceIp, ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}) });
}

export async function dropBoxEgressPolicy(sourceIp: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<void> {
  const proxyUrl = egressProxyUrl();
  if (!proxyUrl) throw new Error("dropBoxEgressPolicy called with no egress.proxyUrl set");
  const token = await egressProxyToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const url = `${proxyUrl.replace(/\/+$/, "")}/policy?sourceIp=${encodeURIComponent(sourceIp)}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: "DELETE", headers, body: "" });
  } catch (err) {
    throw new Error(`egress-proxy policy drop failed (network): ${String(err)}`);
  }
  if (!res.ok && res.status !== 404) throw new Error(`egress-proxy policy drop rejected (HTTP ${res.status})`);
}

const SESSION_POLICY_CAP = 256;
const lastSessionPolicy = new Map<string, SandboxNetworkPolicy>();
const sessionBoxIps = new Map<string, Set<string>>();

function rememberSessionPolicy(sessionId: string, policy: SandboxNetworkPolicy): void {
  lastSessionPolicy.delete(sessionId);
  lastSessionPolicy.set(sessionId, policy);
  let unbound = [...lastSessionPolicy.keys()].filter((k) => !sessionBoxIps.has(k)).length;
  for (const k of [...lastSessionPolicy.keys()]) {
    if (unbound <= SESSION_POLICY_CAP) break;
    if (sessionBoxIps.has(k)) continue;
    lastSessionPolicy.delete(k);
    unbound--;
  }
}

export function hasSessionPolicy(sessionId: string): boolean {
  return lastSessionPolicy.has(sessionId);
}

export async function pushSessionEgressPolicy(
  policy: SandboxNetworkPolicy,
  opts: {
    readonly auditId?: string;
    readonly boxSession?: string;
  },
  push: typeof pushEgressPolicy = pushEgressPolicy,
): Promise<void> {
  const audit = opts.auditId !== undefined ? { sessionId: opts.auditId } : {};
  await push(policy, opts.auditId !== undefined ? audit : undefined);
  const key = opts.boxSession;
  if (key === undefined || !boxEgressBehindProxy()) return;
  rememberSessionPolicy(key, policy);
  for (const ip of sessionBoxIps.get(key) ?? []) await push(policy, { sourceIp: ip, ...audit });
}

export async function bindSessionBox(sessionId: string, sourceIp: string, push: typeof pushEgressPolicy = pushEgressPolicy): Promise<void> {
  let policy = lastSessionPolicy.get(sessionId);
  if (policy === undefined) {
    throw new Error("this session has pushed no egress policy in this process yet, so its browser container would have nothing to enforce — refusing to bind it");
  }
  const ips = sessionBoxIps.get(sessionId) ?? new Set<string>();
  ips.add(sourceIp);
  sessionBoxIps.set(sessionId, ips);
  try {
    for (;;) {
      await push(policy, { sourceIp, sessionId });
      const latest = lastSessionPolicy.get(sessionId);
      if (latest === undefined || latest === policy) break;
      policy = latest;
    }
  } catch (err) {
    unbindSessionBox(sessionId, sourceIp);
    throw err;
  }
}

export function unbindSessionBox(sessionId: string, sourceIp: string): void {
  const ips = sessionBoxIps.get(sessionId);
  if (ips === undefined) return;
  ips.delete(sourceIp);
  if (ips.size === 0) sessionBoxIps.delete(sessionId);
}

export function resetSessionBoxesForTest(): void {
  lastSessionPolicy.clear();
  sessionBoxIps.clear();
}
