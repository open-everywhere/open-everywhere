import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { planFor, type ResolvedMemory } from "../memory/resolve.js";
import { providerById } from "../memory/provider.js";
import { renderMemoryIndex } from "../memory/listing.js";
import { tierId, storeRoot, type MemoryFiles } from "../memory/store.js";
import { seedFor } from "../memory/layout.js";
import { syncTierIntoSandbox, readTierFromSandbox, removeTierFiles, tierSandboxDir } from "../memory/sandbox-sync.js";
import { readOnlyBanner, hasReadOnlyBanner, lockCommand, unlockCommand } from "../memory/readonly.js";
import type { MemorySilo } from "../memory/silo.js";
import { appendAudit } from "../audit/audit.js";
import { isSupervisorSession } from "../model/routing.js";
import { unifiedSupervisorOrgGateEnabled } from "../memory/domain.js";
import { getConfig } from "../access/config.js";

const sessionLog = defineState<{ firstMessage?: string }>(
  "open-everywhere.memory.sessionLog",
  () => ({}),
);

const writeBaseline = defineState<Record<string, Record<string, string>>>(
  "open-everywhere.memory.writeBaseline",
  () => ({}),
);

const readSyncVersions = defineState<Record<string, string | null>>(
  "open-everywhere.memory.readSyncVersions",
  () => ({}),
);

const failedReadSilos = defineState<Record<string, string>>(
  "open-everywhere.memory.failedReadSilos",
  () => ({}),
);

function log(msg: string): void {
  console.log(`[open-everywhere:memory] ${msg}`);
}

export function hashContent(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function hashFiles(files: MemoryFiles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) out[rel] = hashContent(content);
  return out;
}

export function conflictName(rel: string, sessionId: string): string {
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "session";
  const dot = rel.lastIndexOf(".");
  const slash = rel.lastIndexOf("/");
  if (dot > slash && dot !== -1) return `${rel.slice(0, dot)}.conflict-${sid}${rel.slice(dot)}`;
  return `${rel}.conflict-${sid}`;
}

export function mergePreservingConflicts(
  hostCurrent: MemoryFiles,
  fromSandbox: MemoryFiles,
  baseline: Record<string, string>,
  sessionId: string,
): { files: MemoryFiles; conflicts: string[] } {
  const merged: MemoryFiles = { ...hostCurrent, ...fromSandbox };
  const conflicts: string[] = [];
  for (const [rel, sandboxContent] of Object.entries(fromSandbox)) {
    if (rel.includes(".conflict-")) continue;
    const hostContent = hostCurrent[rel];
    if (hostContent === undefined) continue;
    const hostChangedSinceStart = hashContent(hostContent) !== baseline[rel];
    const weChangedIt = sandboxContent !== hostContent;
    if (hostChangedSinceStart && weChangedIt) {
      merged[conflictName(rel, sessionId)] = hostContent;
      conflicts.push(rel);
    }
  }
  return { files: merged, conflicts };
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
  const continuationToken = ctx.channel?.continuationToken;

  let sandbox: Awaited<ReturnType<HookContext["getSandbox"]>> | null = null;
  try {
    sandbox = await ctx.getSandbox();
  } catch {
    log(`sandbox unavailable at session.${outcome}; persisting host-store state only`);
  }

  const baselines = writeBaseline.get();
  let persisted = 0;
  const failed: string[] = [];
  for (const rm of plan.writes) {
    try {
      const provider = providerById(rm.silo.provider);
      let files = await provider.readTier(p, rm.tier, rm.silo);
      let conflicts: string[] = [];
      if (sandbox) {
        const fromSandbox = await readTierFromSandbox(sandbox, rm.tier);
        if (Object.keys(fromSandbox).length > 0) {
          const baseline = baselines[tierId(rm.tier)] ?? {};
          ({ files, conflicts } = mergePreservingConflicts(files, fromSandbox, baseline, sessionId));
        }
      }
      const sha = await provider.writeTier(p, rm.tier, files, `session ${sessionId} (${outcome}) [${tierId(rm.tier)}]`, rm.silo);
      persisted += Object.keys(files).length;
      log(
        `persisted ${tierId(rm.tier)} → ${rm.silo.name}/${rm.silo.provider}: ${Object.keys(files).length} file(s)` +
          `${sha ? ` @ ${sha}` : ""}${conflicts.length ? ` (preserved ${conflicts.length} concurrent-write conflict(s): ${conflicts.join(", ")})` : ""}`,
      );
      if (sha) {
        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId,
          action: "memory.write",
          detail: { tier: tierId(rm.tier), silo: rm.silo.name, provider: rm.silo.provider, files: Object.keys(files).length, version: sha, outcome, sessionId, request, ...(continuationToken ? { continuationToken } : {}), ...(conflicts.length ? { conflicts } : {}) },
        });
      }
    } catch (err) {
      failed.push(rm.silo.name);
      log(`PERSIST FAILED for ${tierId(rm.tier)} → ${rm.silo.name}/${rm.silo.provider} (other silos unaffected): ${String(err)}`);
    }
  }
  log(
    `session ${sessionId} ${outcome}: ${persisted} file(s) for ${p.key} (${plan.reason}) -> ${storeRoot()}` +
      `${failed.length ? ` — ${failed.length} silo(s) FAILED to persist: ${failed.join(", ")}` : ""}`,
  );
}

function withReadOnlyBanner(files: MemoryFiles, silo: MemorySilo): MemoryFiles {
  const md = files["MEMORY.md"];
  if (md && !hasReadOnlyBanner(md)) return { ...files, "MEMORY.md": readOnlyBanner(silo) + md };
  return files;
}

async function loadSource(p: ReturnType<typeof resolvePartition>, rm: ResolvedMemory): Promise<MemoryFiles> {
  const provider = providerById(rm.silo.provider);
  if (rm.readOnly) {
    const files = await provider.readTier(p, rm.tier, rm.silo);
    return withReadOnlyBanner(Object.keys(files).length > 0 ? files : seedFor(p, rm.tier), rm.silo);
  }
  return provider.ensureTier(p, rm.tier, rm.silo);
}

async function lock(sandbox: Awaited<ReturnType<HookContext["getSandbox"]>>, path: string): Promise<void> {
  try {
    await sandbox.run({ command: lockCommand(path) });
  } catch (err) {
    log(`read-only lock for ${path} failed (advisory banner still applies): ${String(err)}`);
  }
}

function resyncArmed(ctx: HookContext): boolean {
  try {
    if (!isSupervisorSession(ctx)) return false;
    return unifiedSupervisorOrgGateEnabled(getConfig().loadDomains());
  } catch {
    return false;
  }
}

function warnGitlessReadSilos(reads: readonly ResolvedMemory[]): void {
  if (existsSync(join(storeRoot(), ".git"))) return;
  const gitSilos = reads.filter((r) => r.silo.provider === "git").map((r) => r.silo.name);
  if (gitSilos.length === 0) return;
  log(
    `⚠ git-backed read silo(s) [${gitSilos.join(", ")}] but the memory store has no .git — ` +
      `tierVersion can't detect upstream writes, so mid-session re-sync will NEVER fire for them ` +
      `(a degraded-git self-host store stays stale until session end). Initialise git in the store ` +
      `(${storeRoot()}) or use the sqlite/postgres memory provider.`,
  );
}

async function recordReadVersions(p: ReturnType<typeof resolvePartition>, reads: readonly ResolvedMemory[]): Promise<void> {
  const versions: Record<string, string | null> = {};
  for (const rm of reads) {
    try {
      const provider = providerById(rm.silo.provider);
      if (provider.tierVersion) versions[tierId(rm.tier)] = await provider.tierVersion(p, rm.tier, rm.silo);
    } catch {
    }
  }
  readSyncVersions.update(() => versions);
}

async function refreshWritableTier(
  sandbox: Awaited<ReturnType<HookContext["getSandbox"]>>,
  p: ReturnType<typeof resolvePartition>,
  rm: ResolvedMemory,
): Promise<void> {
  const provider = providerById(rm.silo.provider);
  const host = await provider.readTier(p, rm.tier, rm.silo);
  const fromSandbox = await readTierFromSandbox(sandbox, rm.tier);
  const tid = tierId(rm.tier);
  const baseline = { ...(writeBaseline.get()[tid] ?? {}) };
  const dir = tierSandboxDir(rm.tier);
  for (const [rel, content] of Object.entries(host)) {
    const sandboxContent = fromSandbox[rel];
    const agentChanged = sandboxContent !== undefined && hashContent(sandboxContent) !== baseline[rel];
    if (agentChanged && sandboxContent !== content) continue;
    if (sandboxContent !== content) await sandbox.writeTextFile({ path: `${dir}/${rel}`, content });
    baseline[rel] = hashContent(content);
  }
  const toDelete: string[] = [];
  for (const [rel, sandboxContent] of Object.entries(fromSandbox)) {
    if (rel in host) continue;
    if (hashContent(sandboxContent) === baseline[rel]) {
      toDelete.push(rel);
      delete baseline[rel];
    }
  }
  if (toDelete.length > 0) await removeTierFiles(sandbox, rm.tier, toDelete);
  writeBaseline.update((b) => ({ ...b, [tid]: baseline }));
}

async function refreshReadOnlyTier(
  sandbox: Awaited<ReturnType<HookContext["getSandbox"]>>,
  p: ReturnType<typeof resolvePartition>,
  rm: ResolvedMemory,
): Promise<void> {
  const files = await loadSource(p, rm);
  const dir = tierSandboxDir(rm.tier);
  const before = await readTierFromSandbox(sandbox, rm.tier);
  const stale = Object.keys(before).filter((rel) => !(rel in files));
  try {
    await sandbox.run({ command: unlockCommand(dir) });
    await syncTierIntoSandbox(sandbox, rm.tier, files);
    if (stale.length > 0) await removeTierFiles(sandbox, rm.tier, stale);
  } finally {
    await lock(sandbox, dir);
  }
}

async function resyncSupervisorReads(ctx: HookContext): Promise<void> {
  const binding = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const plan = planFor(binding, p);
  if (plan.reads.length === 0) return;
  const last = readSyncVersions.get();
  const next: Record<string, string | null> = { ...last };
  let sandbox: Awaited<ReturnType<HookContext["getSandbox"]>> | null = null;
  const resynced: string[] = [];
  const healed: string[] = [];
  const stillFailed = { ...failedReadSilos.get() };
  for (const rm of plan.reads) {
    const tid = tierId(rm.tier);
    try {
      const provider = providerById(rm.silo.provider);
      if (!provider.tierVersion) continue;
      const version = await provider.tierVersion(p, rm.tier, rm.silo);
      const lastSynced = last[tid];
      if (lastSynced !== undefined && version === lastSynced) continue;
      sandbox ??= await ctx.getSandbox();
      if (rm.readOnly) await refreshReadOnlyTier(sandbox, p, rm);
      else await refreshWritableTier(sandbox, p, rm);
      next[tid] = version;
      resynced.push(tid);
      if (stillFailed[tid]) {
        delete stillFailed[tid];
        healed.push(tid);
      }
    } catch (err) {
      log(`turn.started RE-SYNC FAILED for ${tid} ← ${rm.silo.name}/${rm.silo.provider} (other silos unaffected): ${String(err)}`);
    }
  }
  if (resynced.length > 0) {
    readSyncVersions.update(() => next);
    log(`turn.started re-materialised ${resynced.length} advanced silo(s) [${resynced.join(", ")}] for ${p.key}`);
  }
  if (healed.length > 0 && sandbox) {
    failedReadSilos.update(() => stillFailed);
    try {
      const okReads = plan.reads.filter((r) => !stillFailed[tierId(r.tier)]);
      const failedNames = plan.reads.filter((r) => stillFailed[tierId(r.tier)]).map((r) => r.silo.name);
      const healedNames = plan.reads.filter((r) => healed.includes(tierId(r.tier))).map((r) => r.silo.name);
      await sandbox.run({ command: unlockCommand("memory/MEMORY.md") });
      await sandbox.writeTextFile({ path: "memory/MEMORY.md", content: renderMemoryIndex(okReads, failedNames) });
      await lock(sandbox, "memory/MEMORY.md");
      log(`turn.started healed ${healed.length} previously-failed silo(s) [${healed.join(", ")}]; refreshed memory index for ${p.key}`);
      try {
        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId: binding.principalId,
          action: "memory.index_change",
          detail: { healed: healedNames, ...(ctx.channel?.continuationToken ? { continuationToken: ctx.channel.continuationToken } : {}) },
        });
      } catch (err) {
        log(`turn.started index_change audit skipped (index already refreshed on disk): ${String(err)}`);
      }
    } catch (err) {
      log(`turn.started index refresh after heal failed (silos still materialised): ${String(err)}`);
    }
  }
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
        if (plan.writes.length > 0) {
          const baselines: Record<string, Record<string, string>> = {};
          for (const rm of plan.writes) {
            const provider = providerById(rm.silo.provider);
            baselines[tierId(rm.tier)] = hashFiles(await provider.readTier(p, rm.tier, rm.silo));
          }
          writeBaseline.update(() => baselines);
        }
        const sandbox = await ctx.getSandbox();
        let synced = 0;
        const okReads: typeof plan.reads[number][] = [];
        const failedReads: string[] = [];
        const failedTiers: Record<string, string> = {};
        for (const rm of plan.reads) {
          try {
            const files = await loadSource(p, rm);
            await syncTierIntoSandbox(sandbox, rm.tier, files);
            synced += Object.keys(files).length;
            if (rm.readOnly) await lock(sandbox, tierSandboxDir(rm.tier));
            okReads.push(rm);
          } catch (err) {
            failedReads.push(rm.silo.name);
            failedTiers[tierId(rm.tier)] = rm.silo.name;
            log(`SYNC FAILED for ${tierId(rm.tier)} ← ${rm.silo.name}/${rm.silo.provider} (other silos unaffected): ${String(err)}`);
          }
        }
        await sandbox.writeTextFile({ path: "memory/MEMORY.md", content: renderMemoryIndex(okReads, failedReads) });
        await lock(sandbox, "memory/MEMORY.md");
        if (resyncArmed(ctx)) {
          await recordReadVersions(p, okReads);
          failedReadSilos.update(() => failedTiers);
          warnGitlessReadSilos(plan.reads);
        }
        log(
          `synced ${synced} file(s) across [${okReads.map((r) => tierId(r.tier)).join(", ")}] for ${p.key} (${plan.reason})` +
            `${failedReads.length ? ` — ${failedReads.length} silo(s) FAILED to sync: ${failedReads.join(", ")}` : ""}`,
        );
      } catch (err) {
        log(`session.started sync skipped: ${String(err)}`);
      }
    },

    "turn.started": async (_event, ctx) => {
      if (!resyncArmed(ctx)) return;
      try {
        await resyncSupervisorReads(ctx);
      } catch (err) {
        log(`turn.started re-sync skipped: ${String(err)}`);
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
