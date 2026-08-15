import { getOperationalStore } from "../agent/operational/provider.js";
import { findChainBreak } from "../agent/audit/chain.js";

const EXIT_OK = 0;
const EXIT_BROKEN = 1;
const EXIT_ARGS = 2;
const EXIT_NOTHING_VERIFIED = 3;

const USAGE = `
Usage: npx tsx scripts/verify-audit-chain.ts [--org X] [--tail N] [--require-rows]

  --org X         verify only org X (default: every org present in the log)
  --tail N        verify only the last N links per org (N a positive integer). A window that
                  starts mid-chain skips the genesis assertion; a window larger than the
                  chain is the whole chain, so the assertion applies.
  --require-rows  treat a scope that matched zero rows as a failure, on any scope
  --help          print this and exit

Exit codes:
  0  every chain in scope verified intact, or a bare all-orgs scan of an empty log
  1  at least one org's chain is BROKEN
  2  argument error
  3  nothing was verified — the scope matched zero rows

A named --org that matches zero rows is exit 3, never a green "chain intact": the operator
asserted that org exists. A bare all-orgs scan asserts nothing, so an empty log is exit 0 —
pass --require-rows in a CI or cron guard, where an emptied audit log is itself the alarm.
`.trimStart();

function argError(message: string): never {
  console.error(`verify-audit-chain: ${message}\n`);
  console.error(USAGE);
  process.exit(EXIT_ARGS);
}

const VALUE_FLAGS = new Set(["--org", "--tail"]);
const BOOL_FLAGS = new Set(["--require-rows", "--help", "-h"]);

const values = new Map<string, string>();
const flags = new Set<string>();
const argv = process.argv.slice(2);

for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (BOOL_FLAGS.has(token)) {
    flags.add(token);
    continue;
  }
  if (VALUE_FLAGS.has(token)) {
    if (values.has(token)) argError(`${token} was given more than once.`);
    const value = argv[i + 1];
    if (value === undefined) argError(`${token} needs a value, but the arguments end there.`);
    if (value.startsWith("--")) argError(`${token} needs a value, but the next argument is the flag ${value}.`);
    values.set(token, value);
    i++;
    continue;
  }
  const eq = token.indexOf("=");
  if (eq > 0 && VALUE_FLAGS.has(token.slice(0, eq))) {
    argError(`unknown argument ${JSON.stringify(token)}. Write the value as a separate argument: ${token.slice(0, eq)} ${token.slice(eq + 1)}`);
  }
  argError(`unknown argument ${JSON.stringify(token)}.`);
}

if (flags.has("--help") || flags.has("-h")) {
  console.log(USAGE);
  process.exit(EXIT_OK);
}

const onlyOrg = values.get("--org");
const requireRows = flags.has("--require-rows");

let tailLimit: number | undefined;
const tailStr = values.get("--tail");
if (tailStr !== undefined) {
  const parsed = Number(tailStr);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    argError(`--tail must be a positive integer, got ${JSON.stringify(tailStr)}.`);
  }
  tailLimit = parsed;
}

const store = getOperationalStore();
const orgs = onlyOrg ? [onlyOrg] : await store.listAuditOrgs();

console.log(`\nAudit hash-chain verification (${store.id})`);
console.log(`Scope: ${onlyOrg ? `org=${onlyOrg}` : `all orgs (${orgs.length})`}${tailLimit ? `  tail=${tailLimit}` : "  full chain"}`);
console.log("─".repeat(96));

let broken = 0;
let verifiedOrgs = 0;
let rowsWalked = 0;

for (const org of orgs) {
  const rows = await store.readAuditChain(org, tailLimit ? { tailLimit } : undefined);
  if (rows.length === 0) {
    console.log(`  ⚠ ${org}: 0 rows matched — NOTHING VERIFIED (this org has no audit rows)`);
    continue;
  }
  rowsWalked += rows.length;
  const wholeChain = tailLimit === undefined || rows.length < tailLimit;
  const brk = findChainBreak(rows, { expectGenesis: wholeChain });
  if (brk) {
    broken++;
    console.log(`  ✗ ${org}: ${rows.length} row(s) — BREAK at seq ${brk.seq} (${brk.ts}, action "${brk.action}")`);
    console.log(`      ${brk.reason}`);
    console.log(`      expected prev_sha: ${brk.expectedPrev ?? "null"}`);
    console.log(`      found    prev_sha: ${brk.actualPrev ?? "null"}`);
  } else {
    verifiedOrgs++;
    console.log(`  ✓ ${org}: ${rows.length} row(s) — chain intact`);
  }
}

console.log("  " + "─".repeat(60));

if (broken > 0) {
  console.log(`  ${broken} org(s) with a broken chain — the audit history may have been altered out of band.`);
  console.log();
  process.exit(EXIT_BROKEN);
}

if (rowsWalked === 0) {
  console.log("  0 rows matched — NOTHING WAS VERIFIED. This is not a clean bill of health.");
  if (onlyOrg) {
    console.log(`  Org "${onlyOrg}" has no audit rows. Check the org id, or list the orgs that do: run without --org.`);
  } else {
    console.log("  The audit log is empty — expected on a fresh deployment, an alarm on a live one.");
  }
  console.log();
  process.exit(onlyOrg !== undefined || requireRows ? EXIT_NOTHING_VERIFIED : EXIT_OK);
}

console.log(`  All ${verifiedOrgs} org chain(s) verified intact (${rowsWalked} row(s) walked).`);
console.log();
process.exit(EXIT_OK);
