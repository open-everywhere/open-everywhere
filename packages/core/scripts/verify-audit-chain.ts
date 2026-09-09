import { getOperationalStore } from "../agent/operational/provider.js";
import { breaksByAction, walkAuditChain, type ChainBreak } from "../agent/audit/chain.js";
import { connectOperatorStoreForCli } from "./operator-store-connect.js";

const EXIT_OK = 0;
const EXIT_BROKEN = 1;
const EXIT_ARGS = 2;
const EXIT_NOTHING_VERIFIED = 3;
const EXIT_UNACKNOWLEDGED_EPOCH = 4;
const EXIT_STORE_UNREACHABLE = 5;

const USAGE = `
Usage: npm run audit:verify-chain -- [--org X] [--tail N] [--require-rows] [--root-env FILE]

  --org X         verify only org X (default: every org present in the log). It also declares
                  the org this operator process acts for, so a non-"default" tenant is reached
                  with one flag.
  --tail N        verify only the last N links per org (N a positive integer). A window that
                  starts mid-chain skips the genesis assertion; a window larger than the
                  chain is the whole chain, so the assertion applies.
  --require-rows  treat a scope that matched zero rows as a failure, on any scope
  --root-env FILE read DATABASE_URL / the store env from FILE (default .env.local)
  --max-detail N  print at most N broken links in full (default 20)
  --accept-epoch S  acknowledge the sealed chain epoch at seq S. Repeat the flag once per epoch.
                  An epoch nobody named is exit 4 — the marker is not authenticated, so only an
                  operator can vouch for it.
  --help          print this and exit

This command appends no row and changes no posture: it opens the store read-only. On the embedded
floor that also means no schema is created, so a data dir no writer has ever opened is exit 5.

Every broken link is COUNTED and broken links are summarised per action; --max-detail only caps
how many are printed in full.

Exit codes:
  0  every chain in scope verified intact, or a bare all-orgs scan of an empty log
  1  at least one org's chain is BROKEN
  2  argument error
  3  nothing was verified — the scope matched zero rows
  4  an unacknowledged sealed epoch was crossed — pass --accept-epoch <seq> to vouch for it
  5  the operational store could not be opened or read — no verdict was produced

A named --org that matches zero rows is exit 3, never a green "chain intact": the operator
asserted that org exists. A bare all-orgs scan asserts nothing, so an empty log is exit 0 —
pass --require-rows in a CI or cron guard, where an emptied audit log is itself the alarm.
`.trimStart();

function argError(message: string): never {
  console.error(`verify-audit-chain: ${message}\n`);
  console.error(USAGE);
  process.exit(EXIT_ARGS);
}

const VALUE_FLAGS = new Set(["--org", "--tail", "--root-env", "--max-detail"]);
const MULTI_FLAGS = new Set(["--accept-epoch"]);
const BOOL_FLAGS = new Set(["--require-rows", "--help", "-h"]);

const values = new Map<string, string>();
const flags = new Set<string>();
const acceptedEpochs = new Set<number>();
const argv = process.argv.slice(2);

for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (BOOL_FLAGS.has(token)) {
    flags.add(token);
    continue;
  }
  if (MULTI_FLAGS.has(token)) {
    const value = argv[i + 1];
    if (value === undefined) argError(`${token} needs a value, but the arguments end there.`);
    if (value.startsWith("--")) argError(`${token} needs a value, but the next argument is the flag ${value}.`);
    const seq = Number(value);
    if (!Number.isSafeInteger(seq) || seq < 0) argError(`${token} takes a row seq (a non-negative integer), got ${JSON.stringify(value)}.`);
    acceptedEpochs.add(seq);
    i++;
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
  if (eq > 0 && (VALUE_FLAGS.has(token.slice(0, eq)) || MULTI_FLAGS.has(token.slice(0, eq)))) {
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

function positiveInt(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) argError(`${flag} must be a positive integer, got ${JSON.stringify(raw)}.`);
  return parsed;
}

const tailLimit = positiveInt("--tail", values.get("--tail"));
const maxDetail = positiveInt("--max-detail", values.get("--max-detail")) ?? 20;

let target;
try {
  target = await connectOperatorStoreForCli(process.argv, { readOnly: true });
} catch (err) {
  console.error(`\nverify-audit-chain: could not open the operational store — ${err instanceof Error ? err.message : String(err)}`);
  console.error("NOTHING WAS READ. This is not a statement about the chain.\n");
  process.exit(EXIT_STORE_UNREACHABLE);
}
const store = getOperationalStore();

async function readOrExit<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.error(`\nverify-audit-chain: could not read ${what} — ${err instanceof Error ? err.message : String(err)}`);
    console.error("NO VERDICT WAS PRODUCED. This is not a statement about the chain.\n");
    process.exit(EXIT_STORE_UNREACHABLE);
  }
}

const orgs = onlyOrg ? [onlyOrg] : await readOrExit("the list of orgs in the audit log", () => store.listAuditOrgs());

console.log(`\nAudit hash-chain verification (${store.id} — ${target.label})`);
console.log(`Scope: ${onlyOrg ? `org=${onlyOrg}` : `all orgs (${orgs.length})`}${tailLimit ? `  tail=${tailLimit}` : "  full chain"}`);
console.log("─".repeat(96));

let brokenOrgs = 0;
let verifiedOrgs = 0;
let rowsWalked = 0;
let totalBreaks = 0;
let totalEpochs = 0;
let unacknowledgedEpochs = 0;
const allBreaks: ChainBreak[] = [];

function printBreak(brk: ChainBreak): void {
  console.log(`      seq ${brk.seq} (${brk.ts}, action "${brk.action}"): ${brk.reason}`);
  console.log(`          expected prev_sha: ${brk.expectedPrev ?? "null"}`);
  console.log(`          found    prev_sha: ${brk.actualPrev ?? "null"}`);
}

for (const org of orgs) {
  const rows = await readOrExit(`the audit chain of org "${org}"`, () => store.readAuditChain(org, tailLimit ? { tailLimit } : undefined));
  if (rows.length === 0) {
    console.log(`  ⚠ ${org}: 0 rows matched — NOTHING VERIFIED (this org has no audit rows)`);
    continue;
  }
  rowsWalked += rows.length;
  const wholeChain = tailLimit === undefined || rows.length < tailLimit;
  const walk = walkAuditChain(rows, { expectGenesis: wholeChain });
  totalEpochs += walk.epochs.length;
  for (const e of walk.epochs) {
    const acknowledged = acceptedEpochs.has(e.seq);
    if (!acknowledged) unacknowledgedEpochs++;
    const state = e.sealVerified
      ? "seal VERIFIED against the era it covers"
      : wholeChain
        ? "seal DOES NOT match the era it covers"
        : "seal not checked — a --tail window does not hold the era";
    console.log(
      `  ◆ ${org}: sealed chain epoch at seq ${e.seq} (${e.ts}) — covers ${e.seal.rowsBefore} earlier row(s), ` +
        `seq ${e.seal.firstSeqBefore ?? "-"}..${e.seal.lastSeqBefore ?? "-"}, ${e.seal.breaksBefore} of them already broken when sealed. ${state}.`,
    );
    if (!acknowledged) {
      console.log(
        `      ⚠ NOT ACKNOWLEDGED. The marker is not authenticated — anyone who can INSERT one row can write a seal that verifies. ` +
          `Vouch for this one with --accept-epoch ${e.seq}, or investigate who wrote it.`,
      );
    }
  }
  if (walk.breaksInsideSealedEra > 0) {
    console.log(
      `      ${walk.breaksInsideSealedEra} link break(s) inside the sealed era are covered by the seal, not listed. ` +
        "Those rows carry ERA-DIGEST evidence dated to the seal, not link evidence.",
    );
  }
  if (walk.breaks.length > 0) {
    brokenOrgs++;
    totalBreaks += walk.breaks.length;
    allBreaks.push(...walk.breaks);
    console.log(`  ✗ ${org}: ${rows.length} row(s) — ${walk.breaks.length} BROKEN LINK(S)`);
    for (const brk of walk.breaks.slice(0, maxDetail)) printBreak(brk);
    if (walk.breaks.length > maxDetail) {
      console.log(`      … ${walk.breaks.length - maxDetail} more not printed (raise --max-detail to see them; the counts below are complete)`);
    }
  } else if (walk.breaksInsideSealedEra > 0) {
    console.log(`  ○ ${org}: ${rows.length} row(s) — no broken link OUTSIDE the sealed era (see the epoch line above)`);
  } else if (walk.epochs.some((e) => !acceptedEpochs.has(e.seq))) {
    console.log(`  ○ ${org}: ${rows.length} row(s) — no broken link, but the epoch above is NOT acknowledged`);
  } else {
    verifiedOrgs++;
    console.log(`  ✓ ${org}: ${rows.length} row(s) — chain intact`);
  }
}

console.log("  " + "─".repeat(60));

if (totalBreaks > 0) {
  console.log(`  ${totalBreaks} broken link(s) across ${brokenOrgs} org(s), out of ${rowsWalked} row(s) walked.`);
  console.log("  Broken links by action — a write-side fork concentrates, a tamper does not:");
  for (const { action, count } of breaksByAction(allBreaks)) {
    console.log(`      ${String(count).padStart(7)}  ${action}`);
  }
  console.log("  The audit history may have been altered out of band, or two writers forked the chain.");
  console.log("  See docs/security/audit-and-provenance.md for how to tell the two apart.");
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

if (totalEpochs > 0) console.log(`  ${totalEpochs} sealed epoch(s) crossed — listed above.`);

if (unacknowledgedEpochs > 0) {
  console.log(`  ${unacknowledgedEpochs} sealed epoch(s) were NOT acknowledged — this run does not certify the chain.`);
  console.log("  Name each one with --accept-epoch <seq> once you know who sealed it, then re-run.");
  console.log();
  process.exit(EXIT_UNACKNOWLEDGED_EPOCH);
}

console.log(`  All ${verifiedOrgs} org chain(s) verified intact (${rowsWalked} row(s) walked).`);
console.log();
process.exit(EXIT_OK);
