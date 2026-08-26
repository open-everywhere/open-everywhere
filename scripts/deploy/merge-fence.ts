import { parseArgs } from "./lib.js";
import { runMergeFence } from "./merge-fence-lib.js";
import { currentCommit } from "./lib.js";

const args = parseArgs(process.argv.slice(2));

const rawPr = args.values.get("pr");
const prNumber = rawPr !== undefined ? Number(rawPr) : NaN;
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  console.error("✗ deploy:merge-fence: pass the pull request to judge — `npm run deploy:merge-fence -- --pr <number>`.");
  process.exit(2);
}

const expectedHeadSha = args.values.get("sha") ?? (await currentCommit());
if (!expectedHeadSha) {
  console.error(
    "✗ deploy:merge-fence: could not resolve the head sha to clear (no --sha given, and `git rev-parse HEAD` failed).\n" +
      "  This rung refuses to run without it: the head-sha check is what stops it clearing a sha it did not judge.\n" +
      "  Remedy: pass `--sha <the sha you are about to merge>` explicitly.",
  );
  process.exit(2);
}

const decision = await runMergeFence({ prNumber, expectedHeadSha });

if (decision.detail) console.log(decision.detail);

if (decision.verdict === "clear") {
  console.log(`✓ deploy:merge-fence: ${decision.message}`);
  process.exit(0);
}

console.error(`✗ deploy:merge-fence: ${decision.message}`);
process.exit(1);
