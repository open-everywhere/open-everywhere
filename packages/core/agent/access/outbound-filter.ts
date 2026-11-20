import { asSchema, jsonSchema } from "ai";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/deployment-identity.js";
import { agentDisplayName } from "../identity/bot-name.js";
import { requesterAsksThisTurn, requesterMessagesThisTurn } from "./requester-messages.js";
import { currentContinuationTurn } from "./continuation-turn-state.js";
import { currentWorkTier } from "./lean-seat-state.js";
import {
  describeCategories,
  digitsOf,
  redactSpans,
  scanSensitive,
  UNSCANNABLE_TYPE,
  type SensitiveDetector,
  type SensitiveFinding,
  type SensitiveTier,
} from "./sensitive-data.js";

export const OUTBOUND_WITHHELD_ACTION = "outbound.withheld";
export const OUTBOUND_HELD_ACTION = "outbound.held";
export const CLOSING_PROSE_SINK = "closing-prose";
export const A2A_ANSWER_SINK = "a2a-answer";

export const OUTBOUND_INTERNAL_TOOLS: Readonly<Record<string, string>> = {
  agent:
    "hands a brief to a worker inside this deployment; every sink the worker calls is filtered on its own input, and the two surfaces that SHOW a brief (the Slack task card's title, Linear's action preview) strike it first",
  work: "forwards a job to this conversation's own work session; the worker it starts is filtered at its sinks",
  cancel_work: "names a job to stop; ids only, and the ticket stays in the operational store",
  eve__task_cancel: "stops a task this session started; ids only",
  eve__task_wait: "parks a turn on tasks already running; harness-internal",
  eve__reply: "returns a structured result to the session that started this one; that session's sinks are filtered",
  read_file: "reads a file in this session's sandbox",
  write_file: "writes a file in this session's sandbox; a later command that sends it is filtered on its own input only",
  edit_file: "edits a file in this session's sandbox; a later command that sends it is filtered on its own input only",
  glob: "lists files in this session's sandbox",
  grep: "searches files in this session's sandbox",
};

export function outboundSinkOf(toolName: string): "internal" | "outbound" {
  return Object.prototype.hasOwnProperty.call(OUTBOUND_INTERNAL_TOOLS, toolName) ? "internal" : "outbound";
}

const ASKED_WORDS: Readonly<Record<"health" | "personal-finance", RegExp>> = {
  health: /\b(?:health (?:data|records?|information|details|history)|medical (?:\w+ )?(?:history|records?|summary|details|notes|information)|medicines?|medications?|prescriptions?|NHS number|MRN|ICD-?10)\b/i,
  "personal-finance": /\b(?:bank (?:details|account|transfer)|banking details|IBAN|sort ?code|routing number|payment details|financial (?:details|information|data))\b/i,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type OutboundVerdict =
  | { readonly verdict: "pass" }
  | { readonly verdict: "withhold"; readonly findings: readonly SensitiveFinding[] }
  | { readonly verdict: "hold"; readonly findings: readonly SensitiveFinding[] };

function memberAskedFor(finding: SensitiveFinding, value: string, askedMessages: readonly string[]): boolean {
  if (askedMessages.length === 0) return false;
  const digits = digitsOf(value);
  const compact = value.replace(/\s/g, "").toLowerCase();
  for (const message of askedMessages) {
    if (compact.length >= 4 && message.replace(/\s/g, "").toLowerCase().includes(compact)) return true;
    if (digits.length >= 6 && digitsOf(message).includes(digits)) return true;
    if (finding.category === "custom") {
      const name = finding.type.replace(/^custom:/, "").replace(/-/g, " ");
      if (new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(message)) return true;
    } else if (finding.category === "health" || finding.category === "personal-finance") {
      if (ASKED_WORDS[finding.category].test(message)) return true;
    }
  }
  return false;
}

const UNSCANNABLE_FINDING: SensitiveFinding = { tier: "strictest", category: "unscannable", type: UNSCANNABLE_TYPE, start: 0, end: 0 };

function decidingFindings(text: string, askedMessages: readonly string[], detectors?: readonly SensitiveDetector[]): { readonly strict: SensitiveFinding[]; readonly unasked: SensitiveFinding[] } {
  const findings = detectors === undefined ? scanSensitive(text) : scanSensitive(text, detectors);
  const strict = findings.filter((f) => f.tier === "strictest");
  const unasked = findings.filter((f) => f.tier === "explicit" && !memberAskedFor(f, text.slice(f.start, f.end), askedMessages));
  return { strict, unasked };
}

export function decideOutbound(input: string | OutboundText, askedMessages: readonly string[], detectors?: readonly SensitiveDetector[]): OutboundVerdict {
  const { text, complete } = typeof input === "string" ? { text: input, complete: true } : input;
  if (!complete) return { verdict: "withhold", findings: [UNSCANNABLE_FINDING] };
  if (text.length === 0) return { verdict: "pass" };
  const { strict, unasked } = decidingFindings(text, askedMessages, detectors);
  if (strict.length > 0) return { verdict: "withhold", findings: strict };
  return unasked.length === 0 ? { verdict: "pass" } : { verdict: "hold", findings: unasked };
}

const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_LEAVES = 20_000;

export interface OutboundText {
  readonly text: string;
  readonly complete: boolean;
}

export function outboundTextOf(input: unknown): OutboundText {
  const parts: string[] = [];
  let complete = true;
  const walk = (v: unknown, depth: number): void => {
    if (!complete) return;
    if (parts.length >= MAX_INPUT_LEAVES || depth > MAX_INPUT_DEPTH) {
      complete = false;
      return;
    }
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "bigint") parts.push(String(v));
    else if (Array.isArray(v)) for (const el of v) walk(el, depth + 1);
    else if (v !== null && typeof v === "object") {
      for (const [key, el] of Object.entries(v as Record<string, unknown>)) {
        parts.push(key);
        walk(el, depth + 1);
      }
    }
  };
  walk(input, 0);
  return { text: parts.join("\n"), complete };
}

function withheldMessage(toolName: string, findings: readonly SensitiveFinding[]): string {
  const what = describeCategories(findings);
  return (
    `${toolName}: ${agentDisplayName()} withheld this call, so nothing was sent. Its input carries ${what}. ` +
    "Card numbers, government ID numbers and secrets never leave the organisation. " +
    `Tell the member plainly that you withheld ${what} and why. ` +
    "Do not send the value in any other form: not reformatted, split, spelled out, masked or encoded."
  );
}

function heldMessage(toolName: string, findings: readonly SensitiveFinding[]): string {
  const what = describeCategories(findings);
  return (
    `${toolName}: ${agentDisplayName()} held this call, so nothing was sent. Its input carries ${what}, ` +
    "which leaves the organisation only when a member asks for it, and no member asked for it in this turn. " +
    `Ask the member whether they want ${what} sent here. Send it only after they confirm in their own message, ` +
    'and ask them to name the data when they do ("yes, send the bank details"): a bare "yes" does not name it, so the call stays held.'
  );
}

function struckTextNotice(findings: readonly SensitiveFinding[]): string {
  const what = describeCategories(findings);
  return `(${agentDisplayName()} withheld ${what} from this message. Card numbers, government ID numbers and secrets never leave the organisation, and health and financial data leave only when a member asks.)`;
}

export interface OutboundRefusal {
  readonly action: typeof OUTBOUND_WITHHELD_ACTION | typeof OUTBOUND_HELD_ACTION;
  readonly tier: SensitiveTier;
  readonly sink: string;
  readonly types: readonly string[];
  readonly count: number;
}

export type OutboundRecorder = (refusal: OutboundRefusal) => Promise<void>;

async function recordOutboundRefusal(refusal: OutboundRefusal): Promise<void> {
  try {
    const turn = currentContinuationTurn();
    await appendAudit({
      org: deploymentOrg(),
      platform: "unified",
      workspace: "outbound",
      action: refusal.action,
      detail: {
        tier: refusal.tier,
        sink: refusal.sink,
        types: [...refusal.types],
        count: refusal.count,
        ...(turn?.sessionId !== undefined ? { session: turn.sessionId } : {}),
        ...(turn?.turnId !== undefined ? { turn: turn.turnId } : {}),
      },
    });
  } catch {
  }
}

function refusalOf(sink: string, verdict: "withhold" | "hold", findings: readonly SensitiveFinding[]): OutboundRefusal {
  const types = [...new Set(findings.map((f) => f.type))].sort();
  return {
    action: verdict === "withhold" ? OUTBOUND_WITHHELD_ACTION : OUTBOUND_HELD_ACTION,
    tier: verdict === "withhold" ? "strictest" : "explicit",
    sink,
    types,
    count: findings.length,
  };
}

function askedNow(): readonly string[] {
  try {
    return currentWorkTier() === "child" ? requesterMessagesThisTurn() : requesterAsksThisTurn(currentContinuationTurn()?.turnId).map((a) => a.body);
  } catch {
    return [];
  }
}

interface ToolWithInputSchema {
  inputSchema?: unknown;
}

interface ValidatingSchema {
  readonly jsonSchema: unknown;
  readonly validate?: (value: unknown) => Promise<{ success: true; value: unknown } | { success: false; error: Error }> | { success: true; value: unknown } | { success: false; error: Error };
}

export interface OutboundFilterDeps {
  readonly record?: OutboundRecorder;
  readonly asked?: () => readonly string[];
}

/**
 * The outbound decision for ONE tool call's input, outside a schema. It returns the refusal to
 * throw, or `undefined` when the input may leave. A withhold or hold writes its audit row first.
 * The schema wrap below calls it, and so does a tool that sends its input itself, such as an
 * OE-owned connector tool (`connections/connector-tools.ts`), which eve 1.x offers with no
 * toolset projection to wrap its schema.
 */
export async function outboundInputRefusal(name: string, value: unknown, deps: OutboundFilterDeps = {}): Promise<Error | undefined> {
  if (outboundSinkOf(name) === "internal") return undefined;
  const record = deps.record ?? recordOutboundRefusal;
  const asked = deps.asked ?? askedNow;
  const verdict = decideOutbound(outboundTextOf(value), asked());
  if (verdict.verdict === "pass") return undefined;
  await record(refusalOf(name, verdict.verdict, verdict.findings)).catch(() => undefined);
  return new Error(verdict.verdict === "withhold" ? withheldMessage(name, verdict.findings) : heldMessage(name, verdict.findings));
}

const replacements = new WeakMap<object, Map<string, unknown>>();
const ours = new WeakSet<object>();

function filteredSchema(name: string, current: unknown, deps: OutboundFilterDeps): unknown {
  const key = current !== null && (typeof current === "object" || typeof current === "function") ? (current as object) : undefined;
  const byName = key === undefined ? undefined : replacements.get(key);
  const cached = byName?.get(name);
  if (cached !== undefined) return cached;
  const original = asSchema(current as never) as unknown as ValidatingSchema;
  const source = original.jsonSchema;
  const advertised = source !== null && typeof source === "object" && typeof (source as { then?: unknown }).then === "function" ? () => source : source;
  const record = deps.record ?? recordOutboundRefusal;
  const asked = deps.asked ?? askedNow;
  const replacement = jsonSchema(advertised as never, {
    validate: async (value: unknown) => {
      const refusal = await outboundInputRefusal(name, value, { record, asked });
      if (refusal !== undefined) return { success: false as const, error: refusal };
      if (typeof original.validate !== "function") return { success: true as const, value };
      return (await original.validate(value)) as { success: true; value: unknown } | { success: false; error: Error };
    },
  });
  if (key !== undefined) {
    const map = byName ?? new Map<string, unknown>();
    map.set(name, replacement);
    replacements.set(key, map);
  }
  ours.add(replacement as object);
  return replacement;
}

export function filterToolsetOutbound(toolset: Record<string, unknown>, deps: OutboundFilterDeps = {}): { readonly filtered: string[]; readonly removed: string[] } {
  const filtered: string[] = [];
  const removed: string[] = [];
  for (const [name, raw] of Object.entries(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    if (outboundSinkOf(name) === "internal") continue;
    const tool = raw as ToolWithInputSchema;
    try {
      const current = tool.inputSchema;
      if (current !== null && typeof current === "object" && ours.has(current)) {
        filtered.push(name);
        continue;
      }
      tool.inputSchema = filteredSchema(name, current, deps);
      filtered.push(name);
    } catch (err) {
      delete toolset[name];
      removed.push(name);
      console.warn(`[open-everywhere:outbound-filter] removed "${name}" from the toolset: its input schema could not be wrapped (${err instanceof Error ? err.name : "error"})`);
    }
  }
  return { filtered, removed };
}

export function filterOutboundText(text: string, sink: string, deps: OutboundFilterDeps = {}): string {
  const record = deps.record ?? recordOutboundRefusal;
  const asked = deps.asked ?? askedNow;
  let strict: SensitiveFinding[];
  let unasked: SensitiveFinding[];
  try {
    ({ strict, unasked } = decidingFindings(text, asked()));
  } catch {
    strict = [UNSCANNABLE_FINDING];
    unasked = [];
  }
  if (strict.length === 0 && unasked.length === 0) return text;
  if (strict.length > 0) void record(refusalOf(sink, "withhold", strict)).catch(() => undefined);
  if (unasked.length > 0) void record(refusalOf(sink, "hold", unasked)).catch(() => undefined);
  const all = [...strict, ...unasked];
  return `${redactSpans(text, all)}\n\n${struckTextNotice(all)}`;
}

export function filterClosingProse(text: string, deps: OutboundFilterDeps = {}): string {
  return filterOutboundText(text, CLOSING_PROSE_SINK, deps);
}

export function redactOutboundPreview(text: string, asked: () => readonly string[] = askedNow): string {
  try {
    const { strict, unasked } = decidingFindings(text, asked());
    return strict.length === 0 && unasked.length === 0 ? text : redactSpans(text, [...strict, ...unasked]);
  } catch {
    return redactSpans(text, [UNSCANNABLE_FINDING]);
  }
}
