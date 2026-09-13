import "./turn-terminal-actions.js";
import { NO_REPLY_SENTINEL } from "./normalized-wake.js";
import { getSettings } from "../settings/settings.js";
import { configuredAgentName } from "../identity/bot-name.js";
import { consumeNoReplyThisTurn } from "./no-reply-signal.js";
import { silentRoutineThisTurn, SILENT_ROUTINE_DROP_REASON } from "../routines/report.js";
import { consumeStandDownSilenceThisTurn, STAND_DOWN_SILENCE_REASON } from "./stand-down-silence.js";
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

export const NO_REPLY_SENTINEL_REASON = "NO_REPLY sentinel — judged not warranted";

export function finalMessageAction(finishReason: string, message: string | null): FinalMessageAction {
  if (finishReason === "tool-calls") return { kind: "buffer-tool-status" };
  if (!message || !message.trim()) return { kind: "silent", reason: "empty final message" };
  if (isNoReply(message)) return { kind: "silent", reason: NO_REPLY_SENTINEL_REASON };
  return { kind: "post", text: message };
}

export function finalMessageActionForTurn(finishReason: string, message: string | null, turnId?: string): FinalMessageAction {
  const action = finalMessageAction(finishReason, message);
  if (action.kind === "buffer-tool-status") return action;
  const reason = consumeNoReplyThisTurn();
  const stoodDownSilent = consumeStandDownSilenceThisTurn(turnId);
  if (silentRoutineThisTurn()) return { kind: "silent", reason: SILENT_ROUTINE_DROP_REASON };
  if (stoodDownSilent) return { kind: "silent", reason: STAND_DOWN_SILENCE_REASON };
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

export function wakeNameDropTokens(displayName: string | undefined): string[] {
  const settings = getSettings();
  const exclude = new Set(
    settings.wake.nameDropExclude.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0),
  );
  const candidates = [displayName, configuredAgentName(), ...settings.wake.nameDropInclude];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const t = raw?.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key) || exclude.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export interface ReplierLabel {
  readonly taskLabel: string;
}

export function truncateTaskLabel(text: string, max = 60): string {
  const oneLine = text
    .replace(/[[\]]/g, "")
    .trim()
    .replace(/\s+/g, " ");
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

export const PENDING_WORK_INSTRUCTION =
  " Your background worker for this conversation has NOT reported yet, so you do not have the answer it was asked for" +
  " — never write that answer out yourself; report what the worker returns." +
  " Nothing is added to your message on its way out, so your own words are the only thing that tells this conversation" +
  " where the work stands: say plainly that you are still working on it, and do not present what you have as the final result.";

const MEMORY_MOUNT_SEGMENT = "workspace/memory/";

const TRAVERSED_URL_MOUNT = String.raw`(?:https?|file):\/\/[^\s()|<>:]{0,200}?\/\.\.\/[^\s()|<>:]{0,200}?workspace\/memory\/`;

const MOUNT_URL = String.raw`(?:file:\/\/\/workspace\/memory\/|${TRAVERSED_URL_MOUNT}|(?<![\w./:-])\/workspace\/memory\/)`;

const MARKDOWN_LINK_RE = new RegExp(String.raw`\[[^\]\n]*\]\((${MOUNT_URL}[^\s()]+)\)`, "g");

const SLACK_LINK_RE = new RegExp(String.raw`<(${MOUNT_URL}[^\s|>]+)\|[^>]*>`, "g");

const BARE_MEMORY_REF_RE = new RegExp(String.raw`${MOUNT_URL}[^\s()|<>]+`, "g");

function siloRelativePath(url: string): string {
  const idx = url.indexOf(MEMORY_MOUNT_SEGMENT);
  return idx < 0 ? url : url.slice(idx + MEMORY_MOUNT_SEGMENT.length);
}

export function truncateMemoryCitationPaths(text: string): string {
  let out = text.replace(MARKDOWN_LINK_RE, (_m, url: string) => siloRelativePath(url));
  out = out.replace(SLACK_LINK_RE, (_m, url: string) => siloRelativePath(url));
  out = out.replace(BARE_MEMORY_REF_RE, (m: string) => siloRelativePath(m));
  return out;
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

function rotationClockMs(days: number): number {
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

export function supervisorRotateContextSize(): number {
  return getSettings().rotation.contextSizeTokens;
}

export type RotationTrigger =
  | "runtime-changed"
  | "operator-marked"
  | "unknown-accumulation"
  | "unparseable-timestamp"
  | "expiry"
  | "quiet-gap"
  | "context-size"
  | "turn-backstop"
  | "token-backstop";

export interface RotationThresholds {
  readonly quietGapMs?: number;
  readonly turnBudget?: number;
  readonly tokenBudget?: number;
  readonly contextSizeTokens?: number;
  readonly expiryMs?: number;
  readonly runtimeChanged?: boolean;
}

export function rotationTrigger(
  row: Pick<ChannelSessionRow, "createdAt" | "lastWakeAt" | "turnCount" | "inputTokensTotal"> & Partial<Pick<ChannelSessionRow, "lastInputTokens" | "rotateMarkedAt">>,
  now: string,
  opts: RotationThresholds = {},
): RotationTrigger | null {
  if (opts.runtimeChanged === true) return "runtime-changed";
  if (row.rotateMarkedAt != null) return "operator-marked";
  if (row.inputTokensTotal == null) return "unknown-accumulation";
  const nowMs = Date.parse(now);
  const createdAtMs = Date.parse(row.createdAt);
  const lastWakeAtMs = Date.parse(row.lastWakeAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(createdAtMs) || !Number.isFinite(lastWakeAtMs)) return "unparseable-timestamp";
  if (nowMs - createdAtMs > (opts.expiryMs ?? supervisorRotateExpiryMs())) return "expiry";
  if (nowMs - lastWakeAtMs > (opts.quietGapMs ?? supervisorRotateQuietGapMs())) return "quiet-gap";
  if (row.lastInputTokens != null && row.lastInputTokens >= (opts.contextSizeTokens ?? supervisorRotateContextSize())) return "context-size";
  if (row.turnCount > (opts.turnBudget ?? supervisorRotateTurnBudget())) return "turn-backstop";
  if (row.inputTokensTotal >= (opts.tokenBudget ?? supervisorRotateTokenBudget())) return "token-backstop";
  return null;
}

export function shouldRotate(
  row: Pick<ChannelSessionRow, "createdAt" | "lastWakeAt" | "turnCount" | "inputTokensTotal"> & Partial<Pick<ChannelSessionRow, "lastInputTokens" | "rotateMarkedAt">>,
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
