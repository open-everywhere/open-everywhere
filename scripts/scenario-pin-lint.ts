import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { collectShaPins, type PinSite } from "./scenario-pin-lint-lib.js";

const ROOT = process.cwd();
const PACK_DIR = join("packages", "core", "scripts", "e2e");

const dirFlag = process.argv.indexOf("--dir");
const scanRel = dirFlag >= 0 && process.argv[dirFlag + 1] !== undefined ? process.argv[dirFlag + 1]! : PACK_DIR;
const scanDir = isAbsolute(scanRel) ? scanRel : join(ROOT, scanRel);

function tsFilesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...tsFilesUnder(join(dir, entry.name), join(prefix, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(join(prefix, entry.name));
    }
  }
  return out;
}

const files = tsFilesUnder(scanDir);

if (files.length === 0) {
  console.error(`✗ scenario pins: no .ts files under ${scanRel}/ — the gate is looking at the wrong tree.`);
  process.exit(1);
}

const sites: PinSite[] = [];
for (const f of files) sites.push(...collectShaPins(readFileSync(join(scanDir, f), "utf8"), join(scanRel, f)));

if (sites.length > 0) {
  console.error(`✗ scenario pins: ${sites.length} commit-sha pin(s) refused.`);
  for (const site of sites) console.error(`  - ${site.file}:${site.line} — ${site.sha.slice(0, 8)}`);
  console.error(
    "  A commit sha does not survive a rewrite of the history, and a fork or mirror shares no sha with this repository, " +
      "so a scenario gated on one skips forever there. Make the scenario unconditional, or gate it on a fact the " +
      "deployment itself reports (a route, a manifest entry, an audit row).",
  );
  process.exit(1);
}

console.log(`✓ scenario pins: none in ${scanRel}/ (${files.length} files scanned)`);
