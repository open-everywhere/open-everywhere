import { createHash, randomBytes } from "node:crypto";

const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const argv = process.argv.slice(2);
const inject = argv.includes("--inject");
const name = argv.find((a) => !a.startsWith("--")) ?? (inject ? "e2e-injector" : "e2e-harness");
if (!SERVICE_NAME.test(name)) {
  console.error(`✗ "${name}" is not a valid service-token name — lowercase [a-z0-9_-], starting alphanumeric, ≤64 chars (it becomes the audit principal svc:<name>).`);
  process.exit(1);
}

const family = inject
  ? { label: "WAKE-INJECTION", deployEnv: "OE_CONTROL_INJECT_TOKENS", callerEnv: "E2E_CONTROL_INJECT_TOKEN", grants: "`POST /control/v1/test/wake` ONLY (and only while the deployment turns on the `wake.testWakeRoute` setting). NOT a read credential — it opens no control-plane view." }
  : { label: "READ-ONLY", deployEnv: "OE_CONTROL_READ_TOKENS", callerEnv: "E2E_CONTROL_READ_TOKEN", grants: "the read views + the deployment-mounted GET routes. NOT an injection credential — it is refused (401) by the test-wake route." };

const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token, "utf-8").digest("hex");

console.log(`Minted ${family.label} control-plane service token "${name}" (principal svc:${name}).\n`);
console.log(`   Grants: ${family.grants}\n`);
console.log("1) Token VALUE — store in the caller's secret store (e.g. the e2e harness env). Shown once, never persisted here:\n");
console.log(`   ${family.callerEnv}=${token}\n`);
console.log("2) Hash entry — set on the DEPLOYMENT (holds only the sha256; leaking the env never leaks a credential):\n");
console.log(`   ${family.deployEnv}=${name}:${hash}\n`);
console.log(`Append to an existing ${family.deployEnv} with a comma. The two families are DISJOINT — never paste an entry into the other one.`);
console.log("Docs: docs/security/control-plane.md#service-tokens-read-only");
