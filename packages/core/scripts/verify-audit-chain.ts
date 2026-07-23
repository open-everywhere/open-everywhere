import { getOperationalStore } from "../agent/operational/provider.js";
import { findChainBreak } from "../agent/audit/chain.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const onlyOrg = arg("org");
const tailStr = arg("tail");
const tailLimit = tailStr ? Number(tailStr) : undefined;
if (tailStr && (!Number.isFinite(tailLimit) || (tailLimit as number) <= 0)) {
  console.error(`--tail must be a positive integer, got ${JSON.stringify(tailStr)}`);
  process.exit(2);
}

const store = getOperationalStore();
const orgs = onlyOrg ? [onlyOrg] : await store.listAuditOrgs();

console.log(`\nAudit hash-chain verification (${store.id})`);
console.log(`Scope: ${onlyOrg ? `org=${onlyOrg}` : `all orgs (${orgs.length})`}${tailLimit ? `  tail=${tailLimit}` : "  full chain"}`);
console.log("─".repeat(96));

if (orgs.length === 0) {
  console.log("  (no audit entries)");
  console.log();
  process.exit(0);
}

let broken = 0;
for (const org of orgs) {
  const rows = await store.readAuditChain(org, tailLimit ? { tailLimit } : undefined);
  const brk = findChainBreak(rows, { expectGenesis: !tailLimit });
  if (brk) {
    broken++;
    console.log(`  ✗ ${org}: ${rows.length} row(s) — BREAK at seq ${brk.seq} (${brk.ts}, action "${brk.action}")`);
    console.log(`      ${brk.reason}`);
    console.log(`      expected prev_sha: ${brk.expectedPrev ?? "null"}`);
    console.log(`      found    prev_sha: ${brk.actualPrev ?? "null"}`);
  } else {
    console.log(`  ✓ ${org}: ${rows.length} row(s) — chain intact`);
  }
}

console.log("  " + "─".repeat(60));
if (broken > 0) {
  console.log(`  ${broken} org(s) with a broken chain — the audit history may have been altered out of band.`);
  console.log();
  process.exit(1);
}
console.log(`  All ${orgs.length} org chain(s) verified intact.`);
console.log();
process.exit(0);
