import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const listOnly = process.argv.includes("--list");

type Needle = { name: string; bytes: number[] };

function utf8BytesOfCodePoint(codePoint: number): number[] {
  return Array.from(Buffer.from(String.fromCharCode(codePoint), "utf8"));
}

const NEEDLES: Needle[] = [
  { name: "NUL (code point 0)", bytes: [0x00] },
  { name: "LINE SEPARATOR (code point 0x2028)", bytes: utf8BytesOfCodePoint(0x2028) },
  { name: "PARAGRAPH SEPARATOR (code point 0x2029)", bytes: utf8BytesOfCodePoint(0x2029) },
];

function gitTrackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--", "*.ts", "*.md"], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function findOccurrences(buf: Buffer, needle: Needle): number[] {
  const offsets: number[] = [];
  let from = 0;
  const nb = Buffer.from(needle.bytes);
  for (;;) {
    const idx = buf.indexOf(nb, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + 1;
  }
  return offsets;
}

const files = gitTrackedFiles();
if (files.length === 0) {
  console.error("FAIL invisible-bytes-lint: `git ls-files -- *.ts *.md` returned nothing -- refusing to report clean against an unread tree");
  process.exit(1);
}

if (listOnly) {
  for (const f of files) console.log(f);
  console.log(`\n${files.length} git-tracked .ts/.md file(s) scanned.`);
  process.exit(0);
}

type Hit = { file: string; offset: number; needle: string; context: string };
const hits: Hit[] = [];

for (const rel of files) {
  const full = join(root, rel);
  let buf: Buffer;
  try {
    buf = readFileSync(full);
  } catch {
    continue;
  }
  for (const needle of NEEDLES) {
    for (const offset of findOccurrences(buf, needle)) {
      const start = Math.max(0, offset - 30);
      const end = Math.min(buf.length, offset + needle.bytes.length + 30);
      const context = buf
        .slice(start, end)
        .toString("latin1")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .replace(/\n/g, "\\n");
      hits.push({ file: rel, offset, needle: needle.name, context });
    }
  }
}

if (hits.length > 0) {
  console.error(`FAIL invisible-bytes-lint: ${hits.length} invisible-byte occurrence(s) across ${files.length} scanned file(s):`);
  for (const h of hits) {
    console.error(`  - ${h.file}:${h.offset} [${h.needle}]  ...${h.context}...`);
  }
  console.error(
    "\n  Why this is a hard error: rg binary-classifies any file containing a raw NUL and silently\n" +
      "  returns no matches for it -- a NUL-bearing file is invisible to every rg-based search and\n" +
      "  lint in this repo (OPE-337 pt1 found and fixed ten files this way). LINE SEPARATOR and\n" +
      "  PARAGRAPH SEPARATOR bytes are invisible in diffs and break naive line-based tooling the\n" +
      "  same way. If a byte needs to be in the file, spell it as its JS escape sequence inside a\n" +
      "  string/template literal instead of a raw byte.",
  );
  process.exit(1);
}

const trackedAndIgnored = execFileSync("git", ["ls-files", "-ci", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

if (trackedAndIgnored.length > 0) {
  console.error(`FAIL invisible-bytes-lint: ${trackedAndIgnored.length} tracked path(s) are also gitignored:`);
  for (const path of trackedAndIgnored) console.error(`  - ${path}`);
  console.error(
    "\n  Why this is a hard error: a .gitignore entry does not untrack a blob git already has, so the\n" +
      "  ignore reads as protection while the file keeps riding every commit (OPE-1364 -- the ruling on\n" +
      "  .oe-run-note.md was inert for exactly this reason). Fix it with `git rm --cached <path>` and\n" +
      "  commit that; do NOT relax the .gitignore entry to make this lint green.",
  );
  process.exit(1);
}

const RUN_NOTE = ".oe-run-note.md";
const trackedRunNote = execFileSync("git", ["ls-files", "--", RUN_NOTE], { cwd: root, encoding: "utf8" }).trim();
if (trackedRunNote.length > 0) {
  console.error(
    `FAIL invisible-bytes-lint: ${RUN_NOTE} is tracked.\n\n` +
      "  It is a per-run scratch channel, never product (OPE-1327, OPE-1364). Tracked, it conflicts\n" +
      "  between every pair of runs that write a note. Fix it with `git rm --cached .oe-run-note.md`\n" +
      "  and keep the .gitignore entry; do NOT delete the .gitignore entry to get past this.",
  );
  process.exit(1);
}

const trackedCount = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l.trim().length > 0).length;
if (trackedCount === 0) {
  console.error(`FAIL invisible-bytes-lint: \`git ls-files\` reported an EMPTY tracked tree for ${root}. The tree checks above cannot be trusted.`);
  process.exit(1);
}

console.log(
  `OK invisible-bytes-lint: no raw NUL / LINE SEPARATOR / PARAGRAPH SEPARATOR bytes found across ${files.length} git-tracked .ts/.md file(s); ` +
    `no tracked path is gitignored, and ${RUN_NOTE} is untracked, across ${trackedCount} tracked path(s).`,
);
