import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const TEMPLATE_VERSION_PLACEHOLDER = "{{OE_VERSION}}";
export const TEMPLATE_NAME_PLACEHOLDER = "{{APP_NAME}}";

export const TEMPLATE_RENAMED_ON_COPY: Readonly<Record<string, string>> = { gitignore: ".gitignore", "claude/": ".claude/" };

export function scaffoldedPathOf(rel: string): string {
  const exact = TEMPLATE_RENAMED_ON_COPY[rel];
  if (exact !== undefined) return exact;
  for (const [from, to] of Object.entries(TEMPLATE_RENAMED_ON_COPY)) {
    if (from.endsWith("/") && rel.startsWith(from)) return to + rel.slice(from.length);
  }
  return rel;
}

export type TemplateFileKind = "owned" | "config" | "managed";

const CONFIG_PREFIXES: readonly string[] = [
  "agent/access/",
  "agent/blob/",
  "agent/identity/",
  "agent/instructions/",
  "agent/memory/",
  "agent/model/",
  "agent/plugins/",
  "agent/roles/",
  "agent/routines/",
  "agent/sandbox/workspace/",
  "agent/settings/",
  "agent/spend/",
  "agent/webhooks/",
];
const CONFIG_FILES: ReadonlySet<string> = new Set(["roster.config.ts", "agent/instructions.md", ".gitignore"]);
const MANAGED_FILES: ReadonlySet<string> = new Set(["package.json", "roster.lock.json"]);

export function templateFileKind(path: string): TemplateFileKind {
  if (MANAGED_FILES.has(path) || path.endsWith(".generated.ts") || path.startsWith("agent/plugins/generated/")) return "managed";
  if (CONFIG_FILES.has(path) || CONFIG_PREFIXES.some((p) => path.startsWith(p))) return "config";
  return "owned";
}

export interface DriftEntry {
  readonly path: string;
  readonly kind: Exclude<TemplateFileKind, "managed">;
  readonly state: "missing" | "differs";
  readonly summary: string;
  readonly templatePath: string;
}

export interface DriftReport {
  readonly entries: readonly DriftEntry[];
  readonly compared: number;
}

function listFiles(root: string, at = root): string[] {
  return readdirSync(at).flatMap((name) => {
    const p = join(at, name);
    return statSync(p).isDirectory() ? listFiles(root, p) : [relative(root, p).split("\\").join("/")];
  });
}

function normalise(text: string): string {
  return text.replace(/\r\n/gu, "\n");
}

export function lineDiffSummary(appText: string, templateText: string): string {
  const a = normalise(appText).split("\n");
  const b = normalise(templateText).split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const common = commonLineCount(midA, midB);
  const added = midB.length - common;
  const removed = midA.length - common;
  return `the template adds ${added} and drops ${removed} line(s), first at line ${start + 1}`;
}

function commonLineCount(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const c = counts.get(line) ?? 0;
      if (c > 0) {
        common++;
        counts.set(line, c - 1);
      }
    }
    return common;
  }
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

export function templateDrift(options: { readonly appRoot: string; readonly templateDir: string; readonly version: string; readonly appName: string }): DriftReport {
  const entries: DriftEntry[] = [];
  let compared = 0;
  for (const rel of listFiles(options.templateDir).sort()) {
    const path = scaffoldedPathOf(rel);
    const kind = templateFileKind(path);
    if (kind === "managed") continue;
    compared++;
    const templatePath = join(options.templateDir, ...rel.split("/"));
    const appPath = join(options.appRoot, ...path.split("/"));
    if (!existsSync(appPath)) {
      entries.push({ path, kind, state: "missing", summary: "the template has it, the app does not", templatePath });
      continue;
    }
    let expected: string;
    let actual: string;
    try {
      expected = readFileSync(templatePath, "utf8")
        .split(TEMPLATE_VERSION_PLACEHOLDER)
        .join(options.version)
        .split(TEMPLATE_NAME_PLACEHOLDER)
        .join(options.appName);
      actual = readFileSync(appPath, "utf8");
    } catch (err) {
      throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (normalise(actual) === normalise(expected)) continue;
    entries.push({ path, kind, state: "differs", summary: lineDiffSummary(actual, expected), templatePath });
  }
  entries.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "owned" ? -1 : 1));
  return { entries, compared };
}

export function renderDriftReport(report: DriftReport, version: string, templateDir: string): readonly string[] {
  const owned = report.entries.filter((e) => e.kind === "owned");
  const config = report.entries.filter((e) => e.kind === "config");
  const lines: string[] = [`Template drift (against ${version}'s @open-everywhere/create template, ${report.compared} files compared):`];
  if (report.entries.length === 0) {
    lines.push(`  every scaffolded file matches ${version}'s template.`);
    return lines;
  }
  for (const e of owned) lines.push(`  SYNC      ${e.path} — ${e.summary}`);
  for (const e of config) lines.push(`  config    ${e.path} — ${e.summary} (your own config: merge by hand only if you want the template's change)`);
  if (owned.length > 0) {
    lines.push(`  ${owned.length} template-owned file(s) differ from ${version}'s template. A stale copy can typecheck and build and still be wrong at runtime.`);
    lines.push(`  oe upgrade never overwrites an app file: read each diff against ${templateDir}, then copy the template's file over yours.`);
  }
  return lines;
}
