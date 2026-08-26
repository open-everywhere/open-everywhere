import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildConfigSnapshot } from "./config-snapshot-build.js";
import { accessSideEffectFindings, diffConfigSnapshots, SNAPSHOT_FORMAT_VERSION, type ConfigSnapshot } from "./config-snapshot-diff.js";
import { parseConfigFacts, READABLE_SNAPSHOT_FORMAT_VERSION } from "@open-everywhere/core/agent/review/config-facts.js";
import { computeBlastRadius } from "@open-everywhere/core/agent/review/blast-radius.js";
import {
  CONFIG_DIFF_TRIGGER_PATHS,
  CONFIG_DIFF_WORKFLOW_PATH,
  fetchConfigFacts,
  pathMatchesGlob,
  triggersConfigDiff,
  type ArtifactFetchFn,
} from "@open-everywhere/core/agent/review/facts-artifact.js";
import { SNAPSHOT_BLIND_SPOTS } from "@open-everywhere/core/agent/review/pr-walkthrough.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label}\n    actual:   ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

ok(
  READABLE_SNAPSHOT_FORMAT_VERSION === SNAPSHOT_FORMAT_VERSION,
  `🔴 the consumer reads snapshot row-encoding v${READABLE_SNAPSHOT_FORMAT_VERSION} but the producer emits v${SNAPSHOT_FORMAT_VERSION} — ` +
    `every walkthrough would refuse the artifact. Bump READABLE_SNAPSHOT_FORMAT_VERSION in packages/core/agent/review/config-facts.ts ` +
    `only after checking the blast-radius reading still parses the new key/value grammar`,
);

const head = buildConfigSnapshot(join(root, "agent"));
ok(head.rows.length > 0, "the real config snapshot has rows (if not, the rest of this file proves nothing)");

const accessRow = head.rows.find((r) => r.section === "access" && r.key.endsWith(" · hosts") && r.value.startsWith("["));
ok(accessRow !== undefined, "the real snapshot has a set-shaped `access · hosts` row — the shape the blast-radius reading decomposes");

const gainedHost = "api.example-oe-test.invalid";
const base: ConfigSnapshot = {
  ...head,
  rows: head.rows.map((r) => (r.key === accessRow!.key ? { ...r, value: `[${gainedHost}]` } : r)),
};

const diff = diffConfigSnapshots(base, head);
const withFindings = { ...diff, findings: [...diff.findings, ...accessSideEffectFindings(diff, ["agent/access/bundles.ts"])] };

const wire = JSON.stringify({ base, baseFailure: null, head, diff: withFindings, changedFiles: ["agent/access/bundles.ts"] }, null, 2);

const parsed = parseConfigFacts(wire);
ok(parsed.ok, `🔴 a facts document built by the REAL producer must parse through the REAL consumer — it did not: ${parsed.ok ? "" : parsed.reason}`);
if (!parsed.ok) process.exit(1);

eq(parsed.facts.formatVersion, SNAPSHOT_FORMAT_VERSION, "the parsed facts carry the producer's row-encoding version");
eq(parsed.facts.changedFiles, ["agent/access/bundles.ts"], "the parsed facts carry the changed-file list the producer recorded");
eq(parsed.facts.baseFailure, undefined, "a producer `baseFailure: null` becomes undefined, not the string 'null'");
eq(
  parsed.facts.sections.map((s) => s.section).sort(),
  head.sections.map((s) => s).sort(),
  "every section the producer declares survives into the consumer's view (a dropped section would render as a silent green)",
);

const br = computeBlastRadius(parsed.facts);
ok(br.widens, "🔴 the real end-to-end path reports `widens` for a scope that gained a host — the row grammar, the wire shape and the reading all agree");
const scope = accessRow!.key.split(" · ")[0];
const scopeDelta = br.scopes.find((s) => s.scope === scope);
ok(scopeDelta !== undefined, `the gain is attributed to the real scope key "${scope}" — the ` + "` · `" + " separator parses identically on both sides");
ok(
  scopeDelta!.lost.some((l) => l.item === gainedHost),
  "…and the removed host is reported as a loss, so the decomposition is not just detecting 'something moved'",
);
ok(scopeDelta!.gained.length > 0, "…and the real hosts are reported as gains");

const blindDiff = diffConfigSnapshots(undefined, head, { baseFailure: "`npm ci` failed in the base checkout" });
const blindWire = JSON.stringify({ base: null, baseFailure: "`npm ci` failed in the base checkout", head, diff: blindDiff, changedFiles: null }, null, 2);
const blindParsed = parseConfigFacts(blindWire);
ok(blindParsed.ok, "a base-unavailable facts document parses (it is a first-class outcome, not a malformed one)");
ok(blindParsed.ok && blindParsed.facts.sections.every((s) => s.kind === "not-computable"), "…with EVERY section not-computable");
ok(blindParsed.ok && blindParsed.facts.baseFailure?.includes("npm ci") === true, "…and the producer's own reason carried through verbatim");
ok(blindParsed.ok && blindParsed.facts.changedFiles === undefined, "…and a null changed-file list stays UNKNOWN rather than becoming an empty list");
const blindBr = computeBlastRadius(blindParsed.ok ? blindParsed.facts : parsed.facts);
ok(!blindBr.widens, "a fully-blind facts document does not report widens…");
ok(blindBr.notComputable.length === head.sections.length, "…and reports every section as not-computable, so the render cannot show a green");

let trackedFiles: string[];
try {
  trackedFiles = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
} catch (err) {
  console.error(`✗ \`git ls-files\` failed in ${root}, so no glob below can be joined to anything: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
ok(trackedFiles.length > 0, "`git ls-files` lists this repo's tracked files (if not, every join below proves nothing)");

for (const glob of CONFIG_DIFF_TRIGGER_PATHS) {
  ok(
    trackedFiles.some((f) => pathMatchesGlob(f, glob)),
    `🔴 CONFIG_DIFF_TRIGGER_PATHS names "${glob}", and no tracked file matches it. A glob that can never match does not widen ` +
      `the trigger set — it narrows it silently: a walkthrough reports "this PR touches no config" (a COMPUTED ABSENCE) for a PR ` +
      `whose config it simply stopped looking at. Drop the entry in packages/core/agent/review/facts-artifact.ts, or restore the path`,
  );
}

ok(triggersConfigDiff(["agent/access/bundles.ts"]), "a PR touching the deployer's own config triggers a config diff");
ok(triggersConfigDiff(["scripts/config-diff.ts"]), "…as does a PR touching the producer itself");
ok(!triggersConfigDiff(["packages/core/agent/tools/reply.ts", "docs/README.md"]), "…and a pure code/docs PR does NOT (the computed absence this list exists to compute)");

ok(
  !existsSync(join(root, CONFIG_DIFF_WORKFLOW_PATH)),
  `${CONFIG_DIFF_WORKFLOW_PATH} exists again. facts-artifact.ts accepts a run of exactly that workflow as its only producer, so the ` +
    `walkthrough's facts lane is live once more — re-bind this leg to the workflow's \`paths:\` filter and artifact contract before ` +
    `trusting a walkthrough's facts section`,
);

for (const script of ["scripts/deploy/cloud-proof-verify.ts", "scripts/deploy/cloud-proof-post.ts", "scripts/deploy/ci-gate.ts"]) {
  ok(existsSync(join(root, script)), `the merge gate that replaced the Actions lane still ships ${script}`);
}

const noProducerFetch: ArtifactFetchFn = async () => ({
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({ workflow_runs: [{ id: 1, path: ".github/workflows/other.yml", event: "pull_request", head_sha: "deadbeefdeadbeef" }] }),
  arrayBuffer: async () => new ArrayBuffer(0),
});

const dormant = await fetchConfigFacts({
  repo: "example/repo",
  headSha: "deadbeefdeadbeef",
  token: "not-a-real-token",
  changedPaths: ["agent/access/bundles.ts"],
  fetchFn: noProducerFetch,
});

eq(dormant.kind, "unavailable", "🔴 with no run of the config-diff workflow, the facts are UNAVAILABLE — an unknown, never an `artifact` and never a silent green");
ok(
  dormant.kind === "unavailable" && dormant.reason.includes(CONFIG_DIFF_WORKFLOW_PATH),
  `…and the reason names ${CONFIG_DIFF_WORKFLOW_PATH}, so a reader learns WHICH producer did not run`,
);
ok(
  dormant.kind === "unavailable" && /NOT established/i.test(dormant.reason),
  "…and states the facts are not established, so the render cannot show the absence as an all-clear",
);

ok(
  SNAPSHOT_BLIND_SPOTS.every((b) => b.gloss.trim().length > 40),
  "every mirrored limit carries a real gloss — a headline alone tells a reviewer nothing about what they cannot see",
);

console.log(`pr-walkthrough-facts-test: ${passed} assertions passed`);
