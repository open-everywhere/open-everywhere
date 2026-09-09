import { AUDIT_CHAIN_EPOCH_ACTION, auditEpochSealFor, breaksByAction, walkAuditChain } from "../agent/audit/chain.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { connectOperatorStoreForCli } from "./operator-store-connect.js";

const USAGE = `
Usage: npm run audit:seal-epoch -- --org X --sealed-by WHO [--go] [--root-env FILE]

  --org X          the tenant whose chain to seal (required — an epoch row is permanent, so the
                   org is never guessed). It also declares the org this operator process acts for.
  --sealed-by WHO  the operator recorded on the marker row (required). A name, not a secret.
  --go             actually append the marker. Without it this is a dry run that writes nothing.
                   The real seal BLOCKS this org's audit appends while it reads the whole chain —
                   seal in a quiet window.
  --root-env FILE  read DATABASE_URL / the store env from FILE (default .env.local)
  --help           print this and exit

Exit codes: 0 sealed, or a dry run that found something to seal · 1 nothing to seal · 2 bad args
            5 the operational store could not be opened or read — nothing was sealed or reported

Without --go this opens the store READ-ONLY, so a dry run appends no row and changes no posture:
an operator investigating a suspected tamper can run it before deciding anything.
`.trimStart();

function argError(message: string): never {
  console.error(`seal-audit-epoch: ${message}\n`);
  console.error(USAGE);
  process.exit(2);
}

const VALUE_FLAGS = new Set(["--org", "--sealed-by", "--root-env"]);
const BOOL_FLAGS = new Set(["--go", "--help", "-h"]);
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
  process.exit(0);
}

const org = values.get("--org");
const sealedBy = values.get("--sealed-by");
if (org === undefined) argError("--org is required.");
if (sealedBy === undefined || sealedBy.trim().length === 0) argError("--sealed-by is required, and must not be blank.");
const go = flags.has("--go");

let target;
try {
  target = await connectOperatorStoreForCli(process.argv, { readOnly: !go });
} catch (err) {
  console.error(`\nseal-audit-epoch: could not open the operational store — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(5);
}
const store = getOperationalStore();

console.log(`\nAudit chain epoch seal (${store.id} — ${target.label})`);
console.log(`Org: ${org}${go ? "" : "   DRY RUN — nothing is written"}`);
console.log("─".repeat(96));

const rows = await (async () => {
  try {
    return await store.readAuditChain(org);
  } catch (err) {
    console.error(`\nseal-audit-epoch: could not read the audit chain of org "${org}" — ${err instanceof Error ? err.message : String(err)}`);
    console.error("NOTHING WAS SEALED, and nothing was reported about the era.\n");
    process.exit(5);
  }
})();
const seal = auditEpochSealFor(rows);
if (seal === null) {
  console.log(
    rows.length === 0
      ? `  Nothing to seal: org "${org}" has no audit rows. Check the org id — a typo seals nothing and reports nothing.`
      : `  Nothing to seal: org "${org}" already ends at an epoch marker (action "${AUDIT_CHAIN_EPOCH_ACTION}"). No rows have been written since it.`,
  );
  console.log();
  process.exit(1);
}

const walk = walkAuditChain(rows, { expectGenesis: true });
console.log(`  Era to seal: ${seal.rowsBefore} row(s), seq ${seal.firstSeqBefore}..${seal.lastSeqBefore}`);
console.log(`  Broken links inside it, recorded on the marker: ${seal.breaksBefore}`);
for (const { action, count } of breaksByAction(walk.breaks).slice(0, 10)) {
  console.log(`      ${String(count).padStart(7)}  ${action}`);
}
console.log(`  Era digest: ${seal.eraDigest}`);
console.log(`  Epochs already in this chain: ${walk.epochs.length}`);

if (!go) {
  console.log("\n  DRY RUN — nothing written. Re-run with --go to append the marker.");
  console.log("  The audit log has no delete: an epoch row is permanent.\n");
  process.exit(0);
}

const written = await store.sealAuditChainEpoch(org, sealedBy);
if (written === null) {
  console.log("\n  Nothing was sealed — the chain changed under this command. Re-run it.\n");
  process.exit(1);
}
console.log(`\n  ✓ Epoch marker appended for org "${org}" at seq ${written.markerSeq}, sealing ${written.seal.rowsBefore} row(s) (${written.seal.breaksBefore} already broken).`);
console.log(`  Verify it: npm run audit:verify-chain -- --org ${org} --accept-epoch ${written.markerSeq}`);
console.log("  The --accept-epoch is required: an epoch nobody vouches for makes the verifier exit 4, because");
console.log("  the marker itself proves only that somebody with INSERT wrote it.");
console.log();
process.exit(0);
