import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  turnBackstopModel,
  withWrapUpNotice,
  wrapUpNotice,
} = await import("../agent/model/step-boundary.js");
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

function turnCtx(turnId: string, channel = "C_TXN", sessionId?: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      turn: { id: turnId },
      ...(sessionId !== undefined ? { sessionId } : {}),
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

function unroutableTurnCtx(turnId: string): BindableContext {
  return { session: { turn: { id: turnId } } } as unknown as BindableContext;
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
  const ctx = turnCtx("turn-count-A");
  const tiers: string[] = [];
  const crossings: number[] = [];
  for (let i = 0; i < 8; i++) {
    const d = noteTurnStep(ctx);
    tiers.push(d.tier);
    if (d.crossed) crossings.push(d.count);
  }
  eq(tiers, ["none", "none", "none", "soft", "soft", "soft", "hard", "hard"], "count: eight round-trips walk none×3 → soft×3 → hard, on a budget of 3 and a backstop of 6");
  eq(crossings, [4, 7], "count: `crossed` fires ONCE per tier edge (calls 4 and 7) — a 400-step turn writes two records, not four hundred");

  const other = noteTurnStep(turnCtx("turn-count-B"));
  eq(other.tier, "none", "isolation: a different turn id starts its own count at 1");
  eq(other.count, 1, "isolation: …and that count is 1, not the other turn's 9");

  clearTurnStepCount(undefined, "turn-count-A");
  eq(noteTurnStep(ctx).count, 1, "count: clearTurnStepCount drops a turn's counter (the stopped-turn cleanup path)");

  const noTurn = noteTurnStep({ session: { auth: {} } } as unknown as BindableContext);
  eq(noTurn.tier, "none", "count: a ctx with no turn id is INERT — nothing to key a counter on, so the boundary can never trip (patch parity)");
  eq(noTurn.count, 0, "count: …and nothing is counted for it");
  ok(MAX_TRACKED_TURNS >= 128, "count: the tracked-turn map is LRU-bounded in place of the terminal-decision clear the patched loop had");
  resetSettingsForTest();
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(3, 2);
  const sessionA = turnCtx("turn_0", "C_TXN", "sess-A");
  const sessionB = turnCtx("turn_0", "C_TXN", "sess-B");

  const tiersA: string[] = [];
  const tiersB: string[] = [];
  for (let i = 0; i < 4; i++) {
    tiersA.push(noteTurnStep(sessionA).tier);
    tiersB.push(noteTurnStep(sessionB).tier);
  }
  eq(tiersA, ["none", "none", "none", "soft"], "session-scope: session A's four round-trips on turn_0 walk its OWN tiers (budget 3) — unaffected by B's identical turn id");
  eq(tiersB, ["none", "none", "none", "soft"], "session-scope: session B, ALSO on turn_0, gets the identical independent sequence — proof the two are not sharing one counter");

  const again = noteTurnStep(sessionA);
  eq(again.count, 5, "session-scope: session A's count keeps advancing from its own 4, not from a combined 8");
  eq(again.sessionId, "sess-A", "session-scope: the decision carries the session id the count was keyed on");
  eq(again.turnId, "turn_0", "session-scope: …and the (colliding) turn id, for forensic readability alongside sessionId");

  clearTurnStepCount("sess-A", "turn_0");
  eq(noteTurnStep(sessionA).count, 1, "session-scope: clearTurnStepCount(sessionId, turnId) drops exactly A's counter…");
  eq(noteTurnStep(sessionB).count, 5, "session-scope: …and leaves B's counter (still at 4 from the interleave) untouched, proving they were never the same map entry");
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
  const ctx = turnCtx("turn-soft");

  for (let i = 0; i < 3; i++) await resolvePrimaryModel(ctx, DEFAULTS, deps);
  eq(calls.length, 0, "soft: resolving a model does not itself call one");

  const m = await resolvePrimaryModel(ctx, DEFAULTS, deps);
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
  const ctx = turnCtx("turn-hard");
  for (let i = 0; i < 6; i++) await resolvePrimaryModel(ctx, DEFAULTS, deps);
  const m = await resolvePrimaryModel(ctx, DEFAULTS, deps);
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
  const ctx = unroutableTurnCtx("turn-bypass");

  const plain = await resolvePrimaryModel(ctx, DEFAULTS, deps);
  eq(plain, null, "bypass: an unroutable ctx returns null below the budget — plain routing behaviour, unchanged");
  await resolvePrimaryModel(ctx, DEFAULTS, deps);

  const soft = await resolvePrimaryModel(ctx, DEFAULTS, deps);
  ok(soft !== null, "🔴 bypass: past the budget the SAME unroutable ctx gets a model instead of null — the static-fallback path cannot dodge the wrap-up notice");
  await soft!.doGenerate({ prompt: [] });
  const sentPrompt = calls[0]!.options["prompt"] as { content: { text: string }[] }[];
  ok(sentPrompt[0]!.content[0]!.text.startsWith(STEP_BOUNDARY_MARKER), "bypass: …and the notice really is on the call");
  eq(calls[0]!.id, DEFAULT_ID, "bypass: the wrapper is built over the DEFAULT id — exactly the model eve's static fallback would have run");

  await resolvePrimaryModel(ctx, DEFAULTS, deps);
  const hard = await resolvePrimaryModel(ctx, DEFAULTS, deps);
  const before = calls.length;
  const res = (await hard!.doGenerate({ prompt: [] })) as { content: { text: string }[] };
  eq(calls.length, before, "🔴 bypass: the hard backstop applies to the unroutable path too, and still makes no call");
  ok(res.content[0]!.text.includes("stopped by the harness"), "bypass: …with the same legible reply");
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(0);
  const ctx = turnCtx("turn-off");
  let tripped = false;
  for (let i = 0; i < 1000; i++) if (noteTurnStep(ctx).tier !== "none") tripped = true;
  ok(!tripped, "disabled: with `turn.stepBudget` at 0, a thousand round-trips never trip either tier (strict off)");
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(turnCtx("turn-off-2"), DEFAULTS, { domains: () => [], backend: fakeBackend(calls) });
  eq(m, null, "disabled: …and the resolver's return is byte-identical to plain routing (null → eve's static fallback)");
  resetSettingsForTest();
}

{
  _resetStepBoundaryCountsForTest();
  smallSettings(2, 2);
  const deps = { domains: () => [], backend: fakeBackend([]) };
  const ctx = turnCtx("turn-audit", "C_AUDIT");
  for (let i = 0; i < 8; i++) await resolvePrimaryModel(ctx, DEFAULTS, deps);

  const mine = (all: { detail?: Record<string, unknown> }[]): typeof rows => all.filter((r) => r.detail?.["turnId"] === "turn-audit") as typeof rows;
  let rows: { action: string; detail?: Record<string, unknown> }[] = [];
  for (let i = 0; i < 40 && rows.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 50));
    rows = mine((await readAudit({ action: STEP_BOUNDARY_ACTION })) as typeof rows);
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
  const src = readFileSync(join(eveRoot, "dist/src/harness/tool-loop.js"), "utf8");
  ok(src.includes("__oeProjectToolSet"), "retired: hunk 2 (OPE-73 untrusted projection) is UNTOUCHED and still in the installed bytes — it has no userland equivalent and must never be removed with the ceiling");
  for (const dead of ["__oeCeil", "__oeCeilTrip", "__oeCeilClear", "__oeCeilStop", "__oeCONT", "__oeStepCounts", "OE_TURN_STEP_CEILING"]) {
    ok(!src.includes(dead), `retired: the installed bytes must NOT contain \`${dead}\` — the step ceiling left the patch in OPE-407 and lives in agent/model/step-boundary.ts. A re-roll that ports the old __oe* block wholesale drags it back; port ONLY the projection helper`);
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ step-boundary: ${n} assertions passed (tier classification, settings limits, per-turn counting, prompt notice, soft wrap, hard stub, unroutable-path bypass fence, disabled-off, audit rows, ceiling retired from the patch)\n`);
