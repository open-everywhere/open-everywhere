import { defineHook } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import {
  bindFrom,
  healDeliveryIdentity,
  refreshBindingStamp,
  subagentBindingLost,
  subagentParentSessionId,
  type BindableContext,
} from "../identity/binding.js";
import { DelegatedTaskBindingUnavailableError, ensureDelegatedTaskBinding } from "../channels/task-wake.js";
import { refuseTurn, type RefusableContext } from "./control-refusal.js";

function lostBindingError(ctx: BindableContext): Error {
  const b = bindFrom(ctx);
  return new Error(
    `subagent child binding LOST: this child resolved its parent's platform (${b.platform}) but no workspace and no ` +
      `surface, so it would run on the env stand-in partition \`${b.platform}/${b.workspace}/${b.surface}\` — the ` +
      "org default, with no connector grants, the wrong memory partition and spend filed off-surface. A native child " +
      "inherits its parent's identity through the auth attribute bag alone (identity/binding.ts healDeliveryIdentity), " +
      "so an empty bag here means the dispatching turn carried no platform identity and the heal did not land. " +
      "Failing the child rather than running it on the wrong partition.",
  );
}

async function auditRefusal(ctx: BindableContext, phase: "session.started" | "turn.started"): Promise<void> {
  const b = bindFrom(ctx);
  await appendAudit({
    org: b.org,
    platform: b.platform,
    workspace: b.workspace,
    surface: b.surface,
    action: "binding.refused",
    detail: {
      phase,
      reason: "subagent-binding-lost",
      scopeKey: `${b.platform}/${b.workspace}/${b.surface}`,
      parentSessionId: subagentParentSessionId(ctx) ?? null,
      aborted: true,
    },
  }).catch(() => undefined);
}

async function guardBody(ctx: RefusableContext, phase: "session.started" | "turn.started"): Promise<void> {
  try {
    await ensureDelegatedTaskBinding(ctx);
  } catch (err) {
    await refuseTurn(ctx, {
      hook: "binding-bridge",
      phase,
      reason: err instanceof DelegatedTaskBindingUnavailableError ? "delegated-binding-unavailable" : "binding-restore-failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  refreshBindingStamp(ctx);
  const healed = healDeliveryIdentity(ctx);
  if (healed === "unwritable") {
    console.warn(
      "[open-everywhere:binding-bridge] delivery heal FAILED — this session established a surface but the " +
        "delivery's auth attributes could not take it, so a native subagent child cannot inherit the binding " +
        "and will be refused. Check whether eve now freezes or clones the auth attribute bag.",
    );
  }
  if (!subagentBindingLost(ctx)) return;
  const failure = lostBindingError(ctx);
  const b = bindFrom(ctx);
  await refuseTurn(ctx, {
    hook: "binding-bridge",
    phase,
    reason: "subagent-binding-lost",
    message: failure.message,
    detail: { scopeKey: `${b.platform}/${b.workspace}/${b.surface}` },
  });
  await auditRefusal(ctx, phase);
}

async function refreshHealAndGuard(ctx: RefusableContext, phase: "session.started" | "turn.started"): Promise<void> {
  try {
    await guardBody(ctx, phase);
  } catch (err) {
    await refuseTurn(ctx, {
      hook: "binding-bridge",
      phase,
      reason: "binding-guard-failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => refreshHealAndGuard(ctx as RefusableContext, "session.started"),
    "turn.started": async (_event, ctx) => refreshHealAndGuard(ctx as RefusableContext, "turn.started"),
  },
});
