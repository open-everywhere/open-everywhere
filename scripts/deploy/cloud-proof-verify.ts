import { readFileSync } from "node:fs";

import { parseEvidence } from "./cloud-proof-verify-lib.js";
import { parseArgs } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const file = args.positional[0] ?? args.values.get("file");

if (!file) {
  console.error("✗ deploy:cloud-proof-verify: no evidence file given. Usage: npm run deploy:cloud-proof-verify -- <path>");
  process.exit(1);
}

let text: string;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  console.error(`✗ deploy:cloud-proof-verify: could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const verdict = parseEvidence(text);
console.log(JSON.stringify(verdict, null, 2));

if (verdict.verdict === "pass") {
  process.exit(0);
}
console.error(`✗ deploy:cloud-proof-verify: ${verdict.verdict}${"reason" in verdict ? ` — ${verdict.reason}` : ""}`);
process.exit(1);
