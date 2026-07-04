import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { deleteDomainSkill, domainSkillRefusalMessage, resolveSkillDomainDetailed } from "../skills/domain-skills.js";
import { auditToolAction } from "../audit/tool-action.js";
import { resolvePartition } from "../memory/partition.js";

export default defineTool({
  description:
    "Delete a domain skill created with create_skill, by its bare name (see list_skills). Any member of the domain may delete it. Can't be used from a DM, a group chat, or an externally-shared/unconfirmed channel.",
  inputSchema: z.object({
    name: z.string().min(1).describe("The skill's bare name, as shown by list_skills."),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
    domain: z.string(),
    name: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const resolved = resolveSkillDomainDetailed(ctx);
    if (resolved.domain === null) {
      throw new Error(domainSkillRefusalMessage(resolved.reason));
    }
    const domain = resolved.domain;
    const name = input.name.trim();
    const p = resolvePartition(ctx);
    const deleted = await deleteDomainSkill(p.org, domain, name);
    if (!deleted) {
      throw new Error(`No skill named "${name}" in domain "${domain}" — check the name with list_skills.`);
    }
    await auditToolAction(ctx, "skill.delete", { domain, name });
    return { deleted, domain, name };
  },
});
