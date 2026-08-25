import assert from "node:assert/strict";
import { loadDomains, domainsForSurface } from "../agent/memory/domains.js";
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

const liveNames = domainsForSurface({ workspaceKey: "slack/T0EXAMPLE", surface: "C0EXCHAN003" }, domains);
ok(liveNames.includes("e2e-unified"), "the live e2e-unified Slack surface no longer resolves to the e2e-unified domain — domains.ts regressed");
const liveDomains = domains.filter((d) => liveNames.includes(d.name));
ok(
  domainsAdmitCredentialGrant(liveDomains, "notion"),
  "no domain reachable from the LIVE e2e-unified Slack surface admits a notion credential grant — " +
    'declare { connector: "notion", credential: "user-oauth", use: "user-oauth-rest" } on e2e-unified (OPE-1060 slice 2)',
);

if (n === 0) {
  console.error("✗ credential-grant-domain-admission: 0 assertions ran — the file is vacuous");
  process.exit(1);
}
console.log(`✓ credential-grant-domain-admission: ${n} assertions — a real domain admits the notion/user-oauth credential grant role (OPE-1060).`);
