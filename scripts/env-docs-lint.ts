import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CODE_ROOTS = ["agent", "packages"];
const DOC_ROOTS = ["docs"];
const DOC_FILES = [".env.example", ".env.e2e.example"];

const GRANDFATHERED = new Set<string>([]);

const listMode = process.argv.includes("--list");

function filesUnder(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) filesUnder(p, accept, out);
    else if (accept(entry)) out.push(p);
  }
  return out;
}

const codeFiles = CODE_ROOTS.flatMap((root) =>
  filesUnder(root, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith("-test.ts")),
).filter((p) => p.split("/").includes("agent"));

const reads = new Map<string, string[]>();
for (const file of codeFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (!reads.has(m[1])) reads.set(m[1], []);
    const where = reads.get(m[1]);
    if (where && !where.includes(file)) where.push(file);
  }
}

const documentation = [
  ...DOC_ROOTS.flatMap((root) => filesUnder(root, (name) => name.endsWith(".md"))),
  ...DOC_FILES,
]
  .map((p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

const documented = (name: string): boolean => documentation.includes(name);

const reds: string[] = [];
let documentedCount = 0;

for (const [name, where] of [...reads].sort((a, b) => a[0].localeCompare(b[0]))) {
  const isDocumented = documented(name);
  if (isDocumented) documentedCount++;
  if (listMode) {
    const status = isDocumented ? "documented" : GRANDFATHERED.has(name) ? "GRANDFATHERED" : "UNDOCUMENTED";
    console.log(`  ${status.padEnd(14)} ${name}  (${where.length} file(s), e.g. ${where[0]})`);
  }
  if (!isDocumented && !GRANDFATHERED.has(name)) {
    reds.push(
      `UNDOCUMENTED ENV: the runtime reads process.env.${name} (${where[0]}${where.length > 1 ? ` +${where.length - 1} more` : ""}) ` +
        `but no page under docs/ and neither .env.example nor .env.e2e.example mentions it. An operator cannot set what ` +
        `isn't written down, so this lands as a runtime surprise on a deployed agent. Document it (.env.example + ` +
        `docs/deploy/configuration-reference.md), or — if it is deliberately internal — add it to GRANDFATHERED in ` +
        `scripts/env-docs-lint.ts WITH a reason.`,
    );
  }
}

for (const name of GRANDFATHERED) {
  if (!reads.has(name)) {
    reds.push(
      `STALE GRANDFATHER: ${name} is listed in scripts/env-docs-lint.ts but nothing in the runtime reads it any more — ` +
        `delete the entry.`,
    );
    continue;
  }
  if (documented(name)) {
    reds.push(
      `GRANDFATHER CLEARED: ${name} is now documented — delete it from GRANDFATHERED in scripts/env-docs-lint.ts so the ` +
        `list keeps shrinking.`,
    );
  }
}

if (reds.length > 0) {
  console.error(`✗ env-docs: ${reds.length} problem(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ env-docs: ${reads.size} env name(s) read by the runtime — ${documentedCount} documented, ` +
    `${GRANDFATHERED.size} grandfathered (frozen 2026-08-10, must only shrink), 0 new gaps`,
);
