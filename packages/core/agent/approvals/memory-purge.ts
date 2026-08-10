import { getConfig } from "../access/config.js";
import { providerById } from "../memory/provider.js";
import { redactedBulletLabel, removeBulletLinesBySha } from "../memory/purge-redaction.js";
import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";
import type { Tier } from "../memory/store.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

export interface MemoryPurgeLocation {
  readonly siloName: string;
  readonly provider: string;
  readonly tierId: string;
  readonly file: string;
}

export interface MemoryPurgeArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly bullets: readonly { readonly sha256: string; readonly chars: number }[];
  readonly locations: readonly MemoryPurgeLocation[];
}

function tierFromFrozen(tierIdStr: string, siloName: string): Tier {
  if (tierIdStr === "workspace") return { kind: "workspace" };
  if (tierIdStr === "surface") return { kind: "surface" };
  return { kind: "silo", name: siloName };
}

function byTier(locations: readonly MemoryPurgeLocation[]): Map<string, { loc: MemoryPurgeLocation; files: string[] }> {
  const out = new Map<string, { loc: MemoryPurgeLocation; files: string[] }>();
  for (const l of locations) {
    const key = JSON.stringify([l.siloName, l.tierId]);
    const entry = out.get(key);
    if (entry) {
      if (!entry.files.includes(l.file)) entry.files.push(l.file);
    } else {
      out.set(key, { loc: l, files: [l.file] });
    }
  }
  return out;
}

const memoryPurge: ActionKind<MemoryPurgeArgs> = {
  kind: "memory.purge",
  policy: "member",
  summarize(args) {
    const bullets = args.bullets ?? [];
    const locations = args.locations ?? [];
    const silos = [...new Set(locations.map((l) => l.siloName))];
    return [
      `PURGE ${bullets.length} remembered fact(s) — silo(s) ${silos.map((s) => `\`${s}\``).join(", ") || "(none)"}`,
      ...bullets.map((b) => `> ${redactedBulletLabel(b.sha256, b.chars)}`),
      `Found in ${locations.length} file(s): ${locations.map((l) => `${l.tierId}/${l.file}`).join(", ")}`,
    ];
  },
  async execute(args, decidedBy) {
    const shas = (args.bullets ?? []).map((b) => b.sha256);
    const removedFrom: string[] = [];
    const skipped: string[] = [];
    const commits: string[] = [];
    let removedLines = 0;

    for (const { loc, files: rels } of byTier(args.locations ?? []).values()) {
      const silo = getConfig().loadSilos().find((s) => s.name === loc.siloName);
      const provider = providerById(silo?.provider ?? loc.provider);
      const tier = tierFromFrozen(loc.tierId, loc.siloName);

      const files = await provider.readTier(args.partition, tier, silo);
      let changed = false;
      for (const rel of rels) {
        const content = files[rel];
        if (content === undefined) {
          skipped.push(`${loc.tierId}/${rel}`);
          continue;
        }
        const { content: next, removed } = removeBulletLinesBySha(content, shas);
        if (removed === 0) {
          skipped.push(`${loc.tierId}/${rel}`);
          continue;
        }
        files[rel] = next;
        removedLines += removed;
        removedFrom.push(`${loc.tierId}/${rel}`);
        changed = true;
      }
      if (!changed) continue;
      const commit = await provider.writeTier(
        args.partition,
        tier,
        files,
        `purge [${loc.tierId}]: ${shas.length} line(s), ${redactedBulletLabel(shas[0] ?? "")}`,
        silo,
      );
      if (commit) commits.push(commit);
    }

    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "memory.purge",
      detail: {
        bullets: (args.bullets ?? []).map((b) => ({ sha256: b.sha256, chars: b.chars })),
        removedFrom,
        skipped,
        removedLines,
        ...(commits.length ? { commits } : {}),
        ...(removedFrom.length === 0 ? { alreadyGone: true } : {}),
      },
    });

    if (removedFrom.length === 0) {
      return `already gone — the matched fact(s) weren't found in any of their recorded files (${skipped.join(", ") || "none"})`;
    }
    const skippedNote = skipped.length > 0 ? ` (already gone from: ${skipped.join(", ")})` : "";
    return `purged ${removedLines} line(s) from ${removedFrom.join(", ")}${skippedNote}`;
  },
};

registerActionKind(memoryPurge);
