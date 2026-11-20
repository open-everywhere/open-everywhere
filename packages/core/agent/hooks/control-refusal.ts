import { appendAudit, type AuditInput } from "../audit/audit.js";
import { auditSurfaceModeStamp, bindFrom, type BindableContext } from "../identity/binding.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const HOOK_CANCELLABLE_EDGES = ["session.started", "turn.started", "model.requested"] as const;

export type HookCancellableEdge = (typeof HOOK_CANCELLABLE_EDGES)[number];

export type RefusableContext = BindableContext & { readonly cancel: () => void };

export interface HookRefusalInput {
  readonly hook: string;
  readonly phase: HookCancellableEdge;
  readonly reason: string;
  readonly message: string;
  readonly detail?: AuditDetail;
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

export type OptionalHookLog = (message: string) => void;

const OPTIONAL_HOOK_FAULT = Symbol.for("open-everywhere.optional-hook-fault");

export type OptionalHookFault = "caught" | "escaped";

export function _faultOptionalHookForTest(hook: string | undefined, mode: OptionalHookFault = "caught"): void {
  const bag = globalThis as Record<symbol, unknown>;
  if (hook === undefined) delete bag[OPTIONAL_HOOK_FAULT];
  else bag[OPTIONAL_HOOK_FAULT] = { hook, mode };
}

const OPTIONAL_HOOK_FAULTS_THROWN = Symbol.for("open-everywhere.optional-hook-faults-thrown");

function faultCounts(): Record<string, number> {
  const bag = globalThis as Record<symbol, unknown>;
  const counts = bag[OPTIONAL_HOOK_FAULTS_THROWN];
  if (counts !== null && typeof counts === "object") return counts as Record<string, number>;
  const fresh: Record<string, number> = {};
  bag[OPTIONAL_HOOK_FAULTS_THROWN] = fresh;
  return fresh;
}

export function _optionalHookFaultsThrownForTest(eventType?: string): number {
  const counts = faultCounts();
  if (eventType !== undefined) return counts[eventType] ?? 0;
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function countFault(event: unknown): void {
  const type = (event as { readonly type?: unknown } | null | undefined)?.type;
  const key = typeof type === "string" ? type : "unknown";
  const counts = faultCounts();
  counts[key] = (counts[key] ?? 0) + 1;
}

function injectedFault(hook: string): OptionalHookFault | undefined {
  const fault = (globalThis as Record<symbol, unknown>)[OPTIONAL_HOOK_FAULT] as { readonly hook?: unknown; readonly mode?: OptionalHookFault } | undefined;
  return fault?.hook === hook ? fault.mode : undefined;
}

export function optional<E, C>(hook: string, handler: (event: E, ctx: C) => unknown, log?: OptionalHookLog): (event: E, ctx: C) => Promise<void> {
  const warn = log ?? ((message: string) => console.warn(`[open-everywhere:${hook}] ${message}`));
  return async (event, ctx) => {
    const fault = injectedFault(hook);
    if (fault !== undefined) countFault(event);
    // hook-throw: DEFECT — a test-only fault that escapes on purpose, so a test can show eve failing the turn
    if (fault === "escaped") throw new Error(`fault injected past the optional "${hook}" wrapper`);
    try {
      // hook-throw: INTERNAL(optional) — the injected fault is caught by this same try
      if (fault === "caught") throw new Error(`fault injected into the optional "${hook}" hook`);
      await handler(event, ctx);
    } catch (err) {
      try {
        warn(`optional hook work failed, and the turn continues: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
      }
    }
  };
}
