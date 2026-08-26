import { formatInvocation, postCommitStatus } from "./cloud-proof-post-lib.js";
import { parseArgs } from "./lib.js";
import {
  type AttestPlan,
  planFenceLeg,
  type ProtectionState,
  readDefaultBranch,
  readRequiredContexts,
  resolveRepoLabel,
  runProofTransfer,
  UPGRADE_FENCE_CONTEXT,
} from "./merge-attest-lib.js";
import { runMergeFence } from "./merge-fence-lib.js";

const args = parseArgs(process.argv.slice(2));

function usage(problem: string): never {
  console.error(
    `✗ deploy:merge-attest: ${problem}\n` +
      "  npm run deploy:merge-attest -- --pr <number> --fence [--require-protection] [--dry-run]\n" +
      "  npm run deploy:merge-attest -- --pr <number> --transfer --merge-sha <sha> [--dry-run]",
  );
  process.exit(2);
}

const rawPr = args.values.get("pr");
const prNumber = rawPr !== undefined ? Number(rawPr) : NaN;
if (!Number.isInteger(prNumber) || prNumber <= 0) usage("pass the pull request to attest — `--pr <number>`.");

const wantFence = args.flags.has("fence");
const wantTransfer = args.flags.has("transfer");
if (wantFence === wantTransfer) usage("name exactly one leg — `--fence` (before the merge) or `--transfer` (after it).");

const dryRun = args.flags.has("dry-run");
const targetUrl = args.values.get("target-url");

const repo = await resolveRepoLabel({});
console.log(`deploy:merge-attest: ${wantFence ? "--fence" : "--transfer"} on pull request #${prNumber}${repo ? ` in ${repo}` : ""}${dryRun ? " (dry run)" : ""}`);

let plan: AttestPlan;
const advisories: string[] = [];

if (wantFence) {
  const defaultBranch = await readDefaultBranch({});
  if (!defaultBranch) {
    console.error(
      "✗ deploy:merge-attest: could not read the repository's default branch, so this run cannot tell which base refs it may execute a fence from.\n" +
        "  The fence is the BASE ref's own code, run in this session. Nothing was extracted, nothing ran, nothing was posted. DO NOT MERGE.",
    );
    process.exit(1);
  }

  const decision = await runMergeFence({ prNumber, requiredBaseRef: defaultBranch });
  if (decision.detail) console.log(decision.detail);

  const protection: ProtectionState = await readRequiredContexts({ branch: defaultBranch, context: UPGRADE_FENCE_CONTEXT });
  if (protection.kind === "required") {
    advisories.push(`\`${UPGRADE_FENCE_CONTEXT}\` is a required status check on \`${defaultBranch}\` — an unattested head cannot merge.`);
  } else if (protection.kind === "not-required") {
    advisories.push(
      `🔴 \`${UPGRADE_FENCE_CONTEXT}\` is NOT a required status check on \`${defaultBranch}\` (required: ${protection.contexts.join(", ") || "none"}). ` +
        "This attestation is a record, not a gate, until a person adds the rule.",
    );
  } else {
    advisories.push(`🔴 could not confirm the branch protection rule. ${protection.reason}`);
  }

  plan = planFenceLeg({ decision, defaultBranch, protection, requireProtection: args.flags.has("require-protection"), ...(targetUrl ? { targetUrl } : {}) });
} else {
  const mergeSha = args.values.get("merge-sha");
  if (!mergeSha) usage("`--transfer` needs the commit the merge produced — `--merge-sha <sha>`.");
  plan = await runProofTransfer({ prNumber, mergeSha, ...(targetUrl ? { targetUrl } : {}) });
}

for (const line of advisories) console.log(`  ${line}`);

if (plan.kind === "refuse") {
  console.error(`✗ deploy:merge-attest: ${plan.reason}`);
  console.error("  Nothing was posted. DO NOT MERGE.");
  process.exit(1);
}

console.log(`  ${plan.note}`);

if (dryRun) {
  console.log(`${plan.state === "success" ? "✓" : "✗"} deploy:merge-attest (dry run, nothing posted): ${formatInvocation(plan.invocation)}`);
  process.exit(plan.state === "success" ? 0 : 1);
}

const posted = await postCommitStatus(plan.invocation);
if (!posted.ok) {
  console.error(`✗ deploy:merge-attest: could not post \`${plan.context}\` on ${plan.sha.slice(0, 12)} — ${posted.reason}`);
  process.exit(1);
}

if (plan.state === "failure") {
  console.error(`✗ deploy:merge-attest: posted \`${plan.context}\` = failure on ${plan.sha.slice(0, 12)} — ${plan.description}`);
  console.error("  DO NOT MERGE. A guardrail change goes in its own hand-written pull request, opened by a person.");
  process.exit(1);
}

console.log(`✓ deploy:merge-attest: posted \`${plan.context}\` = success on ${plan.sha.slice(0, 12)} — ${plan.description}`);
process.exit(0);
