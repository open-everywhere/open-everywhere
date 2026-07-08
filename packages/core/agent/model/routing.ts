import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelRole, ModelRoute, Domain, NamedKnobLayer, DomainMatch, ModelReasoning } from "../memory/domain.js";
import { modelRouteFor, domainMatchFor, reasoningCeilingFor, domainForChannel, criteriaDomain } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { surfaceHint, surfaceHintMatch } from "./surface-hint.js";
import { bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { stampModelCall } from "./model-stamp.js";
import type { ModelPolicy } from "./policy.js";
import { applyModelPolicyToRoute } from "./policy.js";
import { getOperationalStore } from "../operational/provider.js";

interface RoutingContextStore {
  get(key: unknown): unknown;
}
interface RoutingEveInternals {
  contextStorage: { getStore(): RoutingContextStore | undefined };
  AuthKey: unknown;
  InitiatorAuthKey: unknown;
  ChannelKey: unknown;
}

let routingInternalsPromise: Promise<RoutingEveInternals | null> | undefined;
let routingInternalsLoadError: string | undefined;
function loadRoutingEveInternals(): Promise<RoutingEveInternals | null> {
  if (routingInternalsPromise) return routingInternalsPromise;
  routingInternalsPromise = (async () => {
    try {
      const require = createRequire(import.meta.url);
      const root = dirname(require.resolve("eve/package.json"));
      const abs = (rel: string) => pathToFileURL(join(root, rel)).href;
      const [container, keys, runtimeKeys] = await Promise.all([
        import(abs("dist/src/context/container.js")),
        import(abs("dist/src/context/keys.js")),
        import(abs("dist/src/runtime/sessions/runtime-context-keys.js")),
      ]);
      if (!container?.contextStorage || !keys?.AuthKey || !runtimeKeys?.ChannelKey) {
        routingInternalsLoadError = "internal modules loaded but expected exports are missing";
        return null;
      }
      return {
        contextStorage: container.contextStorage,
        AuthKey: keys.AuthKey,
        InitiatorAuthKey: keys.InitiatorAuthKey,
        ChannelKey: runtimeKeys.ChannelKey,
      };
    } catch (err) {
      routingInternalsLoadError = String(err);
      return null;
    }
  })();
  return routingInternalsPromise;
}

const routingNullReasons = new Set<string>();
function routingNullBecause(reason: string): null {
  if (!routingNullReasons.has(reason)) {
    routingNullReasons.add(reason);
    console.warn(`[open-everywhere:model-routing] surface-context unresolvable: ${reason}`);
  }
  return null;
}

async function readAlsSurfaceContext(): Promise<BindableContext | null> {
  const eve = await loadRoutingEveInternals();
  if (!eve) return routingNullBecause(`eve internals failed to load: ${routingInternalsLoadError ?? "(unknown)"}`);
  const store = eve.contextStorage.getStore();
  if (!store) return routingNullBecause("no ALS store — outside an eve session scope");
  const current = store.get(eve.AuthKey) ?? null;
  const initiator = store.get(eve.InitiatorAuthKey) ?? current;
  if (current === null && initiator === null) return routingNullBecause("ALS store present but no auth keys set");
  const channel = store.get(eve.ChannelKey) as { kind?: string } | undefined;
  type SessionAuthShape = NonNullable<NonNullable<BindableContext["session"]>["auth"]>;
  return {
    session: { auth: { current, initiator } as SessionAuthShape },
    channel: { kind: channel?.kind },
  } as BindableContext;
}

export interface RoutedCallOptions {
  reasoning?: string;
  providerOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RoutableModel {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: unknown;
  doGenerate(options: any): PromiseLike<any>;
  doStream(options: any): PromiseLike<any>;
}

export interface ModelBackend<TModel extends RoutableModel = RoutableModel> {
  model(id: string): TModel;
  applyOptions(
    route: ModelRoute,
    options: RoutedCallOptions,
    ids: { readonly id: string; readonly defaultId: string },
  ): RoutedCallOptions;
}

export interface RoutingDeps<TModel extends RoutableModel = RoutableModel> {
  readonly surfaceKey: () => Promise<string | null>;
  readonly surfaceMatch?: () => Promise<DomainMatch | undefined>;
  readonly domains: () => readonly Domain[];
  readonly roles?: () => readonly NamedKnobLayer[];
  readonly modelPolicy?: () => ModelPolicy | undefined;
  readonly domainModelPick?: (domainName: string) => Promise<DomainModelPick | null>;
  readonly backend: ModelBackend<TModel>;
}

export interface DomainModelPick {
  readonly modelId?: string;
  readonly reasoning?: ModelReasoning;
}

const DOMAIN_MODEL_PICK_TTL_MS = 15_000;
interface DomainModelPickCacheEntry {
  readonly value: DomainModelPick | null;
  readonly expiresAt: number;
}
const domainModelPickCache = new Map<string, DomainModelPickCacheEntry>();

export function _resetDomainModelPickCacheForTest(): void {
  domainModelPickCache.clear();
}

async function liveDomainModelPick(org: string, domainName: string): Promise<DomainModelPick | null> {
  const key = `${org} ${domainName}`;
  const now = Date.now();
  const cached = domainModelPickCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const row = await getOperationalStore().getDomainModel(org, domainName);
  const value: DomainModelPick | null = row ? { modelId: row.modelId, reasoning: row.reasoning } : null;
  domainModelPickCache.set(key, { value, expiresAt: now + DOMAIN_MODEL_PICK_TTL_MS });
  return value;
}

export const liveIdentity: Pick<RoutingDeps, "surfaceKey" | "surfaceMatch" | "domains" | "roles" | "modelPolicy" | "domainModelPick"> = {
  surfaceKey: async () => {
    const ctx = await readAlsSurfaceContext();
    if (ctx) return domainKeyOf(resolvePartition(ctx));
    return surfaceHint();
  },
  surfaceMatch: async () => {
    const ctx = await readAlsSurfaceContext();
    if (ctx) {
      try {
        const binding = bindFrom(ctx);
        return domainMatchFor(binding.mode, binding.trust);
      } catch {
        return undefined;
      }
    }
    return surfaceHintMatch();
  },
  domains: () => getConfig().loadDomains(),
  roles: () => getConfig().loadRoles?.() ?? [],
  modelPolicy: () => getConfig().loadModelPolicy?.(),
  domainModelPick: async (domainName) => {
    try {
      return await liveDomainModelPick(deploymentOrg(), domainName);
    } catch {
      return null;
    }
  },
};

export function applyRoute(
  route: ModelRoute,
  options: RoutedCallOptions,
  defaultId: string,
): { id: string; options: RoutedCallOptions } {
  const id = route.id ?? defaultId;
  return {
    id,
    options: route.reasoning !== undefined ? { ...options, reasoning: route.reasoning } : options,
  };
}

export function createDomainRoutedModel<TModel extends RoutableModel>(
  role: ModelRole,
  defaults: { readonly id: string },
  deps: RoutingDeps<TModel>,
): TModel {
  const inner = new Map<string, TModel>();
  const modelFor = (id: string): TModel => {
    let m = inner.get(id);
    if (!m) {
      m = deps.backend.model(id);
      inner.set(id, m);
    }
    return m;
  };
  const warned = new Set<string>();
  const warnOnce = (reason: string): void => {
    if (warned.has(reason)) return;
    warned.add(reason);
    console.warn(`[open-everywhere:model-routing] ${role}: ${reason} — using default model "${defaults.id}"`);
  };

  const applied = new Set<string>();
  const resolve = async (): Promise<ModelRoute> => {
    let surfaceKey: string | null;
    try {
      surfaceKey = await deps.surfaceKey();
    } catch (err) {
      warnOnce(`surface lookup failed (${String(err)})`);
      return {};
    }
    if (surfaceKey === null) {
      if (!applied.has("__no_surface__")) {
        applied.add("__no_surface__");
        console.log(`[open-everywhere:model-routing] ${role}: no surface at model-call time — routing inactive, defaults apply`);
      }
      return {};
    }
    let surfaceMatch: DomainMatch | undefined;
    try {
      surfaceMatch = await deps.surfaceMatch?.();
    } catch {
      surfaceMatch = undefined;
    }
    try {
      const domains = deps.domains();
      const roles = deps.roles?.() ?? [];
      const rawRoute = modelRouteFor(role, surfaceKey, domains, roles, surfaceMatch);
      let pickedRoute: ModelRoute = rawRoute;
      try {
        const domainName = domainForChannel(surfaceKey, domains)?.name ?? (surfaceMatch ? criteriaDomain(surfaceMatch, domains)?.name : undefined);
        if (domainName !== undefined) {
          const pick = await deps.domainModelPick?.(domainName);
          if (pick && (pick.modelId !== undefined || pick.reasoning !== undefined)) {
            pickedRoute = {
              ...rawRoute,
              ...(pick.modelId !== undefined ? { id: pick.modelId, tier: undefined } : {}),
              ...(pick.reasoning !== undefined ? { reasoning: pick.reasoning } : {}),
            };
            const pickKey = `pick:${role}:${domainName}:${JSON.stringify(pick)}`;
            if (!applied.has(pickKey)) {
              applied.add(pickKey);
              console.log(`[open-everywhere:model-routing] ${role}: domain "${domainName}" runtime pick → ${JSON.stringify(pick)}`);
            }
          }
        }
      } catch (err) {
        pickedRoute = rawRoute;
        warnOnce(`domain model pick lookup failed (${String(err)})`);
      }
      let policy: ModelPolicy | undefined;
      try {
        policy = deps.modelPolicy?.();
      } catch {
        policy = undefined;
      }
      let effectiveCeiling: ModelReasoning | undefined;
      if (policy) {
        try {
          effectiveCeiling = reasoningCeilingFor(surfaceKey, domains, roles, surfaceMatch, policy.reasoningCeiling ?? "medium");
        } catch {
          effectiveCeiling = undefined;
        }
      }
      const enveloped = applyModelPolicyToRoute(pickedRoute, policy, defaults.id, effectiveCeiling);
      for (const w of enveloped.warnings) warnOnce(`model policy: ${w}`);
      const route: ModelRoute = { ...pickedRoute, id: enveloped.id, reasoning: enveloped.reasoning };
      if (route.id !== undefined || route.reasoning !== undefined || route.providers !== undefined) {
        const key = `${surfaceKey} ${JSON.stringify(route)}`;
        if (!applied.has(key)) {
          applied.add(key);
          console.log(`[open-everywhere:model-routing] ${role}: ${surfaceKey} → ${JSON.stringify(route)}`);
        }
      }
      return route;
    } catch (err) {
      warnOnce(`domain config unavailable (${String(err)})`);
      return {};
    }
  };

  const dispatch = async (options: RoutedCallOptions): Promise<{ model: TModel; options: RoutedCallOptions }> => {
    const route = await resolve();
    const generic = applyRoute(route, options, defaults.id);
    const mapped = deps.backend.applyOptions(route, generic.options, { id: generic.id, defaultId: defaults.id });
    stampModelCall(generic.id);
    return { model: modelFor(generic.id), options: mapped };
  };

  const fallback = modelFor(defaults.id);
  const routed: RoutableModel = {
    specificationVersion: fallback.specificationVersion,
    provider: fallback.provider,
    modelId: defaults.id,
    supportedUrls: fallback.supportedUrls,
    async doGenerate(options: RoutedCallOptions) {
      const d = await dispatch(options);
      return d.model.doGenerate(d.options);
    },
    async doStream(options: RoutedCallOptions) {
      const d = await dispatch(options);
      return d.model.doStream(d.options);
    },
  };
  return routed as TModel;
}
