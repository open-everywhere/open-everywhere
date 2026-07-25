import type { WindowGrain } from "../identity/binding.js";
import { windowedDomainFor, type Domain } from "../memory/domain.js";

export type WindowRoutingPosture =
  | "windowed"
  | "native-by-design"
  | "native-degraded";

export function classifyWindowRouting(grain: WindowGrain, domainKey: string, domains: readonly Domain[]): WindowRoutingPosture {
  if (grain !== "native") return "windowed";
  return windowedDomainFor(domainKey, domains) ? "native-degraded" : "native-by-design";
}

export const WINDOW_ROUTING_DEGRADED_ACTION = "window.routing_degraded";
