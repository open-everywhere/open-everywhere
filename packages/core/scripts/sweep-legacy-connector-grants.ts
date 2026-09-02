import { sweepLegacyConnectorGrants } from "../agent/routines/grants.js";

const org = process.argv[2];
if (!org) {
  console.error("✗ sweep-legacy-connector-grants: name the org, e.g. `… sweep-legacy-connector-grants.ts acme`.");
  process.exit(1);
}

const removed = await sweepLegacyConnectorGrants(org);
console.log(`✓ sweep-legacy-connector-grants: ${removed} inert connector.op: row(s) removed for org "${org}" — no authority was withdrawn.`);
process.exit(0);
