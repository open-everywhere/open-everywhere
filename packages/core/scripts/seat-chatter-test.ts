import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARD_OUTCOME_RULE,
  NO_HANDOFF_NARRATION_RULE,
  WORK_FORWARD_SECTION,
  postingIsAnActionParagraph,
  renderDmSeatPersona,
  renderSeatPersona,
  type DeliveryArm,
} from "../agent/instructions/seat-prompt.js";
import { FORWARDED_NOTE, freshFollowUpNote } from "../agent/tools/work.js";
import { renderWorkResultNote } from "../agent/channels/work.js";
import { approvalDecisionBody, type ApprovalDecisionWakeInput } from "../agent/approvals/decision-wake.js";
import { delegationPendingRefusalMessage, settlementReportOwedMessage } from "../agent/access/pending-delegation-signal.js";
import { PENDING_WORK_INSTRUCTION } from "../agent/channels/turn-delivery.js";
import { renderWorkerCapabilityIndex } from "../agent/access/worker-capabilities.js";
import { WORKER_ONLY_TOOLS_STANDING, WORKER_ONLY_TOOLS_THREAD } from "../agent/access/worker-capability-index.generated.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const flat = (s: string) => s.replace(/\s+/g, " ");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ARMS: readonly DeliveryArm[] = [
  { kind: "wake-addressed", pinned: false },
  { kind: "wake-addressed", pinned: true },
  { kind: "reply-only" },
  { kind: "closing-text" },
  { kind: "dual-mode" },
];
const seatPersonas: Array<[string, string]> = [];
for (const delivery of ARMS) {
  for (const forwardsWork of [false, true]) {
    for (const scope of ["channel", "thread"] as const) {
      seatPersonas.push([`seat ${delivery.kind}${"pinned" in delivery && delivery.pinned ? "/pinned" : ""} forwardsWork=${forwardsWork} scope=${scope}`, renderSeatPersona({ seatKind: "conversational", delivery, forwardsWork, scope })]);
    }
  }
}
const workerPersonas: Array<[string, string]> = [
  ["worker midTurnPost=true", renderSeatPersona({ seatKind: "worker", midTurnPost: true })],
  ["worker midTurnPost=false", renderSeatPersona({ seatKind: "worker", midTurnPost: false })],
];

const resultNote = (status: "completed" | "failed" | "cancelled", extra: Partial<Parameters<typeof renderWorkResultNote>[0]> = {}) =>
  renderWorkResultNote({ requestId: "req_1", taskId: "task_1", status, dispatchWakeId: "wk_ask", ...extra });

const decisionInput: ApprovalDecisionWakeInput = {
  origin: { platform: "discord", channelId: "D1", guildId: "G1", threadId: "T1" } as ApprovalDecisionWakeInput["origin"],
  wakeId: "wk_decision",
  summaryLine: "Join the voice channel General",
  outcome: "approved",
  clickerId: "U1",
  pendingId: "pend_1",
  execution: { ran: "ok", line: "the meeting bot was sent to General" },
  forwardsWork: true,
};
const decisionBodies: Array<[string, string]> = [
  ["decision approved/ran", approvalDecisionBody(decisionInput)],
  ["decision approved/failed", approvalDecisionBody({ ...decisionInput, execution: { ran: "failed", line: "FAILED: no voice channel" } })],
  ["decision approved/armed", approvalDecisionBody({ ...decisionInput, armsCall: true })],
  ["decision approved/no-fact", approvalDecisionBody({ ...decisionInput, execution: undefined })],
  ["decision rejected", approvalDecisionBody({ ...decisionInput, outcome: "rejected", execution: undefined })],
  ["decision expired", approvalDecisionBody({ ...decisionInput, outcome: "expired", clickerId: undefined, execution: undefined })],
];

const templates: Array<[string, string]> = [
  ["agent/instructions.md", readFileSync(join(REPO_ROOT, "agent", "instructions.md"), "utf8")],
  ["packages/create/template/agent/instructions.md", readFileSync(join(REPO_ROOT, "packages", "create", "template", "agent", "instructions.md"), "utf8")],
];

const replySource = readFileSync(join(REPO_ROOT, "packages", "core", "agent", "tools", "reply.ts"), "utf8");
const replyLiterals = (replySource.match(/"(?:[^"\\\n]|\\.)*"/gu) ?? []).join(" ");
ok(replyLiterals.includes("pass `done: false`"), "§1/CONTROL: the literal scan really reads the reply tool's descriptions");

const corpus: Array<[string, string]> = [
  ["reply tool descriptions (tools/reply.ts string literals)", replyLiterals],
  ["worker-capability index, standing seat", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_STANDING, "agent", undefined, "spawn_thread_session")],
  ["worker-capability index, thread seat", renderWorkerCapabilityIndex(WORKER_ONLY_TOOLS_THREAD, "agent")],
  ...seatPersonas,
  ...workerPersonas,
  ["dm seat", renderDmSeatPersona()],
  ["WORK_FORWARD_SECTION", WORK_FORWARD_SECTION],
  ["work receipt FORWARDED_NOTE", FORWARDED_NOTE],
  ["work receipt freshFollowUpNote", freshFollowUpNote("task_0")],
  ["reply refusal delegationPendingRefusalMessage", delegationPendingRefusalMessage()],
  ["no_reply refusal settlementReportOwedMessage", settlementReportOwedMessage()],
  ["reply note PENDING_WORK_INSTRUCTION", PENDING_WORK_INSTRUCTION],
  ["result note completed", resultNote("completed")],
  ["result note failed", resultNote("failed")],
  ["result note cancelled", resultNote("cancelled")],
  ["result note rotated", resultNote("completed", { rotated: { brief: true } })],
  ...decisionBodies,
  ...templates,
];

const NARRATION_ASKS: ReadonlyArray<[RegExp, string]> = [
  [/hand-off note/iu, "a 'hand-off note' (the posting paragraph, the reply refusal)"],
  [/that the work has started/iu, "'tell the people who asked that the work has started' (the work section, the work receipt)"],
  [/\bsay (?:that )?you (?:have )?handed\b/iu, "'Say you have handed it off' (the template instructions)"],
  [/\bsay plainly that it is,/iu, "'say plainly that it is [running]' as the hand-off carve-out's ask"],
  [/\bit is TRUE on the turn the call\s+really goes out\b/u, "the measured hand-off sentence ruled TRUE, and so allowed, on a turn with a call"],
  [/\bsay you have routed it\b/iu, "'Route it, say you have routed it' (the worker-capability index)"],
  [/\bhanding (?:this|it) off\b/iu, "a model sentence 'handing this off — will report back' (the worker-capability index)"],
  [/\backnowledge the hand-off\b/iu, "'acknowledge the hand-off in the same turn' (the worker-capability index)"],
  [/\bsay (?:plainly )?that (?:it|the worker|a worker) is (?:still )?running\b/iu, "'say plainly that it is still running', a worker-as-subject narration (cold review, finding 5)"],
];
for (const [name, text] of corpus) {
  for (const [re, what] of NARRATION_ASKS) {
    ok(!re.test(flat(text)), `🔴 §1: ${name} does not ask for ${what}`);
  }
}

const RULE = flat(NO_HANDOFF_NARRATION_RULE);
ok(/handed the work off/u.test(RULE) && /a worker or a work session has it/u.test(RULE), "§2: the rule names the hand-off and the worker, the two things the measured post narrated");
ok(/Until the result arrives, say what will happen\. On a message that did not address you, you may say nothing\./u.test(RULE), "§2: …and says what to do instead, and allows silence only off an addressed message, so the addressed line that arms the settlement duty stays");
ok(/When the message addressed you, post one short line that says what will happen/u.test(WORK_FORWARD_SECTION), "🔴 §2: the work section keeps the in-flight line mandatory on an addressed message (cold review, finding 4)");
ok(/When the message addressed you, post one short line that says what will happen/u.test(FORWARDED_NOTE), "🔴 §2: …and so does the work receipt");
for (const [name, text] of [...seatPersonas, ...workerPersonas]) {
  ok(flat(text).includes(RULE), `🔴 §2: ${name} renders NO_HANDOFF_NARRATION_RULE (the honest-ack carve-out carries it on every arm)`);
}
ok(flat(postingIsAnActionParagraph("A reply ends your turn")).includes(RULE), "🔴 §2: the posting paragraph — the source that asked for 'a short hand-off note' — carries the rule");
ok(flat(FORWARDED_NOTE).includes(RULE), "🔴 §2: the `work` receipt carries the rule — the model reads it the instant it forwards, which is when the live seat posted the narration");
ok(/Never say that you forwarded, handed off or delegated the job/u.test(WORK_FORWARD_SECTION), "🔴 §2: the forwarding seat's own section forbids the narration in its own words");
for (const [name, text] of templates) {
  ok(/Do not tell the room that you\s+handed it off or that a worker has it/u.test(text), `🔴 §2: ${name} forbids the narration where it used to ask for it`);
}
ok(/still working on it/u.test(PENDING_WORK_INSTRUCTION), "§2/CONTROL: the host's 'still working on it' line stays — it narrates no hand-off");
ok(/say in one line what you are doing — what will happen,\s+never that you handed it off/u.test(seatPersonas[0]![1]), "§2/CONTROL: the addressed-reply rule still orders one line, and now says which line");

const CARD = flat(CARD_OUTCOME_RULE);
ok(/Never post a reply that restates, confirms or corrects that outcome/u.test(CARD), "§3: the card rule forbids all three measured shapes — a restatement, a confirmation and a correction");
ok(/not even when a worker's report about the same act is out of date/u.test(CARD), "§3: …and names the live case, a stale worker report, so the seat cannot read a correction as new information");
ok(/What a job did after the card was decided is not on the card: the act an approval only allowed, or a later run of it by the job that failed\. Post that\./u.test(CARD), "🔴 §3: the card rule never silences what is not on the card — an armed act or a failed run (cold review, finding 1)");
ok(!/or a run that failed/u.test(CARD) && !/or a run that failed/u.test(settlementReportOwedMessage()), "🔴 §3: a failed run the APPROVAL made is on the card (card.ts renders FAILED:), so neither text orders it posted — only the job's own later run (re-review, finding 3)");
ok(!/says something different/u.test(CARD), "🔴 §3: …and it no longer forbids a report that differs from the card, which is how a failed armed call would have been dropped");
const CARD_SHOWS_ALL = new Set(["decision approved/ran", "decision rejected", "decision expired"]);
for (const [name, text] of decisionBodies) {
  ok(flat(text).includes(CARD), `🔴 §3: ${name} carries the card rule — the decision wake is the turn that holds the outcome`);
  if (CARD_SHOWS_ALL.has(name)) {
    ok(/do not post a correction of it/u.test(text), `🔴 §3: ${name} reaches forward to the later result turn, where the live correction was posted`);
  } else {
    ok(!/do not post a correction of it/u.test(text), `🔴 §3: ${name} does NOT ban the later report — the card does not show what the job did after the decision (cold review, finding 1)`);
  }
}
const armed = approvalDecisionBody({ ...decisionInput, armsCall: true });
const replay = approvalDecisionBody({ ...decisionInput, armsCall: true, replay: { connection: "linear", tool: "save_issue" } });
ok(/When the job reports back, tell the room what it did/u.test(armed), "🔴 §3/CONTROL: the armed closing still orders the room told what the job did");
ok(/When the replay reports back, tell the room what it did/u.test(replay) && !/do not post a correction of it/u.test(replay), "🔴 §3/CONTROL: …and so does the replay closing, with no contradicting ban beside it");
ok(!/tell the room it failed/u.test(decisionBodies[1]![1]) && /The card already shows the failure/u.test(decisionBodies[1]![1]), "§3: a failed run's notice no longer orders a restatement of the failure the card shows");
for (const status of ["completed", "failed"] as const) {
  const note = resultNote(status);
  ok(flat(note).includes(CARD), `🔴 §3: the ${status} job-result note carries the card rule — this note drew the live fifth post`);
  ok(/If the result adds nothing beyond the card, end this turn with `no_reply` \(reason `nothing_to_add`\)/u.test(note), `🔴 §3: …and the ${status} note names the silent move`);
  ok(!/You told this conversation you had started it/u.test(note), `§3: the ${status} note no longer assumes a hand-off post the seat no longer makes`);
  ok(/Its address is on the next line:\nwake-id: wk_ask\n|Its address is on the next line:\n[^\n]*wk_ask/u.test(note), `§3/CONTROL: the ${status} note still puts the address on its own line, not last`);
}
for (const [name, text] of seatPersonas) {
  ok(flat(text).includes(CARD), `🔴 §3: ${name} renders the card rule`);
}
ok(/shows that the act ran, or that it was rejected or expired, and the report adds nothing beyond it, the card is the report\. Then call `no_reply` again/u.test(settlementReportOwedMessage()), "🔴 §3: the settlement-duty refusal names the card case, so the duty cannot force the restatement");
ok(/An act the approval only allowed, or a later run of it by the job that failed, is not on the card: post it\./u.test(settlementReportOwedMessage()), "🔴 §3: …and its exit is narrow: it never lets the seat drop an armed act's or a failed run's report (cold review, finding 1)");
ok(settlementReportOwedMessage().includes("`reply`"), "§3/CONTROL: …and it still names `reply`, the move that keeps every other promise");

const PRE_FIX: ReadonlyArray<string> = [
  "So `reply` before the result only when the person should hear something now, such as a short hand-off note;",
  "It returns at once and your turn does not wait: tell the people who asked that the work has started (`reply` with `done:false`).",
  "Forwarded to this conversation's work session. Your turn does not wait on it: tell the people who asked that the work has started (reply with done:false), then carry on.",
  "Name an id only when the person named it. Say you have handed it off, and report it done only when the worker's own report says it is done.",
  "something really is running: say plainly that it is, and that its result comes back here",
  "same fabrication on a turn that called no worker, and it is TRUE on the turn the call really goes out.",
  "Post a short hand-off note with `done:false` instead.",
  "discouraged rather than blocked. For a hand-off note whose full answer comes later, pass `done: false`.",
  "And never say you cannot do something that a worker can. Route it, say you have routed it, and come back with the answer.",
  'Routed work is NOT done until the worker reports back: acknowledge it is underway ("handing this off — will report back"), and never tell the room',
  "If this wake owes an answer — it addressed you, or you promised one — acknowledge the hand-off in the same turn with `done: false`, which keeps the wake open for the real answer.",
  "A worker a call really started stays real afterwards: on a later turn say plainly that it is still running, and report what it found when its notice arrives.",
];
for (const text of PRE_FIX) {
  ok(NARRATION_ASKS.some(([re]) => re.test(flat(text))), `§4: a pattern catches the pre-fix source "${text.slice(0, 60)}…"`);
}

console.log(`seat-chatter-test: ${n} assertions passed`);
