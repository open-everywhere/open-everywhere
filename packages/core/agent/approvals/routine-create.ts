import { sourceWords, toolWords, triggerWords } from "../routines/schedule-words.js";
import { watchWords } from "../routines/ask-watch.js";
import { routinePermissionKind, shortUtc } from "./session-grant.js";
import { QUOTE_MAX, plainCode, plainQuote, plainValue } from "./plain-text.js";
import { placeWords } from "../channels/friendly-ids.js";
import { addRoutine, newRoutineId } from "../routines/store.js";
import { computeNextRun } from "../routines/schedule.js";
import { describeTrigger, routinePermissionGeneration, type Routine, type RoutineReport, type RoutineTrigger } from "../routines/routine.js";
import { mintJobBound } from "../routines/bound.js";
import {
  ROUTINE_PERMISSIONS_ARMED_ACTION,
  ROUTINE_PERMISSION_NEVER_LIFTS_ACTION,
  bundleRaisedDeclarations,
  describeDeclaredPermissions,
  namesUnliftableTool,
  armDeclaredRoutinePermissions,
  unarmedDeclarations,
} from "../routines/declared-permissions.js";
import { resolveRoutineCollector } from "../routines/collector.js";
import { resolveRoutineGate } from "../routines/gate.js";
import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";
import type { ModelRole } from "../memory/domain.js";
import { registerActionKind } from "./actions.js";
import { testRunOffer } from "../routines/test-run.js";
import { endFirstRoutineOffer } from "../onboarding/first-routine.js";
import type { ActionKind } from "./types.js";

export interface RoutineCreateArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly surfaceKey: string;
  readonly target: unknown;
  readonly trigger: RoutineTrigger;
  readonly report?: RoutineReport;
  readonly prompt: string;
  readonly watchFor?: string;
  readonly createdBy?: string;
  readonly tainted?: boolean;
  readonly sessionMode?: "job";
  readonly boundPolicy?: string;
  readonly permissions?: readonly string[];
  readonly collectors?: readonly string[];
  readonly gate?: string;
  readonly modelRole?: ModelRole;
  readonly quietWhenEmpty?: true;
  readonly firstRunNow?: true;
  readonly firstRoutineRoom?: true;
}

export function permissionLines(args: Pick<RoutineCreateArgs, "permissions" | "tainted">): string[] {
  const described = describeDeclaredPermissions(args.permissions ?? []);
  if (described.length === 0) return [];
  return [`🔑 may, without asking: ${described.join(" · ")} — anything else will ask you first`];
}

export function collectorLines(args: Pick<RoutineCreateArgs, "collectors">): string[] {
  const names = args.collectors ?? [];
  if (names.length === 0) return [];
  const described = names.map((n) => {
    const def = resolveRoutineCollector(n);
    return def ? `${n} (${def.describe})` : `${n} — no longer declared by this deployment, so it will collect nothing`;
  });
  return [`📥 reads BEFORE every run, under the permissions above: ${described.join(" · ")} — the result is handed to the run as data, never as instructions`];
}

export function gateLines(args: Pick<RoutineCreateArgs, "gate">): string[] {
  if (!args.gate) return [];
  const def = resolveRoutineGate(args.gate);
  return [
    def
      ? `⛔ runs ONLY when: ${def.describe} — checked host-side before any session starts, so a run that should not happen costs nothing`
      : `⛔ names the condition gate "${args.gate}", which this deployment no longer declares — it will therefore NEVER run until it is re-created`,
  ];
}

export function modelRoleLines(args: Pick<RoutineCreateArgs, "modelRole">): string[] {
  if (args.modelRole === undefined) return [];
  return [
    `🧠 this routine — and the work it delegates — runs the \`${args.modelRole}\` role of this deployment's model stack ` +
      "instead of the default `primary` one; a cheaper role can degrade its judgement, and nothing will report that it did",
  ];
}

export function watchLead(args: Pick<RoutineCreateArgs, "trigger" | "watchFor">): string {
  if (watchWords(args.trigger, args.watchFor) === undefined) return "";
  const condition = `watches for ${plainQuote(args.watchFor ?? "", 160)}`;
  if (args.trigger.kind !== "event") return `${condition}; each check follows `;
  const filter = args.trigger.jq !== undefined ? `only events where ${plainCode(args.trigger.jq, 600)}` : `EVERY event from ${sourceWords(args.trigger.source)}`;
  return `${condition}; it wakes on ${filter}, and then follows `;
}

function routineWhere(args: RoutineCreateArgs): string {
  return placeWords({ key: args.report?.kind === "surface" ? args.report.surfaceKey : args.surfaceKey });
}

const routineCreate: ActionKind<RoutineCreateArgs> = {
  kind: "routine.create",
  policy: "member",
  plainSummary(args) {
    const watch = watchWords(args.trigger, args.watchFor);
    if (watch !== undefined) return `Start a watch in ${routineWhere(args)} that ${watch}`;
    return `Start a ${args.sessionMode === "job" ? "job" : "routine"} in ${routineWhere(args)} that runs ${plainValue(triggerWords(args.trigger), 60)}`;
  },
  doneSummary: (args) => {
    const watch = watchWords(args.trigger, args.watchFor);
    if (watch !== undefined) return `started a watch in ${routineWhere(args)} that ${watch}`;
    return `started a ${args.sessionMode === "job" ? "job" : "routine"} in ${routineWhere(args)}, ${plainValue(triggerWords(args.trigger), 60)}`;
  },
  consequence(args) {
    const declared = args.permissions ?? [];
    const raised = new Set(bundleRaisedDeclarations(declared));
    const armable = declared.filter((d) => routinePermissionKind(d.trim()) !== null && !raised.has(d.trim()) && !namesUnliftableTool(d.trim()));
    const asks = declared.filter((d) => !armable.includes(d));
    const tail = [
      ...(armable.length > 0 ? [`may use ${armable.map(toolWords).join(", ")} without asking`] : []),
      ...(asks.length > 0 ? [`asks first before ${asks.map(toolWords).join(", ")}`] : []),
      ...(args.report?.kind === "silent" ? ["reports nothing here"] : []),
    ];
    const suffix = tail.length > 0 ? ` — ${tail.join("; ")}` : "";
    const lead = watchLead(args);
    return `${lead}${plainQuote(args.prompt, QUOTE_MAX - suffix.length - lead.length)}${suffix}`;
  },
  consequenceQuotes: true,
  summarize(args) {
    return [
      `Create ${args.sessionMode === "job" ? "durable JOB" : "routine"} — ${describeTrigger(args.trigger, args.report)} — fires WITHOUT a fresh @-mention`,
      ...(watchWords(args.trigger, args.watchFor) !== undefined ? [`👀 watches for: ${plainQuote(args.watchFor ?? "", 140)} (the trigger above and the instruction below decide each post)`] : []),
      ...(args.quietWhenEmpty === true && args.trigger.kind === "watch" ? ["🤫 posts nothing when a check finds nothing"] : []),
      ...(args.report?.kind === "silent" ? ["🔇 reports NOTHING here — you will only hear from it if it hits a problem it can't resolve, or if it self-disables"] : []),
      ...(args.report?.kind === "surface" ? [`📤 posts into ${placeWords({ key: args.report.surfaceKey })} — this surface can't post proactively, so its domain's configured reportChannel is where every run will land`] : []),
      ...(args.sessionMode === "job"
        ? ["↻ keeps going until it decides the work is DONE, building on what each earlier run learned — where an ordinary routine starts fresh each time and repeats forever. Arm a job only for work that can actually finish."]
        : []),
      ...(args.sessionMode === "job" && args.boundPolicy ? [`⏹️ ${args.boundPolicy} — it will say so here, and you can start it again`] : []),
      ...permissionLines(args),
      ...collectorLines(args),
      ...gateLines(args),
      ...modelRoleLines(args),
      `> ${args.prompt}`,
      `Target: ${placeWords({ key: args.surfaceKey })}`,
    ];
  },
  async execute(args, decidedBy) {
    const now = new Date();
    const next = args.firstRunNow === true ? now : args.trigger.kind === "once" ? new Date(args.trigger.at) : computeNextRun(args.trigger, now);
    const routine: Routine = {
      id: newRoutineId(),
      org: args.org,
      surfaceKey: args.surfaceKey,
      target: args.target as Routine["target"],
      trigger: args.trigger,
      ...(args.report ? { report: args.report } : {}),
      prompt: args.prompt,
      ...(args.watchFor ? { watchFor: args.watchFor } : {}),
      ...(args.quietWhenEmpty === true && args.trigger.kind === "watch" ? { quietWhenEmpty: true as const } : {}),
      createdBy: args.createdBy,
      createdAt: now.toISOString(),
      status: "active",
      nextRunAt: next ? next.toISOString() : null,
      consecutiveFailures: 0,
      ...(args.sessionMode === "job" ? { sessionMode: "job" as const } : {}),
      ...(args.sessionMode === "job" ? { bound: mintJobBound(args.trigger, now), fireCount: 0 } : {}),
      ...(args.collectors && args.collectors.length > 0 ? { collectors: [...args.collectors] } : {}),
      ...(args.gate ? { gate: args.gate } : {}),
      ...(args.modelRole === undefined ? {} : { modelRole: args.modelRole }),
    };
    await addRoutine(args.partition, routine);
    const armed = await armDeclaredRoutinePermissions({
      org: args.org,
      routine,
      declared: args.permissions ?? [],
      grantedBy: decidedBy,
      nowIso: now.toISOString(),
    });
    if (armed.length > 0) {
      await appendAudit({
        org: args.partition.org,
        platform: args.partition.platform,
        workspace: args.partition.workspace,
        surface: args.partition.surface,
        principalId: decidedBy,
        action: ROUTINE_PERMISSIONS_ARMED_ACTION,
        detail: { id: routine.id, grantedBy: decidedBy, kinds: armed, generation: routinePermissionGeneration(routine), declared: true },
      });
    }
    for (const declaration of bundleRaisedDeclarations(args.permissions ?? [])) {
      await appendAudit({
        org: args.partition.org,
        platform: args.partition.platform,
        workspace: args.partition.workspace,
        surface: args.partition.surface,
        principalId: decidedBy,
        action: ROUTINE_PERMISSION_NEVER_LIFTS_ACTION,
        detail: { id: routine.id, declaration, generation: routinePermissionGeneration(routine), reason: "bundle-declared-destructive" },
      });
    }
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.create",
      detail: { id: routine.id, trigger: describeTrigger(args.trigger, args.report), nextRunAt: routine.nextRunAt, armedBy: decidedBy, ...(args.sessionMode === "job" ? { sessionMode: "job" } : {}), ...(args.report ? { report: args.report.kind } : {}), ...(args.watchFor ? { watch: true } : {}) },
    });
    await endFirstRoutineOffer({ partition: args.partition, decidedBy, outcome: "set-up", room: args.firstRoutineRoom === true, atIso: now.toISOString() });
    const unarmed = unarmedDeclarations(args.permissions ?? [], armed);
    return (
      `${watchWords(args.trigger, args.watchFor) !== undefined ? `watch started, it ${watchWords(args.trigger, args.watchFor)}` : `routine started, runs ${triggerWords(args.trigger)}`}${routine.nextRunAt ? `, first on ${shortUtc(routine.nextRunAt)}` : ""}` +
      `${armed.length > 0 ? `; may use ${armed.map(toolWords).join(", ")} without asking` : ""}` +
      `${unarmed.length > 0 ? `; it will ask before ${unarmed.map(toolWords).join(", ")}` : ""}` +
      testRunOffer(routine)
    );
  },
  async declined(args, decidedBy) {
    const ended = await endFirstRoutineOffer({ partition: args.partition, decidedBy, outcome: "declined", room: args.firstRoutineRoom === true });
    return ended.person || ended.room ? "rejected; I won't suggest a routine again" : "rejected";
  },
};

registerActionKind(routineCreate);
