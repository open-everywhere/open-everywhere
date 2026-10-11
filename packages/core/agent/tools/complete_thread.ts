import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { currentTurnId, currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeTarget, unifiedThreadRef } from "../channels/unified-window.js";
import { closeThreadSeat } from "../channels/thread-seat-close.js";
import { liveThreadSeatCloseDeps } from "../channels/unified.js";
import { postUnifiedReply } from "../channels/unified-reply.js";
import { replyAuditFor } from "../channels/reply-post.js";
import { repliedWakesThisTurn } from "../channels/reply-signal.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { isThreadSeatWindowToken } from "../channels/window-key.js";

export function isOwnTokenThreadSeat(ctx: BindableContext): boolean {
  return isThreadSeatWindowToken(resolveOwnWindowToken(ctx));
}

export const THREAD_DONE_LINE = "This thread is done. A new message here goes back to the channel.";

export function completionPostFor(repliedThisTurn: boolean, report: string | undefined): string | undefined {
  if (repliedThisTurn) return undefined;
  return report !== undefined && report.length > 0 ? report : THREAD_DONE_LINE;
}

export function completeThreadNote(
  out: { readonly recorded: boolean; readonly closedNow: boolean; readonly foreign: boolean; readonly cleared: boolean; readonly handedBack: boolean; readonly reaction: string; readonly priorState?: string },
  posted: "seat" | "host" | "failed",
): string {
  const post = posted === "host" ? " Your completion is posted in the thread." : posted === "failed" ? " The completion could not be posted in the thread, so say it there with `reply`." : "";
  if (out.foreign) {
    return `A newer thread seat holds this thread now, so nothing was closed or handed back, and your summary was not delivered.${post} Say anything the people here need in the thread with \`reply\`.`;
  }
  if (out.recorded && !out.closedNow && out.priorState === "completed") {
    return "This thread is already complete and handed back. Nothing more to do.";
  }
  if (out.recorded && !out.closedNow) {
    return `The host had already closed this thread before you finished, so your summary was not delivered and the thread is not marked done.${post} Say what you settled in the thread with \`reply\`.`;
  }
  return (
    (out.cleared ? "Thread released — the channel's standing seat handles it from here." : "Thread marked done (no active ownership row to release).") +
    post +
    (out.handedBack ? " The standing seat has been told." : out.recorded ? " The hand-back wake did not land; the standing seat reads the close when it next looks." : "") +
    (out.reaction === "placed" ? " The thread is marked done." : "")
  );
}

export default windowGated("complete_thread", defineTool({
  description:
    "Mark this thread DONE and hand it back. Call it when the work you were opened for is finished and " +
    "there is nothing left to watch for. Post your completion in the thread with `reply` first — what was " +
    "done, and the answer or link people need. If you did not post this turn, your `summary` is posted in " +
    "the thread for you. Either way the thread's first message gets a done reaction where the surface has " +
    "reactions, and the channel's standing seat is told the thread is finished, with your `summary` " +
    "attached. Later messages in the thread go to the standing seat. Only call it once the thread is " +
    "complete.",
  inputSchema: z.object({
    summary: z
      .string()
      .min(1)
      .optional()
      .describe("Your closing report: what the thread settled and what the standing seat must carry. Stored, and handed to it. Posted in the thread if you did not post there this turn."),
  }),
  outputSchema: z.object({ completed: z.boolean(), note: z.string() }),
  async execute(input, ctx) {
    const c = ctx as BindableContext;
    if (!isOwnTokenThreadSeat(c)) {
      throw new Error("complete_thread: only a thread seat can complete its thread — this session owns no thread-seat row to release.");
    }
    const org = deploymentOrg();
    const wakeId = currentWakeId(c);
    const origin = wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId) : null;
    if (!origin) {
      throw new Error("complete_thread: couldn't resolve this thread to release — try again on a message-driven turn.");
    }
    const ref = unifiedThreadRef(origin);
    const report = input.summary?.trim() || undefined;
    const text = completionPostFor(repliedWakesThisTurn(currentTurnId(c)).length > 0, report);
    let posted: "seat" | "host" | "failed" = "seat";
    if (text !== undefined) {
      posted = await postUnifiedReply(origin, text, {}, replyAuditFor(c, "tool", wakeId ?? undefined))
        .then(() => "host" as const)
        .catch(() => "failed" as const);
    }
    const out = await closeThreadSeat(
      {
        org,
        ref,
        reason: "completed",
        ...(report !== undefined ? { report } : {}),
        origin,
        seatToken: resolveOwnWindowToken(c) as string,
        auditDetail: { posted, wakeId: wakeId ?? null, sessionId: (c.session as { id?: string })?.id ?? null },
      },
      liveThreadSeatCloseDeps(),
    );
    return { completed: true, note: completeThreadNote(out, posted) };
  },
}));
