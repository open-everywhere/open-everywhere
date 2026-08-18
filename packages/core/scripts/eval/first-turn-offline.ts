import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { generateText, tool, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { z } from "zod";
import { createGateway } from "@ai-sdk/gateway";
import { renderWake, type NormalizedWake } from "../../agent/channels/normalized-wake.js";
import { renderScopeMarkdown } from "../../agent/instructions/access.js";
import { registerConfig } from "../../agent/access/config.js";
import { defineDomain } from "../../agent/memory/domain.js";
import { defineMemorySilo } from "../../agent/memory/silo.js";
import { unifiedReplyEntry } from "../../agent/tools/reply.js";
import noReplyTool from "../../agent/tools/no_reply.js";
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

function buildTools(calls: ToolCall[]): ToolSet {
  return {
    reply: tool({
      description: unifiedReplyEntry.description,
      inputSchema: realSchema(unifiedReplyEntry),
      execute: async (input: unknown) => {
        calls.push({ name: "reply", input: input as Record<string, unknown> });
        return { posted: true, id: `probe-${calls.length}` };
      },
    }),
    no_reply: tool({
      description: noReplyTool.description,
      inputSchema: realSchema(noReplyTool),
      execute: async (input: unknown) => {
        calls.push({ name: "no_reply", input: input as Record<string, unknown> });
        return { ok: true };
      },
    }),
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

  console.log(`first-turn-offline: n=${N} mode=${MODE} shape=${SHAPE} pair=${PAIR ?? "rotating"} model=${MODEL} effort=${EFFORT}`);
  console.log(`system prompt: ${system.length} chars`);

  const results: unknown[] = [];
  const usageLog: { probe: number; usage: Record<string, unknown> | null }[] = [];
  let correct = 0;
  let addressedAnswered = 0;
  let ambientSilent = 0;
  let noCrossBinding = 0;

  for (let i = 0; i < N; i++) {
    const p = buildProbe(i);
    const calls: ToolCall[] = [];
    const messages: ModelMessage[] = [{ role: "user", content: p.userMessage }];
    const started = Date.now();
    let text = "";
    let usage: Record<string, unknown> | undefined;
    let error: string | undefined;
    try {
      const r = await generateText({
        model: gateway(MODEL),
        system,
        messages,
        tools: buildTools(calls),
        stopWhen: stepCountIs(6),
        providerOptions: { openai: { reasoningEffort: EFFORT } },
      });
      text = r.text;
      usage = { ...(r.usage as Record<string, unknown>), ...(r.providerMetadata?.gateway as Record<string, unknown> ?? {}) };
    } catch (e) {
      error = (e as Error).message;
    }
    const score = scoreProbe(p, calls);
    if (score.correct) correct++;
    if (score.addressedAnswered) addressedAnswered++;
    if (score.ambientSilent) ambientSilent++;
    if (score.noCrossBinding) noCrossBinding++;
    const verdict = error ? "ERROR" : score.correct ? "CORRECT" : "WRONG";
    console.log(`\n── probe ${i + 1}/${N} ${verdict} (${Math.round((Date.now() - started) / 1000)}s)`);
    console.log(`   ambient : ${p.ambientText}`);
    console.log(`   addressed: ${p.addressedText}`);
    for (const c of calls) console.log(`   → ${c.name}(${JSON.stringify(c.input).slice(0, 240)})`);
    if (calls.length === 0) console.log(`   → (no tool calls) terminal text: ${JSON.stringify(text.slice(0, 240))}`);
    for (const n of score.notes) console.log(`   ! ${n}`);
    if (error) console.log(`   ! model call failed: ${error}`);
    if (usage) console.log(`   $ tokens ${JSON.stringify(usage)}`);
    usageLog.push({ probe: i + 1, usage: usage ?? null });
    results.push({ probe: i + 1, ...p, calls, terminalText: text, score, usage: usage ?? null, error: error ?? null });
  }

  console.log(`\n════ first-turn correctness (offline, mode=${MODE}, shape=${SHAPE}) ════`);
  console.log(`correct            ${correct}/${N} = ${(correct / N).toFixed(2)}`);
  console.log(`addressed_answered ${addressedAnswered}/${N}`);
  console.log(`ambient_silent     ${ambientSilent}/${N}`);
  console.log(`no_cross_binding   ${noCrossBinding}/${N}`);
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
  const out = flag("--out") ?? join(outDir, `first-turn-offline-${MODE}-${SHAPE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    config: { n: N, mode: MODE, pair: PAIR ?? null, shape: SHAPE, model: MODEL, effort: EFFORT, systemPromptChars: system.length },
    summary: { correct, of: N, rate: correct / N, addressedAnswered, ambientSilent, noCrossBinding },
    usage: usageLog,
    system,
    probes: results,
  }, null, 2));
  console.log(`\nwrote ${out}`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ")) {
  await main();
}
