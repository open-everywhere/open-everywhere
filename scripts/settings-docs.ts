import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { settingDocs, settingEnvNames } from "@open-everywhere/core/agent/settings/settings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const REFERENCE = "docs/deploy/configuration-reference.md";
const BEGIN = "<!-- BEGIN GENERATED: agent-settings (scripts/settings-docs.ts) -->";
const END = "<!-- END GENERATED: agent-settings -->";

const SCHEMA_MODULE = "packages/core/agent/settings/settings.ts";

function renderTable(): string {
  const rows = settingDocs().map((d) => {
    const env = d.env === undefined ? "— *(code-only)*" : `\`${d.env}\``;
    return `| \`${d.path}\` | \`${d.shipped}\` | ${env} | ${d.summary} |`;
  });
  return [
    BEGIN,
    "",
    "| Setting | Shipped default | Ops override | Meaning |",
    "|---|---|---|---|",
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

const owned = settingEnvNames();
const problems: string[] = [];

for (const name of owned) {
  if (!reference.includes(name)) {
    problems.push(
      `UNDOCUMENTED OVERRIDE: the settings schema declares \`${name}\` as an ops override, but ${REFERENCE} never mentions it. ` +
        `scripts/env-docs-lint.ts cannot catch this (the resolver reads the var through a schema field, not a literal ` +
        `process.env.${name}), so this gate is the only thing standing between an operator and an undocumented knob.`,
    );
  }
}

function filesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith("-test.ts")) out.push(p);
  }
  return out;
}

const runtimeFiles = ["agent", "packages"]
  .flatMap((r) => filesUnder(join(root, r)))
  .map((p) => relative(root, p).split("\\").join("/"))
  .filter((p) => p.split("/").includes("agent") && p !== SCHEMA_MODULE);

for (const rel of runtimeFiles) {
  const src = readFileSync(join(root, rel), "utf8");
  if (!src.includes("process.env")) continue;
  for (const name of owned) {
    const direct = new RegExp(`process\\.env\\s*(?:\\.${name}\\b|\\[\\s*["'\`]${name}["'\`]\\s*\\])`, "u");
    const viaConst = new RegExp(`process\\.env\\s*\\[[^\\]]*\\b${name}_ENV\\b`, "u");
    if (direct.test(src) || viaConst.test(src)) {
      problems.push(
        `SECOND PARSE SITE: ${rel} reads \`${name}\` directly, but that variable is owned by the behaviour-settings schema ` +
          `(${SCHEMA_MODULE}). A second reader grows a second vocabulary and a second default — exactly the drift OPE-371 ` +
          `removed. Read the resolved value through \`getSettings()\` instead.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ settings-docs: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

if (check) {
  if (updated !== reference) {
    console.error(
      `✗ settings-docs: the generated settings table in ${REFERENCE} is out of date with ` +
        `${SCHEMA_MODULE}.\n  Run: npx tsx scripts/settings-docs.ts`,
    );
    process.exit(1);
  }
  console.log(
    `✓ settings-docs: ${settingDocs().length} setting(s) in sync with ${REFERENCE}; ` +
      `${owned.length} declared ops override(s), all documented, no second parse site`,
  );
} else {
  writeFileSync(referencePath, updated);
  console.log(`✓ settings-docs: wrote ${settingDocs().length} setting(s) into ${REFERENCE}`);
}
