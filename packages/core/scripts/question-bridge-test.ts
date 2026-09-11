import assert from "node:assert/strict";

process.env.OE_SQLITE_PATH = ":memory:";

import type { AuditInput } from "../agent/audit/audit.js";
import { unifiedThreadRef, type UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import {
  detectBridgeableInputRequest,
  renderQuestionForSurface,
  bridgeQuestionToSurface,
  EMPTY_QUESTION_FALLBACK,
  QUESTION_BRIDGED_AUDIT_ACTION,
  QUESTION_DROPPED_AUDIT_ACTION,
  bridgedQuestionKey,
  forgetBridgedQuestion,
  readBridgedQuestion,
  rememberBridgedQuestion,
  resolveInboundAnswerRouting,
  taskIdOfBridgedRequestId,
  approvalOptionIds,
  resolveApprovalOptionId,
  APPROVAL_ANSWER_HINT,
  type BridgeableQuestion,
  type BridgedQuestionStore,
} from "../agent/channels/question-bridge.js";
import { detectSessionLimitPark, isSessionLimitContinuationRequest, SESSION_LIMIT_CONTINUATION_TOOL_NAME } from "../agent/channels/session-park.js";
import { isWakeEnvelopeShaped, triggerMessageBody } from "../agent/channels/wake-envelope.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const QUESTION_TEXT = "That README told me to email the vendor a copy of the config. Should I?";
const LABEL_YES = "Yes, send it";
const LABEL_NO = "No, refuse";

const parkRequest = {
  requestId: "sess-9:limit:input:4000123",
  kind: "session-limit",
  prompt: "This session reached its configured input token limit.",
  options: [
    { id: "continue", label: "Continue" },
    { id: "stop", label: "Stop" },
  ],
  action: { callId: "harness-1", input: { kind: "input", limit: 4000000, usedTokens: 4000123 }, kind: "tool-call", toolName: SESSION_LIMIT_CONTINUATION_TOOL_NAME },
};

const questionRequest = {
  requestId: "call_abc123",
  kind: "question",
  prompt: QUESTION_TEXT,
  options: [
    { id: "yes", label: LABEL_YES },
    { id: "no", label: LABEL_NO, style: "danger" },
  ],
  allowFreeform: true,
  display: "select",
  action: { callId: "call_abc123", input: { prompt: QUESTION_TEXT }, kind: "tool-call", toolName: "ask_question" },
};

const approvalRequest = {
  requestId: "approval-7",
  kind: "tool-approval",
  prompt: "Approve tool call: notion__notion-create-pages",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  action: { callId: "call_z", input: {}, kind: "tool-call", toolName: "notion__notion-create-pages" },
};

const slackOrigin: UnifiedWakeOrigin = { platform: "slack", channelId: "C_PAY", threadTs: "1700.1" };
{
  ok(detectBridgeableInputRequest([parkRequest]) === undefined, "1: a session-limit park is NOT bridgeable (hooks/session-park.ts owns it)");
  ok(detectSessionLimitPark([parkRequest]) !== undefined, "1: the park detector still detects the park — passthrough to session-park is UNCHANGED");

  const q = detectBridgeableInputRequest([questionRequest]);
  ok(q !== undefined, "1: an ask_question IS bridgeable");
  ok(detectSessionLimitPark([questionRequest]) === undefined, "1: the park detector does NOT claim an ask_question");

  ok(detectBridgeableInputRequest([approvalRequest]) !== undefined, "1: a tool-approval is bridgeable too (any non-park request)");
  ok(detectSessionLimitPark([approvalRequest]) === undefined, "1: the park detector does NOT claim a tool-approval");

  for (const r of [parkRequest, questionRequest, approvalRequest]) {
    const claimedByPark = detectSessionLimitPark([r]) !== undefined;
    const claimedByBridge = detectBridgeableInputRequest([r]) !== undefined;
    ok(claimedByPark !== claimedByBridge, `1: exactly one detector claims ${r.action.toolName}`);
    ok(claimedByPark === isSessionLimitContinuationRequest(r), `1: the park claim IS the shared predicate for ${r.action.toolName}`);
  }

  ok(detectSessionLimitPark([parkRequest, questionRequest]) !== undefined, "1: a mixed batch still parks");
  ok(detectBridgeableInputRequest([parkRequest, questionRequest])?.requestId === "call_abc123", "1: a mixed batch still bridges the question (park entries skipped, not fatal)");

  for (const junk of [undefined, null, {}, "requests", [], [null], [42], [{ action: {} }]]) {
    ok(detectBridgeableInputRequest(junk as unknown) === undefined || Array.isArray(junk), `1: junk input (${JSON.stringify(junk)}) does not throw`);
  }
  ok(detectBridgeableInputRequest([null, questionRequest])?.toolName === "ask_question", "1: a null entry is skipped, not fatal");
  ok(detectBridgeableInputRequest([{ action: { toolName: "ask_question" } }])?.prompt === "", "1: a promptless request is STILL returned (dropping it would recreate the silence)");
  ok(detectBridgeableInputRequest([{ action: { toolName: "ask_question" } }])?.kind === "unknown", "1: a request with no `kind` degrades to \"unknown\"");
  ok(detectBridgeableInputRequest([{ requestId: "r1", prompt: "hi" }])?.toolName === "unknown", "1: a request with no action.toolName degrades to \"unknown\" (and is still bridged)");
}

{
  const q = detectBridgeableInputRequest([questionRequest])!;
  ok(q.options.length === 2 && q.options[0]!.label === LABEL_YES && q.options[1]!.label === LABEL_NO, "2: option LABELS are extracted, in order");
  ok(q.options[0]!.id === "yes" && q.options[1]!.id === "no", "2: …and their IDS ride along (OPE-1056 — an approval cannot be settled without one); styles are still dropped");
  ok(Object.keys(q.options[1]!).sort().join(",") === "id,label", "2: …so an option carries the two fields the bridge needs and nothing else (the fixture's `style` is dropped)");
  const text = renderQuestionForSurface(q);
  ok(text.startsWith(QUESTION_TEXT), "2: the question leads the post");
  ok(text.includes(`• ${LABEL_YES}`) && text.includes(`• ${LABEL_NO}`), "2: options render as a plain surface-agnostic list");

  const noOpts = renderQuestionForSurface({ requestId: "r", toolName: "ask_question", kind: "question", prompt: "  Ship it?  ", options: [] });
  ok(noOpts === "Ship it?", "2: no options ⇒ just the trimmed question, no decoration");

  const empty = renderQuestionForSurface({ requestId: "r", toolName: "ask_question", kind: "question", prompt: "   ", options: [] });
  ok(empty === EMPTY_QUESTION_FALLBACK, "2: an empty prompt posts the HOST-authored fallback — a parked turn the room can still unpark");
}

const scope = { org: "acme", platform: "unified", workspace: "payments", surface: "oe-domain::payments", sessionId: "sess-9", wakeId: "w-42" };
const question: BridgeableQuestion = detectBridgeableInputRequest([questionRequest])!;

function sink(): { rows: AuditInput[]; audit: (e: AuditInput) => Promise<void> } {
  const rows: AuditInput[] = [];
  return {
    rows,
    audit: async (e: AuditInput) => {
      rows.push(e);
    },
  };
}

{
  const s = sink();
  const posts: Array<{ origin: UnifiedWakeOrigin; text: string }> = [];
  const outcome = await bridgeQuestionToSurface(scope, question, {
    resolveOrigin: async () => slackOrigin,
    post: async (origin, text) => {
      posts.push({ origin, text });
      return "msg-1";
    },
    audit: s.audit,
  });
  ok(outcome.status === "bridged" && outcome.id === "msg-1" && outcome.platform === "slack", "3a: a resolvable wake + a live post ⇒ bridged");
  ok(posts.length === 1 && posts[0]!.origin === slackOrigin, "3a: posted EXACTLY once, to the wake's own origin (the reply route's target, never an addressed one)");
  ok(posts[0]!.text.includes(QUESTION_TEXT), "3a: the room gets the real question text");
  ok(s.rows.length === 1 && s.rows[0]!.action === QUESTION_BRIDGED_AUDIT_ACTION, "3a: exactly one turn.question_bridged row");
  const d = s.rows[0]!.detail as Record<string, unknown>;
  ok(s.rows[0]!.org === "acme" && s.rows[0]!.platform === "unified" && s.rows[0]!.workspace === "payments", "3a: the row is partitioned like every other unified row (platform=unified)");
  ok(d.platform === "slack", "3a: the ORIGIN platform — where the question actually landed — rides the detail");
  ok(d.id === "msg-1" && d.requestId === "call_abc123" && d.toolName === "ask_question" && d.kind === "question", "3a: ids + eve-owned enums are recorded");
  ok(d.options === 2 && typeof d.chars === "number" && (d.chars as number) > 0, "3a: option COUNT and rendered length, not content");
  ok(d.wakeId === "w-42" && d.sessionId === "sess-9", "3a: the wake + session join keys are stamped");
}

for (const [label, resolveOrigin] of [
  ["a wake with no map row", async () => null],
  ["an origin lookup that THREW", async () => { throw new Error("store down"); }],
] as ReadonlyArray<[string, () => Promise<UnifiedWakeOrigin | null>]>) {
  const s = sink();
  let posted = false;
  const outcome = await bridgeQuestionToSurface(scope, question, {
    resolveOrigin,
    post: async () => {
      posted = true;
      return "never";
    },
    audit: s.audit,
  });
  ok(outcome.status === "dropped" && outcome.reason === "unresolved-origin", `3b: ${label} ⇒ dropped(unresolved-origin), no throw`);
  ok(!posted, `3b: ${label} ⇒ nothing was posted anywhere`);
  ok(s.rows.length === 1 && s.rows[0]!.action === QUESTION_DROPPED_AUDIT_ACTION, `3b: ${label} ⇒ exactly one turn.question_dropped row (the silent-with-no-row outcome is now impossible)`);
  ok((s.rows[0]!.detail as Record<string, unknown>).reason === "unresolved-origin", `3b: ${label} ⇒ the reason distinguishes it from a post failure`);
}

{
  const s = sink();
  const outcome = await bridgeQuestionToSurface(scope, question, {
    resolveOrigin: async () => slackOrigin,
    post: async () => {
      throw new Error("slack chat.postMessage failed: channel_not_found");
    },
    audit: s.audit,
  });
  ok(outcome.status === "dropped" && outcome.reason === "post-failed", "3c: a throwing post arm ⇒ dropped(post-failed), no throw");
  ok(s.rows.length === 1 && s.rows[0]!.action === QUESTION_DROPPED_AUDIT_ACTION, "3c: exactly one turn.question_dropped row");
  const d = s.rows[0]!.detail as Record<string, unknown>;
  ok(d.reason === "post-failed" && d.platform === "slack", "3c: the failing surface is named");
  ok(typeof d.error === "string" && (d.error as string).includes("channel_not_found"), "3c: the arm's error is carried, so the failure is diagnosable");
}

{
  const s = sink();
  await bridgeQuestionToSurface(scope, question, {
    resolveOrigin: async () => slackOrigin,
    post: async () => {
      throw new Error("x".repeat(5000));
    },
    audit: s.audit,
  });
  ok(((s.rows[0]!.detail as Record<string, unknown>).error as string).length === 300, "3c: the error string is capped at 300 chars");
}

{
  const outcome = await bridgeQuestionToSurface(scope, question, {
    resolveOrigin: async () => slackOrigin,
    post: async () => "msg-2",
    audit: async () => {
      throw new Error("audit store down");
    },
  });
  ok(outcome.status === "bridged", "3: a failing audit sink never breaks the bridge (best-effort, house posture)");
}

{
  const all: AuditInput[] = [];
  const collect = async (e: AuditInput): Promise<void> => {
    all.push(e);
  };
  await bridgeQuestionToSurface(scope, question, { resolveOrigin: async () => slackOrigin, post: async () => "m", audit: collect });
  await bridgeQuestionToSurface(scope, question, { resolveOrigin: async () => null, post: async () => "m", audit: collect });
  await bridgeQuestionToSurface(scope, question, {
    resolveOrigin: async () => slackOrigin,
    post: async () => {
      throw new Error("boom");
    },
    audit: collect,
  });
  ok(all.length === 3, "4: three paths, three rows");
  const serialised = JSON.stringify(all);
  ok(!serialised.includes(QUESTION_TEXT), "4: the model-authored PROMPT is in no row (it may carry attacker-derived content)");
  ok(!serialised.includes(LABEL_YES) && !serialised.includes(LABEL_NO), "4: model-authored option LABELS are in no row — only their count");
}

{
  const { registerSlackFixtureMapper, registerSlackFixturePostArm, registerSlackFixtureCodec, registerSlackTestBridge } = await import("./_slack-test-stubs.js");
  registerSlackFixtureMapper();
  registerSlackFixturePostArm();
  registerSlackFixtureCodec();
  registerSlackTestBridge();

  const unified = (await import("../agent/channels/unified.js")).default as unknown as { adapter?: Record<string, unknown> };
  ok(typeof unified.adapter?.["input.requested"] === "function", "5: the unified channel registers an input.requested handler through eve's own defineChannel builder");
  ok(typeof unified.adapter?.["message.completed"] === "function", "5: message.completed still registers (the bridge ADDS an edge, it does not move one)");

  const parkHook = (await import("../agent/hooks/session-park.js")).default as unknown as { events: Record<string, unknown> };
  ok(typeof parkHook.events["input.requested"] === "function", "5: hooks/session-park.ts STILL subscribes to input.requested — the park path is untouched");
}

{
  const TASK_REQUEST_ID = "task_abc123:call_child_1";
  const OWN_REQUEST_ID = "call_window_1";
  const TOKEN = "oe-dom:acme:oe-sup:g3";

  const makeStore = (): BridgedQuestionStore & { rows: Map<string, string> } => {
    const rows = new Map<string, string>();
    return {
      rows,
      putTaskResult: async (_org, key, json) => void rows.set(key, json),
      getTaskResult: async (_org, key) => rows.get(key) ?? null,
      deleteTaskResult: async (_org, key) => rows.delete(key),
    };
  };
  const throwingStore: BridgedQuestionStore = {
    putTaskResult: async () => {
      throw new Error("store down");
    },
    getTaskResult: async () => {
      throw new Error("store down");
    },
    deleteTaskResult: async () => {
      throw new Error("store down");
    },
  };

  ok(taskIdOfBridgedRequestId(TASK_REQUEST_ID) === "task_abc123", "6: a task-namespaced request id yields its owning task (eve's `<taskId>:<childRequestId>`)");
  ok(taskIdOfBridgedRequestId(OWN_REQUEST_ID) === undefined, "6: the window's OWN question has no task — a bare call id yields undefined");
  ok(taskIdOfBridgedRequestId("agent_x:call_1") === undefined, "6: a colon alone is not enough — the head must be `task_`-prefixed, so this stays a derivation and not a guess");
  ok(taskIdOfBridgedRequestId(":call_1") === undefined, "6: a leading colon is not a task id");

  {
    const store = makeStore();
    ok(await rememberBridgedQuestion(store, "o1", TOKEN, { requestId: TASK_REQUEST_ID, wakeId: "w1" }), "6: a bridged question is remembered");
    const got = await readBridgedQuestion(store, "o1", TOKEN);
    ok(got?.requestId === TASK_REQUEST_ID, "6: …and reads back the PARENT-VISIBLE request id, which is the only value that can route");
    ok(got?.wakeId === "w1" && got?.taskId === "task_abc123", "6: …with the wake it was raised on and the derived task, for the audit join");
    ok(JSON.stringify(store.rows.get(bridgedQuestionKey(TOKEN))).includes(TASK_REQUEST_ID), "6: the row is keyed by WINDOW TOKEN — that is what the next inbound message is matched on");
    ok(await readBridgedQuestion(store, "o1", "some-other-token") === undefined, "6: …and a DIFFERENT window has no outstanding question (one row per token, never global)");
    ok(await forgetBridgedQuestion(store, "o1", TOKEN), "6: forget removes the row");
    ok(await readBridgedQuestion(store, "o1", TOKEN) === undefined, "6: 🔴 CONSUME-ONCE — after the answer, the window is back to ordinary wakes");
    ok((await forgetBridgedQuestion(store, "o1", TOKEN)) === false, "6: forgetting twice reports no row, it does not throw");
  }

  {
    const store = makeStore();
    await rememberBridgedQuestion(store, "o1", TOKEN, { requestId: TASK_REQUEST_ID, wakeId: "w1" });
    ok(!JSON.stringify([...store.rows.values()]).includes(QUESTION_TEXT), "6: 🔴 the model-authored prompt is in no ROW either — the room holds the text, this holds the address");
  }

  ok((await rememberBridgedQuestion(throwingStore, "o1", TOKEN, { requestId: TASK_REQUEST_ID })) === false, "6: a store that throws on write reports false and does not throw");
  ok((await readBridgedQuestion(throwingStore, "o1", TOKEN)) === undefined, "6: a store that throws on read is 'no question' — the message stays an ordinary wake");
  ok((await forgetBridgedQuestion(throwingStore, "o1", TOKEN)) === false, "6: a store that throws on delete reports false and does not throw");
  ok((await rememberBridgedQuestion(makeStore(), "o1", TOKEN, { requestId: "" })) === false, "6: an empty request id is not remembered — nothing could route it");
  ok((await rememberBridgedQuestion(makeStore(), "o1", "", { requestId: TASK_REQUEST_ID })) === false, "6: …nor is a question with no window token to key it on");
  {
    const store = makeStore();
    store.rows.set(bridgedQuestionKey(TOKEN), "{not json");
    ok((await readBridgedQuestion(store, "o1", TOKEN)) === undefined, "6: a corrupt row is 'no question', not a throw");
    store.rows.set(bridgedQuestionKey(TOKEN), JSON.stringify({ wakeId: "w1" }));
    ok((await readBridgedQuestion(store, "o1", TOKEN)) === undefined, "6: a row with no request id is 'no question' — half a row can never address an answer");
  }

  const ROOM_A = "slack:C_ASKED";
  const ROOM_B = "slack:C_ELSEWHERE";
  const outstanding = { requestId: TASK_REQUEST_ID, containerKey: ROOM_A, wakeId: "w1", taskId: "task_abc123", at: "2026-08-15T00:00:00.000Z" };
  const allow = async (): Promise<{ ok: true; floor: string }> => ({ ok: true, floor: "member" });
  {
    const routed = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_A }, { read: async () => outstanding, admit: allow });
    ok(routed.kind === "answer", "6: ⭐ an attended message IN THE ASKING ROOM with an outstanding question is an ANSWER");
    ok(routed.kind === "answer" && routed.requestId === TASK_REQUEST_ID, "6: …addressed to the exact request id eve's proxy map is keyed on");
    ok(routed.kind === "answer" && routed.floor === "member" && routed.taskId === "task_abc123", "6: …carrying the resolved floor and the derived task for the routed audit row");
  }
  {
    let admits = 0;
    const countingAllow = async (): Promise<{ ok: true; floor: string }> => {
      admits++;
      return { ok: true, floor: "member" };
    };
    const routed = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_B }, { read: async () => outstanding, admit: countingAllow });
    ok(routed.kind === "wake" && routed.reason === "foreign-room", "6: 🔴 a message from ANOTHER ROOM on the same window token is an ordinary WAKE — it is not eaten as the answer");
    ok(admits === 0, "6: 🔴 …and no admission runs for it: that person was not answering anything, so no refusal row is written against them");
  }
  {
    const noStored = { requestId: TASK_REQUEST_ID, wakeId: "w1", at: "2026-08-15T00:00:00.000Z" };
    const a = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_A }, { read: async () => noStored, admit: allow });
    ok(a.kind === "wake" && a.reason === "foreign-room", "6: 🔴 a row with NO stored room never answers — a pre-fix row on disk fails soft, it does not fail open");
    const b = await resolveInboundAnswerRouting({ internalDispatch: false }, { read: async () => outstanding, admit: allow });
    ok(b.kind === "wake" && b.reason === "foreign-room", "6: 🔴 an inbound wake whose room could not be derived never answers either");
    const c = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: "" }, { read: async () => ({ ...outstanding, containerKey: "" }), admit: allow });
    ok(c.kind === "wake" && c.reason === "foreign-room", "6: 🔴 two EMPTY room keys are not a match — an absent value never equals itself into an answer");
  }
  {
    const routed = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_A }, { read: async () => undefined, admit: allow });
    ok(routed.kind === "wake" && routed.reason === "no-question", "6: 🔴 a message with NO outstanding question routes as an ordinary WAKE — the window is not permanently in answer mode");
  }
  {
    let reads = 0;
    const routed = await resolveInboundAnswerRouting(
      { internalDispatch: true, containerKey: ROOM_A },
      {
        read: async () => {
          reads++;
          return outstanding;
        },
        admit: allow,
      },
    );
    ok(routed.kind === "wake" && routed.reason === "internal-dispatch", "6: 🔴 an INTERNAL dispatch (task spawn, completion wake, redrive) never resolves a question");
    ok(reads === 0, "6: …and short-circuits before the store read — the outstanding row is untouched, so the human can still answer");
  }
  {
    const routed = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_A }, { read: async () => outstanding, admit: async () => ({ ok: false }) });
    ok(routed.kind === "wake" && routed.reason === "refused", "6: 🔴 a REFUSED answerer does not answer — the message becomes an ordinary wake and the question stays open");
  }
  {
    let admits = 0;
    await resolveInboundAnswerRouting(
      { internalDispatch: false, containerKey: ROOM_A },
      {
        read: async () => undefined,
        admit: async () => {
          admits++;
          return { ok: true, floor: "member" };
        },
      },
    );
    ok(admits === 0, "6: the admission is not called when there is no outstanding question — no roster call on the ordinary path");
  }
  {
    const store = makeStore();
    ok(
      (await rememberBridgedQuestion(store, "o1", TOKEN, { requestId: TASK_REQUEST_ID, containerKey: ROOM_A, wakeId: "w1" })) === true,
      "6: a question records the room it was posted into",
    );
    const back = await readBridgedQuestion(store, "o1", TOKEN);
    ok(back?.containerKey === ROOM_A, "6: 🔴 …and the room survives the store round trip — the fence compares a real value, not undefined");
    const roundTripped = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_A }, { read: async () => back, admit: allow });
    ok(roundTripped.kind === "answer", "6: …so the SAME room answers off the stored row");
    const elsewhere = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_B }, { read: async () => back, admit: allow });
    ok(elsewhere.kind === "wake" && elsewhere.reason === "foreign-room", "6: …and another room still does not, off that same stored row");
  }

  {
    const { readFileSync } = await import("node:fs");
    const unifiedSrc = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    ok(/admitInputResponse\(\{/.test(unifiedSrc), "6: 🔴 the live decision runs the SAME admission the Slack/Teams widget arms run (approvals/input-response-floor.ts) — the transport is not the control");
    ok(/\.respond\(\[\{ requestId: /.test(unifiedSrc), "6: …and the channel answers with `respond([{requestId, …}])`, the one shape routeDeliverPayload can route to a child");
    ok(/rememberBridgedQuestion\(/.test(unifiedSrc), "6: …and the input.requested handler writes the row a later answer is matched on");
    ok(/forgetBridgedQuestion\(/.test(unifiedSrc), "6: …and consumes it once the answer is delivered");
  }
}

{
  console.log("\n7. the bridged row names the room (OPE-1231):");
  const posts: { origin: UnifiedWakeOrigin; text: string }[] = [];
  const s = sink();
  const outcome = await bridgeQuestionToSurface(scope, question, {
    resolveOrigin: async () => slackOrigin,
    post: async (origin, text) => {
      posts.push({ origin, text });
      return "msg-room-1";
    },
    audit: s.audit,
  });
  ok(outcome.status === "bridged", "7: the question bridged");
  ok(posts.length === 1 && posts[0]!.origin === slackOrigin, "7: …to the origin it was handed, once (the row below describes THAT post)");
  const d = s.rows[0]!.detail as Record<string, unknown>;
  const expected = unifiedThreadRef(slackOrigin).channelKey;
  ok(typeof expected === "string" && expected.length > 0, "7: the fixture codec really derives a container key (else the line below would assert nothing)");
  ok(d.containerKey === expected, `7: 🔴 the row names the CONTAINER the post went to (${String(d.containerKey)})`);
  ok(d.containerKey !== undefined && String(d.containerKey).includes(slackOrigin.channelId), "7: …and that container carries the origin's own channel, not another room's");
  const serialised = JSON.stringify(s.rows);
  ok(!serialised.includes(QUESTION_TEXT), "7: adding the room did NOT bring the prompt with it");

  const sUnknown = sink();
  const unknownOrigin = { platform: "no-such-platform", channelId: "C_X" } as unknown as UnifiedWakeOrigin;
  const unknownOutcome = await bridgeQuestionToSurface(scope, question, {
    resolveOrigin: async () => unknownOrigin,
    post: async () => "msg-room-2",
    audit: sUnknown.audit,
  });
  ok(unknownOutcome.status === "bridged", "7: an undecodable origin still BRIDGES — the container is a field, never a gate");
  ok(sUnknown.rows.length === 1, "7: …and still writes exactly one row");
  ok((sUnknown.rows[0]!.detail as Record<string, unknown>).containerKey === undefined, "7: …with the container ABSENT rather than a guessed or empty value");
}

{
  console.log("\n8. a bridged approval can be answered (OPE-1056):");
  const approval = detectBridgeableInputRequest([approvalRequest])!;

  ok(approvalOptionIds(approval).join(",") === "approve,cancel", "8a: an approval's eve-minted option ids are the ones the row will store");
  ok(approvalOptionIds(detectBridgeableInputRequest([questionRequest])!).length === 0, "8a: 🔴 an ask_question contributes NO ids — its options are model-authored and the row stays ids-only");

  const approvalText = renderQuestionForSurface(approval, { answerByOption: true });
  ok(approvalText.includes("• Approve") && approvalText.includes("• Cancel"), "8b: the approval's options still render as the plain surface-agnostic list");
  ok(approvalText.includes(APPROVAL_ANSWER_HINT), "8b: 🔴 …and an APPROVAL carries the host-authored line saying a reply must name one — without it the room cannot know a bare answer parks");
  ok(!renderQuestionForSurface(detectBridgeableInputRequest([questionRequest])!, { answerByOption: true }).includes(APPROVAL_ANSWER_HINT), "8b: 🔴 NEGATIVE CONTROL: an ask_question gets NO hint even where the caller opts in — every reply answers one, so the line would be false there");
  ok(!renderQuestionForSurface(approval).includes(APPROVAL_ANSWER_HINT), "8b: 🔴 NEGATIVE CONTROL: and a caller that does NOT opt in gets no hint for an APPROVAL either — the Notion surface shares this renderer and its return leg cannot honour the line, so following it there would DENY the write");

  const OPTS = ["approve", "cancel"] as const;
  ok(resolveApprovalOptionId("Approve", [...OPTS]) === "approve", "8c: the option LABEL answers, because eve's labels lowercase to its ids");
  ok(resolveApprovalOptionId("  approve.  ", [...OPTS]) === "approve", "8c: …after trimming and stripping surrounding punctuation");
  ok(resolveApprovalOptionId("yes", [...OPTS]) === "approve", "8c: a small authored synonym vocabulary answers too");
  ok(resolveApprovalOptionId("Cancel", [...OPTS]) === "cancel", "8c: and the deny half");
  ok(resolveApprovalOptionId("no", [...OPTS]) === "cancel", "8c: …by synonym as well");
  ok(resolveApprovalOptionId("deny", ["approve", "deny"]) === "deny", "8c: the id the request ACTUALLY offered is the one returned — `deny` here, not a hardcoded `cancel`");
  ok(resolveApprovalOptionId("no", ["approve"]) === undefined, "8c: 🔴 a word can only select an id the request OFFERED — a request with no deny option cannot be denied");
  ok(
    resolveApprovalOptionId("no, that is the wrong page — use the other one", [...OPTS]) === undefined,
    "8c: 🔴 THE WHOLE MESSAGE MUST BE THE ANSWER — a correction that merely CONTAINS 'no' settles nothing, or prose steering the approval would decide it",
  );
  ok(resolveApprovalOptionId("approve the other one instead", [...OPTS]) === undefined, "8c: 🔴 …and the same on the approve side, which is the dangerous direction");
  ok(resolveApprovalOptionId("", [...OPTS]) === undefined, "8c: an empty reply names nothing");
  ok(resolveApprovalOptionId("maybe", [...OPTS]) === undefined, "8c: an unrelated word names nothing");

  const TOKEN8 = "oe-dom:payments:oe-sup:g1";
  const ROOM8 = unifiedThreadRef(slackOrigin).channelKey;
  const rows = new Map<string, string>();
  const store8: BridgedQuestionStore = {
    putTaskResult: async (_o, k, v) => void rows.set(k, v),
    getTaskResult: async (_o, k) => rows.get(k) ?? null,
    deleteTaskResult: async (_o, k) => rows.delete(k),
  };
  const allow8 = async (): Promise<{ ok: true; floor: string }> => ({ ok: true, floor: "member" });
  await rememberBridgedQuestion(store8, "o8", TOKEN8, {
    requestId: approval.requestId,
    containerKey: ROOM8,
    wakeId: "w-8",
    optionIds: approvalOptionIds(approval),
  });
  const stored = await readBridgedQuestion(store8, "o8", TOKEN8);
  ok(stored?.optionIds?.join(",") === "approve,cancel", "8d: 🔴 the option ids survive the JSON round trip — the answering turn cannot re-read the parked request, so this row is the only join");
  const rawRow = rows.get(bridgedQuestionKey(TOKEN8))!;
  ok(rawRow.includes("approve"), "8d: the raw stored row really is the row under test (else the redaction line below would assert nothing)");
  ok(!rawRow.includes("Approve tool call"), "8d: 🔴 …and the prompt never reaches the STORE (the redaction rule §4 states is untouched)");

  const approved = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM8, text: "Approve" }, { read: async () => stored, admit: allow8 });
  ok(approved.kind === "answer" && approved.optionId === "approve", "8d: 🔴 a reply naming the option answers WITH THAT OPTION ID — the field eve's resolveApprovalOutcome reads");
  const denied = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM8, text: "cancel" }, { read: async () => stored, admit: allow8 });
  ok(denied.kind === "answer" && denied.optionId === "cancel", "8d: …and the deny half carries its own id, so a REJECT is a real reject rather than an `invalid`");

  let admits8 = 0;
  const unmatched = await resolveInboundAnswerRouting(
    { internalDispatch: false, containerKey: ROOM8, text: "what page is this about?" },
    {
      read: async () => stored,
      admit: async () => {
        admits8++;
        return { ok: true, floor: "member" };
      },
    },
  );
  ok(unmatched.kind === "wake" && unmatched.reason === "unmatched-option", "8d: 🔴 a reply naming no option is an ordinary WAKE — the approval stays parked instead of being denied by accident");
  ok(admits8 === 0, "8d: …and spends no admission call, because that person was not answering the approval");
  ok((await readBridgedQuestion(store8, "o8", TOKEN8))?.requestId === approval.requestId, "8d: …and the row is LEFT IN PLACE, so the room can still answer");

  const qRow = { requestId: "call_abc123", containerKey: ROOM8, at: "2026-05-14T11:35:00.000Z" };
  const qRouted = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM8, text: "what page is this about?" }, { read: async () => qRow, admit: allow8 });
  ok(qRouted.kind === "answer" && qRouted.optionId === undefined, "8d: 🔴 NEGATIVE CONTROL: an ask_question row still answers on ANY text, and carries no optionId");

  rows.set(bridgedQuestionKey(TOKEN8), JSON.stringify({ requestId: approval.requestId, containerKey: ROOM8, at: "2026-05-05T23:30:00.000Z" }));
  const legacy = await readBridgedQuestion(store8, "o8", TOKEN8);
  ok(legacy?.optionIds === undefined, "8d: a PRE-FIX row on disk reads back with no option ids…");
  const legacyRouted = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM8, text: "anything" }, { read: async () => legacy, admit: allow8 });
  ok(legacyRouted.kind === "answer" && legacyRouted.optionId === undefined, "8d: …and routes exactly as it did then, rather than becoming unanswerable");

  const envelopeWith = (body: string): string =>
    `<wake reason="dm" addressing="direct-mention" current-time="2026-07-10T10:00:00.000Z" wake-id="wk_dm_1">\n` +
    `  <channel id="ch_c2xhY2s6RF9BTElDRQ" type="im" container="channel">\n` +
    `  <message trigger="true" from="human" trust="principal" mention="true" author="Rowan Hale" author-id="U1" handle="rowan" id="400.0" sent-at="1970-01-01T00:06:40.000Z">\n` +
    `    ${body}\n` +
    `  </message>\n  </channel>\n</wake>`;
  const dmEnvelope = envelopeWith("Approve");
  ok(isWakeEnvelopeShaped(dmEnvelope) && triggerMessageBody(dmEnvelope) === "Approve", "8dd: the fixture really is an envelope whose trigger body is the answer (else the two arms below assert nothing)");
  ok(resolveApprovalOptionId(dmEnvelope, [...OPTS]) === undefined, "8dd: 🔴 the RAW delivery matches NOTHING — this is the arm that makes reading the envelope load-bearing rather than tidy");
  ok(resolveApprovalOptionId(triggerMessageBody(dmEnvelope)!, [...OPTS]) === "approve", "8dd: 🔴 …and the trigger BODY taken out of that same delivery answers `approve`");
  ok(triggerMessageBody(`${envelopeWith("Approve")}\n${envelopeWith("hello")}`) === undefined, "8dd: 🔴 a COALESCED delivery names no single author, so it yields no body and can settle no approval");

  {
    const { readFileSync } = await import("node:fs");
    const unifiedSrc = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    ok(
      /\.respond\(\[\{ requestId: t\.answer\.requestId, text: answerText, \.\.\.\(t\.answer\.optionId \? \{ optionId: t\.answer\.optionId \} : \{\}\) \}\]/.test(unifiedSrc),
      "8e: 🔴 the channel really sends the optionId to eve — a resolution that never reaches `respond` settles nothing",
    );
    ok(/optionIds: approvalOptionIds\(question\)/.test(unifiedSrc), "8e: …and the input.requested handler really records the ids the answer is matched against");
    ok(/isWakeEnvelopeShaped\(input\.message\) \? triggerMessageBody\(input\.message\)/.test(unifiedSrc), "8e: 🔴 …and it matches the trigger BODY of the rendered wake, never the raw delivery");
    ok(/\.\.\.\(roomText !== undefined \? \{ text: roomText \} : \{\}\)/.test(unifiedSrc), "8e: …and that derived body is what reaches the routing decision, which is what selects the option");
  }
}

console.log(`question-bridge: ${n} assertions passed`);
