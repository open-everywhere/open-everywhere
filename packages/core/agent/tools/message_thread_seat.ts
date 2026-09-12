import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeTarget, unifiedThreadRef, mintWakeId } from "../channels/unified-window.js";
import { resolveThreadOwner } from "../channels/thread-ownership.js";
import { readThreadSeatState, threadSeatOrigin } from "../channels/thread-seat-state.js";
import { dispatchSeatMessage } from "../channels/unified.js";
import { postUnifiedReply } from "../channels/unified-reply.js";
import { replyAuditFor } from "../channels/reply-post.js";
import { getOperationalStore } from "../operational/provider.js";
import { isThreadSeatWindowToken, isTaskWindowToken, parseWindowToken } from "../channels/window-key.js";
import { threadKeyArgument } from "./read_thread_seat.js";
import { appendAudit } from "../audit/audit.js";

export function renderSeatSteer(text: string, mirrored: boolean): string {
  return (
    `A message from the channel seat that opened your thread.\n\n` +
    `${text}\n\n` +
    (mirrored
      ? `This message was also posted into the thread, so the people in it can see it.`
      : `The people in the thread cannot see this message — it came to you alone. Answer in the thread if the answer belongs there.`)
  );
}

export default windowGated(
  "message_thread_seat",
  defineTool({
    description:
      "Send a message to a thread seat you opened — a steer, a correction, a fact it cannot see, or a question. " +
      "Set `mirror` on every call: false sends it to the seat alone, true also posts the same words into the " +
      "thread so the people there see it. The seat answers in its thread, not back through this call, so don't " +
      "wait on a reply here. Name the thread you mean; with no `thread` it uses the thread this message came from.",
    inputSchema: z.object({
      thread: z.string().min(1).optional().describe("The thread's root id, as `spawn_thread_session` returned it. Defaults to the thread this message came from."),
      text: z.string().min(1).describe("What you want the seat to know or do. Write it so it stands alone — the seat sees this text, not your turn."),
      mirror: z
        .boolean()
        .describe("REQUIRED. true: also post this into the thread, where the people in it can see it. false: the seat alone sees it. Decide per message; there is no default."),
    }),
    outputSchema: z.object({ delivered: z.boolean(), thread: z.string(), seatId: z.string(), mirrored: z.boolean(), note: z.string() }),
    async execute(input, ctx) {
      const c = ctx as BindableContext;
      const org = deploymentOrg();
      const wakeId = currentWakeId(c);
      const origin = wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId) : null;
      if (!origin) {
        throw new Error("message_thread_seat: couldn't resolve the conversation you're in — try again on a message-driven turn, or name the thread you mean.");
      }
      const ref = unifiedThreadRef(origin);
      const threadKey = threadKeyArgument(ref.threadKey, input.thread);
      const ownRef = { channelKey: ref.channelKey, threadKey };
      const store = getOperationalStore();
      const owner = await resolveThreadOwner(store, org, ownRef);
      if (owner === null) {
        throw new Error(`message_thread_seat: no session holds thread "${threadKey}" — nobody is there to message. Its messages already come to you; reply in the thread instead.`);
      }
      if (isTaskWindowToken(owner) || !isThreadSeatWindowToken(owner)) {
        throw new Error(
          `message_thread_seat: thread "${threadKey}" is held by a worker, not a thread seat — a worker runs one task and reports back, and has no conversation to steer. Wait for its result.`,
        );
      }
      const domain = parseWindowToken(owner)?.domain;
      if (domain === undefined) {
        throw new Error(`message_thread_seat: the session holding thread "${threadKey}" has an unreadable token — nothing was sent. Its messages will fall back to you when its ownership expires.`);
      }
      const state = await readThreadSeatState(store, org, ownRef);
      const seatOrigin = state ? threadSeatOrigin(state) : undefined;
      if (!seatOrigin) {
        throw new Error(
          `message_thread_seat: no usable record of thread "${threadKey}" — it was opened before this record existed, or the record has aged out. Post in the thread itself; the seat reads its own thread.`,
        );
      }
      if (input.mirror) {
        await postUnifiedReply(seatOrigin, input.text, {}, replyAuditFor(c, "tool", wakeId ?? undefined));
      }
      const delivered = await dispatchSeatMessage({
        token: owner,
        origin: seatOrigin,
        wakeId: mintWakeId(),
        domain,
        message: renderSeatSteer(input.text, input.mirror),
        authAttributes: {},
      });
      await appendAudit({
        org,
        platform: "unified",
        workspace: domain,
        action: "thread_seat.messaged",
        detail: {
          channelKey: ref.channelKey,
          threadKey,
          seatId: owner,
          mirrored: input.mirror,
          delivered,
          chars: input.text.length,
          wakeId: wakeId ?? null,
          sessionId: (c.session as { id?: string })?.id ?? null,
        },
      }).catch(() => undefined);
      return {
        delivered,
        thread: threadKey,
        seatId: owner,
        mirrored: input.mirror,
        note: delivered
          ? input.mirror
            ? "Sent to the thread seat, and posted in the thread. It answers in the thread — you'll see that when you next read the room."
            : "Sent to the thread seat alone. It answers in the thread — you'll see that when you next read the room."
          : input.mirror
            ? "Posted in the thread, but the seat could not be woken — say what you need in the thread itself."
            : "The seat could not be woken and nothing was posted — nobody has seen this message. Say it in the thread if it matters.",
      };
    },
  }),
);
