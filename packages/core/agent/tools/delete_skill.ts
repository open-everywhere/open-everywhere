import { defineTool } from "eve/tools";
import { windowGated } from "../access/window-gated.js";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { listDomainSkills, domainSkillRefusalMessage, resolveSkillDomainDetailed } from "../skills/domain-skills.js";
import { resolvePartition } from "../memory/partition.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default windowGated("delete_skill", defineTool({
  description:
    "PROPOSE deleting a domain skill created with create_skill, by its bare name (see list_skills). Any member of the domain may propose it, but this does NOT delete on the spot: an approval card posts naming the exact skill, and it's removed only when a human in the domain confirms (deleting a skill removes a guardrail, so it's gated like creating one). Can't be used from a DM, a group chat, an externally-shared/unconfirmed channel, or a surface with no approval-card path (Slack/Discord only). The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    name: z.string().min(1).describe("The skill's bare name, as shown by list_skills."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    domain: z.string(),
    name: z.string(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "delete_skill");
    const resolved = resolveSkillDomainDetailed(ctx);
    if (resolved.domain === null) {
      throw new Error(domainSkillRefusalMessage(resolved.reason));
    }
    const domain = resolved.domain;
    const name = input.name.trim();
    const p = resolvePartition(ctx);

    const existing = await listDomainSkills(p.org, domain);
    if (!existing.some((s) => s.name === name)) {
      throw new Error(`No skill named "${name}" in domain "${domain}" — check the name with list_skills.`);
    }

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(`delete_skill needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must confirm the removal.`);
    }
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("delete_skill needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose removing a guardrail the domain's later turns rely on. Ask a person in this conversation to propose it.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("delete_skill couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "skill.delete",
        args: { org: p.org, domain, name, requestedBy },
        scopeKey: p.surfaceKey,
        domain,
        requestedBy,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    return {
      pending: true,
      pendingId: posted.id,
      domain,
      name,
      message: `card posted — delete of skill "${name}" (domain "${domain}") awaiting a human to confirm (pending ${posted.id}).`,
    };
  },
}));
