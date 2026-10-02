import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileIfChanged } from "./write-if-changed.js";
import { assertPackageDistFresh } from "./core-dist-freshness.js";
import { SETUP_STEPS } from "../packages/create/src/steps/index.js";
import type { SetupRoute, StepContext, StepGuide } from "../packages/create/src/engine.js";

assertPackageDistFresh("packages/core", "@open-everywhere/core");
assertPackageDistFresh("packages/providers/slack", "@open-everywhere/provider-slack");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const PAGE = "docs/deploy/setup-steps.md";
const BEGIN = "<!-- BEGIN GENERATED: setup-steps (scripts/setup-steps-docs.ts) -->";
const END = "<!-- END GENERATED: setup-steps -->";

function ctxFor(route: SetupRoute): StepContext {
  return { cwd: join(root, "docs"), env: {}, route };
}

function sameGuide(a: StepGuide, b: StepGuide): boolean {
  return a.summary === b.summary && a.instructions.length === b.instructions.length && a.instructions.every((line, i) => line === b.instructions[i]);
}

function renderInstruction(line: string): string[] {
  if (!line.includes("\n")) return [`- ${line}`];
  const fence = line.trimStart().startsWith("{") ? "```json" : "```";
  return ["", fence, line, "```", ""];
}

function renderGuide(guide: StepGuide): string[] {
  return [guide.summary, "", ...guide.instructions.flatMap(renderInstruction)];
}

function renderDockerDelta(vercel: StepGuide, docker: StepGuide): string[] {
  const newLines = docker.instructions.filter((line) => !vercel.instructions.includes(line));
  const summary = docker.summary === vercel.summary ? [] : [docker.summary, ""];
  return ["**Docker route.**", "", ...summary, ...newLines.flatMap(renderInstruction)];
}

function renderBlock(): string {
  const out: string[] = [BEGIN, ""];
  SETUP_STEPS.forEach((step, i) => {
    const vercel = step.guide(ctxFor("vercel"));
    const docker = step.guide(ctxFor("docker"));
    out.push(`### ${i + 1}. ${step.title}`, "", ...renderGuide(vercel));
    if (!sameGuide(vercel, docker)) out.push("", ...renderDockerDelta(vercel, docker));
    out.push("");
  });
  out.push(END);
  return out.join("\n").replace(/\n{3,}/gu, "\n\n");
}

const pagePath = join(root, PAGE);
const page = readFileSync(pagePath, "utf8");
const beginAt = page.indexOf(BEGIN);
const endAt = page.indexOf(END);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  console.error(`✗ setup-steps-docs: ${PAGE} is missing the generated-section markers.\n  Expected a block delimited by:\n    ${BEGIN}\n    ${END}`);
  process.exit(1);
}

const next = `${page.slice(0, beginAt)}${renderBlock()}${page.slice(endAt + END.length)}`;

if (check) {
  if (next !== page) {
    console.error(
      `✗ setup-steps-docs: ${PAGE} does not match the setup engine's step list.\n` +
        "  Run `npx tsx scripts/setup-steps-docs.ts` (or `npm run docs:generate`) and commit the result.",
    );
    process.exit(1);
  }
  console.log(`✓ setup-steps-docs: ${PAGE} matches the ${SETUP_STEPS.length} engine steps`);
} else {
  const written = writeFileIfChanged(pagePath, next);
  console.log(written ? `✓ setup-steps-docs: wrote ${PAGE} (${SETUP_STEPS.length} steps)` : `✓ setup-steps-docs: ${PAGE} already up to date`);
}
