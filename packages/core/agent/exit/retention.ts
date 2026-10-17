import type { OperationalStore } from "../operational/store.js";
import { EXIT_TABLES } from "./catalogue.js";
import { deleteLocalRun, runsOlderThan } from "./workflow-world.js";
import type { TranscriptStore } from "./transcript-store.js";

export const EXIT_RETENTION_SWEPT_ACTION = "exit.retention_swept";

const DAY_MS = 24 * 60 * 60_000;

export interface RetentionSweepOptions {
  readonly store: OperationalStore;
  readonly org: string;
  readonly now: Date;
  readonly storedStateDays: number;
  readonly sessionTranscriptDays: number;
  readonly transcripts: TranscriptStore;
}

export interface RetentionSweepReport {
  readonly rows: Readonly<Record<string, number>>;
  readonly transcriptsDeleted: number;
  readonly transcriptStore: "local" | "hosted";
}

export async function retentionSweep(opts: RetentionSweepOptions): Promise<RetentionSweepReport> {
  const tables = opts.store.exitTables;
  if (tables === undefined) throw new Error(`the ${opts.store.id} operational store has no exit-kit table access, so it cannot age rows out`);
  const rows: Record<string, number> = {};
  if (opts.storedStateDays > 0) {
    const before = new Date(opts.now.getTime() - opts.storedStateDays * DAY_MS).toISOString();
    for (const spec of EXIT_TABLES) {
      if (spec.ageColumn === undefined || spec.appendOnly || spec.orgColumn === null) continue;
      const n = await tables.deleteRows(spec.table, opts.org, { olderThan: { column: spec.ageColumn, before } });
      if (n > 0) rows[spec.table] = n;
    }
  }
  let transcriptsDeleted = 0;
  if (opts.sessionTranscriptDays > 0 && opts.transcripts.kind === "local") {
    const before = new Date(opts.now.getTime() - opts.sessionTranscriptDays * DAY_MS).toISOString();
    for (const run of runsOlderThan(opts.transcripts.dataDir, before)) {
      if (deleteLocalRun(opts.transcripts.dataDir, run.runId).outcome === "deleted") transcriptsDeleted++;
    }
  }
  const report: RetentionSweepReport = { rows, transcriptsDeleted, transcriptStore: opts.transcripts.kind };
  await opts.store.appendAudit({
    ts: opts.now.toISOString(),
    org: opts.org,
    platform: "exit",
    workspace: "retention",
    action: EXIT_RETENTION_SWEPT_ACTION,
    detail: {
      storedStateDays: opts.storedStateDays,
      sessionTranscriptDays: opts.sessionTranscriptDays,
      rows,
      transcriptsDeleted,
      transcriptStore: opts.transcripts.kind,
    },
  });
  return report;
}
