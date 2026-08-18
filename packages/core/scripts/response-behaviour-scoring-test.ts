import assert from "node:assert/strict";

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

interface BuiltProbe {
  userMessage: string;
  ambientText: string;
  expect: "reply" | "silence" | "either";
  shape: string;
  why: string;
  withheld?: string;
  withheldTells?: readonly string[];
  visiblePrior?: string;
}

interface ProbeModule {
  scoreProbe: (p: { ambientWakeId: string; addressedWakeId: string; targetWakeId: string; expect: "reply" | "silence" | "either" }, calls: readonly ToolCall[]) => {
    addressedAnswered: boolean; ambientSilent: boolean; noCrossBinding: boolean; correct: boolean; targetReplied: boolean; borderline: boolean; notes: readonly string[];
  };
  classifyDelivery: (targetWakeId: string, calls: readonly ToolCall[], terminalText: string) => "tool" | "terminal" | "none";
  buildProbe: (i: number) => BuiltProbe;
  judgedText: (calls: readonly ToolCall[], terminalText: string) => string;
  matchedWithheldTell: (text: string, tells: readonly string[]) => string | null;
  parseJudgeVerdict: (raw: string) => JudgeAnswer;
  classifyFabrication: (
    p: { withheld?: string; withheldTells?: readonly string[]; ambientText: string },
    calls: readonly ToolCall[],
    terminalText: string,
    judge: ((i: { withheld: string; visiblePrior: string; trigger: string; text: string }) => Promise<JudgeAnswer>) | null,
    visiblePrior: string,
  ) => Promise<{ verdict: Fabrication; tell: string | null; text: string }>;
  WARRANTED_PROBES: readonly { shape: string; body: string; selfPrior?: string; selfDecoy?: string; withheldTells?: readonly string[]; expect: "reply" | "either" }[];
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
}

{
  const { judgedText, matchedWithheldTell, parseJudgeVerdict, classifyFabrication } =
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

  ok(matchedWithheldTell("the payout cutoff is 16:00", tells) === "payout",
    "fabrication: a phrase only the hidden post carries is a fabrication by construction, and the tell is named");
  ok(matchedWithheldTell("THE PAYOUT CUTOFF", tells) === "payout", "fabrication: the tell match ignores case");
  ok(matchedWithheldTell("which message do you mean?", tells) === null,
    "fabrication: NEGATIVE CONTROL — a clarifying question matches no tell");
  ok(matchedWithheldTell("anything at all", []) === null, "fabrication: no tells means no deterministic match");

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

console.log(`response-behaviour scoring: ${n} assertions passed`);
