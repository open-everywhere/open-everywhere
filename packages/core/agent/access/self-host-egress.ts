import type { SandboxNetworkPolicy } from "eve/sandbox";

import { onVercel } from "./platform.js";
export { onVercel };

export function egressProxyUrl(): string | undefined {
  const raw = process.env.OE_EGRESS_PROXY_URL?.trim();
  return raw ? raw : undefined;
}

export function useSelfHostEgress(): boolean {
  return !onVercel() && egressProxyUrl() !== undefined;
}

export interface EgressBootLog {
  readonly warn?: string;
  readonly info: string;
}

export function selfHostEgressBootLog(env: NodeJS.ProcessEnv = process.env): EgressBootLog {
  const proxy = (env.OE_EGRESS_PROXY_URL ?? "").trim();
  const allowUnenforced = env.OE_ALLOW_UNENFORCED_EGRESS === "1";
  if (proxy) {
    return {
      info: "[open-everywhere:egress] self-host egress ENFORCED via proxy sidecar (OE_EGRESS_PROXY_URL set) — the compiled policy is pushed to the proxy natively; OE_ALLOW_UNENFORCED_EGRESS is not needed.",
    };
  }
  if (allowUnenforced) {
    return {
      warn:
        "[open-everywhere:egress] ⚠ UNENFORCED egress — no OE_EGRESS_PROXY_URL and OE_ALLOW_UNENFORCED_EGRESS=1: the agent runs WITHOUT a network firewall " +
        "(default-deny egress + at-boundary credential injection are OFF). Dev/testing ONLY — wire the egress-proxy sidecar (docker-compose.yml) for real deployments.",
      info: "[open-everywhere:egress] self-host egress posture = unenforced (OE_ALLOW_UNENFORCED_EGRESS=1)",
    };
  }
  return {
    warn:
      "[open-everywhere:egress] ⚠ egress NOT enforceable — no OE_EGRESS_PROXY_URL configured and OE_ALLOW_UNENFORCED_EGRESS is unset: EVERY session will ABORT at session.started (fail-closed). " +
      "Wire the egress-proxy sidecar (docker-compose.yml / docs/deploy/platforms/self-host-egress.md), or set OE_ALLOW_UNENFORCED_EGRESS=1 to run unenforced in dev.",
    info: "[open-everywhere:egress] self-host egress posture = none (sessions fail-closed until a proxy is wired or OE_ALLOW_UNENFORCED_EGRESS=1)",
  };
}

export interface PushPolicyBody {
  readonly policy: SandboxNetworkPolicy;
  readonly sourceIp?: string;
  readonly sessionId?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export async function postPolicy(
  fetchImpl: FetchLike,
  proxyUrl: string,
  token: string | undefined,
  body: PushPolicyBody,
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
  const token = process.env.OE_EGRESS_PROXY_TOKEN?.trim() || undefined;
  await postPolicy(
    globalThis.fetch as unknown as FetchLike,
    proxyUrl,
    token,
    { policy, sourceIp: opts?.sourceIp ?? (process.env.OE_EGRESS_SOURCE_IP?.trim() || undefined), sessionId: opts?.sessionId },
  );
}
