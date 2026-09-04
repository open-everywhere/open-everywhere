import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import { getRoutine } from "../routines/store.js";
import { ROUTINE_PERMISSION_NO_EXPIRY } from "../routines/declared-permissions.js";
import { routinePermissionGeneration, routinePermissionKey } from "../routines/routine.js";
import { routineCardWaitSeconds } from "../routines/permission-card-wait.js";
import { routinePermissionDeclinedMemo } from "./session-grant.js";
import type { ActionKind } from "./types.js";

export const ROUTINE_PERMISSION_KIND = "routine.permission";

export interface RoutinePermissionArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly grantKey: string;
  readonly routineId: string;
  readonly routineSurfaceKey: string;
  readonly grantKind: string;
  readonly declaration: string;
  readonly prompt: string;
}

const CARD_PROMPT_CHARS = 600;

function clip(s: string): string {
  const t = s.trim();
  return t.length > CARD_PROMPT_CHARS ? `${t.slice(0, CARD_PROMPT_CHARS)}…` : t;
}

export function routinePermissionCardLines(args: RoutinePermissionArgs): string[] {
  const waitArmed = routineCardWaitSeconds() > 0;
  return [
    `Let routine ${args.routineId} use \`${args.declaration}\` on its own, from now on?`,
    waitArmed
      ? "It asked for this while running unattended, and was refused. This decides FUTURE runs — and any run still waiting on this card when you answer."
      : "It asked for this while running unattended, so the run was refused and has already finished. This decides FUTURE runs.",
    "🔑 approving writes the same standing permission the routine's creation card would have declared — it is revoked the moment the routine's instruction is edited, and `revoke_routine_permissions` withdraws it at any time.",
    "⛔ declining is remembered: this routine stops asking for this permission until its instruction is edited.",
    `Routine says:\n> ${clip(args.prompt)}`,
    `Target: ${args.routineSurfaceKey}`,
  ];
}

async function recheckedRoutine(args: RoutinePermissionArgs): Promise<{ ok: true } | { ok: false; why: string }> {
  const state = await routineCardGenerationState(args);
  switch (state.state) {
    case "current":
      return { ok: true };
    case "gone":
      return { ok: false, why: `routine ${args.routineId} no longer exists` };
    case "superseded":
      return {
        ok: false,
        why:
          `routine ${args.routineId} has been edited since this card was posted ` +
          `(it is now on generation ${state.generation}), so its new instruction has to ask again`,
      };
    default:
      return { ok: false, why: `routine ${args.routineId} could not be read` };
  }
}

export type RoutineCardGenerationState =
  | { readonly state: "current" }
  | { readonly state: "superseded"; readonly generation: number }
  | { readonly state: "gone" }
  | { readonly state: "unreadable" };

export async function routineCardGenerationState(args: RoutinePermissionArgs): Promise<RoutineCardGenerationState> {
  let routine: Awaited<ReturnType<typeof getRoutine>>;
  try {
    routine = await getRoutine(args.org, args.routineSurfaceKey, args.routineId);
  } catch {
    return { state: "unreadable" };
  }
  if (!routine) return { state: "gone" };
  if (routinePermissionKey(routine) !== args.grantKey) return { state: "superseded", generation: routinePermissionGeneration(routine) };
  return { state: "current" };
}

export function parseRoutinePermissionArgs(argsJson: string): RoutinePermissionArgs | undefined {
  try {
    const parsed = JSON.parse(argsJson) as Partial<RoutinePermissionArgs> | null;
    if (!parsed || typeof parsed.org !== "string" || typeof parsed.routineId !== "string") return undefined;
    if (typeof parsed.routineSurfaceKey !== "string" || typeof parsed.grantKey !== "string") return undefined;
    return parsed as RoutinePermissionArgs;
  } catch {
    return undefined;
  }
}

const routinePermission: ActionKind<RoutinePermissionArgs> = {
  kind: ROUTINE_PERMISSION_KIND,
  policy: "member",
  summarize(args) {
    return routinePermissionCardLines(args);
  },
  async execute(args, decidedBy) {
    const recheck = await recheckedRoutine(args);
    if (!recheck.ok) {
      throw new Error(`nothing was armed — ${recheck.why}`);
    }
    const now = new Date();
    await getOperationalStore().setSessionApproval({
      org: args.org,
      sessionId: args.grantKey,
      kind: args.grantKind,
      grantedBy: decidedBy,
      createdAt: now.toISOString(),
      expiresAt: ROUTINE_PERMISSION_NO_EXPIRY,
    });
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "routine.permission_granted",
      detail: { routine: args.routineId, grant: args.grantKind, declaration: args.declaration, key: args.grantKey },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "routine_permission_card", "oe.outcome": "granted" });
    return routineCardWaitSeconds() > 0
      ? `routine ${args.routineId} may now use \`${args.declaration}\` on its own — from now on, including any run still waiting on this card, until its instruction is edited`
      : `routine ${args.routineId} may now use \`${args.declaration}\` on its own — from its next run, until its instruction is edited`;
  },
  async declined(args, decidedBy) {
    const recheck = await recheckedRoutine(args);
    if (!recheck.ok) {
      await appendAudit({
        ...whereFromScope(args.org, args.scopeKey),
        principalId: decidedBy,
        action: "routine.permission_declined_stale",
        detail: { routine: args.routineId, grant: args.grantKind, declaration: args.declaration, key: args.grantKey },
      }).catch(() => undefined);
      return `nothing was remembered — ${recheck.why}`;
    }
    const now = new Date();
    await getOperationalStore()
      .setSessionApproval({
        org: args.org,
        sessionId: args.grantKey,
        kind: routinePermissionDeclinedMemo(args.grantKind),
        grantedBy: decidedBy,
        createdAt: now.toISOString(),
        expiresAt: ROUTINE_PERMISSION_NO_EXPIRY,
      })
      .catch(() => undefined);
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "routine.permission_declined",
      detail: { routine: args.routineId, grant: args.grantKind, declaration: args.declaration, key: args.grantKey },
    }).catch(() => undefined);
    emitTelemetry("oe.feature.used", { "oe.feature": "routine_permission_card", "oe.outcome": "declined" });
    return `routine ${args.routineId} will not ask for \`${args.declaration}\` again until its instruction is edited`;
  },
};

registerActionKind(routinePermission);
