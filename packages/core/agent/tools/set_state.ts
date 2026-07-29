import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, resolveWindowSources } from "../identity/binding.js";
import type { BindableContext } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { resolveEntityAction, currentTurnEntityRef, supportedEntityActionPlatforms } from "../channels/entity-actions.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import type { TicketSetStateArgs } from "../approvals/ticket-actions.js";
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

export const setStateEntry = defineTool({
  description:
    "PROPOSE changing a ticket's status — a Linear issue's workflow state (e.g. \"Done\"), or a GitHub " +
    'issue/PR\'s state ("open"/"closed"). Entity-gated: only works on a ticketing surface; refuses ' +
    "cleanly on chat or Notion. Consequential: posts an approval card — nothing changes until a human " +
    "on this surface confirms. Needs a surface with an approval-card path (Slack or Discord). The posted " +
    "card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    ref: refSchema,
    state: z.string().min(1).describe('The target state — e.g. "Done"/"In Progress" (Linear), or "open"/"closed" (GitHub).'),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    platform: z.string(),
    id: z.string(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    await requireSessionContinuation(bctx, "set_state");
    const { ref } = await resolveEntityAction(bctx, "setState", input.ref, safeDomains());

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(
        `set_state needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must confirm the state change.`,
      );
    }
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("set_state needs a verified sender to gate the change — no principal id resolved, so there's no requester to show on the approval card.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("set_state couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const p = resolvePartition(ctx);
    const args: TicketSetStateArgs = {
      org: p.org,
      scopeKey: p.surfaceKey,
      platform: ref.platform,
      entityId: ref.id,
      state: input.state,
      requestedBy,
      tainted: untrustedIngestedThisTurn(),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "ticket.set_state",
        args,
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    return {
      pending: true,
      pendingId: posted.id,
      platform: ref.platform,
      id: ref.id,
      message: `card posted — set ${ref.platform} ${ref.id} state to "${input.state}" awaiting a human to confirm (pending ${posted.id}).`,
    };
  },
});
preRegisterDynamicEntry("set_state", "_single", setStateEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bctx = ctx as BindableContext;
      const sources = resolveWindowSources(bctx, safeDomains());
      const adapterPlatforms = supportedEntityActionPlatforms();
      if (!sources.some((s) => adapterPlatforms.includes(s)) && !currentTurnEntityRef(bctx)) return null;
      return setStateEntry;
    },
  },
});
