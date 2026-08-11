import { createHash } from "node:crypto";
import { defineState } from "eve/context";
import type { ToolContext, ToolDefinition } from "eve/tools";
import { auditToolAction } from "../audit/tool-action.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { SETTINGS, getSettings } from "../settings/settings.js";

export const DEFAULT_STALL_THRESHOLD = SETTINGS.stall.repeatThreshold.shipped;

export function stallThreshold(): number {
  return getSettings().stall.repeatThreshold;
}

export const RESULT_HASH_CAP_BYTES = 8192;

export const STALL_ALLOWLIST: ReadonlySet<string> = new Set(["reply", "react", "no_reply", "agent"]);

export function isGuardedTool(toolName: string): boolean {
  return !STALL_ALLOWLIST.has(toolName);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function inputKeyOf(input: unknown): string {
  return stableStringify(input);
}

export function signatureOf(toolName: string, inputKey: string, output: unknown): string {
  const result = stableStringify(output);
  const capped = result.length <= RESULT_HASH_CAP_BYTES ? result : result.slice(0, RESULT_HASH_CAP_BYTES);
  return createHash("sha1").update(`${toolName}\n${inputKey}\n${capped}`).digest("hex");
}

interface CallRef {
  readonly toolName: string;
  readonly inputKey: string;
}

export interface StallState {
  turnId: string | null;
  signature: string | null;
  count: number;
  armed: CallRef | null;
  strikes: number;
  strikeRef: CallRef | null;
  pending: Record<string, CallRef>;
}

export function initialStallState(): StallState {
  return { turnId: null, signature: null, count: 0, armed: null, strikes: 0, strikeRef: null, pending: {} };
}

const PENDING_CAP = 64;

function reduceTurn(state: StallState, turnId: string | null): StallState {
  if (turnId === null || state.turnId === turnId) return state;
  return { ...initialStallState(), turnId, pending: state.pending };
}

export function reduceRequest(state: StallState, turnId: string | null, callId: string, toolName: string, input: unknown): StallState {
  const s = reduceTurn(state, turnId);
  if (!isGuardedTool(toolName)) return s;
  const pending: Record<string, CallRef> = { ...s.pending, [callId]: { toolName, inputKey: inputKeyOf(input) } };
  const keys = Object.keys(pending);
  if (keys.length > PENDING_CAP) for (const k of keys.slice(0, keys.length - PENDING_CAP)) delete pending[k];
  return { ...s, pending };
}

export function reduceResult(state: StallState, turnId: string | null, callId: string, toolName: string, output: unknown, threshold: number): StallState {
  const s = reduceTurn(state, turnId);
  if (!isGuardedTool(toolName)) return s;
  const inputKey = s.pending[callId]?.inputKey ?? inputKeyOf(undefined);
  const pending = { ...s.pending };
  delete pending[callId];
  let strikes = s.strikes;
  let strikeRef = s.strikeRef;
  if (strikeRef && (strikeRef.toolName !== toolName || strikeRef.inputKey !== inputKey)) {
    strikes = 0;
    strikeRef = null;
  }
  const signature = signatureOf(toolName, inputKey, output);
  if (signature === s.signature) {
    const count = s.count + 1;
    const armed = threshold > 0 && count >= threshold ? { toolName, inputKey } : s.armed;
    return { ...s, signature, count, armed, strikes, strikeRef, pending };
  }
  return { ...s, signature, count: 1, armed: null, strikes, strikeRef, pending };
}

export function takeTrip(state: StallState, toolName: string, input: unknown): { tripped: boolean; strikes: number; state: StallState } {
  if (!isGuardedTool(toolName) || !state.armed) return { tripped: false, strikes: 0, state };
  const inputKey = inputKeyOf(input);
  if (state.armed.toolName !== toolName || state.armed.inputKey !== inputKey) return { tripped: false, strikes: 0, state };
  const sameStreak = state.strikeRef?.toolName === toolName && state.strikeRef?.inputKey === inputKey;
  const strikes = sameStreak ? state.strikes + 1 : 1;
  const strikeRef: CallRef = { toolName, inputKey };
  return { tripped: true, strikes, state: { ...state, signature: null, count: 0, armed: null, strikes, strikeRef } };
}

export function stallNudge(toolName: string, strikes = 1): string {
  const threshold = stallThreshold() || DEFAULT_STALL_THRESHOLD;
  if (strikes <= 1) {
    return (
      `You've called \`${toolName}\` with identical arguments and gotten an identical result ` +
      `${threshold} times in a row. That loop isn't making progress — stop repeating it: ` +
      `summarise what you already have, try a materially different approach, or ask for help.`
    );
  }
  if (strikes === 2) {
    return (
      `You are STILL looping on \`${toolName}\` — identical call, identical result, and you were ` +
      `already warned once. Do NOT call it the same way again. Change approach now, or tell the ` +
      `user you're stuck and exactly what's blocking you.`
    );
  }
  return (
    `You are stuck in a loop on \`${toolName}\` and have ignored ${strikes - 1} warnings. Stop ` +
    `calling it. Report to the user that you cannot make progress and what you were trying to do.`
  );
}

const stallSlot = defineState<StallState>("open-everywhere.stall-guard", initialStallState);

export function recordActionRequest(turnId: string | null, callId: string, toolName: string, input: unknown): void {
  if (stallThreshold() <= 0) return;
  try {
    stallSlot.update((s) => reduceRequest(s, turnId, callId, toolName, input));
  } catch {
  }
}

export function recordActionResult(turnId: string | null, callId: string, toolName: string, output: unknown): void {
  const threshold = stallThreshold();
  if (threshold <= 0) return;
  try {
    stallSlot.update((s) => reduceResult(s, turnId, callId, toolName, output, threshold));
  } catch {
  }
}

function consumeTrip(toolName: string, input: unknown): { tripped: boolean; strikes: number } {
  if (stallThreshold() <= 0) return { tripped: false, strikes: 0 };
  try {
    let tripped = false;
    let strikes = 0;
    stallSlot.update((s) => {
      const r = takeTrip(s, toolName, input);
      tripped = r.tripped;
      strikes = r.strikes;
      return r.state;
    });
    return { tripped, strikes };
  } catch {
    return { tripped: false, strikes: 0 };
  }
}

export function withStallGuard(toolName: string, tool: ToolDefinition): ToolDefinition {
  if (!isGuardedTool(toolName)) return tool;
  return {
    ...tool,
    async execute(input: unknown, ctx: ToolContext) {
      const { tripped, strikes } = consumeTrip(toolName, input);
      if (tripped) {
        emitTelemetry("oe.feature.used", { "oe.feature": "stall_guard", "oe.outcome": "tripped" });
        await auditToolAction(ctx, "stall.nudge", { tool: toolName, threshold: stallThreshold(), strikes });
        console.warn(`[open-everywhere:stall-guard] nudged "${toolName}" after ${stallThreshold()} identical calls (strike ${strikes})`);
        throw new Error(stallNudge(toolName, strikes));
      }
      return tool.execute(input, ctx);
    },
  };
}
