import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface LinkTarget {
  readonly line: number;
  readonly target: string;
}

export interface DeadLink {
  readonly file: string;
  readonly line: number;
  readonly target: string;
}

export const SKIP: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: ".github/PULL_REQUEST_TEMPLATE.md",
    why: "GitHub copies this text into a pull request body, so its links resolve against the pull request page and not against the tree.",
  },
];

function isPathTarget(target: string): boolean {
  if (target === "" || target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return true;
}

function stripCodeSpans(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
}

export function linkTargets(markdown: string): LinkTarget[] {
  const out: LinkTarget[] = [];
  let fence: string | null = null;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const fenceMatch = /^\s*(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(raw);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? fenceMatch[3])!;
      const rest = fenceMatch[2] ?? fenceMatch[4] ?? "";
      if (fence === null) {
        fence = marker;
        continue;
      }
      if (marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === "") {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    const line = stripCodeSpans(raw);
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
      let target = m[1]!;
      if (target.startsWith("<")) target = target.slice(1, -1);
      if (isPathTarget(target)) out.push({ line: i + 1, target });
    }
    const ref = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (ref) {
      let target = ref[1]!;
      if (target.startsWith("<")) target = target.slice(1, -1);
      if (isPathTarget(target)) out.push({ line: i + 1, target });
    }
    for (const m of line.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const target = m[1] ?? m[2]!;
      if (isPathTarget(target)) out.push({ line: i + 1, target });
    }
  }
  return out;
}

export function trackedLookup(tracked: readonly string[]): (repoPath: string) => boolean {
  const known = new Set<string>();
  for (const file of tracked) {
    known.add(file);
    for (let dir = posix.dirname(file); dir !== "." && !known.has(dir); dir = posix.dirname(dir)) known.add(dir);
  }
  return (repoPath) => known.has(repoPath.replace(/\/+$/, ""));
}

export function resolveTarget(file: string, target: string): string {
  let path = target.replace(/[#?].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
  }
  if (path.startsWith("/")) return posix.normalize(path.slice(1));
  return posix.normalize(posix.join(posix.dirname(file), path));
}

export function deadLinks(
  files: ReadonlyArray<{ file: string; text: string }>,
  exists: (repoPath: string) => boolean,
): DeadLink[] {
  const out: DeadLink[] = [];
  for (const { file, text } of files) {
    for (const { line, target } of linkTargets(text)) {
      const path = resolveTarget(file, target);
      if (path === ".." || path.startsWith("../")) continue;
      if (path === "" || path === ".") continue;
      if (!exists(path)) out.push({ file, line, target });
    }
  }
  return out;
}

function main(): void {
  const all = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0 && existsSync(join(root, f)));
  const tracked = all.filter((f) => f.endsWith(".md"));
  const stale = SKIP.filter((s) => !tracked.includes(s.file));
  if (stale.length > 0) {
    console.error(`lint:doc-links — stale SKIP entries (no such tracked file): ${stale.map((s) => s.file).join(", ")}`);
    process.exit(1);
  }
  const skipped = new Set(SKIP.map((s) => s.file));
  const files = tracked.filter((f) => !skipped.has(f)).map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
  const dead = deadLinks(files, trackedLookup(all));
  if (dead.length > 0) {
    console.error(`lint:doc-links — ${dead.length} dead relative link(s):`);
    for (const d of dead) console.error(`  ${d.file}:${d.line} → ${d.target}`);
    console.error("Fix the path, or drop the link and keep the text. A new file must be tracked (`git add` it) before a link to it resolves.");
    process.exit(1);
  }
  console.log(`lint:doc-links — ${files.length} Markdown files, every relative link resolves.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
