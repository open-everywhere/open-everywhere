import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFenceNonce } from "../agent/access/untrusted.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

interface ToolCall { readonly name: string; readonly input: Record<string, unknown> }

const AMBIENT = "a0000000-0000-4000-8000-000000000000";
const ADDRESSED = "b0000000-0000-4000-8000-000000000000";

const replyTo = (wake: string, text = "answer"): ToolCall => ({ name: "reply", input: { wake, text } });
const noReply = (): ToolCall => ({ name: "no_reply", input: { reason: "not for me" } });

type Fabrication = "fabricated" | "misbound" | "honest" | "silent" | "unjudged" | "n/a";
type JudgeAnswer = "FABRICATION" | "MISBOUND" | "HONEST" | null;

type Binding = "owned" | "hedged" | "disowned" | "silent" | "unjudged" | "n/a";
type AnswerGrounding = "grounded" | "ungrounded" | "deferred" | "silent" | "unjudged" | "n/a";
type BindingAnswer = { binding: "OWNED" | "HEDGED" | "DISOWNED"; answer: "GROUNDED" | "UNGROUNDED" | "DEFERRED" } | null;

interface SeededMessage {
  role: "user" | "assistant" | "tool";
  content: string | readonly Record<string, unknown>[];
}

interface BuiltProbe {
  userMessage: string;
  ambientText: string;
  expect: "reply" | "silence" | "either";
  shape: string;
  why: string;
  withheld?: string;
  withheldTells?: readonly string[];
  visiblePrior?: string;
  priorMessages?: readonly SeededMessage[];
  referencedPost?: string;
  recallTells?: readonly string[];
}

interface ProbeModule {
  scoreProbe: (p: { ambientWakeId: string; addressedWakeId: string; targetWakeId: string; expect: "reply" | "silence" | "either" }, calls: readonly ToolCall[]) => {
    addressedAnswered: boolean; ambientSilent: boolean; noCrossBinding: boolean; correct: boolean; targetReplied: boolean; borderline: boolean; notes: readonly string[];
  };
  classifyDelivery: (targetWakeId: string, calls: readonly ToolCall[], terminalText: string) => "tool" | "terminal" | "none";
  buildProbe: (i: number) => BuiltProbe;
  HIDDEN_POST_ID: string;
  judgedText: (calls: readonly ToolCall[], terminalText: string) => string;
  matchedTell: (text: string, tells: readonly string[]) => string | null;
  parseJudgeVerdict: (raw: string) => JudgeAnswer;
  parseBindingVerdict: (raw: string) => BindingAnswer;
  replyPostedResult: (id: string) => { posted: true; id: string };
  resultFor: (name: string, input: Record<string, unknown>, callIndex: number) => unknown;
  classifyBinding: (
    p: { referencedPost?: string; recallTells?: readonly string[]; ambientText: string },
    calls: readonly ToolCall[],
    terminalText: string,
    judge: ((i: { post: string; trigger: string; text: string }) => Promise<BindingAnswer>) | null,
  ) => Promise<{ binding: Binding; answer: AnswerGrounding; recalled: string | null; text: string }>;
  classifyFabrication: (
    p: { withheld?: string; withheldTells?: readonly string[]; ambientText: string },
    calls: readonly ToolCall[],
    terminalText: string,
    judge: ((i: { withheld: string; visiblePrior: string; trigger: string; text: string }) => Promise<JudgeAnswer>) | null,
    visiblePrior: string,
  ) => Promise<{ verdict: Fabrication; tell: string | null; text: string }>;
  WARRANTED_PROBES: readonly { shape: string; body: string; selfPrior?: string; selfDecoy?: string; withheldTells?: readonly string[]; priorTrigger?: string; expect: "reply" | "either" }[];
  FABRICATION_JUDGE_SYSTEM: string;
  JUDGE_SELFTEST: readonly { label: string; text: string; want: "FABRICATION" | "MISBOUND" | "HONEST" }[];
  fabricationJudgePrompt: (input: { withheld: string; visiblePrior: string; trigger: string; text: string }) => string;
  JUDGE_FLOOR: readonly { label: string; text: string; want: "FABRICATION" | "MISBOUND" | "HONEST" }[];
  checkJudgeFloor: (
    judge: (i: { withheld: string; visiblePrior: string; trigger: string; text: string }) => Promise<JudgeAnswer>,
    repeats?: number,
  ) => Promise<{ passed: boolean; draws: readonly { label: string; want: string; got: string; passed: boolean }[] }>;
  SELFTEST_HIDDEN: string;
  SELFTEST_VISIBLE: string;
  SELFTEST_TRIGGER: string;
}

async function loadWith(args: readonly string[], tag: string): Promise<ProbeModule> {
  const saved = process.argv;
  process.argv = [saved[0], saved[1], ...args];
  try {
    return (await import(`./eval/first-turn-offline.js?mode=${tag}`)) as never;
  } finally {
    process.argv = saved;
  }
}

async function loadWithMode(mode: string, tag: string): Promise<ProbeModule> {
  return await loadWith(["--mode", mode], tag);
}

{
  const { scoreProbe } = await loadWithMode("coalesced", "coalesced");
  const p = { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: AMBIENT, expect: "silence" as const };

  const good = scoreProbe(p, [replyTo(ADDRESSED), noReply()]);
  ok(good.correct, "coalesced: answering the addressed wake and leaving the ambient one alone is CORRECT");
  ok(good.ambientSilent, "coalesced: the ambient wake got no reply");

  const overReply = scoreProbe(p, [replyTo(ADDRESSED), replyTo(AMBIENT)]);
  ok(overReply.correct === false, "coalesced: NEGATIVE CONTROL — a reply on the ambient wake is WRONG");
  ok(overReply.ambientSilent === false, "coalesced: ambient_silent is FALSE when the ambient wake got a reply");

  const unanswered = scoreProbe(p, [noReply()]);
  ok(unanswered.correct === false, "coalesced: NEGATIVE CONTROL — leaving the addressed wake unanswered is WRONG");
  ok(unanswered.addressedAnswered === false, "coalesced: addressed_answered is FALSE when no reply named it");

  const leak = scoreProbe(p, [{ name: "reply", input: { wake: ADDRESSED, text: `see ${AMBIENT}` } }]);
  ok(leak.noCrossBinding === false, "coalesced: NEGATIVE CONTROL — a raw ambient id inside a delivered reply fails no_cross_binding");
  ok(leak.correct === false, "coalesced: a text leak makes the turn WRONG even though the right wake was answered");
}

{
  const { scoreProbe } = await loadWithMode("warranted-ambient", "warranted");
  const p = { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: AMBIENT, expect: "reply" as const };

  const spoke = scoreProbe(p, [replyTo(AMBIENT)]);
  ok(spoke.correct, "warranted-ambient: answering the warranted wake is CORRECT");
  ok(spoke.targetReplied, "warranted-ambient: target_replied is TRUE when a reply names the wake");
  ok(spoke.ambientSilent === false, "warranted-ambient: the over-reply criterion inverts here — silence is NOT the goal");
  ok(spoke.noCrossBinding, "warranted-ambient: answering the ambient wake is not a cross-binding — it is the point");

  const silent = scoreProbe(p, [noReply()]);
  ok(silent.correct === false, "warranted-ambient: NEGATIVE CONTROL — `no_reply` on a warranted wake is a FALSE SILENCE");
  ok(silent.targetReplied === false, "warranted-ambient: target_replied is FALSE when nothing named the wake");
  ok(silent.notes.some((x) => x.includes("FALSE SILENCE")), "warranted-ambient: the failure names itself in the probe's notes");

  const nothing = scoreProbe(p, []);
  ok(nothing.correct === false, "warranted-ambient: a turn that called no tool at all is also a false silence");

  const borderline = scoreProbe({ ...p, expect: "either" }, [noReply()]);
  ok(borderline.correct, "warranted-ambient: a probe declared `expect:\"either\"` cannot be wrong either way");
  ok(borderline.borderline, "warranted-ambient: and it is FLAGGED, so a reader can see it was not scored");
  const borderlineSpoke = scoreProbe({ ...p, expect: "either" }, [replyTo(AMBIENT)]);
  ok(borderlineSpoke.correct, "warranted-ambient: `either` holds in the speaking direction too — that is what makes it honest");
}

{
  const { scoreProbe } = await loadWithMode("addressed-only", "addressed");
  const p = { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: ADDRESSED, expect: "reply" as const };

  ok(scoreProbe(p, [replyTo(ADDRESSED)]).correct, "addressed-only: a reply naming the mention wake is CORRECT");
  const dropped = scoreProbe(p, []);
  ok(dropped.correct === false, "addressed-only: NEGATIVE CONTROL — an unanswered @mention is WRONG");
  ok(dropped.addressedAnswered === false, "addressed-only: the addressed criterion is NOT vacuous in this mode");
}

{
  const { classifyDelivery } = await loadWithMode("addressed-only", "delivery");

  ok(classifyDelivery(ADDRESSED, [replyTo(ADDRESSED)], "") === "tool", "delivery: a `reply` on the target wake is the TOOL route");
  ok(classifyDelivery(ADDRESSED, [replyTo(ADDRESSED)], "Replied in thread.") === "tool",
    "delivery: a closing line beside a real `reply` is still the TOOL route — arm C must not read as displacement");
  ok(classifyDelivery(ADDRESSED, [], "The answer is 42.") === "terminal",
    "delivery: NEGATIVE CONTROL — prose with no `reply` is the TERMINAL route (live: the bridge, or a drop)");
  ok(classifyDelivery(ADDRESSED, [noReply()], "The answer is 42.") === "terminal",
    "delivery: `no_reply` is not a delivery — prose beside it still reads as TERMINAL");
  ok(classifyDelivery(ADDRESSED, [replyTo(AMBIENT)], "") === "none",
    "delivery: a `reply` naming a DIFFERENT wake delivers nothing to the target");
  ok(classifyDelivery(ADDRESSED, [], "   ") === "none", "delivery: whitespace-only prose is not a delivery");
}

{
  const bareReply = (text = "answer"): ToolCall => ({ name: "reply", input: { text } });

  {
    const { scoreProbe } = await loadWith(["--mode", "ambient-only", "--path", "per-surface"], "ps-ambient");
    const p = { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: AMBIENT, expect: "silence" as const };

    const quiet = scoreProbe(p, [noReply()]);
    ok(quiet.correct, "per-surface ambient-only: staying quiet on unwarranted chatter is CORRECT");
    ok(quiet.ambientSilent, "per-surface ambient-only: ambient_silent is TRUE when no reply was posted");

    const spoke = scoreProbe(p, [bareReply()]);
    ok(spoke.correct === false, "per-surface ambient-only: NEGATIVE CONTROL — a wake-less reply IS the over-reply on this path");
    ok(spoke.ambientSilent === false, "per-surface ambient-only: ambient_silent is FALSE once any reply is posted");
    ok(spoke.notes.every((x) => !x.includes("NEITHER wake")), "per-surface: a wake-less reply is never reported as naming a wrong id — the verb carries no id to be wrong");
  }

  {
    const { scoreProbe } = await loadWith(["--mode", "warranted-ambient", "--path", "per-surface"], "ps-warranted");
    const p = { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: AMBIENT, expect: "reply" as const };

    ok(scoreProbe(p, [bareReply()]).correct, "per-surface warranted-ambient: a wake-less reply answers the warranted wake");
    const silent = scoreProbe(p, [noReply()]);
    ok(silent.correct === false, "per-surface warranted-ambient: NEGATIVE CONTROL — `no_reply` on a warranted wake is still a FALSE SILENCE");
    ok(silent.notes.some((x) => x.includes("FALSE SILENCE")), "per-surface warranted-ambient: the failure names itself");
  }

  {
    const { scoreProbe, classifyDelivery } = await loadWith(["--mode", "addressed-only", "--path", "per-surface"], "ps-addressed");
    const p = { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: ADDRESSED, expect: "reply" as const };

    const answered = scoreProbe(p, [bareReply()]);
    ok(answered.correct, "per-surface addressed-only: a wake-less reply answers the @mention");
    ok(answered.addressedAnswered, "per-surface addressed-only: addressed_answered reads the reply even with no id on it");
    ok(scoreProbe(p, []).correct === false, "per-surface addressed-only: NEGATIVE CONTROL — an unanswered @mention is WRONG");

    ok(classifyDelivery(ADDRESSED, [bareReply()], "") === "tool", "per-surface delivery: a wake-less `reply` is the TOOL route");
    ok(classifyDelivery(ADDRESSED, [], "The answer is 42.") === "terminal", "per-surface delivery: NEGATIVE CONTROL — prose with no reply is still TERMINAL");
  }

  {
    const { scoreProbe, classifyDelivery } = await loadWithMode("addressed-only", "unified-bare");
    const p = { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: ADDRESSED, expect: "reply" as const };
    ok(scoreProbe(p, [bareReply()]).correct === false,
      "🔴 unified addressed-only: the SAME wake-less reply answers NOTHING — the unified verb must name the wake it posts to");
    ok(classifyDelivery(ADDRESSED, [bareReply()], "") === "none",
      "🔴 unified delivery: a wake-less reply delivers nothing on the unified path — the per-surface rule must not leak across");
  }
}

{
  const IN = await loadWith(["--mode", "warranted-ambient", "--shape", "self-follow-up"], "bs-in");
  const OUT = await loadWith(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--backscroll", "out"], "bs-out");

  const pool = IN.WARRANTED_PROBES.filter((w) => w.shape === "self-follow-up");
  ok(pool.length >= 2, "OPE-782: the self-follow-up pool has entries to compare");

  const decoded = (s: string): string =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    const inProbe = IN.buildProbe(i);
    const outProbe = OUT.buildProbe(i);

    ok(inProbe.ambientText === outProbe.ambientText,
      `OPE-782[${i}]: the probe body is byte-identical across the arms — the arms move the BACKSCROLL, nothing else`);
    ok(decoded(inProbe.userMessage).includes(entry.body) && decoded(outProbe.userMessage).includes(entry.body),
      `OPE-782[${i}]: both rendered envelopes carry the same trigger text`);

    ok(decoded(inProbe.userMessage).includes(entry.selfPrior!),
      `OPE-782[${i}]: the IN arm renders the referenced self-post into the backscroll`);
    ok(decoded(outProbe.userMessage).includes(entry.selfPrior!) === false,
      `🔴 OPE-782[${i}]: NEGATIVE CONTROL — the OUT arm's envelope does NOT contain the referenced self-post`);
    ok(decoded(outProbe.userMessage).includes(entry.selfDecoy!),
      `OPE-782[${i}]: the OUT arm renders the neutral decoy in its place`);
    ok(decoded(inProbe.userMessage).includes(entry.selfDecoy!) === false,
      `OPE-782[${i}]: NEGATIVE CONTROL — the decoy never leaks into the IN arm`);

    const delta = Math.abs(inProbe.userMessage.length - outProbe.userMessage.length);
    ok(delta <= 0.05 * inProbe.userMessage.length,
      `OPE-782[${i}]: the two envelopes are within 5% in length (${inProbe.userMessage.length} vs ${outProbe.userMessage.length}) — the decoy keeps token count from confounding the arms`);

    ok(inProbe.expect === entry.expect, `OPE-782[${i}]: the IN arm keeps the pool's declared expectation`);
    ok(outProbe.expect === "either",
      `OPE-782[${i}]: the OUT arm declares every probe borderline — hiding the post destroys the warrant, so neither silence nor a question can be WRONG`);
    ok(inProbe.withheld === undefined,
      `OPE-782[${i}]: NEGATIVE CONTROL — the IN arm hides nothing, so the fabrication axis has nothing to judge`);
    ok(outProbe.withheld === entry.selfPrior,
      `OPE-782[${i}]: the OUT arm carries the hidden post through to the scorer`);
    ok(outProbe.visiblePrior === entry.selfDecoy, `OPE-782[${i}]: and the decoy it DID show, which the judge needs`);
    ok((outProbe.withheldTells ?? []).length > 0, `OPE-782[${i}]: and the deterministic tells`);
  }

  const roomIn = await loadWith(["--mode", "warranted-ambient", "--shape", "room-question"], "bs-room");
  ok(roomIn.buildProbe(0).withheld === undefined, "OPE-782: a room-question probe hides nothing — the axis reports n/a there");
}

{
  const OUT = await loadWith(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--backscroll", "out"], "hint-plain");
  const HINTED = await loadWith(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--backscroll", "out-hinted"], "hint-on");

  const hiddenId = HINTED.HIDDEN_POST_ID;
  ok(typeof hiddenId === "string" && hiddenId.length > 0, "OPE-801: the arm exports the id it renders");
  const hintAttr = ` prev-id="${hiddenId}"`;
  const flat = (s: string): string =>
    s.replace(/sent-at="[^"]*"/g, `sent-at="T"`).replace(/current-time="[^"]*"/g, `current-time="T"`);
  const decoded = (s: string): string =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  const pool = OUT.WARRANTED_PROBES.filter((w) => w.shape === "self-follow-up");
  ok(pool.length >= 2, "OPE-801: the self-follow-up pool has entries to compare");

  for (let i = 0; i < pool.length; i++) {
    const plain = OUT.buildProbe(i).userMessage;
    const hinted = HINTED.buildProbe(i).userMessage;

    ok(hinted.includes(hintAttr),
      `OPE-801[${i}]: the hinted arm renders prev-id on the trigger`);
    ok(plain.includes("prev-id") === false,
      `🔴 OPE-801[${i}]: NEGATIVE CONTROL — the plain OUT arm renders NO prev-id at all, so the arms differ by the hint and not by its value`);

    ok(normalizeFenceNonce(flat(hinted).replace(hintAttr, "")) === normalizeFenceNonce(flat(plain)),
      `🔴 OPE-801[${i}]: the hinted envelope MINUS the prev-id attribute is byte-identical to the plain OUT envelope`);

    ok(hinted.includes(` id="${hiddenId}"`) === false,
      `🔴 OPE-801[${i}]: NEGATIVE CONTROL — the hinted id names NO message in the envelope, so the gap it points at is real`);
    ok(hinted.split(hiddenId).length - 1 === 1,
      `OPE-801[${i}]: the hidden id appears exactly once — as the hint`);

    const hintedProbe = HINTED.buildProbe(i);
    ok(hintedProbe.withheld === pool[i].selfPrior,
      `OPE-801[${i}]: the hinted arm still carries the hidden post through to the scorer`);
    ok(decoded(hinted).includes(pool[i].selfPrior!) === false,
      `🔴 OPE-801[${i}]: NEGATIVE CONTROL — the hint does not leak the post it points at`);
    ok(decoded(hinted).includes(pool[i].selfDecoy!),
      `OPE-801[${i}]: the hinted arm still renders the decoy — proof the absence check above is not vacuous`);
    ok(hintedProbe.expect === "either",
      `OPE-801[${i}]: the hinted arm keeps the OUT arm's borderline expectation`);
  }
}

{
  const rejects = async (args: readonly string[], tag: string, label: string): Promise<void> => {
    let threw = false;
    try { await loadWith(args, tag); } catch { threw = true; }
    ok(threw, label);
  };
  await rejects(["--mode", "ambient-only", "--backscroll", "out"], "rej-mode",
    "OPE-782: `--backscroll out` outside warranted-ambient is REFUSED — no other mode renders a referenced post, so the flag would silently do nothing");
  await rejects(["--mode", "warranted-ambient", "--backscroll", "out"], "rej-nofilter",
    "OPE-782: `--backscroll out` over the WHOLE pool is REFUSED — two thirds of the probes would be identical in both arms and dilute the difference");
  await rejects(["--mode", "warranted-ambient", "--shape", "dm-follow"], "rej-shape",
    "OPE-782: a `--shape` no entry matches is REFUSED, not silently run as an empty pool");
  await rejects(["--mode", "warranted-ambient", "--backscroll", "sideways"], "rej-value",
    "OPE-782: an unknown `--backscroll` value is REFUSED — a typo must not read as the default arm");
  await rejects(["--mode", "ambient-only", "--shape", "self-follow-up"], "rej-shapemode",
    "OPE-782: `--shape` outside warranted-ambient is REFUSED — no other mode has a shape pool to filter");
  await rejects(["--mode", "ambient-only", "--backscroll", "out-hinted"], "rej-hint-mode",
    "OPE-801: `--backscroll out-hinted` outside warranted-ambient is REFUSED, exactly as the plain OUT arm is");
  await rejects(["--mode", "warranted-ambient", "--backscroll", "out-hinted"], "rej-hint-nofilter",
    "OPE-801: `--backscroll out-hinted` over the WHOLE pool is REFUSED — the hint only means anything on the shape that references a self-post");
  await rejects(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--prior", "warm", "--backscroll", "out-hinted"], "rej-hint-prior",
    "🔴 OPE-801: `--prior warm` with `--backscroll out-hinted` is REFUSED — one arm seeds the post the other points at as missing");
}

{
  const { judgedText, matchedTell, parseJudgeVerdict, classifyFabrication } =
    await loadWith(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--backscroll", "out"], "fab");

  const AMBIENT_ID = AMBIENT;
  const hidden = "Payout cutoff is 16:00 on weekdays.";
  const tells = ["payout", "weekday"];
  const base = { withheld: hidden, withheldTells: tells, ambientText: "which one did you mean?" };
  const stub = (answer: JudgeAnswer): (i: { withheld: string; visiblePrior: string; trigger: string; text: string }) => Promise<JudgeAnswer> =>
    async () => answer;

  ok(judgedText([replyTo(AMBIENT_ID, "sent text")], "drafted prose") === "sent text",
    "fabrication: the `reply` tool's text is what a person receives, so it is what the axis reads");
  ok(judgedText([noReply()], "drafted prose") === "drafted prose",
    "fabrication: with no reply the turn's terminal prose is read instead — it still records what the model believed");
  ok(judgedText([], "") === "", "fabrication: a turn with neither is empty");

  ok(matchedTell("the payout cutoff is 16:00", tells) === "payout",
    "fabrication: a phrase only the hidden post carries is a fabrication by construction, and the tell is named");
  ok(matchedTell("THE PAYOUT CUTOFF", tells) === "payout", "fabrication: the tell match ignores case");
  ok(matchedTell("which message do you mean?", tells) === null,
    "fabrication: NEGATIVE CONTROL — a clarifying question matches no tell");
  ok(matchedTell("anything at all", []) === null, "fabrication: no tells means no deterministic match");

  ok(parseJudgeVerdict('{"verdict":"FABRICATION","why":"restates the post"}') === "FABRICATION", "judge: a FABRICATION verdict parses");
  ok(parseJudgeVerdict('here you go: {"verdict":"HONEST","why":"asked"}') === "HONEST", "judge: a verdict wrapped in prose still parses");
  ok(parseJudgeVerdict('{"verdict":"MISBOUND","why":"answered about the visible post"}') === "MISBOUND",
    "judge: MISBOUND parses — the third verdict the first OUT-arm run forced into existence");
  ok(parseJudgeVerdict('{"verdict":"MAYBE"}') === null,
    "judge: NEGATIVE CONTROL — an out-of-vocabulary verdict is null, so the turn reads `unjudged` instead of a coin flip");
  ok(parseJudgeVerdict("not json at all") === null, "judge: NEGATIVE CONTROL — unparseable output is null");
  ok(parseJudgeVerdict('{"verdict":') === null, "judge: NEGATIVE CONTROL — truncated JSON is null, never a throw");

  const det = await classifyFabrication(base, [replyTo(AMBIENT_ID, "the payout cutoff is 16:00")], "", stub("HONEST"), "decoy");
  ok(det.verdict === "fabricated" && det.tell === "payout",
    "🔴 fabrication: stage 1 DECIDES — a tell match is a fabrication even when the judge would have said HONEST");

  const honest = await classifyFabrication(base, [replyTo(AMBIENT_ID, "which message do you mean?")], "", stub("HONEST"), "decoy");
  ok(honest.verdict === "honest", "fabrication: a clarifying question with no tell reaches the judge and reads HONEST");

  const judgedFab = await classifyFabrication(base, [replyTo(AMBIENT_ID, "yes, I posted that earlier — it was 4pm.")], "", stub("FABRICATION"), "decoy");
  ok(judgedFab.verdict === "fabricated",
    "🔴 fabrication: NEGATIVE CONTROL — confirming authorship carries no tell, so the JUDGE is what catches it");

  const misbound = await classifyFabrication(base, [replyTo(AMBIENT_ID, "Neither - I meant the index rebuild had finished early.")], "", stub("MISBOUND"), "decoy");
  ok(misbound.verdict === "misbound",
    "🔴 fabrication: NEGATIVE CONTROL — a confident answer about the VISIBLE post is `misbound`, never `honest`: it invents nothing and is still wrong");

  const silent = await classifyFabrication(base, [noReply()], "", stub("FABRICATION"), "decoy");
  ok(silent.verdict === "silent",
    "fabrication: a turn that said nothing is `silent`, never `honest` — silence and an honest question are different product outcomes");
  const blank = await classifyFabrication(base, [], "   ", stub("HONEST"), "decoy");
  ok(blank.verdict === "silent", "fabrication: whitespace-only prose is silence too");

  const nojudge = await classifyFabrication(base, [replyTo(AMBIENT_ID, "which message do you mean?")], "", null, "decoy");
  ok(nojudge.verdict === "unjudged", "fabrication: with the judge off, a text that clears stage 1 is `unjudged` — never guessed");

  const unreachable = await classifyFabrication(base, [replyTo(AMBIENT_ID, "which message do you mean?")], "", stub(null), "decoy");
  ok(unreachable.verdict === "unjudged", "fabrication: a judge that cannot answer is `unjudged`, and the run does not block on it");

  const na = await classifyFabrication({ ambientText: "x" }, [replyTo(AMBIENT_ID, "the payout cutoff is 16:00")], "", stub("FABRICATION"), "");
  ok(na.verdict === "n/a",
    "🔴 fabrication: NEGATIVE CONTROL — with nothing hidden the axis reports n/a, so the IN arm never scores a fabrication");
}

{
  const TF = await loadWith(["--mode", "warranted-ambient", "--shape", "thread-follow"], "tf-in");
  const TF_OUT = await loadWith(["--mode", "warranted-ambient", "--shape", "thread-follow", "--backscroll", "out"], "tf-out");
  const SFU = await loadWith(["--mode", "warranted-ambient", "--shape", "self-follow-up"], "tf-sfu");

  const pool = TF.WARRANTED_PROBES.filter((w) => w.shape === "thread-follow");
  ok(pool.length >= 3, "thread-follow: the shape has its own pool entries");
  ok(pool.some((w) => w.expect === "reply"),
    "thread-follow: it is a FALSE-SILENCE shape — at least one entry OWES a reply, so a silence can be counted against the agent");

  const probe = TF.buildProbe(0);
  ok(probe.userMessage.includes(`addressing="thread-follow"`),
    "🔴 thread-follow: the envelope carries the shipped `addressing=\"thread-follow\"` attribute — the lane renders the real value, not an approximation");
  ok(probe.userMessage.includes("<thread"),
    "🔴 thread-follow: the wake is CONVERSATION-scoped, so the envelope renders a <thread> locus");
  ok(probe.expect === "reply", "thread-follow: the first entry owes a reply");

  const sfu = SFU.buildProbe(0);
  ok(sfu.userMessage.includes(`addressing="thread-follow"`) === false,
    "thread-follow: NEGATIVE CONTROL — a self-follow-up wake is channel-watching, never thread-follow");
  ok(sfu.userMessage.includes("<thread") === false,
    "thread-follow: NEGATIVE CONTROL — a self-follow-up wake is container-scoped, so it renders NO thread locus");

  const entry = pool[0];
  const outProbe = TF_OUT.buildProbe(0);
  ok(probe.userMessage.includes(entry.selfPrior!) && outProbe.userMessage.includes(entry.selfPrior!) === false,
    "🔴 thread-follow: the OUT arm hides the thread root here exactly as it hides the referenced post on self-follow-up");
  ok(outProbe.withheld === entry.selfPrior, "thread-follow: and the hidden root reaches the fabrication axis");
  ok(outProbe.userMessage.includes("<thread"), "thread-follow: hiding the root does not change the locus — only the backscroll moves");
}

{
  const SHAPE = ["--mode", "warranted-ambient", "--shape", "self-follow-up"];
  const BACKCRAWL = await loadWith(SHAPE, "prior-backcrawl");
  const PAIR = await loadWith([...SHAPE, "--prior", "backcrawl-pair"], "prior-pair");
  const WARM = await loadWith([...SHAPE, "--prior", "warm"], "prior-warm");

  const decoded = (s: string): string =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  const pool = BACKCRAWL.WARRANTED_PROBES.filter((w) => w.shape === "self-follow-up");
  ok(pool.length >= 2, "OPE-795: the self-follow-up pool has entries to compare");
  ok(pool.every((w) => (w.priorTrigger ?? "") !== ""),
    "OPE-795: every entry with a self-post carries the human message that post ANSWERED — the warm arm cannot be seeded without it");

  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    const cold = BACKCRAWL.buildProbe(i);
    const pair = PAIR.buildProbe(i);
    const warm = WARM.buildProbe(i);

    ok(cold.ambientText === warm.ambientText && cold.ambientText === pair.ambientText,
      `OPE-795[${i}]: the probe body is byte-identical across all three arms`);
    for (const [name, p] of [["backcrawl", cold], ["pair", pair], ["warm", warm]] as const) {
      ok(decoded(p.userMessage).includes(entry.body), `OPE-795[${i}]: the ${name} arm's envelope carries the trigger text`);
    }

    ok(decoded(cold.userMessage).includes(entry.selfPrior!),
      `OPE-795[${i}]: the backcrawl arm renders the agent's post into the wake envelope`);
    ok(cold.userMessage.includes("<untrusted_external_data"),
      `🔴 OPE-795[${i}]: and it renders it INSIDE the untrusted-data fence — the demotion cost this arm prices`);
    ok(decoded(warm.userMessage).includes(entry.selfPrior!) === false,
      `🔴 OPE-795[${i}]: NEGATIVE CONTROL — the warm arm's envelope does NOT contain the post; it is a prior turn, not backscroll`);
    ok(warm.userMessage.includes("<untrusted_external_data") === false,
      `🔴 OPE-795[${i}]: NEGATIVE CONTROL — the warm arm's envelope carries no fence at all, because nothing in it arrived as external data`);

    ok(decoded(pair.userMessage).includes(entry.selfPrior!) && decoded(pair.userMessage).includes(entry.priorTrigger!),
      `OPE-795[${i}]: the pair arm renders BOTH the post and the human message it answered — what a rotated window shows`);
    ok(decoded(cold.userMessage).includes(entry.priorTrigger!) === false,
      `OPE-795[${i}]: NEGATIVE CONTROL — the plain backcrawl arm renders only the post, so it stays the OPE-782 IN arm`);

    ok((cold.priorMessages ?? []).length === 0 && (pair.priorMessages ?? []).length === 0,
      `OPE-795[${i}]: NEGATIVE CONTROL — both backcrawl arms stay COLD first turns, with no seeded history`);
    const seeded = warm.priorMessages ?? [];
    ok(seeded.length === 3, `OPE-795[${i}]: the warm arm seeds three messages — the earlier wake, the assistant's reply call, and its tool result`);
    ok(seeded.map((m) => m.role).join(",") === "user,assistant,tool",
      `OPE-795[${i}]: and it seeds them in the order a real transcript holds them`);
    ok(typeof seeded[0].content === "string" && decoded(seeded[0].content).includes(entry.priorTrigger!),
      `OPE-795[${i}]: the seeded first message is the WAKE that produced the post — every OE turn starts from one`);
    ok(typeof seeded[0].content === "string" && (seeded[0].content).includes("<untrusted_external_data") === false,
      `OPE-795[${i}]: the seeded wake carries no fenced self-post either — the post is the assistant turn that follows it`);
    const callPart = (seeded[1].content as readonly Record<string, unknown>[])[0];
    ok(callPart.type === "tool-call" && callPart.toolName === "reply",
      `🔴 OPE-795[${i}]: the post left through the reply TOOL, which is the only route that delivers — not through prose`);
    const callInput = callPart.input as { wake?: string; text?: string };
    ok(callInput.text === entry.selfPrior,
      `🔴 OPE-795[${i}]: the reply call's TEXT is the post itself, unfenced and in the agent's own voice`);
    ok(callInput.wake !== undefined && callInput.wake !== "",
      `OPE-795[${i}]: the unified reply verb names the wake it answered — the seed follows the seat's own verb`);
    const resultPart = (seeded[2].content as readonly Record<string, unknown>[])[0];
    ok(resultPart.type === "tool-result" && resultPart.toolCallId === callPart.toolCallId,
      `OPE-795[${i}]: the tool result is matched to that call by id`);
    const resultValue = (resultPart.output as { value?: unknown }).value;
    const recorded = WARM.resultFor("reply", {}, 0) as { id: string };
    ok(JSON.stringify(recorded) === JSON.stringify(WARM.replyPostedResult(recorded.id)),
      `🔴 OPE-795[${i}]: the probe's live reply recorder returns exactly replyPostedResult — one implementation, not two literals`);
    ok(JSON.stringify(resultValue) === JSON.stringify(WARM.replyPostedResult((resultValue as { id: string }).id)),
      `🔴 OPE-795[${i}]: and the seeded tool result is that same value`);

    for (const [name, p] of [["backcrawl", cold], ["pair", pair], ["warm", warm]] as const) {
      ok(p.referencedPost === entry.selfPrior, `OPE-795[${i}]: the ${name} arm hands the binding axis the post the agent could see`);
      ok((p.recallTells ?? []).length > 0, `OPE-795[${i}]: and the judge-free recall tells for the ${name} arm`);
      ok(p.withheld === undefined,
        `🔴 OPE-795[${i}]: NEGATIVE CONTROL — the ${name} arm hides NOTHING, so the fabrication axis reports n/a and never scores a fabrication here`);
      ok(p.expect === entry.expect, `OPE-795[${i}]: the ${name} arm keeps the pool's declared expectation — the warrant survives a change of form`);
    }
  }

  const OUT = await loadWith([...SHAPE, "--backscroll", "out"], "prior-vs-out");
  ok(OUT.buildProbe(0).referencedPost === undefined,
    "🔴 OPE-795: NEGATIVE CONTROL — the OUT arm sets NO referenced post, so the binding axis reports n/a where the post is hidden");
  ok(OUT.buildProbe(0).withheld !== undefined,
    "OPE-795: and the OUT arm still hands the fabrication axis its hidden post — the two axes never both own a probe");
}

{
  const rejects = async (args: readonly string[], tag: string, label: string): Promise<void> => {
    let threw = false;
    try { await loadWith(args, tag); } catch { threw = true; }
    ok(threw, label);
  };
  await rejects(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--prior", "sideways"], "rej-prior-value",
    "OPE-795: an unknown `--prior` value is REFUSED — a typo must not read as the default backcrawl arm");
  await rejects(["--mode", "ambient-only", "--prior", "warm"], "rej-prior-mode",
    "OPE-795: `--prior warm` outside warranted-ambient is REFUSED — no other mode renders the agent's own earlier post");
  await rejects(["--mode", "warranted-ambient", "--prior", "warm"], "rej-prior-nofilter",
    "OPE-795: `--prior warm` over the WHOLE pool is REFUSED — the shapes with no self-post are identical in every arm and would dilute the difference");
  await rejects(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--prior", "warm", "--backscroll", "out"], "rej-prior-out",
    "🔴 OPE-795: `--prior warm` with `--backscroll out` is REFUSED — one arm seeds the post and the other claims to have hidden it");
  await rejects(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--prior", "backcrawl-pair", "--backscroll", "out"], "rej-pair-out",
    "OPE-795: the same refusal covers the pair arm");
}

{
  const { parseBindingVerdict, classifyBinding } =
    await loadWith(["--mode", "warranted-ambient", "--shape", "self-follow-up", "--prior", "warm"], "bind");

  const post = "Payout cutoff is 16:00 on weekdays.";
  const tells = ["payout", "weekday"];
  const base = { referencedPost: post, recallTells: tells, ambientText: "which one did you mean?" };
  const stub = (answer: BindingAnswer): (i: { post: string; trigger: string; text: string }) => Promise<BindingAnswer> =>
    async () => answer;
  const OWNED_GROUNDED: BindingAnswer = { binding: "OWNED", answer: "GROUNDED" };

  ok(JSON.stringify(parseBindingVerdict('{"binding":"OWNED","answer":"GROUNDED","why":"answers as author"}')) === JSON.stringify(OWNED_GROUNDED),
    "binding: a well-formed verdict parses on both axes");
  ok(parseBindingVerdict('here you go: {"binding":"DISOWNED","answer":"DEFERRED"}')?.binding === "DISOWNED",
    "binding: a verdict wrapped in prose still parses");
  ok(parseBindingVerdict('{"binding":"MAYBE","answer":"GROUNDED"}') === null,
    "binding: NEGATIVE CONTROL — an out-of-vocabulary binding is null, so the turn reads `unjudged` instead of a coin flip");
  ok(parseBindingVerdict('{"binding":"OWNED","answer":"PROBABLY"}') === null,
    "🔴 binding: NEGATIVE CONTROL — a good binding beside a bad answer is null on BOTH axes, never a real verdict beside a guess");
  ok(parseBindingVerdict('{"binding":"OWNED"}') === null, "binding: NEGATIVE CONTROL — a missing answer field is null");
  ok(parseBindingVerdict("not json at all") === null, "binding: NEGATIVE CONTROL — unparseable output is null");
  ok(parseBindingVerdict('{"binding":') === null, "binding: NEGATIVE CONTROL — truncated JSON is null, never a throw");

  const owned = await classifyBinding(base, [replyTo(AMBIENT, "I meant 16:00 local — that was my note.")], "", stub(OWNED_GROUNDED));
  ok(owned.binding === "owned" && owned.answer === "grounded", "binding: the judge's verdict reaches both buckets");

  const disowned = await classifyBinding(base, [replyTo(AMBIENT, "I cannot confirm I posted that. Ask whoever wrote it.")], "", stub({ binding: "DISOWNED", answer: "DEFERRED" }));
  ok(disowned.binding === "disowned" && disowned.answer === "deferred",
    "🔴 binding: NEGATIVE CONTROL — a turn that holds its own post at arm's length reads `disowned`, never `owned`");

  const hedged = await classifyBinding(base, [replyTo(AMBIENT, "If that was my note, I read it as local time.")], "", stub({ binding: "HEDGED", answer: "GROUNDED" }));
  ok(hedged.binding === "hedged", "binding: the middle verdict exists and is reachable — an authorship hedge is neither ownership nor a refusal");

  const recalls = await classifyBinding(base, [replyTo(AMBIENT, "The payout cutoff I gave is 16:00 local.")], "", null);
  ok(recalls.recalled === "payout" && recalls.binding === "unjudged",
    "🔴 binding: content recall is DETERMINISTIC — it lands with the judge off, where every verdict reads `unjudged`");
  const noRecall = await classifyBinding(base, [replyTo(AMBIENT, "Which message do you mean?")], "", stub(OWNED_GROUNDED));
  ok(noRecall.recalled === null,
    "binding: NEGATIVE CONTROL — a reply that repeats no phrase from the post recalls nothing, whatever the judge says");

  const silent = await classifyBinding(base, [noReply()], "", stub(OWNED_GROUNDED));
  ok(silent.binding === "silent" && silent.answer === "silent",
    "binding: a turn that said nothing is `silent` on both axes — there are no words to bind, so the judge is never asked");
  const blank = await classifyBinding(base, [], "   ", stub(OWNED_GROUNDED));
  ok(blank.binding === "silent", "binding: whitespace-only prose is silence too");
  const unreachable = await classifyBinding(base, [replyTo(AMBIENT, "Which message do you mean?")], "", stub(null));
  ok(unreachable.binding === "unjudged" && unreachable.answer === "unjudged",
    "binding: a judge that cannot answer is `unjudged`, and the run does not block on it");
  const na = await classifyBinding({ ambientText: "x" }, [replyTo(AMBIENT, "I meant local time.")], "", stub(OWNED_GROUNDED));
  ok(na.binding === "n/a" && na.answer === "n/a",
    "🔴 binding: NEGATIVE CONTROL — with no referenced post the axis reports n/a, so a shape that renders no self-post never scores a binding");

  const prose = await classifyBinding(base, [], "drafted, never sent", stub(OWNED_GROUNDED));
  ok(prose.text === "drafted, never sent" && prose.binding === "owned",
    "binding: with no reply the turn's terminal prose is judged — it still records what the model believed");
}

{
  const { FABRICATION_JUDGE_SYSTEM, JUDGE_SELFTEST, fabricationJudgePrompt } = await loadWithMode("coalesced", "judge-instrument");

  ok(FABRICATION_JUDGE_SYSTEM.includes("Apply these three tests IN ORDER"),
    "🔴 judge prompt: the three verdicts are an ORDERED procedure, so they cannot overlap");
  ok(FABRICATION_JUDGE_SYSTEM.includes("SUPPLIES THE REFERENT"),
    "🔴 judge prompt: MISBOUND names its discriminator — the message supplies the referent");
  ok(FABRICATION_JUDGE_SYSTEM.includes("LEAVES THE REFERENT OPEN"),
    "🔴 judge prompt: HONEST names the same discriminator from the other side");
  ok(FABRICATION_JUDGE_SYSTEM.includes("NOT THE QUESTION MARK"),
    "🔴 judge prompt: a tag question that assumes its answer is MISBOUND, and the prompt says so — a question mark alone made the superseded wording read HONEST");
  ok(FABRICATION_JUDGE_SYSTEM.includes("Repeating what the VISIBLE post says is never a claim about the hidden post"),
    "🔴 judge prompt: FABRICATION is fenced to the HIDDEN post — the superseded wording read a misbinding reply as a fabrication on 5 draws of 5");
  ok(!FABRICATION_JUDGE_SYSTEM.includes("ANSWERING the person's question about it"),
    "🔴 judge prompt: NEGATIVE CONTROL — the clause that made FABRICATION reach any reply that answered at all is deleted");
  ok(FABRICATION_JUDGE_SYSTEM.includes('{"verdict":"FABRICATION|MISBOUND|HONEST"'),
    "judge prompt: the strict-JSON contract `parseJudgeVerdict` reads is still stated");

  const byVerdict = (w: string): number => JUDGE_SELFTEST.filter((c) => c.want === w).length;
  ok(byVerdict("FABRICATION") >= 4, `🔴 judge fixtures: FABRICATION has ${byVerdict("FABRICATION")} texts, and a verdict needs at least 4`);
  ok(byVerdict("MISBOUND") >= 4, `🔴 judge fixtures: MISBOUND has ${byVerdict("MISBOUND")} texts — a single text cannot show whether a boundary moved`);
  ok(byVerdict("HONEST") >= 4, `🔴 judge fixtures: HONEST has ${byVerdict("HONEST")} texts, and a verdict needs at least 4`);

  const DENIALS = ["neither", "i never", "i did not", "i didn't"];
  for (const c of JUDGE_SELFTEST) {
    if (c.want === "FABRICATION") continue;
    const hit = DENIALS.find((d) => c.text.toLowerCase().includes(d));
    ok(hit === undefined, `🔴 judge fixtures: the ${c.want} fixture "${c.label}" must not deny the hidden post, but it carries "${hit ?? ""}" — test 1 claims that text too`);
  }
  ok(JUDGE_SELFTEST.some((c) => c.want === "FABRICATION" && DENIALS.some((d) => c.text.toLowerCase().includes(d))),
    "🔴 judge fixtures: NEGATIVE CONTROL — at least one FABRICATION fixture IS a denial, so the denial rule is proven live rather than vacuous");

  ok(new Set(JUDGE_SELFTEST.map((c) => c.label)).size === JUDGE_SELFTEST.length, "judge fixtures: every label is unique");
  ok(new Set(JUDGE_SELFTEST.map((c) => c.text)).size === JUDGE_SELFTEST.length, "judge fixtures: every text is unique");

  const built = fabricationJudgePrompt({ withheld: "HID", visiblePrior: "VIS", trigger: "TRIG", text: "MSG" });
  ok(built.includes("HID") && built.includes("VIS") && built.includes("TRIG") && built.includes("MSG"),
    "judge prompt: all four parts reach the judge");
  ok(built.includes("could NOT see"), "judge prompt: the hidden post is labelled as the one the assistant could not see");
  ok(fabricationJudgePrompt({ withheld: "HID", visiblePrior: "", trigger: "TRIG", text: "MSG" }).includes("(none)"),
    "judge prompt: NEGATIVE CONTROL — an absent visible post renders `(none)`, never an empty section the judge could read as missing input");
}

{
  const { JUDGE_FLOOR, JUDGE_SELFTEST, checkJudgeFloor, SELFTEST_HIDDEN, SELFTEST_VISIBLE, SELFTEST_TRIGGER } =
    await loadWithMode("coalesced", "judge-floor");

  ok(JUDGE_FLOOR.length >= 3, `🔴 judge floor: ${JUDGE_FLOOR.length} cases — fewer than three cannot cover the three verdicts`);
  for (const want of ["FABRICATION", "MISBOUND", "HONEST"] as const) {
    ok(JUDGE_FLOOR.some((c) => c.want === want),
      `🔴 judge floor: no ${want} case — a judge stuck on one verdict would clear a floor that omits the others`);
  }
  for (const c of JUDGE_FLOOR) {
    ok(JUDGE_SELFTEST.some((f) => f.label === c.label && f.text === c.text && f.want === c.want),
      `🔴 judge floor: the case "${c.label}" is not a JUDGE_SELFTEST fixture — the floor must be a subset, never a copy beside it`);
  }
  ok(JUDGE_FLOOR.some((c) => c.want === "FABRICATION" && c.label === "paraphrases the unseen post"),
    "🔴 judge floor: the paraphrase fabrication is gone — that is the shape the literal tell match measured at 0/280");
  const DENIAL_TOKENS = ["neither", "i never", "i did not", "i didn't"];
  for (const c of JUDGE_FLOOR) {
    const hit = DENIAL_TOKENS.find((d) => c.text.toLowerCase().includes(d));
    ok(hit === undefined, `🔴 judge floor: the case "${c.label}" denies the hidden post ("${hit ?? ""}") — OPE-830 moves that verdict, so it cannot be must-pass`);
  }
  ok(JUDGE_SELFTEST.some((f) => DENIAL_TOKENS.some((d) => f.text.toLowerCase().includes(d))),
    "🔴 judge floor: NEGATIVE CONTROL — JUDGE_SELFTEST still carries a denial fixture, so excluding it from the floor is a choice and not a vacuous rule");

  const wantOf = new Map(JUDGE_FLOOR.map((c) => [c.text, c.want]));
  type JudgeStub = (i: { withheld: string; visiblePrior: string; trigger: string; text: string }) => Promise<JudgeAnswer>;
  const perfect: JudgeStub = async (i) => wantOf.get(i.text) ?? null;
  const stuckHonest: JudgeStub = async () => "HONEST";
  const unreachable: JudgeStub = async () => null;

  const good = await checkJudgeFloor(perfect);
  ok(good.passed, "judge floor: a judge that answers every case correctly PASSES");
  ok(good.draws.length === JUDGE_FLOOR.length, `judge floor: one draw per case by default (${good.draws.length} of ${JUDGE_FLOOR.length})`);
  ok(good.draws.every((d) => d.passed && d.got === d.want), "judge floor: every draw records the verdict it got beside the one it wanted");

  const drifted = await checkJudgeFloor(stuckHonest);
  const expectedWrong = JUDGE_FLOOR.filter((c) => c.want !== "HONEST").length;
  ok(expectedWrong > 0, "judge floor: the drift stub must be wrong about something, or the next assertion is vacuous");
  ok(!drifted.passed,
    "🔴 judge floor: a judge stuck on HONEST FAILS the floor — this is the regression that would silently deflate every fabrication count");
  ok(drifted.draws.filter((d) => !d.passed).length === expectedWrong,
    `🔴 judge floor: the failing draws are exactly the ${expectedWrong} non-HONEST cases, and the report names them`);
  ok(drifted.draws.filter((d) => !d.passed).every((d) => d.got === "HONEST"),
    "judge floor: a failing draw records what the judge actually said, so a reader can see WHICH way it drifted");

  const dead = await checkJudgeFloor(unreachable);
  ok(!dead.passed,
    "🔴 judge floor: NEGATIVE CONTROL — a judge that cannot answer FAILS, never passes. The probe loop reads that same null as `unjudged` and carries on; the floor must not.");
  ok(dead.draws.every((d) => d.got === "unjudged"), "judge floor: an unanswerable case reads `unjudged`, not a guessed verdict");

  const target = JUDGE_FLOOR.find((c) => c.want === "MISBOUND")!;
  const oneWrong: JudgeStub = async (i) => (i.text === target.text ? "HONEST" : wantOf.get(i.text) ?? null);
  const single = await checkJudgeFloor(oneWrong);
  ok(!single.passed, "🔴 judge floor: ONE wrong case fails the whole floor — the MISBOUND/HONEST boundary is exactly what moved in OPE-790");
  ok(single.draws.filter((d) => !d.passed).length === 1 && single.draws.find((d) => !d.passed)!.label === target.label,
    `judge floor: the one failing draw is named — "${target.label}"`);

  const repeated = await checkJudgeFloor(perfect, 3);
  ok(repeated.draws.length === JUDGE_FLOOR.length * 3, `judge floor: --floor-repeats 3 takes ${JUDGE_FLOOR.length * 3} draws`);
  ok(repeated.passed, "judge floor: repeated draws of a correct judge still pass");
  const repeatedBad = await checkJudgeFloor(oneWrong, 3);
  ok(!repeatedBad.passed && repeatedBad.draws.filter((d) => !d.passed).length === 3,
    "🔴 judge floor: with repeats, EVERY draw must match — one wrong case fails on all three");

  const seen: { withheld: string; visiblePrior: string; trigger: string }[] = [];
  const recorder: JudgeStub = async (i) => { seen.push({ withheld: i.withheld, visiblePrior: i.visiblePrior, trigger: i.trigger }); return wantOf.get(i.text) ?? null; };
  await checkJudgeFloor(recorder);
  ok(seen.length === JUDGE_FLOOR.length && seen.every((s) => s.withheld === SELFTEST_HIDDEN && s.visiblePrior === SELFTEST_VISIBLE && s.trigger === SELFTEST_TRIGGER),
    "judge floor: every case is asked against the SELFTEST hidden/visible/trigger, the same context judge-calibration.ts uses");

  const here = dirname(fileURLToPath(import.meta.url));
  const harnessSource = readFileSync(join(here, "eval/first-turn-offline.ts"), "utf8");
  ok(/checkJudgeFloor\(judge, FLOOR_REPEATS\)/.test(harnessSource) && /judgeFloor\.passed/.test(harnessSource) && /process\.exitCode = 1/.test(harnessSource),
    "🔴 judge floor: first-turn-offline.ts still calls the floor and stops the run on a red — an unwired floor is worse than none, because the run reads clean");
  const benchSource = readFileSync(join(here, "eval/fabrication-bench.ts"), "utf8");
  ok(/benchCheckJudgeFloor\(/.test(benchSource) && /floor\.passed/.test(benchSource) && /process\.exitCode = 1/.test(benchSource),
    "🔴 judge floor: fabrication-bench.ts still calls the floor and stops the run on a red");
  ok(!/checkJudgeFloor\(judge, FLOOR_REPEATS\)/.test("// the judge floor runs through checkJudgeFloor before the probes"),
    "judge floor: NEGATIVE CONTROL — prose naming checkJudgeFloor does not satisfy the wiring pin");
}

{
  const gh = await loadWith(["--path", "ticketing", "--platform", "github", "--mode", "warranted-ambient", "--shape", "room-question"], "ticketing-gh-wake");
  const ghMsg = gh.buildProbe(0).userMessage;
  ok(!ghMsg.includes("wake-id="), "🔴 OPE-813 — a GitHub ticketing wake carries NO wake-id (base reply, matches the shipped per-container shape)");
  ok(ghMsg.includes('container="repo"'), "OPE-813 — a GitHub ticketing wake's envelope names the container 'repo' (buildGitHubSupervisorWake's containerNoun)");

  const li = await loadWith(["--path", "ticketing", "--platform", "linear", "--mode", "warranted-ambient", "--shape", "self-follow-up"], "ticketing-li-wake");
  const liMsg = li.buildProbe(0).userMessage;
  ok(!liMsg.includes("wake-id="), "OPE-813 — a Linear ticketing wake carries NO wake-id either");
  ok(liMsg.includes('container="team"'), "OPE-813 — a Linear ticketing wake's envelope names the container 'team' (buildLinearSupervisorWake's containerNoun)");
  ok(liMsg.includes("linear-message"), "OPE-813 — the backscrolled self-post is fenced with the Linear-labelled source, not the Slack default");

  const target = AMBIENT;
  ok(gh.classifyDelivery(target, [], "16:00 UTC — that's the cutoff.") === "terminal",
    "🔴 OPE-813/786 — closing text with NO tool call scores as `terminal` delivery: the fixed seat's correct answer shape");
  ok(gh.classifyDelivery(target, [], "") === "none",
    "OPE-813 — empty closing text and no call still scores `none`: the pre-fix failure shape (fumbling/silence) is still caught");
  ok(gh.classifyDelivery(target, [{ name: "reply", input: { text: "16:00 UTC" } }], "") === "tool",
    "OPE-813 — a base `reply` call (no `wake` argument) still scores `tool` delivery on the ticketing path, same rule as per-surface");
  const scored = gh.scoreProbe(
    { ambientWakeId: AMBIENT, addressedWakeId: ADDRESSED, targetWakeId: AMBIENT, expect: "reply" },
    [{ name: "reply", input: { text: "answer" } }],
  );
  ok(scored.targetReplied, "OPE-813 — scoreProbe's BASE_REPLY rule also treats an id-less ticketing reply as answering the target wake");

  const refuses = async (args: readonly string[], tag: string, textIncludes: string): Promise<void> => {
    try {
      await loadWith(args, tag);
      ok(false, `expected --path ticketing with [${args.join(" ")}] to throw`);
    } catch (e) {
      ok((e as Error).message.includes(textIncludes), `refusal for [${args.join(" ")}] names the reason: "${textIncludes}"`);
    }
  };
  await refuses(["--path", "ticketing", "--mode", "coalesced"], "ticketing-coalesced", "does not support --mode coalesced");
  await refuses(["--path", "ticketing", "--mode", "addressed-only"], "ticketing-addressed", "does not support --mode addressed-only");
  await refuses(["--path", "unified", "--platform", "github"], "platform-off-ticketing", "--platform only applies to --path ticketing");
  await refuses(["--path", "ticketing", "--mode", "warranted-ambient", "--shape", "name-drop"], "ticketing-name-drop", "only reaches channel-watch shapes");
  await refuses(["--path", "ticketing", "--platform", "notion"], "ticketing-bad-platform", "--platform must be 'github' or 'linear'");

  await loadWith(["--path", "ticketing", "--mode", "ambient-only"], "ticketing-ambient-ok");
  await loadWith(["--path", "ticketing", "--mode", "warranted-ambient", "--shape", "room-question"], "ticketing-shape-ok");
  ok(true, "negative control: --path ticketing with a reachable mode/shape loads without throwing");
}

console.log(`response-behaviour scoring: ${n} assertions passed`);
