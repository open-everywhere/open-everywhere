import { flushTelemetry } from "@open-everywhere/core/agent/observability/telemetry.js";
import { checkAll, runWizard, type StepContext, type WizardIO } from "./engine.js";
import { WIZARD_STEPS } from "./steps/index.js";
import { createRealIO, closeRealIO } from "./io.js";
import { declineTelemetry, maybeEmitWizardCompleted } from "./telemetry.js";
import { WIZARD_VERSION } from "./version.js";
import { initGitRepo, scaffoldApp, ScaffoldRefusal } from "./scaffold.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { slackAppNameProblem } from "@open-everywhere/provider-slack/agent/app-manifest.js";

const USAGE = `create-open-everywhere [<dir>] [--skip-wizard] [--check [--json]] [--goal hosted|local] [--host <url>]
                       [--app-name <name>] [--decline-telemetry] [--version] [--help]

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
  --goal <g>     What the steps judge against: 'hosted' (default — a Vercel
                 deploy) or 'local' (npm run dev on this machine).
  --host <url>   The deployment's public origin. With the hosted goal, the
                 build + deploy step probes its Slack route.
  --app-name <name>
                 The Slack app's name in the manifest the wizard prints
                 (default "Open Everywhere"). A second install in one
                 workspace needs its own name.
  --decline-telemetry
                 Record "declined" for the wizard's telemetry question, from any
                 shell. Nothing is sent. Accepting needs the interactive prompt.
  --version      Print the wizard's own version.
  --help         Print this message.
`;

export interface ParsedArgs {
  readonly dirs: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly goal?: string;
  readonly host?: string;
  readonly appName?: string;
  readonly errors: readonly string[];
}

const VALUE_FLAGS = new Set(["--goal", "--host", "--app-name"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const dirs: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      dirs.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) errors.push(`${name} needs a value`);
      else values[name] = value;
      continue;
    }
    flags.add(arg);
  }
  const goal = values["--goal"];
  if (goal !== undefined && goal !== "hosted" && goal !== "local") errors.push(`--goal must be "hosted" or "local", got "${goal}"`);
  const appName = values["--app-name"];
  if (appName !== undefined) {
    const problem = slackAppNameProblem(appName);
    if (problem !== undefined) errors.push(`--app-name: ${problem}`);
  }
  return { dirs, flags, goal, host: values["--host"], ...(appName === undefined ? {} : { appName: appName.trim() }), errors };
}

function buildContext(cwd: string = process.cwd(), args?: ParsedArgs): StepContext {
  return {
    cwd,
    env: process.env,
    goal: args?.goal === "local" ? "local" : "hosted",
    ...(args?.host !== undefined ? { host: args.host } : {}),
    ...(args?.appName !== undefined ? { appName: args.appName } : {}),
  };
}

async function runCheckMode(json: boolean, args: ParsedArgs): Promise<number> {
  const ctx = buildContext(process.cwd(), args);
  const summary = await checkAll(WIZARD_STEPS, ctx);
  if (json) {
    const report = {
      version: WIZARD_VERSION,
      cwd: process.cwd(),
      goal: ctx.goal,
      satisfiedCount: summary.satisfiedCount,
      total: summary.total,
      allSatisfied: summary.allSatisfied,
      steps: summary.results.map((r) => ({
        id: r.step.id,
        title: r.step.title,
        satisfied: r.check.satisfied,
        detail: r.check.detail,
        ...(r.check.next !== undefined ? { next: r.check.next } : {}),
      })),
    };
    console.log(JSON.stringify(report, null, 2));
    return summary.allSatisfied ? 0 : 1;
  }
  for (const r of summary.results) {
    console.log(`${r.check.satisfied ? "✓" : "✗"} ${r.step.title}: ${r.check.detail}`);
    if (r.check.next !== undefined) console.log(`    next: ${r.check.next}`);
  }
  console.log(`\n${summary.satisfiedCount}/${summary.total} steps satisfied (goal: ${ctx.goal}).`);
  return summary.allSatisfied ? 0 : 1;
}

async function runInteractiveMode(cwd: string | undefined, args: ParsedArgs, createIO: () => WizardIO = createRealIO): Promise<number> {
  const ctx = buildContext(cwd, args);
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

function runScaffold(target: string): string | undefined {
  try {
    const result = scaffoldApp({ targetDir: target, version: WIZARD_VERSION });
    console.log(`Scaffolded the Open Everywhere quickstart app (${result.files.length} files, version ${WIZARD_VERSION}) into ${result.dir}`);
    console.log(`git: ${initGitRepo(result.dir).detail}`);
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
    ...(resolve(target) === process.cwd() ? [] : [`  cd ${target}`]),
    "  npm install                                   # its postinstall applies the eve patch",
    "  npx create-open-everywhere --check --json     # setup status, as data (add --goal local for npm run dev only)",
    "  npx create-open-everywhere                    # the interactive wizard (a person, in a terminal)",
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
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    for (const e of args.errors) console.error(e);
    return 2;
  }
  const { dirs, flags } = args;
  if (dirs.length > 1) {
    console.error(`create-open-everywhere takes at most one directory, got ${dirs.length}: ${dirs.join(" ")}`);
    return 2;
  }
  const target = dirs[0];
  if (target === undefined) {
    if (flags.has("--skip-wizard")) {
      console.error("--skip-wizard needs a <dir> to scaffold into");
      return 2;
    }
    if (flags.has("--decline-telemetry")) {
      declineTelemetry(process.cwd());
      console.log("Recorded: the wizard's telemetry is declined for this app. Nothing was sent, and nothing will be.");
      if (!flags.has("--check")) return 0;
    }
    if (flags.has("--check")) return runCheckMode(flags.has("--json"), args);
    if (!options.isTTY) {
      console.error(
        "The interactive wizard needs a terminal, and this shell has none. Run `npx create-open-everywhere --check --json` for the status as data, or ask the person to run `npx create-open-everywhere` in a terminal.",
      );
      return 2;
    }
    return runInteractiveMode(undefined, args, options.createIO);
  }
  if (flags.has("--check")) {
    console.error("--check changes nothing, so it cannot scaffold. Scaffold first, then run --check from inside the app.");
    return 2;
  }
  const dir = runScaffold(target);
  if (dir === undefined) return 1;
  if (flags.has("--skip-wizard") || !options.isTTY) {
    console.log(nextSteps(target, flags.has("--skip-wizard") ? "--skip-wizard" : "no terminal"));
    return 0;
  }
  return runInteractiveMode(dir, args, options.createIO);
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
