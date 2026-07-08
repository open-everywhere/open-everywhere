import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelRole, ModelRoute, Domain, NamedKnobLayer, DomainMatch } from "../memory/domain.js";
import { modelRouteFor, domainMatchFor } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { surfaceHint, surfaceHintMatch } from "./surface-hint.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { stampModelCall } from "./model-stamp.js";

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
  readonly backend: ModelBackend<TModel>;
}

export const liveIdentity: Pick<RoutingDeps, "surfaceKey" | "surfaceMatch" | "domains" | "roles"> = {
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
      const route = modelRouteFor(role, surfaceKey, deps.domains(), deps.roles?.() ?? [], surfaceMatch);
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
