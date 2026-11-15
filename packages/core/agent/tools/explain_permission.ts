import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import {
  approvalModeForDomain,
  renderChainResolution,
  resolveApproverChain,
  type ApprovalChainRequest,
} from "../access/approver-chain.js";
import { TOOL_CONSEQUENCE } from "../access/consequence.js";
import { actingPrincipalIdOf, resolveAccessFor, unattendedOf } from "../access/request.js";
import type { BindableContext } from "../identity/binding.js";

export default defineTool({
  description:
    "Explain what would happen if a named tool were used HERE: resolves the real approver chain for this scope (config approvers, surface controls, the consequence registry, the domain's approval mode, the floor and unattended transforms) and returns the full verdict trace — allow / deny / ask, which element decided it, and why. A simulation: nothing runs, nothing is proposed. Use to answer \"why can't you do that?\", \"would this need approval?\", or to preview a routine fire's permissions (unattended: true).",
  inputSchema: z.object({
    tool: z.string().min(1).describe("The tool name to simulate (e.g. \"create_ticket\", \"open_pull_request\", a connector op like \"notion__create_page\")."),
    unattended: z.boolean().optional().describe("Simulate an unattended (routine/webhook fire) context. Default: this turn's own attendance."),
    domain: z.string().optional().describe("Simulate under a specific domain's policy/mode. Default: this surface's own domain."),
  }),
  outputSchema: z.object({
    verdict: z.enum(["allow", "deny", "ask"]),
    resolvedBy: z.string().describe("Which chain element produced the pre-transform verdict."),
    registryVerdict: z.enum(["allow", "ask"]).describe("The consequence registry's baseline — divergence means config/mode moved it."),
    transforms: z.array(z.string()).describe("Post-resolution transforms applied, in order."),
    trace: z.string().describe("The full human-readable resolution trace (same vocabulary as the approval.chain audit row)."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const access = resolveAccessFor(ctx as BindableContext);
    const domain = input.domain ?? access.domains[0];
    const acting = actingPrincipalIdOf(ctx as BindableContext);
    const row = TOOL_CONSEQUENCE[input.tool];
    const request: ApprovalChainRequest = {
      tool: input.tool,
      ...(row !== undefined && row.via.kind === "action-kind" ? { action: row.via.action } : {}),
      scopeKey: access.surfaceKey,
      ...(domain !== undefined ? { domain, mode: approvalModeForDomain(domain) } : {}),
      ...(acting !== undefined ? { principalId: acting } : {}),
      unattended: input.unattended ?? unattendedOf(ctx as BindableContext),
    };
    const resolution = await resolveApproverChain(request, { approvers: access.approvers });
    return {
      verdict: resolution.verdict,
      resolvedBy: resolution.resolvedBy,
      registryVerdict: resolution.registryVerdict,
      transforms: resolution.transforms.map((t) => `${t.name} (${t.from} → ${t.to}${t.reason !== undefined ? `, ${t.reason}` : ""})`),
      trace: renderChainResolution(request, resolution).join("\n"),
    };
  },
});
