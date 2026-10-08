import { checkAll, isSetupRoute, SETUP_ROUTES, type SetupRoute, type StepContext } from "./engine.js";
import { SETUP_STEPS } from "./steps/index.js";
import { CLI_VERSION } from "./version.js";
import { initGitRepo, nestedNameRefusal, scaffoldApp, ScaffoldRefusal } from "./scaffold.js";
import { resolve } from "node:path";
import { coreNodeRange, nodeRangeSatisfied } from "@open-everywhere/core/agent/ops/package-info.js";
import { pathToFileURL } from "node:url";
import { slackAppNameProblem } from "@open-everywhere/provider-slack/agent/app-manifest.js";
import { readAppNaming } from "./app-naming.js";

const USAGE = `create-open-everywhere [<dir>] [--check [--json]] [--route vercel|docker] [--host <url>]
                       [--app-name <name>] [--version] [--help]

  <dir>          Scaffold the quickstart app into <dir> (a new or empty
                 directory), then print the next steps and exit. It never
                 prompts: setup is agent-led.
  --check        Status report for the current directory. No prompts, no
                 changes, no telemetry. Exit 0 if every step is satisfied,
                 else 1. It never scaffolds.
  --json         With --check: print the report as one JSON object.
  --route <r>    The deployment route the steps judge against: 'vercel'
                 (default — the Vercel CLI and Marketplace Neon) or 'docker'
                 (self-host against the deployment contract). These are the
                 two supported routes. A local run is the development loop
                 after a deploy, never a route.
  --host <url>   The deployment's public origin. The build + deploy step
                 probes its Slack route, and the env step reads the env
                 verdicts its status route (/eve/v1/oe/status) reports.
  --app-name <name>
                 The Slack app's name in the manifest the Slack step prints.
                 Default: the app's identity.name setting, else "Open
                 Everywhere". A second install in one workspace needs its
                 own name.
  --version      Print this CLI's version.
  --help         Print this message.

Setup itself is agent-led: open the app in your coding agent and ask it to set
up Open Everywhere. It reads AGENTS.md, drives the open-everywhere-ops MCP
server, and reads this command's --check report.
`;

const NOTHING_TO_DO = `Nothing to do. @open-everywhere/create scaffolds an app (\`npx @open-everywhere/create <dir>\`) and reports setup status (\`npx @open-everywhere/create --check --json\`).

To set this app up, open it in your coding agent and ask it to set up Open Everywhere: it reads AGENTS.md and drives the open-everywhere-ops MCP server. \`--help\` lists every flag.`;

export interface ParsedArgs {
  readonly dirs: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly route?: SetupRoute;
  readonly host?: string;
  readonly appName?: string;
  readonly errors: readonly string[];
}

const VALUE_FLAGS = new Set(["--route", "--host", "--app-name"]);

const BARE_FLAGS = new Set(["--check", "--json", "--help", "-h", "--version", "-v"]);

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
    if (!BARE_FLAGS.has(name)) {
      errors.push(
        name === "--goal"
          ? "--goal is retired: pass --route vercel or --route docker (the local goal is gone — a local run is the development loop, not a setup route)"
          : name === "--skip-wizard" || name === "--decline-telemetry"
            ? `${name} is retired: the interactive wizard is gone, so a scaffold never prompts and this CLI sends no telemetry`
            : `unknown flag ${name} — run --help`,
      );
      continue;
    }
    flags.add(name);
  }
  const route = values["--route"];
  if (route !== undefined && !isSetupRoute(route)) errors.push(`--route must be one of ${SETUP_ROUTES.join(" | ")}, got "${route}"`);
  const appName = values["--app-name"];
  if (appName !== undefined) {
    const problem = slackAppNameProblem(appName);
    if (problem !== undefined) errors.push(`--app-name: ${problem}`);
  }
  return {
    dirs,
    flags,
    ...(route !== undefined && isSetupRoute(route) ? { route } : {}),
    host: values["--host"],
    ...(appName === undefined ? {} : { appName: appName.trim() }),
    errors,
  };
}

async function buildContext(args: ParsedArgs): Promise<StepContext> {
  const cwd = process.cwd();
  return {
    ...(await readAppNaming(cwd)),
    cwd,
    env: process.env,
    route: args.route ?? "vercel",
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.appName !== undefined ? { appName: args.appName } : {}),
  };
}

async function runCheckMode(json: boolean, args: ParsedArgs): Promise<number> {
  const ctx = await buildContext(args);
  const summary = await checkAll(SETUP_STEPS, ctx);
  if (json) {
    const report = {
      version: CLI_VERSION,
      cwd: ctx.cwd,
      route: ctx.route,
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
  console.log(`\n${summary.satisfiedCount}/${summary.total} steps satisfied (route: ${ctx.route}).`);
  return summary.allSatisfied ? 0 : 1;
}

function runScaffold(target: string): string | undefined {
  try {
    const result = scaffoldApp({ targetDir: target, version: CLI_VERSION });
    console.log(`Scaffolded the Open Everywhere quickstart app (${result.files.length} files, version ${CLI_VERSION}) into ${result.dir}`);
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

export function scaffoldNodeRefusal(version: string, range: string | undefined): string | undefined {
  if (range === undefined || nodeRangeSatisfied(range, version) !== false) return undefined;
  return `refusing to scaffold: Open Everywhere needs Node ${range} (found ${version}). Run \`nvm install 24 && nvm use 24\`, then run this command again.`;
}

export interface MainOptions {
  readonly nodeVersion?: string;
  readonly nodeRange?: string;
}

function nextSteps(target: string): string {
  return [
    "Next, from the new app:",
    ...(resolve(target) === process.cwd() ? [] : [`  cd ${target}`]),
    "  npm install                                   # its postinstall applies the eve patch",
    "Then open the app in your coding agent and ask it to set up Open Everywhere. It reads",
    "AGENTS.md, drives the open-everywhere-ops MCP server, and asks you to pick a route:",
    "Vercel or Docker. The app's README.md is one screen; the full step list is the reference",
    "page it links to.",
    "",
    "  npx @open-everywhere/create --check --json    # setup status, as data (--route docker for the Docker route)",
  ].join("\n");
}

export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(CLI_VERSION);
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
    if (flags.has("--check")) return runCheckMode(flags.has("--json"), args);
    console.log(NOTHING_TO_DO);
    return 0;
  }
  if (flags.has("--check")) {
    console.error("--check changes nothing, so it cannot scaffold. Scaffold first, then run --check from inside the app.");
    return 2;
  }
  const nodeRefusal = scaffoldNodeRefusal(options.nodeVersion ?? process.versions.node, "nodeRange" in options ? options.nodeRange : coreNodeRange());
  if (nodeRefusal !== undefined) {
    console.error(nodeRefusal);
    return 1;
  }
  const nested = nestedNameRefusal(target, process.cwd());
  if (nested !== undefined) {
    console.error(nested);
    return 1;
  }
  const dir = runScaffold(target);
  if (dir === undefined) return 1;
  console.log(nextSteps(target));
  return 0;
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
