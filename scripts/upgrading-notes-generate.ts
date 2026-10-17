import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTES_FILE, PAGE_FILE, noteFor, parseUpgradingNotes, renderUpgradingMarkdown } from "../packages/core/scripts/upgrade-notes.js";
import { unknownCodemods } from "../packages/core/scripts/upgrade-codemods.js";
import { writeFileIfChanged } from "./write-if-changed.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages", "core");
const check = process.argv.slice(2).includes("--check");
const problems: string[] = [];
function fail(): never {
  console.error(`✗ lint:upgrading-notes: ${problems.length} problem(s).`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  console.error("  Fix packages/core/upgrading.json, then run `npx tsx scripts/upgrading-notes-generate.ts`.");
  process.exit(1);
}

const notesPath = join(CORE, NOTES_FILE);
if (!existsSync(notesPath)) {
  problems.push(`packages/core/${NOTES_FILE} does not exist — the release record is what \`oe upgrade\` reads.`);
  fail();
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(notesPath, "utf8"));
} catch (err) {
  problems.push(`packages/core/${NOTES_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  fail();
}

const parsed = parseUpgradingNotes(raw);
if (parsed.notes === undefined) {
  problems.push(...parsed.problems);
  fail();
}
const notes = parsed.notes;

const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as {
  version: string;
  files?: string[];
  peerDependencies?: Record<string, string>;
};

const current = noteFor(notes, pkg.version);
if (current === undefined) {
  problems.push(
    `@open-everywhere/core is at ${pkg.version} and packages/core/${NOTES_FILE} has no entry for it. ` +
      `Add one — \`oe upgrade\` reads this record to tell an operator what the release needs.`,
  );
} else if (current.evePeer !== pkg.peerDependencies?.eve) {
  problems.push(
    `the ${pkg.version} entry says eve "${current.evePeer}" and packages/core/package.json declares ` +
      `"${pkg.peerDependencies?.eve ?? "(none)"}". This gate holds the two equal, and \`oe upgrade\` pins the declared one.`,
  );
}

for (const file of [NOTES_FILE, PAGE_FILE]) {
  if (!(pkg.files ?? []).includes(file)) {
    problems.push(`packages/core/package.json \`files\` does not list ${file}, so npm would not pack it and no consumer could read the notes.`);
  }
}

const unknown = unknownCodemods(notes.releases);
if (unknown.length > 0) {
  problems.push(`the notes name ${unknown.length} codemod(s) the registry does not hold: ${unknown.join(", ")}. Add them to packages/core/scripts/upgrade-codemods.ts.`);
}

if (problems.length > 0) fail();

const pagePath = join(CORE, PAGE_FILE);
const rendered = renderUpgradingMarkdown(notes, pkg.version);
if (check) {
  const onDisk = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : undefined;
  if (onDisk !== rendered) {
    problems.push(
      onDisk === undefined
        ? `packages/core/${PAGE_FILE} does not exist.`
        : `packages/core/${PAGE_FILE} is not the rendering of ${NOTES_FILE} — it was hand-edited, or the record changed without a regenerate.`,
    );
    fail();
  }
  console.log(`✓ lint:upgrading-notes: ${notes.releases.length} release record(s), current ${pkg.version} present, ${PAGE_FILE} matches.`);
} else {
  const wrote = writeFileIfChanged(pagePath, rendered);
  console.log(`${wrote ? "✓ wrote" : "· unchanged"} packages/core/${PAGE_FILE} (${notes.releases.length} release record(s)).`);
}
