import { getConfig, resolvePartition, STATUS_REACTION, statusVerbsFor, swallowRoomOp, type ReactionState } from "@open-everywhere/core/agent/adapter-api.js";
import { stepStatusFor, type StepAction } from "./slack-step-label.js";

export type SlackSignRequest = (method: string, params: Readonly<Record<string, string>>) => Promise<void>;

export const SLACK_WORKING_STATUS = "Working...";

export async function setSlackStatusReaction(request: SlackSignRequest, target: { readonly channel: string; readonly timestamp: string }, state: ReactionState | "none"): Promise<void> {
  if (swallowRoomOp("a slack status reaction")) return;
  await Promise.all(
    Object.entries(STATUS_REACTION).map(([s, name]) => request(s === state ? "reactions.add" : "reactions.remove", { channel: target.channel, name, timestamp: target.timestamp })),
  );
}

export async function setSlackThreadStatus(request: SlackSignRequest, target: { readonly channelId: string; readonly threadTs: string }, status: string): Promise<void> {
  await request("assistant.threads.setStatus", { channel_id: target.channelId, thread_ts: target.threadTs, status });
}

export function slackStatusVerb(state: { channelId?: string | null; teamId?: string | null }): string {
  try {
    const p = resolvePartition({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: state.teamId ?? "", channel_id: state.channelId ?? "" }, principalId: "", principalType: "slack-user" } } },
    });
    const cfg = getConfig();
    const verbs = statusVerbsFor(p.surfaceKey, cfg.loadDomains(), cfg.loadRoles?.() ?? []);
    return `${verbs[Math.floor(Math.random() * verbs.length)]}…`;
  } catch {
    return "Working…";
  }
}

export function slackStepStatus(actions: readonly StepAction[] | undefined, state: { channelId?: string | null; teamId?: string | null }): string {
  return stepStatusFor(actions) ?? slackStatusVerb(state);
}
