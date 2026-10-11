import { deploymentOrg, offboardDeactivatedAccount, type DeactivationConfirmation, type OffboardOutcome } from "@open-everywhere/core/agent/adapter-api.js";
import type { SlackEventEnvelope } from "./slack-events.js";

export interface SlackUserDeactivation {
  readonly deliveringTeamId: string;
  readonly enterpriseId?: string;
  readonly userId: string;
  readonly userTeamId: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function parseSlackUserDeactivation(env: SlackEventEnvelope): SlackUserDeactivation | undefined {
  const event = env.event;
  if (!event || event.type !== "user_change") return undefined;
  const user = event["user"] as Record<string, unknown> | undefined;
  if (!user || user["deleted"] !== true) return undefined;
  const userId = str(user["id"]);
  const deliveringTeamId = str(env.team_id);
  if (!userId || !deliveringTeamId) return undefined;
  const enterpriseId = str(env.enterprise_id);
  return { deliveringTeamId, userId, userTeamId: str(user["team_id"]) ?? "", ...(enterpriseId ? { enterpriseId } : {}) };
}

export type SlackUsersInfo = (userId: string) => Promise<Record<string, unknown> | undefined>;

export async function confirmSlackDeactivation(userId: string, teamId: string, usersInfo: SlackUsersInfo): Promise<DeactivationConfirmation> {
  const info = await usersInfo(userId);
  if (info?.["ok"] !== true) {
    const error = str(info?.["error"]) ?? "no response";
    return {
      deactivated: false,
      reason: `Slack users.info refused (${error})${error === "missing_scope" ? " — grant the app the users:read bot scope" : ""}`,
    };
  }
  const user = info["user"] as Record<string, unknown> | undefined;
  if (user?.["deleted"] !== true) return { deactivated: false, reason: "Slack users.info says the account is active (a reactivation, or a report that was never true)" };
  if (str(user["team_id"]) !== teamId) {
    return { deactivated: false, reason: `Slack users.info places the account in workspace "${str(user["team_id"]) ?? "(none)"}", not "${teamId}"` };
  }
  return { deactivated: true };
}

export async function routeSlackUserDeactivation(d: SlackUserDeactivation, deps: { readonly usersInfo: SlackUsersInfo; readonly org?: string }): Promise<OffboardOutcome> {
  return await offboardDeactivatedAccount({
    org: deps.org ?? deploymentOrg(),
    platform: "slack",
    deliveringTenant: d.deliveringTeamId,
    ...(d.enterpriseId ? { deliveringEnterprise: d.enterpriseId } : {}),
    tenant: d.userTeamId,
    nativeId: d.userId,
    source: "slack:user_change",
    confirm: () => confirmSlackDeactivation(d.userId, d.deliveringTeamId, deps.usersInfo),
  });
}
