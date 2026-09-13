import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileIfChanged } from "./write-if-changed.js";

export const PUBLISHABLE_PACKAGES = [
  "packages/core",
  "packages/adapters",
  "packages/providers/discord",
  "packages/providers/github",
  "packages/providers/linear",
  "packages/providers/notion",
  "packages/providers/slack",
  "packages/providers/teams",
] as const;

export const PUBLISHABLE_BIN_PACKAGES = ["packages/create"] as const;

export const ALL_PUBLISHABLE_PACKAGES = [...PUBLISHABLE_PACKAGES, ...PUBLISHABLE_BIN_PACKAGES] as const;

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".internal.ts")) out.push(full);
  }
  return out;
}

export function exportsMapFor(pkgDir: string): Record<string, unknown> {
  const agentDir = join(pkgDir, "agent");
  const files = walkTs(agentDir).map((f) => relative(pkgDir, f).split("\\").join("/"));
  const map: Record<string, unknown> = { "./package.json": "./package.json" };
  for (const rel of files) {
    const stem = rel.replace(/\.ts$/, "");
    map[`./${stem}.js`] = { types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` };
  }
  return map;
}

function main(): void {
  const check = process.argv.includes("--check");
  const drifted: string[] = [];
  for (const pkgDir of PUBLISHABLE_PACKAGES) {
    const manifestPath = join(pkgDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const expected = exportsMapFor(pkgDir);
    if (check) {
      if (JSON.stringify(manifest.exports) !== JSON.stringify(expected)) drifted.push(pkgDir);
      continue;
    }
    manifest.exports = expected;
    const wrote = writeFileIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`✓ ${manifestPath}: ${Object.keys(expected).length - 1} subpath(s)${wrote ? "" : " (already current)"}`);
  }
  if (check) {
    if (drifted.length > 0) {
      console.error(`✗ exports map is stale in:\n${drifted.map((d) => `  - ${d}`).join("\n")}`);
      console.error(`  Regenerate: npx tsx scripts/publish-exports-generate.ts`);
      process.exit(1);
    }
    console.log(`✓ exports maps match sources in all ${PUBLISHABLE_PACKAGES.length} publishable packages.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
