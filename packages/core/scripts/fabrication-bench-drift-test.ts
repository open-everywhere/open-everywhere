import { strict as assert } from "node:assert";
import {
  BENCH_PROBES,
  BENCH_NOW,
  BENCH_WAKE_ID,
  BENCH_JUDGE_SYSTEM,
  benchJudgePrompt,
  benchMatchedTell,
  benchParseVerdict,
  renderEnvelope,
  benchEscapeXml,
  renderPlain,
  buildRequest,
  answerOf,
  BENCH_TOOLS,
  NEUTRAL_SYSTEM,
  MINIMAL_SYSTEM,
  AMBIENT_SYSTEM,
} from "./eval/fabrication-bench.js";

const noTime = (s: string): string => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIME>");
const noWakeId = (s: string): string => s.replace(/[0-9a-f]{8}-0000-4000-8000-\d{12}/g, "<WAKE>");

let checks = 0;
const check = (name: string, fn: () => void): void => { fn(); checks++; console.log(`  ok  ${name}`); };

console.log("fabrication-bench drift test (OPE-826)");

const harness = await (async () => {
  const saved = process.argv;
  process.argv = [saved[0], saved[1], "--mode", "warranted-ambient", "--shape", "self-follow-up", "--backscroll", "out"];
  try {
    return await import("./eval/first-turn-offline.js");
  } finally {
    process.argv = saved;
  }
})();

check("bench judge system prompt equals FABRICATION_JUDGE_SYSTEM", () => {
  assert.equal(BENCH_JUDGE_SYSTEM, harness.FABRICATION_JUDGE_SYSTEM);
});

check("bench judge user prompt equals fabricationJudgePrompt", () => {
  const f = { hidden: "H", visible: "V", trigger: "T", text: "X" };
  assert.equal(
    benchJudgePrompt(f),
    harness.fabricationJudgePrompt({ withheld: f.hidden, visiblePrior: f.visible, trigger: f.trigger, text: f.text }),
  );
  assert.equal(
    benchJudgePrompt({ ...f, visible: "" }),
    harness.fabricationJudgePrompt({ withheld: f.hidden, visiblePrior: "", trigger: f.trigger, text: f.text }),
  );
});

check("bench tell match agrees with matchedTell, including the negative", () => {
  const tells = ["payout", "working day"];
  assert.equal(benchMatchedTell("the PAYOUT cutoff", tells), harness.matchedTell("the PAYOUT cutoff", tells));
  assert.equal(benchMatchedTell("nothing relevant here", tells), harness.matchedTell("nothing relevant here", tells));
  assert.equal(benchMatchedTell("nothing relevant here", tells), null);
});

check("bench verdict parser agrees with parseJudgeVerdict, including the rejections", () => {
  for (const raw of [
    '{"verdict":"FABRICATION","why":"x"}',
    '{"verdict":"MISBOUND","why":"x"}',
    '{"verdict":"HONEST","why":"x"}',
    '{"verdict":"MAYBE"}',
    "no json at all",
    "{not json}",
  ]) assert.equal(benchParseVerdict(raw), harness.parseJudgeVerdict(raw), `parse disagreed on ${raw}`);
  assert.equal(benchParseVerdict("no json at all"), null);
});

check("bench probes are the self-follow-up entries of WARRANTED_PROBES, in order and byte-exact", () => {
  const selfFollow = harness.WARRANTED_PROBES.filter((w) => w.shape === "self-follow-up");
  assert.equal(BENCH_PROBES.length, selfFollow.length, "the pool sizes differ — an entry was added or removed on one side");
  for (const [i, b] of BENCH_PROBES.entries()) {
    const w = selfFollow[i];
    assert.equal(b.hidden, w.selfPrior, `probe ${i}: hidden post differs from selfPrior`);
    assert.equal(b.decoy, w.selfDecoy, `probe ${i}: decoy differs from selfDecoy`);
    assert.equal(b.trigger, w.body, `probe ${i}: trigger differs from body`);
    assert.deepEqual([...b.tells], [...(w.withheldTells ?? [])], `probe ${i}: tells differ from withheldTells`);
  }
});

check("every tell is absent from what the model CAN see — otherwise stage 1 would fire on a derivable phrase", () => {
  for (const b of BENCH_PROBES) {
    for (const t of b.tells) {
      assert.equal(benchMatchedTell(b.decoy, [t]), null, `tell "${t}" appears in the decoy the model can see`);
      assert.equal(benchMatchedTell(b.trigger, [t]), null, `tell "${t}" appears in the trigger the model can see`);
    }
  }
});

const rendered = [0, 1, 2].map((i) => harness.buildProbe(i).userMessage);

check("the harness import really is the OUT arm — otherwise every comparison below is vacuous", () => {
  assert.equal(rendered[0].includes(BENCH_PROBES[0].decoy), true, "the harness render is missing the decoy — this is not the OUT arm");
  assert.equal(rendered[0].includes(BENCH_PROBES[0].hidden), false, "the harness render carries the hidden post — this is the IN arm, not the OUT arm");
});

check("probe 0's envelope is byte-identical to the product render (timestamps aside)", () => {
  assert.equal(noTime(renderEnvelope(BENCH_PROBES[0])), noTime(rendered[0]));
});

check("probes 1 and 2 match too, once the index-derived wake id is normalised", () => {
  for (const i of [1, 2]) {
    assert.equal(noWakeId(noTime(renderEnvelope(BENCH_PROBES[i]))), noWakeId(noTime(rendered[i])), `probe ${i} envelope differs`);
  }
});

check("the hidden post is NOT in any rendered envelope — the arm must actually hide it", () => {
  for (const [i, b] of BENCH_PROBES.entries()) {
    assert.equal(renderEnvelope(b).includes(b.hidden), false, `probe ${i}: the envelope leaks the hidden post`);
    assert.equal(renderEnvelope(b).includes(benchEscapeXml(b.hidden)), false, `probe ${i}: the envelope leaks the hidden post in escaped form`);
    assert.equal(renderEnvelope(b).includes(benchEscapeXml(b.decoy)), true, `probe ${i}: the envelope dropped the decoy`);
  }
});

check("the envelope escapes bodies, so an apostrophe reaches the model as &apos;", () => {
  const withQuote = BENCH_PROBES.find((b) => b.trigger.includes("'"));
  assert.notEqual(withQuote, undefined, "no probe carries an apostrophe — this check would be vacuous");
  assert.equal(renderEnvelope(withQuote!).includes("&apos;"), true, "the envelope did not escape the apostrophe");
  assert.equal(renderEnvelope(withQuote!).includes(withQuote!.trigger), false, "the raw unescaped trigger is still in the envelope");
  assert.equal(renderPlain(withQuote!).includes("&apos;"), false, "the plain render escaped, which would erase the L0→L1 difference");
});

check("the plain render carries the same facts and none of the envelope's structure", () => {
  for (const b of BENCH_PROBES) {
    const plain = renderPlain(b);
    assert.equal(plain.includes(b.hidden), false, "the plain render leaks the hidden post");
    assert.equal(plain.includes(b.decoy), true, "the plain render dropped the decoy");
    assert.equal(plain.includes(b.trigger), true, "the plain render dropped the trigger");
    assert.equal(plain.includes("<wake"), false, "the plain render carries envelope XML");
    assert.equal(plain.includes("untrusted_external_data"), false, "the plain render carries the fence");
  }
});

check("reasoning_effort is sent to openai routes and withheld from the rest", () => {
  const openai = buildRequest({ model: "openai/gpt-5.6-luna", system: "s", user: "u", withTools: false, effort: "high" });
  const anthropic = buildRequest({ model: "anthropic/claude-sonnet-5", system: "s", user: "u", withTools: false, effort: "high" });
  assert.equal(openai.reasoning_effort, "high");
  assert.equal(anthropic.reasoning_effort, undefined);
});

check("the tools knob is what mounts the verbs, and it mounts exactly two", () => {
  assert.equal(buildRequest({ model: "openai/x", system: "s", user: "u", withTools: false, effort: "high" }).tools, undefined);
  assert.equal(buildRequest({ model: "openai/x", system: "s", user: "u", withTools: true, effort: "high" }).tools, BENCH_TOOLS);
  assert.deepEqual(BENCH_TOOLS.map((t) => t.function.name), ["reply", "no_reply"]);
});

check("answerOf reads the reply tool call, then prose, then nothing", () => {
  const viaTool = answerOf({ tool_calls: [{ function: { name: "reply", arguments: JSON.stringify({ text: "hello" }) } }], content: "ignored" });
  assert.deepEqual(viaTool, { text: "hello", route: "reply" });
  assert.deepEqual(answerOf({ content: "just prose" }), { text: "just prose", route: "prose" });
  assert.deepEqual(answerOf({ content: "" }), { text: "", route: "none" });
  assert.deepEqual(answerOf({ tool_calls: [{ function: { name: "no_reply", arguments: "{}" } }], content: "" }), { text: "", route: "none" });
});

check("the neutral baseline carries NO epistemic rule, and minimal adds exactly one", () => {
  for (const forbidden of ["cannot see", "say that you cannot", "only from what you can see"]) {
    assert.equal(NEUTRAL_SYSTEM.toLowerCase().includes(forbidden), false, `the neutral baseline already carries "${forbidden}"`);
  }
  assert.equal(MINIMAL_SYSTEM.startsWith(NEUTRAL_SYSTEM), true, "minimal must be the baseline plus the rule, not a different prompt");
  assert.equal(MINIMAL_SYSTEM.toLowerCase().includes("cannot see"), true, "minimal lost its epistemic rule");
});

check("the ambient arm keeps the epistemics clause and names no tool it does not mount", () => {
  assert.equal(AMBIENT_SYSTEM.includes("Base each claim on something you checked. Say whether you know it, infer it or guess it."), true);
  for (const absent of ["fetch_thread", "fetch_channel", "start_thread_session", "list_thread_sessions", "send_message", "no_reply_needed"]) {
    assert.equal(AMBIENT_SYSTEM.includes(absent), false, `the ambient arm names "${absent}", which this bench does not mount`);
  }
  assert.equal(AMBIENT_SYSTEM.includes("no_reply"), true, "the ambient arm lost the silence verb");
});

check("BENCH_NOW and BENCH_WAKE_ID are what the envelope actually renders", () => {
  const e = renderEnvelope(BENCH_PROBES[0]);
  assert.equal(e.includes(`current-time="${BENCH_NOW}"`), true);
  assert.equal(e.includes(`wake-id="${BENCH_WAKE_ID}"`), true);
});

console.log(`\nfabrication-bench drift test: ${checks} checks passed`);
