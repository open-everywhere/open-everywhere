import { getOperationalStore } from "../../operational/provider.js";
import { appendAudit } from "../../audit/audit.js";
import { signatureDigest } from "./recurrence.js";
import type { MemoryProposalRow } from "../../operational/store.js";
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
  const createdAt = new Date().toISOString();
  let stored: MemoryProposalRow | null = null;
  try {
    stored = await getOperationalStore().addMemoryProposal({
      org,
      kind: p.kind,
      scope: p.scope,
      summary: p.summary,
      ...(p.before !== undefined ? { before: p.before } : {}),
      ...(p.after !== undefined ? { after: p.after } : {}),
      ...(p.detail ? { detail: p.detail } : {}),
      principalId,
      createdAt,
    });
  } catch (err) {
    console.log(`[open-everywhere:dream/proposal] store write failed — ${String(err)}`);
  }

  const signature = typeof p.detail?.["signature"] === "string" ? (p.detail["signature"] as string) : undefined;
  const count = typeof p.detail?.["count"] === "number" ? (p.detail["count"] as number) : undefined;
  const file = typeof p.detail?.["file"] === "string" ? (p.detail["file"] as string) : undefined;
  await appendAudit({
    org,
    platform: "memory",
    workspace: p.scope,
    principalId,
    action: "memory.proposal",
    detail: {
      ...(stored ? { proposalId: stored.id } : {}),
      kind: p.kind,
      scope: p.scope,
      ...(file !== undefined ? { file } : {}),
      ...(signature !== undefined ? { sigSha: signatureDigest(signature) } : {}),
      ...(count !== undefined ? { count } : {}),
    },
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

export function listProposals(org: string): Promise<MemoryProposalRow[]> {
  return getOperationalStore().listMemoryProposals(org);
}
