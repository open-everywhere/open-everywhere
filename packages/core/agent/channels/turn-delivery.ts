import { NO_REPLY_SENTINEL } from "./normalized-wake.js";
import { getSettings } from "../settings/settings.js";
import { consumeNoReplyThisTurn } from "./no-reply-signal.js";
import { silentRoutineThisTurn, SILENT_ROUTINE_DROP_REASON } from "../routines/report.js";
import { OE_GRAIN_ATTR, OE_TASK_LABEL_ATTR } from "./unified-window.js";
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

export interface ReplierLabel {
  readonly taskLabel: string;
}

export function truncateTaskLabel(text: string, max = 60): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function replierLabelFor(grain: string | undefined, taskLabel: string | undefined): ReplierLabel | undefined {
  if (grain !== "task") return undefined;
  return { taskLabel: taskLabel && taskLabel.trim().length > 0 ? taskLabel : "task" };
}

export function replierLabelFromAuthAttributes(attrs: Record<string, unknown> | undefined): ReplierLabel | undefined {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return replierLabelFor(str(attrs?.[OE_GRAIN_ATTR]), str(attrs?.[OE_TASK_LABEL_ATTR]));
}

export function withReplierPrefix(text: string, replier: ReplierLabel | undefined): string {
  return replier ? `[${replier.taskLabel}] ${text}` : text;
}

export function supervisorRotateQuietGapMs(): number {
  return getSettings().rotation.quietGapHours * 3_600_000;
}

export function rotationClockMsFromDays(raw: string | undefined, defaultDays: number): number {
  const fallback = defaultDays * 86_400_000;
  if (raw === undefined || raw.trim() === "") return fallback;
  const days = Number(raw);
  if (!Number.isFinite(days)) return fallback;
  return rotationClockMs(days);
}

export function rotationClockMs(days: number): number {
  return days > 0 ? days * 86_400_000 : Number.POSITIVE_INFINITY;
}

export function supervisorRotateExpiryMs(): number {
  return rotationClockMs(getSettings().rotation.expiryDays);
}

export function supervisorRotateTokenBudget(): number {
  return getSettings().rotation.tokenBudget;
}

export function supervisorRotateTurnBudget(): number {
  return getSettings().rotation.turnBudget;
}

export type RotationTrigger =
  | "unknown-accumulation"
  | "unparseable-timestamp"
  | "expiry"
  | "quiet-gap"
  | "turn-backstop"
  | "token-backstop";

export interface RotationThresholds {
  readonly quietGapMs?: number;
  readonly turnBudget?: number;
  readonly tokenBudget?: number;
  readonly expiryMs?: number;
}

export function rotationTrigger(
  row: Pick<ChannelSessionRow, "createdAt" | "lastWakeAt" | "turnCount" | "inputTokensTotal">,
  now: string,
  opts: RotationThresholds = {},
): RotationTrigger | null {
  if (row.inputTokensTotal == null) return "unknown-accumulation";
  const nowMs = Date.parse(now);
  const createdAtMs = Date.parse(row.createdAt);
  const lastWakeAtMs = Date.parse(row.lastWakeAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(createdAtMs) || !Number.isFinite(lastWakeAtMs)) return "unparseable-timestamp";
  if (nowMs - createdAtMs > (opts.expiryMs ?? supervisorRotateExpiryMs())) return "expiry";
  if (nowMs - lastWakeAtMs > (opts.quietGapMs ?? supervisorRotateQuietGapMs())) return "quiet-gap";
  if (row.turnCount > (opts.turnBudget ?? supervisorRotateTurnBudget())) return "turn-backstop";
  if (row.inputTokensTotal >= (opts.tokenBudget ?? supervisorRotateTokenBudget())) return "token-backstop";
  return null;
}

export function shouldRotate(
  row: Pick<ChannelSessionRow, "createdAt" | "lastWakeAt" | "turnCount" | "inputTokensTotal">,
  now: string,
  opts: RotationThresholds = {},
): boolean {
  return rotationTrigger(row, now, opts) !== null;
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
