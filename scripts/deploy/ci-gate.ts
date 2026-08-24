import { runCiGate } from "./ci-gate-lib.js";
import { currentCommit, parseArgs } from "./lib.js";

const args = parseArgs(process.argv.slice(2));

const sha = args.values.get("sha") ?? (await currentCommit());
if (!sha) {
  console.error("✗ deploy:ci-gate: could not resolve a sha to check (no --sha given, and `git rev-parse HEAD` failed).");
  process.exit(2);
}

const isTip = !args.flags.has("not-tip");
const decision = await runCiGate({ sha, isTip });

if (decision.verdict === "pass") {
  console.log(`✓ deploy:ci-gate: ${decision.message}`);
  process.exit(0);
}

console.error(`✗ deploy:ci-gate: ${decision.message}`);
process.exit(1);
