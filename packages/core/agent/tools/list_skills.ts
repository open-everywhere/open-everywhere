import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolveSkillEntries } from "../skills/scoped.js";

export default defineTool({
  description:
    "List the skills available to you right now in this session, with their provenance (bundle-granted, this channel's domain, or repo-discovered). Use when asked what skills/capabilities are available here, or to check existing names before create_skill / delete_skill.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    skills: z.array(
      z.object({
        name: z.string(),
        tier: z.enum(["granted", "domain", "repo"]),
        description: z.string(),
        updatedBy: z.string().optional(),
        updatedAt: z.string().optional(),
      }),
    ),
  }),
  approval: never(),
  async execute(_input, ctx) {
    const entries = await resolveSkillEntries(ctx);
    const skills = entries
      .map((e) => ({
        name: e.name,
        tier: e.tier,
        description: e.pkg.description,
        ...(e.updatedBy ? { updatedBy: e.updatedBy } : {}),
        ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { skills };
  },
});
