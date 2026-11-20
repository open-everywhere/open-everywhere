import type { OperationalStore, ThreadSeatState, ThreadSeatStateRow } from "../operational/store.js";
import type { UnifiedThreadRef, UnifiedWakeOrigin } from "./unified-window.js";
import { wakeOriginCodec } from "./wake-origin-codec.js";
import { surfaceMessageOps } from "./surface-message-ops.js";
import { parseWindowToken } from "./window-key.js";
import { clearThreadOwner, resolveThreadOwner } from "./thread-ownership.js";
import { recordThreadSeatClose, threadSeatOrigin } from "./thread-seat-state.js";
import type { appendAudit } from "../audit/audit.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const THREAD_SEAT_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

const THREAD_SEAT_SWEEP_LIMIT = 50;

export const THREAD_DONE_REACTION = { slackName: "white_check_mark", unicode: "✅" } as const;

export type ThreadSeatCloseReason = "completed" | "expired" | "closed";

export interface ThreadRootMessage {
  readonly platform: string;
  readonly channelId: string;
  readonly messageId: string;
}

export function threadRootMessageOf(origin: UnifiedWakeOrigin): ThreadRootMessage | undefined {
  try {
    const root = wakeOriginCodec(origin.platform)?.threadRootMessage?.(origin);
    if (!root || !root.channelId || !root.messageId) return undefined;
    return { platform: origin.platform, channelId: root.channelId, messageId: root.messageId };
  } catch {
    return undefined;
  }
}

export function hasThreadDoneReactionPath(platform: string): boolean {
  if (wakeOriginCodec(platform)?.threadRootMessage === undefined) return false;
  return platform === "slack" || surfaceMessageOps(platform)?.setReaction !== undefined;
}

export interface ThreadSeatCloseDeps {
  readonly store: Pick<OperationalStore, "getThreadSeatState" | "putThreadSeatState" | "closeThreadSeatState" | "putThreadOwner" | "getThreadOwner" | "clearThreadOwner" | "getChannelSession">;
  readonly handBack: (input: { readonly token: string; readonly domain: string; readonly origin: UnifiedWakeOrigin; readonly message: string }) => Promise<boolean>;
  readonly react: (platform: string, ref: { readonly channelId: string; readonly messageId: string }, emoji: typeof THREAD_DONE_REACTION) => Promise<boolean>;
  readonly appendAudit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
  readonly now: () => Date;
}

export interface ThreadSeatCloseOutcome {
  readonly recorded: boolean;
  readonly closedNow: boolean;
  readonly foreign: boolean;
  readonly priorState?: ThreadSeatState;
  readonly cleared: boolean;
  readonly handedBack: boolean;
  readonly reaction: "placed" | "failed" | "unsupported" | "not-owed" | "withheld";
}

function handBackOpening(reason: ThreadSeatCloseReason): string {
  switch (reason) {
    case "completed":
      return "A thread seat you opened finished its thread and handed it back.";
    case "expired":
      return "A thread seat you opened went quiet, so the host closed it and handed the thread back.";
    case "closed":
      return "The host closed a thread seat you opened, because its thread could no longer reach it, and handed the thread back.";
  }
}

export function renderThreadSeatHandBack(input: {
  readonly reason: ThreadSeatCloseReason;
  readonly ref: UnifiedThreadRef;
  readonly openedAt: string;
  readonly lastActiveAt: string;
  readonly closedAt: string;
  readonly afterExpiry?: boolean;
  readonly report?: string;
  readonly threadStoodDown?: boolean;
}): string {
  const report = input.report?.trim();
  const lines = [
    handBackOpening(input.reason) + (input.afterExpiry ? " It finished after the host had closed the thread as quiet, so this replaces that earlier hand-back." : ""),
    "",
    `Thread: ${input.ref.threadKey} (in ${input.ref.channelKey})`,
    `Opened: ${input.openedAt}. Last activity: ${input.lastActiveAt}. Closed: ${input.closedAt}.`,
    report ? `The seat's own report:\n${report}` : "The seat left no report. The thread itself is the record of what happened there.",
    "",
  ];
  if (input.reason === "completed") {
    lines.push(
      input.threadStoodDown === true
        ? "The thread stood down, so the seat posted nothing there and placed no done reaction. Post nothing there until someone @mentions you."
        : "The thread shows its completion, and its first message carries a done reaction where the surface has reactions.",
    );
  }
  lines.push("The task is off the thread seat now: a later message in that thread wakes you. Nothing is owed to the room. Speak only if this changes what someone is waiting for.");
  return lines.join("\n");
}

export async function closeThreadSeat(
  input: {
    readonly org: string;
    readonly ref: UnifiedThreadRef;
    readonly reason: ThreadSeatCloseReason;
    readonly seatToken: string;
    readonly report?: string;
    readonly origin?: UnifiedWakeOrigin;
    readonly auditDetail?: AuditDetail;
    /** Required: the done reaction is a visible write, so every caller states the thread's stand-down state. */
    readonly threadStoodDown: boolean;
  },
  deps: ThreadSeatCloseDeps,
): Promise<ThreadSeatCloseOutcome> {
  const { org, ref, reason, seatToken } = input;
  const closedAt = deps.now().toISOString();
  const report = input.report?.trim() || undefined;
  let record: Awaited<ReturnType<typeof recordThreadSeatClose>> = null;
  try {
    record = await recordThreadSeatClose(deps.store, org, ref, { seatToken, state: reason, ...(report !== undefined ? { report } : {}), atIso: closedAt });
  } catch {
    record = null;
  }
  const closedNow = record?.closedNow === true;
  const foreign = record?.foreign === true;

  let cleared = false;
  try {
    const owner = await resolveThreadOwner(deps.store, org, ref);
    if (owner !== null && owner === seatToken) cleared = await clearThreadOwner(deps.store, org, ref);
  } catch {
    cleared = false;
  }

  let handedBack = false;
  let reaction: ThreadSeatCloseOutcome["reaction"] = "not-owed";
  if (closedNow && record) {
    const origin = input.origin ?? threadSeatOrigin(record.row);
    handedBack = origin
      ? await handBackToParent(
          org,
          record.row,
          origin,
          renderThreadSeatHandBack({ reason, ref, openedAt: record.row.openedAt, lastActiveAt: record.lastActiveAt, closedAt, ...(record.priorState === "expired" ? { afterExpiry: true } : {}), ...(report !== undefined ? { report } : {}), ...(input.threadStoodDown ? { threadStoodDown: true } : {}) }),
          deps,
        )
      : false;
    if (reason === "completed") reaction = input.threadStoodDown ? "withheld" : origin ? await markThreadDone(origin, deps) : "unsupported";
  } else if (!record && reason === "completed" && input.origin && cleared) {
    reaction = input.threadStoodDown ? "withheld" : await markThreadDone(input.origin, deps);
  }

  const detail = {
    reason,
    channelKey: ref.channelKey,
    threadKey: ref.threadKey,
    seatId: seatToken ?? null,
    recorded: record !== null,
    closedNow,
    cleared,
    hasReport: report !== undefined,
    handedBack,
    reaction,
    ...(input.auditDetail ?? {}),
  };
  const base = { org, platform: "unified", workspace: ref.channelKey } as const;
  await (reason === "completed"
    ? deps.appendAudit({ ...base, action: "thread_seat.completed", detail })
    : deps.appendAudit({ ...base, action: "thread_seat.closed", detail })
  ).catch(() => undefined);
  return { recorded: record !== null, closedNow, foreign, cleared, handedBack, reaction, ...(record ? { priorState: record.priorState } : {}) };
}

async function handBackToParent(org: string, row: ThreadSeatStateRow, origin: UnifiedWakeOrigin, message: string, deps: ThreadSeatCloseDeps): Promise<boolean> {
  try {
    const parent = await deps.store.getChannelSession(org, row.parentRegistryKey);
    if (!parent) return false;
    const domain = parseWindowToken(parent.token)?.domain;
    if (domain === undefined) return false;
    return await deps.handBack({ token: parent.token, domain, origin, message });
  } catch {
    return false;
  }
}

async function markThreadDone(origin: UnifiedWakeOrigin, deps: ThreadSeatCloseDeps): Promise<ThreadSeatCloseOutcome["reaction"]> {
  const root = threadRootMessageOf(origin);
  if (!root) return "unsupported";
  try {
    return (await deps.react(root.platform, { channelId: root.channelId, messageId: root.messageId }, THREAD_DONE_REACTION)) ? "placed" : "failed";
  } catch {
    return "failed";
  }
}

export interface ThreadSeatSweepReport {
  readonly idle: number;
  readonly expired: number;
  readonly handedBack: number;
}

export async function sweepIdleThreadSeats(
  org: string,
  deps: ThreadSeatCloseDeps & { readonly store: ThreadSeatCloseDeps["store"] & Pick<OperationalStore, "listIdleThreadSeats"> },
): Promise<ThreadSeatSweepReport> {
  const before = new Date(deps.now().getTime() - THREAD_SEAT_IDLE_MS).toISOString();
  let rows: ThreadSeatStateRow[] = [];
  try {
    rows = await deps.store.listIdleThreadSeats(org, before, THREAD_SEAT_SWEEP_LIMIT);
  } catch {
    return { idle: 0, expired: 0, handedBack: 0 };
  }
  let expired = 0;
  let handedBack = 0;
  for (const row of rows) {
    const out = await closeThreadSeat({ org, ref: { channelKey: row.channelKey, threadKey: row.threadKey }, reason: "expired", seatToken: row.seatToken, threadStoodDown: false }, deps);
    if (out.closedNow) expired++;
    if (out.handedBack) handedBack++;
  }
  return { idle: rows.length, expired, handedBack };
}
