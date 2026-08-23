import type { ReleaseChange, ReleaseMigration, ReleaseRecord, ReleaseRollback } from "./schema.js";

export interface UpgradeContext {
  readonly fromSha: string;
  readonly toSha: string;
  readonly reached: boolean;
  readonly changes: readonly ReleaseChange[];
  readonly migrations: readonly ReleaseMigration[];
  readonly verify: readonly string[];
  readonly rollback: ReleaseRollback;
}

export function buildUpgradeContext(records: readonly ReleaseRecord[], fromSha: string, toSha?: string): UpgradeContext {
  const byPrevious = new Map<string, ReleaseRecord>();
  for (const r of records) {
    if (r.previousSha === null) continue;
    const existing = byPrevious.get(r.previousSha);
    if (existing && existing.sha !== r.sha) {
      throw new Error(
        `release-record chain forks: both ${existing.sha} and ${r.sha} declare previousSha ${r.previousSha} — cannot walk this deterministically`,
      );
    }
    byPrevious.set(r.previousSha, r);
  }

  const chain: ReleaseRecord[] = [];
  const visited = new Set<string>([fromSha]);
  let cursor = fromSha;
  while (toSha === undefined || cursor !== toSha) {
    const next = byPrevious.get(cursor);
    if (!next) break;
    if (visited.has(next.sha)) {
      throw new Error(`release-record chain cycles back to ${next.sha}`);
    }
    visited.add(next.sha);
    chain.push(next);
    cursor = next.sha;
  }

  const verify: string[] = [];
  for (const r of chain) for (const v of r.verify) if (!verify.includes(v)) verify.push(v);

  return {
    fromSha,
    toSha: cursor,
    reached: toSha === undefined ? true : cursor === toSha,
    changes: chain.flatMap((r) => r.changes),
    migrations: chain.flatMap((r) => r.migrations),
    verify,
    rollback: chain.length > 0 ? chain[chain.length - 1].rollback : { command: "rollback" },
  };
}
