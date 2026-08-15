import type { TeamsContext, TeamsInputResponseResult, TeamsInvokeActivity, TeamsMessageActivity } from "eve/channels/teams";
import { admitInputResponse, resolvePartition, type InputResponseAdmission, type InputResponseScope } from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth, teamsMembershipType } from "./teams-identity.js";
import { resolveTeamsUserType, teamsHandleRosterProbe } from "./teams-roster.js";

export interface TeamsInputResponseDeps {
  readonly admit?: (scope: InputResponseScope) => Promise<InputResponseAdmission>;
  readonly userType?: (activity: TeamsInvokeActivity | TeamsMessageActivity) => Promise<"guest" | "member" | undefined>;
  readonly notify?: (text: string) => Promise<void>;
}

export async function admitTeamsInputResponse(
  ctx: TeamsContext,
  activity: TeamsInvokeActivity | TeamsMessageActivity,
  deps: TeamsInputResponseDeps = {},
): Promise<TeamsInputResponseResult> {
  const probe = deps.userType ?? ((a) => resolveTeamsUserType(teamsHandleRosterProbe(ctx.teams), a.conversation.id, a.from.id));
  let auth: ReturnType<typeof buildTeamsAuth> | undefined;
  try {
    const userType = await probe(activity);
    auth = buildTeamsAuth({
      userId: activity.from.id,
      aadObjectId: activity.from.aadObjectId,
      userName: activity.from.name,
      tenantId: activity.tenantId ?? activity.conversation.tenantId,
      conversationId: activity.conversation.id,
      channelId: activity.teamsChannelId,
      teamId: activity.teamId,
      serviceUrl: activity.serviceUrl,
      scope: activity.scope,
      membershipType: teamsMembershipType(activity.channelData),
      userType,
    });
    const p = resolvePartition({
      channel: { kind: "teams" },
      session: { auth: { current: auth } },
    } as Parameters<typeof resolvePartition>[0]);
    const verdict = await (deps.admit ?? admitInputResponse)({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      surfaceKey: p.surfaceKey,
      principalId: activity.from.id,
      ...(userType === undefined ? {} : { answererIsGuest: userType === "guest" }),
    });
    if (verdict.ok) return { auth };
    const notify = deps.notify ?? (async (text: string): Promise<void> => { await ctx.thread.post(text); });
    await notify(verdict.notice).catch((err: unknown) => {
      console.error(`[open-everywhere:teams] HITL refusal notice failed to post: ${String(err)}`);
    });
    return null;
  } catch (err) {
    console.error(`[open-everywhere:teams] HITL answer admission failed softly — accepting the answer: ${String(err)}`);
    return { auth: auth ?? null };
  }
}
