import assert from "node:assert/strict";
import {
  attributeOutcomes,
  outcomeFor,
  summarize,
  scoreCoalescedTurn,
  proveSiblingWakes,
  parseSeries,
  S6_PROBES,
  type Injection,
  type Attribution,
  type TurnResult,
  type Expected,
  type CoalescedDeliveryProof,
} from "./eval/ambient-eval.js";
import type { AuditWireEntry } from "./e2e/audit-read.js";
import type { TranscriptWireEvent } from "./e2e/transcript-read.js";

let n = 0;
const ok = (cond: boolean, label: string): void => { assert.ok(cond, label); n++; };

const REPLY_POST = "reply.post";
const PROSE_DELIVERED = "turn.direct_mention_prose_delivered";
const PROSE_DROPPED = "turn.supervisor_prose_dropped";
const NO_REPLY = "unified.no_reply";
const BRIDGE_UNRESOLVED = "turn.direct_mention_bridge_unresolved";
const REDRIVE = "unified.turn.redrive";

let clock = Date.UTC(2026, 6, 24, 12, 0, 0);

const mkTurn = (over: Partial<TurnResult> & Pick<TurnResult, "turn" | "scenario" | "expected" | "outcome">): TurnResult => ({
  label: "", probe: null, state: null, latencyMs: null, delegations: 0, recall: null, matchedRows: [], notes: "", ...over,
});
const nextTs = (): string => { clock += 1000; return new Date(clock).toISOString(); };

function inj(over: Partial<Injection> & Pick<Injection, "wakeId">): Injection {
  return {
    injectedAt: nextTs(),
    kind: "probe",
    turn: 1,
    addressing: "direct-mention",
    platform: "slack",
    text: "probe text",
    ...over,
  };
}

function completion(action: string, over: Record<string, unknown> = {}): AuditWireEntry {
  return { ts: nextTs(), org: "acme", platform: "unified", workspace: "w", action, detail: { sessionId: "SESS", ...over } };
}
function replyPost(wakeId: string, over: Record<string, unknown> = {}): AuditWireEntry {
  return { ts: nextTs(), org: "acme", platform: "unified", workspace: "w", action: REPLY_POST, detail: { wakeId, platform: "slack", id: "1700000000.0001", ...over } };
}
function redriveRow(originalWakeId: string): AuditWireEntry {
  return { ts: nextTs(), org: "acme", platform: "unified", workspace: "w", action: REDRIVE, detail: { originalWakeId, sessionId: "SESS" } };
}

function attr(over: Partial<Attribution> = {}): Attribution {
  return {
    completionOf: new Map(),
    replyPostsOf: new Map(),
    delegationsOf: new Map(),
    sessionId: "SESS",
    completions: [],
    redrivenWakeIds: new Set(),
    notes: [],
    ...over,
  };
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const i1 = inj({ wakeId: "W1" });
  const rows = [replyPost("W1"), replyPost("W1", { route: "bridge", id: "1700000000.0002" })];
  const a = attributeOutcomes([i1], rows);
  ok((a.replyPostsOf.get("W1") ?? []).length === 2, "reply.post rows join their injection EXACTLY by detail.wakeId (2 posts on W1)");
  ok(!a.replyPostsOf.has("W2"), "no phantom join for an un-posted wakeId");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const i1 = inj({ wakeId: "W1" });
  const dispatch = (over: Record<string, unknown> = {}): AuditWireEntry => ({
    ts: new Date((clock += 1000)).toISOString(), org: "acme", platform: "unified", workspace: "w",
    action: "delegation.task_started", detail: { task: "T", call: "call-1", session: "SESS", ...over },
  });
  const a = attributeOutcomes([i1], [dispatch(), dispatch({ task: "T2", call: "call-2" }), completion(NO_REPLY, { wakeId: "W1" })]);
  ok((a.delegationsOf.get("W1") ?? []).length === 2, "delegation.task_started rows join the turn whose completion first follows them in the same session");
  ok(a.delegationsOf.size === 1, "…and only that turn — a dispatch never mints a key of its own");
  const foreign = attributeOutcomes([i1], [dispatch({ session: "OTHER-SESS" }), completion(NO_REPLY, { wakeId: "W1" })]);
  ok(foreign.delegationsOf.size === 0, "a dispatch from ANOTHER session is skipped, not guessed at");
  const late = attributeOutcomes([i1], [completion(NO_REPLY, { wakeId: "W1" }), dispatch()]);
  ok(late.delegationsOf.size === 0, "a dispatch AFTER the last completion belongs to a turn this window does not hold — counted for none");
  const noSession = attributeOutcomes([i1], [dispatch({ session: undefined }), completion(NO_REPLY, { wakeId: "W1" })]);
  ok(noSession.delegationsOf.size === 0, "a dispatch row naming no caller session is skipped, not guessed at");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const bridged = inj({ wakeId: "W-BRIDGE" });
  const bridgePost = replyPost("W-BRIDGE", { route: "bridge" });
  const dispatchByBridged: AuditWireEntry = {
    ts: new Date((clock += 1000)).toISOString(), org: "acme", platform: "unified", workspace: "w",
    action: "delegation.task_started", detail: { task: "T", call: "call-1", session: "SESS" },
  };
  const later = inj({ wakeId: "W-LATER" });
  const laterDone = completion(NO_REPLY, { wakeId: "W-LATER" });
  const a = attributeOutcomes([bridged, later], [bridgePost, dispatchByBridged, laterDone]);
  ok(
    (a.delegationsOf.get("W-LATER") ?? []).length === 0,
    "🔴 a dispatch made by a BRIDGE-delivered turn — which owns no completion row — is NOT hung on the next turn's completion",
  );
  ok(a.delegationsOf.size === 0, "…and it is counted for no turn at all, which is what failing closed means here");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const i1 = inj({ wakeId: "A1", turn: 1 });
  const i2 = inj({ wakeId: "A2", turn: 2, addressing: "channel-watch" });
  const c1 = completion(NO_REPLY, { reason: "judged" });
  const c2 = completion(PROSE_DROPPED, { chars: 40, replied: false });
  const a = attributeOutcomes([i1, i2], [c1, c2]);
  ok(a.completionOf.get("A1") === c1, "FIFO pairs the 1st completion to the 1st injection");
  ok(a.completionOf.get("A2") === c2, "FIFO pairs the 2nd completion to the 2nd injection");
  ok(!a.notes.some((s) => s.includes("FIFO 1:1 broke")), "clean 1:1 emits no FIFO-break note");
  ok(a.sessionId === "SESS", "sessionId is the majority of the completion rows");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const i1 = inj({ wakeId: "B1" });
  const mine = completion(NO_REPLY, { reason: "judged", sessionId: "SESS" });
  const mine2 = completion(NO_REPLY, { reason: "judged", sessionId: "SESS" });
  const foreign = completion(PROSE_DROPPED, { chars: 9, replied: false, sessionId: "OTHER" });
  const i2 = inj({ wakeId: "B2" });
  const a = attributeOutcomes([i1, i2], [mine, foreign, mine2]);
  ok(a.sessionId === "SESS", "majority sessionId wins (2 SESS vs 1 OTHER)");
  ok(a.completions.every((c) => (c.detail?.sessionId ?? "SESS") === "SESS"), "foreign-session completion excluded from the pool");
  ok(a.notes.some((s) => s.includes("other session")), "an exclusion note is recorded");
  ok(a.completionOf.get("B1") === mine && a.completionOf.get("B2") === mine2, "the two SESS completions pair to the two injections in order");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const i1 = inj({ wakeId: "W1" });
  const drop = completion(PROSE_DROPPED, { chars: 30, replied: false });
  const rd = redriveRow("W1");
  const corrective = completion(NO_REPLY, { reason: "redriven-still-silent" });
  const a = attributeOutcomes([i1], [drop, rd, corrective]);
  ok(a.redrivenWakeIds.has("W1"), "the ORIGINAL wakeId is marked redriven (detail.originalWakeId)");
  ok(a.completionOf.get("W1") === drop, "W1 pairs to the ORIGINAL drop, not the corrective completion");
  ok(a.notes.some((s) => s.includes("auto-redrive")), "a redrive-accounting note is recorded");
  ok(!a.notes.some((s) => s.includes("FIFO 1:1 broke")), "after pulling the corrective completion, FIFO stays 1:1");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const iBridge = inj({ wakeId: "M1", addressing: "direct-mention", turn: 1 });
  const iAmbient = inj({ wakeId: "M2", addressing: "channel-watch", turn: 2 });
  const bridgePost = replyPost("M1", { route: "bridge" });
  const ambientDrop = completion(PROSE_DROPPED, { chars: 12, replied: false });
  const a = attributeOutcomes([iBridge, iAmbient], [bridgePost, ambientDrop]);
  ok((a.replyPostsOf.get("M1") ?? []).some((p) => p.detail?.route === "bridge"), "the bridge post joins M1");
  ok(a.completionOf.get("M2") === ambientDrop, "with M1 pulled, the lone completion pairs to the ambient injection M2");
  ok(!a.completionOf.has("M1"), "the bridged injection owns no completion row");
  ok(!a.notes.some((s) => s.includes("FIFO 1:1 broke")), "pulling the bridge injection keeps the pairing 1:1");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const i1 = inj({ wakeId: "C1", addressing: "direct-mention" });
  const i2 = inj({ wakeId: "C2", addressing: "channel-watch" });
  const only = completion(NO_REPLY, { reason: "judged" });
  const a = attributeOutcomes([i1, i2], [only]);
  ok(a.notes.some((s) => s.includes("FIFO 1:1 broke")), "a count mismatch records the FIFO-break / semantic-fallback note");
}

const LANDED: Expected = "LANDED";
const SILENT: Expected = "SILENT_OK";
{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const i = inj({ wakeId: "P1" });

  ok(outcomeFor(i, LANDED, attr({ replyPostsOf: new Map([["P1", [replyPost("P1")]]]) })).outcome === "LANDED_VIA_REPLY_TOOL", "reply.post + LANDED → LANDED_VIA_REPLY_TOOL");

  ok(outcomeFor(i, LANDED, attr({ replyPostsOf: new Map([["P1", [replyPost("P1", { route: "bridge" })]]]) })).outcome === "LANDED_VIA_BRIDGE", "reply.post route:bridge + LANDED → LANDED_VIA_BRIDGE");

  ok(outcomeFor(i, LANDED, attr({ replyPostsOf: new Map([["P1", [replyPost("P1")]]]), redrivenWakeIds: new Set(["P1"]) })).outcome === "LANDED_VIA_REDRIVE", "reply.post on a redriven wake + LANDED → LANDED_VIA_REDRIVE");

  ok(outcomeFor(i, SILENT, attr({ replyPostsOf: new Map([["P1", [replyPost("P1")]]]) })).outcome === "OVER_REPLY", "reply.post + SILENT_OK → OVER_REPLY (it spoke when it should have stayed quiet)");

  ok(outcomeFor(i, LANDED, attr()).outcome === "NO_ACTION", "no post + no completion + LANDED → NO_ACTION");

  ok(outcomeFor(i, SILENT, attr()).outcome === "SILENT_OK", "no post + no completion + SILENT_OK → SILENT_OK (OPE-723: absence of a reply.post already proves silence held)");
  ok(/inferred/i.test(outcomeFor(i, SILENT, attr()).notes), "OPE-723: the inferred case is labelled distinctly in `notes` from an AUDITED no_reply SILENT_OK, so a human reading results can tell them apart");

  ok(outcomeFor(i, SILENT, attr({ replyPostsOf: new Map([["P1", [replyPost("P1")]]]) })).outcome === "OVER_REPLY", "OPE-723 negative control: a real reply.post on a silence-warranted probe still scores OVER_REPLY, never SILENT_OK");

  ok(outcomeFor(i, LANDED, attr({ completionOf: new Map([["P1", completion(NO_REPLY, { reason: "judged" })]]) })).outcome === "JUDGED_SILENT", "no_reply + LANDED → JUDGED_SILENT");

  ok(outcomeFor(i, SILENT, attr({ completionOf: new Map([["P1", completion(NO_REPLY, { reason: "judged" })]]) })).outcome === "SILENT_OK", "no_reply + SILENT_OK → SILENT_OK");

  ok(outcomeFor(i, LANDED, attr({ completionOf: new Map([["P1", completion(PROSE_DROPPED, { chars: 50, replied: false })]]) })).outcome === "DROP", "prose_dropped + LANDED → DROP (the prose-drop failure axis)");

  ok(outcomeFor(i, SILENT, attr({ completionOf: new Map([["P1", completion(PROSE_DROPPED, { chars: 50, replied: false })]]) })).outcome === "SILENT_OK", "prose_dropped + SILENT_OK → SILENT_OK (gated drop, silence held)");

  ok(outcomeFor(i, LANDED, attr({ completionOf: new Map([["P1", completion(BRIDGE_UNRESOLVED, { chars: 20 })]]) })).outcome === "DROP", "bridge_unresolved + LANDED → DROP (owed and lost)");

  ok(outcomeFor(i, LANDED, attr({ completionOf: new Map([["P1", completion(PROSE_DELIVERED, { chars: 20, platform: "slack" })]]) })).outcome === "LANDED_VIA_BRIDGE", "legacy prose_delivered + LANDED → LANDED_VIA_BRIDGE");
}

{
  const turns: TurnResult[] = [
    mkTurn({ turn: 1, scenario: "S1", expected: "LANDED", outcome: "LANDED_VIA_REPLY_TOOL", recall: { code: true, date: true, ref: true } }),
    mkTurn({ turn: 2, scenario: "S2", expected: "LANDED", outcome: "DROP" }),
    mkTurn({ turn: 3, scenario: "S3", expected: "SILENT_OK", outcome: "SILENT_OK" }),
    mkTurn({ turn: 4, scenario: "S5", expected: "LANDED", outcome: "LANDED_VIA_REPLY_TOOL" }),
    mkTurn({ turn: 5, scenario: "S4", expected: "LANDED", outcome: "JUDGED_SILENT" }),
  ];
  const allRows: AuditWireEntry[] = [
    completion(PROSE_DROPPED, { chars: 10, replied: false, sessionId: "SESS" }),
    completion(PROSE_DROPPED, { chars: 10, replied: true, sessionId: "SESS" }),
    completion(PROSE_DROPPED, { chars: 10, replied: false, sessionId: "OTHER" }),
  ];
  const s = summarize(turns, allRows, "SESS");

  ok(s.reply_landed_rate.of === 3, "reply_landed_rate denominator excludes the soft S5 turn (S1,S2,S4)");
  ok(s.reply_landed_rate.landed === 1 && s.reply_landed_rate.rate === 0.333, "reply_landed_rate = 1/3 (only S1 landed)");
  ok(s.reply_tool_adherence.via_reply_tool === 1, "reply_tool_adherence counts the first-try reply-tool landing");
  ok(s.soft_reply_rate.of === 1 && s.soft_reply_rate.landed === 1 && s.soft_reply_rate.rate === 1, "soft_reply_rate = 1/1 for the S5 soft turn");
  ok(s.silence_precision.of === 1 && s.silence_precision.silent === 1 && s.silence_precision.rate === 1, "silence_precision = 1/1 (S3 held silence)");
  ok(s.prose_drop_count.total === 2, "prose_drop_count is session-filtered (foreign-session drop excluded)");
  ok(s.prose_drop_count.repliedFalse === 1 && s.prose_drop_count.repliedTrue === 1, "prose_drop_count splits replied=false (real leak) vs replied=true (benign wrap-up)");
  ok(s.recall_accuracy.full === 1 && s.recall_accuracy.ofLandedRead === 1, "recall_accuracy = 1/1 (S1 recalled all three needles)");
  ok(s.judged_silent_count === 1, "judged_silent_count counts the S4 reply-warranted turn that chose silence");
  ok(s.sequential_pair_correctness.of === 0 && s.sequential_pair_correctness.rate === null, "sequential_pair_correctness on a run with no S6 turns: of=0, rate=null — honest 'not measured', never a false zero");
  ok(s.coalesced_turn_correctness.of === 0 && s.coalesced_turn_correctness.rate === null && s.coalesced_turn_correctness.unproven === 0, "coalesced_turn_correctness on a run with no S7 turns: of=0, rate=null, unproven=0 — honest 'not measured', never a false zero");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const t1 = mkTurn({ turn: 1, scenario: "S6", expected: "LANDED", outcome: "LANDED_VIA_REPLY_TOOL", coalesced: scoreCoalescedTurn("ADDR-1", "AMB-1", attr({ replyPostsOf: new Map([["ADDR-1", [replyPost("ADDR-1")]]]) })) });
  const t2 = mkTurn({ turn: 2, scenario: "S6", expected: "LANDED", outcome: "DROP", coalesced: scoreCoalescedTurn("ADDR-2", "AMB-2", attr({ replyPostsOf: new Map([["AMB-2", [replyPost("AMB-2")]]]) })) });
  const s = summarize([t1, t2], [], "SESS");
  ok(s.sequential_pair_correctness.of === 2, "sequential_pair_correctness.of counts both S6 turns (no coalescing proof stamped ⇒ the SEQUENTIAL axis)");
  ok(s.sequential_pair_correctness.correct === 1 && s.sequential_pair_correctness.rate === 0.5, "sequential_pair_correctness = 1/2 = 0.5 (T1 correct, T2 mis-bound)");
  ok(s.sequential_pair_correctness.addressed_answered === 1 && s.sequential_pair_correctness.ambient_silent === 1, "sequential_pair_correctness sub-counts split T1 (both hold) from T2 (neither holds)");
  ok(s.coalesced_turn_correctness.of === 0 && s.coalesced_turn_correctness.rate === null && s.coalesced_turn_correctness.unproven === 0, "S6 verdicts do NOT leak into coalesced_turn_correctness: of=0, rate=null, unproven=0 — that axis counts PROVEN coalesced turns only");
  ok(s.reply_landed_rate.of === 2 && s.reply_landed_rate.landed === 1, "S6 turns ALSO count in reply_landed_rate (expected:\"LANDED\", not soft) — the addressed half is a real reply-warranted probe like S1/S2/S4");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const proof = (over: Partial<CoalescedDeliveryProof>): CoalescedDeliveryProof => ({
    proven: true, turnId: "turn-1", turnsSpanned: 1, wakeEnvelopesInTurn: 2, note: "", ...over,
  });
  const t1 = mkTurn({ turn: 1, scenario: "S7", expected: "LANDED", outcome: "LANDED_VIA_REPLY_TOOL", coalescedProof: proof({}), coalesced: scoreCoalescedTurn("ADDR-1", "AMB-1", attr({ replyPostsOf: new Map([["ADDR-1", [replyPost("ADDR-1")]]]) })) });
  const t2 = mkTurn({ turn: 2, scenario: "S7", expected: "LANDED", outcome: "DROP", coalescedProof: proof({ turnId: "turn-2" }), coalesced: scoreCoalescedTurn("ADDR-2", "AMB-2", attr({ replyPostsOf: new Map([["AMB-2", [replyPost("AMB-2")]]]) })) });
  const t3 = mkTurn({ turn: 3, scenario: "S7", expected: "LANDED", outcome: "LANDED_VIA_REPLY_TOOL", coalescedProof: proof({ proven: false, turnId: null, turnsSpanned: 2, wakeEnvelopesInTurn: 0 }), coalesced: scoreCoalescedTurn("ADDR-3", "AMB-3", attr({ replyPostsOf: new Map([["ADDR-3", [replyPost("ADDR-3")]]]) })) });
  const s = summarize([t1, t2, t3], [], "SESS");
  ok(s.coalesced_turn_correctness.of === 2, "coalesced_turn_correctness.of counts ONLY the two PROVEN turns — the unproven T3 is not in the denominator");
  ok(s.coalesced_turn_correctness.correct === 1 && s.coalesced_turn_correctness.rate === 0.5, "coalesced_turn_correctness = 1/2 = 0.5 — the unproven T3's 'correct' verdict does NOT inflate it to 2/3");
  ok(s.coalesced_turn_correctness.unproven === 1, "coalesced_turn_correctness.unproven = 1 — the harness fault is REPORTED, never silently dropped");
  ok(s.coalesced_turn_correctness.addressed_answered === 1 && s.coalesced_turn_correctness.ambient_silent === 1, "coalesced_turn_correctness sub-counts read the proven turns only");
  ok(s.sequential_pair_correctness.of === 0, "an S7 turn (proof stamped, proven or not) never counts on the S6 sequential axis");
  ok(s.reply_landed_rate.of === 3 && s.reply_landed_rate.landed === 2, "all three S7 turns still count in reply_landed_rate — the addressed half is a real reply-warranted probe whatever the delivery shape");
}

{
  const received = (turnId: string, message: string, index: number): TranscriptWireEvent => ({
    index, at: new Date(clock += 1000).toISOString(), type: "message.received", data: { message, sequence: index, turnId },
  });
  const envelope = (wakeId: string): string => `<${"wake"} wake-id="${wakeId}" addressing="direct-mention">hello</${"wake"}>`;

  const p1 = proveSiblingWakes([
    received("turn-A", `${envelope("AMB-1")}\n\n${envelope("ADDR-1")}`, 0),
  ], "ADDR-1", "AMB-1");
  ok(p1.proven === true, "proveSiblingWakes: both wake ids in ONE received message on ONE turnId ⇒ PROVEN (the measured live shape)");
  ok(p1.turnId === "turn-A" && p1.turnsSpanned === 1 && p1.wakeEnvelopesInTurn === 2, "proveSiblingWakes: the proof names the shared turnId, spans 1 turn, and counts the 2 SIBLING WAKE ENVELOPES");

  const p2 = proveSiblingWakes([
    received("turn-A", envelope("AMB-2"), 0),
    received("turn-B", envelope("ADDR-2"), 1),
  ], "ADDR-2", "AMB-2");
  ok(p2.proven === false, "proveSiblingWakes: one wake id per turn ⇒ NOT proven (the OPE-744 back-to-back shape)");
  ok(p2.turnsSpanned === 2 && p2.turnId === null, "proveSiblingWakes: a refuted pair reports the 2 distinct turns it spanned and names no turnId");
  ok(p2.note.includes("HARNESS FAULT") && p2.note.includes("AMBIENT_OCCUPY_WAIT_MS"), "proveSiblingWakes: the refusal note calls the split a HARNESS FAULT and names the knob that fixes it");

  const p3 = proveSiblingWakes([
    received("turn-A", envelope("OCC-3"), 0),
    received("turn-A", envelope("AMB-3"), 1),
    received("turn-A", envelope("ADDR-3"), 2),
  ], "ADDR-3", "AMB-3");
  ok(p3.proven === true && p3.wakeEnvelopesInTurn === 3, "proveSiblingWakes: a third envelope in the same turn (the occupier coalescing in) still PROVES the pair, and the count says 3");

  const p4 = proveSiblingWakes([received("turn-A", envelope("AMB-4"), 0)], "ADDR-4", "AMB-4");
  ok(p4.proven === false && p4.turnsSpanned === 1, "proveSiblingWakes: an addressed wake absent from every message.received ⇒ NOT proven");
  ok(p4.note.includes("ADDR-4") && !p4.note.includes("ambient AMB-4"), "proveSiblingWakes: the note names the MISSING half (addressed ADDR-4) and not the half that was found");

  const p5 = proveSiblingWakes([], "ADDR-5", "AMB-5");
  ok(p5.proven === false && p5.turnsSpanned === 0, "proveSiblingWakes: an empty event list ⇒ NOT proven (0 turns spanned) — an unreadable transcript never promotes a turn into the metric");

  const p6 = proveSiblingWakes([
    received("turn-A", envelope("ADDR-6"), 0),
    { index: 1, at: null, type: "message.completed", data: { message: `replying to ${envelope("AMB-6")}`, turnId: "turn-A" } },
    { index: 2, at: null, type: "message.received", data: { message: envelope("AMB-6") } },
  ], "ADDR-6", "AMB-6");
  ok(p6.proven === false, "proveSiblingWakes: a wake id appearing only in a message.completed (model output) or in a turnId-less event does NOT prove coalescing");

  const p7 = proveSiblingWakes([
    received("turn-A", `<${"wake"} wake-id="ADDR-7">both ids here: AMB-7</${"wake"}>`, 0),
  ], "ADDR-7", "AMB-7");
  ok(p7.proven === false && p7.wakeEnvelopesInTurn === 1, "proveSiblingWakes: one envelope naming both ids ⇒ NOT proven — the shape must be ≥2 SIBLING wake envelopes, not one turn mentioning two ids");
}

{
  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const a1 = attr({ replyPostsOf: new Map([["ADDR-1", [replyPost("ADDR-1")]]]) });
  const s1 = scoreCoalescedTurn("ADDR-1", "AMB-1", a1);
  ok(s1.addressedAnswered === true, "correct case: addressedAnswered = true (reply.post joined by the addressed wake's OWN id)");
  ok(s1.ambientSilent === true, "correct case: ambientSilent = true (no reply.post under the ambient wake's id)");
  ok(s1.noCrossBinding === true, "correct case: noCrossBinding = true (no read-back text, degrades to ambientSilent alone)");
  ok(s1.correct === true, "correct case: correct = true — all three criteria hold");
  ok(s1.notes.length === 0, "correct case: no failure notes recorded");

  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const a2 = attr();
  const s2 = scoreCoalescedTurn("ADDR-2", "AMB-2", a2);
  ok(s2.addressedAnswered === false, "dropped case: addressedAnswered = false (no reply.post at all)");
  ok(s2.ambientSilent === true, "dropped case: ambientSilent is STILL true — the ambient half is fine");
  ok(s2.correct === false, "dropped case: correct = false — one failing criterion is enough to fail the whole turn");
  ok(s2.notes.some((m) => m.includes("got NO reply.post")), "dropped case: the note names WHICH criterion failed");

  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const a3 = attr({ replyPostsOf: new Map([["AMB-3", [replyPost("AMB-3")]]]) });
  const s3 = scoreCoalescedTurn("ADDR-3", "AMB-3", a3);
  ok(s3.addressedAnswered === false, "mis-binding case: addressedAnswered = false — the addressed wake's OWN id never got a post");
  ok(s3.ambientSilent === false, "mis-binding case: ambientSilent = false — a post landed on the wrong wake-id");
  ok(s3.noCrossBinding === false, "mis-binding case: noCrossBinding = false too — same underlying bug, both criteria correctly flag it");
  ok(s3.correct === false, "mis-binding case: correct = false");
  ok(s3.notes.some((m) => m.includes("should never have been answered")), "mis-binding case: the note names the ambient wake as the one that was wrongly answered");

  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const a4 = attr({ replyPostsOf: new Map([["ADDR-4", [replyPost("ADDR-4")]]]) });
  const s4 = scoreCoalescedTurn("ADDR-4", "AMB-4", a4, "the answer is 42 (wake AMB-4)");
  ok(s4.addressedAnswered === true && s4.ambientSilent === true, "text-leak case: (a) and (b) both hold — the wakeId routing itself was correct");
  ok(s4.noCrossBinding === false, "text-leak case: noCrossBinding = false — the ambient wake's raw id leaked into the delivered text");
  ok(s4.correct === false, "text-leak case: correct = false — a hygiene failure fails the turn even with correct routing");
  ok(s4.notes.some((m) => m.includes("leaked into a delivered message")), "text-leak case: the note names the leak specifically, distinct from the routing notes above");

  clock = Date.UTC(2026, 6, 24, 12, 0, 0);
  const a5 = attr({ replyPostsOf: new Map([["ADDR-5", [replyPost("ADDR-5")]]]) });
  const s5 = scoreCoalescedTurn("ADDR-5", "AMB-5", a5, "the answer is 42");
  ok(s5.noCrossBinding === true && s5.correct === true, "negative control: ordinary reply text with no ambient-id substring does not trip the leak check");
}

{
  ok(parseSeries(undefined) === undefined, "parseSeries(undefined): no --series flag ⇒ undefined ⇒ main() falls back to seriesOf(cli.turns) unchanged");
  ok(JSON.stringify(parseSeries("S6,S6,S6")) === JSON.stringify(["S6", "S6", "S6"]), "parseSeries: a comma-list of valid ids parses in order, duplicates kept (repeats are the point for a screening run)");
  ok(JSON.stringify(parseSeries(" S1, S6 ")) === JSON.stringify(["S1", "S6"]), "parseSeries: surrounding whitespace around each id is trimmed");
  ok(JSON.stringify(parseSeries("")) === JSON.stringify([]), "parseSeries: an empty string parses to an empty (but DEFINED, not undefined) series — a caller that explicitly passed --series \"\" gets an explicit empty run, not the default fallback");
  assert.throws(() => parseSeries("S1,S9,S2"), /unknown scenario id\(s\) S9/, "parseSeries: an unknown scenario id FAILS LOUD (throws), naming the bad id — never silently dropped, which would run a shorter series than asked");

  assert.throws(() => parseSeries("S7,S7,S7,S7,S7"), /S7 cannot be driven on this eve/, "parseSeries: S7 is REFUSED, not silently dropped — a shortened series is a run the operator did not ask for");
  assert.throws(() => parseSeries("S7"), /coalesced-delivery-merge-assumption-test\.ts/, "…and the refusal names the offline pin that goes RED on the day S7 becomes drivable again");
  assert.throws(() => parseSeries("S1,S7,S6"), /S7 cannot be driven/, "…and one unreachable id refuses the WHOLE series, so a mixed run never silently loses its S7 turns");
  ok(JSON.stringify(parseSeries("S1,S6")) === JSON.stringify(["S1", "S6"]), "🔴 NEGATIVE CONTROL: the refusal is specific to S7 — every other id still parses, so the guard above is not a blanket throw");
}

{
  ok(S6_PROBES.length >= 8, `the S6 pool holds enough pairs for a first-turn run without wrapping (${S6_PROBES.length})`);
  const ambients = S6_PROBES.map((p) => p.ambient);
  const addressed = S6_PROBES.map((p) => p.addressed);
  ok(new Set(ambients).size === ambients.length, "🔴 every AMBIENT text in the pool is distinct — no probe repeats a text the session already judged");
  ok(new Set(addressed).size === addressed.length, "🔴 every ADDRESSED text in the pool is distinct");
  ok(S6_PROBES.every((p) => p.ambient.trim().length > 0 && p.addressed.trim().length > 0), "no pool entry is empty");
  ok(S6_PROBES.every((p) => /reply here with/i.test(p.addressed)), "every addressed probe asks for a reply in the channel — S6 measures binding, not whether the ask was legible");
  ok(S6_PROBES.every((p) => !/reply here with/i.test(p.ambient)), "🔴 no ambient probe asks the agent for anything — a reply landing on its wake is unambiguously wrong");
}

console.log(`\n✓ ambient-eval scoring: ${n} assertions passed (FIFO pairing + session filter + redrive/bridge pull-out + outcome mapping + soft-bucket summary + pair binding: correct/dropped/mis-bound/text-leak/negative-control + OPE-747 coalescing proof + the S6/S7 axis split + probe-text pool + --series parsing)\n`);
