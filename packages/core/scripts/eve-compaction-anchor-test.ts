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

const ANCHORED_CONFIG_DEF =
  "function __oeAnchoredConfig(e,t){let n=getInputTokenCount(e,t)-estimateTokens(e);return n>0?{...t,threshold:t.threshold-n}:t}";
const NOOP_GUARD_DEF =
  'function __oeNoteNoOpCompaction(e,t,n,r){if(t!==e&&(t.length!==e.length||JSON.stringify(t)!==JSON.stringify(e)))return t;if(r!==!0&&!shouldCompact(e,n))return t;console.warn("[oe][OPE-689] compaction returned the input unchanged after the trigger fired ("+e.length+" messages, threshold "+n.threshold+"). The harness will emit compaction.completed for a no-op and the session will not shrink.");return t}';

const src = readFileSync(compactionPath, "utf8");
ok(src.includes("=== OE PATCH HELPERS (OPE-689) ==="), "presence: the OPE-689 marker comment is in the installed bytes");
ok(src.includes(ANCHORED_CONFIG_DEF), "presence: the __oeAnchoredConfig helper is byte-exact in the installed bytes");
ok(src.includes(NOOP_GUARD_DEF), "presence: the __oeNoteNoOpCompaction backstop is byte-exact in the installed bytes");
const END = "// === END OE PATCH HELPERS ===";
ok(src.indexOf(ANCHORED_CONFIG_DEF) < src.indexOf(END), "presence: the helpers live inside the OE helper block");

ok(
  /\{config:__oeA,conversation:[A-Za-z_$]{1,2},older:/.test(src),
  "wiring: the anchored config is the one the compaction heuristics receive",
);
ok((src.match(/__oeAnchoredConfig\(/g) ?? []).length === 2, "wiring: exactly one call site (helper definition plus one invocation)");
ok((src.match(/__oeA[,)]/g) ?? []).length === 1, "wiring: the anchored config is read exactly once — nothing else re-budgets on it");
ok(
  /selectRecentWindowSize\([A-Za-z_$]{1,2},[A-Za-z_$]{1,2}\?\{\.\.\.i,recentWindowSize:1\}:i\)/.test(src),
  "wiring: selectRecentWindowSize still reads the original config — per-message budgeting keeps the estimator",
);
ok(
  src.includes("async function compactMessages(t,r,i,a,o,c,l,d=!1){return __oeNoteNoOpCompaction(t,await __oeCompactMessagesInner(t,r,i,a,o,c,l,d),i,d)}"),
  "wiring: the exported compactMessages delegates to the inner function through the no-op backstop",
);
ok(src.includes("export{compactMessages,"), "wiring: `compactMessages` is still the exported name, so every eve caller gets the wrapper");

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

  ok(estimated + OVERHEAD <= THRESHOLD, "premise: the JSON.stringify/4 estimate reads the fixture as WITHIN the threshold");
  ok(
    compaction.getInputTokenCount(messages, config) + OVERHEAD > THRESHOLD,
    "premise: the reported input-token count reads the same fixture as OVER the threshold",
  );
  ok(compaction.shouldCompact(messages, config), "premise: the trigger therefore fires");
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
  ok(!compaction.shouldCompact(messages, config), "fast-path: the trigger would not fire on this session at all");

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
  ok(estimated > config.threshold, "tool-cap: the raw transcript is over the threshold on the estimate alone");
  ok(compaction.shouldCompact(messages, config), "tool-cap: the trigger fires");

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
    "no-usage: with no reported input-token count the trigger cannot see the overrun at all — the hunk anchors on " +
      "the provider's figure and can only correct a session that has already reported one",
  );
}

{
  const anchoredConfig = new Function(
    "getInputTokenCount",
    "estimateTokens",
    `${ANCHORED_CONFIG_DEF}\nreturn __oeAnchoredConfig;`,
  )(compaction.getInputTokenCount, estimateTokens) as (messages: readonly Msg[], config: CompactionConfig) => CompactionConfig;

  const messages = denseSession();
  const estimated = estimateTokens(messages);
  const over: CompactionConfig = {
    lastKnownInputTokens: 30_000,
    lastKnownPromptMessageCount: messages.length,
    recentWindowSize: 4,
    threshold: THRESHOLD,
  };
  const anchored = anchoredConfig(messages, over);
  const gap = compaction.getInputTokenCount(messages, over) - estimated;
  ok(gap > 0, `anchor-drive: the fixture really has a real-minus-estimate gap (${gap} tokens)`);
  ok(
    anchored.threshold === THRESHOLD - gap,
    `anchor-drive: the threshold drops by exactly that gap (${THRESHOLD} → ${anchored.threshold})`,
  );
  ok(anchored.recentWindowSize === over.recentWindowSize, "anchor-drive: every other field is carried through unchanged");
  ok(anchored !== over, "anchor-drive: a COPY is returned — the session's own compaction config is never mutated");

  const none: CompactionConfig = { recentWindowSize: 4, threshold: THRESHOLD };
  ok(anchoredConfig(messages, none) === none, "anchor-drive: with no reported usage the config passes through untouched");
  const under: CompactionConfig = { ...over, lastKnownInputTokens: Math.round(estimated / 2) };
  ok(anchoredConfig(messages, under) === under, "anchor-drive: a reported count below the estimate never LOOSENS the budget");
}

{
  let triggerFires = true;
  const guard = new Function("shouldCompact", `${NOOP_GUARD_DEF}\nreturn __oeNoteNoOpCompaction;`)(
    () => triggerFires,
  ) as (before: Msg[], after: Msg[], config: CompactionConfig, force?: boolean) => Msg[];

  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warned.push(args.map(String).join(" "));
  };
  try {
    const config: CompactionConfig = { recentWindowSize: 4, threshold: THRESHOLD };
    const list: Msg[] = [{ role: "user", content: "a" }];

    warned.length = 0;
    ok(guard(list, list, config) === list, "guard-drive: the result is passed through unchanged (the backstop only observes)");
    ok(warned.length === 1, "guard-drive: an unchanged list after the trigger fired logs exactly one line");
    ok(warned[0].includes("OPE-689"), "guard-drive: the line names the defect, so a log search finds it");

    warned.length = 0;
    guard(list, [{ role: "user", content: "a" }], config);
    ok(warned.length === 1, "guard-drive: an equal-by-value copy counts as a no-op, not as work");

    warned.length = 0;
    guard(list, [], config);
    ok(warned.length === 0, "guard-drive: a list that really changed is silent");

    triggerFires = false;
    warned.length = 0;
    guard(list, list, config);
    ok(warned.length === 0, "guard-drive: an unchanged list is silent when the trigger would not have fired");

    warned.length = 0;
    guard(list, list, config, true);
    ok(warned.length === 1, "guard-drive: a FORCED compaction that changed nothing still logs");
  } finally {
    console.warn = realWarn;
  }
}
const toolLoopPath = join(eveRoot, "dist/src/harness/tool-loop.js");
const toolLoopSrc = readFileSync(toolLoopPath, "utf8");

const REDUCED_DEF =
  "function __oeCompactionReduced(e,t){return t!==e&&(t.length!==e.length||JSON.stringify(t)!==JSON.stringify(e))}";
const WITH_REDUCED_DEF = "function __oeWithReduced(e,t){return{...e,data:{...e.data,reduced:t}}}";

ok(toolLoopSrc.includes(REDUCED_DEF), "event-wiring: __oeCompactionReduced is byte-exact in the installed tool loop");
ok(toolLoopSrc.includes(WITH_REDUCED_DEF), "event-wiring: __oeWithReduced is byte-exact in the installed tool loop");
ok(
  toolLoopSrc.indexOf(REDUCED_DEF) < toolLoopSrc.indexOf(END),
  "event-wiring: the OPE-697 helpers live inside the OE helper block, not loose in eve's bytes",
);
ok(
  toolLoopSrc.includes(
    'function __oeProjectToolSet(ts){const h=globalThis.__oeToolResultProjection;if(typeof h==="function")h(ts);return ts}',
  ),
  "event-wiring: the OPE-73 untrusted-projection hook is still byte-exact beside the OPE-697 helpers",
);
ok(
  /__oeRed=__oeCompactionReduced\([A-Za-z_$]{1,2}\.messages,[A-Za-z_$]{1,2}=await compactMessages\(/.test(toolLoopSrc),
  "event-wiring: the flag is computed from the INPUT list at the compactMessages call site",
);
ok(
  /await [A-Za-z_$]{1,2}\(__oeWithReduced\(createCompactionCompletedEvent\(/.test(toolLoopSrc),
  "event-wiring: the emitted compaction.completed event is the stamped one",
);
ok(
  (toolLoopSrc.match(/createCompactionCompletedEvent\(/g) ?? []).length === 1,
  "event-wiring: there is exactly one compaction.completed emission, so no path can emit an unstamped event",
);
ok((toolLoopSrc.match(/__oeWithReduced\(/g) ?? []).length === 2, "event-wiring: one __oeWithReduced definition and one call site");

const isReduced = new Function(`${REDUCED_DEF}\nreturn __oeCompactionReduced;`)() as (
  before: readonly Msg[],
  after: readonly Msg[],
) => boolean;
{
  const list: Msg[] = [{ role: "user", content: "a" }];
  ok(isReduced(list, list) === false, "reduced-drive: the same array instance is NOT a reduction");
  ok(isReduced(list, [{ role: "user", content: "a" }]) === false, "reduced-drive: an equal-by-value copy is NOT a reduction");
  ok(isReduced(list, []) === true, "reduced-drive: a shorter list IS a reduction");
  ok(isReduced(list, [{ role: "user", content: "b" }]) === true, "reduced-drive: a same-length list with changed content IS a reduction");
}

const MC_START = "async function maybeCompact(";
const MC_END = "function resolveApprovalKeyFromTools(";
const mcStart = toolLoopSrc.indexOf(MC_START);
const mcEnd = toolLoopSrc.indexOf(MC_END);
ok(mcStart !== -1 && mcEnd > mcStart, "event-honesty: maybeCompact is extractable from the installed bytes by its unminified name");
const maybeCompactSrc = toolLoopSrc.slice(mcStart, mcEnd);
ok(
  (maybeCompactSrc.match(/async function maybeCompact\(/g) ?? []).length === 1,
  "event-honesty: the extracted slice holds exactly one maybeCompact definition",
);

const { createCompactionCompletedEvent, createCompactionRequestedEvent } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/protocol/message.js")).href
)) as unknown as {
  createCompactionCompletedEvent(input: { modelId: string; sequence: number; sessionId: string; turnId: string }): {
    data: Record<string, unknown>;
    type: string;
  };
  createCompactionRequestedEvent(input: Record<string, unknown>): { data: Record<string, unknown>; type: string };
};

const withReduced = new Function(`${WITH_REDUCED_DEF}\nreturn __oeWithReduced;`)() as (
  event: { data: Record<string, unknown>; type: string },
  reduced: boolean,
) => { data: Record<string, unknown>; type: string };

interface Emitted {
  data: Record<string, unknown>;
  type: string;
}
type WorkStep = (messages: Msg[]) => Msg[];

function driveMaybeCompact(work: WorkStep, onCompaction?: () => Msg[]): Promise<Emitted[]> {
  const events: Emitted[] = [];
  const factory = new Function(
    "shouldCompact",
    "resolveCompactionModel",
    "requireSessionModelReference",
    "createCompactionRequestedEvent",
    "createCompactionCompletedEvent",
    "formatLanguageModelGatewayId",
    "getInputTokenCount",
    "compactMessages",
    "buildGatewayAttributionHeaders",
    "__oeCompactionReduced",
    "__oeWithReduced",
    `${maybeCompactSrc}\nreturn maybeCompact;`,
  ) as (...deps: unknown[]) => (input: Record<string, unknown>) => Promise<{ messages: Msg[] }>;

  const maybeCompact = factory(
    () => true,
    async () => ({ model: { modelId: "stub" }, providerOptions: undefined }),
    () => ({ modelId: "stub" }),
    createCompactionRequestedEvent,
    createCompactionCompletedEvent,
    () => "stub/model",
    () => 999,
    async (messages: Msg[]) => work(messages),
    () => undefined,
    isReduced,
    withReduced,
  );

  return maybeCompact({
    emissionState: { sequence: 1, turnId: "turn-1" },
    emit: (event: Emitted) => {
      events.push(event);
    },
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
    model: { modelId: "stub" },
    onCompaction,
    resolveModel: async () => ({ modelId: "stub" }),
    session: {
      agent: {},
      compaction: { recentWindowSize: 2, threshold: THRESHOLD },
      sessionId: "s-1",
    },
  }).then(() => events);
}

function completedEvent(events: Emitted[]): Emitted {
  const found = events.find((e) => e.type === "compaction.completed");
  assert.ok(found, "no compaction.completed event was emitted at all");
  return found;
}

{
  const events = await driveMaybeCompact(() => [{ role: "user", content: "SUMMARY" }]);
  ok(events.some((e) => e.type === "compaction.requested"), "event-honesty: the requested event still fires (contract unchanged)");
  const completed = completedEvent(events);
  ok("reduced" in completed.data, "event-honesty: a real compaction carries the reduced field at all");
  ok(completed.data.reduced === true, "event-honesty: a real compaction reports reduced === true");
  ok(completed.data.sessionId === "s-1" && completed.data.turnId === "turn-1", "event-honesty: the stamp preserves the original payload");
  ok(completed.type === "compaction.completed", "event-honesty: the stamp does not change the event kind");
}
{
  const events = await driveMaybeCompact((messages) => messages);
  ok(events.some((e) => e.type === "compaction.requested"), "event-honesty: a no-op still emits requested — no suppression");
  ok(events.some((e) => e.type === "compaction.completed"), "event-honesty: a no-op still emits completed — no consumer can hang");
  const completed = completedEvent(events);
  ok("reduced" in completed.data, "event-honesty: a no-op carries the reduced field rather than omitting it");
  ok(completed.data.reduced === false, "event-honesty: a no-op reports reduced === false");
}
{
  const events = await driveMaybeCompact((messages) => messages.map((m) => ({ ...m })));
  ok(completedEvent(events).data.reduced === false, "event-honesty: an equal-by-value copy reports reduced === false");
}
{
  const events = await driveMaybeCompact(
    (messages) => messages.map((m) => ({ ...m })),
    () => [{ role: "assistant", content: "appended after compaction" }],
  );
  ok(
    completedEvent(events).data.reduced === false,
    "event-honesty: an equal-by-value no-op whose onCompaction() appended a message STILL reports reduced === false",
  );
}
{
  const events = await driveMaybeCompact(
    (messages) => messages,
    () => [{ role: "assistant", content: "appended after compaction" }],
  );
  ok(
    completedEvent(events).data.reduced === false,
    "event-honesty: an identity no-op whose onCompaction() appended a message STILL reports reduced === false",
  );
}
{
  const events = await driveMaybeCompact(
    () => [{ role: "user", content: "SUMMARY" }],
    () => [{ role: "assistant", content: "appended after compaction" }],
  );
  ok(completedEvent(events).data.reduced === true, "event-honesty: a real reduction with an appended message still reports true");
}

console.log(
  `\n✓ eve-compaction-anchor: ${n} assertions passed (presence, wiring, premise, reduces, fast-path, tool-cap, no-usage, ` +
    `anchor-drive, guard-drive, event-wiring, reduced-drive, event-honesty)\n`,
);
