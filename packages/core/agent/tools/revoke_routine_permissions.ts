import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger } from "../routines/routine.js";
import { ROUTINE_PERMISSIONS_REVOKED_ACTION, listRoutinePermissions, revokeRoutinePermissions } from "../routines/declared-permissions.js";
import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeFrom } from "../identity/binding.js";

export default defineTool({
  description:
    "Withdraw a routine's STANDING permissions — the things it was allowed to do unattended without asking — while leaving the routine itself running on its schedule. Get the id and see what it currently holds with list_routines. Use when someone wants a routine to go back to asking before it acts ('stop letting the nightly job open PRs'), or is unhappy with what a routine can do on its own. To stop the routine entirely instead, use cancel_routine.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
  }),
  outputSchema: z.object({
    revoked: z.number().describe("How many standing permissions were withdrawn (0 = it already asked for everything)."),
    id: z.string(),
    trigger: z.string(),
    permissions: z.array(z.string()).describe("What it held, in plain language, before this call."),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const id = input.id.trim();

    // principal-gate: presence — 🔴 this tool posts NO card at all (open tier), so this refusal is the ONLY
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "revoke_routine_permissions needs a verified sender so the audit log can name who withdrew the permissions — a triggered routine fire has no acting sender (only the creator it is attributed to). Ask a person in this conversation to run it.",
      );
    }

    const routine = await getRoutine(p.org, p.surfaceKey, id);
    if (!routine) {
      throw new Error(`No routine '${id}' on this surface — check the id with list_routines.`);
    }

    const held = await listRoutinePermissions(p.org, routine, new Date().toISOString());
    const { permissions: revoked, rows } = await revokeRoutinePermissions(p.org, routine);
    if (rows > 0) {
      await appendAudit({
        org: p.org,
        platform: p.platform,
        workspace: p.workspace,
        surface: p.surface,
        ...auditSurfaceModeFrom(ctx),
        principalId: requestedBy,
        action: ROUTINE_PERMISSIONS_REVOKED_ACTION,
        detail: { id, revokedBy: requestedBy, count: revoked, rows, permissions: held },
      });
    }

    const trigger = describeTrigger(routine.trigger, routine.report);
    return {
      revoked,
      id,
      trigger,
      permissions: held,
      message:
        revoked > 0
          ? `routine ${id} no longer has standing permission to ${held.join(" · ")} — it keeps running (${trigger}) and will post an approval card for each of those from now on.`
          : rows > 0
            ? `routine ${id} had no standing permissions — it already asks a human before every gated action. This did clear its permission-card record, so it may ask again on its next fire. It keeps running (${trigger}).`
            : `routine ${id} had no standing permissions — it already asks a human before every gated action. It keeps running (${trigger}).`,
    };
  },
});
