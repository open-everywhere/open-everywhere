import type {
  SlackAnswerContext,
  SlackAnswerResult,
  SlackAnswerSubmission,
} from "eve/channels/slack";
import {
  admitInputResponse,
  ingressSpendGate,
  resolvePartition,
  SLACK_SPEND_BADGES,
  type BindableContext,
  type IngressSpendGateInput,
  type InputResponseAdmission,
  type InputResponseScope,
  type SpendGateDecision,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackClickerIsGuest } from "./slack-events.js";

function slackAuthTeamId(auth: SlackAnswerContext["defaultAuth"]): string | undefined {
  const v = auth.attributes?.["team_id"];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  return undefined;
}

export interface SlackInputResponseDeps {
  readonly admit?: (scope: InputResponseScope) => Promise<InputResponseAdmission>;
  readonly notify?: (userId: string, text: string) => Promise<void>;
  readonly guestVerdict?: (userId: string, teamId: string | undefined) => Promise<boolean | undefined>;
  readonly spendGate?: (input: IngressSpendGateInput) => Promise<SpendGateDecision>;
}

export async function admitSlackInputResponse(
  ctx: SlackAnswerContext,
  submission: SlackAnswerSubmission,
  deps: SlackInputResponseDeps = {},
): Promise<SlackAnswerResult> {
  const allow: SlackAnswerResult = { auth: ctx.defaultAuth };
  try {
    const bindable = {
      channel: { kind: "slack" },
      session: { auth: { current: ctx.defaultAuth } },
    } as BindableContext;
    const p = resolvePartition(bindable);
    const teamId = slackAuthTeamId(ctx.defaultAuth);

    const spendGate = deps.spendGate ?? ingressSpendGate;
    const spendVerdict = await spendGate({
      bindable,
      door: "answer",
      principalId: submission.user.id,
      workspaceRef: teamId ?? null,
      badges: SLACK_SPEND_BADGES,
      post: async (text) => {
        await ctx.thread.postEphemeral(submission.user.id, text);
      },
    });
    if (spendVerdict === "declined") return null;

    const guestVerdict = deps.guestVerdict ?? slackClickerIsGuest;
    const answererIsGuest = await guestVerdict(submission.user.id, teamId).catch(() => undefined);
    const verdict = await (deps.admit ?? admitInputResponse)({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      surfaceKey: p.surfaceKey,
      principalId: submission.user.id,
      responses: submission.answers.length,
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
