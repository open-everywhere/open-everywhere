import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-ticket-approvals-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { registerEntityActionAdapter } = await import("../agent/channels/entity-actions.js");
type TicketSetStateArgs = import("../agent/approvals/ticket-actions.js").TicketSetStateArgs;
type TicketAssignArgs = import("../agent/approvals/ticket-actions.js").TicketAssignArgs;
await import("../agent/approvals/flow.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const calls: { entityId: string; value: string }[] = [];
registerEntityActionAdapter({
  platform: "test-ticket-platform",
  setState: async (id, v) => {
    calls.push({ entityId: id, value: v });
    return `test-ticket-platform ${id} state → "${v}"`;
  },
  assign: async (id, v) => {
    calls.push({ entityId: id, value: v });
    return `test-ticket-platform ${id} assigned to ${v}`;
  },
});

function setStateArgs(over: Partial<TicketSetStateArgs> = {}): TicketSetStateArgs {
  return { org: "default", scopeKey: "slack/T1/C1", platform: "test-ticket-platform", entityId: "TP-1", state: "Done", requestedBy: "U_PROPOSER", ...over };
}
function assignArgs(over: Partial<TicketAssignArgs> = {}): TicketAssignArgs {
  return { org: "default", scopeKey: "slack/T1/C1", platform: "test-ticket-platform", entityId: "TP-1", assignee: "alice", requestedBy: "U_PROPOSER", ...over };
}

{
  const setState = actionKind("ticket.set_state");
  const assign = actionKind("ticket.assign");
  ok(setState !== undefined, "ticket.set_state is registered (flow.ts side-effect import)");
  ok(assign !== undefined, "ticket.assign is registered (flow.ts side-effect import)");
  ok(setState!.policy === "member" && assign!.policy === "member", "both are MEMBER policy — audience-expanding, same tier as pr.open/routine.cancel");
}

{
  const kind = actionKind("ticket.set_state")!;
  const lines = kind.summarize(setStateArgs());
  ok(lines[0].includes("test-ticket-platform") && lines[0].includes("TP-1") && lines[0].includes('"Done"'), "card names platform, entity id, and target state");
  ok(!lines.some((l) => l.includes("⚠")), "no taint banner on a clean proposal");
  const tainted = kind.summarize(setStateArgs({ tainted: true }));
  ok(tainted.some((l) => l.includes("⚠") && l.includes("external content")), "tainted proposal gets the reviewer-scrutiny banner");
}
{
  const kind = actionKind("ticket.assign")!;
  const lines = kind.summarize(assignArgs());
  ok(lines[0].includes("test-ticket-platform") && lines[0].includes("TP-1") && lines[0].includes("alice"), "card names platform, entity id, and assignee");
}

{
  calls.length = 0;
  const kind = actionKind("ticket.set_state")!;
  const outcome = await kind.execute(setStateArgs(), "U_APPROVER");
  ok(outcome.includes('state → "Done"'), `execute() returns the adapter fn's outcome string (${outcome})`);
  ok(calls.length === 1 && calls[0].entityId === "TP-1" && calls[0].value === "Done", "the adapter fn was called with (entityId, value) — value is the frozen state");
  const audit = await readAudit({ org: "default", limit: 3 });
  const entry = audit.find((a) => a.action === "ticket.set_state");
  ok(entry !== undefined, "audits ticket.set_state");
  ok(entry!.principalId === "U_APPROVER", "audit principal is the DECIDER (approver), not the proposer");
  const detail = entry!.detail as Record<string, unknown>;
  ok(detail.platform === "test-ticket-platform" && detail.entityId === "TP-1" && detail.value === "Done" && detail.requestedBy === "U_PROPOSER", "audit detail carries platform/entityId/value/requestedBy");
  ok(detail.tainted === false, "audit detail stamps tainted:false on a clean proposal");
}

{
  calls.length = 0;
  const kind = actionKind("ticket.assign")!;
  const outcome = await kind.execute(assignArgs({ tainted: true }), "U_APPROVER2");
  ok(outcome.includes("assigned to alice"), `execute() returns the adapter fn's outcome string (${outcome})`);
  ok(calls.length === 1 && calls[0].value === "alice", "the adapter fn was called with the frozen assignee");
  const audit = await readAudit({ org: "default", limit: 3 });
  const entry = audit.find((a) => a.action === "ticket.assign");
  ok(entry !== undefined && entry!.principalId === "U_APPROVER2", "audits ticket.assign, principal = the approver");
  ok((entry!.detail as Record<string, unknown>).tainted === true, "a tainted proposal's audit row carries tainted:true even after approval");
}

{
  const kind = actionKind("ticket.set_state")!;
  await assert.rejects(
    () => kind.execute(setStateArgs({ platform: "platform-that-no-longer-exists" }), "U_APPROVER"),
    /no "setState" adapter is registered for platform "platform-that-no-longer-exists"/,
    "a stale pending row whose platform's adapter was removed fails with a legible reason",
  );
  n++;
}

console.log(`✓ ${n} ticket-approvals assertions passed`);
