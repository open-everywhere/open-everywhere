import assert from "node:assert/strict";

process.env.OE_SQLITE_PATH = ":memory:";

import type { AuditInput } from "../agent/audit/audit.js";
import type { UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import {
  detectBridgeableInputRequest,
  renderQuestionForSurface,
  bridgeQuestionToSurface,
  EMPTY_QUESTION_FALLBACK,
  QUESTION_BRIDGED_AUDIT_ACTION,
  QUESTION_DROPPED_AUDIT_ACTION,
  type BridgeableQuestion,
} from "../agent/channels/question-bridge.js";
import { detectSessionLimitPark, isSessionLimitContinuationRequest, SESSION_LIMIT_CONTINUATION_TOOL_NAME } from "../agent/channels/session-park.js";

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
  prompt: "Allow bash?",
  action: { callId: "call_z", input: {}, kind: "tool-call", toolName: "bash" },
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
  ok(q.options.length === 2 && q.options[0] === LABEL_YES && q.options[1] === LABEL_NO, "2: option LABELS are extracted (ids/styles are not)");
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

console.log(`question-bridge: ${n} assertions passed`);
