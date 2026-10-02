import { registerStatusProbe, onVercel, type ProbeAnswer } from "@open-everywhere/core/agent/adapter-api.js";

export const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";

export const GATEWAY_PROBE_TIMEOUT_MS = 2_000;

export function gatewayCatalogUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OE_AI_GATEWAY_URL?.trim();
  if (!override) return GATEWAY_CATALOG_URL;
  try {
    return `${new URL(override).origin}/v1/models/catalog`;
  } catch {
    return GATEWAY_CATALOG_URL;
  }
}

export interface GatewayProbeDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly vercel?: boolean;
}

export async function probeGatewayRoute(deps: GatewayProbeDeps = {}): Promise<ProbeAnswer> {
  const env = deps.env ?? process.env;
  const vercel = deps.vercel ?? onVercel();
  const keySet = (env.AI_GATEWAY_API_KEY ?? "").trim().length > 0;
  const retargeted = (env.OE_AI_GATEWAY_URL ?? "").trim().length > 0;
  if (!vercel && !keySet) {
    if (retargeted) {
      return { met: "unknown", detail: "the model route is retargeted by OE_AI_GATEWAY_URL and holds no AI_GATEWAY_API_KEY — a relay may need neither, so this was not measured" };
    }
    return { met: "no", detail: "no gateway credential: off Vercel the deployment needs AI_GATEWAY_API_KEY (on Vercel, OIDC authenticates it)" };
  }
  const credential = vercel ? "OIDC on Vercel" : "AI_GATEWAY_API_KEY";
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const fuse = setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(gatewayCatalogUrl(env), { method: "GET", signal: controller.signal });
    if (!res.ok) {
      if (retargeted && (res.status === 404 || res.status === 405)) {
        return { met: "unknown", detail: `the retargeted model gateway does not serve a model catalog (HTTP ${res.status}), so reachability was not measured; the credential posture is ${credential}` };
      }
      return { met: "no", detail: `the model gateway answered HTTP ${res.status} to a catalog read; the credential posture is ${credential}` };
    }
    return {
      met: "yes",
      detail: `the model gateway answered a catalog read and the credential posture is ${credential} — this does not prove an inference call is authorised`,
    };
  } catch {
    return { met: "no", detail: `the model gateway did not answer within ${GATEWAY_PROBE_TIMEOUT_MS} ms; the credential posture is ${credential}` };
  } finally {
    clearTimeout(fuse);
  }
}

export function registerGatewayRouteProbe(): void {
  registerStatusProbe("model-route", () => probeGatewayRoute());
}
