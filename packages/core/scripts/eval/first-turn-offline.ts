import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { generateText, tool, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { z } from "zod";
import { createGateway } from "@ai-sdk/gateway";
import { renderWake, type NormalizedWake } from "../../agent/channels/normalized-wake.js";
import { renderScopeMarkdown } from "../../agent/instructions/access.js";
import { registerConfig } from "../../agent/access/config.js";
import { defineDomain } from "../../agent/memory/domain.js";
import { defineMemorySilo } from "../../agent/memory/silo.js";
import { unifiedReplyEntry } from "../../agent/tools/reply.js";
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
const SHAPE = flag("--shape") ?? "schema";
const MODEL = flag("--model") ?? "openai/gpt-5.6-luna";
const EFFORT = flag("--effort") ?? "high";
const MODE = flag("--mode") ?? "coalesced";
const PAIR = flag("--pair") === undefined ? undefined : Math.max(0, Number.parseInt(flag("--pair")!, 10));
const TOOLSET = flag("--toolset") ?? "minimal";
const REISSUE = has("--reissue");

if (SHAPE === "schema") process.env.OE_WAKE_SHAPE = "schema";
else delete process.env.OE_WAKE_SHAPE;

const DOMAIN = "payments";
const SLACK_CHANNEL = "C_PAY";

function registerSyntheticConfig(): void {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [
      defineDomain({
        name: DOMAIN,
        channels: [`slack/T_PAY/${SLACK_CHANNEL}`, "notion/W_PAY/P_PAY", "github/acme/payments-api"],
        memory: "payments-notes",
        ambientSupervisor: true,
        mode: "unified",
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "payments-notes", description: "payments-domain decisions", provider: "sqlite" })],
    domainsForSurface: ({ surface }: { surface: string }) => ([SLACK_CHANNEL, "P_PAY", "payments-api"].includes(surface) ? [DOMAIN] : []),
  } as never);
}

const unifiedCtx: BindableContext = {
  channel: { kind: "channel:unified", continuationToken: `oe-dom:${DOMAIN}:oe-sup:g1` },
  session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
} as BindableContext;

async function buildSystemPrompt(): Promise<string> {
  const base = readFileSync(new URL("../../../../agent/instructions.md", import.meta.url), "utf8");
  const dynamic = await renderScopeMarkdown(unifiedCtx);
  return `${base}\n\n${dynamic}`;
}

const COALESCE_JOIN = "\n\n";

interface Probe { readonly ambientWakeId: string; readonly addressedWakeId: string; readonly userMessage: string; readonly ambientText: string; readonly addressedText: string; }

function buildProbe(i: number): Probe {
  const pair = S6_PROBES[(PAIR ?? i) % S6_PROBES.length];
  const ambientWakeId = `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const addressedWakeId = `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const now = () => new Date().toISOString();

  const channel = { id: SLACK_CHANNEL, type: "channel", platform: "slack", platformLabel: "Slack" };
  const ambient: NormalizedWake = {
    platform: "slack", reason: "channel-activity", addressing: "channel-watch",
    locus: { channel }, wakeId: ambientWakeId,
    participants: [{ id: "U_ALEX", name: "Alex" }, { id: "U_SAM", name: "Sam" }],
    trigger: { kind: "message", message: { id: "1768476128.893000", sentAt: now(), from: "human", trust: "peer", trigger: true, author: "Alex", authorId: "U_ALEX", body: pair.ambient } },
  };
  const addressed: NormalizedWake = {
    platform: "slack", reason: "mention", addressing: "direct-mention",
    locus: { channel }, wakeId: addressedWakeId,
    participants: [{ id: "U_ALEX", name: "Alex" }, { id: "U_SAM", name: "Sam" }],
    trigger: { kind: "message", message: { id: "1768476133.510000", sentAt: now(), from: "human", trust: "peer", trigger: true, mention: true, author: "Sam", authorId: "U_SAM", body: pair.addressed } },
  };
  const userMessage = MODE === "ambient-only"
    ? renderWake(ambient, now).message
    : [renderWake(ambient, now).message, renderWake(addressed, now).message].join(COALESCE_JOIN);
  return { ambientWakeId, addressedWakeId, userMessage, ambientText: pair.ambient, addressedText: pair.addressed };
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
  const resolved = await started({}, unifiedCtx);
  if (resolved === null || resolved === undefined) return null;
  return resolved as MountableEntry;
}

async function eveFrameworkTool(file: string): Promise<Record<string, unknown>> {
  const base = import.meta.resolve("eve/tools").replace(/\/src\/.*$/, "/src/runtime/framework-tools/");
  return (await import(base + file)) as Record<string, unknown>;
}

async function buildLeanSeatTools(calls: ToolCall[]): Promise<ToolSet> {
  const set: Record<string, ToolSet[string]> = {
    reply: recorder("reply", unifiedReplyEntry as MountableEntry, calls),
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
    reply: recorder("reply", unifiedReplyEntry as MountableEntry, calls),
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

interface ReissueStages {
  readonly step1: readonly ToolCall[];
  readonly secondCallEmpty: boolean;
  readonly secondCallText: string;
  readonly reissued: boolean;
  readonly afterNudge: readonly ToolCall[];
  readonly afterNudgeText: string;
}

async function runReissueProbe(
  gateway: ReturnType<typeof createGateway>,
  system: string,
  p: Probe,
  calls: ToolCall[],
): Promise<{ stages: ReissueStages; usage: Record<string, unknown> | undefined }> {
  const model = gateway(MODEL);
  const opts = { model, system, providerOptions: { openai: { reasoningEffort: EFFORT } }, stopWhen: stepCountIs(1) } as const;
  const base: ModelMessage[] = [{ role: "user", content: p.userMessage }];

  const first = await generateText({ ...opts, messages: base, tools: await buildTools(calls) });
  const step1 = [...calls];
  const afterFirst: ModelMessage[] = [...base, ...first.response.messages];

  const second = await generateText({ ...opts, messages: afterFirst, tools: await buildTools(calls) });
  const secondCallEmpty = second.text.trim() === "" && second.toolCalls.length === 0;

  if (!secondCallEmpty) {
    const usage = { ...(second.usage as Record<string, unknown>), ...((second.providerMetadata?.gateway as Record<string, unknown>) ?? {}) };
    return { stages: { step1, secondCallEmpty, secondCallText: second.text, reissued: false, afterNudge: [], afterNudgeText: "" }, usage };
  }

  const before = calls.length;
  const nudged: ModelMessage[] = [...afterFirst, { role: "user", content: eveEmptyResponseNudge() }];
  const third = await generateText({ ...opts, messages: nudged, tools: await buildTools(calls) });
  const afterNudge = calls.slice(before);

  const usage = { ...(third.usage as Record<string, unknown>), ...((third.providerMetadata?.gateway as Record<string, unknown>) ?? {}) };
  return {
    stages: { step1, secondCallEmpty, secondCallText: second.text, reissued: true, afterNudge, afterNudgeText: third.text },
    usage,
  };
}

interface Score {
  readonly addressedAnswered: boolean;
  readonly ambientSilent: boolean;
  readonly noCrossBinding: boolean;
  readonly correct: boolean;
  readonly notes: readonly string[];
}

export function scoreProbe(p: Pick<Probe, "ambientWakeId" | "addressedWakeId">, calls: readonly ToolCall[]): Score {
  const replies = calls.filter((c) => c.name === "reply");
  const wakeOf = (c: ToolCall): string => String(c.input.wake ?? "");
  const textOf = (c: ToolCall): string => String(c.input.text ?? "");
  const addressedAnswered = MODE === "ambient-only" || replies.some((c) => wakeOf(c) === p.addressedWakeId);
  const ambientSilent = !replies.some((c) => wakeOf(c) === p.ambientWakeId);
  const textLeak = replies.some((c) => textOf(c).includes(p.ambientWakeId));
  const noCrossBinding = ambientSilent && !textLeak;
  const notes: string[] = [];
  if (!addressedAnswered) notes.push(`the addressed wake ${p.addressedWakeId} got no reply — the message it was owed went unanswered`);
  if (!ambientSilent) notes.push(`the ambient wake ${p.ambientWakeId} got a reply — it should never have been answered`);
  if (textLeak) notes.push(`a reply's TEXT names the ambient wake's id — a raw id leaked into a delivered message`);
  const unknownWake = replies.filter((c) => wakeOf(c) !== p.addressedWakeId && wakeOf(c) !== p.ambientWakeId);
  for (const c of unknownWake) notes.push(`a reply named an id belonging to NEITHER wake: ${wakeOf(c)}`);
  return { addressedAnswered, ambientSilent, noCrossBinding, correct: addressedAnswered && ambientSilent && noCrossBinding, notes };
}

async function main(): Promise<void> {
  registerSyntheticConfig();
  const system = await buildSystemPrompt();
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

  console.log(`first-turn-offline: n=${N} mode=${MODE} shape=${SHAPE} toolset=${TOOLSET} reissue=${REISSUE} pair=${PAIR ?? "rotating"} model=${MODEL} effort=${EFFORT}`);
  console.log(`system prompt: ${system.length} chars`);

  const results: unknown[] = [];
  const usageLog: { probe: number; usage: Record<string, unknown> | null }[] = [];
  let correct = 0;
  let addressedAnswered = 0;
  let ambientSilent = 0;
  let noCrossBinding = 0;
  let emptySecondStep = 0;
  let overReplyAfterNudge = 0;

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
    if (stages?.secondCallEmpty) emptySecondStep++;
    if (stages?.reissued && stages.afterNudge.some((c) => c.name === "reply")) overReplyAfterNudge++;
    const score = scoreProbe(p, calls);
    if (score.correct) correct++;
    if (score.addressedAnswered) addressedAnswered++;
    if (score.ambientSilent) ambientSilent++;
    if (score.noCrossBinding) noCrossBinding++;
    const verdict = error ? "ERROR" : score.correct ? "CORRECT" : "WRONG";
    console.log(`\n── probe ${i + 1}/${N} ${verdict} (${Math.round((Date.now() - started) / 1000)}s)`);
    console.log(`   ambient : ${p.ambientText}`);
    console.log(`   addressed: ${p.addressedText}`);
    if (stages) {
      for (const c of stages.step1) console.log(`   step1 → ${c.name}(${JSON.stringify(c.input).slice(0, 200)})`);
      console.log(`   step2 → ${stages.secondCallEmpty ? "EMPTY (eve reissues here)" : `text ${JSON.stringify(stages.secondCallText.slice(0, 160))} — no reissue`}`);
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
    results.push({ probe: i + 1, ...p, calls, terminalText: text, score, stages: stages ?? null, usage: usage ?? null, error: error ?? null });
  }

  console.log(`\n════ first-turn correctness (offline, mode=${MODE}, shape=${SHAPE}) ════`);
  console.log(`correct            ${correct}/${N} = ${(correct / N).toFixed(2)}`);
  console.log(`addressed_answered ${addressedAnswered}/${N}`);
  console.log(`ambient_silent     ${ambientSilent}/${N}`);
  console.log(`no_cross_binding   ${noCrossBinding}/${N}`);
  if (REISSUE) {
    console.log(`empty_second_step  ${emptySecondStep}/${N}  (how often eve would reissue)`);
    console.log(`over_reply_nudged  ${overReplyAfterNudge}/${N}  (reissue turned silence into a reply)`);
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
  const out = flag("--out") ?? join(outDir, `first-turn-offline-${MODE}-${SHAPE}-${TOOLSET}${REISSUE ? "-reissue" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    config: { n: N, mode: MODE, pair: PAIR ?? null, shape: SHAPE, toolset: TOOLSET, reissue: REISSUE, mountedTools: mounted, model: MODEL, effort: EFFORT, systemPromptChars: system.length },
    summary: { correct, of: N, rate: correct / N, addressedAnswered, ambientSilent, noCrossBinding, emptySecondStep, overReplyAfterNudge },
    usage: usageLog,
    system,
    probes: results,
  }, null, 2));
  console.log(`\nwrote ${out}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
