import { admitProviderRegistration, isProviderSelected } from "../access/provider-selection.js";

export interface DocEntry {
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
}

export interface RegisteredDoc extends DocEntry {
  readonly provider?: string;
}

const UNIVERSAL = new Map<string, RegisteredDoc>();
const BY_PROVIDER = new Map<string, Map<string, RegisteredDoc>>();

export function registerDocs(entries: readonly DocEntry[]): void {
  for (const e of entries) UNIVERSAL.set(e.path, { ...e });
}

export function registerProviderDocs(provider: string, entries: readonly DocEntry[]): void {
  if (!admitProviderRegistration(provider, "docs")) return;
  let bucket = BY_PROVIDER.get(provider);
  if (bucket === undefined) {
    bucket = new Map<string, RegisteredDoc>();
    BY_PROVIDER.set(provider, bucket);
  }
  for (const e of entries) bucket.set(e.path, { ...e, provider });
}

export function clearDocs(): void {
  UNIVERSAL.clear();
  BY_PROVIDER.clear();
}

export function visibleDocs(): readonly RegisteredDoc[] {
  const out: RegisteredDoc[] = [...UNIVERSAL.values()];
  for (const [provider, bucket] of BY_PROVIDER) {
    if (!isProviderSelected(provider)) continue;
    out.push(...bucket.values());
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function docIndex(): readonly { path: string; title: string; summary: string }[] {
  return visibleDocs().map((d) => ({ path: d.path, title: d.title, summary: d.summary }));
}

export function normalizeDocPath(input: string): string | null {
  const cleaned = input.trim().replace(/\\/gu, "/").replace(/^\/+/u, "");
  const stripped = cleaned.replace(/^(?:\.{1,2}\/)+/u, "");
  if (stripped.length === 0) return null;
  if (stripped.split("/").includes("..")) return null;
  return stripped.startsWith("docs/") ? stripped : `docs/${stripped}`;
}

export interface DocRefusal {
  readonly ok: false;
  readonly message: string;
}

export type DocLookup = { readonly ok: true; readonly doc: RegisteredDoc } | DocRefusal;

export function readDoc(requested: string): DocLookup {
  const path = normalizeDocPath(requested);
  const docs = visibleDocs();
  if (path === null) {
    return { ok: false, message: `"${requested}" isn't a usable doc path. Call read_docs with no path to list the manual this deployment ships.` };
  }
  const exact = docs.find((d) => d.path === path);
  if (exact) return { ok: true, doc: exact };

  const needle = path.startsWith("docs/") ? path.slice("docs/".length) : path;
  const candidates = docs.filter((d) => d.path === `docs/${needle}` || d.path.endsWith(`/${needle}`));
  if (candidates.length === 1) return { ok: true, doc: candidates[0] };
  if (candidates.length > 1) {
    return {
      ok: false,
      message: `"${requested}" matches ${candidates.length} docs — ask for one of: ${candidates.map((d) => d.path).join(", ")}.`,
    };
  }
  return {
    ok: false,
    message:
      `This deployment's manual has no "${path}". It ships ${docs.length} docs — call read_docs with no path to list them. ` +
      `Say the doc isn't part of this deployment's documentation rather than guessing at its contents.`,
  };
}
