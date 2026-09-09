import { createHash } from "node:crypto";
import type { AuditEntry } from "../../operational/store.js";
import { exampleLine, groupFailuresByAction, type BucketOptions, type FailureCluster } from "./mode3.js";

export interface FailureSignature {
  readonly action: string;
  readonly tool: string;
  readonly errorClass: string;
  readonly surface: string;
}

const ERROR_CLASS_MAX = 80;

const ERROR_TEXT_MAX = 2000;

export function normaliseErrorClass(text: string): string {
  const norm = text
    .slice(0, ERROR_TEXT_MAX)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/(["'`])(?:(?!\1).)*\1/g, "<q>")
    .replace(/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b(?=[A-Z0-9]*[0-9])[A-Z][A-Z0-9]{6,}\b/g, "<id>")
    .replace(/\d+/g, "<n>")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (norm.length <= ERROR_CLASS_MAX) return norm;
  return `${norm.slice(0, ERROR_CLASS_MAX)}#${createHash("sha256").update(norm).digest("hex").slice(0, 6)}`;
}

function detailOf(row: AuditEntry): Record<string, unknown> {
  return (row.detail ?? {}) as Record<string, unknown>;
}

function firstString(d: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

const SIGNATURE_FIELDS: Record<string, { readonly tool: readonly string[]; readonly error: readonly string[] }> = {
  "surface.quiet_fail": { tool: ["event"], error: ["message"] },
  "turn.bare_stop": { tool: [], error: [] },
  "webhook.rejected": { tool: ["hookId"], error: ["reason"] },
  "spend.cap_bypassed": { tool: ["standing"], error: ["reason"] },
  "approval.failed": { tool: ["kind"], error: ["error"] },
  "unified.supervisor_turn_failed": { tool: ["gatewayName", "upstreamType", "gatewayType"], error: ["code", "name", "message"] },
  "unified.supervisor_session_failed": { tool: ["gatewayName", "upstreamType", "gatewayType"], error: ["code", "name", "message"] },
};

export function surfaceKey(row: AuditEntry): string {
  return row.surface ? `${row.platform}/${row.workspace}/${row.surface}` : `${row.platform}/${row.workspace}`;
}

export function failureSignature(row: AuditEntry): FailureSignature {
  const fields = SIGNATURE_FIELDS[row.action] ?? { tool: [], error: [] };
  const d = detailOf(row);
  return {
    action: row.action,
    tool: firstString(d, fields.tool),
    errorClass: normaliseErrorClass(firstString(d, fields.error)),
    surface: surfaceKey(row),
  };
}

export function signatureKey(sig: FailureSignature): string {
  return JSON.stringify([sig.action, sig.tool, sig.errorClass, sig.surface]);
}

export interface SignatureCluster extends FailureCluster {
  readonly signature: FailureSignature;
  readonly days: number;
}

export function clusterFailures(rows: readonly AuditEntry[], opts: BucketOptions = {}): SignatureCluster[] {
  const maxClusters = opts.maxClusters ?? 3;
  const maxExamples = opts.maxExamplesPerCluster ?? 3;

  const bySignature = new Map<string, { sig: FailureSignature; entries: AuditEntry[]; seen: number }>();
  for (const entries of groupFailuresByAction(rows).values()) {
    for (const row of entries) {
      const sig = failureSignature(row);
      const key = signatureKey(sig);
      const hit = bySignature.get(key);
      if (hit) hit.entries.push(row);
      else bySignature.set(key, { sig, entries: [row], seen: bySignature.size });
    }
  }

  return Array.from(bySignature.values())
    .map((c) => ({
      action: c.sig.action,
      signature: c.sig,
      count: c.entries.length,
      days: distinctDays(c.entries),
      examples: c.entries.slice(0, maxExamples).map((row) => exampleLine(row, opts.surfaceName)),
      seen: c.seen,
    }))
    .sort((a, b) => b.count - a.count || b.days - a.days || a.seen - b.seen)
    .slice(0, maxClusters)
    .map(({ seen: _seen, ...cluster }) => cluster);
}

function distinctDays(entries: readonly AuditEntry[]): number {
  const days = new Set<string>();
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t)) days.add(new Date(t).toISOString().slice(0, 10));
  }
  return days.size;
}
