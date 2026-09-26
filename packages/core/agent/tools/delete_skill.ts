import { defineTool } from "eve/tools";
import { windowGated } from "../access/window-gated.js";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { listDomainSkills, domainSkillRefusalMessage, resolveSkillDomainDetailed } from "../skills/domain-skills.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default windowGated("delete_skill", defineTool({
  description:
    "PROPOSE deleting a domain skill created with create_skill, by its bare name (see list_skills). Any member of the domain may propose it, but this does NOT delete on the spot: an approval card posts naming the exact skill, and it's removed only when a human in the domain confirms (deleting a skill removes a guardrail, so it's gated like creating one). Can't be used from a DM, a group chat, or an externally-shared/unconfirmed channel. The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `message` field names it, and you MUST relay that.",
  inputSchema: z.object({
    name: z.string().min(1).describe("The skill's bare name, as shown by list_skills."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    domain: z.string(),
    name: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
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
    const proposeScopeKey = await proposalScopeKey(ctx, p);

    const existing = await listDomainSkills(p.org, domain);
    if (!existing.some((s) => s.name === name)) {
      throw new Error(`No skill named "${name}" in domain "${domain}" — check the name with list_skills.`);
    }

    const binding = bindFrom(ctx);
    // principal-gate: presence — a delete removes standing trusted text the domain relies on, and the
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("delete_skill needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose removing a guardrail the domain's later turns rely on. Ask a person in this conversation to propose it.");
    }

    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "delete that skill"));
    }
    const venue = venueResult.venue;

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "skill.delete",
        args: { org: p.org, domain, name, requestedBy },
        scopeKey: proposeScopeKey,
        domain,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const subject = `delete of skill "${name}" (domain "${domain}")`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        domain,
        name,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      domain,
      name,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${cardPostedTail(venue, "confirm the removal", posted)}`,
    };
  },
}));
