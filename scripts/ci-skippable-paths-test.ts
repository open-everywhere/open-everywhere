import assert from "node:assert/strict";

import { isSkippableDiff, isSkippablePath, runtimePaths } from "./ci/skippable-paths.js";

let checks = 0;
const check = (label: string, fn: () => void): void => {
  checks++;
  fn();
};

check("isSkippablePath: .claude/** is skippable", () => {
  assert.equal(isSkippablePath(".claude/skills/example/SKILL.md"), true);
  assert.equal(isSkippablePath(".claude/agents/example.md"), true);
});

check("isSkippablePath: docs/** is skippable", () => {
  assert.equal(isSkippablePath("docs/deploy/rollback.md"), true);
  assert.equal(isSkippablePath("docs/introduction/quick-start.md"), true);
});

check("isSkippablePath: a root-level *.md file is skippable", () => {
  assert.equal(isSkippablePath("AGENTS.md"), true);
  assert.equal(isSkippablePath("README.md"), true);
  assert.equal(isSkippablePath("CLAUDE.md"), true);
});

check("isSkippablePath: agent/** is RUNTIME, never skippable", () => {
  assert.equal(isSkippablePath("agent/agent.ts"), false);
  assert.equal(isSkippablePath("agent/settings/settings.ts"), false);
});

check("isSkippablePath: agent/docs/generated/** is RUNTIME even though it is doc CONTENT — it is the compiled-in copy the agent serves", () => {
  assert.equal(isSkippablePath("agent/docs/generated/deploy.ts"), false);
});

check("isSkippablePath: packages/** is RUNTIME", () => {
  assert.equal(isSkippablePath("packages/core/agent/agent.ts"), false);
  assert.equal(isSkippablePath("packages/core/scripts/reply-test.ts"), false);
});

check("isSkippablePath: .github/** is RUNTIME by deliberate exclusion — a workflow edit must always keep the heavy job in the loop", () => {
  assert.equal(isSkippablePath(".github/workflows/ci.yml"), false);
});

check("isSkippablePath: a root config file (not *.md) is RUNTIME", () => {
  assert.equal(isSkippablePath("package.json"), false);
  assert.equal(isSkippablePath("tsconfig.json"), false);
  assert.equal(isSkippablePath("vitest.config.ts"), false);
});

check("isSkippablePath: a NESTED *.md is not the root-markdown case, but IS covered by docs/ or .claude/ where applicable", () => {
  assert.equal(isSkippablePath("packages/core/README.md"), false);
});

check("isSkippableDiff: every path skippable → true", () => {
  assert.equal(isSkippableDiff([".claude/skills/example/SKILL.md", "docs/deploy/rollback.md", "AGENTS.md"]), true);
});

check("isSkippableDiff: one runtime path among many skippable ones → false (ALL must be skippable)", () => {
  assert.equal(isSkippableDiff([".claude/skills/example/SKILL.md", "agent/agent.ts"]), false);
});

check("isSkippableDiff: an empty path list is NOT skippable", () => {
  assert.equal(isSkippableDiff([]), false);
});

check("isSkippableDiff: docs/** plus its regenerated agent/docs/generated/** copy is runtime overall", () => {
  assert.equal(isSkippableDiff(["docs/deploy/rollback.md", "agent/docs/generated/deploy.ts"]), false);
});

check("runtimePaths: returns only the non-skippable paths, in order", () => {
  const paths = [".claude/skills/example/SKILL.md", "agent/agent.ts", "docs/deploy/rollback.md", "packages/core/agent/agent.ts"];
  assert.deepEqual(runtimePaths(paths), ["agent/agent.ts", "packages/core/agent/agent.ts"]);
});

check("runtimePaths: empty when the diff is fully skippable — the complement of isSkippableDiff's true case", () => {
  assert.deepEqual(runtimePaths([".claude/skills/example/SKILL.md", "AGENTS.md"]), []);
});

console.log(`✓ ci-skippable-paths: ${checks} check(s) passed (path predicate, whole-diff predicate, blocking-subset — all offline)`);
