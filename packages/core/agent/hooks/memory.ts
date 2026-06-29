import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { planFor, type ResolvedMemory } from "../memory/resolve.js";
import { providerById } from "../memory/provider.js";
import { isPointer } from "../memory/silo.js";
import { renderMemoryIndex } from "../memory/listing.js";
import { tierId, storeRoot, type MemoryFiles } from "../memory/store.js";
import { seedFor } from "../memory/layout.js";
import { syncTierIntoSandbox, readTierFromSandbox } from "../memory/sandbox-sync.js";
import { appendAudit } from "../audit/audit.js";

const sessionLog = defineState<{ firstMessage?: string }>(
  "open-everywhere.memory.sessionLog",
  () => ({}),
);

function log(msg: string): void {
  console.log(`[open-everywhere:memory] ${msg}`);
}

async function persistOnEnd(ctx: HookContext, outcome: "completed" | "failed"): Promise<void> {
  const binding = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const plan = planFor(binding, p);
  if (plan.writes.length === 0) {
    log(`session.${outcome}: nothing to persist — ${plan.reason}`);
    return;
  }
  const sessionId = ctx.session.id;
  const principalId = binding.principalId;
  const request = sessionLog.get().firstMessage?.trim().replace(/\n+/g, " ").slice(0, 200);

  let sandbox: Awaited<ReturnType<HookContext["getSandbox"]>> | null = null;
  try {
    sandbox = await ctx.getSandbox();
  } catch {
    log(`sandbox unavailable at session.${outcome}; persisting host-store state only`);
  }

  let persisted = 0;
  for (const rm of plan.writes) {
    const provider = providerById(rm.silo.provider);
    let files = await provider.readTier(p, rm.tier, rm.silo);
    if (sandbox) {
      const fromSandbox = await readTierFromSandbox(sandbox, rm.tier);
      if (Object.keys(fromSandbox).length > 0) files = fromSandbox;
    }
    const sha = await provider.writeTier(p, rm.tier, files, `session ${sessionId} (${outcome}) [${tierId(rm.tier)}]`, rm.silo);
    persisted += Object.keys(files).length;
    log(`persisted ${tierId(rm.tier)} → ${rm.silo.name}/${rm.silo.provider}: ${Object.keys(files).length} file(s)${sha ? ` @ ${sha}` : ""}`);
    if (sha) {
      await appendAudit({
        org: p.org,
        platform: p.platform,
        workspace: p.workspace,
        surface: p.surface,
        principalId,
        action: "memory.write",
        detail: { tier: tierId(rm.tier), silo: rm.silo.name, provider: rm.silo.provider, files: Object.keys(files).length, version: sha, outcome, sessionId, request },
      });
    }
  }
  log(`session ${sessionId} ${outcome}: ${persisted} file(s) for ${p.key} (${plan.reason}) -> ${storeRoot()}`);
}

const RO_BANNER =
  "<!-- read-only baseline: edits here are NOT saved. Use the `remember` tool (it writes to this channel's writable memory) instead. -->\n\n";

function withReadOnlyBanner(files: MemoryFiles): MemoryFiles {
  const md = files["MEMORY.md"];
  if (md && !md.startsWith("<!-- read-only")) return { ...files, "MEMORY.md": RO_BANNER + md };
  return files;
}

async function loadSource(p: ReturnType<typeof resolvePartition>, rm: ResolvedMemory): Promise<MemoryFiles> {
  const provider = providerById(rm.silo.provider);
  if (rm.readOnly) {
    const files = await provider.readTier(p, rm.tier, rm.silo);
    return withReadOnlyBanner(Object.keys(files).length > 0 ? files : seedFor(p, rm.tier));
  }
  return provider.ensureTier(p, rm.tier, rm.silo);
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const binding = bindFrom(ctx);
        const p = resolvePartition(ctx);
        const plan = planFor(binding, p);
        if (plan.reads.length === 0) {
          log(`session.started: no memory synced — ${plan.reason}`);
          return;
        }
        const sandbox = await ctx.getSandbox();
        let synced = 0;
        for (const rm of plan.reads) {
          if (isPointer(rm.silo)) continue;
          const files = await loadSource(p, rm);
          await syncTierIntoSandbox(sandbox, rm.tier, files);
          synced += Object.keys(files).length;
        }
        await sandbox.writeTextFile({ path: "memory/MEMORY.md", content: renderMemoryIndex(plan.reads) });
        log(`synced ${synced} file(s) across [${plan.reads.map((r) => tierId(r.tier)).join(", ")}] for ${p.key} (${plan.reason})`);
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
