import assert from "node:assert/strict";
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
  try {
    process.env.npm_execpath = process.argv[1];
    const [cmd, argv] = npmCommand(["run", "x"]);
    assert.equal(cmd, process.execPath);
    assert.notEqual(cmd, "npm");
    assert.deepEqual(argv.slice(-2), ["run", "x"]);
  } finally {
    if (saved === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = saved;
  }
} finally {
  Object.defineProperty(process, "platform", real);
}
console.log("npm-command-test: ok");
