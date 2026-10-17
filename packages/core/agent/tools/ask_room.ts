import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { auditSurfaceModeFrom, bindFrom, type BindableContext } from "../identity/binding.js";
import { isWorkSessionChildContext } from "../access/work-session.js";
import { postSurfaceTextStrict } from "../channels/surface-message-ops.js";
import { resolvePartition } from "../memory/partition.js";
import { appendAudit } from "../audit/audit.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { rememberWorkAsked } from "../channels/work-surface-wait.js";

export const WORK_QUESTION_TOOL = "ask_room";

const WORK_QUESTION_POSTED_ACTION = "work.question_posted";

export function renderRoomQuestion(question: string, options: readonly string[]): string {
  const lines = ["❓ A job you asked for needs an answer before it can go on:", `> ${question.replace(/\n+/g, " ").trim()}`];
  if (options.length > 0) lines.push(`Options: ${options.map((o) => o.replace(/\n+/g, " ").trim()).join(" · ")}`);
  lines.push("Answer here, and the agent continues the job with your answer.");
  return lines.join("\n");
}

const SYSTEM_VALUE_ASKS: readonly RegExp[] = [
  /\b(?:join|meeting|job|task)\s+receipts?\b/i,
  /\b(?:meeting|task|job|session|run|wake|notetaker|bot)[\s-]?(?:id|ids|identifiers?)\b/i,
  /(?<!\b(?:pull|merge)\s)\brequest[\s-]?(?:id|ids|identifiers?|receipts?)\b/i,
  /\b(?:mtg|wrun|wake)_[A-Za-z0-9]/,
];
export function asksForSystemValue(question: string): string | undefined {
  for (const re of SYSTEM_VALUE_ASKS) {
    const m = re.exec(question);
    if (m) return m[0];
  }
  return undefined;
}

export function systemValueRefusal(matched: string): string {
  return (
    `ask_room: nothing was posted. Your question asks a person for "${matched}", and people do not hold values this system made. ` +
    "Find it with your tools, or call the tool that needs none: `meeting_leave`, for one, takes no argument and finds this conversation's bot itself. " +
    "If no tool can find it, finish and report what you could not find."
  );
}

function roomAddress(ctx: BindableContext): { platform: string; channelId: string; threadTs?: string } {
  const binding = bindFrom(ctx);
  const id = binding.platform === "notion" ? binding.anchorChannelId : binding.target?.channelId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("ask_room: couldn't resolve the room this job came from, so the question was NOT posted. Finish the task and say what you need decided.");
  }
  return { platform: binding.platform, channelId: id, ...(binding.threadTs ? { threadTs: binding.threadTs } : {}) };
}

export default defineTool({
  description:
    "Ask the room that gave you this job ONE question you cannot answer yourself. The question is posted into the room at once, and this call returns at once: it does NOT wait for the answer. After it returns, finish your task: report what you did so far and say that the job waits for the answer to this question. The answer reaches this job later, as a continuation of the same task. Ask only when you cannot do the job without the answer, and only for a decision or a fact a person holds: never for an id or a receipt this system made.",
  inputSchema: z.object({
    question: z.string().min(1).max(1000).describe("The question, in one or two sentences, for the people in the room."),
    options: z.array(z.string().min(1).max(120)).max(6).optional().describe("Short answer choices, when the answer is one of a few."),
  }),
  outputSchema: z.object({ posted: z.boolean(), message: z.string() }),
  approval: never(),
  async execute(input, ctx) {
    const systemValue = asksForSystemValue([input.question, ...(input.options ?? [])].join("\n"));
    if (systemValue !== undefined) throw new Error(systemValueRefusal(systemValue));
    const c = ctx as unknown as BindableContext;
    if (!isWorkSessionChildContext(c)) {
      throw new Error("ask_room: only a job of this conversation's work session can ask the room this way. Nothing was posted.");
    }
    const where = roomAddress(c);
    const options = input.options ?? [];
    const p = resolvePartition(c);
    const text = renderRoomQuestion(input.question, options);
    const callId = typeof (ctx as { callId?: unknown }).callId === "string" ? (ctx as { callId: string }).callId : undefined;
    await postOnce({
      org: p.org,
      key: outboundKey({ surface: where.platform, channel: where.channelId, threadTs: where.threadTs, action: `${where.platform}.ask_room`, stableId: callId, payload: text }),
      run: () => postSurfaceTextStrict(where.platform, { channelId: where.channelId, text, ...(where.threadTs ? { threadTs: where.threadTs } : {}) }),
    });
    await rememberWorkAsked(c);
    await appendAudit({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      ...(p.surface === undefined ? {} : { surface: p.surface, ...auditSurfaceModeFrom(c) }),
      action: WORK_QUESTION_POSTED_ACTION,
      detail: { chars: input.question.length, options: options.length },
    }).catch(() => undefined);
    return {
      posted: true,
      message:
        "Your question is posted in the room. Nothing waits on it. Finish your task now: report what you did so far, and say that the job waits for the answer to your question. The answer reaches this job later as a continuation of this task.",
    };
  },
});
