import { createHash } from "node:crypto";
import { HOST_OWNED_FILES } from "./host-owned-files.js";
import type { MemoryFiles } from "./store.js";

export const EXTERNAL_PROVENANCE_PREFIX = "[external-provenance:";

export const EXTERNAL_CLAIM_PREFIX = "[unverified claim";

const EXTERNAL_CLAIM_LEAD = `${EXTERNAL_CLAIM_PREFIX}; the turn ingested `;
const EXTERNAL_PROVENANCE_LEAD = `${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested `;

const UNNAMED_SOURCE = "external content";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function provenanceCarrierPattern(): RegExp {
  return new RegExp(`${escapeRe(EXTERNAL_CLAIM_LEAD)}[^\\][]*\\]|${escapeRe(EXTERNAL_PROVENANCE_LEAD)}[^\\][]*\\]`, "g");
}

export const MAX_MARKED_KINDS = 4;

const MAX_KIND_CHARS = 24;

function sanitiseKind(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, MAX_KIND_CHARS);
}

export function renderProvenanceMark(kinds: readonly string[] = []): string {
  return `${EXTERNAL_PROVENANCE_LEAD}${describeKinds(kinds) ?? UNNAMED_SOURCE}]`;
}

function describeKinds(kinds: readonly string[]): string | null {
  const named = kinds.map(sanitiseKind).filter((k) => k.length > 0);
  if (named.length === 0) return null;
  const shown = named.slice(0, MAX_MARKED_KINDS);
  const rest = named.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}

export function renderClaimAttribution(kinds: readonly string[] = []): string {
  return `${EXTERNAL_CLAIM_LEAD}${describeKinds(kinds) ?? UNNAMED_SOURCE}]`;
}

export interface ProvenanceWording {
  readonly mark: string;
  readonly attribution: string;
}

export function renderProvenanceWording(kinds: readonly string[] = []): ProvenanceWording {
  return { mark: renderProvenanceMark(kinds), attribution: renderClaimAttribution(kinds) };
}

export function isBulletLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line);
}

function isFenceLine(line: string): boolean {
  return /^\s*(?:```|~~~)/.test(line);
}

const BULLET_HEAD = /^(\s*(?:[-*+]|\d+\.)\s+)([^\n]*)$/;

const DATE_LEAD = /^(\d{4}-\d{2}-\d{2}(?:\s*:\s*|\s+))([^\n]*)$/;

const ANY_DATE_LEAD = /^\d{4}-\d{2}-\d{2}/;

const ATTRIBUTED_LEAD = /^(?:per\b|according to\b|reportedly\b|alleged(?:ly)?\b|claim(?:s|ed)?\b|unverified\b|rumou?r\b|says?\b|said\b|source\s*:)/i;

const NON_ASSERTION_LEAD = /^(?:todo\b|fixme\b|tbd\b|ask\b|check\b|confirm\b|verify\b|chase\b|ping\b|draft\b|review\b|send\b|schedule\b|follow[- ]up\b|remember to\b|note to self\b)/i;

const MIN_ASSERTION_WORDS = 3;

function isAssertionShaped(statement: string): boolean {
  const text = statement.trim();
  if (text.endsWith("?")) return false;
  if (/^\[[ xX]?\]/.test(text)) return false;
  if (ANY_DATE_LEAD.test(text)) return false;
  if (ATTRIBUTED_LEAD.test(text)) return false;
  if (NON_ASSERTION_LEAD.test(text)) return false;
  return text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= MIN_ASSERTION_WORDS;
}

export function recastAsAttributedClaim(line: string, attribution: string): string {
  if (attribution.length === 0) return line;
  const head = BULLET_HEAD.exec(line);
  if (head === null) return line;
  const rest = head[2]!;
  if (rest.includes(EXTERNAL_CLAIM_PREFIX)) return line;
  const dated = DATE_LEAD.exec(rest);
  const lead = dated?.[1] ?? "";
  const statement = dated?.[2] ?? rest;
  if (!isAssertionShaped(statement)) return line;
  return `${head[1]!}${lead}${attribution} ${statement}`;
}

interface LineCarriers {
  readonly attribution: string | null;
  readonly mark: string | null;
}

function carriersOf(line: string): LineCarriers {
  let attribution: string | null = null;
  let mark: string | null = null;
  for (const [found] of line.matchAll(provenanceCarrierPattern())) {
    if (attribution === null && found.startsWith(EXTERNAL_CLAIM_LEAD)) attribution = found;
    if (mark === null && found.startsWith(EXTERNAL_PROVENANCE_LEAD)) mark = found;
  }
  return { attribution, mark };
}

export function donorOf(sources: readonly string[]): string | undefined {
  return sources.find((source) => {
    const carriers = carriersOf(source);
    return carriers.attribution !== null || carriers.mark !== null;
  });
}

export function conserveProvenanceOnMerge(survivor: string, sources: readonly string[]): string {
  const source = donorOf(sources);
  if (source === undefined) return survivor;
  const donor = carriersOf(source);
  const held = carriersOf(survivor);
  if (held.attribution !== null || held.mark !== null) return survivor;
  let out = survivor;
  if (donor.attribution !== null) out = recastAsAttributedClaim(out, donor.attribution);
  if (donor.mark !== null) out = `${out.trimEnd()}  ${donor.mark}`;
  return out;
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

function distinctMarkedLines(content: string): number {
  const suffixed = new Set<string>();
  const attributed = new Set<string>();
  let fenced = false;
  for (const line of content.split("\n")) {
    if (isFenceLine(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !isBulletLine(line)) continue;
    if (line.includes(EXTERNAL_PROVENANCE_PREFIX)) suffixed.add(line.trim());
    if (line.includes(EXTERNAL_CLAIM_PREFIX)) attributed.add(line.trim());
  }
  return suffixed.size + attributed.size;
}

export interface ProvenanceGuard {
  readonly files: MemoryFiles;
  readonly reverted: readonly string[];
}

export function guardProvenanceMarks(before: MemoryFiles, after: MemoryFiles): ProvenanceGuard {
  const files: MemoryFiles = {};
  const reverted: string[] = [];
  for (const [rel, content] of Object.entries(after)) {
    const was = before[rel];
    if (typeof content !== "string" || typeof was !== "string" || was === content) {
      files[rel] = content;
      continue;
    }
    if (distinctMarkedLines(content) < distinctMarkedLines(was)) {
      files[rel] = was;
      reverted.push(rel);
      continue;
    }
    files[rel] = content;
  }
  return { files, reverted };
}

export function markAddedBullets(baseline: ProvenanceBaseline, files: MemoryFiles, wording: ProvenanceWording): ProvenanceMarking {
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
      out.push(`${recastAsAttributedClaim(line, wording.attribution).trimEnd()}  ${wording.mark}`);
      fileChanged = true;
      marked++;
    }
    if (fileChanged) changed[rel] = out.join("\n");
  }
  return { files: changed, marked };
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  "chat-message": "a chat",
  notion: "Notion",
  linear: "Linear",
  github: "GitHub",
  connector: "a connected app",
  web: "the web",
  webhook: "an outside service",
  "routine-event": "an outside service",
  "delegation-result": "a background task",
  "image-description": "an image",
  "file-upload": "a file",
  aws: "AWS",
};

function carrierSources(body: string): string {
  const words = [...new Set(body.split(/,|\+\d+ more/).map((k) => KIND_WORDS[k.trim()]).filter((w): w is string => w !== undefined))];
  return words.length === 0 ? "an outside source" : words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function memoryLineForReader(line: string): string {
  return line.replace(provenanceCarrierPattern(), (carrier) => {
    if (carrier.startsWith(EXTERNAL_CLAIM_LEAD)) return "(unconfirmed)";
    return `(from ${carrierSources(carrier.slice(EXTERNAL_PROVENANCE_LEAD.length, -1))})`;
  });
}

export function restoreProvenanceCarriers(edited: string, stored: string): string {
  const carriers = [...stored.matchAll(provenanceCarrierPattern())].map((m) => m[0]);
  let out = edited;
  let droppedMark: string | undefined;
  let cursor = 0;
  carriers.forEach((carrier, n) => {
    const raw = out.indexOf(carrier, cursor);
    if (raw >= 0) {
      cursor = raw + carrier.length;
      return;
    }
    const shown = memoryLineForReader(carrier);
    const isMark = carrier.startsWith(EXTERNAL_PROVENANCE_LEAD);
    const lastMark = isMark && n === carriers.length - 1 && stored.trimEnd().endsWith(carrier);
    const at = lastMark ? (out.trimEnd().endsWith(shown) ? out.trimEnd().length - shown.length : -1) : out.indexOf(shown, cursor);
    if (at >= cursor && at >= 0) {
      out = out.slice(0, at) + carrier + out.slice(at + shown.length);
      cursor = at + carrier.length;
    } else if (isMark) droppedMark = carrier;
  });
  return droppedMark === undefined ? out : `${out} ${droppedMark}`;
}
