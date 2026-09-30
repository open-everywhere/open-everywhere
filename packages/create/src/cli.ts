import { flushTelemetry } from "@open-everywhere/core/agent/observability/telemetry.js";
import { checkAll, runWizard, type StepContext } from "./engine.js";
import { WIZARD_STEPS } from "./steps/index.js";
import { createRealIO, closeRealIO } from "./io.js";
import { maybeEmitWizardCompleted } from "./telemetry.js";
import { WIZARD_VERSION } from "./version.js";
import { pathToFileURL } from "node:url";

const USAGE = `create-open-everywhere [--check] [--version] [--help]

  (no flags)   Interactive setup wizard — walks prerequisites, repo, tool
               roster, Vercel, database, Slack, env checklist, telemetry
               disclosure, build, and final verification. Resumable — re-run
               any time; already-satisfied steps are skipped.
  --check      Non-interactive status report only. No prompts, no changes,
               no telemetry. Exit code 0 if every step is satisfied, else 1.
  --version    Print the wizard's own version.
  --help       Print this message.
`;

function buildContext(): StepContext {
  return { cwd: process.cwd(), env: process.env };
}

async function runCheckMode(): Promise<number> {
  const summary = await checkAll(WIZARD_STEPS, buildContext());
  for (const r of summary.results) {
    console.log(`${r.check.satisfied ? "✓" : "✗"} ${r.step.title}: ${r.check.detail}`);
  }
  console.log(`\n${summary.satisfiedCount}/${summary.total} steps satisfied.`);
  return summary.allSatisfied ? 0 : 1;
}

async function runInteractiveMode(): Promise<number> {
  const ctx = buildContext();
  const io = createRealIO();
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

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(WIZARD_VERSION);
    return 0;
  }
  if (argv.includes("--check")) return runCheckMode();
  return runInteractiveMode();
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
