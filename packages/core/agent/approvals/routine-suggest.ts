import { plainValue } from "./plain-text.js";
import { actionKind, registerActionKind } from "./actions.js";
import { appendAudit } from "../audit/audit.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { proposalWhen, type RoutineSuggestArgs } from "../personal-watch/discovery.js";
import { recordProposalOutcome } from "../personal-watch/state.js";
import type { ActionKind } from "./types.js";

function refuseOthers(args: RoutineSuggestArgs, decidedBy: string): void {
  if (decidedBy !== args.personId) throw new Error("only the person this suggestion is for can answer it");
}

function whereOf(args: RoutineSuggestArgs): { org: string; platform: string; workspace: string; surface: string } {
  const p = parsePrincipalKey(args.principalKey);
  return { org: args.org, platform: p?.platform ?? "unknown", workspace: p?.tenant ?? "", surface: "home" };
}

const routineSuggest: ActionKind<RoutineSuggestArgs> = {
  kind: "routine.suggest",
  policy: "member",
  sessionless: true,
  plainSummary(args) {
    return `Set up a routine to ${plainValue(args.work, 60)} ${proposalWhen(args)}?`;
  },
  consequence(args) {
    return `You asked me for this in ${args.weeks} of the last 5 weeks. Nothing runs until you press Set it up, and I won't suggest it again.`;
  },
  optionLabels() {
    return { approve: "Set it up", reject: "No thanks" };
  },
  doneSummary(args) {
    return `set up a routine to ${plainValue(args.work, 60)} ${proposalWhen(args)}`;
  },
  summarize(args) {
    return [`Suggested routine — ${args.summary}`, `Runs ${proposalWhen(args)} in the person's own DM`, `> ${args.create.prompt}`];
  },
  async execute(args, decidedBy) {
    refuseOthers(args, decidedBy);
    const create = actionKind("routine.create");
    if (!create) throw new Error("the routine path is not registered on this deployment");
    const line = await create.execute(args.create, decidedBy);
    await recordProposalOutcome(args.org, args.principalKey, args.fingerprint, "accepted").catch(() => "unknown");
    await appendAudit({ ...whereOf(args), principalId: args.principalKey, action: "personal_watch.proposal.accepted", detail: { fingerprint: args.fingerprint } });
    return line;
  },
  async declined(args, decidedBy) {
    refuseOthers(args, decidedBy);
    await recordProposalOutcome(args.org, args.principalKey, args.fingerprint, "declined");
    await appendAudit({ ...whereOf(args), principalId: args.principalKey, action: "personal_watch.proposal.declined", detail: { fingerprint: args.fingerprint } });
    return "I won't suggest this again";
  },
};

registerActionKind(routineSuggest);
