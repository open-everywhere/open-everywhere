import { classifyTenantAdmission, admittedTenantsFromConfig, type TenantAdmissionDecision } from "@open-everywhere/core/agent/adapter-api.js";

export function slackTenantAdmission(teamId: string | undefined | null, enterpriseId?: string | undefined | null): TenantAdmissionDecision {
  return classifyTenantAdmission({ platform: "slack", tenant: teamId, enterprise: enterpriseId, admitted: admittedTenantsFromConfig("slack") });
}
