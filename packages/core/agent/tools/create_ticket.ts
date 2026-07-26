import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, resolveWindowSources } from "../identity/binding.js";
import type { BindableContext } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { resolveTicketCreate, supportedTicketCreatePlatforms } from "../channels/ticket-create.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import type { TicketCreateArgs } from "../approvals/ticket-create.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export const createTicketEntry = defineTool({
  description:
    "PROPOSE filing a NEW work item — a GitHub issue or a Linear issue — on a work surface this " +
    "conversation is bound to. Use it to turn a reported defect or a follow-up into tracked work. " +
    "Consequential: posts an approval card showing the exact title and body — nothing is filed until " +
    "a human on this surface confirms. Needs a surface with an approval-card path (Slack or Discord). " +
    "Write the body like a ticket: what happens, what should happen, and how to reproduce or verify. " +
    "The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    platform: z
      .string()
      .min(1)
      .optional()
      .describe('Which work surface to file on — "github" or "linear". Optional: defaults to this window\'s only work surface.'),
    target: z
      .string()
      .min(1)
      .optional()
      .describe('Where on that surface — a GitHub repo as "owner/repo", or a Linear team key such as "ENG". Optional: defaults to this turn\'s own repo/team when there is one.'),
    title: z.string().min(1).describe("One-line summary of the work item."),
    body: z.string().describe("The full description (markdown): what happens, what should happen, how to reproduce or verify."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    platform: z.string(),
    target: z.string(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    await requireSessionContinuation(bctx, "create_ticket");
    const { platform, target } = resolveTicketCreate(
      bctx,
      input.platform || input.target ? { ...(input.platform ? { platform: input.platform } : {}), ...(input.target ? { target: input.target } : {}) } : undefined,
      safeDomains(),
    );

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(
        `create_ticket needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must confirm before anything is filed.`,
      );
    }
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("create_ticket needs a verified sender to gate the filing — no principal id resolved, so there's no requester to show on the approval card.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("create_ticket couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const p = resolvePartition(ctx);
    const args: TicketCreateArgs = {
      org: p.org,
      scopeKey: p.surfaceKey,
      platform,
      target,
      title: input.title,
      body: input.body,
      requestedBy,
      tainted: untrustedIngestedThisTurn(),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "ticket.create",
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
      platform,
      target,
      message: `card posted — file "${input.title}" on ${platform} (${target}) awaiting a human to confirm (pending ${posted.id}).`,
    };
  },
});
preRegisterDynamicEntry("create_ticket", "_single", createTicketEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bctx = ctx as BindableContext;
      const sources = resolveWindowSources(bctx, safeDomains());
      const adapterPlatforms = supportedTicketCreatePlatforms();
      if (!sources.some((s) => adapterPlatforms.includes(s))) return null;
      return createTicketEntry;
    },
  },
});
