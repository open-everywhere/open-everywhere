import { callSlackApi } from "eve/channels/slack";
import { linesFromMessages, READ_MORE_HINT } from "./slack-context.js";
import { renderContext, sinceLastAgentReply, WAKE_BACKSCROLL_MAX, type ContextLine } from "./context-render.js";

export { WAKE_BACKSCROLL_MAX } from "./context-render.js";

export interface WakeBotIdentity {
  readonly userId?: string;
  readonly botId?: string;
}

export type SlackRequester = (method: string, params: Record<string, string>) => Promise<Record<string, unknown> | undefined>;

export interface WakeBackscrollInput {
  readonly channelId: string;
  readonly ts: string;
  readonly threadTs?: string;
}

export interface WakeBackscrollDeps {
  readonly request: SlackRequester;
  readonly identity: () => Promise<WakeBotIdentity>;
}

const liveRequest: SlackRequester = async (method, params) => {
  try {
    return (await callSlackApi({ botToken: undefined, operation: method, body: params })) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

let wakeBotIdentityPromise: Promise<WakeBotIdentity> | undefined;
function liveWakeBotIdentity(): Promise<WakeBotIdentity> {
  if (!wakeBotIdentityPromise) {
    wakeBotIdentityPromise = (async () => {
      const res = await liveRequest("auth.test", {});
      if (res?.ok === true) {
        return {
          userId: typeof res.user_id === "string" ? res.user_id : undefined,
          botId: typeof res.bot_id === "string" ? res.bot_id : undefined,
        };
      }
      return {};
    })();
  }
  return wakeBotIdentityPromise;
}

export function _resetWakeBotIdentity(): void {
  wakeBotIdentityPromise = undefined;
}

const liveDeps: WakeBackscrollDeps = { request: liveRequest, identity: liveWakeBotIdentity };

export async function fetchWakeBackscroll(input: WakeBackscrollInput, deps: WakeBackscrollDeps = liveDeps): Promise<string[]> {
  try {
    const ids = await deps.identity().catch(() => ({} as WakeBotIdentity));
    if (input.threadTs) {
      const res = await deps.request("conversations.replies", {
        channel: input.channelId,
        ts: input.threadTs,
        limit: "100",
      });
      const raw = extractMessages(res);
      if (!raw) return [];
      const priorRaw = raw.filter((m) => (typeof m.ts === "string" ? m.ts : "") !== input.ts);
      const lines = sinceLastAgentReply(linesFromMessages(priorRaw, ids));
      return renderEntry(lines, `slack thread ${input.channelId}/${input.threadTs}`);
    }
    const res = await deps.request("conversations.history", {
      channel: input.channelId,
      latest: input.ts,
      inclusive: "false",
      limit: String(WAKE_BACKSCROLL_MAX),
    });
    const raw = extractMessages(res);
    if (!raw) return [];
    const lines = linesFromMessages(raw, ids);
    lines.reverse();
    return renderEntry(lines, `slack channel ${input.channelId}`);
  } catch {
    return [];
  }
}

function extractMessages(res: Record<string, unknown> | undefined): Array<Record<string, unknown>> | undefined {
  if (!res || res.ok !== true || !Array.isArray(res.messages)) return undefined;
  return res.messages as Array<Record<string, unknown>>;
}

function renderEntry(lines: readonly ContextLine[], source: string): string[] {
  const capped = lines.slice(-WAKE_BACKSCROLL_MAX);
  const entry = renderContext(capped, source, { readMoreHint: READ_MORE_HINT });
  return entry ? [entry] : [];
}
