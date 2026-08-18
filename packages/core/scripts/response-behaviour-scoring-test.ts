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

interface ProbeModule {
  scoreProbe: (p: { ambientWakeId: string; addressedWakeId: string; targetWakeId: string; expect: "reply" | "silence" | "either" }, calls: readonly ToolCall[]) => {
    addressedAnswered: boolean; ambientSilent: boolean; noCrossBinding: boolean; correct: boolean; targetReplied: boolean; borderline: boolean; notes: readonly string[];
  };
  classifyDelivery: (targetWakeId: string, calls: readonly ToolCall[], terminalText: string) => "tool" | "terminal" | "none";
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

console.log(`response-behaviour scoring: ${n} assertions passed`);
