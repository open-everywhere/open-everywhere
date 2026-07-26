import { NO_REPLY_SENTINEL } from "./normalized-wake.js";
import { consumeNoReplyThisTurn } from "./no-reply-signal.js";
import { silentRoutineThisTurn, SILENT_ROUTINE_DROP_REASON } from "../routines/report.js";
import type { ChannelSessionRow } from "../operational/store.js";

export { NO_REPLY_SENTINEL };

export function isNoReply(message: string): boolean {
  return message.trimStart().startsWith(NO_REPLY_SENTINEL);
}

export type FinalMessageAction =
  | { readonly kind: "buffer-tool-status" }
  | { readonly kind: "silent"; readonly reason: string }
  | { readonly kind: "post"; readonly text: string };

export function finalMessageAction(finishReason: string, message: string | null): FinalMessageAction {
  if (finishReason === "tool-calls") return { kind: "buffer-tool-status" };
  if (!message || !message.trim()) return { kind: "silent", reason: "empty final message" };
  if (isNoReply(message)) return { kind: "silent", reason: "NO_REPLY sentinel — judged not warranted" };
  return { kind: "post", text: message };
}

export function finalMessageActionForTurn(finishReason: string, message: string | null): FinalMessageAction {
  const action = finalMessageAction(finishReason, message);
  if (action.kind === "buffer-tool-status") return action;
  const reason = consumeNoReplyThisTurn();
  if (silentRoutineThisTurn()) return { kind: "silent", reason: SILENT_ROUTINE_DROP_REASON };
  if (reason) return { kind: "silent", reason: `no_reply tool: ${reason}` };
  return action;
}

export function isBareStop(action: Extract<FinalMessageAction, { kind: "silent" } | { kind: "post" }>, actedThisTurn: boolean): boolean {
  return action.kind === "silent" && action.reason === "empty final message" && !actedThisTurn;
}

export function nameDropPattern(name: string): RegExp {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

export const SUPERVISOR_ROTATE_QUIET_GAP_MS =
  (Number(process.env.OE_SUPERVISOR_ROTATE_QUIET_GAP_HOURS) || 24) * 3_600_000;

export const SUPERVISOR_ROTATE_TOKEN_BUDGET = Number(process.env.OE_SUPERVISOR_ROTATE_TOKEN_BUDGET) || 4_000_000;

export const SUPERVISOR_ROTATE_TURN_BUDGET = Number(process.env.OE_SUPERVISOR_ROTATE_TURN_BUDGET) || 150;

export function shouldRotate(
  row: Pick<ChannelSessionRow, "lastWakeAt" | "turnCount" | "inputTokensTotal">,
  now: string,
  opts: { readonly quietGapMs?: number; readonly turnBudget?: number; readonly tokenBudget?: number } = {},
): boolean {
  if (row.inputTokensTotal == null) return true;
  if (row.inputTokensTotal >= (opts.tokenBudget ?? SUPERVISOR_ROTATE_TOKEN_BUDGET)) return true;
  if (row.turnCount > (opts.turnBudget ?? SUPERVISOR_ROTATE_TURN_BUDGET)) return true;
  const quietGapMs = opts.quietGapMs ?? SUPERVISOR_ROTATE_QUIET_GAP_MS;
  const lastWakeAtMs = Date.parse(row.lastWakeAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(lastWakeAtMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - lastWakeAtMs > quietGapMs;
}

export interface SupervisorTextDelivery {
  readonly postText: boolean;
  readonly droppedProse: boolean;
  readonly reason: string;
}

export function supervisorTextDelivery(hasTerminalProse: boolean, midTurnPostAvailable: boolean): SupervisorTextDelivery {
  if (!midTurnPostAvailable) {
    return { postText: hasTerminalProse, droppedProse: false, reason: "no reply tool on this surface — fail open, terminal text posts" };
  }
  return {
    postText: false,
    droppedProse: hasTerminalProse,
    reason: hasTerminalProse ? "message-tool-only: terminal prose dropped (reply via the tool)" : "message-tool-only: no terminal text",
  };
}

export function isSupervisorProseLeak(hasTerminalProse: boolean, repliedViaTool: boolean, cardPosted: boolean): boolean {
  return hasTerminalProse && !repliedViaTool && !cardPosted;
}
