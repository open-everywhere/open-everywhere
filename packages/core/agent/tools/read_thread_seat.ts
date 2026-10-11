import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeTarget, unifiedThreadRef } from "../channels/unified-window.js";
import { resolveThreadOwner } from "../channels/thread-ownership.js";
import { readThreadSeatState } from "../channels/thread-seat-state.js";
import type { ThreadSeatState } from "../operational/store.js";
import { getOperationalStore } from "../operational/provider.js";
import { isThreadSeatWindowToken } from "../channels/window-key.js";

export function threadKeyArgument(fromWake: string, argument: string | undefined): string {
  return argument && argument.length > 0 ? argument.replace(/:/g, "_") : fromWake;
}

export default windowGated(
  "read_thread_seat",
  defineTool({
    description:
      "Read what you recorded about a thread you handed to a thread seat: which seat holds it, whether it is " +
      "still open, and its closing report once it has handed back. Stored facts only — it does not ask the seat " +
      "anything and never guesses at progress. Use it before you steer a seat, and after a hand-back to pick up " +
      "what it left you. Name the thread you mean; with no `thread` it reads the thread this message came from.",
    inputSchema: z.object({
      thread: z.string().min(1).optional().describe("The thread's root id, as `spawn_thread_session` returned it. Defaults to the thread this message came from."),
    }),
    outputSchema: z.object({
      found: z.boolean(),
      thread: z.string(),
      state: z.string().optional(),
      seatId: z.string().optional(),
      openedAt: z.string().optional(),
      updatedAt: z.string().optional(),
      routed: z.boolean().optional(),
      report: z.string().optional(),
      note: z.string(),
    }),
    async execute(input, ctx) {
      const c = ctx as BindableContext;
      const org = deploymentOrg();
      const wakeId = currentWakeId(c);
      const origin = wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId) : null;
      if (!origin) {
        throw new Error("read_thread_seat: couldn't resolve the conversation you're in — try again on a message-driven turn, or name the thread you mean.");
      }
      const ref = unifiedThreadRef(origin);
      const threadKey = threadKeyArgument(ref.threadKey, input.thread);
      const ownRef = { channelKey: ref.channelKey, threadKey };
      const store = getOperationalStore();
      const state = await readThreadSeatState(store, org, ownRef);
      const owner = await resolveThreadOwner(store, org, ownRef);
      const routed = owner !== null && isThreadSeatWindowToken(owner);
      if (!state) {
        return {
          found: false,
          thread: threadKey,
          ...(routed ? { routed } : {}),
          note: routed
            ? "No record for this thread, but a thread seat still holds it — it was opened before this record existed, or the record has aged out. Its messages still go to that seat."
            : "No record for this thread: no thread seat has held it in the last week. Its messages come to you.",
        };
      }
      return {
        found: true,
        thread: threadKey,
        state: state.state,
        seatId: state.seatToken,
        openedAt: state.openedAt,
        updatedAt: state.updatedAt,
        routed,
        ...(state.report !== undefined ? { report: state.report } : {}),
        note: readThreadSeatNote(state.state, routed, state.report !== undefined),
      };
    },
  }),
);

export function readThreadSeatNote(state: ThreadSeatState, routed: boolean, hasReport: boolean): string {
  const report = hasReport ? " The report above is the seat's own closing words." : " The seat left no report; the thread itself is the record.";
  switch (state) {
    case "open":
      return routed
        ? "A thread seat is holding this thread. It has not reported back yet — what it is doing is not recorded anywhere, so ask it with `message_thread_seat` rather than assuming."
        : "The record says open, but nothing routes this thread to a seat any more. Its messages come to you.";
    case "completed":
      return `The seat finished the thread and handed it back to you.${report}`;
    case "expired":
      return `The thread went quiet, so the host closed its seat and handed it back to you.${report}`;
    case "closed":
      return `The host closed the seat because its thread could no longer reach it, and handed the thread back to you.${report}`;
  }
}
