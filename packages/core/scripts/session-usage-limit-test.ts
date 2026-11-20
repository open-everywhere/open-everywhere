// The session budget's count rule on eve 1.x. The agent hands eve `limits.sessionUsage`, a
// function over the session's usage. This spec pins what that function counts, and that eve's
// own accounting puts a `decide()` call into the usage it reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emptySessionView, foldEvents, usage, type ReceivedEvent } from "eve/events";
import type { SessionUsageLimit } from "eve";
import { countedInputTokens, sessionUsageLimit, type SessionUsageTokens } from "../agent/model/session-usage.js";
import { SETTINGS } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require_ = createRequire(import.meta.url);
const eveRoot = dirname(require_.resolve("eve/package.json"));
const eveVersion = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;
const eveDist = (rel: string): string => pathToFileURL(join(eveRoot, "dist", "src", rel)).href;
console.log(`session-usage-limit: pinning against installed eve ${eveVersion}`);

const BUDGET = 30_000_000;
const NONE: SessionUsageTokens = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const tokens = (t: Partial<SessionUsageTokens>): SessionUsageTokens => ({ ...NONE, ...t });
const trips = (limit: SessionUsageLimit, window: SessionUsageTokens, total: SessionUsageTokens = window): boolean => limit({ total, window });

console.log("1. the count rule of the agent's own limit function:");
{
  const limit = sessionUsageLimit(BUDGET);
  ok(
    !trips(limit, tokens({ inputTokens: BUDGET + 1_000_000, cacheReadTokens: BUDGET + 1_000_000 })),
    "🔴 cache reads do NOT count: a window of only cache reads, over the budget, stays within it",
  );
  ok(
    trips(limit, tokens({ inputTokens: BUDGET, cacheWriteTokens: BUDGET })),
    "🔴 cache writes DO count: a window of only cache writes, at the budget, trips it",
  );
  ok(trips(limit, tokens({ inputTokens: BUDGET })), "the limit trips AT the budget");
  ok(!trips(limit, tokens({ inputTokens: BUDGET - 1 })), "…and not one token below it");
  ok(
    !trips(limit, tokens({ inputTokens: BUDGET + 5, cacheReadTokens: 10 })),
    "the cache reads come off the input before the compare (budget + 5 input, 10 of them cache reads)",
  );
  ok(
    !trips(limit, tokens({ inputTokens: 1_000 }), tokens({ inputTokens: BUDGET * 3 })),
    "🔴 the limit reads the WINDOW, not the lifetime total: an approved continuation starts a fresh budget",
  );
  ok(countedInputTokens(tokens({ inputTokens: 700, cacheReadTokens: 200, cacheWriteTokens: 100 })) === 500, "countedInputTokens is input minus cache reads");
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => sessionUsageLimit(bad), /positive number of tokens/, `a budget of ${String(bad)} is refused at boot`);
    n++;
  }
  ok(SETTINGS.agent.sessionInputTokenBudget.shipped === BUDGET, "the shipped `agent.sessionInputTokenBudget` is the budget this spec measures");
}

console.log("2. eve's own accounting puts a decide() call into the session's usage:");
{
  const decideSource = readFileSync(join(eveRoot, "dist", "src", "ai", "decide.js"), "utf8");
  ok(
    /async function decideFor\([\w$]+,[\w$]+\)\{[^}]*await recordUsage\(\{[^}]*\},\{kind:`decision`\}\)/.test(decideSource),
    "🔴 eve's public `decide()` (through `decideFor`) records its usage into the usage sink, as kind `decision`",
  );

  const sink = (await import(eveDist("harness/usage-sink.js"))) as {
    withUsageSink: <T>(publish: (commit: unknown) => Promise<unknown>, fn: () => Promise<T>) => Promise<T>;
    recordUsage: (usage: Partial<SessionUsageTokens>, options?: { readonly kind?: "auxiliary" | "decision" }) => Promise<void>;
  };
  const published: unknown[] = [];
  await sink.withUsageSink(
    async (commit) => {
      published.push(commit);
    },
    async () => {
      await sink.recordUsage({ inputTokens: BUDGET, outputTokens: 12 }, { kind: "decision" });
    },
  );
  const facts = published.flatMap((c) => (Array.isArray(c) ? c : [])) as { type?: string; data?: { kind?: string } }[];
  const fact = facts.find((f) => f.type === "usage.recorded");
  ok(fact !== undefined && fact.data?.kind === "decision", "🔴 inside a session step, the sink publishes a `usage.recorded` fact of kind `decision`");

  const at = "2000-01-01T00:00:00.000Z";
  const events: ReceivedEvent[] = [
    { type: "usage.recorded", data: fact?.data, meta: { position: { line: 0, index: 0 }, at, endOfLine: true } },
    {
      type: "usage.recorded",
      data: { kind: "model", usage: { inputTokens: 4_000_000, cacheReadTokens: 4_000_000, cacheWriteTokens: 0, outputTokens: 7 } },
      meta: { position: { line: 1, index: 0 }, at, endOfLine: true },
    },
  ];
  const seen = usage(foldEvents(emptySessionView(), events));
  ok(seen.total.inputTokens === BUDGET + 4_000_000, "eve's session projection folds the decision's input into the session total");
  ok(seen.byKind["decision"]?.inputTokens === BUDGET, "…and keeps it apart by kind, so the decision is visible as its own spend");
  ok(trips(sessionUsageLimit(BUDGET), seen.total), "🔴 a decide() call's input counts toward `sessionUsage`: the decision alone reaches the budget");
  ok(
    !trips(sessionUsageLimit(BUDGET + 1), seen.total),
    "…while the model step's 4M of cache reads add nothing (one token over the decision's spend stays within)",
  );

  const budget = (await import(eveDist("harness/hitl/budget.js"))) as {
    checkSessionUsageLimit: (input: {
      readonly canAsk: boolean;
      readonly limit: SessionUsageLimit;
      readonly session: { readonly sessionId: string; readonly state?: Record<string, unknown> };
      readonly turnSequence: number;
      readonly usage: SessionUsageTokens;
    }) => { readonly kind: string };
  };
  const check = (u: SessionUsageTokens): string =>
    budget.checkSessionUsageLimit({ canAsk: false, limit: sessionUsageLimit(BUDGET), session: { sessionId: "s-1", state: {} }, turnSequence: 1, usage: u }).kind;
  ok(check(seen.total) === "fail", "🔴 eve's own limit check, given the folded usage and the agent's limit, stops the session");
  ok(check(tokens({ inputTokens: BUDGET * 2, cacheReadTokens: BUDGET * 2 })) === "within", "🔴 …and lets a session of only cache reads run on");
}

console.log("3. eve's definition normalizer accepts the v1 keys and refuses the old ones:");
{
  const authored = (await import(eveDist("internal/authored-definition/core.js"))) as {
    normalizeAgentDefinition: (definition: unknown, label: string) => { readonly limits?: { readonly sessionUsage?: unknown }; readonly compaction?: { readonly threshold?: unknown } };
  };
  const normalized = authored.normalizeAgentDefinition(
    { model: "test/model", limits: { sessionUsage: sessionUsageLimit(BUDGET), sessionTimeoutMs: false }, compaction: { threshold: 0.5 } },
    "agent.ts:",
  );
  ok(typeof normalized.limits?.sessionUsage === "function", "`limits.sessionUsage` survives the normalizer as a function");
  ok(normalized.compaction?.threshold === 0.5, "`compaction.threshold` survives the normalizer as the fraction");
  assert.throws(() => authored.normalizeAgentDefinition({ model: "test/model", limits: { maxInputTokensPerSession: BUDGET } }, "agent.ts:"), /maxInputTokensPerSession/);
  n++;
  assert.throws(() => authored.normalizeAgentDefinition({ model: "test/model", compaction: { thresholdPercent: 0.5 } }, "agent.ts:"), /compaction\.threshold/);
  n++;
}

console.log("4. both shipped agent definitions author the v1 keys:");
for (const rel of ["agent/agent.ts", "packages/create/template/agent/agent.ts"]) {
  const src = readFileSync(join(REPO_ROOT, rel), "utf8");
  ok(/limits: \{ sessionUsage: sessionUsageLimit\(SESSION_INPUT_TOKEN_BUDGET\), sessionTimeoutMs: false \}/.test(src), `🔴 ${rel} hands eve the shared limit function over the configured budget`);
  ok(/const SESSION_INPUT_TOKEN_BUDGET = getSettings\(\)\.agent\.sessionInputTokenBudget;/.test(src), `${rel} reads the budget from the setting`);
  ok(!/maxInputTokensPerSession|thresholdPercent/.test(src), `${rel} carries no pre-v1 key`);
}

console.log(`✓ session-usage-limit: ${n} assertions passed (cache reads do not count toward the session budget; a decide() call does)`);
