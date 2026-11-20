import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-step-boundary-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { registerSettings, resetSettingsForTest, getSettings } = await import("../agent/settings/settings.js");
const { resolvePrimaryModel } = await import("../agent/model/routing.js");
const {
  STEP_BOUNDARY_ACTION,
  STEP_BOUNDARY_MARKER,
  MAX_TRACKED_TURNS,
  _resetStepBoundaryCountsForTest,
  appendHarnessNotice,
  backstopReply,
  classifyStepCount,
  clearTurnStepCount,
  noteTurnStep,
  stepBoundaryLimits,
  stepCountKey,
  turnBackstopModel,
  withWrapUpNotice,
  wrapUpNotice,
} = await import("../agent/model/step-boundary.js");
const { EMPTY_TURN_STATE, deleteTurnState, parseTurnState, readTurnState, writeTurnState } = await import("../agent/model/turn-state.js");
const { sqliteOperationalStore } = await import("../agent/operational/sqlite.js");
const { registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
type BindableContext = import("../agent/identity/binding.js").BindableContext;
type ModelBackend = import("../agent/model/routing.js").ModelBackend;
type RoutedCallOptions = import("../agent/model/routing.js").RoutedCallOptions;

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepEqual(a, b);
  n++;
};

interface FakeCall {
  id: string;
  options: RoutedCallOptions;
}

function fakeBackend(calls: FakeCall[]): ModelBackend {
  return {
    model: (id) => ({
      specificationVersion: "v4",
      provider: "fake",
      modelId: id,
      supportedUrls: {},
      doGenerate: async (options: RoutedCallOptions) => {
        calls.push({ id, options });
        return { ok: true };
      },
      doStream: async (options: RoutedCallOptions) => {
        calls.push({ id, options });
        return { ok: true };
      },
    }),
    applyOptions: (_route, options) => options,
  };
}

const DEFAULT_ID = "vendor/default-model";
const DEFAULTS = { primary: { id: DEFAULT_ID }, utility: { id: "vendor/utility-model" } };

function turnCtx(sessionId?: string, channel = "C_TXN"): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      id: sessionId ?? "",
      auth: {
        current: {
          attributes: { team_id: "T1", channel_id: channel, channel_type: "channel", is_private: "false", trust_checked: "true" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  } as unknown as BindableContext;
}

// The model resolver's event argument. `noteTurnStep` reads only `data.turnId` from it, and only when
// the context has no turn id.
function stepEvent(turnId?: string): unknown {
  return { data: { turnId } };
}

function unroutableTurnCtx(sessionId?: string): BindableContext {
  return { session: { id: sessionId ?? "" } } as unknown as BindableContext;
}

const smallSettings = (budget: number, multiple = 2): void => {
  registerSettings({ turn: { stepBudget: budget, stepBackstopMultiple: multiple } });
};

{
  eq(classifyStepCount(1_000_000, 0, 0), "none", "classify: budget 0 disables the boundary entirely (the old `=0` semantics, preserved)");
  eq(classifyStepCount(3, 3, 6), "none", "classify: the first N calls are free (count == budget is still none)");
  eq(classifyStepCount(4, 3, 6), "soft", "classify: call budget+1 is the FIRST soft one");
  eq(classifyStepCount(6, 3, 6), "soft", "classify: the soft band runs up to and including the backstop");
  eq(classifyStepCount(7, 3, 6), "hard", "classify: call backstop+1 is the FIRST hard one");
  eq(classifyStepCount(700, 3, 6), "hard", "classify: it stays hard forever after");
}

{
  resetSettingsForTest();
  const shipped = stepBoundaryLimits();
  eq(shipped, { budget: 120, backstop: 360 }, "limits: the SHIPPED opinion is 120 round-trips with a 3x backstop (360)");
  ok(getSettings().turn.stepBudget === 120, "limits: `turn.stepBudget` is a typed setting with no env mirror (OPE-408 env minimalism)");

  registerSettings({ turn: { stepBackstopMultiple: 0.5 } });
  eq(stepBoundaryLimits().backstop, 120, "limits: a multiple below 1 is CLAMPED to 1 — a backstop under the soft boundary would stop the turn before the model was ever asked to wrap up");

  registerSettings({ turn: { stepBudget: -5 } });
  eq(stepBoundaryLimits().budget, 0, "limits: a negative budget resolves to 0 (disabled), never a negative boundary");

  registerSettings({ turn: { stepBudget: 7.9 } });
  eq(stepBoundaryLimits().budget, 7, "limits: a fractional budget is floored");
  resetSettingsForTest();
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(3, 2);
  const ctx = turnCtx();
  const event = stepEvent("turn-count-A");
  const tiers: string[] = [];
  const crossings: number[] = [];
  for (let i = 0; i < 8; i++) {
    const d = await noteTurnStep(ctx, event);
    tiers.push(d.tier);
    if (d.crossed) crossings.push(d.count);
  }
  eq(tiers, ["none", "none", "none", "soft", "soft", "soft", "hard", "hard"], "count: eight round-trips walk none×3 → soft×3 → hard, on a budget of 3 and a backstop of 6");
  eq(crossings, [4, 7], "count: `crossed` fires ONCE per tier edge (calls 4 and 7) — a 400-step turn writes two records, not four hundred");

  const other = await noteTurnStep(turnCtx(), stepEvent("turn-count-B"));
  eq(other.tier, "none", "isolation: a different turn id starts its own count at 1");
  eq(other.count, 1, "isolation: …and that count is 1, not the other turn's 9");

  await clearTurnStepCount(undefined, "turn-count-A");
  eq((await noteTurnStep(ctx, event)).count, 1, "count: clearTurnStepCount drops a SESSIONLESS turn's counter, which is a CACHE-ONLY drop — `durableTurnKey` answers undefined for a bare `turn_N` (OPE-1551), so such a turn has no durable row for the clear to reach");

  const noTurn = await noteTurnStep({ session: { auth: {} } } as unknown as BindableContext);
  eq(noTurn.tier, "none", "count: a ctx with no turn id AND no event is INERT — nothing to key a counter on, so the boundary can never trip (patch parity)");
  eq(noTurn.count, 0, "count: …and nothing is counted for it");
  ok(MAX_TRACKED_TURNS >= 128, "count: the tracked-turn map is LRU-bounded in place of the terminal-decision clear the patched loop had");
  resetSettingsForTest();
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(3, 2);
  const sessionA = turnCtx("sess-A");
  const sessionB = turnCtx("sess-B");
  const turn0 = stepEvent("turn_0");

  const tiersA: string[] = [];
  const tiersB: string[] = [];
  for (let i = 0; i < 4; i++) {
    tiersA.push((await noteTurnStep(sessionA, turn0)).tier);
    tiersB.push((await noteTurnStep(sessionB, turn0)).tier);
  }
  eq(tiersA, ["none", "none", "none", "soft"], "session-scope: session A's four round-trips on turn_0 walk its OWN tiers (budget 3) — unaffected by B's identical turn id");
  eq(tiersB, ["none", "none", "none", "soft"], "session-scope: session B, ALSO on turn_0, gets the identical independent sequence — proof the two are not sharing one counter");

  const again = await noteTurnStep(sessionA, turn0);
  eq(again.count, 5, "session-scope: session A's count keeps advancing from its own 4, not from a combined 8");
  eq(again.sessionId, "sess-A", "session-scope: the decision carries the session id the count was keyed on");
  eq(again.turnId, "turn_0", "session-scope: …and the (colliding) turn id, for forensic readability alongside sessionId");

  await clearTurnStepCount("sess-A", "turn_0");
  eq((await noteTurnStep(sessionA, turn0)).count, 1, "session-scope: clearTurnStepCount(sessionId, turnId) drops exactly A's counter…");
  eq((await noteTurnStep(sessionB, turn0)).count, 5, "session-scope: …and leaves B's counter (still at 4 from the interleave) untouched, proving they were never the same map entry");
  resetSettingsForTest();
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(3, 2);
  const ctx = turnCtx("sess-resumed");
  const event = stepEvent("turn-resumed");
  const pair = stepCountKey("sess-resumed", "turn-resumed");
  await deleteTurnState(pair);

  const tiersA: string[] = [];
  for (let i = 0; i < 3; i++) tiersA.push((await noteTurnStep(ctx, event)).tier);
  eq(tiersA, ["none", "none", "none"], "instance-change/CONTROL: instance A's three round-trips all sit inside a budget of 3");
  eq((await readTurnState(pair))?.steps, 3, "instance-change: instance A's count reached the turn's DURABLE row, not only its process memory");

  _resetStepBoundaryCountsForTest();

  const resumed = await noteTurnStep(ctx, event);
  eq(resumed.count, 4, "instance-change: the cold instance CONTINUES the count at 4 — before OPE-1522 it restarted at 1 and the turn ran a second budget");
  eq(resumed.tier, "soft", "instance-change: …so the soft boundary fires on the round-trip that really is past the budget");
  ok(resumed.crossed === true, "instance-change: and that round-trip is the crossing, so the turn still writes exactly one audit row for the edge");

  await writeTurnState(pair, { steps: 1 });
  const stale = await noteTurnStep(ctx, event);
  eq(stale.count, 5, "instance-change: a STALE row loses at most a step — the count is max(cache, row) + 1, so a rewound row can never un-cross a boundary");
  eq(stale.tier, "soft", "instance-change: …and the turn stays past the soft boundary it already crossed");

  _resetStepBoundaryCountsForTest();
  await deleteTurnState(pair);
  eq((await noteTurnStep(ctx, event)).count, 1, "instance-change/CONTROL: with the durable row gone too, the count restarts at 1 — so the continuation above is carried by the row and by nothing else");
  resetSettingsForTest();
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(3, 2);
  const ctx = turnCtx("sess-unreadable");
  const event = stepEvent("turn-unreadable");
  const pair = stepCountKey("sess-unreadable", "turn-unreadable");
  await deleteTurnState(pair);

  eq(parseTurnState(null), EMPTY_TURN_STATE, "unreadable: no row at all is the EMPTY state — the first round-trip of every turn");
  eq(parseTurnState("{not json"), undefined, "unreadable: bytes that will not parse answer `undefined`, never an empty count");
  eq(parseTurnState("[1,2,3]"), undefined, "unreadable: …and so does a shape this build does not recognise — a richer row a newer build wrote during a rolling deploy must not be overwritten");

  for (let i = 0; i < 3; i++) await noteTurnStep(ctx, event);
  eq((await readTurnState(pair))?.steps, 3, "unreadable/CONTROL: the row really holds the turn's count before the store goes wrong");

  let readsFail = false;
  registerOperationalStore({
    ...sqliteOperationalStore,
    getTaskResult: async (org: string, key: string) => {
      if (readsFail) throw new Error("operational store unavailable");
      return sqliteOperationalStore.getTaskResult(org, key);
    },
  });
  resetOperationalStore();
  try {
    _resetStepBoundaryCountsForTest();
    readsFail = true;
    const blind = await noteTurnStep(ctx, event);
    eq(blind.count, 1, "unreadable: with no cache and no readable row the round-trip counts 1 — there is nothing else it could count");
    eq(blind.tier, "none", "unreadable: …and the boundary answers on that count, which is the fail-soft direction");
    readsFail = false;
    eq((await readTurnState(pair))?.steps, 3, "unreadable: 🔴 the ROW IS UNTOUCHED — a count computed from a read that failed is never written back over the real one");
  } finally {
    registerOperationalStore(sqliteOperationalStore);
    resetOperationalStore();
  }

  _resetStepBoundaryCountsForTest();
  eq((await noteTurnStep(ctx, event)).count, 4, "unreadable: the turn resumes at 4 once the store answers again — the outage cost a round-trip's bookkeeping, not the turn's count");
  resetSettingsForTest();
}

{
  const prompt = [
    { role: "system", content: "you are an agent" },
    { role: "user", content: [{ type: "text", text: "do the thing" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1" }] },
  ];
  const before = JSON.stringify(prompt);
  const out = appendHarnessNotice(prompt, "NOTICE") as unknown[];
  eq(JSON.stringify(prompt), before, "notice: the caller's prompt array is NOT mutated (a shared prompt would leak the notice into other calls)");
  eq(out.length, 4, "notice: exactly one message is appended");
  eq(out[3], { role: "user", content: [{ type: "text", text: "NOTICE" }] }, "notice: it is a trailing USER-role text message — cache-preserving (the system prefix is untouched) and accepted by every provider, including right after tool results");
  eq(appendHarnessNotice(undefined, "NOTICE"), undefined, "notice: an unrecognised prompt shape is returned UNTOUCHED — a shim must never break a model call");
  ok(wrapUpNotice({ tier: "soft", count: 4, budget: 3, backstop: 6, crossed: true }).startsWith(STEP_BOUNDARY_MARKER), "notice: the wrap-up text is marked as harness-authored so the model cannot mistake it for the person");
  ok(backstopReply({ tier: "hard", count: 7, budget: 3, backstop: 6, crossed: true }).includes("stopped by the harness"), "notice: the backstop reply SAYS what happened — the legible stop the patched bytes could never give");
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(3, 2);
  const calls: FakeCall[] = [];
  const deps = { domains: () => [], backend: fakeBackend(calls) };
  const ctx = turnCtx("sess-soft");
  const event = stepEvent("turn-soft");

  for (let i = 0; i < 3; i++) await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  eq(calls.length, 0, "soft: resolving a model does not itself call one");

  const m = await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  ok(m !== null, "soft: past the budget the resolver returns a MODEL, never null — the notice cannot be dodged by falling through to eve's static fallback");
  await m!.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  eq(calls.length, 1, "soft: the real underlying model IS called — the turn is not killed, it is nudged");
  eq(calls[0]!.id, DEFAULT_ID, "soft: …at the same model id routing would have used");
  const sent = calls[0]!.options["prompt"] as { role: string; content: { text: string }[] }[];
  eq(sent.length, 2, "soft: the notice rides the call as one appended message");
  ok(sent[1]!.content[0]!.text.startsWith(STEP_BOUNDARY_MARKER), "soft: …and it is the wrap-up notice");
  ok(sent[1]!.content[0]!.text.includes("END THE TURN"), "soft: the notice tells the model to conclude and yield, not that it has been cut off");
  ok(m!.modelId === DEFAULT_ID && m!.provider === "fake", "soft: the shim mirrors the inner model's identity, so the spend stamp / telemetry see the real model");
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(3, 2);
  const calls: FakeCall[] = [];
  const deps = { domains: () => [], backend: fakeBackend(calls) };
  const ctx = turnCtx("sess-hard");
  const event = stepEvent("turn-hard");
  for (let i = 0; i < 6; i++) await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  const m = await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  ok(m !== null, "hard: past the backstop the resolver returns the stub model");
  const res = (await m!.doGenerate({ prompt: [] })) as { content: { type: string; text: string }[]; finishReason: unknown };
  eq(calls.length, 0, "🔴 hard: the stub makes NO backend call at all — a runaway turn stops costing money the moment the backstop trips");
  eq(res.content.length, 1, "hard: the reply is one content part");
  eq(res.content[0]!.type, "text", "🔴 hard: TEXT ONLY — no tool call, which is what makes eve's own continue-decision end the turn (last message = assistant, nothing to continue for)");
  ok(res.content[0]!.text.includes(STEP_BOUNDARY_MARKER), "hard: the reply names itself as a harness stop");
  eq(res.finishReason, { unified: "stop", raw: "stop" }, "hard: it finishes with `stop`");
  const streamed = (await m!.doStream({ prompt: [] })) as { stream: ReadableStream<{ type: string; delta?: string }> };
  const parts: { type: string; delta?: string }[] = [];
  for await (const p of streamed.stream as unknown as AsyncIterable<{ type: string; delta?: string }>) parts.push(p);
  ok(parts.some((p) => p.type === "text-delta" && p.delta?.includes(STEP_BOUNDARY_MARKER) === true), "hard: the streaming path delivers the same reply");
  ok(parts.at(-1)?.type === "finish", "hard: …and terminates the stream properly");
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(2, 2);
  const calls: FakeCall[] = [];
  const deps = { domains: () => [], backend: fakeBackend(calls) };
  const ctx = unroutableTurnCtx("sess-bypass");
  const event = stepEvent("turn-bypass");

  const plain = await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  eq(plain.modelId, DEFAULT_ID, "bypass: an unroutable ctx returns the DEFAULT model below the budget — plain routing behaviour, unchanged (OPE-412: concretely, not null)");
  await plain.doGenerate({ prompt: [] });
  eq(calls[0]!.id, DEFAULT_ID, "bypass: …and it is a real callable model at the default id");
  eq((calls[0]!.options["prompt"] as unknown[]).length, 0, "bypass: …carrying NO wrap-up notice — below the budget the boundary injects nothing");
  calls.length = 0;
  await resolvePrimaryModel(ctx, DEFAULTS, deps, event);

  const soft = await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  ok(soft !== null, "🔴 bypass: past the budget the SAME unroutable ctx gets a model instead of null — the static-fallback path cannot dodge the wrap-up notice");
  await soft!.doGenerate({ prompt: [] });
  const sentPrompt = calls[0]!.options["prompt"] as { content: { text: string }[] }[];
  ok(sentPrompt[0]!.content[0]!.text.startsWith(STEP_BOUNDARY_MARKER), "bypass: …and the notice really is on the call");
  eq(calls[0]!.id, DEFAULT_ID, "bypass: the wrapper is built over the DEFAULT id — exactly the model eve's static fallback would have run");

  await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  const hard = await resolvePrimaryModel(ctx, DEFAULTS, deps, event);
  const before = calls.length;
  const res = (await hard!.doGenerate({ prompt: [] })) as { content: { text: string }[] };
  eq(calls.length, before, "🔴 bypass: the hard backstop applies to the unroutable path too, and still makes no call");
  ok(res.content[0]!.text.includes("stopped by the harness"), "bypass: …with the same legible reply");
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(0);
  const ctx = turnCtx("sess-off");
  const event = stepEvent("turn-off");
  let tripped = false;
  for (let i = 0; i < 1000; i++) if ((await noteTurnStep(ctx, event)).tier !== "none") tripped = true;
  ok(!tripped, "disabled: with `turn.stepBudget` at 0, a thousand round-trips never trip either tier (strict off)");
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(turnCtx("sess-off-2"), DEFAULTS, { domains: () => [], backend: fakeBackend(calls) }, stepEvent("turn-off-2"));
  eq(m.modelId, DEFAULT_ID, "disabled: …and the resolver's return is byte-identical to plain routing (the bare DEFAULT model — OPE-412 — with no boundary wrapper)");
  await m.doGenerate({ prompt: [] });
  eq((calls[0]!.options["prompt"] as unknown[]).length, 0, "disabled: …and nothing is injected into the call");
  resetSettingsForTest();
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(2, 2);
  const deps = { domains: () => [], backend: fakeBackend([]) };
  const ctx = turnCtx("sess-audit", "C_AUDIT");
  const event = stepEvent("turn-audit");
  for (let i = 0; i < 8; i++) await resolvePrimaryModel(ctx, DEFAULTS, deps, event);

  const mine = (all: { detail?: Record<string, unknown> }[]): typeof rows => all.filter((r) => r.detail?.["turnId"] === "turn-audit") as typeof rows;
  let rows: { action: string; detail?: Record<string, unknown> }[] = [];
  for (let i = 0; i < 40 && rows.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 50));
    rows = mine((await readAudit({ org: "default", action: STEP_BOUNDARY_ACTION })) as typeof rows);
  }
  eq(rows.length, 2, "audit: EIGHT round-trips past a budget of 2 write exactly TWO `turn.step_boundary` rows — one per crossing, not one per call");
  const tiers = rows.map((r) => r.detail?.["tier"]).sort();
  eq(tiers, ["hard", "soft"], "audit: one row for each tier");
  const soft = rows.find((r) => r.detail?.["tier"] === "soft");
  eq(soft?.detail?.["steps"], 3, "audit: the soft row records the round-trip that crossed the budget");
  eq(soft?.detail?.["budget"], 2, "audit: …the budget it crossed");
  eq(soft?.detail?.["backstop"], 4, "audit: …and the backstop still ahead of it");
  eq(soft?.detail?.["turnId"], "turn-audit", "audit: …keyed to the turn, so a spiral is attributable");
  resetSettingsForTest();
}

{
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  // eve 1.x ships no harness/tool-loop.js, so the retired ceiling is checked across every file the
  // committed eve patch targets: a re-roll that ports the old __oe* block wholesale lands in one of them.
  // The OPE-73 projection (patch part 1) is not carried onto 1.x; eve-install-integrity pins its absence.
  ok(!existsSync(join(eveRoot, "dist/src/harness/tool-loop.js")), "retired: eve 1.x ships no harness/tool-loop.js — a 0.x eve is installed if it is back, and this block must read it again");
  const patchFile = new URL(`../../../patches/eve+${JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")).version}.patch`, import.meta.url);
  const targets = [...readFileSync(patchFile, "utf8").matchAll(/^\+\+\+ b\/node_modules\/eve\/(\S+)$/gm)].map((m) => m[1]!);
  ok(targets.length > 0, "retired: the committed eve patch names at least one target — the scan below reads real bytes");
  const src = targets.map((rel) => readFileSync(join(eveRoot, rel), "utf8")).join("\n");
  for (const dead of ["__oeCeil", "__oeCeilTrip", "__oeCeilClear", "__oeCeilStop", "__oeCONT", "__oeStepCounts", "OE_TURN_STEP_CEILING"]) {
    ok(!src.includes(dead), `retired: the patched bytes must NOT contain \`${dead}\` — the step ceiling left the patch in OPE-407 and lives in agent/model/step-boundary.ts. A re-roll that ports the old __oe* block wholesale drags it back`);
  }
}

await removeTempDir(tmp);
console.log(`\n✓ step-boundary: ${n} assertions passed (tier classification, settings limits, per-turn counting, prompt notice, soft wrap, hard stub, unroutable-path bypass fence, disabled-off, audit rows, ceiling retired from the patch)\n`);

// proves: SET-058, SET-059
