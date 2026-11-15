import { defineTool } from "eve/tools";
import { windowGated } from "../access/window-gated.js";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { actingPrincipalIdOf, resolveAccessFor, unattendedOf } from "../access/request.js";
import { isSafeSkillName } from "../scm/repo-skills.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import {
  MAX_DOMAIN_SKILL_BYTES,
  domainSkillCap,
  domainSkillRefusalMessage,
  listDomainSkills,
  resolveSkillDomainDetailed,
  withDescription,
} from "../skills/domain-skills.js";

export default windowGated("create_skill", defineTool({
  description:
    "PROPOSE creating or updating a SKILL for this channel's memory domain — a reusable markdown instruction package any future turn in the domain can invoke by its bare name. This does NOT arm the skill: a skill is a procedure the agent loads and FOLLOWS, so a human in the domain must read and approve it first — an approval card posts with the full body, and the skill arms only when someone clicks. Any domain member can propose one, and it becomes invocable once armed. Can't be authored from a DM, a group chat, or an externally-shared/unconfirmed channel — author from a channel that's actually in the target domain. Write one worth keeping: a trigger-rich description in the words a teammate would use, the intent behind the ask (not just the commands you ran), the edge cases you hit, and one coherent job per skill. The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `message` field names it, and you MUST relay that.",
  inputSchema: z.object({
    name: z.string().min(1).max(80).describe('Bare invocation name, e.g. "deploy-runbook". Letters, digits, ".", "_", "-" only (no ":", no "..").'),
    content: z.string().min(1).describe("The skill's markdown body — the instructions the model reads once it invokes this skill."),
    description: z
      .string()
      .optional()
      .describe(
        'One-line summary of when to use this skill, shown to the model alongside its name. Name the concrete situations it applies to ("when someone asks to deploy the payments API") — a vague description means the skill never fires. Omit if `content` already starts with its own `---` frontmatter.',
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    name: z.string(),
    domain: z.string(),
    action: z.enum(["created", "updated"]),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "create_skill");
    const name = input.name.trim();
    if (!isSafeSkillName(name)) {
      throw new Error(`"${name}" isn't a valid skill name — use letters, digits, ".", "_", "-" only (no ":", no "..").`);
    }
    if (resolveAccessFor(ctx).skills.includes(name)) {
      throw new Error(`"${name}" is already a bundle-granted skill for this session — granted skills always win a name collision, so a domain skill with this name would never actually arm. Choose a different name.`);
    }

    const content = withDescription(input.content, input.description);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_DOMAIN_SKILL_BYTES) {
      throw new Error(`Skill content is ${bytes} bytes — the cap is ${MAX_DOMAIN_SKILL_BYTES} bytes (32KB). Trim it and try again.`);
    }

    const resolved = resolveSkillDomainDetailed(ctx);
    if (resolved.domain === null) {
      throw new Error(domainSkillRefusalMessage(resolved.reason));
    }
    const domain = resolved.domain;

    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const existing = await listDomainSkills(p.org, domain);
    const already = existing.some((s) => s.name === name);
    const cap = domainSkillCap();
    if (!already && existing.length >= cap) {
      throw new Error(`Domain "${domain}" already has ${existing.length} skill(s) — the cap is ${cap} (skills.domainSkillCap). Delete one with delete_skill first.`);
    }

    const binding = bindFrom(ctx);
    // principal-gate: presence — a skill is standing trusted text every future turn of the domain is handed
    const authoredBy = actingPrincipalIdOf(ctx);
    if (!authoredBy) {
      throw new Error("create_skill needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not author standing instructions every later turn of the domain will follow. Ask a person in this conversation to propose it.");
    }

    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "create that skill"));
    }
    const venue = venueResult.venue;

    const action: "created" | "updated" = already ? "updated" : "created";
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "skill.create",
        args: { org: p.org, domain, name, content, action, ...(authoredBy ? { authoredBy } : {}) },
        scopeKey: proposeScopeKey,
        domain,
        requestedBy: authoredBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const subject = `skill "${name}" (${action})`;
    if (posted.autoApproved) {
      return {
        ok: true,
        name,
        domain,
        action,
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      ok: true,
      name,
      domain,
      action,
      pending: true,
      pendingId: posted.id,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to arm it (pending ${posted.id}).${cardPostedTail(venue, "arm it", posted)}`,
    };
  },
}));
