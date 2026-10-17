import {
  currentSessionId,
  currentTurnGithubTarget,
  currentTurnId,
  currentTurnIssue,
  currentTurnPage,
  currentWakeId,
  isUnifiedWindowContext,
  type BindableContext,
} from "../identity/binding.js";
import { addressedWakeThisTurn } from "../access/dispatch-origin-signal.js";
import { resolvePartition } from "../memory/partition.js";
import { noteConnectorRead, rememberRecordName, rememberSourceLink, type ConnectorRead, type ConnectorReadProof } from "./reply-provenance.js";
import { noteDelegatedRead } from "./delegated-provenance.js";

export type ReadReach = Pick<ConnectorRead, "proof" | "surfaceKey" | "wakeId">;

export function stampReadReach(bind: BindableContext, turnId: string | undefined, surfaceKey: string | undefined): ReadReach {
  const unified = isUnifiedWindowContext(bind);
  const wakeId = unified ? (addressedWakeThisTurn(turnId) ?? currentWakeId(bind)) : undefined;
  const proof: ConnectorReadProof = unified ? (wakeId !== undefined ? "wake" : "none") : surfaceKey !== undefined ? "surface" : "none";
  return {
    proof,
    ...(proof === "surface" && surfaceKey !== undefined ? { surfaceKey } : {}),
    ...(proof === "wake" && wakeId !== undefined ? { wakeId } : {}),
  };
}

export type AuthoredRecordKind = "notion-page" | "linear-issue" | "github-issue" | "github-pull-request";

const AUTHORED_READ_TOOLS: Readonly<Record<AuthoredRecordKind, { readonly connection: string; readonly ops: readonly [string, ...string[]] }>> = {
  "notion-page": { connection: "notion", ops: ["read_notion_page", "read_notion_comments"] },
  "linear-issue": { connection: "linear", ops: ["read_linear_issue"] },
  "github-issue": { connection: "github", ops: ["read_github_issue"] },
  "github-pull-request": { connection: "github", ops: ["read_github_issue", "check_pr_status", "get_pr_feedback", "walk_pr"] },
};

export function githubRecordId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export interface AuthoredRecordRead {
  readonly kind: AuthoredRecordKind;
  readonly op?: string;
  readonly id: string;
  readonly alsoKnownAs?: readonly (string | undefined)[];
  readonly name?: string;
  readonly url?: string;
}

function idKey(v: string): string {
  const lower = v.toLowerCase();
  const dashless = lower.replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(dashless) ? dashless : lower;
}

function sameId(a: string, b: string): boolean {
  const key = idKey(a);
  return key.length > 0 && key === idKey(b);
}

function roomRecordId(kind: AuthoredRecordKind, bind: BindableContext): string | undefined {
  switch (kind) {
    case "linear-issue":
      return currentTurnIssue(bind);
    case "notion-page":
      return currentTurnPage(bind);
    case "github-issue":
    case "github-pull-request": {
      const target = currentTurnGithubTarget(bind);
      return target === undefined ? undefined : githubRecordId(`${target.owner}/${target.repo}`, target.number);
    }
  }
}

function roomHoldsRecordId(read: AuthoredRecordRead, bind: BindableContext): boolean {
  const room = roomRecordId(read.kind, bind);
  if (room === undefined || room.length === 0) return false;
  for (const candidate of [read.id, ...(read.alsoKnownAs ?? [])]) {
    if (typeof candidate === "string" && candidate.length > 0 && sameId(candidate, room)) return true;
  }
  return false;
}

export function noteAuthoredRecordRead(ctx: unknown, read: AuthoredRecordRead): void {
  try {
    const spec = AUTHORED_READ_TOOLS[read.kind];
    if (spec === undefined || typeof read.id !== "string" || read.id.length === 0) return;
    const op = read.op ?? spec.ops[0];
    if (!spec.ops.includes(op)) return;
    const bind = ctx as BindableContext;
    const turnId = currentTurnId(bind);
    if (turnId === undefined || turnId.length === 0) return;
    let surfaceKey: string | undefined;
    try {
      surfaceKey = resolvePartition(bind).surfaceKey;
    } catch {
      surfaceKey = undefined;
    }
    const named = roomHoldsRecordId(read, bind);
    const citable = typeof read.name === "string" && read.name.length > 0 && typeof read.url === "string" && read.url.length > 0;
    noteConnectorRead(turnId, {
      ...stampReadReach(bind, turnId, surfaceKey),
      connection: spec.connection,
      op,
      ...(named ? { record: { kind: read.kind, id: read.id } } : {}),
      ...(citable ? { cite: { kind: read.kind, id: read.id } } : {}),
    });
    noteDelegatedRead(bind, spec.connection, op, undefined, citable ? { kind: read.kind, id: read.id, name: read.name, url: read.url } : undefined);
    if (named) rememberRecordName(currentSessionId(bind), turnId, read.kind, read.id, read.name);
    if (citable) rememberSourceLink(currentSessionId(bind), turnId, read.kind, read.id, read.name, read.url);
  } catch {
  }
}

export const BORROWED_RECORD_KIND = "credential-grant";

export const BORROWED_READ_OP = "credential_grant_borrow";

export interface BorrowedRecordRead {
  readonly connection: string;
  readonly grantId: string;
  readonly targetLabel?: string;
}

export function noteBorrowedRecordRead(ctx: unknown, read: BorrowedRecordRead): void {
  try {
    if (read.connection.length === 0 || read.grantId.length === 0) return;
    const bind = ctx as BindableContext;
    const turnId = currentTurnId(bind);
    if (turnId === undefined || turnId.length === 0) return;
    let surfaceKey: string | undefined;
    try {
      surfaceKey = resolvePartition(bind).surfaceKey;
    } catch {
      surfaceKey = undefined;
    }
    const label = read.targetLabel !== undefined && read.targetLabel.length > 0 ? read.targetLabel : undefined;
    noteConnectorRead(turnId, {
      ...stampReadReach(bind, turnId, surfaceKey),
      connection: read.connection,
      op: BORROWED_READ_OP,
      ...(label === undefined ? {} : { record: { kind: BORROWED_RECORD_KIND, id: read.grantId } }),
    });
    if (label !== undefined) rememberRecordName(currentSessionId(bind), turnId, BORROWED_RECORD_KIND, read.grantId, label);
    noteDelegatedRead(bind, read.connection, BORROWED_READ_OP, label === undefined ? undefined : { kind: BORROWED_RECORD_KIND, id: read.grantId, name: label });
  } catch {
  }
}
