import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { planFor, type ResolvedMemory } from "../memory/resolve.js";
import { providerById } from "../memory/provider.js";
import { renderMemoryIndex } from "../memory/listing.js";
import { tierId, storeRoot, type MemoryFiles, type Tier } from "../memory/store.js";
import { seedFor } from "../memory/layout.js";
import { syncTierIntoSandbox, readTierFromSandbox, removeTierFiles, removeTierDir, tierSandboxDir, writeTierFile } from "../memory/sandbox-sync.js";
import { type ProvenanceWording, baselineOf, markAddedBullets, renderProvenanceWording } from "../memory/provenance-mark.js";
import { untrustedIngestedThisTurn, taintKindsThisTurn } from "../access/taint-signal.js";
import { taintEnabled } from "../access/taint-enforcement.js";
import { readOnlyBanner, hasReadOnlyBanner, lockCommand, unlockCommand } from "../memory/readonly.js";
import { lockMemoryRoot, memoryRootUnlockCommand } from "../memory/root-fence.js";
import { removedLineDigests } from "../memory/purge-redaction.js";
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

const materialisedTiers = defineState<Record<string, { tier: Tier; silo: string; readOnly: boolean }>>(
  "open-everywhere.memory.materialisedTiers",
  () => ({}),
);

const provenanceBaseline = defineState<{ armed?: boolean; tiers?: Record<string, Record<string, string[]>> }>(
  "open-everywhere.memory.provenanceBaseline",
  () => ({}),
);

function log(msg: string): void {
  console.log(`[open-everywhere:memory] ${msg}`);
}

function hashContent(s: string): string {
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

const MAX_AUDITED_DELETIONS = 50;

function deletionDigests(
  hostCurrent: MemoryFiles,
  files: MemoryFiles,
): { readonly perFile: readonly { file: string; removed: readonly { sha256: string; chars: number }[] }[]; readonly total: number } {
  const perFile: { file: string; removed: readonly { sha256: string; chars: number }[] }[] = [];
  let total = 0;
  for (const [rel, hostContent] of Object.entries(hostCurrent)) {
    if (isHostMintedSibling(rel)) continue;
    const next = files[rel];
    if (next === undefined || next === hostContent) continue;
    let removed: readonly { sha256: string; chars: number }[];
    try {
      removed = removedLineDigests(hostContent, next);
    } catch {
      continue;
    }
    if (removed.length === 0) continue;
    total += removed.length;
    perFile.push({ file: rel, removed });
  }
  return { perFile, total };
}

function deletionDetail(hostCurrent: MemoryFiles, files: MemoryFiles): Record<string, unknown> | null {
  const { perFile, total } = deletionDigests(hostCurrent, files);
  if (total === 0) return null;
  let budget = MAX_AUDITED_DELETIONS;
  const rendered: { file: string; lines: { sha256: string; chars: number }[] }[] = [];
  for (const entry of perFile) {
    if (budget <= 0) break;
    const take = entry.removed.slice(0, budget);
    budget -= take.length;
    rendered.push({ file: entry.file, lines: take.map((l) => ({ sha256: l.sha256, chars: l.chars })) });
  }
  return {
    deletedLines: total,
    deleted: rendered,
    ...(total > MAX_AUDITED_DELETIONS ? { deletedTruncated: true } : {}),
  };
}

export const SUBAGENT_SKIP_MARKER = "SKIPPED — this is an eve subagent child";

function skipAsSubagentChild(ctx: HookContext, phase: string): boolean {
  let child = false;
  try {
    child = isSubagentChildContext(ctx as unknown as BindableContext);
  } catch {
    child = false;
  }
  if (child) log(`${phase}: ${SUBAGENT_SKIP_MARKER}; the parent owns the shared sandbox's memory tree`);
  return child;
}

type MemorySandbox = Awaited<ReturnType<HookContext["getSandbox"]>>;

export type MemoryPersistOutcome = "completed" | "failed" | "settled";

const PERSIST_WHERE: Record<MemoryPersistOutcome, string> = {
  completed: "session.completed",
  failed: "session.failed",
  settled: "delegation settlement",
};

export type MemoryPersistContext = BindableContext & {
  readonly session?: { readonly id?: string };
  readonly channel?: { readonly continuationToken?: string };
  getSandbox?: () => Promise<MemorySandbox>;
};

export interface MemoryFlushSummary {
  readonly silos: number;
  readonly persisted: number;
  readonly changed: number;
  readonly failed: number;
}

const NOTHING_PERSISTED: MemoryFlushSummary = { silos: 0, persisted: 0, changed: 0, failed: 0 };

export async function persistMemoryNow(ctx: MemoryPersistContext, outcome: MemoryPersistOutcome): Promise<MemoryFlushSummary> {
  const where = PERSIST_WHERE[outcome] ?? String(outcome);
  if (skipAsSubagentChild(ctx as unknown as HookContext, where)) return NOTHING_PERSISTED;
  const binding = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const plan = planFor(binding, p);
  if (plan.writes.length === 0) {
    log(`${where}: nothing to persist — ${plan.reason}`);
    return NOTHING_PERSISTED;
  }
  await markProvenanceForTurn(ctx, `persist:${outcome}`);
  const sessionId = ctx.session?.id ?? "";
  const principalId = binding.principalId;
  const request = sessionLog.get().firstMessage?.trim().replace(/\n+/g, " ").slice(0, 200);
  const continuationToken = ctx.channel?.continuationToken;

  let sandbox: MemorySandbox | null = null;
  try {
    sandbox = ctx.getSandbox ? await ctx.getSandbox() : null;
  } catch {
    log(`sandbox unavailable at ${where}; persisting host-store state only`);
  }

  const baselines = writeBaseline.get();
  let persisted = 0;
  let changed = 0;
  const failed: string[] = [];
  for (const rm of plan.writes) {
    try {
      const provider = providerById(rm.silo.provider);
      const hostCurrent = await provider.readTier(p, rm.tier, rm.silo, rm.access);
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
      const deleted = deletionDetail(hostCurrent, files);
      const sha = await provider.writeTier(p, rm.tier, files, `session ${sessionId} (${outcome}) [${tierId(rm.tier)}]`, rm.silo, rm.access);
      persisted += Object.keys(files).length;
      if (sha) changed++;
      try {
        writeBaseline.update((b) => ({ ...b, [tierId(rm.tier)]: hashFiles(files) }));
      } catch (err) {
        log(`write-baseline advance skipped for ${tierId(rm.tier)} (the persist itself landed; a later pass may re-file our own write as a conflict): ${String(err)}`);
      }
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
          detail: { tier: tierId(rm.tier), silo: rm.silo.name, provider: rm.silo.provider, files: Object.keys(files).length, version: sha, outcome, sessionId, request, ...(continuationToken ? { continuationToken } : {}), ...(conflicts.length ? { conflicts } : {}), ...(rejected.length ? { refused: rejected.map((r) => r.rel) } : {}), ...(deleted ?? {}) },
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
  return { silos: plan.writes.length, persisted, changed, failed: failed.length };
}

function withReadOnlyBanner(files: MemoryFiles, silo: MemorySilo): MemoryFiles {
  const md = files["MEMORY.md"];
  if (md && !hasReadOnlyBanner(md)) return { ...files, "MEMORY.md": readOnlyBanner(silo) + md };
  return files;
}

async function loadSource(p: ReturnType<typeof resolvePartition>, rm: ResolvedMemory): Promise<MemoryFiles> {
  const provider = providerById(rm.silo.provider);
  if (rm.readOnly) {
    const files = await provider.readTier(p, rm.tier, rm.silo, rm.access);
    return withReadOnlyBanner(Object.keys(files).length > 0 ? files : seedFor(p, rm.tier), rm.silo);
  }
  return provider.ensureTier(p, rm.tier, rm.silo, rm.access);
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
    if (isSubagentChildContext(ctx as unknown as BindableContext)) return false;
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
      if (provider.tierVersion) versions[tierId(rm.tier)] = await provider.tierVersion(p, rm.tier, rm.silo, rm.access);
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
  const host = await provider.readTier(p, rm.tier, rm.silo, rm.access);
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

async function unmaterialiseDroppedTiers(
  sandbox: Awaited<ReturnType<HookContext["getSandbox"]>>,
  dropped: readonly { tierId: string; tier: Tier; silo: string; readOnly: boolean }[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const d of dropped) {
    const dir = tierSandboxDir(d.tier);
    try {
      const present = await readTierFromSandbox(sandbox, d.tier);
      if (d.readOnly) await sandbox.run({ command: unlockCommand(dir) });
      const rels = Object.keys(present);
      if (rels.length > 0) await removeTierFiles(sandbox, d.tier, rels);
      await removeTierDir(sandbox, d.tier);
      removed.push(d.tierId);
    } catch (err) {
      log(`turn.started UN-MATERIALISE FAILED for ${d.tierId} ← ${d.silo} (other tiers unaffected): ${String(err)}`);
    }
  }
  return removed;
}

async function resyncSupervisorReads(ctx: HookContext): Promise<readonly string[]> {
  let sandbox: Awaited<ReturnType<HookContext["getSandbox"]>> | null = null;
  let rootUnlocked = false;
  const openSandbox = async (): Promise<Awaited<ReturnType<HookContext["getSandbox"]>>> => {
    sandbox ??= await ctx.getSandbox();
    if (!rootUnlocked) {
      try {
        await sandbox.run({ command: memoryRootUnlockCommand() });
        rootUnlocked = true;
      } catch (err) {
        log(`turn.started memory root unlock failed (a gained/dropped tier may not apply this turn): ${String(err)}`);
      }
    }
    return sandbox;
  };
  try {
    return await runSupervisorResync(ctx, openSandbox);
  } finally {
    if (rootUnlocked && sandbox) await lockMemoryRoot(sandbox);
  }
}

async function runSupervisorResync(
  ctx: HookContext,
  openSandbox: () => Promise<Awaited<ReturnType<HookContext["getSandbox"]>>>,
): Promise<readonly string[]> {
  const binding = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const plan = planFor(binding, p);
  const planned = new Set(plan.reads.map((r) => tierId(r.tier)));
  const known = materialisedTiers.get();
  const dropped = Object.entries(known)
    .filter(([tid]) => !planned.has(tid))
    .map(([tid, v]) => ({ tierId: tid, ...v }));
  if (plan.reads.length === 0 && dropped.length === 0) return [];
  const last = readSyncVersions.get();
  const next: Record<string, string | null> = { ...last };
  let sandbox: Awaited<ReturnType<HookContext["getSandbox"]>> | null = null;
  const resynced: string[] = [];
  const healed: string[] = [];
  const stillFailed = { ...failedReadSilos.get() };

  let removed: string[] = [];
  const removedNames: string[] = [];
  if (dropped.length > 0) {
    sandbox = await openSandbox();
    removed = await unmaterialiseDroppedTiers(sandbox, dropped);
    if (removed.length > 0) {
      const gone = new Set(removed);
      for (const tid of removed) {
        removedNames.push(known[tid]!.silo);
        delete next[tid];
        delete stillFailed[tid];
      }
      writeBaseline.update((b) => Object.fromEntries(Object.entries(b).filter(([tid]) => !gone.has(tid))));
      materialisedTiers.update((m) => Object.fromEntries(Object.entries(m).filter(([tid]) => !gone.has(tid))));
      log(`turn.started UN-MATERIALISED ${removed.length} dropped tier(s) [${removed.join(", ")}] for ${p.key}`);
    }
  }

  for (const rm of plan.reads) {
    const tid = tierId(rm.tier);
    try {
      const provider = providerById(rm.silo.provider);
      if (!provider.tierVersion) continue;
      const version = await provider.tierVersion(p, rm.tier, rm.silo, rm.access);
      const lastSynced = last[tid];
      if (lastSynced !== undefined && version === lastSynced) continue;
      sandbox = await openSandbox();
      if (rm.readOnly) await refreshReadOnlyTier(sandbox, p, rm);
      else await refreshWritableTier(sandbox, p, rm);
      next[tid] = version;
      resynced.push(tid);
      materialisedTiers.update((m) => ({ ...m, [tid]: { tier: rm.tier, silo: rm.silo.name, readOnly: rm.readOnly === true } }));
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
  } else if (removed.length > 0) {
    readSyncVersions.update(() => next);
  }
  if ((healed.length > 0 || removed.length > 0) && sandbox) {
    failedReadSilos.update(() => stillFailed);
    try {
      const okReads = plan.reads.filter((r) => !stillFailed[tierId(r.tier)]);
      const failedNames = plan.reads.filter((r) => stillFailed[tierId(r.tier)]).map((r) => r.silo.name);
      const healedNames = plan.reads.filter((r) => healed.includes(tierId(r.tier))).map((r) => r.silo.name);
      await sandbox.run({ command: unlockCommand("memory/MEMORY.md") });
      await sandbox.writeTextFile({ path: "memory/MEMORY.md", content: renderMemoryIndex(okReads, failedNames) });
      await lock(sandbox, "memory/MEMORY.md");
      log(
        `turn.started refreshed the memory index for ${p.key}` +
          `${healed.length ? ` — healed ${healed.length} previously-failed silo(s) [${healed.join(", ")}]` : ""}` +
          `${removed.length ? ` — dropped ${removed.length} un-planned tier(s) [${removed.join(", ")}]` : ""}`,
      );
      try {
        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId: binding.principalId,
          action: "memory.index_change",
          detail: {
            healed: healedNames,
            ...(removedNames.length ? { removed: removedNames } : {}),
            ...(ctx.channel?.continuationToken ? { continuationToken: ctx.channel.continuationToken } : {}),
          },
        });
      } catch (err) {
        log(`turn.started index_change audit skipped (index already refreshed on disk): ${String(err)}`);
      }
    } catch (err) {
      log(`turn.started index refresh failed (silo materialisation itself already applied): ${String(err)}`);
    }
  }
  return resynced;
}

function provenanceArmed(): boolean {
  try {
    return taintEnabled();
  } catch {
    return false;
  }
}

async function provenanceTargets(
  ctx: MemoryPersistContext,
): Promise<{ p: ReturnType<typeof resolvePartition>; principalId: string | undefined; writes: readonly ResolvedMemory[]; sandbox: MemorySandbox } | null> {
  if (!provenanceArmed()) return null;
  const p = resolvePartition(ctx);
  const binding = bindFrom(ctx);
  const plan = planFor(binding, p);
  if (plan.writes.length === 0 || ctx.getSandbox === undefined) return null;
  return { p, principalId: binding.principalId, writes: plan.writes, sandbox: await ctx.getSandbox() };
}

async function captureProvenanceBaseline(ctx: MemoryPersistContext): Promise<void> {
  try {
    if (provenanceBaseline.get().armed === true) return;
    const target = await provenanceTargets(ctx);
    if (target === null) return;
    const tiers: Record<string, Record<string, string[]>> = {};
    for (const rm of target.writes) tiers[tierId(rm.tier)] = baselineOf(await readTierFromSandbox(target.sandbox, rm.tier));
    provenanceBaseline.update(() => ({ armed: true, tiers }));
    log(`provenance baseline captured for ${target.writes.length} writable tier(s)`);
  } catch (err) {
    log(`provenance baseline capture SKIPPED — no bullet this session adds takes a mark: ${String(err)}`);
  }
}

async function rebaseProvenanceAfterResync(ctx: MemoryPersistContext, resynced: readonly string[]): Promise<void> {
  if (resynced.length === 0) return;
  const touched = new Set(resynced);
  let target: Awaited<ReturnType<typeof provenanceTargets>> = null;
  try {
    if (provenanceBaseline.get().armed !== true) return;
    target = await provenanceTargets(ctx);
    if (target === null) return;
  } catch (err) {
    log(`provenance re-base preamble failed, nothing advanced: ${String(err)}`);
    return;
  }
  const advanced: string[] = [];
  const dropped: string[] = [];
  for (const rm of target.writes) {
    const tid = tierId(rm.tier);
    if (!touched.has(tid)) continue;
    try {
      const fresh = baselineOf(await readTierFromSandbox(target.sandbox, rm.tier));
      provenanceBaseline.update((cur) => ({ ...cur, armed: true, tiers: { ...(cur.tiers ?? {}), [tid]: fresh } }));
      advanced.push(tid);
    } catch (err) {
      provenanceBaseline.update((cur) => ({ ...cur, armed: true, tiers: Object.fromEntries(Object.entries(cur.tiers ?? {}).filter(([k]) => k !== tid)) }));
      dropped.push(tid);
      log(`provenance re-base could not read ${tid}, so it takes NO mark this turn: ${String(err)}`);
    }
  }
  if (advanced.length > 0 || dropped.length > 0) {
    log(`provenance baseline re-based over ${advanced.length} re-synced tier(s)${dropped.length > 0 ? `, ${dropped.length} dropped` : ""}`);
  }
}

async function markProvenanceForTurn(ctx: MemoryPersistContext, where: string): Promise<void> {
  try {
    const state = provenanceBaseline.get();
    if (state.armed !== true) return;
    const target = await provenanceTargets(ctx);
    if (target === null) return;
    const tainted = untrustedIngestedThisTurn();
    const kinds = [...taintKindsThisTurn()];
    const wording: ProvenanceWording = tainted ? renderProvenanceWording(kinds) : { mark: "", attribution: "" };
    const tiers: Record<string, Record<string, string[]>> = {};
    const markedFiles: string[] = [];
    let marked = 0;
    for (const rm of target.writes) {
      const tid = tierId(rm.tier);
      const files = await readTierFromSandbox(target.sandbox, rm.tier);
      let current = files;
      const held = state.tiers?.[tid];
      if (tainted && held !== undefined) {
        const pass = markAddedBullets(held, files, wording);
        for (const [rel, content] of Object.entries(pass.files)) {
          await writeTierFile(target.sandbox, rm.tier, rel, content);
          markedFiles.push(`${tid}/${rel}`);
        }
        if (pass.marked > 0) {
          current = { ...files, ...pass.files };
          marked += pass.marked;
        }
      }
      tiers[tid] = baselineOf(current);
    }
    provenanceBaseline.update((cur) => ({ ...cur, armed: true, tiers }));
    if (marked === 0) return;
    log(`${where}: marked ${marked} added bullet(s) with external provenance in ${markedFiles.join(", ")}`);
    try {
      await appendAudit({
        org: target.p.org,
        platform: target.p.platform,
        workspace: target.p.workspace,
        surface: target.p.surface,
        principalId: target.principalId,
        action: "memory.provenance_marked",
        detail: {
          where,
          bullets: marked,
          files: markedFiles,
          kinds,
          ...(ctx.session?.id ? { sessionId: ctx.session.id } : {}),
        },
      });
    } catch (err) {
      log(`memory.provenance_marked audit skipped (the marks are already in the sandbox): ${String(err)}`);
    }
  } catch (err) {
    log(`${where}: provenance marking skipped (the turn is unaffected): ${String(err)}`);
  }
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      if (skipAsSubagentChild(ctx, "session.started")) return;
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
              baselines[tierId(rm.tier)] = hashFiles(await provider.readTier(p, rm.tier, rm.silo, rm.access));
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
        if (!(await lockMemoryRoot(sandbox))) log("memory root fence NOT applied (chmod failed) — a shell write into an unowned silo would be dropped silently, as before OPE-999");
        if (resyncArmed(ctx)) {
          const tVersions = timing ? timing.now() : 0;
          await recordReadVersions(p, okReads);
          failedReadSilos.update(() => failedTiers);
          materialisedTiers.update(() =>
            Object.fromEntries(okReads.map((r) => [tierId(r.tier), { tier: r.tier, silo: r.silo.name, readOnly: r.readOnly === true }])),
          );
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
      let resynced: readonly string[] = [];
      if (resyncArmed(ctx)) {
        try {
          resynced = await resyncSupervisorReads(ctx);
        } catch (err) {
          log(`turn.started re-sync skipped: ${String(err)}`);
        }
      }
      try {
        await rebaseProvenanceAfterResync(ctx, resynced);
      } catch (err) {
        log(`provenance re-base skipped: ${String(err)}`);
      }
      await captureProvenanceBaseline(ctx);
    },

    "message.received": (event, _ctx) => {
      const current = sessionLog.get();
      if (!current.firstMessage && typeof event.data?.message === "string") {
        sessionLog.update((s) => ({ ...s, firstMessage: event.data.message }));
      }
    },

    "turn.completed": async (_event, ctx) => {
      await markProvenanceForTurn(ctx, "turn.completed");
    },

    "turn.failed": async (_event, ctx) => {
      await markProvenanceForTurn(ctx, "turn.failed");
    },

    "session.completed": async (_event, ctx) => {
      await persistMemoryNow(ctx, "completed");
    },

    "session.failed": async (_event, ctx) => {
      await persistMemoryNow(ctx, "failed");
    },
  },
});
