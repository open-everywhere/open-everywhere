import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { adminStandingSubject } from "../access/admin-standing.js";
import { getConfig } from "../access/config.js";
import { adminControlRoles } from "../access/roles.js";
import { requireAdminReadVenue } from "../access/admin-read-venue.js";
import { memoryListView } from "../control/views.js";

export default defineTool({
  description:
    'ADMIN ONLY: enumerate every memory silo you are allowed to inspect — org -> domains -> silos -> files, with sizes. Two fences apply. ROLE: org admins cover every eligible silo, domain admins only the silos an explicit domain of theirs references. VENUE: the ORG-WIDE listing answers only in the governance channel or in a DM with the asker; in any other channel it is narrowed to that channel\'s own domain, or redirected. DM/personal memory and any silo referenced only by the org/public/dm pseudo-domains stay excluded, even for an org admin — same fail-closed privacy rule as the out-of-band control plane. Read-only; pass "silo" to see one silo\'s files, omit it to see everything you cover.',
  inputSchema: z.object({
    silo: z.string().optional().describe("Narrow to one silo's files (a name from a prior call). Omit to list every silo you cover."),
  }),
  outputSchema: z.object({
    org: z.string(),
    scope: z.enum(["org-wide", "domain-scoped"]),
    note: z.string().optional(),
    tiers: z.array(
      z.object({
        silo: z.string(),
        domains: z.array(z.string()).describe("Explicit domains referencing this silo — empty means admin-only (org-brain / an orphaned silo)."),
        provider: z.string(),
        backing: z.string(),
        readOnly: z.boolean(),
        files: z.array(z.object({ path: z.string(), bytes: z.number() })),
        totalBytes: z.number(),
      }),
    ),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const subject = adminStandingSubject(binding, ctx);
    if (!subject.ok) throw new Error(`memory_admin_list: ${subject.message}`);
    const caller = subject.principalId;
    const domains = getConfig().loadDomains();
    const roles = adminControlRoles(caller, domains, binding.platform, binding.workspace, binding.enterprise);
    if (roles.length === 0) {
      throw new Error(
        `memory_admin_list requires an org admin, or a domain admin for at least one memory domain. Your id ("${caller}") ` +
          `isn't listed on the "org" pseudo-domain's admins or any explicit domain's admins (Domain.admins, agent/memory/config/domains.ts).`,
      );
    }

    const venue = await requireAdminReadVenue(ctx, { roles, principalId: caller, kind: "memory.admin_list" });
    const effective = venue.roles;
    const scope = venue.decision.placement === "org-wide" ? ("org-wide" as const) : ("domain-scoped" as const);
    const framing = { scope, ...(venue.note ? { note: venue.note } : {}) };

    const result = await memoryListView(binding.org, effective);
    if (!input.silo) return { ...result, ...framing };

    const tiers = result.tiers.filter((t) => t.silo === input.silo);
    if (tiers.length === 0) {
      throw new Error(`no memory silo named "${input.silo}" among the ones your roles cover in this room (call memory_admin_list with no "silo" to see what you can reach here).`);
    }
    return { org: result.org, tiers, ...framing };
  },
});
