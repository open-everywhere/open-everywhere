import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileIfChanged } from "./write-if-changed.js";
import { settingDocs } from "@open-everywhere/core/agent/settings/settings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const REFERENCE = "docs/deploy/configuration-reference.md";
const BEGIN = "<!-- BEGIN GENERATED: agent-settings (scripts/settings-docs.ts) -->";
const END = "<!-- END GENERATED: agent-settings -->";

const SCHEMA_MODULE = "packages/core/agent/settings/settings.ts";

function renderTable(): string {
  const rows = settingDocs().map((d) => `| \`${d.path}\` | \`${d.shipped}\` | ${d.summary} |`);
  return [
    BEGIN,
    "",
    "| Setting | Shipped default | Meaning |",
    "|---|---|---|",
    ...rows,
    "",
    END,
  ].join("\n");
}

const referencePath = join(root, REFERENCE);
const reference = readFileSync(referencePath, "utf8");
const beginAt = reference.indexOf(BEGIN);
const endAt = reference.indexOf(END);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  console.error(
    `✗ settings-docs: ${REFERENCE} is missing the generated-section markers.\n` +
      `  Expected a block delimited by:\n    ${BEGIN}\n    ${END}\n` +
      `  Re-add them where the settings table should live — this script owns everything between them.`,
  );
  process.exit(1);
}
const updated = reference.slice(0, beginAt) + renderTable() + reference.slice(endAt + END.length);

if (check) {
  if (updated !== reference) {
    console.error(
      `✗ settings-docs: the generated settings table in ${REFERENCE} is out of date with ` +
        `${SCHEMA_MODULE}.\n  Run: npx tsx scripts/settings-docs.ts`,
    );
    process.exit(1);
  }
  console.log(`✓ settings-docs: ${settingDocs().length} setting(s) in sync with ${REFERENCE}`);
} else {
  const wrote = writeFileIfChanged(referencePath, updated);
  console.log(`✓ settings-docs: ${REFERENCE} ${wrote ? "updated" : "already current"} — ${settingDocs().length} setting(s)`);
}
