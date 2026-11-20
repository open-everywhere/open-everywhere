import assert from "node:assert/strict";

delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = ":memory:";

import type { InteractionKind, InteractionOpenedData } from "eve/events";
import {
  bridgeableQuestionOf,
  detectBridgeableInputRequest,
  renderQuestionForSurface,
  EMPTY_QUESTION_FALLBACK,
  QUESTION_DROPPED_AUDIT_ACTION,
  bridgedQuestionKey,
  forgetBridgedQuestion,
  readBridgedQuestion,
  rememberBridgedQuestion,
  resolveInboundAnswerRouting,
  type BridgedQuestionStore,
} from "../agent/channels/question-bridge.js";
import { detectSessionLimitPark, isSessionLimitContinuationRequest, SESSION_LIMIT_CONTINUATION_TOOL_NAME } from "../agent/channels/session-park.js";
import { classifySessionId, dmWindowKey, formatWindowToken, taskWindowId, threadSeatWindowId, workWindowId } from "../agent/channels/window-key.js";
import { isUnifiedSupervisorToken } from "../agent/channels/unified-supervisor.js";
import { readAudit } from "../agent/audit/audit.js";
import { deploymentOrg } from "../agent/identity/deployment-identity.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
const eveDist = (rel: string): string => pathToFileURL(join(eveRoot, "dist/src/context", rel)).href;
const { ContextContainer, contextStorage } = (await import(eveDist("container.js"))) as {
  ContextContainer: new () => { set(key: unknown, value: unknown): void };
  contextStorage: { run<T>(c: unknown, fn: () => Promise<T>): Promise<T> };
};
const { SessionKey } = (await import(eveDist("keys.js"))) as { SessionKey: unknown };
const { emptySessionView: rawEmptyView } = (await import(pathToFileURL(join(eveRoot, "dist/src/protocol/session-projection/fold.js")).href)) as { emptySessionView: () => unknown };
const inSession = <T>(fn: () => Promise<T>): Promise<T> => {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "sess-qb", auth: { current: null, initiator: null }, turn: { id: "turn-qb" }, parent: undefined });
  return contextStorage.run(c, fn);
};

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
  ok(q.options[0]!.id === "yes" && q.options[1]!.id === "no", "2: …and their IDS ride along; styles are dropped");
  ok(Object.keys(q.options[1]!).sort().join(",") === "id,label", "2: …so an option carries the two fields the bridge needs and nothing else (the fixture's `style` is dropped)");
  const text = renderQuestionForSurface(q);
  ok(text.startsWith(QUESTION_TEXT), "2: the question leads the post");
  ok(text.includes(`• ${LABEL_YES}`) && text.includes(`• ${LABEL_NO}`), "2: options render as a plain surface-agnostic list");

  const noOpts = renderQuestionForSurface({ requestId: "r", toolName: "ask_question", kind: "question", prompt: "  Ship it?  ", options: [] });
  ok(noOpts === "Ship it?", "2: no options ⇒ just the trimmed question, no decoration");

  const empty = renderQuestionForSurface({ requestId: "r", toolName: "ask_question", kind: "question", prompt: "   ", options: [] });
  ok(empty === EMPTY_QUESTION_FALLBACK, "2: an empty prompt posts the HOST-authored fallback — a parked turn the room can still unpark");
}
const V27_KIND: Record<string, string> = { question: "question", "tool-approval": "approval", "session-limit": "budget" };
type V26Request = typeof questionRequest | typeof approvalRequest | typeof parkRequest;
const opened = (r: V26Request, taskId?: string): { type: "interaction.opened"; scope?: { taskId: string }; data: InteractionOpenedData } => ({
  type: "interaction.opened" as const,
  ...(taskId ? { scope: { taskId } } : {}),
  data: {
    interactionId: r.requestId,
    subject: { callId: r.action.callId },
    request: { kind: V27_KIND[r.kind] as InteractionKind, prompt: r.prompt, options: r.options.map((o) => ({ id: o.id, label: o.label, ...("style" in o && o.style === "danger" ? { style: "danger" as const } : {}) })) },
    origin: { sessionId: "sess-qb", interactionId: r.requestId, call: { callId: r.action.callId, name: r.action.toolName } },
  },
});
{
  const q = bridgeableQuestionOf(opened(questionRequest).data);
  ok(q !== undefined && q.requestId === questionRequest.requestId, "1b: a v27 question bridges, keyed on its interaction id");
  ok(q?.toolName === "ask_question" && q.kind === "question", "1b: …naming the asking tool from the interaction's origin call, and the v27 kind");
  ok(q?.options.map((o) => o.label).join("|") === `${LABEL_YES}|${LABEL_NO}`, "1b: …with the option labels in order");
  ok(bridgeableQuestionOf(opened(approvalRequest).data)?.kind === "approval", "1b: a v27 approval bridges too");
  ok(bridgeableQuestionOf(opened(parkRequest).data) === undefined, "1b: 🔴 a v27 budget prompt (the old session-limit park) is NOT bridgeable");
  const signIn = { ...opened(questionRequest).data, request: { kind: "sign-in" as const, prompt: "Sign in to Notion" } };
  ok(bridgeableQuestionOf(signIn) === undefined, "1b: 🔴 a v27 sign-in is NOT bridgeable — a sign-in is no question the room can answer");
  ok(bridgeableQuestionOf({ ...opened(questionRequest).data, origin: undefined })?.toolName === "unknown", "1b: an interaction with no origin call degrades to toolName \"unknown\" and still bridges");
}
const { registerSlackFixtureMapper, registerSlackFixturePostArm, registerSlackFixtureCodec, registerSlackTestBridge } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
registerSlackFixturePostArm();
registerSlackFixtureCodec();
registerSlackTestBridge();
const unified = (await import("../agent/channels/unified.js")).default as unknown as {
  adapter?: Record<string, unknown>;
};
type InteractionOpenedHandler = (event: unknown, adapterCtx: Record<string, unknown>) => Promise<void>;
const rawOnInteractionOpened = unified.adapter?.["interaction.opened"] as InteractionOpenedHandler;
const onInteractionOpened = (event: unknown, token?: string): Promise<void> =>
  inSession(() => rawOnInteractionOpened(event, token === undefined ? { view: rawEmptyView() } : { continuation: { token }, view: rawEmptyView() }));
const ORG = deploymentOrg();
const droppedRows = async () => readAudit({ org: ORG, action: QUESTION_DROPPED_AUDIT_ACTION });
{
  const STANDING = formatWindowToken({ domain: "payments", windowId: "C_PAY", generation: 2 });
  const TASK = formatWindowToken({ domain: "payments", windowId: taskWindowId("C_PAY", "1700.1"), generation: 2 });
  const WORK = formatWindowToken({ domain: "payments", windowId: workWindowId("C_PAY"), generation: 2 });
  const UNCLASSIFIED = "not-a-window-token";
  const cases: ReadonlyArray<{ readonly token: string; readonly reason: string; readonly label: string }> = [
    { token: STANDING, reason: "no-question-road", label: "a standing seat" },
    { token: TASK, reason: "no-question-road", label: "🔴 the e2e test door's TASK window (control/test-route.ts `taskThread`, full kit)" },
    { token: UNCLASSIFIED, reason: "no-question-road", label: "🔴 a token that fails to classify (grain native, full kit)" },
    { token: WORK, reason: "work-session", label: "the work session" },
  ];
  const store = getOperationalStore();
  for (const c of cases) {
    for (const request of [questionRequest, approvalRequest]) {
      const before = (await droppedRows()).length;
      await onInteractionOpened(opened(request, "task_7"), `unified:${c.token}`);
      const rows = await droppedRows();
      ok(rows.length === before + 1, `3: ${c.label} — a ${request.kind} writes exactly ONE turn.question_dropped row`);
      const row = rows.find((r) => {
        const d = (r.detail ?? {}) as Record<string, unknown>;
        return d.requestId === request.requestId && d.reason === c.reason;
      });
      ok(row !== undefined, `3: ${c.label} — …with reason "${c.reason}" and the request id`);
      const detail = (row?.detail ?? {}) as Record<string, unknown>;
      ok(detail.toolName === request.action.toolName && detail.kind === V27_KIND[request.kind], `3: ${c.label} — …naming the tool and the eve kind (ids and enums only)`);
      ok(detail.taskId === "task_7", `3: ${c.label} — …and the owning task eve stated on the event, for the audit join`);
      ok((await readBridgedQuestion(store, ORG, c.token)) === undefined, `3: 🔴 ${c.label} — no outstanding-question row is written, so nothing can route an answer`);
    }
  }
  const DM = formatWindowToken(dmWindowKey("slack/T1/D_ALICE", 3));
  const THREAD = formatWindowToken({ domain: "payments", windowId: threadSeatWindowId("C_PAY", "1700.1"), generation: 2 });
  for (const t of [STANDING, TASK, WORK, DM, THREAD]) {
    ok(isUnifiedSupervisorToken(t), `3: ${t} is a window token the unified receive admits`);
    ok(classifySessionId(t).grain !== "native", `3: 🔴 …and it classifies "${classifySessionId(t).grain}", never the full-kit native fallback`);
  }
  ok(!isUnifiedSupervisorToken(UNCLASSIFIED) && classifySessionId(UNCLASSIFIED).grain === "native", "3: 🔴 a token that classifies native is not a window token, so the unified receive refuses it");
  const before = (await droppedRows()).length;
  await onInteractionOpened(opened(parkRequest), `unified:${STANDING}`);
  ok((await droppedRows()).length === before, "3: a budget prompt (the old session-limit PARK) writes no drop row — the park hook owns it");
  for (const junk of [undefined, null, {}, { data: "x" }, { data: { request: null } }]) {
    await onInteractionOpened(junk);
  }
  ok((await droppedRows()).length === before, "3: junk input writes no row and does not throw");
}

{
  const serialised = JSON.stringify(await droppedRows());
  ok(serialised.includes("call_abc123"), "4: the drop rows are there to search");
  ok(!serialised.includes(QUESTION_TEXT), "4: the model-authored PROMPT is in no row (it may carry attacker-derived content)");
  ok(!serialised.includes(LABEL_YES) && !serialised.includes(LABEL_NO), "4: model-authored option LABELS are in no row");
}

{
  ok(typeof unified.adapter?.["interaction.opened"] === "function", "5: the unified channel registers an interaction.opened handler through eve's own defineChannel builder");
  ok(typeof unified.adapter?.["content.completed"] === "function", "5: content.completed still registers");
  {
    const { EVE_EVENT_NAMES } = await import("../../../scripts/eve-event-names.generated.js");
    const known: ReadonlySet<string> = new Set(EVE_EVENT_NAMES);
    const eventKeys = Object.keys(unified.adapter ?? {}).filter((k) => /^[a-z]+\.[a-z_.]+$/.test(k));
    ok(eventKeys.length >= 2, `5: precondition: the unified adapter's event keys are read (got ${eventKeys.join(", ")})`);
    const stale = eventKeys.filter((k) => !known.has(k));
    ok(stale.length === 0, `5: 🔴 every event key on the unified adapter is an event the installed eve emits — no v26 key is left (eve would never fire it): ${stale.join(", ")}`);
  }

  const parkHook = (await import("../agent/hooks/session-park.js")).default as unknown as { events: Record<string, unknown> };
  ok(typeof parkHook.events["interaction.opened"] === "function", "5: hooks/session-park.ts subscribes to interaction.opened — the park path reads the v27 budget prompt");
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

  {
    const store = makeStore();
    ok(await rememberBridgedQuestion(store, "o1", TOKEN, { requestId: TASK_REQUEST_ID, wakeId: "w1" }), "6: a bridged question is remembered");
    const got = await readBridgedQuestion(store, "o1", TOKEN);
    ok(got?.requestId === TASK_REQUEST_ID, "6: …and reads back the PARENT-VISIBLE request id, which is the only value that can route");
    ok(got?.wakeId === "w1", "6: …with the wake it was raised on, for the audit join");
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
  const outstanding = { requestId: TASK_REQUEST_ID, containerKey: ROOM_A, wakeId: "w1", at: "2026-08-15T00:00:00.000Z" };
  const allow = async (): Promise<{ ok: true; floor: string }> => ({ ok: true, floor: "member" });
  {
    const routed = await resolveInboundAnswerRouting({ internalDispatch: false, containerKey: ROOM_A }, { read: async () => outstanding, admit: allow });
    ok(routed.kind === "answer", "6: ⭐ an attended message IN THE ASKING ROOM with an outstanding question is an ANSWER");
    ok(routed.kind === "answer" && routed.requestId === TASK_REQUEST_ID, "6: …addressed to the exact request id eve's proxy map is keyed on");
    ok(routed.kind === "answer" && routed.floor === "member", "6: …carrying the resolved floor for the routed audit row");
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
    const strip = (src: string): string => src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    const unifiedSrc = strip(readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8"));
    ok(!/rememberBridgedQuestion\(|readBridgedQuestion\(|resolveInboundAnswerRouting\(/.test(unifiedSrc), "6: 🔴 the unified channel writes and reads no outstanding-question row (OPE-2389)");
    ok(!/\.respond\(\[/.test(unifiedSrc), "6: 🔴 …and delivers no `respond` — a room message on the unified window is always an ordinary wake");
    const notionSrc = strip(readFileSync(new URL("../../providers/notion/agent/channels/notion-question-return.ts", import.meta.url), "utf8"));
    ok(/resolveInboundAnswerRouting\(/.test(notionSrc) && /readBridgedQuestion\(/.test(notionSrc), "6: …while the Notion question return still runs the routing decision over the row");
  }
}

console.log(`question-bridge: ${n} assertions passed`);

// proves: TOOL-ask_question
