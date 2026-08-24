import assert from "node:assert/strict";

import type { ExecResult } from "./deploy/lib.js";
import { fetchChangedPaths, isRealSha } from "./ci/changed-paths.js";

let checks = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> | void => {
  checks++;
  return fn() as void;
};

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0000000000000000000000000000000000000000";

check("isRealSha: a real-looking sha is real", () => {
  assert.equal(isRealSha(A), true);
  assert.equal(isRealSha("abc1234"), true);
});

check("isRealSha: the all-zero sentinel is NOT real (GitHub's own 'no previous commit' marker)", () => {
  assert.equal(isRealSha(ZERO), false);
});

check("isRealSha: non-hex garbage is not real", () => {
  assert.equal(isRealSha("not-a-sha"), false);
  assert.equal(isRealSha(""), false);
});

await check("fetchChangedPaths: refuses when `before` is the all-zero sentinel — never diffs, never calls git", async () => {
  let called = false;
  const result = await fetchChangedPaths({
    before: ZERO,
    after: B,
    exec: async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not a resolvable commit pair/);
  assert.equal(called, false, "git must never be invoked for an unresolvable sha pair");
});

await check("fetchChangedPaths: a failed SPAWN refuses loudly, naming the spawn error", async () => {
  const spawnFailed: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn git ENOENT" };
  const result = await fetchChangedPaths({ before: A, after: B, exec: async () => spawnFailed });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /could not run `git diff`/);
    assert.match(result.reason, /ENOENT/);
  }
});

await check("fetchChangedPaths: empty stdout WITHOUT spawnError is an empty (but valid) path list", async () => {
  const ranButPrintedNothing: ExecResult = { code: 0, stdout: "", stderr: "" };
  const result = await fetchChangedPaths({ before: A, after: B, exec: async () => ranButPrintedNothing });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.paths, []);
});

await check("fetchChangedPaths: a non-zero git exit refuses and surfaces stderr", async () => {
  const badRef: ExecResult = { code: 128, stdout: "", stderr: "fatal: bad object aaaaaaa" };
  const result = await fetchChangedPaths({ before: A, after: B, exec: async () => badRef });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /bad object/);
});

await check("fetchChangedPaths: parses a real `git diff --name-only` output into a path list, dropping blank lines", async () => {
  const ok: ExecResult = { code: 0, stdout: "docs/deploy/rollback.md\nagent/agent.ts\n\n", stderr: "" };
  const result = await fetchChangedPaths({ before: A, after: B, exec: async () => ok });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.paths, ["docs/deploy/rollback.md", "agent/agent.ts"]);
});

console.log(`✓ ci-changed-paths: ${checks} check(s) passed (isRealSha, spawn-trap seam, fetch→parse — all offline)`);
