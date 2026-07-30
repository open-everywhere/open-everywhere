import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildConfigSnapshot } from "./config-snapshot-build.js";
import { accessSideEffectFindings, diffConfigSnapshots, SNAPSHOT_FORMAT_VERSION, type ConfigSnapshot } from "./config-snapshot-diff.js";
import { parseConfigFacts, READABLE_SNAPSHOT_FORMAT_VERSION } from "@open-everywhere/core/agent/review/config-facts.js";
import { computeBlastRadius } from "@open-everywhere/core/agent/review/blast-radius.js";
import { CONFIG_DIFF_TRIGGER_PATHS, CONFIG_DIFF_WORKFLOW_PATH, CONFIG_DIFF_ARTIFACT_NAME, CONFIG_DIFF_JSON_ENTRY, OVERLAY_GATE_ENTRY } from "@open-everywhere/core/agent/review/facts-artifact.js";
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

const workflow = readFileSync(join(root, CONFIG_DIFF_WORKFLOW_PATH), "utf8");

function workflowTriggerPaths(text: string): string[] {
  const start = text.indexOf("\n    paths:");
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of text.slice(start + 1).split("\n").slice(1)) {
    const m = /^\s+- "([^"]+)"\s*$/.exec(line);
    if (m) {
      out.push(m[1]);
      continue;
    }
    if (line.trim().startsWith("#") || line.trim().length === 0) continue;
    break;
  }
  return out;
}

eq(
  workflowTriggerPaths(workflow),
  [...CONFIG_DIFF_TRIGGER_PATHS],
  `🔴 packages/core/agent/review/facts-artifact.ts's CONFIG_DIFF_TRIGGER_PATHS must mirror ${CONFIG_DIFF_WORKFLOW_PATH}'s \`paths:\` filter exactly. ` +
    `They disagree, which means a walkthrough would report "this PR touches no config" (a COMPUTED ABSENCE) for a PR the gate actually runs on — ` +
    `the exact green-produced-by-blindness the whole flow refuses`,
);

ok(workflow.includes(`name: ${CONFIG_DIFF_ARTIFACT_NAME}`), `the workflow still uploads an artifact named "${CONFIG_DIFF_ARTIFACT_NAME}"`);
ok(workflow.includes(`/tmp/${CONFIG_DIFF_JSON_ENTRY}`), `…containing ${CONFIG_DIFF_JSON_ENTRY} (the machine-readable facts the walkthrough reads)`);
ok(workflow.includes(`/tmp/${OVERLAY_GATE_ENTRY}`), `…and ${OVERLAY_GATE_ENTRY} (the overlay single-scope gate's own report)`);
ok(/on:\s*\n\s*pull_request:/.test(workflow), "🔴 the gate still triggers on `pull_request`, never `pull_request_target` (AGENTS.md's CI invariant)");
ok(!/^\s*pull_request_target\s*:/m.test(workflow), "…and `pull_request_target` appears nowhere as an event key (a fork PR must not run with repo write scope)");
ok(
  workflow.includes("--json /tmp/config-diff.json"),
  "the workflow still asks scripts/config-diff.ts for the `--json` document — without it the artifact carries only prose and no walkthrough can be built",
);

ok(
  SNAPSHOT_BLIND_SPOTS.every((b) => b.gloss.trim().length > 40),
  "every mirrored limit carries a real gloss — a headline alone tells a reviewer nothing about what they cannot see",
);

console.log(`pr-walkthrough-facts-test: ${passed} assertions passed`);
