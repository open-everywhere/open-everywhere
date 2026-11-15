import {
  TRANSFORM_STAGE_ORDER,
  TRANSFORM_TABLE,
  chainAuditDetail,
  judgedConnectorOpTool,
  renderChainResolution,
  resolveApproverChain,
  type ApprovalChainRequest,
  type ChainResolution,
  type OperatorApprover,
} from "../agent/access/approver-chain.js";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { markUntrustedIngestedThisTurn, untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const FORMER_TAINT_SINKS = [
  "add_routine_rule",
  "cancel_routine",
  "create_agent",
  "create_routine",
  "create_skill",
  "declare_webhook",
  "delete_skill",
  "edit_routine",
  "enable_routine",
  "meeting_join",
  "meeting_recap",
  "propose_email_sender",
  "propose_mcp_server",
  "remove_routine_rule",
  "rotate_webhook",
] as const;

ok(FORMER_TAINT_SINKS.length === 15, "the former taint-floored sink list has 15 entries");
for (const sink of FORMER_TAINT_SINKS) {
  ok(TOOL_CONSEQUENCE[sink] !== undefined && TOOL_CONSEQUENCE[sink]!.tier !== "open", `${sink} is still a gated row of the consequence registry`);
}

const lower: OperatorApprover = { name: "lower", approve: () => "allow" };

function req(tool: string, extra: Partial<ApprovalChainRequest> = {}): ApprovalChainRequest {
  return { tool, unattended: false, principalId: "U1", ...extra };
}

function decision(res: ChainResolution): string {
  return JSON.stringify({
    verdict: res.verdict,
    resolvedBy: res.resolvedBy,
    registryVerdict: res.registryVerdict,
    transforms: res.transforms,
    denyAbsolute: res.denyAbsolute ?? false,
  });
}

for (const sink of FORMER_TAINT_SINKS) {
  const shapes: { name: string; request: ApprovalChainRequest; approvers: OperatorApprover[] }[] = [
    { name: "attended, lowered", request: req(sink), approvers: [lower] },
    { name: "attended, registry", request: req(sink), approvers: [] },
    { name: "unattended, lowered", request: req(sink, { unattended: true, principalId: undefined }), approvers: [lower] },
    { name: "bypass domain", request: req(sink, { mode: { mode: "DANGEROUSLY_BYPASS" } }), approvers: [] },
  ];
  for (const shape of shapes) {
    const clean = await resolveApproverChain(shape.request, { approvers: shape.approvers });

    const supplied = await resolveApproverChain({ ...shape.request, tainted: true }, { approvers: shape.approvers });
    ok(decision(supplied) === decision(clean), `1/${sink} (${shape.name}): a supplied tainted:true decides as the clean turn (${decision(supplied)} vs ${decision(clean)})`);

    const live = await inEveContext(new FakeEveContext(), async () => {
      markUntrustedIngestedThisTurn("web");
      ok(untrustedIngestedThisTurn(), `1/${sink} (${shape.name}): precondition — the live turn really is marked`);
      return await resolveApproverChain(shape.request, { approvers: shape.approvers });
    });
    ok(decision(live) === decision(clean), `1/${sink} (${shape.name}): a live-marked turn decides as the clean turn (${decision(live)} vs ${decision(clean)})`);
  }

  const lowered = await resolveApproverChain(req(sink, { tainted: true }), { approvers: [lower] });
  ok(lowered.verdict === "allow" && lowered.transforms.length === 0, `1/${sink}: a lowering on a turn that read untrusted content lands (OPE-2715 row 1)`);
}

for (const sink of FORMER_TAINT_SINKS) {
  for (const tainted of [false, true]) {
    const fire = await resolveApproverChain(req(sink, { unattended: true, principalId: undefined, tainted }));
    ok(
      fire.verdict === "deny" && fire.transforms.map((t) => t.name).join(",") === "unattended" && fire.transforms[0]!.reason === "ask-unattended",
      `2/${sink} (tainted=${tainted}): the unattended clamp denies the registry ask in an empty room`,
    );
  }
}

for (const sink of FORMER_TAINT_SINKS) {
  const approveAll = await resolveApproverChain(req(sink, { mode: { mode: "APPROVE_ALL" } }), { approvers: [lower] });
  ok(approveAll.verdict === "ask" && approveAll.transforms.map((t) => t.name).join(",") === "mode:APPROVE_ALL", `3/${sink}: APPROVE_ALL raises a lowered allow to ask`);
  const denyAll = await resolveApproverChain(req(sink, { mode: { mode: "DENY_ALL" } }));
  ok(denyAll.verdict === "deny" && denyAll.transforms[0]!.name === "mode:DENY_ALL", `3/${sink}: DENY_ALL denies`);
  const floored = await resolveApproverChain(req(sink, { beneficiaryClicker: true }), { approvers: [lower] });
  ok(floored.verdict === "ask" && floored.transforms.map((t) => t.name).join(",") === "beneficiary-clicker-floor", `3/${sink}: the beneficiary-clicker floor raises a lowered allow to ask`);
  const bypassFloor = await resolveApproverChain(req(sink, { beneficiaryClicker: true, mode: { mode: "DANGEROUSLY_BYPASS" } }));
  ok(bypassFloor.verdict === "ask", `3/${sink}: DANGEROUSLY_BYPASS cannot lift the beneficiary-clicker floor`);
}

{
  const args = { tool: "notion__create_page", grain: "call", credential: "domain", inputPreview: "{}", opTier: "write", tainted: true };
  const taintedChain = { unattended: false, tainted: true, domain: "support" };
  ok(judgedConnectorOpTool("op.connector", args, taintedChain) === "notion__create_page", "4: a connector write on a turn that read a page reaches the judge");
  ok(judgedConnectorOpTool("op.connector", { ...args, tainted: false }, { unattended: false, domain: "support" }) === "notion__create_page", "4: …exactly as on a clean turn");
  ok(judgedConnectorOpTool("op.connector", args, { unattended: true, domain: "support" }) === undefined, "4: an unattended run keeps its fence");
  ok(judgedConnectorOpTool("op.connector", { ...args, credential: "person" }, { unattended: false, domain: "support" }) === undefined, "4: a person's own credential keeps the card");
  ok(judgedConnectorOpTool("op.connector", args, { unattended: false }) === undefined, "4: a room with no single domain keeps the card");
  ok(judgedConnectorOpTool("op.connector", { ...args, grain: "once" }, { unattended: false, domain: "support" }) === undefined, "4: the blanket `once` grain keeps the card");
  ok(judgedConnectorOpTool("op.connector", { ...args, opTier: "destructive" }, { unattended: false, domain: "support" }) === undefined, "4: a delete the name does not show keeps the card");
}

ok(JSON.stringify(TRANSFORM_STAGE_ORDER) === JSON.stringify(["mode", "floor", "unattended"]), "5: the stage order lists only the surviving stages: mode → floor → unattended");
ok(TRANSFORM_TABLE.every((row) => !/taint/i.test(row.name) && !/taint/i.test(row.reason ?? "")), "5: no transform arrow is named for taint");
for (const [tool, row] of Object.entries(TOOL_CONSEQUENCE)) {
  const keys = Object.keys(row);
  ok(!keys.includes("taint") && !keys.includes("postTurnSurface") && !keys.includes("judgeTaintBlind"), `5: ${tool}'s consequence row carries no taint column, postTurnSurface or judgeTaintBlind`);
}
{
  const request = req("create_ticket", { action: "ticket.create", tainted: true });
  const res = await inEveContext(new FakeEveContext(), async () => {
    markUntrustedIngestedThisTurn("web");
    return await resolveApproverChain(request);
  });
  ok(!("tainted" in res), "5: the resolution carries no `tainted` field");
  const detail = await inEveContext(new FakeEveContext(), async () => {
    markUntrustedIngestedThisTurn("web");
    return chainAuditDetail(request, res);
  });
  ok(!("tainted" in detail) && !("taintKinds" in detail) && !("taintMode" in detail), "5: the approval.chain row writes no tainted, taintKinds or taintMode");
  const trace = renderChainResolution(request, res).join("\n");
  ok(!/taint/i.test(trace), `5: the explain trace prints no taint line (got: ${trace.split("\n").at(-1)})`);
  ok(/context: unattended: false/.test(trace), "5: …and the context line still carries the unattended fact");
}

console.log(`✓ taint-free-chain: ${passed} assertions`);
