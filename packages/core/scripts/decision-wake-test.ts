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
  const body = approvalDecisionBody({ ...baseInput, execution: { ran: "ok", line: "sent a direct message to teams person 29-1oW" } });
  ok(body.includes("ALREADY RUN"), `approved+ran states the act already ran (${body})`);
  ok(body.includes("sent a direct message to teams person 29-1oW"), "approved+ran quotes the EXECUTOR's own outcome line — the direct observable");
  ok(body.includes("NOT delegate it again"), "approved+ran names the observed failure mode: re-delegating the same act");
  ok(body.includes("repeats the same effect"), "approved+ran says WHY a second run is wrong, in terms of the people it reached");
  ok(body.includes("continue that work now"), "approved+ran keeps OPE-921's continuation for work BEYOND the approved act");
  ok(body.includes("does not re-open the act above"), "approved+ran holds the two clauses apart — continue the rest, not the act itself");
}

{
  const body = approvalDecisionBody({ ...baseInput, execution: { ran: "failed", line: "FAILED: Slack refused the DM (missing im:write)" } });
  ok(body.includes("RAN AND FAILED"), `approved+failed states the failure (${body})`);
  ok(body.includes("nothing was applied"), "approved+failed says nothing landed");
  ok(body.includes("missing im:write"), "approved+failed carries the failure reason");
  ok(body.includes("attempt it again"), "approved+failed leaves the seat free to retry");
  ok(!body.includes("ALREADY RUN"), "approved+failed NEVER claims the act already ran");
  ok(!body.includes("NOT delegate it again"), "approved+failed carries no re-delegation ban");
}

{
  const body = approvalDecisionBody({ ...baseInput, outcome: "rejected", execution: { ran: "ok", line: "should never be read" } });
  ok(!body.includes("should never be read"), "a rejected outcome never renders an execution line");
  ok(!body.includes("ALREADY RUN"), "a rejected outcome never claims an act already ran");
}

{
  const body = approvalDecisionBody(baseInput);
  ok(!body.includes("ALREADY RUN"), "no execution fact ⇒ the wake claims nothing about what ran");
}

{
  const wake = buildApprovalDecisionWake(baseInput, "2026-08-21T12:00:00.000Z");
  ok(wake.addressing === "channel-watch", "still AMBIENT — the humans were already told in-thread");
  ok(wake.wakeId === baseInput.wakeId, "host-minted wake id rides the envelope");
  const rendered = renderApprovalDecisionMessage(baseInput, "2026-08-21T12:00:00.000Z");
  ok(rendered.includes("continue that work now"), "the rendered turn message (what the model actually reads) carries the fix");
  const renderedRan = renderApprovalDecisionMessage({ ...baseInput, execution: { ran: "ok", line: "sent a direct message to teams person 29-1oW" } }, "2026-08-21T12:00:00.000Z");
  ok(renderedRan.includes("ALREADY RUN") && renderedRan.includes("29-1oW"), "the rendered turn message carries the OPE-1097 observable, not just the builder's return");
}

console.log(`✓ ${n} decision-wake assertions passed`);
