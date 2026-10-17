import {
  DEFAULT_MODEL_VIA,
  getSettings,
  modelTargetFor,
  registerStatusProbe,
  onVercel,
  type ProbeAnswer,
  type ResolvableModel,
} from "@open-everywhere/core/agent/adapter-api.js";
import { checkModelConfig, type ConfigCheckResult } from "./model-config-check.js";
import { targetBaseUrl } from "./target-url.js";

export const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";

export const GATEWAY_PROBE_TIMEOUT_MS = 2_000;

function gatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const targets = getSettings().models.targets;
  return targetBaseUrl(DEFAULT_MODEL_VIA, modelTargetFor(DEFAULT_MODEL_VIA, targets), env);
}

export function gatewayCatalogUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = gatewayBaseUrl(env);
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
  readonly models?: () => readonly ResolvableModel[];
  readonly cache?: ConfigCheckCache;
  readonly now?: () => number;
}

const MODEL_CONFIG_CHECK_TTL_MS = 10 * 60_000;

export interface ConfigCheckCache {
  value?: { readonly at: number; readonly result: ConfigCheckResult };
}
const CONFIG_CHECK_CACHE: ConfigCheckCache = {};

let registeredModels: (() => readonly ResolvableModel[]) | undefined;

export function registerModelConfigCheck(models: () => readonly ResolvableModel[]): void {
  registeredModels = models;
}

function publicConfigWords(r: ConfigCheckResult): string {
  if (r.met === "no") return "the model config has a models.dataPolicy, providers.only or target dataPolicy demand that no provider can serve for at least one model — run `npm run check:model-config` for the names";
  if (r.met === "unknown" && r.findings.every((f) => f.row.endsWith(".providers.only"))) {
    return "the model config can be served; a providers.only name serves none of the checked models — run `npm run check:model-config` for the names";
  }
  if (r.met === "unknown") return "the model config was not fully measured — run `npm run check:model-config` for the details";
  return "the model config can be served";
}

async function cachedConfigCheck(deps: GatewayProbeDeps, models: () => readonly ResolvableModel[]): Promise<ConfigCheckResult> {
  const cache = deps.cache ?? CONFIG_CHECK_CACHE;
  const now = (deps.now ?? Date.now)();
  if (cache.value !== undefined && now - cache.value.at < MODEL_CONFIG_CHECK_TTL_MS) return cache.value.result;
  const env = deps.env ?? process.env;
  let result: ConfigCheckResult;
  try {
    const settings = getSettings().models;
    result = await checkModelConfig({
      models: models(),
      targets: settings.targets,
      policy: settings.dataPolicy,
      baseUrlFor: (via) => targetBaseUrl(via, modelTargetFor(via, settings.targets), env),
      timeoutMs: GATEWAY_PROBE_TIMEOUT_MS,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    result = { met: "unknown", findings: [{ met: "unknown", row: "config", detail: "the model config could not be read" }], checked: 0 };
  }
  cache.value = { at: now, result };
  return result;
}

export async function probeGatewayRoute(deps: GatewayProbeDeps = {}): Promise<ProbeAnswer> {
  const env = deps.env ?? process.env;
  const vercel = deps.vercel ?? onVercel();
  const keySet = (env.AI_GATEWAY_API_KEY ?? "").trim().length > 0;
  const retargeted = gatewayBaseUrl(env) !== undefined;
  if (!vercel && !keySet) {
    if (retargeted) {
      return { met: "unknown", detail: "the model route is retargeted (models.targets.gateway.url) and holds no AI_GATEWAY_API_KEY — a relay may need neither, so this was not measured" };
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
    const reached = `the model gateway answered a catalog read and the credential posture is ${credential} — this does not prove an inference call is authorised`;
    const models = deps.models ?? registeredModels;
    if (models === undefined) return { met: "yes", detail: reached };
    const check = await cachedConfigCheck(deps, models);
    return { met: check.met === "no" ? "no" : "yes", detail: `${reached}; ${publicConfigWords(check)}` };
  } catch {
    return { met: "no", detail: `the model gateway did not answer within ${GATEWAY_PROBE_TIMEOUT_MS} ms; the credential posture is ${credential}` };
  } finally {
    clearTimeout(fuse);
  }
}

export function registerGatewayRouteProbe(): void {
  registerStatusProbe("model-route", () => probeGatewayRoute());
}
