import type { AuditWireEntry } from "./audit-read.js";

export const EGRESS_POLICY_ACTION = "egress.policy";

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CredentialedWriteHost {
  readonly host: string;
  readonly via: string | null;
  readonly methods: readonly string[] | "any";
}

export interface EgressHostEvidence {
  readonly rows: number;
  readonly matches: readonly CredentialedWriteHost[];
  readonly hostsSeen: readonly string[];
}

function admitsAWrite(methods: readonly string[] | "any"): boolean {
  if (methods === "any") return true;
  return methods.some((m) => !READ_ONLY_METHODS.has(m.toUpperCase()));
}

function readVerbs(e: Record<string, unknown>): readonly string[] | "any" | undefined {
  for (const key of ["verb", "methods"] as const) {
    const v = e[key];
    if (v === "any") return "any";
    if (Array.isArray(v) && v.every((m) => typeof m === "string")) return v as readonly string[];
  }
  return undefined;
}

function readWriteHost(raw: unknown): (CredentialedWriteHost & { readonly credentialed: boolean }) | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.host !== "string" || e.host.length === 0) return undefined;
  if (typeof e.credentialed !== "boolean") return undefined;
  const methods = readVerbs(e);
  if (methods === undefined) return undefined;
  const credential = typeof e.credential === "string" ? e.credential : typeof e.via === "string" ? e.via : null;
  return { host: e.host, via: credential, methods, credentialed: e.credentialed };
}

export function findCredentialedWriteHost(rows: readonly AuditWireEntry[], opts: { readonly host: string; readonly surface?: string }): EgressHostEvidence {
  const considered = rows.filter((r) => r.action === EGRESS_POLICY_ACTION && (opts.surface === undefined || r.surface === undefined || r.surface === opts.surface));
  const matches: CredentialedWriteHost[] = [];
  const hostsSeen = new Set<string>();
  for (const row of considered) {
    const raw = (row.detail ?? {})["writeHosts"];
    if (!Array.isArray(raw)) continue;
    for (const element of raw) {
      const entry = readWriteHost(element);
      if (!entry) continue;
      hostsSeen.add(entry.host);
      if (entry.host === opts.host && entry.credentialed && admitsAWrite(entry.methods)) matches.push({ host: entry.host, via: entry.via, methods: entry.methods });
    }
  }
  return { rows: considered.length, matches, hostsSeen: [...hostsSeen].sort() };
}

export const NOTION_PAGE_LINK = /https?:\/\/(?:[a-z0-9-]+\.)*notion\.(?:so|site)\/[^\s<>"'`)\]]*[0-9a-f]{32}/gi;

export function notionPageLinks(text: string): readonly string[] {
  return [...new Set(text.match(NOTION_PAGE_LINK) ?? [])];
}

export interface NotionPagePin {
  readonly pageId: string;
  readonly title: string;
  readonly phrases: readonly string[];
}

const MIN_PHRASE_CHARS = 28;
const MAX_PHRASE_CHARS = 180;
const MIN_PHRASE_WORDS = 5;
const MAX_PHRASES = 12;

function foldForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[*_`>\\|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function blockText(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const block = raw as Record<string, unknown>;
  const kind = typeof block.type === "string" ? block.type : undefined;
  if (kind === undefined) return "";
  const body = block[kind];
  if (typeof body !== "object" || body === null) return "";
  const rich = (body as Record<string, unknown>)["rich_text"];
  if (!Array.isArray(rich)) return "";
  return rich
    .map((span) => (typeof span === "object" && span !== null && typeof (span as Record<string, unknown>).plain_text === "string" ? ((span as Record<string, unknown>).plain_text as string) : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function notionBlockPhrases(blocks: readonly unknown[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (candidate: string): void => {
    const phrase = candidate.trim().replace(/\s+/g, " ");
    if (phrase.length < MIN_PHRASE_CHARS || phrase.length > MAX_PHRASE_CHARS) return;
    if (phrase.split(" ").filter((w) => w.length > 0).length < MIN_PHRASE_WORDS) return;
    const key = foldForQuote(phrase);
    if (key.length < MIN_PHRASE_CHARS || seen.has(key)) return;
    seen.add(key);
    out.push(phrase);
  };
  for (const block of blocks) {
    if (out.length >= MAX_PHRASES) break;
    const line = blockText(block);
    if (line.length === 0) continue;
    take(line);
    for (const sentence of line.split(/(?<=[.!?])\s+/)) take(sentence);
  }
  return out.slice(0, MAX_PHRASES);
}

export function quotedPagePhrase(reply: string, pin: NotionPagePin): string | undefined {
  const haystack = foldForQuote(reply);
  if (haystack.length === 0) return undefined;
  return pin.phrases.find((phrase) => {
    const needle = foldForQuote(phrase);
    return needle.length >= MIN_PHRASE_CHARS && haystack.includes(needle);
  });
}
