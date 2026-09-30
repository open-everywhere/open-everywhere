import { flushTelemetry } from "@open-everywhere/core/agent/observability/telemetry.js";
import { checkAll, runWizard, type StepContext, type WizardIO } from "./engine.js";
import { WIZARD_STEPS } from "./steps/index.js";
import { createRealIO, closeRealIO } from "./io.js";
import { maybeEmitWizardCompleted } from "./telemetry.js";
import { WIZARD_VERSION } from "./version.js";
import { scaffoldApp, ScaffoldRefusal } from "./scaffold.js";
import { pathToFileURL } from "node:url";

const USAGE = `create-open-everywhere [<dir>] [--skip-wizard] [--check [--json]] [--version] [--help]

  <dir>          Scaffold the quickstart app into <dir> (a new or empty
                 directory). On a terminal, then run the interactive wizard
                 from inside it. Without a terminal (a coding agent's shell),
                 print the next steps and exit 0: it never waits on a prompt.
  --skip-wizard  With <dir>: scaffold only, even on a terminal.
  (no <dir>)     Interactive setup wizard in the current directory — walks
                 prerequisites, repo, tool roster, Vercel, database, Slack, env
                 checklist, telemetry disclosure, build, and final verification.
                 Resumable — re-run any time; already-satisfied steps are skipped.
  --check        Non-interactive status report of the current directory only. No
                 prompts, no changes, no telemetry. Exit code 0 if every step is
                 satisfied, else 1. It never scaffolds.
  --json         With --check: print the report as one JSON object.
  --version      Print the wizard's own version.
  --help         Print this message.
`;

function buildContext(cwd: string = process.cwd()): StepContext {
  return { cwd, env: process.env };
}

async function runCheckMode(json: boolean): Promise<number> {
  const summary = await checkAll(WIZARD_STEPS, buildContext());
  if (json) {
    const report = {
      version: WIZARD_VERSION,
      cwd: process.cwd(),
      satisfiedCount: summary.satisfiedCount,
      total: summary.total,
      allSatisfied: summary.allSatisfied,
      steps: summary.results.map((r) => ({ id: r.step.id, title: r.step.title, satisfied: r.check.satisfied, detail: r.check.detail })),
    };
    console.log(JSON.stringify(report, null, 2));
    return summary.allSatisfied ? 0 : 1;
  }
  for (const r of summary.results) {
    console.log(`${r.check.satisfied ? "✓" : "✗"} ${r.step.title}: ${r.check.detail}`);
  }
  console.log(`\n${summary.satisfiedCount}/${summary.total} steps satisfied.`);
  return summary.allSatisfied ? 0 : 1;
}

async function runInteractiveMode(cwd?: string, createIO: () => WizardIO = createRealIO): Promise<number> {
  const ctx = buildContext(cwd);
  const io = createIO();
  try {
    const summary = await runWizard(WIZARD_STEPS, ctx, io);
    io.print("");
    io.print(`${summary.satisfiedCount}/${summary.total} steps satisfied.`);
    await maybeEmitWizardCompleted(ctx.cwd, summary.satisfiedCount);
    await flushTelemetry();
    return summary.allSatisfied ? 0 : 1;
  } finally {
    closeRealIO();
  }
}

function positionals(argv: readonly string[]): string[] {
  return argv.filter((a) => !a.startsWith("-"));
}

function runScaffold(target: string): string | undefined {
  try {
    const result = scaffoldApp({ targetDir: target, version: WIZARD_VERSION });
    console.log(`Scaffolded the Open Everywhere quickstart app (${result.files.length} files, version ${WIZARD_VERSION}) into ${result.dir}`);
    return result.dir;
  } catch (err) {
    if (err instanceof ScaffoldRefusal) {
      console.error(err.message);
      return undefined;
    }
    throw err;
  }
}

function nextSteps(target: string, why: string): string {
  return [
    `The wizard did not run (${why}). Next, from the new app:`,
    `  cd ${target}`,
    "  npm install                                   # its postinstall applies the eve patch",
    "  npx create-open-everywhere --check --json     # setup status, as data",
    "  npx create-open-everywhere                    # the interactive wizard (needs a terminal)",
    "The app's README.md carries the numbered steps. A coding agent opened in the app reads AGENTS.md.",
  ].join("\n");
}

export interface MainOptions {
  readonly isTTY?: boolean;
  readonly createIO?: () => WizardIO;
}

export async function main(argv: readonly string[], options: MainOptions = { isTTY: process.stdin.isTTY === true }): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(WIZARD_VERSION);
    return 0;
  }
  const dirs = positionals(argv);
  if (dirs.length > 1) {
    console.error(`create-open-everywhere takes at most one directory, got ${dirs.length}: ${dirs.join(" ")}`);
    return 2;
  }
  const target = dirs[0];
  if (target === undefined) {
    if (argv.includes("--skip-wizard")) {
      console.error("--skip-wizard needs a <dir> to scaffold into");
      return 2;
    }
    if (argv.includes("--check")) return runCheckMode(argv.includes("--json"));
    return runInteractiveMode();
  }
  if (argv.includes("--check")) {
    console.error("--check changes nothing, so it cannot scaffold. Scaffold first, then run --check from inside the app.");
    return 2;
  }
  const dir = runScaffold(target);
  if (dir === undefined) return 1;
  if (argv.includes("--skip-wizard") || !options.isTTY) {
    console.log(nextSteps(target, argv.includes("--skip-wizard") ? "--skip-wizard" : "no terminal"));
    return 0;
  }
  return runInteractiveMode(dir, options.createIO);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : err);
      process.exit(1);
    },
  );
}
