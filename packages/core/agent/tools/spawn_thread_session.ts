import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeTarget, mintWakeId, unifiedThreadRef } from "../channels/unified-window.js";
import { dispatchTaskWindow } from "../channels/unified.js";
import { getOperationalStore } from "../operational/provider.js";
import {
  parseWindowToken,
  isTaskWindowToken,
  isThreadSeatWindowToken,
  threadSeatWindowId,
  formatWindowToken,
  type WindowKey,
} from "../channels/window-key.js";
import { recordThreadOwner, resolveThreadOwner } from "../channels/thread-ownership.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { appendAudit } from "../audit/audit.js";

function ownWindowKey(ctx: BindableContext): WindowKey | undefined {
  const raw = ctx.channel?.continuationToken;
  if (typeof raw !== "string") return undefined;
  const stripped = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
  return parseWindowToken(stripped);
}

function isOwnTokenTaskOrThread(ctx: BindableContext): boolean {
  const raw = ctx.channel?.continuationToken;
  if (typeof raw !== "string") return false;
  const stripped = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
  return isTaskWindowToken(stripped) || isThreadSeatWindowToken(stripped);
}

export function canSpawnThreadFromWindow(ctx: BindableContext): boolean {
  if (!oneshotAgentEnabled()) return false;
  const raw = ctx.channel?.continuationToken;
  if (typeof raw !== "string" || raw.length === 0) return true;
  const stripped = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
  return parseWindowToken(stripped) !== undefined;
}

function renderThreadSeatBrief(brief: string): string {
  return (
    "You are a thread seat: a persistent conversational presence that OWNS this one thread and stays " +
    "live across turns. You have the conversational kit — reply/react/read — and you DELEGATE any real " +
    "work to a worker via `agent` (you have no sandbox yourself). Call `complete_thread` when the thread " +
    "is finished and hand it back to the channel watcher.\n\n" +
    brief
  );
}

export default windowGated("spawn_thread_session", defineTool({
  description:
    "Open a lasting presence in a thread: spawn a conversational seat that owns the thread and stays " +
    "live across messages (unlike a one-off worker). Use it when a thread needs ongoing back-and-forth " +
    "you don't want to run inline in this channel seat. The seat talks, reads, and delegates real work " +
    "to a worker itself. Give a self-contained brief (what the thread is about + what 'done' looks like); " +
    "returns at once with the seat's id. You keep watching the channel.",
  inputSchema: z.object({
    brief: z.string().min(1).describe("What this thread is about and the bar for done. The seat sees only this — include the context it needs."),
    thread: z.string().min(1).optional().describe("The thread to own. Defaults to the thread this message came from."),
  }),
  outputSchema: z.object({ seatId: z.string(), thread: z.string(), note: z.string() }),
  async execute(input, ctx) {
    const c = ctx as BindableContext;
    if (isOwnTokenTaskOrThread(c)) {
      throw new Error("spawn_thread_session: a worker or thread seat cannot open another thread seat — no recursive thread trees. Delegate work with `agent`, or ask the channel watcher to open one.");
    }
    const own = ownWindowKey(c);
    if (!own) {
      throw new Error("spawn_thread_session: this session can't open a thread seat — that runs on a standing window seat (a cross-surface or channel watcher on a window token). This seat has none.");
    }
    const wakeId = currentWakeId(c);
    const org = deploymentOrg();
    const origin = wakeId ? await resolveUnifiedWakeTarget(getOperationalStore(), org, wakeId) : null;
    if (!origin) {
      throw new Error("spawn_thread_session: couldn't resolve the thread that woke you — a seat must own a live thread. Try again on a message-driven turn.");
    }
    const ref = unifiedThreadRef(origin);
    const threadKey = input.thread && input.thread.length > 0 ? input.thread.replace(/:/g, "_") : ref.threadKey;
    const ownRef = { channelKey: ref.channelKey, threadKey };
    const seatToken = formatWindowToken({ domain: own.domain, windowId: threadSeatWindowId(ref.channelKey, threadKey), generation: own.generation });

    const store = getOperationalStore();
    const existing = await resolveThreadOwner(store, org, ownRef);
    if (existing && isThreadSeatWindowToken(existing) && parseWindowToken(existing)?.generation === own.generation) {
      return { seatId: existing, thread: threadKey, note: "This thread already has a running thread seat — reusing it (no second seat opened)." };
    }

    const tainted = untrustedIngestedThisTurn();
    const childWakeId = mintWakeId();
    await dispatchTaskWindow({
      token: seatToken,
      message: renderThreadSeatBrief(input.brief),
      wakeId: childWakeId,
      domain: own.domain,
      origin,
      parentAuthAttributes: c.session?.auth?.current?.attributes as Record<string, unknown> | undefined,
      tainted,
      grain: "thread",
    });

    await recordThreadOwner(store, org, ownRef, seatToken, new Date().toISOString()).catch(() => undefined);

    await appendAudit({
      org,
      platform: "unified",
      workspace: own.domain,
      action: "thread_seat.spawned",
      detail: {
        seatId: seatToken,
        windowId: threadSeatWindowId(ref.channelKey, threadKey),
        channelKey: ref.channelKey,
        threadKey,
        briefLen: input.brief.length,
        tainted,
        wakeId: childWakeId,
        parentWakeId: wakeId ?? null,
        parentSessionId: c.session && "id" in (c.session as Record<string, unknown>) ? (c.session as { id?: string }).id ?? null : null,
      },
    }).catch(() => undefined);

    return {
      seatId: seatToken,
      thread: threadKey,
      note: `Opened a thread seat to own this thread — it stays live across messages and delegates real work with \`agent\`. You keep watching the channel${tainted ? " (the brief carries this turn's untrusted-content taint forward)" : ""}.`,
    };
  },
}), canSpawnThreadFromWindow);
