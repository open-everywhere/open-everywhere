import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpgradingNotes } from "../packages/core/scripts/upgrade-notes.js";
import { listFiles, scaffoldPathFor } from "../packages/create/src/scaffold.js";
import { writeFileIfChanged } from "./write-if-changed.js";

export const TEMPLATE_PATHS_FILE = "packages/create/template-paths.txt";

const HEADER = [
  "# Every scaffolded path that the @open-everywhere/create template has held since the first release (OPE-2354).",
  "# The list only grows. `npx tsx scripts/template-paths.ts --write` adds the paths the template holds now.",
  "# A path that the template no longer holds must be named in `removedFiles` of a release entry in",
  "# packages/core/upgrading.json, so that `oe upgrade --plan` prints DELETE for an app that still has it.",
  "# `npm run lint:template-paths` checks both rules. `.gitattributes` merges this file by union.",
];

export function parseTemplatePaths(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function renderTemplatePaths(paths: Iterable<string>): string {
  return `${[...HEADER, ...[...new Set(paths)].sort()].join("\n")}\n`;
}

export function templatePathProblems(input: {
  readonly template: readonly string[];
  readonly recorded: readonly string[];
  readonly removedFiles: readonly string[];
}): string[] {
  const problems: string[] = [];
  const recorded = new Set(input.recorded);
  const template = new Set(input.template);
  const removed = new Set(input.removedFiles);
  const sorted = [...recorded].sort();
  if (recorded.size !== input.recorded.length) {
    problems.push(`${TEMPLATE_PATHS_FILE} lists a path more than once. Run \`npx tsx scripts/template-paths.ts --write\`.`);
  } else if (input.recorded.some((p, i) => p !== sorted[i])) {
    problems.push(`${TEMPLATE_PATHS_FILE} is not sorted. Run \`npx tsx scripts/template-paths.ts --write\`.`);
  }
  for (const path of [...template].sort()) {
    if (!recorded.has(path)) {
      problems.push(`the template holds ${path}, and ${TEMPLATE_PATHS_FILE} does not list it. Run \`npx tsx scripts/template-paths.ts --write\` and commit the record.`);
    }
  }
  for (const path of sorted) {
    if (!template.has(path) && !removed.has(path)) {
      problems.push(
        `the template no longer holds ${path}, and no release entry in packages/core/upgrading.json names it in \`removedFiles\`. ` +
          "Add it to `removedFiles` of the next release's entry, so that `oe upgrade --plan` tells an app that still has it to delete it.",
      );
    }
  }
  for (const path of [...removed].sort()) {
    if (!recorded.has(path)) {
      problems.push(`packages/core/upgrading.json names ${path} in \`removedFiles\`, and the template never held that path (${TEMPLATE_PATHS_FILE}). Correct the path.`);
    }
  }
  return problems;
}

export function readTemplatePathInputs(root: string): { template: string[]; recorded: string[]; removedFiles: string[]; problems: string[] } {
  const template = listFiles(join(root, "packages", "create", "template")).map(scaffoldPathFor);
  const recorded = parseTemplatePaths(readFileSync(join(root, ...TEMPLATE_PATHS_FILE.split("/")), "utf8"));
  const parsed = parseUpgradingNotes(JSON.parse(readFileSync(join(root, "packages", "core", "upgrading.json"), "utf8")));
  const removedFiles = (parsed.notes?.releases ?? []).flatMap((r) => r.removedFiles);
  return { template, recorded, removedFiles, problems: parsed.notes ? [] : [...parsed.problems] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const inputs = readTemplatePathInputs(root);
  if (process.argv.includes("--write")) {
    writeFileIfChanged(join(root, ...TEMPLATE_PATHS_FILE.split("/")), renderTemplatePaths([...inputs.recorded, ...inputs.template]));
    console.log(`✓ template-paths: wrote ${TEMPLATE_PATHS_FILE}`);
  } else {
    const problems = [...inputs.problems, ...templatePathProblems(inputs)];
    if (problems.length > 0) {
      console.error(`✗ lint:template-paths: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`✓ lint:template-paths: ${inputs.template.length} template path(s) recorded; every one of ${inputs.recorded.length - inputs.template.length} removed path(s) is named in a release's removedFiles.`);
  }
}
