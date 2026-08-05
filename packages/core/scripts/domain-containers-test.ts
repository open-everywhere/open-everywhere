import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-domain-containers-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_ORG = "containers-test";

import { registerConfig } from "../agent/access/config.js";
import {
  defineDomain,
  resolveDomainForChannel,
  domainForChannel,
  ambientSupervisorEnabled,
  ambientSkipFor,
  assertDomainsValid,
  assertChannelExclusivity,
  assertGovernanceDomains,
  type Domain,
} from "../agent/memory/domain.js";
import { auditAmbientSkip, resetAmbientSkipSightings } from "../agent/channels/ambient-skip.js";
import { readAudit } from "../agent/audit/audit.js";
import { siloCoveringDomains } from "../agent/control/auth.js";
import { adminControlRoles } from "../agent/access/roles.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  n++;
};
const throws = (fn: () => void, needle: string, label: string) => {
  let msg = "";
  try {
    fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg.includes(needle), `${label} (wanted "${needle}" in: ${msg || "<no throw>"})`);
};

{
  const claimant = defineDomain({ name: "platform", containers: ["github/acme"], memory: "platform-silo" });
  const carveOut = defineDomain({ name: "payments", channels: ["github/acme/billing"], memory: "payments-silo" });
  const domains: Domain[] = [claimant, carveOut];

  const swept = resolveDomainForChannel("github/acme/api", domains);
  ok(swept.domain?.name === "platform", "an unlisted repo under a claimed owner routes to the claiming domain");
  ok(swept.via === "container:github/acme", "the claim reports WHICH container matched");

  const carved = resolveDomainForChannel("github/acme/billing", domains);
  ok(carved.domain?.name === "payments", "an explicitly-listed repo stays where it was listed, even under another domain's claim");
  ok(carved.via === "roster", "a roster hit reports via=roster, never the claim that also covered it");

  const reversed = resolveDomainForChannel("github/acme/billing", [carveOut, claimant] as Domain[]);
  ok(reversed.domain?.name === "payments", "roster-beats-claim holds regardless of declaration order");

  const other = resolveDomainForChannel("github/other/api", domains);
  ok(other.domain === undefined && other.via === "none", "a claim on one owner does not reach another owner");

  ok(resolveDomainForChannel("slack/T1/C_X", domains).via === "none", "an unrouted surface reports via=none");

  ok(domainForChannel("github/acme/api", domains)?.name === "platform", "domainForChannel inherits the container fallback unchanged");
  ok(domainForChannel("slack/T1/C_X", domains) === undefined, "domainForChannel still returns undefined for an unrouted surface");

  ok(resolveDomainForChannel("github/acme", domains)?.domain?.name === "platform", "the tenant key itself resolves to its claimant");

  const withOrg = [...domains, defineDomain({ name: "org", match: "org" })];
  ok(resolveDomainForChannel("slack/T1/C_X", withOrg).domain === undefined, "a match pseudo-domain is never selected by channel key");
}

{
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["notion/ws123/db456"] })]),
    "INTERMEDIATE containers are not supported yet",
    "a three-segment containers entry is refused by name",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["notion/ws123/db456"] })]),
    "platform/<tenant>",
    "the refusal names the accepted form",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["github"] })]),
    "not a two-segment tenant key",
    "a one-segment containers entry is refused",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["github/"] })]),
    "not a two-segment tenant key",
    "an empty tenant segment is refused",
  );

  assertDomainsValid([defineDomain({ name: "d", containers: ["github/acme"] })]);
  n++;
  assertDomainsValid([defineDomain({ name: "d", channels: ["github/acme/api"], containers: ["github/other"] })]);
  n++;

  throws(
    () => assertDomainsValid([defineDomain({ name: "org", match: "org", containers: ["github/acme"] })]),
    "must have EITHER explicit membership",
    "containers on a match pseudo-domain is refused",
  );

  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", containers: ["github/acme"] }),
        defineDomain({ name: "b", containers: ["github/acme"] }),
      ]),
    "claimed in containers by both",
    "one tenant claimed by two domains is refused",
  );

  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", channels: ["github/acme"] }),
        defineDomain({ name: "b", containers: ["github/acme"] }),
      ]),
    "say which you meant",
    "a key that is both a channels entry and a containers claim is refused",
  );

  assertChannelExclusivity([
    defineDomain({ name: "platform", containers: ["github/acme"] }),
    defineDomain({ name: "payments", channels: ["github/acme/billing"] }),
  ]);
  n++;

  throws(
    () =>
      assertGovernanceDomains(
        [defineDomain({ name: "gov", governance: true, channels: ["slack/T1/C_ADMIN"], containers: ["slack/T1"], admins: ["slack/U_A"] })],
        ["slack/T1"],
      ),
    "claims tenant container(s)",
    "a governance domain with a containers claim is refused",
  );
}

{
  const claimOnly = defineDomain({ name: "platform", containers: ["github/acme"], memory: "platform-silo", admins: ["github/U_P"] });
  const org = defineDomain({ name: "org", match: "org", memory: "org-brain" });
  ok(siloCoveringDomains("platform-silo", [claimOnly, org]).join(",") === "platform", "a claim-only domain covers its own silo");
  ok(siloCoveringDomains("org-brain", [claimOnly, org]).length === 0, "a criteria pseudo-domain still covers nothing");
  ok(adminControlRoles("U_P", [claimOnly, org], "github").join(",") === "domain:platform", "a claim-only domain's admins still get its domain role");
}

{
  const routed = defineDomain({ name: "platform", containers: ["github/acme"] });
  const live = defineDomain({ name: "watched", channels: ["github/acme/watched"], ambientSupervisor: true });
  const domains: Domain[] = [routed, live];

  ok(ambientSupervisorEnabled("github/acme/watched", domains), "the gate is ON for an opted-in roster surface");
  ok(ambientSkipFor("github/acme/watched", domains) === undefined, "an engaged surface has no skip reason");

  const refused = ambientSkipFor("github/acme/api", domains);
  ok(refused?.reason === "domain-refused", "a surface swept in by a claim whose domain has not opted in reports domain-refused");
  ok(refused?.domain === "platform" && refused.via === "container:github/acme", "the refusal names the domain and how the surface reached it");

  const gap = ambientSkipFor("github/nobody/api", domains);
  ok(gap?.reason === "no-domain", "a surface in no domain at all reports no-domain");
  ok(gap?.via === "none", "the config gap reports via=none");

  const withOrgOn = [...domains, defineDomain({ name: "org", match: "org", ambientSupervisor: true })];
  ok(ambientSkipFor("github/nobody/api", withOrgOn) === undefined, "an org-wide ambient opt-in leaves an unrouted surface with no skip");
  ok(ambientSupervisorEnabled("github/nobody/api", withOrgOn), "…and the gate itself agrees, so the recorder never contradicts it");
}

{
  const domains: Domain[] = [defineDomain({ name: "watched", channels: ["github/acme/watched"], ambientSupervisor: true })];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
  } as never);
  resetAmbientSkipSightings();

  const logged: string[] = [];
  const skip = { platform: "github", workspace: "acme", surfaceKey: "github/acme/unrouted", log: (m: string) => logged.push(m) };

  const first = await auditAmbientSkip(skip);
  ok(first === "no-domain", "auditAmbientSkip returns the recorded reason");
  const second = await auditAmbientSkip(skip);
  ok(second === "no-domain", "a repeat skip still reports its reason to the caller");

  ok(logged.length === 2, "the log line is UNCONDITIONAL — every skipped delivery says so");
  ok(logged[0].includes("containers:"), "the log names the exact edit (add to channels, or claim the tenant), not the blockage");

  const rows = await readAudit({ action: "github.ambient_skipped" });
  ok(rows.length === 1, "the audit row is written ONCE per surface+reason, not once per delivery");
  ok(rows[0].surface === "github/acme/unrouted", "the row names the surface a deployer would add");
  ok((rows[0].detail as Record<string, unknown>).reason === "no-domain", "the row carries the closed-set reason");
  ok((rows[0].detail as Record<string, unknown>).via === "none", "the row carries the routing provenance");

  const bogus = await auditAmbientSkip({ platform: "github", workspace: "acme", surfaceKey: "github/acme/watched" });
  ok(bogus === undefined, "an ENGAGED surface records nothing, even if an ingress calls the recorder by mistake");
  ok((await readAudit({ action: "github.ambient_skipped" })).length === 1, "…and writes no row");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ domain-containers: ${n} assertions passed (OPE-205 stage 1 — the container tier + the audited ambient skip)\n`);
