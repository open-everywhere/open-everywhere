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
import {
  buildConfigDiffStatusDescription,
  CONFIG_DIFF_STATUS_CONTEXT,
  configFactsDigest,
  isAllowedFactsDocumentUrl,
  parseConfigDiffStatusDescription,
} from "@open-everywhere/core/agent/review/facts-cloud-status.js";
import { FACTS_LABEL, renderWalkthrough, SNAPSHOT_BLIND_SPOTS } from "@open-everywhere/core/agent/review/pr-walkthrough.js";

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

const CLOUD_HEAD = "a".repeat(40);
const cloudDigest = configFactsDigest(wire);
const cloudUrl = `https://raw.githubusercontent.com/example/repo/${CLOUD_HEAD}/config-diff.json`;

function cloudFetch(statuses: unknown[], body: string): ArtifactFetchFn {
  return async (url: string) => {
    if (url.includes("/actions/runs")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ workflow_runs: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url.includes("/statuses")) {
      return { ok: true, status: 200, text: async () => "", json: async () => statuses, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, text: async () => body, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

const goodStatus = {
  context: CONFIG_DIFF_STATUS_CONTEXT,
  description: buildConfigDiffStatusDescription({ digest: cloudDigest, sessionId: "session_test" }),
  target_url: cloudUrl,
  updated_at: "2026-09-10T00:00:00Z",
  creator: { login: "oe-orchestrator" },
};

ok(buildConfigDiffStatusDescription({ digest: cloudDigest, sessionId: "session_test" }).length <= 140, "the status description fits GitHub's 140-byte cap, so the digest is never the part that gets cut");
eq(
  parseConfigDiffStatusDescription(goodStatus.description),
  { digest: cloudDigest, sessionId: "session_test" },
  "the description the publisher writes round-trips through the parser the consumer reads it with",
);

const viaStatus = await fetchConfigFacts({
  repo: "example/repo",
  headSha: CLOUD_HEAD,
  token: "not-a-real-token",
  changedPaths: ["agent/access/bundles.ts"],
  fetchFn: cloudFetch([goodStatus], wire),
});

eq(viaStatus.kind, "cloud-status", "🔴 with NO Actions run but a vouching `oe/config-diff` status, the facts are REAL — this is the half-dark state OPE-1683 closed");
ok(viaStatus.kind === "cloud-status" && viaStatus.provenance.digest === cloudDigest, "…and the provenance carries the digest the status named, so a reader can re-hash the document themselves");
ok(viaStatus.kind === "cloud-status" && viaStatus.provenance.documentUrl === cloudUrl, "…and the checkable link to the exact bytes");
ok(viaStatus.kind === "cloud-status" && viaStatus.provenance.sessionId === "session_test", "…and the cloud run whose transcript produced them");
ok(viaStatus.kind === "cloud-status" && computeBlastRadius(viaStatus.facts).widens, "…and the facts really are the facts: the same blast radius ② computed comes out of the status lane");

const rendered = renderWalkthrough({
  pr: { repo: "example/repo", number: 7, url: "https://github.com/example/repo/pull/7", title: "config change", stateLabel: "open", baseRef: "main", headSha: CLOUD_HEAD },
  diff: { repo: "example/repo", number: 7, headSha: CLOUD_HEAD, baseRef: "main", diff: "diff --git a/agent/access/bundles.ts b/agent/access/bundles.ts", diffClipped: false, diffChars: 60, files: ["agent/access/bundles.ts"], filesCapped: false },
  facts: viaStatus,
});
ok(rendered.includes(FACTS_LABEL), "the rendered walkthrough carries the 🧮 FACTS heading (it always does — the legs below are what prove the section is FILLED)");
ok(
  !rendered.includes("establishes NOTHING about what this PR changes"),
  "🔴 the facts section is FILLED, not the empty-state sentence — the two-toned design's facts tone, which never appeared on this repo's own PRs before",
);
ok(rendered.includes(gainedHost), `…and it prints the row that actually moved (${gainedHost}), so the section is this document's facts and not a heading over nothing`);
ok(/widens/u.test(rendered) && rendered.includes("`widens: YES`"), "…and the blast radius is COMPUTED from them rather than reported as not-computable");
ok(rendered.includes(CONFIG_DIFF_STATUS_CONTEXT), "…and the source line names the commit status it came from, so the provenance is checkable rather than asserted");
ok(rendered.includes(`sha256:${cloudDigest}`), "…and prints the digest the bytes were verified against");
ok(rendered.includes("statuses: write"), "…and §5 states what a commit status does NOT establish — anyone who can write one could vouch for other bytes");

const staleAsk = renderWalkthrough({
  pr: { repo: "example/repo", number: 7, url: "https://github.com/example/repo/pull/7", title: "config change", stateLabel: "open", baseRef: "main", headSha: CLOUD_HEAD },
  diff: { repo: "example/repo", number: 7, headSha: CLOUD_HEAD, baseRef: "main", diff: "diff --git a/agent/access/bundles.ts b/agent/access/bundles.ts", diffClipped: false, diffChars: 60, files: ["agent/access/bundles.ts"], filesCapped: false },
  facts: viaStatus,
  expectedFactsRunId: 4242,
});
ok(staleAsk.includes("UNPERFORMED, not passed"), "🔴 a staleness check that was ASKED FOR and could not run says so on the document — silence there is indistinguishable from a check that passed");
ok(staleAsk.includes("4242"), "…naming the run the narration was produced against, so a reader can go and compare");
ok(!rendered.includes("UNPERFORMED, not passed"), "NEGATIVE: a caller that asked for no staleness check gets no such line — the sentence marks a real unperformed check, not every status-lane render");

const swapped = await fetchConfigFacts({
  repo: "example/repo",
  headSha: CLOUD_HEAD,
  token: "not-a-real-token",
  changedPaths: ["agent/access/bundles.ts"],
  fetchFn: cloudFetch([goodStatus], `${wire} `),
});
eq(swapped.kind, "unavailable", "🔴 bytes that do not hash to the vouched digest are REFUSED — this is what makes the hosting location untrusted");
ok(swapped.kind === "unavailable" && swapped.reason.includes(cloudDigest), "…and the reason names the digest that was vouched for, so a swap is diagnosable");

const offRepo = await fetchConfigFacts({
  repo: "example/repo",
  headSha: CLOUD_HEAD,
  token: "not-a-real-token",
  changedPaths: ["agent/access/bundles.ts"],
  fetchFn: cloudFetch([{ ...goodStatus, target_url: "https://evil.example.invalid/config-diff.json" }], wire),
});
eq(offRepo.kind, "unavailable", "a status pointing off-repo is refused before the host is dialled at all");

const noDigest = await fetchConfigFacts({
  repo: "example/repo",
  headSha: CLOUD_HEAD,
  token: "not-a-real-token",
  changedPaths: ["agent/access/bundles.ts"],
  fetchFn: cloudFetch([{ ...goodStatus, description: "config diff ran, all good" }], wire),
});
eq(noDigest.kind, "unavailable", "🔴 a status that names no digest vouches for no particular bytes — its EXISTENCE is never read as facts");

const noStatus = await fetchConfigFacts({
  repo: "example/repo",
  headSha: CLOUD_HEAD,
  token: "not-a-real-token",
  changedPaths: ["agent/access/bundles.ts"],
  fetchFn: cloudFetch([], wire),
});
eq(noStatus.kind, "unavailable", "with neither provenance the answer is still an UNKNOWN");
ok(
  noStatus.kind === "unavailable" && noStatus.reason.includes(CONFIG_DIFF_WORKFLOW_PATH) && noStatus.reason.includes(CONFIG_DIFF_STATUS_CONTEXT),
  "…and it names BOTH lanes, so an operator on a repo with no workflow is not sent looking for a run that can never exist",
);

ok(!isAllowedFactsDocumentUrl("http://raw.githubusercontent.com/example/repo/x.json", "example/repo"), "the URL fence refuses plain http");
ok(!isAllowedFactsDocumentUrl("https://raw.githubusercontent.com/other/repo/x.json", "example/repo"), "…and a GitHub host serving ANOTHER repository");
ok(isAllowedFactsDocumentUrl("https://api.github.com/repos/example/repo/releases/assets/1", "example/repo"), "…and accepts the API host serving this one");

ok(
  SNAPSHOT_BLIND_SPOTS.every((b) => b.gloss.trim().length > 40),
  "every mirrored limit carries a real gloss — a headline alone tells a reviewer nothing about what they cannot see",
);

console.log(`pr-walkthrough-facts-test: ${passed} assertions passed`);
