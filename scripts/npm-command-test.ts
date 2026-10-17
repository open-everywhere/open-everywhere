import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chainLegs } from "./chain/_legs.js";
import { finishedRun, IncompleteChildRun, npmCommand, spawnFailure, tsxCommand, type ChildResult } from "./npm-command.js";

const enoent = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
const started = spawnFailure({ status: null, error: enoent }, "e2e driver");
assert.ok(started?.includes("did not start") && started.includes("ENOENT") && started.includes("spawn npm ENOENT"), String(started));
assert.ok(spawnFailure({ status: null, signal: "SIGTERM" }, "e2e driver")?.includes("SIGTERM"));
assert.equal(spawnFailure({ status: 0 }, "x"), undefined);
assert.equal(spawnFailure({ status: 3 }, "x"), undefined);
const timedOut = spawnFailure({ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync x ETIMEDOUT"), { code: "ETIMEDOUT" }) }, "x");
assert.ok(timedOut?.includes("timed out") && !timedOut.includes("did not start"), String(timedOut));
assert.ok(spawnFailure({ status: null, error: Object.assign(new Error("spawnSync x ENOBUFS"), { code: "ENOBUFS" }) }, "x")?.includes("maxBuffer"));

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const PRINT_THEN = (tail: string): string[] => ["-e", `process.stdout.write("first row\\n"); ${tail}`];
function thrownBy(args: string[], options: { timeout?: number; maxBuffer?: number } = {}): ChildResult {
  try {
    execFileSync(NODE, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (err) {
    return err as ChildResult;
  }
  throw new Error("the child was meant to fail");
}
function incomplete(result: ChildResult, label: string): IncompleteChildRun {
  try {
    finishedRun(result, label);
  } catch (err) {
    if (err instanceof IncompleteChildRun) return err;
    throw err;
  }
  throw new Error(`finishedRun graded ${label} as a finished run`);
}
{
  const hang = thrownBy(PRINT_THEN("setTimeout(() => {}, 60_000);"), { timeout: 5_000 });
  const e = incomplete(hang, "the hung child");
  assert.ok(e.message.startsWith("INCOMPLETE RUN — the hung child timed out and was killed"), e.message);
  assert.ok(e.output.includes("first row"), "the cut output is kept for diagnosis");
  assert.equal(hang.status, null, "a timeout kill of a bare node child has no exit code");
}
{
  const dir = mkdtempSync(join(tmpdir(), "npm-command-test-tsx-"));
  try {
    const hang = join(dir, "hang.ts");
    writeFileSync(hang, 'process.stdout.write("first row\\n");\nsetTimeout(() => {}, 60_000);\n');
    const r = spawnSync(...tsxCommand(REPO, [hang]), { encoding: "utf8", timeout: 2_000 });
    assert.ok(incomplete(r, "the tsx child").message.includes("timed out"));
    const killed = join(dir, "killed.ts");
    writeFileSync(killed, 'process.stdout.write("first row\\n");\nprocess.kill(process.pid, "SIGKILL");\n');
    const k = spawnSync(...tsxCommand(REPO, [killed]), { encoding: "utf8", timeout: 60_000 });
    assert.equal(k.signal, null, "tsx relays the kill as a code, not as a signal");
    const ke = incomplete(k, "the OOM-killed child");
    assert.ok(ke.message.includes("exited 137") && ke.message.includes("SIGKILL") && ke.output.includes("first row"), ke.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const r = spawnSync(NODE, PRINT_THEN('process.kill(process.pid, "SIGKILL");'), { encoding: "utf8" });
  assert.ok(incomplete(r, "the killed child").message.includes("signal SIGKILL"));
  assert.ok(incomplete(thrownBy(PRINT_THEN('process.stdout.write("x".repeat(4096));'), { maxBuffer: 1024 }), "the loud child").message.includes("maxBuffer"));
  assert.ok(incomplete(spawnSync(join(REPO, "no-such-binary"), [], { encoding: "utf8" }), "the missing child").message.includes("did not start (ENOENT)"));
}
{
  const failed = finishedRun(thrownBy(PRINT_THEN('process.stderr.write("why\\n"); process.exit(2);')), "the failing child");
  assert.deepEqual(failed, { status: 2, stdout: "first row\n", stderr: "why\n" });
  assert.equal(finishedRun(spawnSync(NODE, PRINT_THEN(""), { encoding: "utf8" }), "the clean child").status, 0);
}

{
  const FOLDS = [/\b(?:status|code) \?\? -?1\b/, /\b(?:status|code) \?\? \(/, /typeof \w+\.status === "number" \? \w+\.status : -?1\b/];
  const folds = (line: string): boolean => FOLDS.some((re) => re.test(line));
  assert.ok(folds("return { code: e.status ?? 1, out };") && folds("resolve(code ?? (signal ? 1 : 0))"), "FOLDS matches the removed fold shapes");
  assert.ok(folds('return { status: typeof e.status === "number" ? e.status : -1 };'), "FOLDS matches the typeof fold");
  assert.ok(!folds("status: a?.status ?? 200"), "FOLDS leaves an HTTP status default alone");
  const offenders: string[] = [];
  const self = fileURLToPath(import.meta.url);
  for (const file of new Set(chainLegs().map((leg) => leg.file))) {
    if (file === self) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("node:child_process")) continue;
    src.split("\n").forEach((line, i) => {
      if (!/^\s*(\/\/|\*)/.test(line) && FOLDS.some((re) => re.test(line))) offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `chain legs that fold a killed or timed-out child into an exit code — read it through finishedRun:\n${offenders.join("\n")}`);
}

const real = Object.getOwnPropertyDescriptor(process, "platform")!;
try {
  Object.defineProperty(process, "platform", { value: "linux" });
  assert.deepEqual(npmCommand(["run", "x"]), ["npm", ["run", "x"]]);
  Object.defineProperty(process, "platform", { value: "win32" });
  const saved = process.env.npm_execpath;
  const dir = mkdtempSync(join(tmpdir(), "npm-command-test-"));
  try {
    const cli = join(dir, "npm-cli.js");
    writeFileSync(cli, "");
    process.env.npm_execpath = cli;
    const [cmd, argv] = npmCommand(["run", "x"]);
    assert.equal(cmd, process.execPath);
    assert.notEqual(cmd, "npm");
    assert.deepEqual(argv, [cli, "run", "x"]);
  } finally {
    if (saved === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = saved;
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  Object.defineProperty(process, "platform", real);
}
console.log("npm-command-test: ok");
