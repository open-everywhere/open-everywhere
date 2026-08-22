import { createHash } from "node:crypto";
import { HOST_OWNED_FILES } from "./host-owned-files.js";
import type { MemoryFiles } from "./store.js";

export const EXTERNAL_PROVENANCE_PREFIX = "[external-provenance:";

export const MAX_MARKED_KINDS = 4;

const MAX_KIND_CHARS = 24;

function sanitiseKind(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, MAX_KIND_CHARS);
}

export function renderProvenanceMark(kinds: readonly string[] = []): string {
  const named = kinds.map(sanitiseKind).filter((k) => k.length > 0);
  if (named.length === 0) return `${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested external content]`;
  const shown = named.slice(0, MAX_MARKED_KINDS);
  const rest = named.length - shown.length;
  return `${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}]`;
}

export function isBulletLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line);
}

function isFenceLine(line: string): boolean {
  return /^\s*(?:```|~~~)/.test(line);
}

export function lineDigest(line: string): string {
  return createHash("sha1").update(line.trim()).digest("hex").slice(0, 12);
}

export type ProvenanceBaseline = Readonly<Record<string, readonly string[]>>;

export function baselineOf(files: MemoryFiles): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [rel, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    out[rel] = [...new Set(content.split("\n").map(lineDigest))];
  }
  return out;
}

function isUnmarkableFile(rel: string): boolean {
  return HOST_OWNED_FILES.has(rel) || rel.includes(".conflict-") || rel.includes(".rejected-");
}

export interface ProvenanceMarking {
  readonly files: MemoryFiles;
  readonly marked: number;
}

export function markAddedBullets(baseline: ProvenanceBaseline, files: MemoryFiles, mark: string): ProvenanceMarking {
  const changed: MemoryFiles = {};
  let marked = 0;
  for (const [rel, content] of Object.entries(files)) {
    if (typeof content !== "string" || isUnmarkableFile(rel)) continue;
    const held = new Set(baseline[rel] ?? []);
    const lines = content.split("\n");
    const out: string[] = [];
    let fenced = false;
    let fileChanged = false;
    for (const line of lines) {
      if (isFenceLine(line)) {
        fenced = !fenced;
        out.push(line);
        continue;
      }
      if (fenced || !isBulletLine(line) || line.includes(EXTERNAL_PROVENANCE_PREFIX) || held.has(lineDigest(line))) {
        out.push(line);
        continue;
      }
      out.push(`${line.trimEnd()}  ${mark}`);
      fileChanged = true;
      marked++;
    }
    if (fileChanged) changed[rel] = out.join("\n");
  }
  return { files: changed, marked };
}
