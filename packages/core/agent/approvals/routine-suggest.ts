import { plainValue } from "./plain-text.js";
import { actionKind, registerActionKind } from "./actions.js";
import { appendAudit } from "../audit/audit.js";
import { agentCommandName } from "../identity/bot-name.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { proposalWhen, type RoutineSuggestArgs } from "../personal-watch/discovery.js";
import { recordRoomProposalOutcome, type RoomRoutineSuggestArgs } from "../personal-watch/room-discovery.js";
import { recordProposalOutcome } from "../personal-watch/state.js";
import { BRIEF_CRON, NEEDS_YOU_CRON, type FirstDayBriefArgs } from "../onboarding/first-day-brief.js";
import { cronWords } from "../routines/schedule-words.js";
import { listRoutines, updateRoutine } from "../routines/store.js";
import type { ActionKind } from "./types.js";

export type AnyRoutineSuggestArgs = RoutineSuggestArgs | RoomRoutineSuggestArgs | FirstDayBriefArgs;

function isFirstDayCard(args: AnyRoutineSuggestArgs): args is FirstDayBriefArgs {
  return (args as { scope?: unknown }).scope === "first-day";
}

function isRoomCard(args: AnyRoutineSuggestArgs): args is RoomRoutineSuggestArgs {
  return (args as { scope?: unknown }).scope === "room";
}

function roomWhere(args: RoomRoutineSuggestArgs): { org: string; platform: string; workspace: string; surface: string } {
  const [platform = "unknown", workspace = "", ...rest] = args.surfaceKey.split("/");
  return { org: args.org, platform, workspace, surface: rest.join("/") };
}

function refuseOthers(args: RoutineSuggestArgs | FirstDayBriefArgs, decidedBy: string): void {
  if (decidedBy !== args.personId) throw new Error("only the person this suggestion is for can answer it");
}

function whereOf(args: RoutineSuggestArgs | FirstDayBriefArgs): { org: string; platform: string; workspace: string; surface: string } {
  const p = parsePrincipalKey(args.principalKey);
  return { org: args.org, platform: p?.platform ?? "unknown", workspace: p?.tenant ?? "", surface: "home" };
}

const routineSuggest: ActionKind<AnyRoutineSuggestArgs> = {
  kind: "routine.suggest",
  policy: "member",
  sessionless: true,
  plainSummary(args) {
    if (isFirstDayCard(args)) return "Want a morning brief and check-ins?";
    return `Set up a routine to ${plainValue(args.work, 60)} ${proposalWhen(args)}?`;
  },
  consequence(args) {
    if (isFirstDayCard(args)) return "A short brief each weekday at 09:00 UTC, and check-ins at 11:00, 14:00 and 17:00 UTC that post only when something needs you.";
    if (isRoomCard(args)) {
      return `${args.people} people here asked me for this in ${args.weeks} of the last 5 weeks. Nothing runs until someone sets it up. \`/${agentCommandName()} suggest off\` stops these.`;
    }
    return `You asked me for this in ${args.weeks} of the last 5 weeks. Nothing runs until you press Set it up, and I won't suggest it again.`;
  },
  optionLabels() {
    return { approve: "Set it up", reject: "No thanks" };
  },
  doneSummary(args) {
    if (isFirstDayCard(args)) return "set up a morning brief and check-ins";
    return `set up a routine to ${plainValue(args.work, 60)} ${proposalWhen(args)}`;
  },
  summarize(args) {
    if (isFirstDayCard(args)) {
      return [
        "Suggested first-day brief — a morning brief and check-ins, in the person's own DM",
        `Brief: ${cronWords(BRIEF_CRON)}, posts every run, the first run at once`,
        `> ${args.brief.prompt}`,
        `Needs-you watch: ${cronWords(NEEDS_YOU_CRON)}, posts nothing when a check finds nothing`,
        `> ${args.needsYou.prompt}`,
      ];
    }
    if (isRoomCard(args)) return [`Suggested routine — ${args.summary}`, `Runs ${proposalWhen(args)} in this room`, `> ${args.create.prompt}`];
    return [`Suggested routine — ${args.summary}`, `Runs ${proposalWhen(args)} in the person's own DM`, `> ${args.create.prompt}`];
  },
  async execute(args, decidedBy) {
    if (isFirstDayCard(args)) {
      refuseOthers(args, decidedBy);
      const create = actionKind("routine.create");
      if (!create) throw new Error("the routine path is not registered on this deployment");
      const startedAt = new Date().toISOString();
      await create.execute(args.needsYou, decidedBy);
      try {
        await create.execute(args.brief, decidedBy);
      } catch (err) {
        const armed = (await listRoutines(args.needsYou.partition).catch(() => [])).filter(
          (r) => r.status === "active" && r.prompt === args.needsYou.prompt && r.createdBy === args.personId && r.createdAt >= startedAt,
        );
        for (const r of armed) {
          await updateRoutine(r.org, r.surfaceKey, r.id, { status: "disabled", disabledReason: "the morning brief did not arm, so its needs-you watch was stopped", nextRunAt: null }).catch(() => undefined);
        }
        throw err;
      }
      await recordProposalOutcome(args.org, args.principalKey, args.fingerprint, "accepted").catch(() => "unknown");
      await appendAudit({ ...whereOf(args), principalId: args.principalKey, action: "personal_watch.proposal.accepted", detail: { fingerprint: args.fingerprint } });
      return "set up your morning brief and check-ins. The first brief is on its way";
    }
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
    if (isFirstDayCard(args)) {
      refuseOthers(args, decidedBy);
      await recordProposalOutcome(args.org, args.principalKey, args.fingerprint, "declined");
      await appendAudit({ ...whereOf(args), principalId: args.principalKey, action: "personal_watch.proposal.declined", detail: { fingerprint: args.fingerprint } });
      return "I won't offer this again. Ask me any time if you want a brief";
    }
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
