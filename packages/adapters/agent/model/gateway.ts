import { gateway, createGateway } from "ai";
import {
  type ModelRoute,
  type BindableContext,
  type ModelBackend,
  type RoutedCallOptions,
  type ModelDataPolicy,
  dataPolicyActive,
  dataPolicyRows,
  getSettings,
  hostPlaneFetch,
  hostPlanePolicy,
  liveIdentity,
  resolvePrimaryModel,
} from "@open-everywhere/core/agent/adapter-api.js";

type GatewayModel = ReturnType<typeof gateway>;

const GATEWAY_BASE_URL = process.env.OE_AI_GATEWAY_URL?.trim();

export const DEFAULT_GATEWAY_HOST = "ai-gateway.vercel.sh";

export function gatewayHost(baseUrl: string | undefined): string {
  if (!baseUrl) return DEFAULT_GATEWAY_HOST;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return DEFAULT_GATEWAY_HOST;
  }
}

export const GATEWAY_TARGET_HOST = gatewayHost(GATEWAY_BASE_URL);

const HOST_PLANE_HOSTS: string[] = [GATEWAY_TARGET_HOST];
let hostPlaneCurrent = hostPlaneFetch(HOST_PLANE_HOSTS);
let hostPlaneBuiltFor = HOST_PLANE_HOSTS.length;
const HOST_PLANE_FETCH: typeof fetch | undefined =
  hostPlaneCurrent === undefined
    ? undefined
    : (input, init) => {
        if (hostPlaneBuiltFor !== HOST_PLANE_HOSTS.length) {
          hostPlaneCurrent = hostPlaneFetch(HOST_PLANE_HOSTS);
          hostPlaneBuiltFor = HOST_PLANE_HOSTS.length;
        }
        return hostPlaneCurrent!(input, init);
      };

export function sharedHostPlaneFetch(hosts: readonly string[]): typeof fetch | undefined {
  const named = hosts.map((h) => h.trim()).filter((h) => h !== "");
  if (HOST_PLANE_FETCH !== undefined) hostPlanePolicy([...HOST_PLANE_HOSTS, ...named]);
  for (const h of named) if (!HOST_PLANE_HOSTS.includes(h)) HOST_PLANE_HOSTS.push(h);
  return HOST_PLANE_FETCH;
}

const provider =
  GATEWAY_BASE_URL || HOST_PLANE_FETCH
    ? createGateway({ ...(GATEWAY_BASE_URL ? { baseURL: GATEWAY_BASE_URL } : {}), ...(HOST_PLANE_FETCH ? { fetch: HOST_PLANE_FETCH } : {}) })
    : gateway;

export function vercelDataPolicyOptions(p: ModelDataPolicy): Record<string, unknown> {
  return {
    ...(p.zeroRetention === true ? { zeroDataRetention: true } : {}),
    ...(p.noTraining === true ? { disallowPromptTraining: true } : {}),
    ...(p.region !== undefined ? { inferenceRegion: { scope: "zone", geoRegion: p.region } } : {}),
  };
}

type ProviderOptionsCarrier = { readonly providerOptions?: Record<string, unknown> | undefined };

export function withDataPolicy<T extends ProviderOptionsCarrier>(options: T, p: ModelDataPolicy): T {
  if (!dataPolicyActive(p)) return options;
  const gw = (options.providerOptions?.["gateway"] ?? {}) as Record<string, unknown>;
  return { ...options, providerOptions: { ...options.providerOptions, gateway: { ...gw, ...vercelDataPolicyOptions(p) } } };
}

const NO_PROVIDER = /\bno (?:available )?providers?\b/i;

export function dataPolicyCallError(modelId: string, p: ModelDataPolicy, err: unknown): unknown {
  if (!dataPolicyActive(p)) return err;
  const e = err as { statusCode?: unknown; isRetryable?: unknown };
  if (typeof e?.statusCode !== "number" || e.statusCode < 400 || e.statusCode >= 500 || e.isRetryable === true) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (!NO_PROVIDER.test(msg)) return err;
  return new Error(`models.dataPolicy (${dataPolicyRows(p).join(", ")}): no provider serves "${modelId}" under these rows. The call fails closed and does not fall back. Gateway said: ${msg}`, { cause: err });
}

function currentDataPolicy(): ModelDataPolicy {
  return getSettings().models.dataPolicy;
}

const CALL_METHOD = /^do[A-Z]/;

const ROWLESS_METHODS = new Set<string>(["doCreateClientSecret"]);

function withDataPolicyFor(prop: string, options: ProviderOptionsCarrier, p: ModelDataPolicy): ProviderOptionsCarrier {
  const merged = withDataPolicy(options, p);
  const requests = (merged as { requests?: unknown }).requests;
  if (prop !== "doStartBatch" || !dataPolicyActive(p) || !Array.isArray(requests)) return merged;
  return {
    ...merged,
    requests: requests.map((r: unknown) => {
      const req = r as { options?: ProviderOptionsCarrier } | null;
      return req !== null && typeof req === "object" ? { ...req, options: withDataPolicy(req.options ?? {}, p) } : r;
    }),
  } as ProviderOptionsCarrier;
}

function withGuardedMemberProps<W extends (...a: unknown[]) => unknown>(wrapped: W, member: object, name: string): W {
  for (const [k, v] of Object.entries(member)) {
    (wrapped as unknown as Record<string, unknown>)[k] =
      typeof v === "function"
        ? (...args: unknown[]): unknown => {
            const p = currentDataPolicy();
            if (dataPolicyActive(p)) throw rowlessRefusal(p, `${name}.${k}`);
            return (v as (...a: unknown[]) => unknown).apply(member, args);
          }
        : v;
  }
  return wrapped;
}

function rowlessRefusal(p: ModelDataPolicy, what: string): Error {
  return new Error(`models.dataPolicy (${dataPolicyRows(p).join(", ")}): ${what} cannot carry the rows, so it refuses`);
}

export function policyModel<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || !CALL_METHOD.test(prop) || typeof value !== "function") return value;
      return async (options: unknown, ...rest: unknown[]) => {
        const p = currentDataPolicy();
        const isOptions = options !== null && typeof options === "object" && !Array.isArray(options);
        if ((!isOptions || ROWLESS_METHODS.has(prop)) && dataPolicyActive(p)) throw rowlessRefusal(p, prop);
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).call(receiver, isOptions ? withDataPolicyFor(prop, options as ProviderOptionsCarrier, p) : options, ...rest);
        } catch (err) {
          throw dataPolicyCallError(String((target as { modelId?: unknown }).modelId ?? "?"), p, err);
        }
      };
    },
  });
}

export function gatewayLanguageModel(id: string): GatewayModel {
  return policyModel(provider(id));
}

const OWN_PROVIDER = Symbol.for("open-everywhere.gateway.policyProvider");

const NON_MODEL_MEMBERS = new Set<PropertyKey>(["getAvailableModels", "getCredits", "getSpendReport", "getGenerationInfo", "tools"]);

export function policyProvider<P extends object>(base: P): P {
  return new Proxy(base, {
    apply(target, thisArg, args: unknown[]) {
      const m = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      return m !== null && typeof m === "object" ? policyModel(m) : m;
    },
    get(target, prop, receiver) {
      if (prop === OWN_PROVIDER) return true;
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || NON_MODEL_MEMBERS.has(prop)) return value;
      const wrapped = (...args: unknown[]): unknown => {
        const m = (value as (...a: unknown[]) => unknown).apply(target, args);
        return m !== null && typeof m === "object" ? policyModel(m) : m;
      };
      return withGuardedMemberProps(wrapped, value, String(prop));
    },
  });
}

const sdkGlobal = globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown };
const installed = sdkGlobal.AI_SDK_DEFAULT_PROVIDER;
if (installed === undefined || installed === null) {
  sdkGlobal.AI_SDK_DEFAULT_PROVIDER = policyProvider(provider);
} else if ((typeof installed === "object" || typeof installed === "function") && installed !== null && (installed as Record<symbol, unknown>)[OWN_PROVIDER] !== true) {
  console.error(
    "[open-everywhere:model] AI_SDK_DEFAULT_PROVIDER was already set by another module. A bare model id resolves through it, " +
      "and it cannot carry models.dataPolicy, so under a data policy every such call refuses.",
  );
  sdkGlobal.AI_SDK_DEFAULT_PROVIDER = foreignProviderGuard(installed);
}

export function foreignProviderGuard<P extends object>(base: P): P {
  const guardModel = (m: object): object =>
    new Proxy(m, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof prop !== "string" || !CALL_METHOD.test(prop) || typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const p = currentDataPolicy();
          if (dataPolicyActive(p)) {
            throw new Error(`models.dataPolicy (${dataPolicyRows(p).join(", ")}): this call resolved through a default provider that is not the gateway adapter's, so it cannot carry the rows, and it refuses`);
          }
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(receiver, args);
        };
      },
    });
  return new Proxy(base, {
    apply(target, thisArg, args: unknown[]) {
      const m = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      return m !== null && typeof m === "object" ? guardModel(m) : m;
    },
    get(target, prop, receiver) {
      if (prop === OWN_PROVIDER) return true;
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || NON_MODEL_MEMBERS.has(prop)) return value;
      return withGuardedMemberProps(
        (...args: unknown[]): unknown => {
          const m = (value as (...a: unknown[]) => unknown).apply(target, args);
          return m !== null && typeof m === "object" ? guardModel(m) : m;
        },
        value,
        String(prop),
      );
    },
  });
}

export interface GatewayRoutedDefaults {
  readonly id: string;
  readonly gateway?: Record<string, unknown>;
}

const PIN_KEYS = ["only", "order"] as const;

export function applyGatewayOptions(
  route: ModelRoute,
  options: RoutedCallOptions,
  ids: { readonly id: string; readonly defaultId: string },
  defaults?: Record<string, unknown>,
): RoutedCallOptions {
  const base = (options.providerOptions?.gateway ?? defaults) as Record<string, unknown> | undefined;
  let gatewayOpts = base;
  if (ids.id !== ids.defaultId && base !== undefined) {
    gatewayOpts = { ...base };
    for (const k of PIN_KEYS) delete gatewayOpts[k];
  }
  if (route.providers !== undefined) {
    gatewayOpts = { ...(gatewayOpts ?? {}), order: [...route.providers] };
    delete gatewayOpts["only"];
  }
  if (gatewayOpts === undefined) return options;
  return { ...options, providerOptions: { ...options.providerOptions, gateway: gatewayOpts } };
}

export function gatewayTranscriptionModel(id: string): ReturnType<typeof provider.transcriptionModel> {
  return policyModel(provider.transcriptionModel(id));
}

export function gatewayModelBackend(defaults?: Record<string, unknown>): ModelBackend<GatewayModel> {
  return {
    model: (id) => gatewayLanguageModel(id),
    applyOptions: (route, options, ids) => applyGatewayOptions(route, options, ids, defaults),
  };
}

export function gatewayModelResolver(primary: GatewayRoutedDefaults): (event: unknown, ctx: unknown) => Promise<GatewayModel> {
  const deps = { ...liveIdentity, backend: gatewayModelBackend(primary.gateway) };
  return (event, ctx) => resolvePrimaryModel(ctx as BindableContext, { primary: { id: primary.id } }, deps, event);
}

