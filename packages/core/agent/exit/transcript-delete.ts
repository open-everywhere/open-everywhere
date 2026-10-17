import type { OperationalStore } from "../operational/store.js";
import { deleteLocalRun, isRunId } from "./workflow-world.js";
import type { TranscriptStore } from "./transcript-store.js";

export const EXIT_TRANSCRIPT_DELETED_ACTION = "exit.transcript_deleted";

export interface DeleteTranscriptOptions {
  readonly store: OperationalStore;
  readonly org: string;
  readonly sessionId: string;
  readonly transcripts: TranscriptStore;
  readonly actor: string;
  readonly now?: Date;
}

export type DeleteTranscriptOutcome = "deleted" | "absent" | "refused-live" | "hosted";

export interface DeleteTranscriptReport {
  readonly outcome: DeleteTranscriptOutcome;
  readonly files: number;
  readonly captures: number;
  readonly status?: string;
}

export async function deleteTranscript(opts: DeleteTranscriptOptions): Promise<DeleteTranscriptReport> {
  if (!isRunId(opts.sessionId)) throw new Error(`"${opts.sessionId}" is not a session id — a session id starts with wrun_`);
  if (opts.store.exitTables === undefined) throw new Error(`the ${opts.store.id} operational store has no exit-kit table access`);
  let outcome: DeleteTranscriptOutcome = "hosted";
  let files = 0;
  if (opts.transcripts.kind === "local") {
    const r = deleteLocalRun(opts.transcripts.dataDir, opts.sessionId);
    if (r.outcome === "refused-live") return { outcome: "refused-live", files: 0, captures: 0, status: r.status };
    outcome = r.outcome;
    files = r.outcome === "deleted" ? r.files : 0;
  }
  const captures = await opts.store.exitTables.deleteRows("model_call_capture", opts.org, { anyOf: [{ column: "session_id", values: [opts.sessionId] }] });
  await opts.store.appendAudit({
    ts: (opts.now ?? new Date()).toISOString(),
    org: opts.org,
    platform: "exit",
    workspace: "transcript",
    principalId: opts.actor,
    action: EXIT_TRANSCRIPT_DELETED_ACTION,
    detail: { sessionId: opts.sessionId, outcome, files, captures },
  });
  return { outcome, files, captures };
}
