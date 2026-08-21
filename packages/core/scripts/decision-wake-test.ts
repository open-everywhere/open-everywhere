import assert from "node:assert/strict";
import { approvalDecisionBody, buildApprovalDecisionWake, renderApprovalDecisionMessage, type ApprovalDecisionWakeInput } from "../agent/approvals/decision-wake.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const baseInput: ApprovalDecisionWakeInput = {
  origin: { platform: "slack", channelId: "C123", threadTs: "111.222" },
  wakeId: "wk_test123",
  summaryLine: 'Set linear SOAK-9 state → "In Progress"',
  outcome: "approved",
  clickerId: "U999",
  pendingId: "pend_abc",
};

{
  const body = approvalDecisionBody(baseInput);
  ok(!body.includes("Nothing more is needed from you unless someone asks a follow-up."), "the old unconditional stop instruction is GONE (OPE-921's bug)");
  ok(body.includes("continue that work now"), `approved outcome tells the model to CONTINUE a stated plan (${body})`);
  ok(body.includes("does not end your turn"), "approved outcome names the failure mode: approval unblocks, it does not end the turn");
  ok(body.includes("nothing more is needed unless"), "the silence default survives for the common case (no stated plan)");
  ok(body.includes(baseInput.pendingId), "body names the pending id (correlates with the card the model saw)");
  ok(body.includes(baseInput.summaryLine), "body names the decided request's own summary");
  ok(body.includes("APPROVED"), "body states the outcome");
  ok(body.includes(`<@${baseInput.clickerId}>`), "body names who decided");
}

{
  const body = approvalDecisionBody({ ...baseInput, outcome: "rejected", clickerId: "U999" });
  ok(body.includes("REJECTED"), "rejected outcome stated");
  ok(body.includes("treat a fresh request as a NEW proposal"), "rejected outcome keeps its own closing instruction, untouched");
  ok(!body.includes("continue that work now"), "rejected outcome carries no plan-continuation language (nothing was approved)");
}
{
  const body = approvalDecisionBody({ ...baseInput, outcome: "expired", clickerId: undefined });
  ok(body.includes("EXPIRED"), "expired outcome stated");
  ok(!body.includes(" by <@"), "no clicker id ⇒ no attribution clause");
  ok(!body.includes("continue that work now"), "expired outcome carries no plan-continuation language either");
}

{
  const wake = buildApprovalDecisionWake(baseInput, "2026-08-21T12:00:00.000Z");
  ok(wake.addressing === "channel-watch", "still AMBIENT — the humans were already told in-thread");
  ok(wake.wakeId === baseInput.wakeId, "host-minted wake id rides the envelope");
  const rendered = renderApprovalDecisionMessage(baseInput, "2026-08-21T12:00:00.000Z");
  ok(rendered.includes("continue that work now"), "the rendered turn message (what the model actually reads) carries the fix");
}

console.log(`✓ ${n} decision-wake assertions passed`);
