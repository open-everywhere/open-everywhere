import { readFileSync } from "node:fs";

import { buildPostDecision, formatInvocation, pinInvocationToRepo, postCommitStatus } from "./cloud-proof-post-lib.js";
import { parseEvidence } from "./cloud-proof-verify-lib.js";
import { parseArgs } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const file = args.positional[0] ?? args.values.get("file");
const sha = args.values.get("sha");
const sessionId = args.values.get("session-id");
const targetUrl = args.values.get("target-url");
const dryRun = args.flags.has("dry-run");

if (!file || !sha || !sessionId) {
  console.error(
    "✗ deploy:cloud-proof-post: usage: npm run deploy:cloud-proof-post -- <evidence-file> --sha <sha> --session-id <id> [--target-url <url>] [--dry-run]",
  );
  process.exit(1);
}

let text: string;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  console.error(`✗ deploy:cloud-proof-post: could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const verdict = parseEvidence(text);
const decision = buildPostDecision({ verdict, expectedSha: sha, sessionId, ...(targetUrl ? { targetUrl } : {}) });

if (decision.kind === "refuse") {
  console.error(`✗ deploy:cloud-proof-post: ${decision.reason}`);
  process.exit(1);
}

if (dryRun) {
  console.log(`(dry run, nothing posted) ${formatInvocation(pinInvocationToRepo(decision.invocation, process.env))}`);
  process.exit(0);
}

const result = await postCommitStatus(decision.invocation);
if (!result.ok) {
  console.error(`✗ deploy:cloud-proof-post: ${result.reason}`);
  process.exit(1);
}
console.log(`✓ deploy:cloud-proof-post: posted ${decision.state} for ${decision.sha} (${decision.description})`);
