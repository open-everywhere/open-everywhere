import { gateway, createGateway } from "ai";
import {
  type ModelRoute,
  type BindableContext,
  type ModelBackend,
  type RoutedCallOptions,
  type ModelDataPolicy,
  type ModelTarget,
  DEFAULT_MODEL_VIA,
  bareModelRoutesRegistered,
  bareModelVia,
  dataPolicyActive,
  dataPolicyRows,
  mergeDataPolicy,
  getSettings,
  hostPlaneFetch,
  hostPlanePolicy,
  liveIdentity,
  modelTargetFor,
  operatorSecretOrUnset,
  resolvePrimaryModel,
  useSelfHostEgress,
} from "@open-everywhere/core/agent/adapter-api.js";
import { targetBaseUrl } from "./target-url.js";

export { targetBaseUrl } from "./target-url.js";

type GatewayModel = ReturnType<typeof gateway>;
type GatewayProvider = typeof gateway;

function currentTargets(): ReturnType<typeof getSettings>["models"]["targets"] {
  return getSettings().models.targets;
}

export const DEFAULT_GATEWAY_HOST = "ai-gateway.vercel.sh";

export function gatewayHost(baseUrl: string | undefined): string {
  if (!baseUrl) return DEFAULT_GATEWAY_HOST;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return DEFAULT_GATEWAY_HOST;
  }
}

const TARGET_URLS = new Map<string, string | undefined>();
function resolvedTargetUrl(name: string): string | undefined {
  if (!TARGET_URLS.has(name)) TARGET_URLS.set(name, targetBaseUrl(name, modelTargetFor(name, currentTargets())));
  return TARGET_URLS.get(name);
}

export function gatewayTargetHost(): string {
  return gatewayHost(resolvedTargetUrl(DEFAULT_MODEL_VIA));
}

function targetHosts(): string[] {
  return Object.keys(currentTargets()).map((name) => gatewayHost(resolvedTargetUrl(name)));
}

const HOST_PLANE_HOSTS: string[] = [];
let hostPlaneCurrent: typeof fetch | undefined;
let hostPlaneBuiltFor = -1;
let targetHostsSeeded = false;
function seedTargetHosts(): void {
  if (targetHostsSeeded) return;
  targetHostsSeeded = true;
  for (const h of targetHosts()) if (!HOST_PLANE_HOSTS.includes(h)) HOST_PLANE_HOSTS.unshift(h);
}
const HOST_PLANE_FETCH: typeof fetch | undefined = !useSelfHostEgress()
  ? undefined
  : (input, init) => {
        seedTargetHosts();
        if (hostPlaneCurrent === undefined || hostPlaneBuiltFor !== HOST_PLANE_HOSTS.length) {
          hostPlaneCurrent = hostPlaneFetch(HOST_PLANE_HOSTS);
          hostPlaneBuiltFor = HOST_PLANE_HOSTS.length;
        }
        return hostPlaneCurrent!(input, init);
      };

export function sharedHostPlaneFetch(hosts: readonly string[]): typeof fetch | undefined {
  const named = hosts.map((h) => h.trim()).filter((h) => h !== "");
  if (HOST_PLANE_FETCH !== undefined && named.length > 0) hostPlanePolicy(named);
  for (const h of named) if (!HOST_PLANE_HOSTS.includes(h)) HOST_PLANE_HOSTS.push(h);
  return HOST_PLANE_FETCH;
}

const AI_GATEWAY_API_KEY_NAME = "AI_GATEWAY_API_KEY";

let gatewayApiKey: string | undefined;

async function refreshGatewayApiKey(): Promise<void> {
  gatewayApiKey = await operatorSecretOrUnset(AI_GATEWAY_API_KEY_NAME);
}

const TARGET_PROVIDERS = new Map<string, GatewayProvider>();
function targetProvider(via: string | undefined): GatewayProvider {
  const name = via ?? DEFAULT_MODEL_VIA;
  let p = TARGET_PROVIDERS.get(name);
  if (p === undefined) {
    const baseURL = resolvedTargetUrl(name);
    p = createGateway({
      get apiKey(): string | undefined {
        return gatewayApiKey;
      },
      ...(baseURL !== undefined ? { baseURL } : {}),
      ...(HOST_PLANE_FETCH !== undefined ? { fetch: HOST_PLANE_FETCH } : {}),
    });
    TARGET_PROVIDERS.set(name, p);
  }
  return p;
}

export function vercelDataPolicyOptions(p: ModelDataPolicy): Record<string, unknown> {
  return {
    ...(p.zeroRetention === true ? { zeroDataRetention: true } : {}),
    ...(p.noTraining === true ? { disallowPromptTraining: true } : {}),
    ...(p.region !== undefined ? { inferenceRegion: { scope: "zone", geoRegion: p.region } } : {}),
  };
}

type ProviderOptionsCarrier = { readonly providerOptions?: Record<string, unknown> | undefined };

export function withDataPolicy<T extends ProviderOptionsCarrier>(options: T, p: ModelDataPolicy): T {
  return withTargetRows(options, undefined, p);
}

function demandsAnything(t: ModelTarget | undefined, p: ModelDataPolicy): boolean {
  return dataPolicyActive(p) || (t?.providers?.only?.length ?? 0) > 0 || (t?.dataPolicy !== undefined && dataPolicyActive(t.dataPolicy));
}

export function demandLabel(p: ModelDataPolicy, t?: ModelTarget, via: string = DEFAULT_MODEL_VIA): string {
  const parts: string[] = [];
  if (dataPolicyActive(p)) parts.push(`models.dataPolicy (${dataPolicyRows(p).join(", ")})`);
  const only = t?.providers?.only;
  if (only !== undefined && only.length > 0) parts.push(`models.targets.${via}.providers.only (${only.join(", ")})`);
  if (t?.dataPolicy !== undefined && dataPolicyActive(t.dataPolicy)) parts.push(`models.targets.${via}.dataPolicy (${dataPolicyRows(t.dataPolicy).join(", ")})`);
  return parts.join(" + ");
}

export function withTargetRows<T extends ProviderOptionsCarrier>(options: T, t: ModelTarget | undefined, global: ModelDataPolicy, via: string = DEFAULT_MODEL_VIA): T {
  const floor = t?.options;
  const only = t?.providers?.only;
  const order = t?.providers?.order;
  let p: ModelDataPolicy;
  try {
    p = mergeDataPolicy(global, t?.dataPolicy);
  } catch (err) {
    throw new Error(`models.targets.${via}.dataPolicy: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (floor === undefined && only === undefined && order === undefined && !dataPolicyActive(p)) return options;
  const gw = (options.providerOptions?.["gateway"] ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...floor, ...gw };
  if (order !== undefined && merged["order"] === undefined) merged["order"] = [...order];
  if (only !== undefined) {
    const own = Array.isArray(gw["only"]) ? (gw["only"] as unknown[]) : undefined;
    const allowed = own === undefined ? [...only] : own.filter((s): s is string => typeof s === "string" && only.includes(s));
    if (allowed.length === 0) {
      throw new Error(`${demandLabel(global, t, via)}: the call's own provider list (${(own ?? []).join(", ")}) shares no provider with the target's, so it refuses`);
    }
    merged["only"] = allowed;
  }
  Object.assign(merged, vercelDataPolicyOptions(p));
  return { ...options, providerOptions: { ...options.providerOptions, gateway: merged } };
}

const NO_PROVIDER = /\bno (?:available )?providers?\b/i;

export function dataPolicyCallError(modelId: string, p: ModelDataPolicy, err: unknown, t?: ModelTarget, via?: string): unknown {
  if (!demandsAnything(t, p)) return err;
  const e = err as { statusCode?: unknown; isRetryable?: unknown };
  if (typeof e?.statusCode !== "number" || e.statusCode < 400 || e.statusCode >= 500 || e.isRetryable === true) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (!NO_PROVIDER.test(msg)) return err;
  return new Error(`${demandLabel(p, t, via)}: no provider serves "${modelId}" under these rows. The call fails closed and does not fall back. Gateway said: ${msg}`, { cause: err });
}

function currentDataPolicy(): ModelDataPolicy {
  return getSettings().models.dataPolicy;
}

const CALL_METHOD = /^do[A-Z]/;

const ROWLESS_METHODS = new Set<string>(["doCreateClientSecret"]);

function withRowsFor(prop: string, options: ProviderOptionsCarrier, t: ModelTarget | undefined, p: ModelDataPolicy, via: string): ProviderOptionsCarrier {
  const merged = withTargetRows(options, t, p, via);
  const requests = (merged as { requests?: unknown }).requests;
  if (prop !== "doStartBatch" || merged === options || !Array.isArray(requests)) return merged;
  return {
    ...merged,
    requests: requests.map((r: unknown) => {
      const req = r as { options?: ProviderOptionsCarrier } | null;
      return req !== null && typeof req === "object" ? { ...req, options: withTargetRows(req.options ?? {}, t, p, via) } : r;
    }),
  } as ProviderOptionsCarrier;
}

function currentTarget(via: string): ModelTarget {
  return modelTargetFor(via, currentTargets());
}

function withGuardedMemberProps<W extends (...a: unknown[]) => unknown>(wrapped: W, member: object, name: string, via: string = DEFAULT_MODEL_VIA): W {
  for (const [k, v] of Object.entries(member)) {
    (wrapped as unknown as Record<string, unknown>)[k] =
      typeof v === "function"
        ? (...args: unknown[]): unknown => {
            const p = currentDataPolicy();
            const t = currentTarget(via);
            if (demandsAnything(t, p)) throw rowlessRefusal(p, `${name}.${k}`, t, via);
            return (v as (...a: unknown[]) => unknown).apply(member, args);
          }
        : v;
  }
  return wrapped;
}

function rowlessRefusal(p: ModelDataPolicy, what: string, t?: ModelTarget, via?: string): Error {
  return new Error(`${demandLabel(p, t, via)}: ${what} cannot carry the rows, so it refuses`);
}

export function policyModel<M extends object>(model: M, via: string = DEFAULT_MODEL_VIA): M {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || !CALL_METHOD.test(prop) || typeof value !== "function") return value;
      return async (options: unknown, ...rest: unknown[]) => {
        const p = currentDataPolicy();
        const t = currentTarget(via);
        const isOptions = options !== null && typeof options === "object" && !Array.isArray(options);
        if ((!isOptions || ROWLESS_METHODS.has(prop)) && demandsAnything(t, p)) throw rowlessRefusal(p, prop, t, via);
        const sent = isOptions ? withRowsFor(prop, options as ProviderOptionsCarrier, t, p, via) : options;
        await refreshGatewayApiKey();
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).call(receiver, sent, ...rest);
        } catch (err) {
          throw dataPolicyCallError(String((target as { modelId?: unknown }).modelId ?? "?"), p, err, t, via);
        }
      };
    },
  });
}

export function gatewayLanguageModel(id: string, via?: string): GatewayModel {
  return policyModel(targetProvider(via)(id), via ?? DEFAULT_MODEL_VIA);
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

function bareViaOf(args: readonly unknown[]): string {
  noteUnregisteredBareIds();
  return bareModelVia(typeof args[0] === "string" ? args[0] : "").via;
}

let bareGapNoted = false;

function noteUnregisteredBareIds(): void {
  if (bareGapNoted || bareModelRoutesRegistered()) return;
  if (!Object.keys(currentTargets()).some((k) => k !== DEFAULT_MODEL_VIA)) return;
  bareGapNoted = true;
  console.error(
    "[open-everywhere:model] a bare model id (a declared subagent's model, eve evaluate()) goes via gateway, because agent/model/models.ts " +
      "does not call registerBareModelRoutes. Add the line from the 0.8.0 template so it takes its role's target. npm run check:model-config names this too.",
  );
}

export function _resetBareGapNoticeForTest(): void {
  bareGapNoted = false;
}

export function bareIdProvider(): GatewayProvider {
  const build = (prop: PropertyKey | undefined, args: unknown[]): unknown => {
    const via = bareViaOf(args);
    const p = targetProvider(via);
    const m = prop === undefined ? Reflect.apply(p as unknown as (...a: unknown[]) => unknown, undefined, args) : (Reflect.get(p, prop) as (...a: unknown[]) => unknown).apply(p, args);
    return m !== null && typeof m === "object" ? policyModel(m, via) : m;
  };
  return new Proxy(function bareIdGateway() {} as unknown as GatewayProvider, {
    apply: (_t, _thisArg, args: unknown[]) => build(undefined, args),
    get: (_t, prop) => {
      if (prop === OWN_PROVIDER) return true;
      const via = bareModelVia("").via;
      const value = Reflect.get(targetProvider(via), prop) as unknown;
      if (typeof value !== "function" || NON_MODEL_MEMBERS.has(prop)) return value;
      return withGuardedMemberProps((...args: unknown[]): unknown => build(prop, args), value, String(prop), via);
    },
    has: (_t, prop) => prop === OWN_PROVIDER || Reflect.has(targetProvider(bareModelVia("").via), prop),
  });
}

const sdkGlobal = globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown };
const installed = sdkGlobal.AI_SDK_DEFAULT_PROVIDER;
if (installed === undefined || installed === null) {
  sdkGlobal.AI_SDK_DEFAULT_PROVIDER = bareIdProvider();
} else if ((typeof installed === "object" || typeof installed === "function") && installed !== null && (installed as Record<symbol, unknown>)[OWN_PROVIDER] !== true) {
  console.error(
    "[open-everywhere:model] AI_SDK_DEFAULT_PROVIDER was already set by another module. A bare model id resolves through it, " +
      "and it cannot carry models.dataPolicy, so under a data policy every such call refuses.",
  );
  sdkGlobal.AI_SDK_DEFAULT_PROVIDER = foreignProviderGuard(installed);
}

export function foreignProviderGuard<P extends object>(base: P): P {
  const guardModel = (m: object, via: string): object =>
    new Proxy(m, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof prop !== "string" || !CALL_METHOD.test(prop) || typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (via !== DEFAULT_MODEL_VIA) {
            throw new Error(`this call goes through the target "${via}", but it resolved through a default provider that is not the gateway adapter's, so it cannot reach that target, and it refuses`);
          }
          const p = currentDataPolicy();
          const t = currentTarget(via);
          if (demandsAnything(t, p)) {
            throw new Error(`${demandLabel(p, t)}: this call resolved through a default provider that is not the gateway adapter's, so it cannot carry the rows, and it refuses`);
          }
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(receiver, args);
        };
      },
    });
  return new Proxy(base, {
    apply(target, thisArg, args: unknown[]) {
      const m = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      return m !== null && typeof m === "object" ? guardModel(m, bareViaOf(args)) : m;
    },
    get(target, prop, receiver) {
      if (prop === OWN_PROVIDER) return true;
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || NON_MODEL_MEMBERS.has(prop)) return value;
      return withGuardedMemberProps(
        (...args: unknown[]): unknown => {
          const m = (value as (...a: unknown[]) => unknown).apply(target, args);
          return m !== null && typeof m === "object" ? guardModel(m, bareViaOf(args)) : m;
        },
        value,
        String(prop),
      );
    },
  });
}

export interface GatewayRoutedDefaults {
  readonly id: string;
  readonly via?: string;
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
  if (route.providerOrder !== undefined) {
    gatewayOpts = { ...(gatewayOpts ?? {}), order: [...route.providerOrder] };
    delete gatewayOpts["only"];
  }
  if (gatewayOpts === undefined) return options;
  return { ...options, providerOptions: { ...options.providerOptions, gateway: gatewayOpts } };
}

export function gatewayTranscriptionModel(id: string): ReturnType<GatewayProvider["transcriptionModel"]> {
  return policyModel(targetProvider(DEFAULT_MODEL_VIA).transcriptionModel(id));
}

export function gatewayModelBackend(defaults?: Record<string, unknown>, via?: string): ModelBackend<GatewayModel> {
  return {
    model: (id, routeVia) => gatewayLanguageModel(id, routeVia ?? via),
    applyOptions: (route, options, ids) => applyGatewayOptions(route, options, ids, defaults),
  };
}

export function gatewayModelResolver(primary: GatewayRoutedDefaults): (event: unknown, ctx: unknown) => Promise<GatewayModel> {
  const deps = { ...liveIdentity, backend: gatewayModelBackend(primary.gateway, primary.via) };
  return (event, ctx) => resolvePrimaryModel(ctx as BindableContext, { primary: { id: primary.id } }, deps, event);
}

