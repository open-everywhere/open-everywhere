import assert from "node:assert/strict";
import type { AuditWireEntry } from "./audit-read.js";
import { CONNECTOR_CARD_ACTIONS, connectorCardRun, type ConnectorCardRequest } from "./connector-card.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const DM = "D-FIXTURE-DM";
const HUMAN = "U-FIXTURE-HUMAN";
const OTHER = "U-FIXTURE-OTHER";
const SEAT = "seat-session-fixture";
const CARD = "card-fixture-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const slackTs = (sec: number) => ((T0 + sec * 1000) / 1000).toFixed(6);

const row = (action: string, sec: number, detail: Record<string, unknown>, extra: Partial<AuditWireEntry> = {}): AuditWireEntry => ({
  ts: at(sec),
  org: "default",
  platform: "slack",
  workspace: "fixture",
  action,
  detail,
  ...extra,
});

const request: ConnectorCardRequest = {
  askWakeId: "wake-ask",
  seatSessionId: SEAT,
  requestId: "req-1",
  pendingId: CARD,
  requestedBy: HUMAN,
  scopeKey: `slack/T-FIXTURE/${DM}`,
  requestedAt: at(0),
};

const INTERIM = slackTs(29);
const ANSWER = slackTs(50);

const base = (): AuditWireEntry[] => [
  row("connector.op_approved", 10, { requestedBy: HUMAN }, { principalId: HUMAN }),
  row("approval.approved", 10.2, { id: CARD }, { principalId: HUMAN }),
  row("approval.decision_wake", 11, { id: CARD, outcome: "approved", delivered: true, wakeId: "wake-decision" }),
  row("connector.op", 30, { opTier: "write", status: "completed", op: "create-page" }, { surface: DM }),
];

const interimPost = row("reply.post", 29, { id: INTERIM, platform: "slack", sessionId: SEAT, done: false });
const refused = row("reply.refused", 44, { reason: "should-be-edit", sessionId: SEAT });
const edit = (overrides: Record<string, unknown> = {}, sec = 48) =>
  row("reply.edit", sec, { id: INTERIM, platform: "slack", sessionId: SEAT, chars: 300, ...overrides });

const run = (rows: readonly AuditWireEntry[], candidates: readonly { id: string; text: string; editedTs?: string }[], clicker = HUMAN) =>
  connectorCardRun(rows, { request, clicker, surface: DM, replyPlatform: "slack", candidates });

const editedCandidate = { id: INTERIM, text: "Done: created the page.", editedTs: slackTs(48) };

ok((CONNECTOR_CARD_ACTIONS as readonly string[]).includes("reply.edit"), "the leg's action-filtered audit read includes reply.edit, or the edit shape is dead code");
ok((CONNECTOR_CARD_ACTIONS as readonly string[]).includes("reply.post"), "the leg's action-filtered audit read still includes reply.post");

{
  const rows = [...base(), row("reply.post", 50, { id: ANSWER, platform: "slack", sessionId: SEAT })];
  const r = run(rows, [{ id: ANSWER, text: "Done." }]);
  ok(r !== undefined && r.replyShape === "post" && r.candidate.id === ANSWER, "a seat reply.post after the write is the answer (shape post)");
  ok(r?.decisionWakeId === "wake-decision" && r?.write.ts === at(30), "the run names the decision wake and the write");
}
{
  const r = run([...base(), interimPost], [{ id: INTERIM, text: "Working on it." }]);
  ok(r === undefined, "a done:false post BEFORE the write, with no edit, is no answer");
}
{
  const rows = [...base(), row("reply.post", 50, { id: ANSWER, platform: "slack", sessionId: SEAT, done: false })];
  ok(run(rows, [{ id: ANSWER, text: "Handing off." }]) === undefined, "a done:false post after the write is a hand-off note, not the answer");
}

{
  const rows = [...base(), interimPost, refused, edit()];
  const r = run(rows, [editedCandidate]);
  ok(r !== undefined, "the incident shape passes: the seat edits its interim post with the answer after the write");
  ok(r?.replyShape === "edit" && r?.reply.action === "reply.edit" && r?.candidate.id === INTERIM, "the run reports shape edit, the edit row and the edited message");
  ok(r?.reply.detail?.sessionId === SEAT, "the answer row names the seat session, which the callers gate on");
}
{
  const rows = [...base(), interimPost, refused, edit()];
  ok(run(rows, [{ id: INTERIM, text: "Working on it." }]) === undefined, "the pre-write interim text is not the answer: a candidate with no editedTs refuses");
}
{
  const rows = [...base(), interimPost, refused, edit()];
  ok(run(rows, [{ ...editedCandidate, editedTs: slackTs(29.5) }]) === undefined, "a candidate edited before the write refuses");
}
{
  const rows = [...base(), interimPost, edit({}, 29.5)];
  ok(run(rows, [{ ...editedCandidate, editedTs: slackTs(31) }]) === undefined, "a reply.edit row before the write is not the answer");
}
{
  const rows = [...base(), interimPost, refused, edit({ sessionId: "another-session" })];
  ok(run(rows, [editedCandidate]) === undefined, "an edit from another session is not the seat's answer");
}
{
  const rows = [...base(), row("reply.post", 29, { id: INTERIM, platform: "slack", sessionId: "another-session", done: false }), edit()];
  ok(run(rows, [editedCandidate]) === undefined, "an edit of a message the seat did not post refuses");
}
{
  const rows = [...base(), refused, edit()];
  ok(run(rows, [editedCandidate]) === undefined, "an edit of a message with no reply.post row refuses");
}
{
  const rows = [...base(), interimPost, edit({ platform: "teams" })];
  ok(run(rows, [editedCandidate]) === undefined, "an edit on another platform refuses");
}
{
  const rows = [...base(), interimPost, refused, edit()];
  ok(run(rows, []) === undefined, "an edit of a message the leg did not observe in the DM refuses");
}
{
  const rows = [...base(), interimPost, edit({}, 40), row("reply.post", 50, { id: ANSWER, platform: "slack", sessionId: SEAT })];
  const r = run(rows, [{ ...editedCandidate, editedTs: slackTs(40) }, { id: ANSWER, text: "Also done." }]);
  ok(r?.replyShape === "edit" && r?.candidate.id === INTERIM, "the earlier of an edit and a post is the answer");
}

const incident = () => [...base(), interimPost, refused, edit()];
{
  ok(run(incident(), [editedCandidate], OTHER) === undefined, "a click by anyone but the clicker refuses");
}
{
  const rows = [...incident(), row("approval.approved", 10.4, { id: CARD }, { principalId: HUMAN })];
  ok(run(rows, [editedCandidate]) === undefined, "two approvals of one card refuse");
}
{
  const rows = [...incident(), row("approval.rejected", 12, { id: CARD }, { principalId: HUMAN })];
  ok(run(rows, [editedCandidate]) === undefined, "a rejected card refuses");
}
{
  const rows = incident().filter((r) => r.action !== "connector.op_approved");
  ok(run(rows, [editedCandidate]) === undefined, "no connector.op_approved row refuses");
}
{
  const rows = incident().map((r) => (r.action === "approval.decision_wake" ? { ...r, detail: { ...r.detail, delivered: false } } : r));
  ok(run(rows, [editedCandidate]) === undefined, "an undelivered decision wake refuses");
}
{
  const rows = [...incident(), row("connector.op", 5, { opTier: "write", status: "completed" }, { surface: DM })];
  ok(run(rows, [editedCandidate]) === undefined, "a write between the card and the click refuses");
}
{
  const rows = incident().filter((r) => r.action !== "connector.op");
  ok(run(rows, [editedCandidate]) === undefined, "no write after the click refuses");
}

console.log(`connector-card-test: ${n} assertions passed`);
