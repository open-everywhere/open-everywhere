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
import { startMemorySyncTiming, emitMemorySyncTiming, byteSize } from "../memory/sync-timing.js";
import type { MemorySilo } from "../memory/silo.js";
import { appendAudit } from "../audit/audit.js";
import { isSupervisorSession } from "../model/routing.js";
import { windowTopologyEnabled } from "../access/capabilities.js";
import { getConfig } from "../access/config.js";
import { HOST_OWNED_FILES } from "../memory/host-owned-files.js";

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

function siblingName(rel: string, marker: string, sessionId: string): string {
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "session";
  const dot = rel.lastIndexOf(".");
  const slash = rel.lastIndexOf("/");
  if (dot > slash && dot !== -1) return `${rel.slice(0, dot)}.${marker}-${sid}${rel.slice(dot)}`;
  return `${rel}.${marker}-${sid}`;
}

export function conflictName(rel: string, sessionId: string): string {
  return siblingName(rel, "conflict", sessionId);
}

export function rejectedName(rel: string, sessionId: string): string {
  return siblingName(rel, "rejected", sessionId);
}

function isHostOwnedFile(rel: string): boolean {
  return HOST_OWNED_FILES.has(rel);
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
    if (isHostOwnedFile(rel)) {
      if (rel in hostCurrent) merged[rel] = hostCurrent[rel];
      continue;
    }
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

export const MEMORY_DROP_RATIO_FLOOR = 0.5;
export const MEMORY_DROP_MIN_LINES = 3;

export interface RejectedWrite {
  readonly rel: string;
  readonly hostLines: number;
  readonly droppedLines: number;
  readonly parkedAs: string;
}

function isHostMintedSibling(rel: string): boolean {
  return rel.includes(".conflict-") || rel.includes(".rejected-");
}

function contentLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function destructionVerdict(host: string, next: string): { hostLines: number; droppedLines: number } | null {
  if (typeof host !== "string" || typeof next !== "string") throw new TypeError("memory floor: non-string file content");
  const before = contentLines(host);
  if (before.length === 0) return null;
  const kept = new Set(contentLines(next));
  const dropped = before.filter((l) => !kept.has(l)).length;
  if (dropped < MEMORY_DROP_MIN_LINES) return null;
  if (dropped / before.length <= MEMORY_DROP_RATIO_FLOOR) return null;
  return { hostLines: before.length, droppedLines: dropped };
}

export function guardDestructiveWrites(
  hostCurrent: MemoryFiles,
  merged: MemoryFiles,
  sessionId: string,
): { files: MemoryFiles; rejected: RejectedWrite[] } {
  const files: MemoryFiles = { ...merged };
  const rejected: RejectedWrite[] = [];
  for (const [rel, hostContent] of Object.entries(hostCurrent)) {
    if (isHostMintedSibling(rel)) continue;
    const next = files[rel];
    if (next === undefined || next === hostContent) continue;
    let verdict: { hostLines: number; droppedLines: number } | null;
    try {
      verdict = destructionVerdict(hostContent, next);
    } catch {
      verdict = { hostLines: -1, droppedLines: -1 };
    }
    if (!verdict) continue;
    const parkedAs = rejectedName(rel, sessionId);
    files[rel] = hostContent;
    files[parkedAs] = typeof next === "string" ? next : String(next);
    rejected.push({ rel, hostLines: verdict.hostLines, droppedLines: verdict.droppedLines, parkedAs });
  }
  return { files, rejected };
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
      const hostCurrent = await provider.readTier(p, rm.tier, rm.silo);
      let files = hostCurrent;
      let conflicts: string[] = [];
      let rejected: RejectedWrite[] = [];
      if (sandbox) {
        const fromSandbox = await readTierFromSandbox(sandbox, rm.tier);
        if (Object.keys(fromSandbox).length > 0) {
          const baseline = baselines[tierId(rm.tier)] ?? {};
          const merged = mergePreservingConflicts(hostCurrent, fromSandbox, baseline, sessionId);
          conflicts = merged.conflicts;
          ({ files, rejected } = guardDestructiveWrites(hostCurrent, merged.files, sessionId));
        }
      }
      if (rejected.length > 0) {
        log(
          `REFUSED ${rejected.length} destructive overwrite(s) in ${tierId(rm.tier)} → ${rm.silo.name}: ` +
            rejected.map((r) => `${r.rel} (-${r.droppedLines}/${r.hostLines} lines, parked as ${r.parkedAs})`).join(", "),
        );
        try {
          await appendAudit({
            org: p.org,
            platform: p.platform,
            workspace: p.workspace,
            surface: p.surface,
            principalId,
            action: "memory.write_refused",
            detail: {
              tier: tierId(rm.tier),
              silo: rm.silo.name,
              provider: rm.silo.provider,
              outcome,
              sessionId,
              request,
              ...(continuationToken ? { continuationToken } : {}),
              refused: rejected.map((r) => ({ file: r.rel, hostLines: r.hostLines, droppedLines: r.droppedLines, parkedAs: r.parkedAs })),
            },
          });
        } catch (err) {
          log(`memory.write_refused audit skipped (the overwrite was still refused): ${String(err)}`);
        }
      }
      const sha = await provider.writeTier(p, rm.tier, files, `session ${sessionId} (${outcome}) [${tierId(rm.tier)}]`, rm.silo);
      persisted += Object.keys(files).length;
      log(
        `persisted ${tierId(rm.tier)} → ${rm.silo.name}/${rm.silo.provider}: ${Object.keys(files).length} file(s)` +
          `${sha ? ` @ ${sha}` : ""}${conflicts.length ? ` (preserved ${conflicts.length} concurrent-write conflict(s): ${conflicts.join(", ")})` : ""}` +
          `${rejected.length ? ` (REFUSED ${rejected.length} destructive overwrite(s): ${rejected.map((r) => r.rel).join(", ")})` : ""}`,
      );
      if (sha) {
        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId,
          action: "memory.write",
          detail: { tier: tierId(rm.tier), silo: rm.silo.name, provider: rm.silo.provider, files: Object.keys(files).length, version: sha, outcome, sessionId, request, ...(continuationToken ? { continuationToken } : {}), ...(conflicts.length ? { conflicts } : {}), ...(rejected.length ? { refused: rejected.map((r) => r.rel) } : {}) },
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
    return windowTopologyEnabled();
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
      const timing = startMemorySyncTiming();
      try {
        const binding = bindFrom(ctx);
        const p = resolvePartition(ctx);
        const plan = planFor(binding, p);
        if (binding.trust === "external" && binding.platform !== "local") {
          try {
            await appendAudit({
              org: p.org,
              platform: p.platform,
              workspace: p.workspace,
              surface: p.surface,
              principalId: binding.principalId,
              action: "memory.trust_gate",
              detail: { mode: binding.mode, reads: plan.reads.length, reason: plan.reason, ...(ctx.session?.id ? { sessionId: ctx.session.id } : {}) },
            });
          } catch (err) {
            log(`session.started trust_gate audit skipped: ${String(err)}`);
          }
        }
        if (plan.reads.length === 0) {
          log(`session.started: no memory synced — ${plan.reason}`);
          if (timing) await emitMemorySyncTiming(p, binding.principalId, timing.finish(ctx.session?.id ?? null));
          return;
        }
        if (plan.writes.length > 0) {
          const tBaseline = timing ? timing.now() : 0;
          const baselines: Record<string, Record<string, string>> = {};
          for (const rm of plan.writes) {
            try {
              const provider = providerById(rm.silo.provider);
              baselines[tierId(rm.tier)] = hashFiles(await provider.readTier(p, rm.tier, rm.silo));
            } catch (err) {
              log(`write-baseline FAILED for ${tierId(rm.tier)} ← ${rm.silo.name}/${rm.silo.provider} (sync continues; persist will treat every file as concurrently-changed): ${String(err)}`);
            }
          }
          writeBaseline.update(() => baselines);
          timing?.mark("baseline", tBaseline);
        }
        const tSandbox = timing ? timing.now() : 0;
        const sandbox = await ctx.getSandbox();
        timing?.mark("sandbox", tSandbox);
        let synced = 0;
        const okReads: typeof plan.reads[number][] = [];
        const failedReads: string[] = [];
        const failedTiers: Record<string, string> = {};
        for (const rm of plan.reads) {
          const tLoad = timing ? timing.now() : 0;
          let tSync = 0;
          let tLock = 0;
          try {
            const files = await loadSource(p, rm);
            tSync = timing ? timing.now() : 0;
            await syncTierIntoSandbox(sandbox, rm.tier, files);
            tLock = timing ? timing.now() : 0;
            synced += Object.keys(files).length;
            if (rm.readOnly) await lock(sandbox, tierSandboxDir(rm.tier));
            timing?.silo({
              silo: rm.silo.name,
              tier: tierId(rm.tier),
              provider: rm.silo.provider,
              readOnly: rm.readOnly === true,
              loadMs: tSync - tLoad,
              syncMs: tLock - tSync,
              lockMs: rm.readOnly ? timing.now() - tLock : null,
              files: Object.keys(files).length,
              bytes: byteSize(files),
              ok: true,
            });
            okReads.push(rm);
          } catch (err) {
            failedReads.push(rm.silo.name);
            failedTiers[tierId(rm.tier)] = rm.silo.name;
            timing?.silo({
              silo: rm.silo.name,
              tier: tierId(rm.tier),
              provider: rm.silo.provider,
              readOnly: rm.readOnly === true,
              loadMs: (tSync || timing.now()) - tLoad,
              syncMs: tSync ? timing.now() - tSync : -1,
              lockMs: null,
              files: 0,
              bytes: 0,
              ok: false,
            });
            log(`SYNC FAILED for ${tierId(rm.tier)} ← ${rm.silo.name}/${rm.silo.provider} (other silos unaffected): ${String(err)}`);
          }
        }
        const tIndex = timing ? timing.now() : 0;
        await sandbox.writeTextFile({ path: "memory/MEMORY.md", content: renderMemoryIndex(okReads, failedReads) });
        await lock(sandbox, "memory/MEMORY.md");
        timing?.mark("index", tIndex);
        if (resyncArmed(ctx)) {
          const tVersions = timing ? timing.now() : 0;
          await recordReadVersions(p, okReads);
          failedReadSilos.update(() => failedTiers);
          warnGitlessReadSilos(plan.reads);
          timing?.mark("versions", tVersions);
        }
        log(
          `synced ${synced} file(s) across [${okReads.map((r) => tierId(r.tier)).join(", ")}] for ${p.key} (${plan.reason})` +
            `${failedReads.length ? ` — ${failedReads.length} silo(s) FAILED to sync: ${failedReads.join(", ")}` : ""}`,
        );
        if (timing) await emitMemorySyncTiming(p, binding.principalId, timing.finish(ctx.session?.id ?? null));
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
