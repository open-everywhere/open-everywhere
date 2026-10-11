import { entityActionFn } from "../channels/entity-actions.js";
import { appendAudit } from "../audit/audit.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import type { RepoCapability } from "../access/repo-capabilities.js";
import { plainValue } from "./plain-text.js";

interface TicketActionArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly platform: string;
  readonly entityId: string;
  readonly organizationId?: string;
  readonly requestedBy: string;
  readonly tainted?: boolean;
  readonly capabilities?: readonly RepoCapability[];
}

export interface TicketSetStateArgs extends TicketActionArgs {
  readonly state: string;
}

export interface TicketAssignArgs extends TicketActionArgs {
  readonly assignee: string;
}

function taintedLine(tainted: boolean | undefined): string[] {
  return tainted ? ["⚠ proposed in a turn that read external content — review before approving"] : [];
}

async function executeTicketVerb(
  args: TicketActionArgs & { readonly value: string },
  verb: "setState" | "assign",
  decidedBy: string,
  auditAction: string,
): Promise<string> {
  const fn = entityActionFn(args.platform, verb);
  if (!fn) {
    throw new Error(`${auditAction}: no "${verb}" adapter is registered for platform "${args.platform}" (was it removed since this was proposed?).`);
  }
  const outcome = await fn(args.entityId, args.value, args.organizationId, args.capabilities ?? []);
  await appendAudit({
    ...whereFromScope(args.org, args.scopeKey),
    principalId: decidedBy,
    action: auditAction,
    detail: { platform: args.platform, entityId: args.entityId, value: args.value, requestedBy: args.requestedBy, tainted: Boolean(args.tainted) },
  });
  return outcome;
}

const ticketSetState: ActionKind<TicketSetStateArgs> = {
  kind: "ticket.set_state",
  policy: "member",
  plainSummary(args) {
    return `Move ${plainValue(args.platform)} ${plainValue(args.entityId)} to "${plainValue(args.state)}"`;
  },
  summarize(args) {
    return [`Set ${args.platform} ${args.entityId} state → "${args.state}"`, ...taintedLine(args.tainted)];
  },
  execute(args, decidedBy) {
    return executeTicketVerb({ ...args, value: args.state }, "setState", decidedBy, "ticket.set_state");
  },
};

const ticketAssign: ActionKind<TicketAssignArgs> = {
  kind: "ticket.assign",
  policy: "member",
  plainSummary(args) {
    return `Assign ${plainValue(args.platform)} ${plainValue(args.entityId)} to ${plainValue(args.assignee)}`;
  },
  summarize(args) {
    return [`Assign ${args.platform} ${args.entityId} → ${args.assignee}`, ...taintedLine(args.tainted)];
  },
  execute(args, decidedBy) {
    return executeTicketVerb({ ...args, value: args.assignee }, "assign", decidedBy, "ticket.assign");
  },
};

registerActionKind(ticketSetState);
registerActionKind(ticketAssign);
