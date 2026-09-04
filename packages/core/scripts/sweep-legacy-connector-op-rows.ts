import { sweepLegacyConnectorOpRows } from "../agent/routines/declared-permissions.js";

const org = process.argv[2];
if (!org) {
  console.error("✗ sweep-legacy-connector-op-rows: name the org, e.g. `… sweep-legacy-connector-op-rows.ts acme`.");
  process.exit(1);
}

const removed = await sweepLegacyConnectorOpRows(org);
console.log(`✓ sweep-legacy-connector-op-rows: ${removed} inert connector.op: row(s) removed for org "${org}" — no authority was withdrawn.`);
process.exit(0);
