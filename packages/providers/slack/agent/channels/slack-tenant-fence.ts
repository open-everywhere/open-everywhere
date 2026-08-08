import { classifyTenantAdmission, admittedTenantsFromConfig, type TenantAdmissionDecision } from "@open-everywhere/core/agent/adapter-api.js";

export function slackTenantAdmission(teamId: string | undefined | null): TenantAdmissionDecision {
  return classifyTenantAdmission({ platform: "slack", tenant: teamId, admitted: admittedTenantsFromConfig("slack") });
}
