import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CANONICAL_FILE = "docs/deploy/configuration-reference.md";
export const CANONICAL_HEADING = "Wake, seat, memory: three independent axes";

export interface BannedTerm {
  readonly pattern: RegExp;
  readonly say: string;
}

export const BANNED_TERMS: readonly BannedTerm[] = [
  { pattern: /\bbrains?\b/gi, say: `"memory" (or "memory silo"): "brain" made a reader take shared memory for one shared seat` },
  { pattern: /(?<![-\w])supervisor[-\s]+sessions?\b/gi, say: `"standing seat": the ambient supervisor is a wake rule, not a separate session` },
];

export interface RequiredLink {
  readonly file: string;
  readonly what: string;
  readonly start: RegExp;
  readonly end?: RegExp;
}

export const REQUIRED_LINKS: readonly RequiredLink[] = [
  { file: CANONICAL_FILE, what: "the `ambientSupervisor` row", start: /^\| `ambientSupervisor` \|/, end: /^(?!\| `ambientSupervisor` \|)/ },
  { file: CANONICAL_FILE, what: "the `match` row (the `org` pseudo-domain)", start: /^\| `match` \|/, end: /^(?!\| `match` \|)/ },
  { file: CANONICAL_FILE, what: "the `mode` row", start: /^\| `mode` \|/, end: /^(?!\| `mode` \|)/ },
  { file: "docs/capabilities/memory.md", what: "the `org` pseudo-domain bullet", start: /^- \*\*`org`\*\*/, end: /^- \*\*/ },
  { file: "docs/capabilities/proactivity-and-routines.md", what: "the untagged-ingestion paragraph", start: /Untagged channel ingestion is/, end: /^## / },
  { file: "docs/deploy/surfaces/github.md", what: "the ambient-mode section", start: /^### Ambient mode/, end: /^#{1,3} / },
  { file: "docs/deploy/surfaces/linear.md", what: "the ambient-mode section", start: /^## Ambient mode/, end: /^#{1,2} / },
  { file: "docs/deploy/surfaces/notion.md", what: "the on-by-default section", start: /^### On by default, off per \*\*domain\*\*/, end: /^#{1,3} / },
  { file: "docs/deploy/surfaces/slack.md", what: "the untagged-messages paragraph", start: /^\*\*Untagged channel messages\.\*\*/, end: /^1\. / },
  { file: "docs/glossary.md", what: "the **standing seat** entry", start: /^\*\*standing seat\*\*/, end: /^$/ },
];

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly say: string;
}

function stripCodeSpans(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
}

export function proseLines(markdown: string): Array<{ line: number; text: string; raw: string }> {
  const out: Array<{ line: number; text: string; raw: string }> = [];
  let fence: string | null = null;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (m) {
      if (fence === null && !(m[1]![0] === "`" && m[2]!.includes("`"))) {
        fence = m[1]!;
        continue;
      }
      if (fence !== null && m[1]![0] === fence[0] && m[1]!.length >= fence.length && m[2]!.trim() === "") {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    out.push({ line: i + 1, text: stripCodeSpans(raw), raw });
  }
  return out;
}

export function bannedTermHits(file: string, markdown: string): Hit[] {
  const out: Hit[] = [];
  const prose = proseLines(markdown);
  for (let i = 0; i < prose.length; i++) {
    const { line, text } = prose[i]!;
    const next = prose[i + 1]?.line === line + 1 ? prose[i + 1]!.text : "";
    const joined = `${text}\n${next}`;
    for (const term of BANNED_TERMS) {
      for (const m of joined.matchAll(term.pattern)) {
        if (m.index! < text.length) out.push({ file, line, text: m[0], say: term.say });
      }
    }
  }
  return out;
}

export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

export function headingSlugs(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const { raw } of proseLines(markdown)) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (m) out.add(githubSlug(m[1]!));
  }
  return out;
}

export function canonicalHref(file: string): string {
  const rel = posix.relative(posix.dirname(file), CANONICAL_FILE);
  return `${file === CANONICAL_FILE ? "" : rel}#${githubSlug(CANONICAL_HEADING)}`;
}

export function requiredLinkProblems(
  read: (file: string) => string | undefined,
  required: readonly RequiredLink[] = REQUIRED_LINKS,
): string[] {
  const problems: string[] = [];
  const canonical = read(CANONICAL_FILE);
  if (canonical === undefined || !headingSlugs(canonical).has(githubSlug(CANONICAL_HEADING))) {
    problems.push(`${CANONICAL_FILE}: the canonical heading "${CANONICAL_HEADING}" is gone`);
  }
  for (const req of required) {
    const text = read(req.file);
    if (text === undefined) {
      problems.push(`${req.file}: file is gone (${req.what})`);
      continue;
    }
    const lines = text.split("\n");
    const first = lines.findIndex((l) => req.start.test(l));
    if (first < 0) {
      problems.push(`${req.file}: cannot find ${req.what} — update REQUIRED_LINKS in scripts/seat-vocabulary-lint.ts if it moved`);
      continue;
    }
    let last = lines.length;
    if (req.end) {
      for (let i = first + 1; i < lines.length; i++) {
        if (req.end.test(lines[i]!)) {
          last = i;
          break;
        }
      }
    }
    const place = lines.slice(first, last).join("\n");
    if (!place.includes(`](${canonicalHref(req.file)})`)) {
      problems.push(`${req.file}:${first + 1}: ${req.what} does not link [${CANONICAL_HEADING}](${canonicalHref(req.file)})`);
    }
  }
  return problems;
}

function main(): void {
  const docs = execFileSync("git", ["ls-files", "-z", "--", "docs"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f.endsWith(".md") && !f.startsWith("docs/inventory/"));
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const hits = docs.flatMap((file) => bannedTermHits(file, read(file) ?? ""));
  const problems = requiredLinkProblems(read);
  if (hits.length > 0 || problems.length > 0) {
    for (const h of hits) console.error(`  ${h.file}:${h.line}: "${h.text}" — say ${h.say}`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(`lint:seat-vocabulary — ${hits.length} banned term(s), ${problems.length} link problem(s). See docs/glossary.md, entry **standing seat**.`);
    process.exit(1);
  }
  console.log(`lint:seat-vocabulary — ${docs.length} docs pages clean; ${REQUIRED_LINKS.length} places link "${CANONICAL_HEADING}".`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
