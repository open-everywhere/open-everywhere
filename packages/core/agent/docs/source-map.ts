const SURFACE_DOC_DIR = "docs/deploy/surfaces";

export const UNIVERSAL_SURFACE_DOCS: readonly string[] = ["support-matrix.md"];

export const MAX_SUMMARY_CHARS = 240;

export function docTitleOf(path: string, markdown: string): string {
  for (const line of markdown.split(/\r?\n/u)) {
    const m = /^#\s+(.+?)\s*$/u.exec(line);
    if (m) return m[1];
  }
  return path.split("/").pop() ?? path;
}

export function docSummaryOf(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (buf.length === 0) {
      if (t.length === 0 || t.startsWith("#") || t.startsWith(">") || t.startsWith("-") || t.startsWith("*") || t.startsWith("|")) continue;
      buf.push(t);
      continue;
    }
    if (t.length === 0) break;
    buf.push(t);
  }
  const flat = buf
    .join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (flat.length <= MAX_SUMMARY_CHARS) return flat;
  const cut = flat.slice(0, MAX_SUMMARY_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_SUMMARY_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function providerForDocPath(path: string, bundleIds: readonly string[]): string | undefined {
  const prefix = `${SURFACE_DOC_DIR}/`;
  if (!path.startsWith(prefix)) return undefined;
  const file = path.slice(prefix.length);
  if (file.includes("/")) return undefined;
  if (UNIVERSAL_SURFACE_DOCS.includes(file)) return undefined;
  const id = file.replace(/\.md$/u, "");
  return bundleIds.includes(id) ? id : undefined;
}

export function sectionForDocPath(path: string): string {
  const rest = path.startsWith("docs/") ? path.slice("docs/".length) : path;
  const slash = rest.indexOf("/");
  return slash === -1 ? "root" : rest.slice(0, slash);
}

export interface DocsSourceMapInput {
  readonly docPaths: readonly string[];
  readonly bundleIds: readonly string[];
}

export function checkDocsSourceMap(input: DocsSourceMapInput): readonly string[] {
  const problems: string[] = [];
  const prefix = `${SURFACE_DOC_DIR}/`;
  const surfaceFiles = input.docPaths.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));

  for (const id of input.bundleIds) {
    if (!surfaceFiles.includes(`${prefix}${id}.md`)) {
      problems.push(
        `provider bundle "packages/providers/${id}" has no ${prefix}${id}.md — every bundle ships its own setup runbook, and that runbook is what the agent serves to a deployment carrying the bundle. Write it, or drop the bundle.`,
      );
    }
  }
  for (const p of surfaceFiles) {
    const file = p.slice(prefix.length);
    if (UNIVERSAL_SURFACE_DOCS.includes(file)) continue;
    const id = file.replace(/\.md$/u, "");
    if (!input.bundleIds.includes(id)) {
      problems.push(
        `${p} names no provider bundle ("packages/providers/${id}" does not exist) — it would ship to EVERY deployment as a universal doc. Add the bundle, delete the doc, or declare the filename in UNIVERSAL_SURFACE_DOCS (agent/docs/source-map.ts) with the reason it belongs to no single provider.`,
      );
    }
  }
  return problems;
}
