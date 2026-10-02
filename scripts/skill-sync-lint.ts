import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileIfChanged } from "./write-if-changed.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");

const SOURCE = "packages/create/template/claude/skills/quickstart-open-everywhere/SKILL.md";
const MIRROR = ".claude/skills/quickstart-open-everywhere/SKILL.md";

const source = readFileSync(join(root, SOURCE), "utf8");
const mirror = readFileSync(join(root, MIRROR), "utf8");

if (source === mirror) {
  console.log(`✓ skill-sync: ${MIRROR} matches ${SOURCE}`);
  process.exit(0);
}

if (write) {
  writeFileIfChanged(join(root, MIRROR), source);
  console.log(`✓ skill-sync: wrote ${MIRROR} from ${SOURCE}`);
  process.exit(0);
}

const sourceLines = source.split("\n");
const mirrorLines = mirror.split("\n");
const at = sourceLines.findIndex((line, i) => line !== mirrorLines[i]);
console.error(
  `✗ skill-sync: the two copies of the setup skill have drifted.\n` +
    `  source: ${SOURCE}\n` +
    `  mirror: ${MIRROR}\n` +
    (at < 0
      ? `  The mirror has ${mirrorLines.length - sourceLines.length} extra line(s) at the end.\n`
      : `  First difference at line ${at + 1}:\n    source: ${JSON.stringify(sourceLines[at] ?? "(absent)")}\n    mirror: ${JSON.stringify(mirrorLines[at] ?? "(absent)")}\n`) +
    "  Edit the SOURCE, then run `npx tsx scripts/skill-sync-lint.ts --write`.",
);
process.exit(1);
