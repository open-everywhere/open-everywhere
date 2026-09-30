import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCompiledDoc } from "@open-everywhere/core/agent/docs/source-map.js";

export const AUDIT_PATH = "/control/v1/audit?";

export function auditQueries(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(AUDIT_PATH, from);
    if (at === -1) return out;
    const start = at + AUDIT_PATH.length;
    const rest = text.slice(start);
    const folded = rest.replace(/<[^<>\n]*>/gu, (m) => "_".repeat(m.length));
    const end = folded.search(/[\s`'"()[\]<>]/u);
    out.push(rest.slice(0, end === -1 ? rest.length : end));
    from = start;
  }
}

export interface AuditQueryDefect {
  readonly file: string;
  readonly query: string;
  readonly problem: string;
}

export function findAuditQueryDefects(files: ReadonlyMap<string, string>): AuditQueryDefect[] {
  const defects: AuditQueryDefect[] = [];
  for (const [file, text] of files) {
    for (const query of auditQueries(text)) {
      const params = query.split("&").map((p) => p.split("=")[0]!.trim());
      if (params.includes("action")) {
        defects.push({
          file,
          query,
          problem: 'the route reads `actions` (a comma-separated list), never `action` — a request with `action=` is answered UNFILTERED, so the row the reader wants can sit behind the page limit. Write `actions=<name>`.',
        });
      }
      if (!params.includes("since")) {
        defects.push({
          file,
          query,
          problem: "the route REQUIRES `since` and answers 400 without it. Write `since=<iso>` as the first parameter.",
        });
      }
    }
  }
  return defects;
}

export function docFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(join(root, "docs"));
  return out.filter(isCompiledDoc);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = new Map<string, string>();
  for (const f of docFiles(root)) files.set(f, readFileSync(join(root, f), "utf8"));
  const defects = findAuditQueryDefects(files);
  if (defects.length > 0) {
    console.error(
      `✗ audit-query-docs-lint: ${defects.length} unrunnable audit query/queries:\n` +
        defects.map((d) => `  - ${d.file}: \`?${d.query}\` — ${d.problem}`).join("\n"),
    );
    process.exit(1);
  }
  const queries = [...files.values()].reduce((n, text) => n + auditQueries(text).length, 0);
  console.log(`✓ audit-query-docs-lint: ${queries} audit-read query/queries across ${files.size} document(s) name \`since\` and spell the filter \`actions\`.`);
}
