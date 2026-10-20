import { ProxyAgent, type Dispatcher } from "undici";

import { resolveEgressRoute } from "./host-egress.js";
import { egressProxyToken, egressProxyUrl, postPolicy, useSelfHostEgress, type FetchLike } from "./self-host-egress.js";

const TOOL = "host-plane fetch";

export function hostPlanePolicy(hosts: readonly string[]): { readonly allow: string[] } {
  const allow = [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== ""))];
  if (allow.length === 0) throw new Error(`${TOOL}: no host-plane host declared`);
  for (const h of allow) {
    if (h.includes("*")) throw new Error(`${TOOL}: host-plane hosts are exact hosts, never a wildcard ("${h}")`);
  }
  return { allow };
}

export type HostPlaneTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function hostPlaneFetch(hosts: readonly string[], transport?: HostPlaneTransport): typeof fetch | undefined {
  if (!useSelfHostEgress()) return undefined;
  const policy = hostPlanePolicy(hosts);
  const declared = new Set(policy.allow);
  const send: HostPlaneTransport = transport ?? ((input, init) => globalThis.fetch(input, init));
  let pushed: Promise<void> | undefined;
  const ensurePushed = (): Promise<void> => {
    const proxyUrl = egressProxyUrl();
    if (proxyUrl === undefined) return Promise.reject(new Error(`${TOOL}: egress.proxyUrl is no longer set`));
    pushed ??= egressProxyToken()
      .then((token) => postPolicy(send as unknown as FetchLike, proxyUrl, token, { plane: "host", hostPlane: { allow: policy.allow } }))
      .catch((err: unknown) => {
        pushed = undefined;
        throw err;
      });
    return pushed;
  };
  const agents = new Map<string, Dispatcher>();
  const agentFor = async (proxyUrl: string): Promise<Dispatcher> => {
    let agent = agents.get(proxyUrl);
    if (agent === undefined) {
      const token = await egressProxyToken();
      agent = new ProxyAgent(token === undefined ? { uri: proxyUrl } : { uri: proxyUrl, token: `Bearer ${token}` });
      if (token !== undefined) agents.set(proxyUrl, agent);
    }
    return agent;
  };
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!declared.has(url.hostname.toLowerCase())) {
      throw new Error(`${TOOL}: "${url.hostname}" is not a declared host-plane host (${[...declared].join(", ")}) — refusing.`);
    }
    await ensurePushed();
    const route = resolveEgressRoute(url, process.env, TOOL);
    try {
      if (route.via === "direct") return await send(input, init);
      return await send(input, { ...init, dispatcher: await agentFor(route.proxyUrl) } as RequestInit);
    } catch (err) {
      pushed = undefined;
      agents.clear();
      throw err;
    }
  }) as typeof fetch;
}
