import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeTarget, unifiedThreadRef } from "../channels/unified-window.js";
import { clearThreadOwner } from "../channels/thread-ownership.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { isThreadSeatWindowToken } from "../channels/window-key.js";
import { appendAudit } from "../audit/audit.js";

export function isOwnTokenThreadSeat(ctx: BindableContext): boolean {
  return isThreadSeatWindowToken(resolveOwnWindowToken(ctx));
}

export default windowGated("complete_thread", defineTool({
  description:
    "Mark this thread DONE and hand it back to the channel. Call it when the conversation you were opened " +
    "to hold is finished and there is nothing left to watch for — later messages then go to the channel " +
    "watcher again. Only reach for it once the thread is genuinely complete.",
  inputSchema: z.object({
    summary: z.string().min(1).optional().describe("Optional one-line note of what the thread covered (audit only)."),
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
    const cleared = await clearThreadOwner(getOperationalStore(), org, ref);
    await appendAudit({
      org,
      platform: "unified",
      workspace: ref.channelKey,
      action: "thread_seat.completed",
      detail: { channelKey: ref.channelKey, threadKey: ref.threadKey, cleared, hasSummary: Boolean(input.summary), wakeId: wakeId ?? null, sessionId: (c.session as { id?: string })?.id ?? null },
    }).catch(() => undefined);
    return {
      completed: true,
      note: cleared ? "Thread released — the channel watcher handles it from here." : "Thread marked done (no active ownership row to release).",
    };
  },
}));
