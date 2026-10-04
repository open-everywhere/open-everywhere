import { readFileSync, readdirSync, statSync } from "node:fs";
import { toPosixPath } from "./posix-path.js";
import { join } from "node:path";

const ROOTS = ["agent", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "generated", ".git"]);

const SELF = "scripts/manual-compaction-guard-lint.ts";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const stat = statSync(p);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...tsFilesUnder(p));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(toPosixPath(p));
    }
  }
  return out;
}

const CALL_PATTERN = /\.compact\s*\(/g;

const reds: string[] = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of tsFilesUnder(root)) {
    if (file === SELF) continue;
    scanned++;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(CALL_PATTERN)) {
      const line = code.slice(0, m.index).split("\n").length;
      reds.push(
        `${file}:${line} calls \`.compact(\` directly. eve's compact() response does not prove ` +
          `compaction ran (OPE-449), and OE supports no manual compaction — resurrect the verified ` +
          `wrapper (compactSessionVerified, deleted in OPE-688) from git history first, and keep it ` +
          `watch-and-log: never block or fail a turn on the compaction outcome.`,
      );
    }
  }
}

if (reds.length > 0) {
  console.error(`✗ manual-compaction-guard: ${reds.length} raw \`.compact(\` call(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(`✓ manual-compaction-guard: 0 raw \`.compact(\` calls (${scanned} files scanned)`);
