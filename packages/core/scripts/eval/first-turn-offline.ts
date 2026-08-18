import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { generateText, tool, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { z } from "zod";
import { createGateway } from "@ai-sdk/gateway";
import { renderWake, type NormalizedWake } from "../../agent/channels/normalized-wake.js";
import { turnHasTerminalAction } from "../../agent/channels/turn-terminal-actions.js";
import { renderScopeMarkdown, renderReadingAWake, renderSupervisorPersona } from "../../agent/instructions/access.js";
import { registerConfig } from "../../agent/access/config.js";
import { defineDomain } from "../../agent/memory/domain.js";
import { defineMemorySilo } from "../../agent/memory/silo.js";
import replyDynamic, { unifiedReplyEntry } from "../../agent/tools/reply.js";
import { registerSlackFixtureMapper, registerSlackFixtureManifest } from "../_slack-test-stubs.js";
import noReplyTool, { NO_REPLY_NOTE } from "../../agent/tools/no_reply.js";
import updateStatusTool from "../../agent/tools/update_status.js";
import standDownTool from "../../agent/tools/stand_down.js";
import reactDynamic from "../../agent/tools/react.js";
import spawnThreadSessionDynamic from "../../agent/tools/spawn_thread_session.js";
import { S6_PROBES } from "./ambient-eval.js";
import type { BindableContext } from "../../agent/identity/binding.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

const N = Math.max(1, Number.parseInt(flag("--n") ?? "5", 10));
const MODEL = flag("--model") ?? "openai/gpt-5.6-luna";
const EFFORT = flag("--effort") ?? "high";
const MODE = flag("--mode") ?? "coalesced";
const MODES = ["coalesced", "ambient-only", "warranted-ambient", "addressed-only"] as const;
if (!(MODES as readonly string[]).includes(MODE)) throw new Error(`--mode must be one of ${MODES.join(", ")}; got '${MODE}'`);
const PAIR = flag("--pair") === undefined ? undefined : Math.max(0, Number.parseInt(flag("--pair")!, 10));
const TOOLSET = flag("--toolset") ?? "minimal";
const REISSUE = has("--reissue");
const STOCK_REISSUE = has("--stock-reissue");
const ARM = (flag("--arm") ?? "a").toLowerCase();
const ARMS = ["a", "c", "w", "r"] as const;
if (!(ARMS as readonly string[]).includes(ARM)) throw new Error(`--arm must be one of ${ARMS.join(", ")} (a=shipped, c=say-something, w=reading-a-wake, r=message-tool-only reporting); got '${ARM}'`);
const PATH = (flag("--path") ?? "unified").toLowerCase();
if (PATH !== "unified" && PATH !== "per-surface") throw new Error(`--path must be 'unified' or 'per-surface'; got '${PATH}'`);
const PER_SURFACE = PATH === "per-surface";
if (PER_SURFACE && MODE === "coalesced") {
  throw new Error("--path per-surface does not support --mode coalesced: a per-surface seat has no wake-id, so 'which wake did the reply name' has no answer to score. Use ambient-only, addressed-only or warranted-ambient.");
}
if ((ARM === "w" || ARM === "r") && !PER_SURFACE) throw new Error(`--arm ${ARM} needs --path per-surface: the unified prompt already carries that text, so applying it there measures a duplicate`);

const ARM_C_INSTRUCTION = `
## Ending the turn

Do not end a turn with nothing at all. Finish every turn with one short line, in your own words,
that says what you just did or decided — a sentence is plenty. There is no set phrase and no format
to follow, so write it the way you would tell a colleague in passing.

That closing line is not how you talk to the people here. Anything they are owed goes through
\`reply\` first; the closing line only notes that you sent it, or that nothing was needed.
`.trim();

const DOMAIN = "payments";
const SLACK_CHANNEL = "C_PAY";

const SLACK_TEAM = "T_PAY";

function registerSyntheticConfig(): void {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [
      defineDomain({
        name: DOMAIN,
        channels: [`slack/${SLACK_TEAM}/${SLACK_CHANNEL}`, "notion/W_PAY/P_PAY", "github/acme/payments-api"],
        memory: "payments-notes",
        ambientSupervisor: true,
        ...(PER_SURFACE ? {} : { mode: "unified" as const }),
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "payments-notes", description: "payments-domain decisions", provider: "sqlite" })],
    domainsForSurface: ({ surface }: { surface: string }) => ([SLACK_CHANNEL, "P_PAY", "payments-api"].includes(surface) ? [DOMAIN] : []),
  } as never);
  registerSlackFixtureMapper();
  registerSlackFixtureManifest();
}

const unifiedCtx: BindableContext = {
  channel: { kind: "channel:unified", continuationToken: `oe-dom:${DOMAIN}:oe-sup:g1` },
  session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
} as BindableContext;

const perSurfaceCtx: BindableContext = {
  channel: { kind: "slack", continuationToken: `${SLACK_CHANNEL}:oe-sup:g1` },
  session: {
    auth: {
      current: {
        attributes: { team_id: SLACK_TEAM, channel_id: SLACK_CHANNEL, channel_type: "channel", is_private: "false", trust_checked: "true" },
        principalId: "U_ALEX",
        principalType: "user",
      },
    },
  },
} as BindableContext;

const activeCtx: BindableContext = PER_SURFACE ? perSurfaceCtx : unifiedCtx;

function section(md: string, heading: string): string {
  const i = md.indexOf(heading);
  if (i < 0) throw new Error(`the '${heading}' section is not in the rendered block — the persona moved, so the arm cannot be built from it`);
  const j = md.indexOf("\n### ", i + 1);
  return j < 0 ? md.slice(i) : md.slice(i, j + 1);
}

function applyArmR(scope: string): string {
  const shippedReporting = section(renderSupervisorPersona(activeCtx), "### Reporting");
  const toolOnlyReporting = section(renderSupervisorPersona(activeCtx, { messageToolOnly: true }), "### Reporting");
  if (shippedReporting === toolOnlyReporting) throw new Error("arm r: both persona arms rendered the SAME reporting text — there is nothing to swap, so the arm would measure the shipped prompt under another name");
  const at = scope.indexOf(shippedReporting);
  if (at < 0) throw new Error("arm r: the shipped reporting section is not in the rendered scope — the swap would be a no-op");
  if (scope.indexOf(shippedReporting, at + 1) >= 0) throw new Error("arm r: the reporting section appears twice in the scope — refusing an ambiguous swap");
  return scope.slice(0, at) + toolOnlyReporting + scope.slice(at + shippedReporting.length);
}

async function buildSystemPrompt(): Promise<string> {
  const base = readFileSync(new URL("../../../../agent/instructions.md", import.meta.url), "utf8");
  const dynamic = ARM === "r" ? applyArmR(await renderScopeMarkdown(activeCtx)) : await renderScopeMarkdown(activeCtx);
  const shipped = `${base}\n\n${dynamic}`;
  if (ARM === "c") return `${shipped}\n\n${ARM_C_INSTRUCTION}\n`;
  if (ARM === "w") return `${shipped}\n\n${renderReadingAWake()}\n`;
  return shipped;
}

const COALESCE_JOIN = "\n\n";

const WARRANTED_PROBES: readonly {
  readonly shape: "room-question" | "name-drop" | "self-follow-up";
  readonly body: string;
  readonly selfPrior?: string;
  readonly expect: "reply" | "either";
  readonly why: string;
}[] = [
  { shape: "room-question", expect: "reply",
    body: `does anyone know what the ISO currency code for the Swiss franc is? need it for the payout mapping.`,
    why: `"a question you can answer — asked of the room" and the agent holds it outright` },
  { shape: "room-question", expect: "reply",
    body: `quick one for whoever is about — which HTTP status code means "too many requests"? I want to match on it.`,
    why: `same clause: a question to the room the agent answers without a lookup` },
  { shape: "room-question", expect: "reply",
    body: `does anyone remember how many minutes there are in a full day? I keep second-guessing the cron interval.`,
    why: `same clause; the ask is trivial so the measurement is WHETHER it speaks, not whether it can` },
  { shape: "name-drop", expect: "reply",
    body: `someone ask the agent what 250 divided by 4 is, we're arguing about how to split the invoice.`,
    why: `"you're addressed or named — a direct question, or your name in a request"` },
  { shape: "name-drop", expect: "reply",
    body: `the agent should know this one — is a leap year 365 or 366 days? need it for the accrual window.`,
    why: `same clause: the request names the agent as the holder, without an @mention` },
  { shape: "name-drop", expect: "either",
    body: `the agent has been quiet today. anyway, standup notes are in the doc if anyone missed it.`,
    why: `BORDERLINE ON PURPOSE — the name appears but nothing is asked, so silence is defensible` },
  { shape: "self-follow-up", expect: "reply",
    selfPrior: `Payout cutoff is 16:00 on weekdays — anything after that settles the next working day.`,
    body: `sorry, 16:00 UTC or 16:00 local? which one did you mean?`,
    why: `"a missing fact only you hold" — the ambiguity is in the agent's OWN post, so only it can resolve it` },
  { shape: "self-follow-up", expect: "reply",
    selfPrior: `I've moved the retry ceiling from 3 to 5 on the sandbox connector.`,
    body: `wait, is that 5 retries or 5 attempts in total? want to get the runbook right.`,
    why: `same clause: a direct clarifying question about a change the agent itself announced` },
  { shape: "self-follow-up", expect: "either",
    selfPrior: `Payout cutoff is 16:00 on weekdays — anything after that settles the next working day.`,
    body: `nice one, thanks — that's what I thought.`,
    why: `BORDERLINE ON PURPOSE — the prompt names social chatter "even right after you posted" as a silence case` },
];

interface Probe {
  readonly ambientWakeId: string;
  readonly addressedWakeId: string;
  readonly userMessage: string;
  readonly ambientText: string;
  readonly addressedText: string;
  readonly targetWakeId: string;
  readonly expect: "reply" | "silence" | "either";
  readonly shape: string;
  readonly why: string;
}

const envelopeWakeId = (id: string): string | undefined => (PER_SURFACE ? undefined : id);

function buildProbe(i: number): Probe {
  const pair = S6_PROBES[(PAIR ?? i) % S6_PROBES.length];
  const ambientWakeId = `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const addressedWakeId = `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const now = () => new Date().toISOString();

  const channel = { id: SLACK_CHANNEL, type: "channel" };

  if (MODE === "warranted-ambient") {
    const w = WARRANTED_PROBES[(PAIR ?? i) % WARRANTED_PROBES.length];
    const nameDropped = w.shape === "name-drop";
    const wake: NormalizedWake = {
      platform: "slack",
      reason: "channel-activity",
      addressing: nameDropped ? "name-drop" : "channel-watch",
      locus: { channel }, wakeId: envelopeWakeId(ambientWakeId),
      participants: [{ id: "U_ALEX", name: "Alex" }, { id: "U_SAM", name: "Sam" }],
      ...(nameDropped ? { nameDrop: { followUp: "channel-not-following" as const } } : {}),
      ...(w.selfPrior !== undefined
        ? { backscroll: [{ id: "1768476120.000100", sentAt: now(), from: "self" as const, trust: "peer" as const, author: "the agent", body: w.selfPrior }] }
        : {}),
      trigger: { kind: "message", message: { id: "1768476128.893000", sentAt: now(), from: "human", trust: "peer", trigger: true, author: "Alex", authorId: "U_ALEX", body: w.body } },
    };
    return {
      ambientWakeId, addressedWakeId, userMessage: renderWake(wake, now).message,
      ambientText: w.body, addressedText: "", targetWakeId: ambientWakeId,
      expect: w.expect, shape: w.shape, why: w.why,
    };
  }

  const ambient: NormalizedWake = {
    platform: "slack", reason: "channel-activity", addressing: "channel-watch",
    locus: { channel }, wakeId: envelopeWakeId(ambientWakeId),
    participants: [{ id: "U_ALEX", name: "Alex" }, { id: "U_SAM", name: "Sam" }],
    trigger: { kind: "message", message: { id: "1768476128.893000", sentAt: now(), from: "human", trust: "peer", trigger: true, author: "Alex", authorId: "U_ALEX", body: pair.ambient } },
  };
  const addressed: NormalizedWake = {
    platform: "slack", reason: "mention", addressing: "direct-mention",
    locus: { channel }, wakeId: envelopeWakeId(addressedWakeId),
    participants: [{ id: "U_ALEX", name: "Alex" }, { id: "U_SAM", name: "Sam" }],
    trigger: { kind: "message", message: { id: "1768476133.510000", sentAt: now(), from: "human", trust: "peer", trigger: true, mention: true, author: "Sam", authorId: "U_SAM", body: pair.addressed } },
  };
  const userMessage = MODE === "ambient-only"
    ? renderWake(ambient, now).message
    : MODE === "addressed-only"
      ? renderWake(addressed, now).message
      : [renderWake(ambient, now).message, renderWake(addressed, now).message].join(COALESCE_JOIN);
  return {
    ambientWakeId, addressedWakeId, userMessage, ambientText: pair.ambient, addressedText: pair.addressed,
    targetWakeId: MODE === "addressed-only" ? addressedWakeId : ambientWakeId,
    expect: MODE === "addressed-only" ? "reply" : "silence",
    shape: MODE === "addressed-only" ? "direct-mention" : "unwarranted-ambient",
    why: MODE === "addressed-only"
      ? `an @mention with a trivially-answerable ask — a reply is owed`
      : `ordinary channel chatter nothing about the agent is needed for`,
  };
}

interface ToolCall { readonly name: string; readonly input: Record<string, unknown>; }

const realSchema = (entry: { readonly inputSchema: unknown }): z.ZodType => entry.inputSchema as z.ZodType;

interface MountableEntry { readonly description: string; readonly inputSchema: unknown }

function recorder(name: string, entry: MountableEntry, calls: ToolCall[]): ToolSet[string] {
  return tool({
    description: entry.description,
    inputSchema: realSchema(entry),
    execute: async (input: unknown) => {
      calls.push({ name, input: input as Record<string, unknown> });
      if (name === "reply") return { posted: true, id: `probe-${calls.length}` };
      if (name === "no_reply") return { acknowledged: true, reason: String((input as { reason?: unknown }).reason ?? ""), note: NO_REPLY_NOTE };
      return { ok: true };
    },
  });
}

async function resolveDynamicEntry(mod: unknown): Promise<MountableEntry | null> {
  const events = (mod as { events?: Record<string, (e: unknown, c: unknown) => unknown> }).events;
  const started = events?.["session.started"];
  if (started === undefined) return null;
  const resolved = await started({}, activeCtx);
  if (resolved === null || resolved === undefined) return null;
  return resolved as MountableEntry;
}

let replyEntryCache: MountableEntry | undefined;
async function replyEntryForSeat(): Promise<MountableEntry> {
  if (replyEntryCache === undefined) {
    const entry = await resolveDynamicEntry(replyDynamic);
    if (entry === null) throw new Error(`the reply dynamic mounts NOTHING on the ${PATH} seat (no mid-turn post primitive) — every criterion here reads reply calls, so this run would score zeros that mean nothing`);
    replyEntryCache = entry;
  }
  return replyEntryCache;
}

async function eveFrameworkTool(file: string): Promise<Record<string, unknown>> {
  const base = import.meta.resolve("eve/tools").replace(/\/src\/.*$/, "/src/runtime/framework-tools/");
  return (await import(base + file)) as Record<string, unknown>;
}

async function buildLeanSeatTools(calls: ToolCall[]): Promise<ToolSet> {
  const set: Record<string, ToolSet[string]> = {
    reply: recorder("reply", await replyEntryForSeat(), calls),
    no_reply: recorder("no_reply", noReplyTool as MountableEntry, calls),
    update_status: recorder("update_status", updateStatusTool as MountableEntry, calls),
    stand_down: recorder("stand_down", standDownTool as MountableEntry, calls),
  };

  for (const [name, mod] of [["react", reactDynamic], ["spawn_thread_session", spawnThreadSessionDynamic]] as const) {
    const entry = await resolveDynamicEntry(mod);
    if (entry !== null) set[name] = recorder(name, entry, calls);
    else console.log(`   (lean toolset: ${name} does not mount on this seat — skipped)`);
  }

  const agentMod = await eveFrameworkTool("agent.js");
  set.agent = recorder("agent", agentMod.AGENT_TOOL_DEFINITION as MountableEntry, calls);
  const askMod = await eveFrameworkTool("ask-question.js");
  set.ask_question = recorder("ask_question", askMod.ASK_QUESTION_TOOL_DEFINITION as MountableEntry, calls);
  const todoMod = await eveFrameworkTool("todo.js");
  set.todo = recorder("todo", todoMod.TODO_TOOL_DEFINITION as MountableEntry, calls);
  const taskMod = await eveFrameworkTool("tasks.js");
  const taskDefs = taskMod.TASK_TOOL_DEFINITIONS as readonly (MountableEntry & { readonly name: string })[];
  for (const def of taskDefs) {
    if (def.name === "task_peek" || def.name === "task_cancel") set[def.name] = recorder(def.name, def, calls);
  }
  return set as ToolSet;
}

async function buildTools(calls: ToolCall[]): Promise<ToolSet> {
  if (TOOLSET === "lean") return await buildLeanSeatTools(calls);
  return {
    reply: recorder("reply", await replyEntryForSeat(), calls),
    no_reply: recorder("no_reply", noReplyTool as MountableEntry, calls),
  } as ToolSet;
}

function eveEmptyResponseNudge(): string {
  const url = import.meta.resolve("eve/tools").replace(/\/src\/.*$/, "/src/harness/tool-loop.js");
  const src = readFileSync(new URL(url), "utf8");
  const m = /EMPTY_RESPONSE_NUDGE\s*=\s*`([^`]+)`/.exec(src);
  if (m === null) {
    throw new Error("EMPTY_RESPONSE_NUDGE not found in the installed eve harness/tool-loop.js — the reissue contract moved; re-read the dist before trusting this arm");
  }
  return m[1];
}

export function eveWouldReissue(
  finalCallEmpty: boolean,
  messagesAtEmptyStep: readonly unknown[],
  stock = false,
): boolean {
  if (!finalCallEmpty) return false;
  if (stock) return true;
  return !turnHasTerminalAction(messagesAtEmptyStep);
}

interface ReplayCall { readonly calls: readonly ToolCall[]; readonly text: string }

interface ReissueStages {
  readonly step1: readonly ToolCall[];
  readonly step1Text: string;
  readonly perCall: readonly ReplayCall[];
  readonly finalCallEmpty: boolean;
  readonly finalCallText: string;
  readonly suppressedByTerminalGuard: boolean;
  readonly hitCallCeiling: boolean;
  readonly reissued: boolean;
  readonly afterNudge: readonly ToolCall[];
  readonly afterNudgeText: string;
}

const MAX_REPLAY_CALLS = 6;

async function runReissueProbe(
  gateway: ReturnType<typeof createGateway>,
  system: string,
  p: Probe,
  calls: ToolCall[],
): Promise<{ stages: ReissueStages; usage: Record<string, unknown> | undefined }> {
  const model = gateway(MODEL);
  const opts = { model, system, providerOptions: { openai: { reasoningEffort: EFFORT } }, stopWhen: stepCountIs(1) } as const;
  let messages: ModelMessage[] = [{ role: "user", content: p.userMessage }];

  const perCall: ReplayCall[] = [];
  let messagesAtFinalCall: ModelMessage[] = messages;
  let last = await generateText({ ...opts, messages, tools: await buildTools(calls) });
  let hitCallCeiling = false;
  perCall.push({ calls: [...calls], text: last.text });
  for (let k = 1; last.toolCalls.length > 0; k++) {
    if (k >= MAX_REPLAY_CALLS) { hitCallCeiling = true; break; }
    messages = [...messages, ...last.response.messages];
    messagesAtFinalCall = messages;
    const before = calls.length;
    last = await generateText({ ...opts, messages, tools: await buildTools(calls) });
    perCall.push({ calls: calls.slice(before), text: last.text });
  }
  const step1 = [...perCall[0].calls];
  const finalCallEmpty = !hitCallCeiling && last.text.trim() === "" && last.toolCalls.length === 0;

  const reissue = eveWouldReissue(finalCallEmpty, messagesAtFinalCall, STOCK_REISSUE);
  const suppressedByTerminalGuard = finalCallEmpty && !reissue;
  const stagesBase = {
    step1, step1Text: perCall[0].text, perCall, finalCallEmpty, finalCallText: last.text,
    suppressedByTerminalGuard, hitCallCeiling,
  };
  if (!reissue) {
    const usage = { ...(last.usage as Record<string, unknown>), ...((last.providerMetadata?.gateway as Record<string, unknown>) ?? {}) };
    return { stages: { ...stagesBase, reissued: false, afterNudge: [], afterNudgeText: "" }, usage };
  }

  const before = calls.length;
  const nudged: ModelMessage[] = [...messagesAtFinalCall, { role: "user", content: eveEmptyResponseNudge() }];
  const third = await generateText({ ...opts, messages: nudged, tools: await buildTools(calls) });
  const afterNudge = calls.slice(before);

  const usage = { ...(third.usage as Record<string, unknown>), ...((third.providerMetadata?.gateway as Record<string, unknown>) ?? {}) };
  return { stages: { ...stagesBase, reissued: true, afterNudge, afterNudgeText: third.text }, usage };
}

interface Score {
  readonly addressedAnswered: boolean;
  readonly ambientSilent: boolean;
  readonly noCrossBinding: boolean;
  readonly correct: boolean;
  readonly targetReplied: boolean;
  readonly borderline: boolean;
  readonly notes: readonly string[];
}

type Delivery = "tool" | "terminal" | "none";

export function scoreProbe(
  p: Pick<Probe, "ambientWakeId" | "addressedWakeId" | "targetWakeId" | "expect">,
  calls: readonly ToolCall[],
): Score {
  const replies = calls.filter((c) => c.name === "reply");
  const wakeOf = (c: ToolCall): string => String(c.input.wake ?? "");
  const textOf = (c: ToolCall): string => String(c.input.text ?? "");
  const namesWake = (c: ToolCall, id: string): boolean => (PER_SURFACE ? true : wakeOf(c) === id);
  const singleWake = MODE !== "coalesced";
  const addressedAnswered = (singleWake && MODE !== "addressed-only") || replies.some((c) => namesWake(c, p.addressedWakeId));
  const ambientSilent = !replies.some((c) => namesWake(c, p.ambientWakeId));
  const textLeak = replies.some((c) => textOf(c).includes(p.ambientWakeId));
  const noCrossBinding = !textLeak && (p.expect === "silence" ? ambientSilent : true);
  const targetReplied = replies.some((c) => namesWake(c, p.targetWakeId));
  const borderline = p.expect === "either";
  const notes: string[] = [];
  if (!addressedAnswered) notes.push(`the addressed wake ${p.addressedWakeId} got no reply — the message it was owed went unanswered`);
  if (p.expect === "silence" && !ambientSilent) notes.push(`the ambient wake ${p.ambientWakeId} got a reply — it should never have been answered`);
  if (p.expect === "reply" && !targetReplied) notes.push(`FALSE SILENCE — the wake ${p.targetWakeId} warranted a reply and got none`);
  if (textLeak) notes.push(`a reply's TEXT names the ambient wake's id — a raw id leaked into a delivered message`);
  const unknownWake = PER_SURFACE ? [] : replies.filter((c) => wakeOf(c) !== p.addressedWakeId && wakeOf(c) !== p.ambientWakeId);
  for (const c of unknownWake) notes.push(`a reply named an id belonging to NEITHER wake: ${wakeOf(c)}`);
  const meetsExpectation = p.expect === "either" ? true : p.expect === "reply" ? targetReplied : ambientSilent;
  return {
    addressedAnswered, ambientSilent, noCrossBinding, targetReplied, borderline,
    correct: addressedAnswered && noCrossBinding && meetsExpectation,
    notes,
  };
}

export function classifyDelivery(targetWakeId: string, calls: readonly ToolCall[], terminalText: string): Delivery {
  if (calls.some((c) => c.name === "reply" && (PER_SURFACE || String(c.input.wake ?? "") === targetWakeId))) return "tool";
  return terminalText.trim() === "" ? "none" : "terminal";
}

async function assertSeatShape(system: string): Promise<void> {
  const replyEntry = await replyEntryForSeat();
  const replyArgs = Object.keys((replyEntry.inputSchema as { shape?: Record<string, unknown> }).shape ?? {});
  const hasWakeArg = replyArgs.includes("wake");
  const block = renderReadingAWake();
  const carriesBlock = system.includes(block);
  if (PER_SURFACE) {
    if (replyEntry === (unifiedReplyEntry as unknown)) throw new Error("fixture guard: the per-surface seat resolved the UNIFIED reply entry — the ctx is not the per-container shape this run claims to measure");
    if (hasWakeArg) throw new Error("fixture guard: the per-surface `reply` carries a `wake` argument — the scoring rule for this path assumes it does not");
    if (ARM === "a" && carriesBlock) throw new Error("fixture guard: the per-surface prompt already carries the 'Reading a wake' block — the OPE-771 gap this run measures is closed, so re-read the ticket before quoting these numbers");
    if (ARM === "w" && !carriesBlock) throw new Error("fixture guard: arm w did not append the 'Reading a wake' block");
  } else {
    if (replyEntry !== (unifiedReplyEntry as unknown)) throw new Error("fixture guard: the unified seat did not resolve `unifiedReplyEntry` — every earlier arm's numbers assume it did");
    if (!carriesBlock) throw new Error("fixture guard: the unified prompt is missing the 'Reading a wake' block");
  }
  console.log(`seat: path=${PATH} reply=${PER_SURFACE ? "base (no wake arg)" : "unified (map-addressed)"} reading-a-wake=${carriesBlock ? "PRESENT" : "ABSENT"}${ARM === "w" ? " (appended by arm w)" : ""}`);
}

async function main(): Promise<void> {
  registerSyntheticConfig();
  const system = await buildSystemPrompt();
  await assertSeatShape(system);
  const mounted = Object.keys(await buildTools([]));
  console.log(`toolset (${mounted.length}): ${mounted.join(", ")}`);

  if (has("--dump-body")) {
    const p = buildProbe(0);
    console.log("──────── SYSTEM ────────\n");
    console.log(system);
    console.log("\n──────── USER (one coalesced first turn) ────────\n");
    console.log(p.userMessage);
    console.log(`\n──────── ids ────────\nambient    ${p.ambientWakeId}\naddressed  ${p.addressedWakeId}`);
    return;
  }

  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error("AI_GATEWAY_API_KEY is unset — source .env.e2e and set it from ROWAN_VERCEL_AI_GATEWAY_KEY (never the shell key, which is the shell key)");
  const gateway = createGateway({ apiKey: key });

  console.log(`first-turn-offline: n=${N} path=${PATH} mode=${MODE} arm=${ARM}${ARM === "c" ? " (say-something)" : " (shipped)"} toolset=${TOOLSET} reissue=${REISSUE ? (STOCK_REISSUE ? "stock (pre-OPE-762)" : "guarded (OPE-762)") : "off"} pair=${PAIR ?? "rotating"} model=${MODEL} effort=${EFFORT}`);
  console.log(`system prompt: ${system.length} chars`);

  const results: unknown[] = [];
  const usageLog: { probe: number; usage: Record<string, unknown> | null }[] = [];
  let correct = 0;
  let addressedAnswered = 0;
  let ambientSilent = 0;
  let noCrossBinding = 0;
  let emptyFinalStep = 0;
  let overReplyAfterNudge = 0;
  let ceilingHits = 0;
  let guardSuppressed = 0;
  const delivery: Record<Delivery, number> = { tool: 0, terminal: 0, none: 0 };
  let falseSilence = 0;
  let borderlineCount = 0;
  let expectedReply = 0;
  let erroredProbes = 0;

  for (let i = 0; i < N; i++) {
    const p = buildProbe(i);
    const calls: ToolCall[] = [];
    const messages: ModelMessage[] = [{ role: "user", content: p.userMessage }];
    const started = Date.now();
    let text = "";
    let usage: Record<string, unknown> | undefined;
    let error: string | undefined;
    let stages: ReissueStages | undefined;
    try {
      if (REISSUE) {
        const r = await runReissueProbe(gateway, system, p, calls);
        stages = r.stages;
        usage = r.usage;
        text = r.stages.afterNudgeText;
      } else {
        const r = await generateText({
          model: gateway(MODEL),
          system,
          messages,
          tools: await buildTools(calls),
          stopWhen: stepCountIs(6),
          providerOptions: { openai: { reasoningEffort: EFFORT } },
        });
        text = r.text;
        usage = { ...(r.usage as Record<string, unknown>), ...(r.providerMetadata?.gateway as Record<string, unknown> ?? {}) };
      }
    } catch (e) {
      error = (e as Error).message;
    }
    if (stages?.finalCallEmpty) emptyFinalStep++;
    if (stages?.hitCallCeiling) ceilingHits++;
    if (error !== undefined) erroredProbes++;
    if (stages?.suppressedByTerminalGuard) guardSuppressed++;
    if (stages?.reissued && stages.afterNudge.some((c) => c.name === "reply")) overReplyAfterNudge++;
    const score = scoreProbe(p, calls);
    const terminalText = stages
      ? [stages.afterNudgeText, ...[...stages.perCall].reverse().map((c) => c.text)].find((t) => t.trim() !== "") ?? ""
      : text;
    const del = classifyDelivery(p.targetWakeId, calls, terminalText);
    delivery[del]++;
    if (score.borderline) borderlineCount++;
    if (p.expect === "reply" && error === undefined) {
      expectedReply++;
      if (!score.targetReplied) falseSilence++;
    }
    if (score.correct) correct++;
    if (score.addressedAnswered) addressedAnswered++;
    if (score.ambientSilent) ambientSilent++;
    if (score.noCrossBinding) noCrossBinding++;
    const verdict = error ? "ERROR" : !score.correct ? "WRONG" : score.borderline ? "EITHER-OK" : "CORRECT";
    console.log(`\n── probe ${i + 1}/${N} ${verdict} (${Math.round((Date.now() - started) / 1000)}s) shape=${p.shape} expect=${p.expect} delivery=${del}`);
    if (MODE === "warranted-ambient") console.log(`   warrant : ${p.why}`);
    console.log(`   ambient : ${p.ambientText}`);
    if (p.addressedText !== "") console.log(`   addressed: ${p.addressedText}`);
    if (stages) {
      stages.perCall.forEach((c, k) => {
        for (const call of c.calls) console.log(`   step${k + 1} → ${call.name}(${JSON.stringify(call.input).slice(0, 200)})`);
        if (c.calls.length === 0) {
          const why = k + 1 === stages.perCall.length && stages.finalCallEmpty
            ? stages.suppressedByTerminalGuard
              ? "EMPTY — suppressed by the OPE-762 terminal guard (no reissue)"
              : "EMPTY (eve reissues here)"
            : `text ${JSON.stringify(c.text.slice(0, 160))} — no reissue`;
          console.log(`   step${k + 1} → ${why}`);
        }
      });
      if (stages.hitCallCeiling) console.log(`   ! the replay hit its ${MAX_REPLAY_CALLS}-call ceiling — this turn's ending is UNKNOWN, not empty`);
      if (stages.reissued) {
        for (const c of stages.afterNudge) console.log(`   nudged → ${c.name}(${JSON.stringify(c.input).slice(0, 200)})`);
        if (stages.afterNudge.length === 0) console.log(`   nudged → (no tool call) text: ${JSON.stringify(stages.afterNudgeText.slice(0, 200))}`);
      }
    } else {
      for (const c of calls) console.log(`   → ${c.name}(${JSON.stringify(c.input).slice(0, 240)})`);
      if (calls.length === 0) console.log(`   → (no tool calls) terminal text: ${JSON.stringify(text.slice(0, 240))}`);
    }
    for (const n of score.notes) console.log(`   ! ${n}`);
    if (error) console.log(`   ! model call failed: ${error}`);
    if (usage) console.log(`   $ tokens ${JSON.stringify(usage)}`);
    usageLog.push({ probe: i + 1, usage: usage ?? null });
    results.push({ probe: i + 1, ...p, calls, terminalText, delivery: del, score, stages: stages ?? null, usage: usage ?? null, error: error ?? null });
  }

  console.log(`\n════ first-turn correctness (offline, path=${PATH}, mode=${MODE}, arm=${ARM}) ════`);
  console.log(`correct            ${correct}/${N} = ${(correct / N).toFixed(2)}`);
  console.log(`addressed_answered ${addressedAnswered}/${N}`);
  console.log(`ambient_silent     ${ambientSilent}/${N}`);
  console.log(`no_cross_binding   ${noCrossBinding}/${N}`);
  console.log(`delivery           tool ${delivery.tool}/${N} · terminal ${delivery.terminal}/${N} · none ${delivery.none}/${N}`);
  if (expectedReply > 0) {
    console.log(`false_silence      ${falseSilence}/${expectedReply} = ${(falseSilence / expectedReply).toFixed(2)}  (probes that OWED a reply and made none)`);
  }
  if (borderlineCount > 0) console.log(`borderline         ${borderlineCount}/${N}  (expect="either" — reported, never scored against the agent)`);
  if (erroredProbes > 0) console.log(`errored            ${erroredProbes}/${N}  (the call threw — excluded from false_silence, never counted as a silence)`);
  if (REISSUE) {
    console.log(`empty_final_step   ${emptyFinalStep}/${N}  (the step eve reads as a failure)`);
    console.log(`guard_suppressed   ${guardSuppressed}/${N}  (OPE-762 stopped the nudge; ${STOCK_REISSUE ? "STOCK arm — guard off" : "guarded arm"})`);
    console.log(`nudges_sent        ${emptyFinalStep - guardSuppressed}/${N}  (reissues the stack actually sends)`);
    console.log(`over_reply_nudged  ${overReplyAfterNudge}/${N}  (reissue turned silence into a reply)`);
    if (ceilingHits > 0) console.log(`call_ceiling_hits  ${ceilingHits}/${N}  (replay ran out of calls — those turns' endings are UNKNOWN)`);
  }
  const cachedOf = (u: Record<string, unknown> | null): number => {
    const details = (u?.inputTokenDetails ?? {}) as Record<string, unknown>;
    return Number((details.cacheReadTokens ?? u?.cachedInputTokens ?? 0) as number);
  };
  const inputOf = (u: Record<string, unknown> | null): number => Number((u?.inputTokens ?? 0) as number);
  const totalIn = usageLog.reduce((a, r) => a + inputOf(r.usage), 0);
  const totalCached = usageLog.reduce((a, r) => a + cachedOf(r.usage), 0);
  console.log(`\ninput tokens ${totalIn} · cached ${totalCached} (${totalIn > 0 ? Math.round((totalCached / totalIn) * 100) : 0}%) across ${N} probes`);
  console.log(`per probe: ${usageLog.map((r) => `${inputOf(r.usage)}/${cachedOf(r.usage)}`).join(" ")}  (input/cached)`);

  const outDir = join(process.cwd(), "scripts/eval/results");
  const out = flag("--out") ?? join(outDir, `first-turn-offline-${PATH}-${MODE}-${TOOLSET}-arm${ARM}${REISSUE ? (STOCK_REISSUE ? "-reissue-stock" : "-reissue") : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    config: { n: N, path: PATH, mode: MODE, arm: ARM, pair: PAIR ?? null, toolset: TOOLSET, reissue: REISSUE, stockReissue: STOCK_REISSUE, mountedTools: mounted, model: MODEL, effort: EFFORT, systemPromptChars: system.length },
    summary: {
      correct, of: N, rate: correct / N, addressedAnswered, ambientSilent, noCrossBinding,
      emptyFinalStep, guardSuppressed, nudgesSent: emptyFinalStep - guardSuppressed, overReplyAfterNudge, ceilingHits,
      delivery, falseSilence, expectedReply, borderline: borderlineCount, erroredProbes,
    },
    usage: usageLog,
    system,
    probes: results,
  }, null, 2));
  console.log(`\nwrote ${out}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
