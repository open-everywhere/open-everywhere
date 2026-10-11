import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export interface RoutingAsk {
  readonly id: string;
  readonly expect: "self" | "thread";
  readonly body: string;
  readonly why: string;
}

export const ROUTING_ASKS: readonly RoutingAsk[] = [
  {
    id: "self-one-read",
    expect: "self",
    body: "<@BOT> what's the current p95 latency on the payments API? Just the number from the dashboard.",
    why: "ONE job a worker can run (a read the seat's own kit does not hold), and one result to relay.",
  },
  {
    id: "self-ci-status",
    expect: "self",
    body: "<@BOT> has PR #482 in acme/payments-api passed CI yet?",
    why: "ONE lookup and a yes/no back. Opening a thread session for it would cost a seat and add nothing.",
  },
  {
    id: "self-two-independent",
    expect: "self",
    body: "<@BOT> pull last week's error counts for checkout and for refunds.",
    why: "Two INDEPENDENT jobs whose results the seat relays as they arrive. Nothing builds on anything.",
  },
  {
    id: "thread-fix-and-review",
    expect: "thread",
    body: "<@BOT> the nightly reconciliation job has failed every night since Tuesday. Find out why, fix it, open a PR and get it through review.",
    why: "Real work with jobs that build on each other (diagnose, fix, PR) and a review loop.",
  },
  {
    id: "thread-plan-with-people",
    expect: "thread",
    body: "<@BOT> let's plan moving the ledger service to Postgres 17. Draft a plan, go through it with Sam and Alex, and turn it into tickets once we agree.",
    why: "Back-and-forth with people while the work runs, then dependent follow-on work.",
  },
  {
    id: "thread-iterate-until",
    expect: "thread",
    body: "<@BOT> write a load test for the payments API, run it against staging, and keep tuning until p99 stays under 300ms.",
    why: "Long-running work with an open-ended loop — meaningful orchestration by definition.",
  },
];

export interface ScoredCall {
  readonly name: string;
}

export const THREAD_HANDOFF_TOOL = "spawn_thread_session";
export const SELF_ORCHESTRATION_TOOLS: readonly string[] = ["work", "agent"];

export interface RoutingScore {
  readonly handedOff: boolean;
  readonly orchestratedSelf: boolean;
  readonly misrouted: boolean;
  readonly noRoute: boolean;
}

export function scoreRoutingTurn(ask: RoutingAsk, calls: readonly ScoredCall[]): RoutingScore {
  const handedOff = calls.some((c) => c.name === THREAD_HANDOFF_TOOL);
  const orchestratedSelf = !handedOff && calls.some((c) => SELF_ORCHESTRATION_TOOLS.includes(c.name));
  const noRoute = !handedOff && !orchestratedSelf;
  const misrouted = ask.expect === "self" ? handedOff : orchestratedSelf;
  return { handedOff, orchestratedSelf, misrouted, noRoute };
}

export function summariseRoutingRun(scored: readonly { readonly ask: RoutingAsk; readonly score: RoutingScore }[]): {
  readonly selfAsks: number;
  readonly selfHandedOff: number;
  readonly selfNoRoute: number;
  readonly threadAsks: number;
  readonly threadKeptInline: number;
  readonly threadNoRoute: number;
} {
  const side = (e: RoutingAsk["expect"]) => scored.filter((s) => s.ask.expect === e);
  return {
    selfAsks: side("self").length,
    selfHandedOff: side("self").filter((s) => s.score.misrouted).length,
    selfNoRoute: side("self").filter((s) => s.score.noRoute).length,
    threadAsks: side("thread").length,
    threadKeptInline: side("thread").filter((s) => s.score.misrouted).length,
    threadNoRoute: side("thread").filter((s) => s.score.noRoute).length,
  };
}

const RESULTS_DIR = fileURLToPath(new URL("./results/", import.meta.url));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const N = Math.max(1, Number.parseInt(flag("--n") ?? "12", 10));
  const MODEL = flag("--model") ?? "openai/gpt-6-luna";
  const EFFORT = flag("--effort") ?? "high";

  const { generateText, stepCountIs } = await import("ai");
  const { createGateway } = await import("@ai-sdk/gateway");
  const { renderWake } = await import("../../agent/channels/normalized-wake.js");
  const { NO_REPLY_NOTE } = await import("../../agent/tools/no_reply.js");
  const seat = await import("./_offline-seat.js");

  seat.registerSyntheticConfig({ unified: true });
  const system = await seat.buildShippedSystemPrompt(seat.unifiedCtx, () => seat.readBaseInstructions());

  const probe = (i: number) => {
    const ask = ROUTING_ASKS[i % ROUTING_ASKS.length];
    const now = () => new Date().toISOString();
    const rootTs = "1768476120.000100";
    const message = renderWake(
      {
        platform: "slack",
        reason: "mention",
        addressing: "direct-mention",
        locus: { channel: { id: seat.SLACK_CHANNEL, type: "channel" }, thread: { ts: rootTs } },
        wakeId: `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        participants: [{ id: "U_ALEX", name: "Alex" }, { id: "U_SAM", name: "Sam" }],
        trigger: { kind: "message", message: { id: "1768476133.510000", sentAt: now(), from: "human", trust: "peer", trigger: true, mention: true, author: "Alex", authorId: "U_ALEX", body: ask.body } },
      },
      now,
    ).message;
    return { ask, message };
  };

  if (argv.includes("--dump-body")) {
    console.log(system);
    console.log("\n================ USER MESSAGE ================\n");
    console.log(probe(0).message);
    return;
  }

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) throw new Error("AI_GATEWAY_API_KEY is unset — source .env.e2e, which sets AI_GATEWAY_API_KEY to your own gateway key");
  const gateway = createGateway({ apiKey });
  const resultFor = (name: string, input: Record<string, unknown>, callIndex: number): unknown => {
    if (name === "reply") return { posted: true, id: `probe-${callIndex}` };
    if (name === "no_reply") return { acknowledged: true, reason: String(input.reason ?? ""), note: NO_REPLY_NOTE };
    if (name === "spawn_thread_session") return { seatId: "probe-seat", thread: "1768476120.000100", note: "Opened a thread seat to own this thread." };
    if (name === "work" || name === "agent") return { started: true, note: "The job is running. Its result arrives later; this turn does not have it." };
    if (name === "read_channel") return { platform: "slack", channel: seat.SLACK_CHANNEL, count: 0, messages: [] };
    if (name === "read_thread") return { platform: "slack", channel: seat.SLACK_CHANNEL, thread_ts: "1768476120.000100", count: 0, messages: [] };
    return { ok: true };
  };

  console.log(`routing-decision offline — model=${MODEL} effort=${EFFORT} n=${N}`);
  const rows: { readonly ask: RoutingAsk; readonly score: RoutingScore; readonly calls: readonly string[] }[] = [];
  for (let i = 0; i < N; i++) {
    const { ask, message } = probe(i);
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    try {
      await generateText({
        model: gateway(MODEL),
        system,
        messages: [{ role: "user", content: message }],
        tools: await seat.buildLeanSeatToolset({ ctx: seat.unifiedCtx, calls, resultFor }),
        stopWhen: stepCountIs(4),
        providerOptions: { openai: { reasoningEffort: EFFORT } },
      });
    } catch (err) {
      console.log(`   probe-${i} [${ask.id}]: model call FAILED — ${(err as Error).message}`);
      continue;
    }
    const score = scoreRoutingTurn(ask, calls);
    rows.push({ ask, score, calls: calls.map((c) => c.name) });
    console.log(`   probe-${i} [${ask.id}] ${score.misrouted ? "MISROUTED" : score.noRoute ? "no route" : "ok"}  calls=[${calls.map((c) => c.name).join(",")}]`);
  }
  const s = summariseRoutingRun(rows);
  console.log(`\n   self asks:   ${s.selfHandedOff}/${s.selfAsks} handed to a thread session (defect), ${s.selfNoRoute} with no route`);
  console.log(`   thread asks: ${s.threadKeptInline}/${s.threadAsks} kept inline (defect), ${s.threadNoRoute} with no route`);
  const out = flag("--out") ?? join(RESULTS_DIR, `routing-decision-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ model: MODEL, effort: EFFORT, n: rows.length, summary: s, rows }, null, 2));
  console.log(`\n   wrote ${out}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
