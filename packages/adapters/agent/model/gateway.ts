import { gateway, createGateway } from "ai";
import {
  type ModelRoute,
  type BindableContext,
  type ModelBackend,
  type RoutedCallOptions,
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
  return provider.transcriptionModel(id);
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

