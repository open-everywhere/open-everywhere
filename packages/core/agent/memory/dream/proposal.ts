import { appendAudit, readAudit, type AuditEntry } from "../../audit/audit.js";
import type { MemoryOp } from "./ops.js";

export const DREAM_ACTOR = "dream-cycle";

export interface Proposal {
  readonly kind: string;
  readonly scope: string;
  readonly summary: string;
  readonly before?: string;
  readonly after?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export async function recordProposal(org: string, p: Proposal, principalId: string = DREAM_ACTOR): Promise<void> {
  await appendAudit({
    org,
    platform: "memory",
    workspace: p.scope,
    principalId,
    action: "memory.proposal",
    detail: { kind: p.kind, scope: p.scope, summary: p.summary, before: p.before, after: p.after, ...(p.detail ?? {}) },
  });
}

export async function recordMemoryOpProposals(org: string, silo: string, ops: readonly MemoryOp[]): Promise<number> {
  for (const op of ops) {
    await recordProposal(org, {
      kind: op.kind,
      scope: silo,
      summary: op.summary,
      before: op.before,
      after: op.after,
      detail: { file: op.file },
    });
  }
  return ops.length;
}

export function listProposals(org: string): Promise<AuditEntry[]> {
  return readAudit({ org, action: "memory.proposal" });
}
