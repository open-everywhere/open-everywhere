import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MockLanguageModelV4 } from "ai/test";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const compactionPath = join(eveRoot, "dist/src/harness/compaction.js");

interface CompactionConfig {
  readonly lastKnownInputTokens?: number;
  readonly lastKnownPromptMessageCount?: number;
  readonly recentWindowSize: number;
  readonly threshold: number;
}
interface Msg {
  readonly role: string;
  readonly content: unknown;
}
interface CompactionModule {
  compactMessages(
    messages: Msg[],
    model: unknown,
    config: CompactionConfig,
    providerOptions?: unknown,
    telemetry?: unknown,
    headers?: unknown,
    abortSignal?: unknown,
    forceSummary?: boolean,
  ): Promise<Msg[]>;
  getInputTokenCount(messages: readonly Msg[], config: CompactionConfig): number;
  shouldCompact(messages: readonly Msg[], config: CompactionConfig): boolean;
}

const compaction = (await import(pathToFileURL(compactionPath).href)) as unknown as CompactionModule;
const { estimateTokens } = (await import(pathToFileURL(join(eveRoot, "dist/src/harness/token-estimate.js")).href)) as unknown as {
  estimateTokens(messages: readonly unknown[]): number;
};
const promptModule = (await import(pathToFileURL(join(eveRoot, "dist/src/harness/compaction-prompt.js")).href)) as unknown as {
  COMPACTION_CHECKPOINT_MARKER: string;
  COMPACTION_PROMPT_ENVELOPE: { prompt: string; system: string };
  TRANSCRIPT_PAYLOAD_LIMIT: number;
};

const OVERHEAD = estimateTokens([
  { content: promptModule.COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  { content: promptModule.COMPACTION_PROMPT_ENVELOPE.prompt, role: "user" },
]);

const src = readFileSync(compactionPath, "utf8");
ok(src.includes("=== OE PATCH HELPERS (OPE-689) ==="), "presence: the OPE-689 marker comment is in the installed bytes");
ok(src.includes("function __oeCompactionDensity("), "presence: the __oeCompactionDensity helper is in the installed bytes");
ok(src.includes("function __oeCompactionDensityConfig("), "presence: the __oeCompactionDensityConfig helper is in the installed bytes");
ok(
  src.indexOf("function __oeCompactionDensity(") < src.indexOf("// === END OE PATCH HELPERS ==="),
  "presence: the helpers live inside the OE helper block",
);
ok(
  /async function compactMessages\([^)]*\)\{[A-Za-z_$]{1,2}=__oeCompactionDensityConfig\(/.test(src),
  "wiring: the corrected config is installed as the first statement of compactMessages",
);
ok((src.match(/__oeCompactionDensityConfig\(/g) ?? []).length === 2, "wiring: exactly one call site (helper definition plus one invocation)");

const DENSE = "eJyVk1tv2jAUx7/KUZ42qUlIQmhJpUmoTNM0abtIm/YwTZUJDrhN7Mx2oKzqd99xEijQru";

function denseSession(): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < 20; i++) out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `step-${i} ${DENSE.repeat(20)}` });
  out.push({ role: "user", content: "final question" });
  return out;
}

const THRESHOLD = 10_000;

type MockConfig = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;

function mockModel(): { model: MockLanguageModelV4; calls: () => number } {
  let calls = 0;
  const doGenerate: MockConfig["doGenerate"] = async () => {
    calls++;
    return {
      content: [{ type: "text" as const, text: "SUMMARY: the earlier conversation, condensed." }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 12, text: 12, reasoning: undefined },
      },
      warnings: [],
    };
  };
  return { model: new MockLanguageModelV4({ doGenerate }), calls: () => calls };
}

{
  const messages = denseSession();
  const estimated = estimateTokens(messages);
  const config: CompactionConfig = {
    lastKnownInputTokens: 30_000,
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 4,
    threshold: THRESHOLD,
  };

  ok(estimated + OVERHEAD <= THRESHOLD, "premise: the JSON.stringify/4 heuristic reads the fixture as WITHIN the threshold");
  ok(
    compaction.getInputTokenCount(messages, config) + OVERHEAD > THRESHOLD,
    "premise: the reported input-token count reads the same fixture as OVER the threshold",
  );
  ok(compaction.shouldCompact(messages, config), "premise: eve therefore decides to compact");
}

{
  const messages = denseSession();
  const before = messages.map((m) => ({ ...m }));
  const config: CompactionConfig = {
    lastKnownInputTokens: 30_000,
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 4,
    threshold: THRESHOLD,
  };
  const { model, calls } = mockModel();
  const after = await compaction.compactMessages(messages, model, config);

  ok(after.length < before.length, `reduces: the message list shrank (${before.length} → ${after.length})`);
  ok(
    JSON.stringify(after).length < JSON.stringify(before).length,
    "reduces: the serialized transcript shrank too, not only the message count",
  );
  ok(calls() >= 1, `reduces: the compaction model was actually called (${calls()} call(s)) — a summary really happened`);
  ok(
    after.some((m) => m.role === "user" && m.content === promptModule.COMPACTION_CHECKPOINT_MARKER),
    "reduces: the result opens with eve's checkpoint marker, so it is a real compaction result",
  );
  ok(
    after.some((m) => typeof m.content === "string" && m.content.includes("SUMMARY: the earlier conversation, condensed.")),
    "reduces: the summary the model produced is in the result",
  );
  ok(
    JSON.stringify(after) !== JSON.stringify(before),
    "not-a-no-op: compactMessages did NOT return the input list unchanged (the OPE-689 defect shape)",
  );
}

{
  const messages: Msg[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "how are you" },
    { role: "assistant", content: "fine" },
    { role: "user", content: "thanks" },
    { role: "user", content: "one more thing" },
  ];
  const before = JSON.stringify(messages);
  const estimated = estimateTokens(messages);
  const config: CompactionConfig = {
    lastKnownInputTokens: Math.round(estimated * 1.2),
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 4,
    threshold: THRESHOLD,
  };
  ok(!compaction.shouldCompact(messages, config), "fast-path: eve would not compact this session at all");

  const { model, calls } = mockModel();
  const after = await compaction.compactMessages(messages, model, config);
  ok(calls() === 0, "fast-path: NO model call — the correction did not turn every compaction into a summary");
  ok(JSON.stringify(after) === before, "fast-path: the message list is returned untouched when it genuinely fits");
}

{
  const messages: Msg[] = [];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read", input: {} }] });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${i}`,
          toolName: "read",
          output: { type: "text", value: DENSE.repeat(200) },
        },
      ],
    });
  }
  messages.push({ role: "user", content: "what did you find" });

  const estimated = estimateTokens(messages);
  const config: CompactionConfig = {
    lastKnownInputTokens: Math.round(estimated * 1.25),
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 2,
    threshold: 20_000,
  };
  ok(estimated > config.threshold, "tool-cap: the raw transcript is over the threshold on the heuristic alone");
  ok(compaction.shouldCompact(messages, config), "tool-cap: eve decides to compact");

  const before = JSON.stringify(messages);
  const { model, calls } = mockModel();
  const after = await compaction.compactMessages(messages, model, config);
  ok(calls() === 0, "tool-cap: no model call — capping oversized tool results was enough");
  ok(JSON.stringify(after).length < before.length, "tool-cap: the transcript really shrank (tool payloads were capped)");
  ok(
    JSON.stringify(after).includes("Truncated by eve"),
    `tool-cap: oversized tool results were capped at the ${promptModule.TRANSCRIPT_PAYLOAD_LIMIT}-character payload limit`,
  );
}

{
  const messages = denseSession();
  const config: CompactionConfig = { recentWindowSize: 4, threshold: THRESHOLD };
  ok(
    compaction.shouldCompact(messages, config) === false,
    "no-usage: with no reported input-token count eve cannot see the overrun at all — the hunk keys on the " +
      "provider's figure and can only correct a session that has already reported one",
  );
}

console.log(`\n✓ eve-compaction-density: ${n} assertions passed (presence, wiring, premise, reduces, fast-path, tool-cap, no-usage)\n`);
