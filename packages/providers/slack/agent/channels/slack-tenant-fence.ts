import { classifyTenantAdmission, admittedTenantsFromConfig, type TenantAdmissionDecision } from "@open-everywhere/core/agent/adapter-api.js";

export function slackTenantAdmission(teamId: string | undefined | null, enterpriseId?: string | undefined | null): TenantAdmissionDecision {
  return classifyTenantAdmission({ platform: "slack", tenant: teamId, enterprise: enterpriseId, admitted: admittedTenantsFromConfig("slack") });
}

export interface SlackInteractivityTenantIds {
  readonly teamId?: string;
  readonly enterpriseId?: string;
}

export function slackInteractivityTenantIds(raw: unknown): SlackInteractivityTenantIds {
  const p = asObject(raw);
  if (p === undefined) return {};
  const teamId = asNonEmptyString(asObject(p.team)?.id);
  const enterpriseId =
    asNonEmptyString(asObject(p.enterprise)?.id) ?? asNonEmptyString(p.enterprise_id) ?? asNonEmptyString(asObject(p.team)?.enterprise_id);
  return { ...(teamId === undefined ? {} : { teamId }), ...(enterpriseId === undefined ? {} : { enterpriseId }) };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
