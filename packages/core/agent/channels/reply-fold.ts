import { defineState } from "eve/context";
import { postArm } from "./post-arms.js";
import { isOwnPost, OWN_POST_TTL_MS, type OwnPostLedgerDeps, type OwnPostLocus } from "./own-post-ledger.js";
import { auditReplyForced, auditReplyRefused, type ReplyAudit } from "./reply-post.js";
import { secondMessageValve } from "./reply-signal.js";
import type { SessionTailEntry } from "./session-tail.js";
import type { TailWindow } from "./session-tail-record.js";

export const REPLY_FOLD_REFUSAL_REASON = "should-be-edit";

export const REPLY_FOLD_FORCED_AUDIT_REASON = "should-be-edit-forced";

export interface FoldTarget {
  readonly messageId: string;
  readonly platform: string;
}

export interface ReplyFoldStore {
  readSessionTail(org: string, surfaceKey: string, token: string): Promise<SessionTailEntry[]>;
}

export function platformCanEdit(platform: string): boolean {
  return typeof postArm(platform)?.editMessage === "function";
}

export function foldTargetInTail(
  ring: readonly SessionTailEntry[],
  input: {
    readonly container: string | undefined;
    readonly platform: string;
    readonly answeringWake?: string | undefined;
    readonly canEdit?: (platform: string) => boolean;
    readonly nowMs?: number;
    readonly windowMs?: number;
  },
): FoldTarget | null {
  if (!input.container) return null;
  const rows = ring.filter((e) => e.container === input.container);
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind.localeCompare(b.kind));
  const last = ordered[ordered.length - 1];
  if (last.kind !== "post" || last.from !== "self") return null;
  if (!last.id) return null;
  if (last.wake === undefined) return null;
  if (input.answeringWake !== undefined && last.wake !== input.answeringWake) return null;
  const platform = last.platform ?? input.platform;
  if (platform !== input.platform) return null;
  if (!(input.canEdit ?? platformCanEdit)(platform)) return null;
  const at = Date.parse(last.at);
  if (!Number.isFinite(at)) return null;
  if ((input.nowMs ?? Date.now()) - at > (input.windowMs ?? OWN_POST_TTL_MS)) return null;
  return { messageId: last.id, platform };
}

export async function replyFoldTarget(input: {
  readonly store: ReplyFoldStore;
  readonly window: TailWindow | null;
  readonly platform: string;
  readonly locus: OwnPostLocus | null;
  readonly answeringWake?: string | undefined;
  readonly nowMs?: number | undefined;
  readonly ledgerDeps?: OwnPostLedgerDeps;
}): Promise<FoldTarget | null> {
  const { store, window, platform, locus } = input;
  if (!window || !locus) return null;
  let ring: SessionTailEntry[];
  try {
    ring = await store.readSessionTail(window.org, window.registryKey, window.token);
  } catch {
    return null;
  }
  const target = foldTargetInTail(ring, {
    container: window.container,
    platform,
    answeringWake: input.answeringWake,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
  if (!target) return null;
  return (await isOwnPost(window.org, locus, target.messageId, input.ledgerDeps ?? {})) ? target : null;
}

export function foldIntoEditRefusalMessage(target: FoldTarget, canForce: boolean, answeringWake?: string | undefined): string {
  const valve = secondMessageValve(canForce);
  const args = answeringWake === undefined ? `message_id \`${target.messageId}\`` : `wake \`${answeringWake}\` and message_id \`${target.messageId}\``;
  return (
    "reply: your last message in this conversation is still the newest one — nobody has said anything since. " +
    "NOTHING was posted. The room already has your answer, so a second post beside it reads as noise. " +
    "Fold this into that message instead: call `edit_reply` with " +
    `${args}. ` +
    "🔴 An edit REPLACES the message outright, so write the FULL message — everything the old one said that still " +
    "holds, plus what you are adding — never only the new part. " +
    valve
  );
}

export async function refuseIfShouldFold(input: {
  readonly store: ReplyFoldStore;
  readonly window: TailWindow | null;
  readonly platform: string;
  readonly locus: OwnPostLocus | null;
  readonly turnId: string | undefined;
  readonly audit: ReplyAudit;
  readonly answeringWake?: string | undefined;
  readonly force?: boolean | undefined;
}): Promise<void> {
  const room = input.window?.container;
  if (wasFoldRefusedThisTurn(input.turnId, room)) return;
  const target = await replyFoldTarget({
    store: input.store,
    window: input.window,
    platform: input.platform,
    locus: input.locus,
    answeringWake: input.answeringWake,
  });
  if (!target) return;
  if (input.force === true) {
    await auditReplyForced(input.audit, REPLY_FOLD_FORCED_AUDIT_REASON);
    return;
  }
  markFoldRefusedThisTurn(input.turnId, room);
  await auditReplyRefused(input.audit, REPLY_FOLD_REFUSAL_REASON);
  throw new Error(foldIntoEditRefusalMessage(target, input.force !== undefined, input.answeringWake));
}

interface FoldRefusedRooms {
  readonly turnId: string;
  readonly rooms: readonly string[];
}

const refusedSlot = defineState<FoldRefusedRooms | null>("open-everywhere.reply-fold-refused", () => null);

const MAX_REFUSED_ROOMS = 32;

export function markFoldRefusedThisTurn(turnId: string | undefined, room: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (typeof room !== "string" || room.length === 0) return;
  try {
    refusedSlot.update((prev) => {
      const rooms = prev !== null && prev.turnId === turnId ? prev.rooms : [];
      if (rooms.includes(room) || rooms.length >= MAX_REFUSED_ROOMS) return { turnId, rooms };
      return { turnId, rooms: [...rooms, room] };
    });
  } catch {
  }
}

export function wasFoldRefusedThisTurn(turnId: string | undefined, room: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  if (typeof room !== "string" || room.length === 0) return false;
  try {
    const cur = refusedSlot.get();
    return cur !== null && cur.turnId === turnId && cur.rooms.includes(room);
  } catch {
    return false;
  }
}
