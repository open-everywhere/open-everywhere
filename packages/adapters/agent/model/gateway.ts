import { gateway, createGateway } from "ai";
import {
  type ModelRoute,
  type BindableContext,
  type ModelBackend,
  type RoutedCallOptions,
  createRoutedCompactionModel,
  liveIdentity,
  resolvePrimaryModel,
} from "@open-everywhere/core/agent/adapter-api.js";

type GatewayModel = ReturnType<typeof gateway>;

const GATEWAY_BASE_URL = process.env.OE_AI_GATEWAY_URL?.trim();

const provider = GATEWAY_BASE_URL ? createGateway({ baseURL: GATEWAY_BASE_URL }) : gateway;

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

export function gatewayModelResolver(
  primary: GatewayRoutedDefaults,
  utility: GatewayRoutedDefaults,
): (event: unknown, ctx: unknown) => Promise<GatewayModel> {
  const deps = { ...liveIdentity, backend: gatewayModelBackend(primary.gateway) };
  return (_event, ctx) =>
    resolvePrimaryModel(ctx as BindableContext, { primary: { id: primary.id }, utility: { id: utility.id } }, deps);
}

export function gatewayRoutedCompactionModel(defaults: GatewayRoutedDefaults): GatewayModel {
  return createRoutedCompactionModel({ id: defaults.id }, gatewayModelBackend(defaults.gateway));
}
