import { appendAudit, type AuditInput } from "../audit/audit.js";
import { auditSurfaceModeStamp, bindFrom, type BindableContext } from "../identity/binding.js";

export const HOOK_CANCELLABLE_EDGES = ["session.started", "turn.started", "step.started"] as const;

export type HookCancellableEdge = (typeof HOOK_CANCELLABLE_EDGES)[number];

export type RefusableContext = BindableContext & { readonly cancel: () => void };

export interface HookRefusalInput {
  readonly hook: string;
  readonly phase: HookCancellableEdge;
  readonly reason: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface HookRefusalDeps {
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface HookRefusalOutcome {
  readonly cancelCalled: boolean;
  readonly audited: boolean;
}

export async function refuseTurn(
  ctx: RefusableContext,
  input: HookRefusalInput,
  deps: HookRefusalDeps = {},
): Promise<HookRefusalOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(`[open-everywhere:${input.hook}] ${message}`));
  const audit = deps.audit ?? appendAudit;

  let cancelCalled = false;
  try {
    ctx.cancel();
    cancelCalled = true;
  } catch (err) {
    log(`ctx.cancel() FAILED, so this turn may still be running: ${String(err)}`);
  }

  log(`turn CANCEL REQUESTED at ${input.phase} (${input.reason}): ${input.message}`);
  if (!cancelCalled) {
    log(
      `the cancel call did not even run, so this hook has NOT made the guarded act impossible — read ` +
        `HOOK_CANCELLABLE_EDGES in hooks/control-refusal.ts before adding an edge`,
    );
  }

  let audited = false;
  try {
    const b = bindFrom(ctx);
    await audit({
      org: b.org,
      platform: b.platform,
      workspace: b.workspace,
      surface: b.surface,
      ...auditSurfaceModeStamp(b),
      action: "hook.refused",
      detail: {
        ...(input.detail ?? {}),
        hook: input.hook,
        phase: input.phase,
        reason: input.reason,
        cancelCalled,
      },
    });
    audited = true;
  } catch (err) {
    log(`hook.refused row skipped (the refusal itself stands): ${String(err)}`);
  }

  return { cancelCalled, audited };
}
