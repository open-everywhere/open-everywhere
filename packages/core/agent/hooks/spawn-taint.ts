import { defineHook, type HookContext } from "eve/hooks";
import { OE_SPAWN_TAINTED_ATTR } from "../channels/unified.js";
import { beginTaintTurn, markUntrustedIngestedThisTurn, OE_TAINTED_FIRE_ATTR, OE_RESULT_TAINTED_ATTR } from "../access/taint-signal.js";
import { JOB_TAINT_ATTR } from "../access/job-posture.js";
import { registerTaintDryRunSink, type TaintDryRunRow } from "../access/taint-dryrun.js";
import { appendAudit } from "../audit/audit.js";
import { currentTurnId, deploymentOrg, type BindableContext } from "../identity/binding.js";

export const TAINT_DRYRUN_ACTION = "taint.dryrun";

registerTaintDryRunSink((row: TaintDryRunRow) => {
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: row.kind,
    action: TAINT_DRYRUN_ACTION,
    detail: { ...row },
  }).catch(() => undefined);
});

export const TAINT_SEED_ATTRS: readonly string[] = [OE_SPAWN_TAINTED_ATTR, OE_TAINTED_FIRE_ATTR, OE_RESULT_TAINTED_ATTR, JOB_TAINT_ATTR];

function currentAttrs(ctx: HookContext): Record<string, unknown> | undefined {
  return (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
}

function stampedTrue(v: unknown): boolean {
  const first = Array.isArray(v) ? v[0] : v;
  return first === "true" || first === true;
}

export function seedIfTainted(ctx: HookContext): void {
  try {
    const attrs = currentAttrs(ctx);
    for (const name of TAINT_SEED_ATTRS) {
      if (stampedTrue(attrs?.[name])) {
        markUntrustedIngestedThisTurn();
        return;
      }
    }
  } catch {
  }
}

export function openTaintTurn(ctx: HookContext): void {
  let turnId: string | undefined;
  try {
    turnId = currentTurnId(ctx as unknown as BindableContext);
  } catch {
    turnId = undefined;
  }
  beginTaintTurn(turnId);
  seedIfTainted(ctx);
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => openTaintTurn(ctx),
  },
});
