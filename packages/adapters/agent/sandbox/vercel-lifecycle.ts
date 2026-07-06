import { defineHook, type HookContext } from "eve/hooks";
import { Sandbox } from "@vercel/sandbox";
import { domainKeyOf, resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { appendUsageEvent } from "@open-everywhere/core/agent/spend/usage-events.js";

function log(msg: string): void {
  console.log(`[open-everywhere:sandbox-lifecycle] ${msg}`);
}

export function stopAfterTurnEnabled(): boolean {
  return process.env.OE_SANDBOX_STOP_AFTER_TURN !== "0";
}

export function shouldStop(status: string): boolean {
  return status === "running" || status === "pending";
}

export interface SandboxListing {
  readonly name: string;
  readonly status: string;
  readonly createdAt: number;
}

export interface SandboxLifecycleDeps {
  list(sessionId: string): Promise<SandboxListing[]>;
  stop(name: string): Promise<void>;
}

const sdkDeps: SandboxLifecycleDeps = {
  async list(sessionId) {
    const result = await Sandbox.list({ tags: { sessionId } });
    const out: SandboxListing[] = [];
    for await (const s of result) out.push({ name: s.name, status: s.status, createdAt: s.createdAt });
    return out;
  },
  async stop(name) {
    await (await Sandbox.get({ name })).stop();
  },
};

export interface StoppedSandbox {
  readonly name: string;
  readonly sandboxSeconds: number;
}

export async function stopSessionSandboxes(
  sessionId: string,
  deps: SandboxLifecycleDeps = sdkDeps,
  now: () => number = Date.now,
): Promise<StoppedSandbox[]> {
  const stopped: StoppedSandbox[] = [];
  const sandboxes = await deps.list(sessionId);
  for (const s of sandboxes) {
    if (!shouldStop(s.status)) continue;
    try {
      await deps.stop(s.name);
      const sandboxSeconds = Math.max(0, (now() - s.createdAt) / 1000);
      stopped.push({ name: s.name, sandboxSeconds });
    } catch (err) {
      log(`stop of "${s.name}" failed (falls back to the timeout fuse): ${String(err)}`);
    }
  }
  return stopped;
}

async function onTurnEnd(ctx: HookContext, outcome: string): Promise<void> {
  if (!stopAfterTurnEnabled()) return;
  try {
    const stopped = await stopSessionSandboxes(ctx.session.id);
    if (stopped.length > 0) {
      log(`turn.${outcome}: stopped ${stopped.map((s) => s.name).join(", ")} (auto-snapshot; next turn auto-resumes)`);
      await recordSandboxUsage(ctx, stopped);
    }
  } catch (err) {
    log(`turn.${outcome}: sandbox stop skipped: ${String(err)}`);
  }
}

async function recordSandboxUsage(ctx: HookContext, stopped: StoppedSandbox[]): Promise<void> {
  try {
    const p = resolvePartition(ctx);
    for (const s of stopped) {
      await appendUsageEvent({
        org: p.org,
        surfaceKey: domainKeyOf(p),
        sessionId: ctx.session.id,
        kind: "sandbox",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        detail: { sandboxSeconds: Math.round(s.sandboxSeconds), sandboxName: s.name },
      });
    }
  } catch (err) {
    log(`sandbox usage-event skipped (no resolvable partition): ${String(err)}`);
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
