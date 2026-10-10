import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmCommand, spawnFailure } from "./npm-command.js";

const enoent = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
const started = spawnFailure({ status: null, error: enoent }, "e2e driver");
assert.ok(started?.includes("did not start") && started.includes("ENOENT") && started.includes("spawn npm ENOENT"), String(started));
assert.ok(spawnFailure({ status: null, signal: "SIGTERM" }, "e2e driver")?.includes("SIGTERM"));
assert.equal(spawnFailure({ status: 0 }, "x"), undefined);
assert.equal(spawnFailure({ status: 3 }, "x"), undefined);

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
