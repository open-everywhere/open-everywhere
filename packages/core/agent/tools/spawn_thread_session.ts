import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { currentTurnId, currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeTarget, mintWakeId, unifiedThreadRef, isThreadScopedWakeOrigin, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { renderWake } from "../channels/normalized-wake.js";
import { postArm } from "../channels/post-arms.js";
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
import { recordThreadOwner, resolveThreadOwner, isLiveThreadSeatOwner } from "../channels/thread-ownership.js";
import { recordThreadSeatOpen } from "../channels/thread-seat-state.js";
import { unifiedDomainSessionKey } from "../channels/unified-supervisor.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { liveAuthIsAnotherPrincipal } from "../access/turn-opening-principal.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { postOnce, outboundKey } from "../operational/post-once.js";
import { appendAudit } from "../audit/audit.js";
import { createHash } from "node:crypto";

function deterministicChildWakeId(callId: string): string {
  return createHash("sha256").update(`oe-oneshot:${callId}`).digest("hex").slice(0, 32);
}

function ownWindowKey(ctx: BindableContext): WindowKey | undefined {
  const token = resolveOwnWindowToken(ctx);
  return token ? parseWindowToken(token) : undefined;
}

function isOwnTokenTaskOrThread(ctx: BindableContext): boolean {
  const token = resolveOwnWindowToken(ctx);
  return token !== undefined && (isTaskWindowToken(token) || isThreadSeatWindowToken(token));
}

export function canSpawnThreadFromWindow(ctx: BindableContext): boolean {
  if (!oneshotAgentEnabled()) return false;
  const raw = ctx.channel?.continuationToken;
  if (typeof raw !== "string" || raw.length === 0) return true;
  const stripped = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
  return parseWindowToken(stripped) !== undefined;
}

export function renderThreadSeatBrief(brief: string): string {
  return (
    "You are a thread seat. The channel's standing seat handed you the task below and this one thread, " +
    "and it no longer watches the thread: you own the task from here to done. You hold the conversational " +
    "kit — reply, react, read — and you run the real work through this thread's own work session with " +
    "`work`. When the task is done, post the completion in this thread with `reply`, then call " +
    "`complete_thread` with a short summary. That marks the thread done and tells the standing seat.\n\n" +
    brief
  );
}

function renderThreadSeatOpening(input: { readonly wakeId: string; readonly origin: UnifiedWakeOrigin; readonly brief: string; readonly nowIso: string }): string {
  const arm = postArm(input.origin.platform);
  const containerId = arm?.redriveContainerId ? arm.redriveContainerId(input.origin) : input.origin.platform;
  const envelope = renderWake(
    {
      platform: input.origin.platform,
      reason: "dispatch",
      addressing: "direct-mention",
      wakeId: input.wakeId,
      locus: { channel: { id: containerId } },
      trigger: { kind: "notice" },
      systemNote: "The channel seat opened this thread seat for you. Your brief follows below this envelope.",
    },
    () => input.nowIso,
  ).message;
  return `${envelope}\n${renderThreadSeatBrief(input.brief)}`;
}

export default windowGated("spawn_thread_session", defineTool({
  description:
    "Hand a task's orchestration to a THREAD SESSION: a seat of its own that owns one thread, runs the " +
    "work through its own work session, talks with the people in the thread, and posts its result there. " +
    "Use it for anything that needs meaningful orchestration or real work. After the hand-off the task is " +
    "off your radar: you do not track it or relay it, and the host tells you when the thread is done. " +
    "Give a self-contained brief (what the task is, what the seat needs to know, what 'done' looks like). " +
    "Returns at once with the seat's id. You keep watching the channel.",
  inputSchema: z.object({
    brief: z.string().min(1).describe("What this thread is about and the bar for done. The seat sees only this — include the context it needs."),
    thread: z.string().min(1).optional().describe("The thread to own. Defaults to the thread this message came from."),
  }),
  outputSchema: z.object({ seatId: z.string(), thread: z.string(), note: z.string() }),
  async execute(input, ctx) {
    const c = ctx as BindableContext;
    if (!oneshotAgentEnabled()) {
      throw new Error("spawn_thread_session: delegation (delegation.oneshotAgent) is disarmed on this deployment — no new thread seats can be opened.");
    }
    if (isOwnTokenTaskOrThread(c)) {
      throw new Error("spawn_thread_session: a worker or thread seat cannot open another thread seat — no recursive thread trees. Forward work with `work`, or ask the channel watcher to open one.");
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
    if (origin.platform === "discord") {
      if (input.thread !== undefined) {
        throw new Error("spawn_thread_session: `thread` isn't accepted on Discord — a Discord thread IS its own channel, so the seat's thread is the message's own channel. Spawn from inside the thread with no `thread` argument.");
      }
      if (!isThreadScopedWakeOrigin(origin)) {
        throw new Error("spawn_thread_session: this Discord message isn't inside a thread — a seat opened here would own the whole channel and never be woken as a thread. Open a thread on the message and spawn from inside it.");
      }
    }
    if (!input.thread && !isThreadScopedWakeOrigin(origin)) {
      throw new Error("spawn_thread_session: this message isn't inside a thread — a seat opened here would never be woken again (only thread-scoped messages route to owners). Reply inside the thread and spawn from there, or pass `thread` with the thread's root id.");
    }
    const ref = unifiedThreadRef(origin);
    const threadKey = input.thread && input.thread.length > 0 ? input.thread.replace(/:/g, "_") : ref.threadKey;
    const ownRef = { channelKey: ref.channelKey, threadKey };
    const seatToken = formatWindowToken({ domain: own.domain, windowId: threadSeatWindowId(ref.channelKey, threadKey), generation: own.generation });

    const store = getOperationalStore();
    const existing = await resolveThreadOwner(store, org, ownRef);
    if (existing && isLiveThreadSeatOwner(existing, own.domain)) {
      return { seatId: existing, thread: threadKey, note: "This thread already has a running thread seat — reusing it (no second seat opened)." };
    }

    if (liveAuthIsAnotherPrincipal(c)) {
      throw new Error("spawn_thread_session: a later message inside this turn carried a different person's identity than the message that started it, so this turn cannot say whose thread seat to open. Ask for it again in a message of your own.");
    }
    const tainted = untrustedIngestedThisTurn();
    const callId = typeof (ctx as { callId?: unknown }).callId === "string" ? (ctx as { callId: string }).callId : undefined;
    const childWakeId = callId ? deterministicChildWakeId(callId) : mintWakeId();
    const doDispatch = () =>
      dispatchTaskWindow({
        token: seatToken,
        message: renderThreadSeatOpening({ wakeId: childWakeId, origin, brief: input.brief, nowIso: new Date().toISOString() }),
        wakeId: childWakeId,
        domain: own.domain,
        origin,
        parentAuthAttributes: c.session?.auth?.current?.attributes as Record<string, unknown> | undefined,
        tainted,
        grain: "thread",
        ...(own.windowId !== undefined ? { seatWindowId: own.windowId } : {}),
        turnId: currentTurnId(c),
      });
    if (callId) {
      await postOnce({
        org,
        key: outboundKey({ surface: "unified", action: "thread_seat.dispatch", stableId: callId, payload: seatToken }),
        run: doDispatch,
      });
    } else {
      await doDispatch();
    }

    const spawnedAt = new Date().toISOString();
    await recordThreadOwner(store, org, ownRef, seatToken, spawnedAt).catch(() => undefined);
    await recordThreadSeatOpen(store, org, ownRef, {
      seatToken,
      parentRegistryKey: unifiedDomainSessionKey(own.windowId ?? own.domain),
      origin,
      atIso: spawnedAt,
    }).catch(() => undefined);

    await appendAudit({
      org,
      platform: "unified",
      workspace: own.domain,
      action: "thread_seat.spawned",
      detail: {
        reason: "spawn" as const,
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
      note: `Opened a thread seat to own this thread — it stays live across messages and forwards real work to its own work session with \`work\`. You keep watching the channel${tainted ? " (the brief carries this turn's untrusted-content taint forward)" : ""}.`,
    };
  },
}), canSpawnThreadFromWindow);
