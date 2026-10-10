import { gateway, createGateway } from "ai";
import {
  type ModelRoute,
  type BindableContext,
  type ModelBackend,
  type RoutedCallOptions,
  hostPlaneFetch,
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

const HOST_PLANE_FETCH = hostPlaneFetch([gatewayHost(GATEWAY_BASE_URL)]);

const provider =
  GATEWAY_BASE_URL || HOST_PLANE_FETCH
    ? createGateway({ ...(GATEWAY_BASE_URL ? { baseURL: GATEWAY_BASE_URL } : {}), ...(HOST_PLANE_FETCH ? { fetch: HOST_PLANE_FETCH } : {}) })
    : gateway;

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

export function gatewayModelBackend(defaults?: Record<string, unknown>): ModelBackend<GatewayModel> {
  return {
    model: (id) => provider(id),
    applyOptions: (route, options, ids) => applyGatewayOptions(route, options, ids, defaults),
  };
}

export function gatewayModelResolver(primary: GatewayRoutedDefaults): (event: unknown, ctx: unknown) => Promise<GatewayModel> {
  const deps = { ...liveIdentity, backend: gatewayModelBackend(primary.gateway) };
  return (event, ctx) => resolvePrimaryModel(ctx as BindableContext, { primary: { id: primary.id } }, deps, event);
}

