import { gateway, generateText } from "ai";
import {
  type ModelRoute,
  modelRouteFor,
  memoryRefs,
  getConfig,
  type DreamCompletion,
  type DreamJudge,
  judgeFromCompletion,
  registerDreamJudge,
  facetJudgeFromCompletion,
  registerFailureFacetJudge,
  stampModelCall,
} from "@open-everywhere/core/agent/adapter-api.js";
import { applyGatewayOptions, type GatewayRoutedDefaults } from "./gateway.js";

export function utilityRouteForScope(scope: string): ModelRoute {
  try {
    const domains = getConfig().loadDomains();
    const roles = getConfig().loadRoles?.() ?? [];
    if (domains.some((d) => d.channels?.includes(scope))) return modelRouteFor("utility", scope, domains, roles);
    const owner = domains.find((d) => memoryRefs(d).includes(scope) && (d.channels?.length ?? 0) > 0);
    return modelRouteFor("utility", owner?.channels?.[0] ?? scope, domains, roles);
  } catch {
    return {};
  }
}

export function dreamCallSettings(
  route: ModelRoute,
  defaults: GatewayRoutedDefaults,
): { id: string; reasoning?: ModelRoute["reasoning"]; providerOptions?: Record<string, unknown> } {
  const id = route.id ?? defaults.id;
  const options = applyGatewayOptions(route, {}, { id, defaultId: defaults.id }, defaults.gateway);
  return { id, reasoning: route.reasoning, providerOptions: options.providerOptions };
}

export function resolvedDreamCallSettings(
  scope: string,
  defaults: GatewayRoutedDefaults,
): { id: string; reasoning?: ModelRoute["reasoning"]; providerOptions?: Record<string, unknown> } {
  const s = dreamCallSettings(utilityRouteForScope(scope), defaults);
  stampModelCall(s.id);
  return s;
}

export function gatewayDreamCompletion(defaults: GatewayRoutedDefaults): DreamCompletion {
  return async (scope, prompt) => {
    const s = resolvedDreamCallSettings(scope, defaults);
    const { text } = await generateText({
      model: gateway(s.id),
      prompt,
      ...(s.reasoning !== undefined ? { reasoning: s.reasoning } : {}),
      ...(s.providerOptions !== undefined
        ? { providerOptions: s.providerOptions as Parameters<typeof generateText>[0]["providerOptions"] }
        : {}),
    });
    return text;
  };
}

export function gatewayDreamJudge(defaults: GatewayRoutedDefaults): DreamJudge {
  return judgeFromCompletion(gatewayDreamCompletion(defaults));
}

export function registerGatewayDreamJudge(defaults: GatewayRoutedDefaults): void {
  registerDreamJudge(gatewayDreamJudge(defaults));
}

export function registerGatewayFailureFacetJudge(defaults: GatewayRoutedDefaults): void {
  registerFailureFacetJudge(facetJudgeFromCompletion(gatewayDreamCompletion(defaults)));
}

