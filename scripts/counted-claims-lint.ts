import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoreDistFresh } from "./core-dist-freshness.js";
import { LEAN_SEAT_TOOLS } from "@open-everywhere/core/agent/access/lean-seat.js";
import {
  WORKER_ONLY_TOOLS_STANDING,
  WORKER_ONLY_TOOLS_THREAD,
} from "@open-everywhere/core/agent/access/worker-capability-index.generated.js";
import { GRANT_REFUND_CAP_PER_TURN } from "@open-everywhere/core/agent/access/credential-grant-broker.js";
import { GRANT_ONCE_MAX_ATTEMPTS_PER_TURN } from "@open-everywhere/core/agent/access/credential-grant-card.js";
import { TOOL_CONSEQUENCE } from "@open-everywhere/core/agent/access/consequence.js";
import { taintToleranceOf } from "@open-everywhere/core/agent/access/approver-chain.js";
import { COUNTED_CLAIMS, COUNTED_FACT_KEYS, checkCountedClaims, type CountedFacts } from "@open-everywhere/core/agent/docs/counted-claims.js";
import { ENV_READ_ALLOWLIST } from "./env-read-allowlist.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

assertCoreDistFresh();

function taintGateSinks(): string[] {
  return Object.keys(TOOL_CONSEQUENCE)
    .filter((tool) => taintToleranceOf(tool) === "gate")
    .sort();
}

function envPendingMigration(): string[] {
  return [...ENV_READ_ALLOWLIST.entries()]
    .filter(([, entry]) => entry.klass === "pending-migration")
    .map(([name]) => name)
    .sort();
}

const facts: CountedFacts = {
  "lean-seat-tools": [...LEAN_SEAT_TOOLS],
  "taint-gate-sinks": taintGateSinks(),
  "worker-only-standing": WORKER_ONLY_TOOLS_STANDING,
  "worker-only-thread": WORKER_ONLY_TOOLS_THREAD,
  "env-pending-migration": envPendingMigration(),
  "grant-refund-cap-per-turn": GRANT_REFUND_CAP_PER_TURN,
  "grant-once-max-attempts-per-turn": GRANT_ONCE_MAX_ATTEMPTS_PER_TURN,
};

const derived = new Set(Object.keys(facts));
const declared = new Set<string>(COUNTED_FACT_KEYS);
const keyDrift = [
  ...[...declared].filter((k) => !derived.has(k)).map((k) => `COUNTED_FACT_KEYS declares "${k}", but this lint derives no such fact`),
  ...[...derived].filter((k) => !declared.has(k)).map((k) => `this lint derives "${k}", which COUNTED_FACT_KEYS does not declare`),
];
if (keyDrift.length > 0) {
  console.error(`✗ counted-claims-lint: fact key drift (${keyDrift.length}):\n` + keyDrift.map((d) => `  - ${d}`).join("\n"));
  process.exit(1);
}

const docs = new Map<string, string>();
for (const path of new Set(COUNTED_CLAIMS.map((c) => c.doc))) {
  try {
    docs.set(path, readFileSync(join(root, path), "utf8"));
  } catch {
  }
}

const report = checkCountedClaims({ facts, docs });

if (report.problems.length > 0) {
  console.error(`✗ counted-claims-lint: ${report.problems.length} problem(s):\n` + report.problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

function factValue(key: string): number {
  const fact = facts[key];
  return typeof fact === "number" ? fact : (fact?.length ?? Number.NaN);
}

console.log(
  `✓ counted-claims-lint: ${report.checked}/${COUNTED_CLAIMS.length} counted claims hold across ${docs.size} document(s) — ` +
    `lean seat ${factValue("lean-seat-tools")}, worker-only standing ${factValue("worker-only-standing")}, ` +
    `worker-only thread ${factValue("worker-only-thread")}, ` +
    `grant refund cap ${factValue("grant-refund-cap-per-turn")}, once-grant attempts ${factValue("grant-once-max-attempts-per-turn")}, ` +
    `taint-gate sinks ${factValue("taint-gate-sinks")}, env knobs pending migration ${factValue("env-pending-migration")}.`,
);
