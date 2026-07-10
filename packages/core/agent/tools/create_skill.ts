import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { principalIdOf, resolveAccessFor } from "../access/request.js";
import { isSafeSkillName } from "../scm/repo-skills.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import {
  MAX_DOMAIN_SKILL_BYTES,
  domainSkillCap,
  domainSkillRefusalMessage,
  listDomainSkills,
  resolveSkillDomainDetailed,
  withDescription,
} from "../skills/domain-skills.js";

export default defineTool({
  description:
    "PROPOSE creating or updating a SKILL for this channel's memory domain — a reusable markdown instruction package any future turn in the domain can invoke by its bare name. This does NOT arm the skill: a skill is a procedure the agent loads and FOLLOWS, so a human in the domain must read and approve it first — an approval card posts with the full body, and the skill arms only when someone clicks. Any domain member can propose one, and it becomes invocable once armed. Can't be authored from a DM, a group chat, or an externally-shared/unconfirmed channel, or a surface with no approval-card path (Slack/Discord only) — author from a channel that's actually in the target domain. Write one worth keeping: a trigger-rich description in the words a teammate would use, the intent behind the ask (not just the commands you ran), the edge cases you hit, and one coherent job per skill. The posted card IS the reply — do not add narration after this call.",
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
  }),
  approval: never(),
  async execute(input, ctx) {
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
    const existing = await listDomainSkills(p.org, domain);
    const already = existing.some((s) => s.name === name);
    const cap = domainSkillCap();
    if (!already && existing.length >= cap) {
      throw new Error(`Domain "${domain}" already has ${existing.length} skill(s) — the cap is ${cap} (OE_DOMAIN_SKILL_CAP). Delete one with delete_skill first.`);
    }

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(`create_skill needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must read and arm the skill body before it can be followed.`);
    }
    const authoredBy = principalIdOf(ctx);
    if (!authoredBy) {
      throw new Error("create_skill needs a verified sender to gate the write — no principal id resolved, so there's no author to show on the approval card.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("create_skill couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const action: "created" | "updated" = already ? "updated" : "created";
    const tainted = untrustedIngestedThisTurn();
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "skill.create",
        args: { org: p.org, domain, name, content, action, ...(authoredBy ? { authoredBy } : {}), tainted },
        scopeKey: p.surfaceKey,
        domain,
        requestedBy: authoredBy,
        channelId,
        threadTs: binding.threadTs ?? null,
      },
      approvalPostDeps(binding.platform),
    );

    return {
      ok: true,
      name,
      domain,
      action,
      pending: true,
      pendingId: posted.id,
      message: `card posted — skill "${name}" (${action})${tainted ? " ⚠ tainted" : ""} awaiting a human to arm it (pending ${posted.id}).`,
    };
  },
});
