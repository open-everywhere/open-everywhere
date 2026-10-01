import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIZARD_STEPS } from "../src/steps/index.js";
import { main } from "../src/cli.js";
import type { WizardIO } from "../src/engine.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = join(packageRoot, "src", "cli.ts");

function runCli(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliPath, ...args], { cwd, encoding: "utf8", env: { ...process.env }, input: "", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

{
  const version = runCli(["--version"], packageRoot);
  ok(version.status === 0, "--version: exits 0");
  ok(/^\d+\.\d+\.\d+/.test(version.stdout.trim()), "--version: prints a semver-looking string");

  const help = runCli(["--help"], packageRoot);
  ok(help.status === 0, "--help: exits 0");
  ok(help.stdout.includes("--check"), "--help: mentions --check");
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-wizard-cli-check-test-"));
  try {
    const result = runCli(["--check"], dir);
    ok(result.status === 1, "--check: exits 1 when the checklist isn't fully satisfied (a bare scratch dir never is)");
    ok(result.stdout.includes("Prerequisites"), "--check: reports the prerequisites step");
    ok(result.stdout.includes("Repo"), "--check: reports the repo step");
    ok(result.stdout.includes("Slack app"), "--check: reports the Slack step");
    ok(result.stdout.includes("Roster ("), "--check: reports the roster step");
    ok(
      new RegExp(String.raw`\d+/${WIZARD_STEPS.length} steps satisfied \(goal: hosted\)\.`).test(result.stdout),
      `--check: prints an N/${WIZARD_STEPS.length} summary line covering every registered step`,
    );
    ok(!existsSync(join(dir, ".open-everywhere", "wizard-state.json")), "--check: never writes wizard-state.json (no prompts, no side effects)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-wizard-cli-scaffold-test-"));
  try {
    const help = runCli(["--help"], packageRoot);
    ok(help.stdout.includes("<dir>") && help.stdout.includes("--skip-wizard"), "--help: documents <dir> and --skip-wizard");

    const scaffolded = runCli(["my-app", "--skip-wizard"], dir);
    ok(scaffolded.status === 0, `<dir> --skip-wizard: exits 0 (stderr: ${scaffolded.stderr.trim()})`);
    ok(existsSync(join(dir, "my-app", "agent", "agent.ts")), "<dir> --skip-wizard: scaffolds the app, relative to the working directory");
    ok(existsSync(join(dir, "my-app", ".gitignore")), "<dir> --skip-wizard: renames gitignore to .gitignore");
    ok(!existsSync(join(dir, "my-app", "node_modules")), "<dir> --skip-wizard: installs nothing");
    ok(!existsSync(join(dir, "my-app", ".open-everywhere")), "<dir> --skip-wizard: runs no wizard step (no wizard state)");

    const again = runCli(["my-app", "--skip-wizard"], dir);
    ok(again.status === 1, "<dir>: refuses a non-empty directory with exit 1");
    ok(again.stderr.includes("not empty"), "<dir>: the refusal says why");

    const checkScaffold = runCli(["other-app", "--check"], dir);
    ok(checkScaffold.status === 2, "<dir> --check: refused with exit 2 — --check changes nothing");
    ok(!existsSync(join(dir, "other-app")), "<dir> --check: scaffolds nothing");

    const two = runCli(["a", "b"], dir);
    ok(two.status === 2 && !existsSync(join(dir, "a")), "two <dir> arguments: refused with exit 2, nothing written");

    const agentShell = runCli(["agent-app"], dir);
    ok(agentShell.status === 0, `<dir> with no TTY: exits 0 without waiting on a prompt (status ${agentShell.status})`);
    ok(existsSync(join(dir, "agent-app", "agent", "agent.ts")), "<dir> with no TTY: scaffolds the app");
    ok(agentShell.stdout.includes("did not run (no terminal)"), "<dir> with no TTY: says the wizard did not run, and why");
    ok(agentShell.stdout.includes("--check --json"), "<dir> with no TTY: names the machine-readable next step");
    ok(!agentShell.stdout.includes("— Prerequisites"), "<dir> with no TTY: runs no interactive step (negative control)");
    ok(!existsSync(join(dir, "agent-app", ".open-everywhere")), "<dir> with no TTY: writes no wizard state");

    const report = runCli(["--check", "--json"], join(dir, "agent-app"));
    ok(report.status === 1, "--check --json: exits 1 while any step is unsatisfied");
    const parsed = JSON.parse(report.stdout) as { total: number; steps: { id: string; satisfied: boolean; detail: string }[] };
    ok(parsed.total === WIZARD_STEPS.length, "--check --json: total counts every registered step");
    ok(
      JSON.stringify(parsed.steps.map((st) => st.id)) === JSON.stringify(WIZARD_STEPS.map((st) => st.id)),
      "--check --json: one entry per registered step, in order",
    );
    const repo = parsed.steps.find((st) => st.id === "repo");
    ok(repo?.satisfied === false && /app found, but run .npm install./.test(repo.detail), "--check --json: the repo step recognises the scaffolded app and asks for npm install");
    ok(parsed.steps.every((st) => typeof st.satisfied === "boolean" && typeof st.detail === "string"), "--check --json: every step carries a boolean and a detail");

    const skipAlone = runCli(["--skip-wizard"], dir);
    ok(skipAlone.status === 2, "--skip-wizard with no <dir>: refused with exit 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const parent = mkdtempSync(join(tmpdir(), "oe-wizard-cli-tty-test-"));
  const printed: string[] = [];
  const asked: string[] = [];
  const scripted: WizardIO = {
    print: (line) => void printed.push(line),
    ask: async (q) => {
      asked.push(q);
      return "decline";
    },
    askSecret: async (q) => {
      asked.push(q);
      return "";
    },
    confirm: async (q) => {
      asked.push(q);
      return false;
    },
  };
  const before = process.cwd();
  try {
    process.chdir(parent);
    const code = await main(["tty-app"], { isTTY: true, createIO: () => scripted });
    const appDir = join(parent, "tty-app");
    ok(existsSync(join(appDir, "agent", "agent.ts")), "<dir> on a TTY: scaffolds the app first");
    ok(printed.some((l) => l.includes("— Prerequisites")), "<dir> on a TTY: the interactive wizard runs (its first step is printed)");
    ok(asked.some((q) => q.includes("npm install")), "<dir> on a TTY: the repo step offers `npm install` — it found the app, so the wizard ran in <dir>");
    ok(!existsSync(join(appDir, "node_modules")), "<dir> on a TTY: a declined install installs nothing");
    ok(existsSync(join(appDir, ".open-everywhere", "wizard-state.json")), "<dir> on a TTY: the wizard's state lands in <dir>, not the parent");
    ok(!existsSync(join(parent, ".open-everywhere")), "<dir> on a TTY: nothing lands in the parent directory (negative control)");
    ok(code === 1, "<dir> on a TTY: exits 1 while steps stay unsatisfied");
  } finally {
    process.chdir(before);
    rmSync(parent, { recursive: true, force: true });
  }
}

{
  const { parseArgs } = await import("../src/cli.js");
  const parsed = parseArgs(["--check", "--goal", "local", "--host=https://a.example", "--json"]);
  ok(parsed.goal === "local" && parsed.host === "https://a.example" && parsed.dirs.length === 0, "parseArgs: `--goal v` and `--host=v` both parse, and a flag value is never a <dir>");
  ok(parseArgs(["--goal", "staging"]).errors.length === 1, "parseArgs: an unknown goal is an error");
  ok(parseArgs(["--host"]).errors.length === 1, "parseArgs: a value flag with no value is an error");
  const named = parseArgs(["--app-name", " Acme Agent "]);
  ok(named.appName === "Acme Agent" && named.errors.length === 0 && named.dirs.length === 0, "parseArgs: `--app-name v` takes the name, trimmed, and not as a dir");
  ok(parseArgs([]).appName === undefined, "parseArgs: no --app-name means no name (negative control)");
  ok(/at most 35/.test(parseArgs([`--app-name=${"x".repeat(36)}`]).errors.join(" ")), "parseArgs: a name over Slack's 35-character limit is an error");

  const dir = mkdtempSync(join(tmpdir(), "oe-wizard-cli-goal-"));
  try {
    const bad = runCli(["--check", "--goal", "staging"], dir);
    ok(bad.status === 2, "--goal staging: exits 2");

    const hosted = runCli(["--check", "--json"], dir);
    const report = JSON.parse(hosted.stdout) as { goal: string; steps: { id: string; satisfied: boolean; next?: string }[] };
    ok(report.goal === "hosted", "--check --json: the default goal is hosted, and the report says so");
    const unsatisfied = report.steps.filter((s) => !s.satisfied);
    ok(unsatisfied.length > 0 && unsatisfied.every((s) => typeof s.next === "string" && s.next.length > 0), "--check --json: every unsatisfied step carries a `next` command");
    ok(report.steps.find((s) => s.id === "database")?.satisfied === false, "--check --json: the hosted goal never reports the database as done without one");

    const local = JSON.parse(runCli(["--check", "--json", "--goal", "local"], dir).stdout) as { goal: string; steps: { id: string; satisfied: boolean }[] };
    ok(local.goal === "local" && local.steps.find((s) => s.id === "database")?.satisfied === true, "--check --goal local: the embedded floor satisfies the database step (negative control)");

    const text = runCli(["--check"], dir);
    ok(/\n {4}next: /.test(text.stdout), "--check (text): prints a `next:` line under an unsatisfied step");

    const declined = runCli(["--decline-telemetry"], dir);
    ok(declined.status === 0, "--decline-telemetry: exits 0 without a terminal");
    const statePath = join(dir, ".open-everywhere", "wizard-state.json");
    ok(existsSync(statePath), "--decline-telemetry: writes the wizard state");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    ok(state.telemetryConsent === "declined", "--decline-telemetry: records consent = declined");
    ok(state.wizardStartedEmitted === undefined, "--decline-telemetry: emits nothing (no started guard set)");
    const after = JSON.parse(runCli(["--check", "--json"], dir).stdout) as { steps: { id: string; satisfied: boolean }[] };
    ok(after.steps.find((s) => s.id === "telemetry-disclosure")?.satisfied === true, "--decline-telemetry: the telemetry step is then satisfied");

    const hung = runCli([], dir);
    ok(hung.status === 2 && /needs a terminal/.test(hung.stderr), "no flags and no terminal: exits 2 and says the wizard needs a terminal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`✓ ${n} CLI --check assertions passed`);
