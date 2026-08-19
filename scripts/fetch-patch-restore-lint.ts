import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PATCH = /globalThis\.fetch\s*=(?!=)/;
const DIRS = ["packages/core/scripts", "scripts", ...readdirSync(join(ROOT, "packages/providers")).map((p) => `packages/providers/${p}/scripts`)];

function tsFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );
  } catch {
    return [];
  }
  return entries;
}

const bad: string[] = [];
for (const dir of DIRS) {
  for (const f of tsFiles(join(ROOT, dir))) {
    if (f.endsWith("_fetch-test-utils.ts")) continue;
    const src = readFileSync(f, "utf8");
    if (PATCH.test(src) && !/finally/.test(src)) bad.push(f.slice(ROOT.length + 1));
  }
}

if (bad.length > 0) {
  console.error(
    `✗ lint:fetch-patch-restore: ${bad.length} file(s) reassign globalThis.fetch with NO "finally" anywhere — restore it in a ` +
      `try/finally, or wrap the patched code in withPatchedFetch (packages/core/scripts/_fetch-test-utils.ts, or the ` +
      `provider-local copy):\n${bad.map((f) => `  - ${f}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("✓ lint:fetch-patch-restore: every globalThis.fetch reassignment guards its restore with a finally");
