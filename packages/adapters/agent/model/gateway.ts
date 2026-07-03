import { gateway } from "ai";
import type { ModelRoute } from "@open-everywhere/core/agent/memory/domain.js";
import type { ModelBackend, RoutedCallOptions } from "@open-everywhere/core/agent/model/routing.js";
import { createDomainRoutedModel, liveIdentity } from "@open-everywhere/core/agent/model/routing.js";
import type { ModelRole } from "@open-everywhere/core/agent/memory/domain.js";

type GatewayModel = ReturnType<typeof gateway>;

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
    gatewayOpts = { ...(gatewayOpts ?? {}), only: [...route.providers] };
    delete gatewayOpts["order"];
  }
  if (gatewayOpts === undefined) return options;
  return { ...options, providerOptions: { ...options.providerOptions, gateway: gatewayOpts } };
}

export function gatewayModelBackend(defaults?: Record<string, unknown>): ModelBackend<GatewayModel> {
  return {
    model: (id) => gateway(id),
    applyOptions: (route, options, ids) => applyGatewayOptions(route, options, ids, defaults),
  };
}

export function gatewayRoutedModel(role: ModelRole, defaults: GatewayRoutedDefaults): GatewayModel {
  return createDomainRoutedModel(role, { id: defaults.id }, {
    ...liveIdentity,
    backend: gatewayModelBackend(defaults.gateway),
  });
}
