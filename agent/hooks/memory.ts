import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { resolveMode } from "../access/request.js";
import type { SessionMode } from "../access/resolver.js";
import { ensureTier, readTier, writeTier, storeRoot, ALL_TIERS, type Tier } from "../memory/store.js";
import { syncTierIntoSandbox, readTierFromSandbox } from "../memory/sandbox-sync.js";

const sessionLog = defineState<{ firstMessage?: string }>(
  "open-everywhere.memory.sessionLog",
  () => ({}),
);

function log(msg: string): void {
  console.log(`[open-everywhere:memory] ${msg}`);
}

function tiersForMode(mode: SessionMode): readonly Tier[] {
  if (mode === "mpim") return [];
  if (mode === "dm") return ["surface"];
  return ALL_TIERS;
}

async function persistOnEnd(ctx: HookContext, outcome: "completed" | "failed"): Promise<void> {
  const mode = resolveMode(ctx);
  const tiers = tiersForMode(mode);
  if (tiers.length === 0) {
    log(`${mode} is execution-only — skipping memory persistence on session.${outcome}`);
    return;
  }
  const p = resolvePartition(ctx);
  const sessionId = ctx.session.id;
  const when = new Date().toISOString();
  const firstMessage = sessionLog.get().firstMessage?.trim();

  let sandbox: Awaited<ReturnType<HookContext["getSandbox"]>> | null = null;
  try {
    sandbox = await ctx.getSandbox();
  } catch {
    log(`sandbox unavailable at session.${outcome}; persisting host-store state only`);
  }

  let persisted = 0;
  for (const tier of tiers) {
    let files = await readTier(p, tier);
    if (sandbox) {
      const fromSandbox = await readTierFromSandbox(sandbox, tier);
      if (Object.keys(fromSandbox).length > 0) files = fromSandbox;
    }
    if (tier === "surface") {
      files[`sessions/${sessionId}.md`] =
        `# Session ${sessionId}\n\n` +
        `- when: ${when}\n` +
        `- outcome: ${outcome}\n` +
        `- request: ${firstMessage ? firstMessage.replace(/\n+/g, " ").slice(0, 500) : "(not captured)"}\n`;
    }
    const sha = await writeTier(p, tier, files, `session ${sessionId} (${outcome}) [${tier}]`);
    persisted += Object.keys(files).length;
    log(`persisted ${tier}: ${Object.keys(files).length} file(s)${sha ? ` @ ${sha}` : ""}`);
  }
  log(`session ${sessionId} ${outcome}: ${persisted} file(s) for ${p.key} -> ${storeRoot()}`);
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const mode = resolveMode(ctx);
        const tiers = tiersForMode(mode);
        if (tiers.length === 0) {
          log(`${mode} is execution-only — skipping memory sync-in (no learning)`);
          return;
        }
        const p = resolvePartition(ctx);
        const sandbox = await ctx.getSandbox();
        let synced = 0;
        for (const tier of tiers) {
          const files = await ensureTier(p, tier);
          await syncTierIntoSandbox(sandbox, tier, files);
          synced += Object.keys(files).length;
        }
        log(`synced ${synced} file(s) across [${tiers.join(", ")}] for ${p.key}`);
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
