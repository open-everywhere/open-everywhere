import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { adminControlRoles } from "../access/roles.js";
import { memoryReadView } from "../control/views.js";
import { siloScopeDenial } from "../control/auth.js";
import { MEMORY_WRITE_MAX_BYTES } from "../control/writes.js";
import { appendAudit } from "../audit/audit.js";

export default defineTool({
  description:
    "ADMIN ONLY: read one file's raw content out of one memory silo (memory_admin_list for silo names + file lists), from ANY channel or DM — the gate is YOUR role, not which channel you're speaking in. Org admins can read every eligible silo; domain admins only the silos an explicit domain of theirs references. DM/personal memory and org-brain-style pseudo-domain-only silos stay excluded, same as the out-of-band control plane. Capped at 64KB (use the out-of-band control-plane memory_read tool for anything bigger). Read-only; every call is audited (more exposed than the out-of-band control MCP, since it renders in a Slack thread).",
  inputSchema: z.object({
    silo: z.string().min(1).describe("Silo name, from memory_admin_list."),
    relPath: z.string().min(1).describe('File path within the silo, e.g. "MEMORY.md" or "people.md".'),
  }),
  outputSchema: z.object({
    org: z.string(),
    silo: z.string(),
    relPath: z.string(),
    content: z.string(),
    bytes: z.number(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    if (!binding.principalId) {
      throw new Error(
        "memory_admin_read needs a verified sender on this turn — no principal id resolved, so there's no caller to check admin standing for.",
      );
    }
    const domains = getConfig().loadDomains();
    const roles = adminControlRoles(binding.principalId, domains);
    if (roles.length === 0) {
      throw new Error(
        `memory_admin_read requires an org admin, or a domain admin for at least one memory domain. Your id ("${binding.principalId}") ` +
          `isn't listed on the "org" pseudo-domain's admins or any explicit domain's admins (Domain.admins, agent/memory/domains.ts).`,
      );
    }
    const denial = siloScopeDenial(roles, binding.org, input.silo, domains);
    if (denial) throw new Error(denial);

    const result = await memoryReadView({ org: binding.org, silo: input.silo, relPath: input.relPath });
    if (result.bytes > MEMORY_WRITE_MAX_BYTES) {
      throw new Error(
        `"${input.relPath}" is ${result.bytes} bytes, over the ${MEMORY_WRITE_MAX_BYTES / 1024}KB in-Slack read cap — use the out-of-band control-plane memory_read tool for a file this size.`,
      );
    }

    await appendAudit({
      org: binding.org,
      platform: binding.platform,
      workspace: binding.workspace,
      surface: binding.surface,
      principalId: binding.principalId,
      action: "memory.admin_read",
      detail: { silo: input.silo, relPath: input.relPath, bytes: result.bytes, roles },
    });

    return result;
  },
});
