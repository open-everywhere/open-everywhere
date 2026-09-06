import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { BindableContext } from "../identity/binding.js";
import type { EffectiveAccess, ReachableHost } from "../access/resolver.js";
import { openWriteHosts, writeHostsAuditFields } from "../access/egress.js";
import { egressPolicyFingerprint } from "../hooks/egress.js";
import { auditToolAction } from "../audit/tool-action.js";
import { GIT_BROKER_HOSTS } from "./broker.js";

export function brokerAttributionHosts(reachableHosts: readonly ReachableHost[]): readonly ReachableHost[] {
  return reachableHosts.filter((h) => !(GIT_BROKER_HOSTS as readonly string[]).includes(h.host));
}

export type BrokerApplyReason = "checkout_repo" | "open_pull_request.push" | "open_pull_request.restore";

export async function auditBrokeredEgressPolicy(
  ctx: BindableContext,
  access: EffectiveAccess,
  policy: SandboxNetworkPolicy,
  reason: BrokerApplyReason,
): Promise<void> {
  try {
    const hostCount = typeof policy === "string" ? 0 : Object.keys(policy.allow ?? {}).length;
    const writeHosts = openWriteHosts(policy, brokerAttributionHosts(access.reachableHosts));
    await auditToolAction(ctx, "egress.policy", {
      hosts: hostCount,
      enforced: true,
      scopeKey: access.scopeKey,
      summary: typeof policy === "string" ? policy : `allow ${hostCount} host(s), default-deny`,
      phase: "scm.broker",
      reason,
      policyFingerprint: egressPolicyFingerprint(policy),
      ...writeHostsAuditFields(writeHosts),
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] dropped the "${reason}" egress.policy row (the policy itself is applied): ${String(err)}`);
  }
}
