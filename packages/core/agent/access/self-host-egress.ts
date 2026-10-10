import type { SandboxNetworkPolicy } from "eve/sandbox";

import { getSettings } from "../settings/settings.js";

import { resolveSelfHostBackendKind, sandboxOnVercel } from "../sandbox/backend-select.js";

import { onVercel } from "./platform.js";
export { onVercel };

export function egressProxyUrl(): string | undefined {
  const raw = process.env.OE_EGRESS_PROXY_URL?.trim();
  return raw ? raw : undefined;
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
  "[open-everywhere:egress] refusing to boot: sandbox.selfHostBackend \"docker\" with OE_EGRESS_PROXY_URL set. The docker backend starts each session container " +
  "on the Docker daemon's default network, outside the egress proxy, so the proxy cannot enforce that session's egress. " +
  "Declare sandbox.selfHostBackend \"justbash\" behind the proxy (its egress leaves through this app process), or run docker without OE_EGRESS_PROXY_URL " +
  "(docker then applies only the coarse \"deny-all\", and a session that needs a host allow-list aborts), or deploy on Vercel.";

export function selfHostEgressBootLog(env: NodeJS.ProcessEnv = process.env): EgressBootLog {
  const proxy = (env.OE_EGRESS_PROXY_URL ?? "").trim();
  const allowUnenforced = getSettings().egress.allowUnenforced;
  if (proxy) {
    if (resolveSelfHostBackendKind() === "docker") {
      return { fatal: DOCKER_BEHIND_PROXY_FATAL, info: "[open-everywhere:egress] self-host egress posture = refused (docker backend behind the proxy)" };
    }
    return {
      info: "[open-everywhere:egress] self-host egress ENFORCED via proxy sidecar (OE_EGRESS_PROXY_URL set) — the compiled policy is pushed to the proxy natively; `egress.allowUnenforced` is not needed. The app's own model call is decided against its host-plane list, never against a session policy (OPE-2406).",
    };
  }
  if (allowUnenforced) {
    return {
      warn:
        "[open-everywhere:egress] ⚠ UNENFORCED egress — no OE_EGRESS_PROXY_URL and `egress.allowUnenforced: true` in agent/settings.ts: the agent runs WITHOUT a network firewall " +
        "(default-deny egress + at-boundary credential injection are OFF). Dev/testing ONLY — wire the egress-proxy sidecar (docker-compose.yml) for real deployments.",
      info: "[open-everywhere:egress] self-host egress posture = unenforced (egress.allowUnenforced)",
    };
  }
  return {
    warn:
      "[open-everywhere:egress] ⚠ egress NOT enforceable — no OE_EGRESS_PROXY_URL configured and `egress.allowUnenforced` is off: any session that resolves a HOST ALLOW-LIST will ABORT at session.started (fail-closed). " +
      "Neither wired backend applies a fine-grained policy: justbash rejects every setNetworkPolicy, and docker accepts only the coarse \"allow-all\"/\"deny-all\" strings. A session that reaches nothing compiles to \"deny-all\", which docker DOES apply — that session boots, with no network at all. " +
      "Wire the egress-proxy sidecar (docker-compose.yml / docs/deploy/platforms/self-host-egress.md), or declare `egress: { allowUnenforced: true }` in agent/settings.ts to run unenforced in dev.",
    info: "[open-everywhere:egress] self-host egress posture = none (a session needing any host fails closed until a proxy is wired or egress.allowUnenforced is declared)",
  };
}

export function egressProxyToken(): string | undefined {
  return process.env.OE_EGRESS_PROXY_TOKEN?.trim() || undefined;
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
    throw new Error("pushEgressPolicy called with no OE_EGRESS_PROXY_URL set (self-host egress not configured)");
  }
  const token = egressProxyToken();
  await postPolicy(
    globalThis.fetch as unknown as FetchLike,
    proxyUrl,
    token,
    { policy, sourceIp: opts?.sourceIp ?? (process.env.OE_EGRESS_SOURCE_IP?.trim() || undefined), sessionId: opts?.sessionId },
  );
}
