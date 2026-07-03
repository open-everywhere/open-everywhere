import type { ModelRole, ModelRoute, Domain } from "../memory/domain.js";
import { modelRouteFor } from "../memory/domain.js";
import { readSurfaceContext } from "../access/connector-scope.js";
import { getConfig } from "../access/config.js";
import { resolvePartition } from "../memory/partition.js";

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
  readonly domains: () => readonly Domain[];
  readonly backend: ModelBackend<TModel>;
}

export const liveIdentity: Pick<RoutingDeps, "surfaceKey" | "domains"> = {
  surfaceKey: async () => {
    const ctx = await readSurfaceContext();
    return ctx ? resolvePartition(ctx).surfaceKey : null;
  },
  domains: () => getConfig().loadDomains(),
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
      return {};
    }
    try {
      const route = modelRouteFor(role, surfaceKey, deps.domains());
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
