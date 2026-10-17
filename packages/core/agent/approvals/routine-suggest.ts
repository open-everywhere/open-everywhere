import { plainValue } from "./plain-text.js";
import { actionKind, registerActionKind } from "./actions.js";
import { appendAudit } from "../audit/audit.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { proposalWhen, type RoutineSuggestArgs } from "../personal-watch/discovery.js";
import { recordRoomProposalOutcome, type RoomRoutineSuggestArgs } from "../personal-watch/room-discovery.js";
import { recordProposalOutcome } from "../personal-watch/state.js";
import type { ActionKind } from "./types.js";

export type AnyRoutineSuggestArgs = RoutineSuggestArgs | RoomRoutineSuggestArgs;

function isRoomCard(args: AnyRoutineSuggestArgs): args is RoomRoutineSuggestArgs {
  return (args as { scope?: unknown }).scope === "room";
}

function roomWhere(args: RoomRoutineSuggestArgs): { org: string; platform: string; workspace: string; surface: string } {
  const [platform = "unknown", workspace = "", ...rest] = args.surfaceKey.split("/");
  return { org: args.org, platform, workspace, surface: rest.join("/") };
}

function refuseOthers(args: RoutineSuggestArgs, decidedBy: string): void {
  if (decidedBy !== args.personId) throw new Error("only the person this suggestion is for can answer it");
}

function whereOf(args: RoutineSuggestArgs): { org: string; platform: string; workspace: string; surface: string } {
  const p = parsePrincipalKey(args.principalKey);
  return { org: args.org, platform: p?.platform ?? "unknown", workspace: p?.tenant ?? "", surface: "home" };
}

const routineSuggest: ActionKind<AnyRoutineSuggestArgs> = {
  kind: "routine.suggest",
  policy: "member",
  sessionless: true,
  plainSummary(args) {
    return `Set up a routine to ${plainValue(args.work, 60)} ${proposalWhen(args)}?`;
  },
  consequence(args) {
    if (isRoomCard(args)) {
      return `${args.people} people in this room asked me for this in ${args.weeks} of the last 5 weeks. Nothing runs until someone presses Set it up, and I won't suggest it here again.`;
    }
    return `You asked me for this in ${args.weeks} of the last 5 weeks. Nothing runs until you press Set it up, and I won't suggest it again.`;
  },
  optionLabels() {
    return { approve: "Set it up", reject: "No thanks" };
  },
  doneSummary(args) {
    return `set up a routine to ${plainValue(args.work, 60)} ${proposalWhen(args)}`;
  },
  summarize(args) {
    if (isRoomCard(args)) return [`Suggested routine — ${args.summary}`, `Runs ${proposalWhen(args)} in this room`, `> ${args.create.prompt}`];
    return [`Suggested routine — ${args.summary}`, `Runs ${proposalWhen(args)} in the person's own DM`, `> ${args.create.prompt}`];
  },
  async execute(args, decidedBy) {
    if (isRoomCard(args)) {
      const create = actionKind("routine.create");
      if (!create) throw new Error("the routine path is not registered on this deployment");
      const line = await create.execute({ ...args.create, createdBy: decidedBy }, decidedBy);
      await recordRoomProposalOutcome(args.org, args.surfaceKey, args.fingerprint, "accepted").catch(() => "unknown");
      await appendAudit({ ...roomWhere(args), principalId: decidedBy, action: "room_watch.proposal.accepted", detail: { fingerprint: args.fingerprint } });
      return line;
    }
    refuseOthers(args, decidedBy);
    const create = actionKind("routine.create");
    if (!create) throw new Error("the routine path is not registered on this deployment");
    const line = await create.execute(args.create, decidedBy);
    await recordProposalOutcome(args.org, args.principalKey, args.fingerprint, "accepted").catch(() => "unknown");
    await appendAudit({ ...whereOf(args), principalId: args.principalKey, action: "personal_watch.proposal.accepted", detail: { fingerprint: args.fingerprint } });
    return line;
  },
  async declined(args, decidedBy) {
    if (isRoomCard(args)) {
      await recordRoomProposalOutcome(args.org, args.surfaceKey, args.fingerprint, "declined");
      await appendAudit({ ...roomWhere(args), principalId: decidedBy, action: "room_watch.proposal.declined", detail: { fingerprint: args.fingerprint } });
      return "I won't suggest this here again";
    }
    refuseOthers(args, decidedBy);
    await recordProposalOutcome(args.org, args.principalKey, args.fingerprint, "declined");
    await appendAudit({ ...whereOf(args), principalId: args.principalKey, action: "personal_watch.proposal.declined", detail: { fingerprint: args.fingerprint } });
    return "I won't suggest this again";
  },
};

registerActionKind(routineSuggest);
