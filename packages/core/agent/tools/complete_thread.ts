import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeTarget, unifiedThreadRef, mintWakeId, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { clearThreadOwner } from "../channels/thread-ownership.js";
import { recordThreadSeatReport } from "../channels/thread-seat-state.js";
import { dispatchSeatMessage } from "../channels/unified.js";
import { getOperationalStore } from "../operational/provider.js";
import type { ThreadSeatStateRow } from "../operational/store.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { isThreadSeatWindowToken, parseWindowToken } from "../channels/window-key.js";
import { appendAudit } from "../audit/audit.js";

export function isOwnTokenThreadSeat(ctx: BindableContext): boolean {
  return isThreadSeatWindowToken(resolveOwnWindowToken(ctx));
}

async function reportToParent(
  state: ThreadSeatStateRow,
  ref: { readonly channelKey: string; readonly threadKey: string },
  origin: UnifiedWakeOrigin,
  report: string,
): Promise<boolean> {
  try {
    const parent = await getOperationalStore().getChannelSession(deploymentOrg(), state.parentRegistryKey);
    if (!parent) return false;
    const domain = parseWindowToken(parent.token)?.domain;
    if (domain === undefined) return false;
    return await dispatchSeatMessage({
      token: parent.token,
      origin,
      wakeId: mintWakeId(),
      domain,
      message:
        `A thread seat you opened has handed its thread back.\n\n` +
        `Thread: ${ref.threadKey} (in ${ref.channelKey})\n` +
        `Its report:\n${report}\n\n` +
        `The thread is yours again: later messages in it wake you. Nothing is owed to the room — speak only if this changes what someone is waiting for.`,
      authAttributes: {},
    });
  } catch {
    return false;
  }
}

export default windowGated("complete_thread", defineTool({
  description:
    "Mark this thread DONE and hand it back to the channel. Call it when the conversation you were opened " +
    "to hold is finished and there is nothing left to watch for — later messages then go to the channel " +
    "watcher again. Your `summary` is what the channel watcher is told at the hand-back, and what it can " +
    "read back later, so write it for them: what the thread settled, and anything they have to carry. Only " +
    "reach for it once the thread is genuinely complete.",
  inputSchema: z.object({
    summary: z
      .string()
      .min(1)
      .optional()
      .describe("Your closing report for the channel watcher: what the thread settled and what it must carry. Stored, and delivered to it at hand-back."),
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
    const store = getOperationalStore();
    const report = input.summary?.trim();
    const closed = report ? await recordThreadSeatReport(store, org, ref, report, new Date().toISOString()).catch(() => null) : null;
    const reported = closed ? await reportToParent(closed, ref, origin, report ?? "") : false;
    const cleared = await clearThreadOwner(store, org, ref);
    await appendAudit({
      org,
      platform: "unified",
      workspace: ref.channelKey,
      action: "thread_seat.completed",
      detail: {
        channelKey: ref.channelKey,
        threadKey: ref.threadKey,
        cleared,
        hasSummary: Boolean(input.summary),
        reportStored: closed !== null,
        reportDelivered: reported,
        wakeId: wakeId ?? null,
        sessionId: (c.session as { id?: string })?.id ?? null,
      },
    }).catch(() => undefined);
    return {
      completed: true,
      note:
        (cleared ? "Thread released — the channel watcher handles it from here." : "Thread marked done (no active ownership row to release).") +
        (closed === null
          ? report
            ? " Your report could not be filed for this thread, so say anything the watcher must carry in the thread itself."
            : " You left no report, so the watcher gets the hand-back and nothing else."
          : reported
            ? " Your report is filed and the watcher has been told."
            : " Your report is filed; the watcher will read it when it next looks."),
    };
  },
}));
