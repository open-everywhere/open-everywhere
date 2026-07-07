import { createHash, randomBytes } from "node:crypto";

const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const name = process.argv[2] ?? "e2e-harness";
if (!SERVICE_NAME.test(name)) {
  console.error(`✗ "${name}" is not a valid service-token name — lowercase [a-z0-9_-], starting alphanumeric, ≤64 chars (it becomes the audit principal svc:<name>).`);
  process.exit(1);
}

const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token, "utf-8").digest("hex");

console.log(`Minted read-only control-plane service token "${name}" (principal svc:${name}).\n`);
console.log("1) Token VALUE — store in the caller's secret store (e.g. the e2e harness env). Shown once, never persisted here:\n");
console.log(`   E2E_CONTROL_READ_TOKEN=${token}\n`);
console.log("2) Hash entry — set on the DEPLOYMENT (holds only the sha256; leaking the env never leaks a credential):\n");
console.log(`   OE_CONTROL_READ_TOKENS=${name}:${hash}\n`);
console.log("Append to an existing OE_CONTROL_READ_TOKENS with a comma. Docs: docs/security/control-plane.md#service-tokens-read-only");
