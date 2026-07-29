import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveEntityAction, currentTurnEntityRef, supportedEntityActionPlatforms } from "../channels/entity-actions.js";
import { resolveWindowSources, type BindableContext } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { auditToolAction } from "../audit/tool-action.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const refSchema = z
  .object({
    platform: z.string().min(1).describe('Ticketing surface — "linear" or "github".'),
    id: z.string().min(1).describe('Entity id — a Linear issue UUID/identifier (e.g. "ENG-42"), or GitHub "owner/repo#123".'),
  })
  .optional()
  .describe("The ticket to act on. Defaults to the current turn's entity (the Linear issue or GitHub issue/PR this turn is on).");

export const addLabelEntry = defineTool({
  description:
    "Add a label to a ticket — a Linear issue or a GitHub issue/PR. Entity-gated: only works on a " +
    "ticketing surface; refuses cleanly on chat or Notion. ADDITIVE (never replaces existing labels). " +
    "Defaults to the current turn's ticket. Reversible, no approval needed.",
  inputSchema: z.object({
    ref: refSchema,
    label: z.string().min(1).describe('The label name — e.g. "bug" (must already exist on the entity\'s team/repo).'),
  }),
  outputSchema: z.object({ platform: z.string(), id: z.string(), label: z.string(), message: z.string() }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    const { ref, run } = await resolveEntityAction(bctx, "addLabel", input.ref, safeDomains());
    const message = await run(input.label);
    await auditToolAction(bctx, "ticket.add_label", { platform: ref.platform, entityId: ref.id, label: input.label });
    return { platform: ref.platform, id: ref.id, label: input.label, message };
  },
});
preRegisterDynamicEntry("add_label", "_single", addLabelEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bctx = ctx as BindableContext;
      const sources = resolveWindowSources(bctx, safeDomains());
      const adapterPlatforms = supportedEntityActionPlatforms();
      if (!sources.some((s) => adapterPlatforms.includes(s)) && !currentTurnEntityRef(bctx)) return null;
      return addLabelEntry;
    },
  },
});
