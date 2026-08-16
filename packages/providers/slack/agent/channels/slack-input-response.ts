import type {
  SlackInputResponseContext,
  SlackInputResponseResult,
  SlackInputResponseSubmission,
} from "eve/channels/slack";
import { admitInputResponse, resolvePartition, type InputResponseAdmission, type InputResponseScope } from "@open-everywhere/core/agent/adapter-api.js";
import { slackClickerIsGuest } from "./slack-events.js";

function slackAuthTeamId(auth: SlackInputResponseContext["defaultAuth"]): string | undefined {
  const v = auth.attributes?.["team_id"];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  return undefined;
}

export interface SlackInputResponseDeps {
  readonly admit?: (scope: InputResponseScope) => Promise<InputResponseAdmission>;
  readonly notify?: (userId: string, text: string) => Promise<void>;
  readonly guestVerdict?: (userId: string, teamId: string | undefined) => Promise<boolean | undefined>;
}

export async function admitSlackInputResponse(
  ctx: SlackInputResponseContext,
  submission: SlackInputResponseSubmission,
  deps: SlackInputResponseDeps = {},
): Promise<SlackInputResponseResult> {
  const allow: SlackInputResponseResult = { auth: ctx.defaultAuth };
  try {
    const p = resolvePartition({
      channel: { kind: "slack" },
      session: { auth: { current: ctx.defaultAuth } },
    } as Parameters<typeof resolvePartition>[0]);
    const guestVerdict = deps.guestVerdict ?? slackClickerIsGuest;
    const answererIsGuest = await guestVerdict(submission.user.id, slackAuthTeamId(ctx.defaultAuth)).catch(() => undefined);
    const verdict = await (deps.admit ?? admitInputResponse)({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      surfaceKey: p.surfaceKey,
      principalId: submission.user.id,
      responses: submission.inputResponses.length,
      ...(answererIsGuest === undefined ? {} : { answererIsGuest }),
    });
    if (verdict.ok) return allow;
    const notify =
      deps.notify ??
      (async (userId: string, text: string): Promise<void> => {
        await ctx.thread.postEphemeral(userId, text);
      });
    await notify(submission.user.id, verdict.notice).catch((err: unknown) => {
      console.error(`[open-everywhere:slack] HITL refusal notice failed to post: ${String(err)}`);
    });
    return null;
  } catch (err) {
    console.error(`[open-everywhere:slack] HITL answer admission failed softly — accepting the answer: ${String(err)}`);
    return allow;
  }
}
