import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { posixJoin, posixRelative, toPosixPath } from "./posix-path.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
  console.log(`  ✓ ${label}`);
}

console.log("posix-path:");

{
  ok(toPosixPath("agent\\channels\\slack.ts", "\\") === "agent/channels/slack.ts", "🔴 a `\\`-joined repo path becomes the `/` key");
  ok(toPosixPath("C:\\oe\\packages\\core\\agent\\x.ts", "\\") === "C:/oe/packages/core/agent/x.ts", "…and so does an absolute drive path");
  ok(
    toPosixPath("agent\\channels\\slack.ts", "\\").split("/").includes("agent"),
    "🔴 the env-docs filter shape: `split(\"/\").includes(\"agent\")` sees the segment once the path is normalised",
  );
  ok(!"agent\\channels\\slack.ts".split("/").includes("agent"), "…NEGATIVE CONTROL: the raw Windows path does not — the defect this ticket measured");
  ok(
    posixRelative("C:\\oe\\packages\\providers\\slack", "C:\\oe\\packages\\providers\\slack\\agent\\channels\\slack.ts", path.win32) ===
      "agent/channels/slack.ts",
    "🔴 posixRelative over the win32 path API yields the key KNOWN_UNCOVERED lists",
  );
  ok(
    path.win32.relative("C:\\oe\\pkg", "C:\\oe\\pkg\\agent\\x.ts") === "agent\\x.ts",
    "…NEGATIVE CONTROL: bare win32 `relative()` does not — it is what the seam suites compared before",
  );
  ok(posixRelative("C:\\oe", "C:\\oe\\a.ts", path.win32) === "a.ts", "a file at the root has no separator to change");
}

{
  ok(toPosixPath("agent/channels/slack.ts", "/") === "agent/channels/slack.ts", "a `/` path is returned unchanged");
  ok(toPosixPath("odd\\name.ts", "/") === "odd\\name.ts", "🔴 a POSIX path holding a literal `\\` is returned unchanged");
  ok(
    posixRelative("/oe/pkg", "/oe/pkg/agent/x.ts", path.posix) === path.posix.relative("/oe/pkg", "/oe/pkg/agent/x.ts"),
    "posixRelative over the posix path API equals bare `relative()`",
  );
  if (path.sep === "/") {
    ok(toPosixPath("a\\b") === "a\\b", "the host default on this POSIX host is the identity");
    ok(posixJoin("packages", "core", "dist") === path.join("packages", "core", "dist"), "posixJoin equals `join()` on this POSIX host");
  } else {
    ok(posixJoin("packages", "core", "dist") === "packages/core/dist", "posixJoin spells a joined key with `/` on this Windows host");
  }
}

{
  const CALL_SITES: ReadonlyArray<readonly [file: string, helper: string, count: number]> = [
    ["scripts/env-docs-lint.ts", "toPosixPath(", 1],
    ["scripts/export-reach-lint.ts", "posixRelative(", 1],
    ["scripts/export-reach-lint.ts", "toPosixPath(", 1],
    ["scripts/manual-compaction-guard-lint.ts", "toPosixPath(", 1],
    ["scripts/consequence-lint.ts", "posixRelative(", 3],
    ["scripts/ambient-env-lint.ts", "posixRelative(", 2],
    ["scripts/deployment-identity-test.ts", "toPosixPath(", 1],
    ["scripts/wake-retry-parity-test.ts", "posixRelative(", 1],
    ["scripts/discord-rest-seam-test.ts", "posixRelative(", 1],
    ["scripts/suite-store-reach-test.ts", "toPosixPath(", 1],
    ["scripts/deploy-test.ts", "toPosixPath(", 1],
    ["tests/integration/prepare-cache.ts", "toPosixPath(", 1],
    ["tests/integration/prepare-cache.ts", "posixJoin(", 2],
    ["packages/core/scripts/principal-gate-lint-test.ts", "posixRelative(", 4],
    ["packages/core/scripts/ingestion-binding-lint-test.ts", "posixRelative(", 1],
    ["packages/core/scripts/external-policy-test.ts", "toPosixPath(", 1],
    ["packages/core/scripts/config-repo-mint-test.ts", "toPosixPath(", 1],
    ["packages/core/scripts/standing-seat-test.ts", "toPosixPath(", 1],
  ];
  const BUNDLE_SITES: ReadonlyArray<readonly [file: string, count: number]> = [
    ["packages/providers/github/scripts/github-write-seam-test.ts", 2],
    ["packages/providers/linear/scripts/linear-write-seam-test.ts", 5],
    ["packages/providers/notion/scripts/notion-write-seam-test.ts", 2],
    ["packages/providers/slack/scripts/slack-web-api-seam-test.ts", 2],
    ["packages/providers/teams/scripts/teams-connector-seam-test.ts", 3],
  ];
  const LOCAL_HELPER = 'const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join("/");';
  const calls = (src: string, helper: string): number => src.split(helper).length - 1;
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const [file, helper, count] of CALL_SITES) {
    const src = readFileSync(path.join(root, file), "utf8");
    const got = calls(src, helper);
    ok(src.includes("posix-path.js") && got === count, `${file} keys its paths through ${helper.slice(0, -1)} at ${count} call site(s) (found ${got})`);
  }
  for (const [file, count] of BUNDLE_SITES) {
    const src = readFileSync(path.join(root, file), "utf8");
    const got = calls(src, "posixRelative(");
    ok(src.includes(LOCAL_HELPER) && got === count, `${file} keys its paths through its local posixRelative at ${count} call site(s) (found ${got})`);
  }
}

console.log(`\n${n} assertions passed`);
