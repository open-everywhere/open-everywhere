import assert from "node:assert/strict";
import { loadDomains } from "../agent/memory/domains.js";
import { domainsAdmitCredentialGrant } from "@open-everywhere/core/agent/access/credential-grant.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const domains = loadDomains();

const fixture = domains.find((d) => d.name === "it-work-read-fixture-notion");
ok(fixture !== undefined, "the it-work-read-fixture-notion domain is defined — without it this file measures nothing");

ok(
  domainsAdmitCredentialGrant([fixture], "notion"),
  "it-work-read-fixture-notion does not admit a notion credential grant — declare { connector: \"notion\", credential: \"user-oauth\", use: \"<id>\" } on it (OPE-1060)",
);

ok(
  !domainsAdmitCredentialGrant([fixture], "linear"),
  "the fixture domain admits a linear credential grant it never declared — the admission check is not vacuously true",
);

const soak = domains.find((d) => d.name === "soak");
ok(soak !== undefined, "the soak domain is defined — without it this control measures nothing");
ok(
  !domainsAdmitCredentialGrant([soak], "notion"),
  "the soak domain (Notion WORK role only) wrongly admits a credential GRANT — the work and grant roles must not be conflated",
);

if (n === 0) {
  console.error("✗ credential-grant-domain-admission: 0 assertions ran — the file is vacuous");
  process.exit(1);
}
console.log(`✓ credential-grant-domain-admission: ${n} assertions — a real domain admits the notion/user-oauth credential grant role (OPE-1060).`);
