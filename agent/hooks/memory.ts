import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { ensurePartition, readPartition, writePartition, storeRoot } from "../memory/store.js";
import { syncIntoSandbox, readFromSandbox } from "../memory/sandbox-sync.js";

const sessionLog = defineState<{ firstMessage?: string }>(
  "open-everywhere.memory.sessionLog",
  () => ({}),
);

function log(msg: string): void {
  console.log(`[open-everywhere:memory] ${msg}`);
}

async function persistOnEnd(ctx: HookContext, outcome: "completed" | "failed"): Promise<void> {
  const p = resolvePartition(ctx);
  const sessionId = ctx.session.id;
  const when = new Date().toISOString();
  const firstMessage = sessionLog.get().firstMessage?.trim();

  let files = await readPartition(p);
  try {
    const sandbox = await ctx.getSandbox();
    const fromSandbox = await readFromSandbox(sandbox);
    if (Object.keys(fromSandbox).length > 0) files = fromSandbox;
  } catch {
    log(`sandbox unavailable at session.${outcome}; persisting host-store state only`);
  }

  const summary =
    `# Session ${sessionId}\n\n` +
    `- when: ${when}\n` +
    `- outcome: ${outcome}\n` +
    `- request: ${firstMessage ? firstMessage.replace(/\n+/g, " ").slice(0, 500) : "(not captured)"}\n`;
  files[`sessions/${sessionId}.md`] = summary;

  const sha = await writePartition(p, files, `session ${sessionId} (${outcome})`);
  log(
    `persisted ${Object.keys(files).length} file(s) for ${p.key} -> ${storeRoot()}` +
      (sha ? ` @ ${sha}` : " (no git history)"),
  );
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const p = resolvePartition(ctx);
        const files = await ensurePartition(p);
        const sandbox = await ctx.getSandbox();
        await syncIntoSandbox(sandbox, files);
        log(`synced ${Object.keys(files).length} file(s) for ${p.key} into /workspace/memory`);
      } catch (err) {
        log(`session.started sync skipped: ${String(err)}`);
      }
    },

    "message.received": (event, _ctx) => {
      const current = sessionLog.get();
      if (!current.firstMessage && typeof event.data?.message === "string") {
        sessionLog.update((s) => ({ ...s, firstMessage: event.data.message }));
      }
    },

    "session.completed": async (_event, ctx) => {
      await persistOnEnd(ctx, "completed");
    },

    "session.failed": async (_event, ctx) => {
      await persistOnEnd(ctx, "failed");
    },
  },
});
