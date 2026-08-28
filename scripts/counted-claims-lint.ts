import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoreDistFresh } from "./core-dist-freshness.js";
import { LEAN_SEAT_TOOLS } from "@open-everywhere/core/agent/access/lean-seat.js";
import {
  WORKER_ONLY_TOOLS_STANDING,
  WORKER_ONLY_TOOLS_THREAD,
} from "@open-everywhere/core/agent/access/worker-capability-index.generated.js";
import { SETTINGS } from "@open-everywhere/core/agent/settings/settings.js";
import { COUNTED_CLAIMS, COUNTED_FACT_KEYS, checkCountedClaims, type CountedFacts } from "@open-everywhere/core/agent/docs/counted-claims.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

assertCoreDistFresh();

function settingsEnvSeams(): string[] {
  const out: string[] = [];
  for (const group of Object.values(SETTINGS as Record<string, Record<string, { path: string; env?: string }>>)) {
    for (const spec of Object.values(group)) {
      if (typeof spec.env === "string") out.push(spec.path);
    }
  }
  return out.sort();
}

const facts: CountedFacts = {
  "lean-seat-tools": [...LEAN_SEAT_TOOLS],
  "worker-only-standing": WORKER_ONLY_TOOLS_STANDING,
  "worker-only-thread": WORKER_ONLY_TOOLS_THREAD,
  "settings-env-seams": settingsEnvSeams(),
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

console.log(
  `✓ counted-claims-lint: ${report.checked}/${COUNTED_CLAIMS.length} counted claims hold across ${docs.size} document(s) — ` +
    `lean seat ${facts["lean-seat-tools"]?.length}, worker-only standing ${facts["worker-only-standing"]?.length}, ` +
    `worker-only thread ${facts["worker-only-thread"]?.length}, settings env seams ${facts["settings-env-seams"]?.length}.`,
);
