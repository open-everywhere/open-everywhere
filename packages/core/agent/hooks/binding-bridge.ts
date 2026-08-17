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

async function refreshHealAndGuard(ctx: BindableContext, phase: "session.started" | "turn.started"): Promise<void> {
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
  console.warn(`[open-everywhere:binding-bridge] ${failure.message}`);
  await auditRefusal(ctx, phase);
  throw failure;
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => refreshHealAndGuard(ctx as BindableContext, "session.started"),
    "turn.started": async (_event, ctx) => refreshHealAndGuard(ctx as BindableContext, "turn.started"),
  },
});
