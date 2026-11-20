import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const harness = join(eveRoot, "dist/src/harness");
const enginePath = join(harness, "compaction/engine.js");
const stepPath = join(harness, "compaction/step.js");
const configPath = join(harness, "compaction/config.js");

interface CompactionConfig {
  readonly contextWindowTokens?: number;
  readonly estimateRatio?: number;
  readonly lastKnownInputTokens?: number;
  readonly lastKnownPromptMessageCount?: number;
  readonly lastStage?: string;
  readonly recentWindowSize: number;
  readonly target: number;
  readonly threshold: number;
}
interface Msg {
  readonly role: string;
  readonly content: unknown;
  readonly kind?: string;
}
type Summarize = (prompt: { messages: Msg[]; system: string }) => Promise<string>;
type Compact = (
  messages: Msg[],
  config: CompactionConfig,
  summarize: Summarize,
  forceSummary?: boolean,
  resume?: boolean,
) => Promise<{ messages: Msg[]; stage: string }>;
interface EngineModule {
  compactMessages: Compact;
  estimateRatio(config: CompactionConfig): number;
  getInputTokenCount(messages: readonly Msg[], config: CompactionConfig, envelope?: number, previousEnvelope?: number): number;
  shouldCompact(messages: readonly Msg[], config: CompactionConfig, envelope?: number, previousEnvelope?: number): boolean;
}

ok(existsSync(enginePath), `upstream: ${enginePath} exists — the compaction engine this test reads (moved there in the v1 rewrite)`);
ok(existsSync(stepPath), `upstream: ${stepPath} exists — the step that decides whether to compact before a model call`);
ok(
  !existsSync(join(harness, "compaction.js")) && !existsSync(join(harness, "tool-loop.js")),
  "upstream: the 0.x carriers harness/compaction.js and harness/tool-loop.js are gone — a 0.x eve is installed if either is back",
);

const engine = (await import(pathToFileURL(enginePath).href)) as unknown as EngineModule;
const { estimateTokens } = (await import(pathToFileURL(join(harness, "token-estimate.js")).href)) as unknown as {
  estimateTokens(messages: readonly unknown[]): number;
};
const promptModule = (await import(pathToFileURL(join(harness, "compaction/prompt.js")).href)) as unknown as {
  COMPACTION_CHECKPOINT_MARKER: string;
  COMPACTION_PROMPT_ENVELOPE: { prompt: string; system: string };
  TRANSCRIPT_PAYLOAD_LIMIT: number;
};
const contextChanges = (await import(pathToFileURL(join(harness, "session-machine/context-changes.js")).href)) as unknown as {
  completeCompaction(input: { changeId: string; runId: string; runOpen: boolean; summarized: boolean; usage?: unknown }): unknown;
};

const engineSrc = readFileSync(enginePath, "utf8");
const stepSrc = readFileSync(stepPath, "utf8");
const configSrc = readFileSync(configPath, "utf8");

const distFiles = readdirSync(join(eveRoot, "dist/src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js"));
const adjusted = distFiles.filter((f) => readFileSync(join(eveRoot, "dist/src", f), "utf8").includes("tokenEstimateAdjustment"));
ok(
  adjusted.length === 0,
  `upstream: no eve module carries a tokenEstimateAdjustment (found in ${adjusted.join(", ")}). The v1 engine anchors the ` +
    "trigger on the provider's count and scales the estimate by estimateRatio. An additive adjustment on top of that " +
    "double-counts the gap, so re-derive this test before it lands",
);
ok(
  !engineSrc.includes("__oeAnchoredConfig") && !engineSrc.includes("__oeNoteNoOpCompaction"),
  "upstream: NO part-3 helper of ours is installed — the hunk stays retired",
);
ok(
  /export\{compactMessages,[^}]*shouldCompact[^}]*\}/.test(engineSrc),
  "upstream: `compactMessages` and `shouldCompact` are still the exported names the compaction step reaches",
);
const targetShare = /const TARGET_SHARE=([0-9.]+);/.exec(configSrc);
ok(targetShare !== null && Number(targetShare[1]) === 0.5, "upstream: the compaction target is half the context window (TARGET_SHARE=.5)");
ok(
  engineSrc.includes("const COMPACTION_HEURISTICS=[fixedTailHeuristic];"),
  "upstream: the only compaction heuristic is fixedTailHeuristic, so every compacted result follows a summary call, and the " +
    "step's second opener never opens a change except on the way to a summary call",
);

const OVERHEAD = estimateTokens([
  { content: promptModule.COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  { content: promptModule.COMPACTION_PROMPT_ENVELOPE.prompt, role: "user" },
]);

const DENSE = "eJyVk1tv2jAUx7/KUZ42qUlIQmhJpUmoTNM0abtIm/YwTZUJDrhN7Mx2oKzqd99xEijQru";

function denseSession(): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < 20; i++) out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `step-${i} ${DENSE.repeat(20)}` });
  out.push({ role: "user", content: "final question", kind: "user" });
  return out;
}

const WINDOW = 20_000;
const THRESHOLD = 18_000;
const TARGET = Math.floor(WINDOW * 0.5);
const REPORTED = 70_000;

function denseConfig(messages: readonly Msg[], extra: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    contextWindowTokens: WINDOW,
    estimateRatio: REPORTED / estimateTokens(messages),
    lastKnownInputTokens: REPORTED,
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 4,
    target: TARGET,
    threshold: THRESHOLD,
    ...extra,
  };
}

const SUMMARY = "SUMMARY: the earlier conversation, condensed.";

function mockSummarize(): { summarize: Summarize; calls: () => number } {
  let calls = 0;
  return {
    summarize: async () => {
      calls++;
      return SUMMARY;
    },
    calls: () => calls,
  };
}

{
  const messages = denseSession();
  const config = denseConfig(messages);
  ok(estimateTokens(messages) + OVERHEAD <= THRESHOLD, "premise: the UTF-8 bytes/4 estimate reads the fixture as WITHIN the threshold");
  ok(
    engine.getInputTokenCount(messages, config) + OVERHEAD > THRESHOLD,
    "premise: the reported input-token count reads the same fixture as OVER the threshold",
  );
  ok(engine.shouldCompact(messages, config), "premise: the trigger anchors on the provider's count, so it fires");
  ok(
    !engine.shouldCompact(messages, { recentWindowSize: 4, target: TARGET, threshold: THRESHOLD }),
    "premise: with no reported count the estimate alone keeps the trigger quiet — the provider's count is the anchor",
  );
}

async function assertReduces(compact: Compact, label: string): Promise<void> {
  const messages = denseSession();
  const before = JSON.stringify(messages);
  const config = denseConfig(messages);
  const { summarize, calls } = mockSummarize();
  const { messages: after } = await compact(messages, config, summarize);

  ok(after.length < messages.length, `${label}reduces: the message list shrank (${messages.length} → ${after.length})`);
  ok(JSON.stringify(after).length < before.length, `${label}reduces: the serialized transcript shrank too, not only the message count`);
  ok(calls() >= 1, `${label}reduces: the summary model was called (${calls()} call(s)) — a summary really happened`);
  ok(
    after[0]?.role === "user" && after[0]?.content === promptModule.COMPACTION_CHECKPOINT_MARKER,
    `${label}reduces: the result opens with eve's checkpoint marker, so it is a real compaction result`,
  );
  ok(after.some((m) => m.content === SUMMARY), `${label}reduces: the summary the model produced is in the result`);
  ok(JSON.stringify(after) !== before, `${label}not-a-no-op: compactMessages did NOT return the input list unchanged (the OPE-689 defect shape)`);
  const provider = Math.ceil(estimateTokens(after) * engine.estimateRatio(config));
  ok(
    provider <= TARGET,
    `${label}target: the result is under half the window on the provider's token count (${provider} ≤ ${TARGET}), so the ` +
      "next call does not re-trigger the compaction that just ran",
  );
}

await assertReduces(engine.compactMessages, "");

{
  const identity: Compact = async (messages) => ({ messages, stage: "tail" });
  const before = n;
  await assert.rejects(
    assertReduces(identity, "negative-control "),
    "negative-control: a compaction that returns its input unchanged must FAIL the reduces block",
  );
  n = before + 1;
}

{
  const messages = denseSession();
  const ratio = 60;
  const config = denseConfig(messages, { estimateRatio: ratio });
  const { summarize } = mockSummarize();
  const { messages: after, stage } = await engine.compactMessages(messages, config, summarize);
  ok(stage === "summary-only", `escalation: a tail that cannot reach the target escalates to summary-only (got ${stage})`);
  ok(
    after.length < messages.length && after.some((m) => m.content === SUMMARY),
    "escalation: the escalated result still holds the summary and is shorter than the input",
  );
}

for (const lastStage of [undefined, "tail", "text-tail"]) {
  const messages = denseSession();
  const config = denseConfig(messages, lastStage === undefined ? {} : { lastStage });
  const { summarize, calls } = mockSummarize();
  const { messages: after } = await engine.compactMessages(messages, config, summarize);
  ok(
    calls() >= 1 && JSON.stringify(after) !== JSON.stringify(messages),
    `no-op-path: from lastStage=${String(lastStage)} the engine summarizes and changes the history — it has no exit that returns the input`,
  );
}

{
  const messages: Msg[] = [];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read", input: {} }] });
    messages.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read", output: { type: "text", value: DENSE.repeat(200) } }],
    });
  }
  messages.push({ role: "user", content: "what did you find", kind: "user" });
  const estimated = estimateTokens(messages);
  const config: CompactionConfig = {
    estimateRatio: 1.25,
    lastKnownInputTokens: Math.round(estimated * 1.25),
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 3,
    target: 10_000,
    threshold: 20_000,
  };
  ok(estimated > config.threshold, "tool-cap: the raw transcript is over the threshold on the estimate alone");
  ok(engine.shouldCompact(messages, config), "tool-cap: the trigger fires");

  const before = JSON.stringify(messages);
  const { summarize, calls } = mockSummarize();
  const { messages: after } = await engine.compactMessages(messages, config, summarize);
  ok(
    calls() >= 1,
    "no-op-path: capping oversized tool results does NOT end the pass without a summary — the 0.x tool-cap-only exit is gone",
  );
  ok(JSON.stringify(after).length < before.length, "tool-cap: the transcript really shrank");
  ok(
    JSON.stringify(after).includes("Truncated by eve"),
    `tool-cap: a kept oversized tool result is capped at the ${promptModule.TRANSCRIPT_PAYLOAD_LIMIT}-character payload limit`,
  );
}

const CU_START = "async function compactUnder(";
const CU_END = "async function summarizeHistory(";
const cuStart = stepSrc.indexOf(CU_START);
const cuEnd = stepSrc.indexOf(CU_END);
ok(cuStart !== -1 && cuEnd > cuStart, "gate: compactUnder and lazyChange are extractable from the installed step by their unminified names");
const gateSrc = stepSrc.slice(cuStart, cuEnd);
ok((gateSrc.match(/async function compactUnder\(/g) ?? []).length === 1, "gate: the slice holds exactly one compactUnder definition");
ok((gateSrc.match(/function lazyChange\(/g) ?? []).length === 1, "gate: the slice holds exactly one lazyChange definition");

interface Published {
  readonly fact: unknown;
}
interface DriveResult {
  readonly published: Published[];
  readonly summarized: number;
}

async function driveCompactUnder(messages: Msg[], config: CompactionConfig, openChange: boolean): Promise<DriveResult> {
  const published: Published[] = [];
  let summarized = 0;
  const factory = new Function(
    "shouldCompact",
    "getInputTokenCount",
    "nextChangeId",
    "nextRunId",
    "activeTurnId",
    "summarizeHistory",
    "startChange",
    "takeBlockingFailure",
    `${gateSrc}\nreturn compactUnder;`,
  ) as (...deps: unknown[]) => (e: unknown, t: unknown, n: Msg[], r: CompactionConfig) => Promise<unknown>;
  const compactUnder = factory(
    engine.shouldCompact,
    engine.getInputTokenCount,
    () => "change-1",
    () => "run-1",
    () => "turn-1",
    async (_e: unknown, t: { change: { open(): Promise<void>; opened: boolean } }) => {
      summarized++;
      if (openChange) {
        await t.change.open();
        await t.change.open();
      }
      return undefined;
    },
    (input: unknown) => ({ startChange: input }),
    () => undefined,
  );
  const ctx = {
    ctx: {},
    position: () => ({ turnId: "turn-1" }),
    publish: async (fact: unknown) => {
      published.push({ fact });
    },
    view: () => ({ projection: {} }),
  };
  await compactUnder(ctx, { messages, model: {}, requestEnvelopeTokens: 0 }, messages, config);
  return { published, summarized };
}

{
  const messages: Msg[] = [
    { role: "user", content: "hello", kind: "user" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "thanks", kind: "user" },
  ];
  const estimated = estimateTokens(messages);
  const config: CompactionConfig = {
    lastKnownInputTokens: Math.round(estimated * 1.2),
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 4,
    target: TARGET,
    threshold: THRESHOLD,
  };
  ok(!engine.shouldCompact(messages, config), "fast-path: the trigger does not fire on a session that fits");
  const { published, summarized } = await driveCompactUnder(messages, config, true);
  ok(summarized === 0, "fast-path: a fitting session never reaches the summary step, so no model call happens");
  ok(published.length === 0, "fast-path: a fitting session publishes NO context event — absence means no compaction");
}
{
  const messages = denseSession();
  const config = denseConfig(messages);
  const quiet = await driveCompactUnder(messages, config, false);
  ok(quiet.summarized === 1, "gate: an over-threshold session reaches the summary step once");
  ok(quiet.published.length === 0, "gate: the change is lazy — nothing is published until the summary step opens it");
  const opened = await driveCompactUnder(messages, config, true);
  ok(opened.published.length === 1, "gate: opening the change twice publishes exactly one context.started fact");
  const started = (opened.published[0]?.fact as { startChange?: { kind?: string; trigger?: { inputTokens?: number } } }).startChange;
  ok(
    started?.kind === "compaction" && started.trigger?.inputTokens === engine.getInputTokenCount(messages, config),
    "gate: the started fact is a compaction, and its trigger carries the provider-anchored input count",
  );
}

ok(
  /let summarize=async [A-Za-z_$]{1,2}=>\{await [A-Za-z_$]{1,2}\.open\(\)/.test(stepSrc) &&
    /isDeepStrictEqual\([A-Za-z_$]{1,2},[A-Za-z_$]{1,2}\)\|\|await [A-Za-z_$]{1,2}\.open\(\)/.test(stepSrc) &&
    /let ([A-Za-z_$]{1,2})=isDeepStrictEqual\([A-Za-z_$]{1,2},[A-Za-z_$]{1,2}\);if\([A-Za-z_$]{1,2}\.opened&&await settleChange\([^;]*\),\1\)return;let [A-Za-z_$]{1,2}=changeHistory\(/.test(stepSrc),
  "event: the summary call opens the change before the model runs, and a changed history opens it too. The step settles a " +
    "change only when it was opened, and it rewrites the history only after that, and only when the result differs from the input",
);
{
  const facts = contextChanges.completeCompaction({ changeId: "c-1", runId: "r-1", runOpen: true, summarized: true }) as {
    data: Record<string, unknown>;
    type: string;
  }[];
  const settled = facts.find((f) => f.type === "context.settled");
  ok(settled?.data.outcome === "completed" && settled.data.kind === "compaction", "event: a finished compaction settles as context.settled, outcome completed");
  ok(
    !("summarized" in (settled?.data ?? {})) && !("reduced" in (settled?.data ?? {})),
    "event: context.settled carries neither `summarized` nor `reduced` — a consumer reads the started/settled pair, not a flag",
  );
  ok(
    facts.findIndex((f) => f.type === "model.settled") >= 0 &&
      facts.findIndex((f) => f.type === "model.settled") < facts.findIndex((f) => f.type === "context.settled"),
    "event: a summarized compaction settles its summary run (model.settled) before the context change",
  );
}

console.log(
  `\n✓ eve-compaction-anchor: ${n} assertions passed (upstream, premise, reduces, target, negative-control, escalation, ` +
    `no-op-path, tool-cap, fast-path, gate, event)\n`,
);
