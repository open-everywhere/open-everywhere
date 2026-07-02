import { defineHook, type HookContext } from "eve/hooks";
import { Sandbox } from "@vercel/sandbox";

function log(msg: string): void {
  console.log(`[open-everywhere:sandbox-lifecycle] ${msg}`);
}

export function stopAfterTurnEnabled(): boolean {
  return process.env.OE_SANDBOX_STOP_AFTER_TURN !== "0";
}

export function shouldStop(status: string): boolean {
  return status === "running" || status === "pending";
}

export interface SandboxLifecycleDeps {
  list(sessionId: string): Promise<Array<{ name: string; status: string }>>;
  stop(name: string): Promise<void>;
}

const sdkDeps: SandboxLifecycleDeps = {
  async list(sessionId) {
    const result = await Sandbox.list({ tags: { sessionId } });
    const out: Array<{ name: string; status: string }> = [];
    for await (const s of result) out.push({ name: s.name, status: s.status });
    return out;
  },
  async stop(name) {
    await (await Sandbox.get({ name })).stop();
  },
};

export async function stopSessionSandboxes(
  sessionId: string,
  deps: SandboxLifecycleDeps = sdkDeps,
): Promise<string[]> {
  const stopped: string[] = [];
  const sandboxes = await deps.list(sessionId);
  for (const s of sandboxes) {
    if (!shouldStop(s.status)) continue;
    try {
      await deps.stop(s.name);
      stopped.push(s.name);
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
      log(`turn.${outcome}: stopped ${stopped.join(", ")} (auto-snapshot; next turn auto-resumes)`);
    }
  } catch (err) {
    log(`turn.${outcome}: sandbox stop skipped: ${String(err)}`);
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
