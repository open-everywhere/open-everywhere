import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { principalIdOf, resolveAccessFor } from "../access/request.js";
import { auditToolAction } from "../audit/tool-action.js";
import { isSafeSkillName } from "../scm/repo-skills.js";
import {
  MAX_DOMAIN_SKILL_BYTES,
  domainSkillCap,
  domainSkillRefusalMessage,
  listDomainSkills,
  putDomainSkill,
  resolveSkillDomainDetailed,
  withDescription,
} from "../skills/domain-skills.js";

export default defineTool({
  description:
    "Create or update a SKILL for this channel's memory domain — a reusable markdown instruction package any future turn in the domain can invoke by its bare name. Any domain member can author one; it's audited but never needs approval, and it becomes invocable from your NEXT turn (skills resolve at turn start, not mid-turn). Can't be authored from a DM, a group chat, or an externally-shared/unconfirmed channel — author from a channel that's actually in the target domain.",
  inputSchema: z.object({
    name: z.string().min(1).max(80).describe('Bare invocation name, e.g. "deploy-runbook". Letters, digits, ".", "_", "-" only (no ":", no "..").'),
    content: z.string().min(1).describe("The skill's markdown body — the instructions the model reads once it invokes this skill."),
    description: z
      .string()
      .optional()
      .describe("One-line summary of when to use this skill, shown to the model alongside its name. Omit if `content` already starts with its own `---` frontmatter."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    name: z.string(),
    domain: z.string(),
    action: z.enum(["created", "updated"]),
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

    const updatedBy = principalIdOf(ctx);
    await putDomainSkill(p.org, domain, name, content, updatedBy, new Date().toISOString());
    await auditToolAction(ctx, already ? "skill.update" : "skill.create", { domain, name });

    const action = already ? "updated" : "created";
    return {
      ok: true,
      name,
      domain,
      action,
      message: `Skill "${name}" ${action} for domain "${domain}" — armed from your next turn.`,
    };
  },
});
