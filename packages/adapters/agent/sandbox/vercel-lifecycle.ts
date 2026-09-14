import { defineHook, type HookContext } from "eve/hooks";
import { bindFrom, domainKeyOf, resolvePartition, appendUsageEvent, usageForSession, recordSpend, periodOf, estimateSandboxCostUsd, routineIdOf, turnSurfaceMode, getSettings, isSubagentChildContext, liveTaskIds, subagentParentSessionId, type BindableContext } from "@open-everywhere/core/agent/adapter-api.js";
import { resolveSandboxStopper, shouldStop, type SandboxListing, type SandboxStopper } from "./backend-stop.js";

export { shouldStop, type SandboxListing, type SandboxStopper };

function log(msg: string): void {
  console.log(`[open-everywhere:sandbox-lifecycle] ${msg}`);
}

export function stopAfterTurnEnabled(): boolean {
  return getSettings().sandbox.stopAfterTurn;
}

export interface StoppedSandbox {
  readonly name: string;
  readonly sandboxSeconds: number;
}

export async function stopSessionSandboxes(
  sessionId: string,
  stopper: SandboxStopper = resolveSandboxStopper(),
  now: () => number = Date.now,
): Promise<StoppedSandbox[]> {
  const stopped: StoppedSandbox[] = [];
  const sandboxes = await stopper.list(sessionId);
  for (const s of sandboxes) {
    if (!shouldStop(s.status)) continue;
    try {
      await stopper.stop(s.name);
      const sandboxSeconds = Math.max(0, (now() - s.createdAt) / 1000);
      stopped.push({ name: s.name, sandboxSeconds });
    } catch (err) {
      log(`stop of "${s.name}" failed (falls back to the timeout fuse): ${String(err)}`);
    }
  }
  return stopped;
}

export async function restoreParentSandboxTag(ctx: HookContext, stopper: SandboxStopper): Promise<string[]> {
  const parentSessionId = subagentParentSessionId(ctx as unknown as BindableContext);
  if (parentSessionId === undefined) return [];
  const restored: string[] = [];
  for (const s of await stopper.list(ctx.session.id)) {
    try {
      if (await stopper.retag(s.name, parentSessionId)) restored.push(s.name);
    } catch (err) {
      log(`re-tag of "${s.name}" back to parent session failed (the parent reclaims it on its next sandbox use): ${String(err)}`);
    }
  }
  return restored;
}

let ownershipLogged = false;
function logStopOwnershipOnce(stopper: SandboxStopper): void {
  if (ownershipLogged) return;
  ownershipLogged = true;
  log(stopper.ownership);
}

export function resetStopOwnershipLogForTest(): void {
  ownershipLogged = false;
}

export function liveDelegatedTasksHoldingSandbox(): readonly string[] {
  try {
    return liveTaskIds();
  } catch {
    return [];
  }
}

async function onTurnEnd(ctx: HookContext, outcome: string): Promise<void> {
  if (!stopAfterTurnEnabled()) return;
  try {
    const stopper = resolveSandboxStopper();
    logStopOwnershipOnce(stopper);
    if (isSubagentChildContext(ctx as unknown as BindableContext)) {
      const restored = await restoreParentSandboxTag(ctx, stopper);
      log(
        `turn.${outcome}: SKIPPED the stop — this is an eve subagent child and the parent owns the shared sandbox` +
          (restored.length > 0 ? `; handed ${restored.join(", ")} back to the parent session` : ""),
      );
      return;
    }
    const holding = liveDelegatedTasksHoldingSandbox();
    if (holding.length > 0) {
      log(
        `turn.${outcome}: SKIPPED the stop — ${holding.length} delegated background task(s) still hold this session's sandbox ` +
          `[${holding.join(", ")}]; the next turn end that finds none sweeps it`,
      );
      return;
    }
    const stopped = await stopSessionSandboxes(ctx.session.id, stopper);
    if (stopped.length > 0) {
      log(`turn.${outcome}: stopped ${stopped.map((s) => s.name).join(", ")} (auto-snapshot; next turn auto-resumes)`);
      if (stopper.metered) await recordSandboxUsage(ctx, stopped);
    }
  } catch (err) {
    log(`turn.${outcome}: sandbox stop skipped: ${String(err)}`);
  }
}

export async function recordSandboxUsage(ctx: HookContext, stopped: StoppedSandbox[]): Promise<void> {
  try {
    const p = resolvePartition(ctx);
    const principalId = bindFrom(ctx).principalId;
    const routineId = routineIdOf(ctx);
    const surfaceMode = turnSurfaceMode(ctx);
    const priorBilled = new Map<string, number>();
    try {
      for (const e of await usageForSession(p.org, ctx.session.id)) {
        if (e.kind !== "sandbox") continue;
        const name = e.detail?.sandboxName;
        if (typeof name !== "string") continue;
        const secs = typeof e.detail?.sandboxSeconds === "number" ? e.detail.sandboxSeconds : 0;
        priorBilled.set(name, (priorBilled.get(name) ?? 0) + secs);
      }
    } catch (err) {
      log(`prior sandbox usage read skipped (billing the full window): ${String(err)}`);
    }
    const seenNames = new Set<string>();
    const dedupedStopped = stopped.filter((s) => {
      if (seenNames.has(s.name)) return false;
      seenNames.add(s.name);
      return true;
    });
    for (const s of dedupedStopped) {
      const billedSeconds = Math.max(0, Math.round(s.sandboxSeconds) - (priorBilled.get(s.name) ?? 0));
      try {
        await recordSpend(p, {
          period: periodOf(new Date().toISOString()),
          usage: {},
          principalId,
          routineId,
          model: "",
          ...(surfaceMode !== undefined ? { surfaceMode } : {}),
          usdMicros: Math.round(estimateSandboxCostUsd(billedSeconds) * 1_000_000),
        });
      } catch (err) {
        log(`sandbox spend-ledger record skipped for "${s.name}" (watermark NOT advanced — this window re-bills next stop): ${String(err)}`);
        continue;
      }
      try {
        await appendUsageEvent({
          org: p.org,
          surfaceKey: domainKeyOf(p),
          sessionId: ctx.session.id,
          kind: "sandbox",
          ...(surfaceMode !== undefined ? { surfaceMode } : {}),
          principalId,
          ...(routineId !== undefined ? { routineId } : {}),
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          detail: { sandboxSeconds: billedSeconds, sandboxName: s.name },
        });
      } catch (err) {
        log(`sandbox usage-event append skipped for "${s.name}" (watermark not advanced; a future stop may re-bill this window): ${String(err)}`);
      }
    }
  } catch (err) {
    log(`sandbox usage records skipped (no resolvable partition): ${String(err)}`);
  }
}

export default defineHook({
  events: {
    "turn.completed": async (_event, ctx) => onTurnEnd(ctx, "completed"),
    "turn.failed": async (_event, ctx) => onTurnEnd(ctx, "failed"),
    "session.completed": async (_event, ctx) => onTurnEnd(ctx, "session-completed"),
    "session.failed": async (_event, ctx) => onTurnEnd(ctx, "session-failed"),
  },
});
