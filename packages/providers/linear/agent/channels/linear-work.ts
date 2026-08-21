import { callerWorkGrant, getConfig, type BindableContext, type Domain } from "@open-everywhere/core/agent/adapter-api.js";

export const LINEAR_PROVIDER = "linear";

export const LINEAR_WORK_CREDENTIAL = "workspace";

export function linearWorkOrg(ctx: BindableContext, domains?: readonly Domain[]): string | undefined {
  return callerWorkGrant(ctx, LINEAR_PROVIDER, LINEAR_WORK_CREDENTIAL, () => domains ?? getConfig().loadDomains());
}
