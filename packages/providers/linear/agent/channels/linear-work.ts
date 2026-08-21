import {
  getConfig,
  resolveDomainForChannel,
  resolvePartition,
  workGrantCredential,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";

export const LINEAR_PROVIDER = "linear";

export const LINEAR_WORK_CREDENTIAL = "workspace";

export function linearWorkOrg(ctx: BindableContext, domains?: readonly Domain[]): string | undefined {
  try {
    const surfaceKey = resolvePartition(ctx).surfaceKey;
    const domain = resolveDomainForChannel(surfaceKey, domains ?? getConfig().loadDomains()).domain;
    return workGrantCredential(domain, LINEAR_PROVIDER, LINEAR_WORK_CREDENTIAL);
  } catch {
    return undefined;
  }
}
