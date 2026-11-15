import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { platformName } from "../channels/friendly-ids.js";
import { ticketCreateFn } from "../channels/ticket-create.js";
import { appendAudit } from "../audit/audit.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

export interface TicketCreateArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly platform: string;
  readonly target: string;
  readonly organizationId?: string;
  readonly title: string;
  readonly body: string;
  readonly requestedBy: string;
  /** @deprecated Since OPE-2717 nothing writes or reads it. A card frozen before the deploy can still carry it; it is ignored. OPE-2721 removes it. */
  readonly tainted?: boolean;
}

function summarizeCreate(args: TicketCreateArgs): string[] {
  const lines = [`File a new ${args.platform} work item in ${args.target}`, `Title: ${args.title}`];
  if (args.body.trim().length > 0) lines.push(args.body);
  return lines;
}

const ticketCreate: ActionKind<TicketCreateArgs> = {
  kind: "ticket.create",
  policy: "member",
  plainSummary: (args) => `File a new ${platformName(args.platform)} issue in ${plainValue(args.target)}: ${plainValue(args.title, 60)}`,
  consequence: (args) => (args.body.trim().length > 0 ? plainQuote(args.body, QUOTE_MAX - 2) : undefined),
  consequenceQuotes: true,
  summarize: summarizeCreate,
  async execute(args, decidedBy) {
    const fn = ticketCreateFn(args.platform);
    if (!fn) {
      throw new Error(`ticket.create: no create adapter is registered for platform "${args.platform}" (was it removed since this was proposed?).`);
    }
    const created = await fn(args.target, { title: args.title, body: args.body }, args.organizationId);
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "ticket.create",
      detail: {
        platform: args.platform,
        target: args.target,
        title: args.title,
        entityId: created.ref.id,
        ...(created.url ? { url: created.url } : {}),
        requestedBy: args.requestedBy,
      },
    });
    return created.url ? `${created.summary} ${created.url}` : created.summary;
  },
};

registerActionKind(ticketCreate);
