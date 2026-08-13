import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["agent", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "generated", ".git"]);

const WRAPPER = "packages/core/agent/lib/manual-compaction.ts";
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
      out.push(p);
    }
  }
  return out;
}

const CALL_PATTERN = /\.compact\s*\(/g;

const reds: string[] = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of tsFilesUnder(root)) {
    if (file === WRAPPER || file === SELF) continue;
    scanned++;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(CALL_PATTERN)) {
      const line = code.slice(0, m.index).split("\n").length;
      reds.push(
        `${file}:${line} calls \`.compact(\` directly. eve's compact() response does not prove ` +
          `compaction ran (OPE-449) — route this through compactSessionVerified() in ${WRAPPER} instead.`,
      );
    }
  }
}

if (reds.length > 0) {
  console.error(`✗ manual-compaction-guard: ${reds.length} raw \`.compact(\` call(s) outside the blessed wrapper:\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(`✓ manual-compaction-guard: 0 raw \`.compact(\` calls outside ${WRAPPER} (${scanned} files scanned)`);
