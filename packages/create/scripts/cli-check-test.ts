import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SETUP_STEPS } from "../src/steps/index.js";
import { parseArgs } from "../src/cli.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = join(packageRoot, "src", "cli.ts");

const CONFIG_PREFIXES = /^(OE_|SLACK_|E2E_|EVAL_|AI_GATEWAY|DATABASE_URL)/;
const CLEAN_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(CLEAN_ENV)) if (CONFIG_PREFIXES.test(key)) delete CLEAN_ENV[key];

function runCli(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliPath, ...args], { cwd, encoding: "utf8", env: { ...CLEAN_ENV }, input: "", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

{
  const version = runCli(["--version"], packageRoot);
  ok(version.status === 0, "--version: exits 0");
  ok(/^\d+\.\d+\.\d+/.test(version.stdout.trim()), "--version: prints a semver-looking string");

  const help = runCli(["--help"], packageRoot);
  ok(help.status === 0, "--help: exits 0");
  ok(help.stdout.includes("--check") && help.stdout.includes("<dir>"), "--help: documents --check and <dir>");
  ok(/--route <r>/.test(help.stdout) && /vercel/.test(help.stdout) && /docker/.test(help.stdout), "--help: documents --route and names both routes");
  ok(/agent-led/.test(help.stdout), "--help: says setup is agent-led");
  ok(!/--skip-wizard|--decline-telemetry|--goal /.test(help.stdout), "--help: documents no retired flag");
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-cli-check-test-"));
  try {
    const result = runCli(["--check"], dir);
    ok(result.status === 1, "--check: exits 1 when the checklist isn't fully satisfied (a bare scratch dir never is)");
    ok(result.stdout.includes("Prerequisites"), "--check: reports the prerequisites step");
    ok(result.stdout.includes("Repo"), "--check: reports the repo step");
    ok(result.stdout.includes("Slack app"), "--check: reports the Slack step");
    ok(result.stdout.includes("Roster ("), "--check: reports the roster step");
    ok(
      new RegExp(String.raw`\d+/${SETUP_STEPS.length} steps satisfied \(route: vercel\)\.`).test(result.stdout),
      `--check: prints an N/${SETUP_STEPS.length} summary line covering every registered step, naming the route`,
    );
    ok(/\n {4}next: /.test(result.stdout), "--check (text): prints a `next:` line under an unsatisfied step");
    ok(!existsSync(join(dir, ".open-everywhere")), "--check: writes no state directory");
    ok(!existsSync(join(dir, ".env.local")), "--check: writes no .env.local");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-cli-scaffold-test-"));
  try {
    const scaffolded = runCli(["my-app"], dir);
    ok(scaffolded.status === 0, `<dir>: exits 0 (stderr: ${scaffolded.stderr.trim()})`);
    ok(existsSync(join(dir, "my-app", "agent", "agent.ts")), "<dir>: scaffolds the app, relative to the working directory");
    ok(existsSync(join(dir, "my-app", ".gitignore")), "<dir>: renames gitignore to .gitignore");
    ok(!existsSync(join(dir, "my-app", "node_modules")), "<dir>: installs nothing");
    ok(!existsSync(join(dir, "my-app", ".open-everywhere")), "<dir>: writes no state (there is no wizard to resume)");
    ok(scaffolded.stdout.includes("cd my-app"), "<dir>: the next steps carry `cd my-app`");
    ok(/coding agent/.test(scaffolded.stdout), "<dir>: the next steps hand setup to the coding agent");
    ok(scaffolded.stdout.includes("--check --json"), "<dir>: …and name the machine-readable status command");
    ok(!/— Prerequisites/.test(scaffolded.stdout), "<dir>: runs no interactive step (negative control)");

    const again = runCli(["my-app"], dir);
    ok(again.status === 1, "<dir>: refuses a non-empty directory with exit 1");
    ok(again.stderr.includes("not empty"), "<dir>: the refusal says why");

    const clone = join(dir, "fresh-clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    const inPlace = runCli(["."], clone);
    ok(inPlace.status === 0, `. in a fresh clone: exits 0 (stderr: ${inPlace.stderr.trim()})`);
    ok(existsSync(join(clone, "agent", "agent.ts")), ". in a fresh clone: scaffolds the app in place");
    ok(!inPlace.stdout.includes("cd ."), ". in a fresh clone: the next steps carry no `cd .` line");

    const checkScaffold = runCli(["other-app", "--check"], dir);
    ok(checkScaffold.status === 2, "<dir> --check: refused with exit 2 — --check changes nothing");
    ok(!existsSync(join(dir, "other-app")), "<dir> --check: scaffolds nothing");

    const two = runCli(["a", "b"], dir);
    ok(two.status === 2 && !existsSync(join(dir, "a")), "two <dir> arguments: refused with exit 2, nothing written");

    const report = runCli(["--check", "--json"], join(dir, "my-app"));
    ok(report.status === 1, "--check --json: exits 1 while any step is unsatisfied");
    const parsed = JSON.parse(report.stdout) as { total: number; route: string; steps: { id: string; satisfied: boolean; detail: string; next?: string }[] };
    ok(parsed.total === SETUP_STEPS.length, "--check --json: total counts every registered step");
    ok(
      JSON.stringify(parsed.steps.map((st) => st.id)) === JSON.stringify(SETUP_STEPS.map((st) => st.id)),
      "--check --json: one entry per registered step, in order",
    );
    ok(parsed.route === "vercel", "--check --json: the default route is vercel, and the report says so");
    const repo = parsed.steps.find((st) => st.id === "repo");
    ok(repo?.satisfied === false && /app found, but run .npm install./.test(repo.detail), "--check --json: the repo step recognises the scaffolded app and asks for npm install");
    ok(parsed.steps.every((st) => typeof st.satisfied === "boolean" && typeof st.detail === "string"), "--check --json: every step carries a boolean and a detail");
    const unsatisfied = parsed.steps.filter((s) => !s.satisfied);
    ok(unsatisfied.length > 0 && unsatisfied.every((s) => typeof s.next === "string" && s.next.length > 0), "--check --json: every unsatisfied step carries a `next` command");
    ok(parsed.steps.every((st) => st.id !== "telemetry-disclosure"), "--check --json: there is no telemetry-disclosure step (it went with the wizard)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const parsed = parseArgs(["--check", "--route", "docker", "--host=https://a.example", "--json"]);
  ok(parsed.route === "docker" && parsed.host === "https://a.example" && parsed.dirs.length === 0, "parseArgs: `--route v` and `--host=v` both parse, and a flag value is never a <dir>");
  ok(parseArgs(["--check"]).route === undefined, "parseArgs: no --route leaves it unset (the context defaults it to vercel)");
  ok(/vercel \| docker/.test(parseArgs(["--route", "fly"]).errors.join(" ")), "parseArgs: an unsupported route is an error that names both supported ones");
  ok(parseArgs(["--host"]).errors.length === 1, "parseArgs: a value flag with no value is an error");

  ok(/--route vercel/.test(parseArgs(["--goal", "hosted"]).errors.join(" ")), "parseArgs: --goal is an error whose message names --route");
  ok(/local run is the development loop/.test(parseArgs(["--goal", "local"]).errors.join(" ")), "parseArgs: …and says why the local goal is gone");
  for (const flag of ["--skip-wizard", "--decline-telemetry"]) {
    ok(/retired/.test(parseArgs([flag]).errors.join(" ")), `parseArgs: ${flag} is an error that says it is retired`);
  }
  ok(/unknown flag --nope/.test(parseArgs(["--nope"]).errors.join(" ")), "parseArgs: any other unknown flag is an error that names it");

  const named = parseArgs(["--app-name", " Acme Agent "]);
  ok(named.appName === "Acme Agent" && named.errors.length === 0 && named.dirs.length === 0, "parseArgs: `--app-name v` takes the name, trimmed, and not as a dir");
  ok(parseArgs([]).appName === undefined, "parseArgs: no --app-name means no name (negative control)");
  ok(/at most 35/.test(parseArgs([`--app-name=${"x".repeat(36)}`]).errors.join(" ")), "parseArgs: a name over Slack's 35-character limit is an error");
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-cli-route-"));
  try {
    for (const retired of [["--check", "--goal", "hosted"], ["--check", "--goal", "local"], ["--skip-wizard"], ["--decline-telemetry"]]) {
      const res = runCli(retired, dir);
      ok(res.status === 2, `${retired.join(" ")}: exits 2`);
      ok(/retired/.test(res.stderr), `${retired.join(" ")}: …and stderr says it is retired`);
    }
    ok(!existsSync(join(dir, ".open-everywhere")), "a retired flag writes no state (the state file went with the wizard)");

    const docker = JSON.parse(runCli(["--check", "--json", "--route", "docker"], dir).stdout) as { route: string; steps: { id: string; satisfied: boolean; detail: string }[] };
    ok(docker.route === "docker", "--check --route docker: the report names the docker route");
    ok(docker.steps.find((s) => s.id === "vercel")?.satisfied === true, "--route docker: the Vercel-link step is satisfied (that route needs no project)");
    ok(docker.steps.find((s) => s.id === "database")?.satisfied === false, "--route docker: the database step still blocks — both routes need Postgres");
    const dockerEnv = docker.steps.find((s) => s.id === "env-checklist");
    ok(/AI_GATEWAY_API_KEY/.test(dockerEnv?.detail ?? ""), "--route docker: the env checklist asks for a model route");

    const vercel = JSON.parse(runCli(["--check", "--json"], dir).stdout) as { steps: { id: string; satisfied: boolean; detail: string }[] };
    ok(vercel.steps.find((s) => s.id === "vercel")?.satisfied === false, "--route vercel: the Vercel-link step blocks (negative control)");
    ok(!/AI_GATEWAY_API_KEY/.test(vercel.steps.find((s) => s.id === "env-checklist")?.detail ?? ""), "--route vercel: the env checklist asks for no gateway key (OIDC)");

    const bare = runCli([], dir);
    ok(bare.status === 0, "no arguments: exits 0 without waiting on a prompt");
    ok(/coding agent/.test(bare.stdout) && /--check --json/.test(bare.stdout), "no arguments: points at the agent-led setup and the status command");
    ok(!existsSync(join(dir, ".open-everywhere")) && !existsSync(join(dir, ".env.local")), "no arguments: writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`✓ ${n} CLI assertions passed`);
