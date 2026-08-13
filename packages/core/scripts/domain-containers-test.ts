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
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["notion/ws123/db456/row789"] })]),
    "INTERMEDIATE containers are not supported",
    "a four-segment containers entry is refused by name",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["notion/ws123/db456/row789"] })]),
    "ancestor walk",
    "…and the refusal states the reason that earns it, not a blanket depth rule",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["notion/ws123/db456"] })]),
    "that is a roster entry",
    "an exact three-segment containers entry is sent to `channels`",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["github"] })]),
    "neither a two-segment tenant key",
    "a one-segment containers entry is refused",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", containers: ["github/"] })]),
    "neither a two-segment tenant key",
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
        [defineDomain({ name: "gov", governance: true, channels: ["slack/T1/C_ADMIN"], containers: ["slack/T1"], admins: ["slack/T1/U_A"] })],
        ["slack/T1"],
      ),
    "claims container(s)",
    "a governance domain with a containers claim is refused",
  );
}

{
  const claimOnly = defineDomain({ name: "platform", containers: ["github/acme"], memory: "platform-silo", admins: ["github/U_P"] });
  const org = defineDomain({ name: "org", match: "org", memory: "org-brain" });
  ok(siloCoveringDomains("platform-silo", [claimOnly, org]).join(",") === "platform", "a claim-only domain covers its own silo");
  ok(siloCoveringDomains("org-brain", [claimOnly, org]).length === 0, "a criteria pseudo-domain still covers nothing");
  ok(adminControlRoles("U_P", [claimOnly, org], "github", undefined).join(",") === "domain:platform", "a claim-only domain's admins still get its domain role");
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

{
  const payments = defineDomain({
    name: "payments",
    containers: ["github/acme/pay-*"],
    excludeContainers: ["github/acme/pay-secrets"],
    memory: "payments-silo",
  });
  const domains: Domain[] = [payments];

  const swept = resolveDomainForChannel("github/acme/pay-api", domains);
  ok(swept.domain?.name === "payments", "a glob claims the surfaces it matches, including ones nobody enumerated");
  ok(swept.via === "container:github/acme/pay-*", "the provenance names WHICH PATTERN admitted it, verbatim");

  const carved = resolveDomainForChannel("github/acme/pay-secrets", domains);
  ok(carved.domain === undefined, "EXCLUDE ALWAYS WINS — an excluded surface is not in the domain, whatever the claim says");
  ok(carved.via === "excluded:payments:github/acme/pay-secrets", "…and the refusal names the domain AND the exclusion that carved it out");

  ok(resolveDomainForChannel("github/acme/billing", domains).via === "none", "a glob does NOT annex the rest of the tenant — that is the whole point of it");
  ok(resolveDomainForChannel("github/other/pay-api", domains).via === "none", "a glob is scoped to ONE tenant; it never widens across tenants");
  ok(resolveDomainForChannel("github/acme", domains).via === "none", "a glob does not claim the bare tenant key (only a tenant claim does)");
  ok(resolveDomainForChannel("github/acme/pay-api/sub", domains).via === "none", "a same-level glob never reaches a DEEPER key");

  const listed = defineDomain({ name: "audit", channels: ["github/acme/pay-audit"] });
  const withRoster: Domain[] = [payments, listed];
  ok(resolveDomainForChannel("github/acme/pay-audit", withRoster).via === "roster", "the exact roster still beats any pattern");
  ok(resolveDomainForChannel("github/acme/pay-audit", withRoster).domain?.name === "audit", "…so a listed surface stays where it was listed");
  ok(resolveDomainForChannel("github/acme/pay-audit", [listed, payments] as Domain[]).domain?.name === "audit", "…regardless of declaration order");

  const tenant: Domain[] = [defineDomain({ name: "platform", containers: ["github/acme"] })];
  ok(resolveDomainForChannel("github/acme/api/deeper", tenant).domain?.name === "platform", "a TENANT claim still covers keys at any depth");
  ok(resolveDomainForChannel("github/acme", tenant).domain?.name === "platform", "…and still contains the bare tenant key");

  const flat: Domain[] = [defineDomain({ name: "flat", containers: ["github/acme/*"] })];
  ok(resolveDomainForChannel("github/acme/anything", flat).domain?.name === "flat", "an empty-prefix glob matches every same-level surface");
  ok(resolveDomainForChannel("github/acme/anything/deeper", flat).via === "none", "…and is strictly narrower than the tenant claim: no deeper key");

  const org = defineDomain({ name: "platform", containers: ["github/acme"], excludeContainers: ["github/acme/pay-*"] });
  const pay = defineDomain({ name: "payments", containers: ["github/acme/pay-*"] });
  assertChannelExclusivity([org, pay]);
  n++;
  assertDomainsValid([org, pay]);
  n++;
  ok(resolveDomainForChannel("github/acme/api", [org, pay] as Domain[]).domain?.name === "platform", "the broad claim keeps everything it did not hand over");
  ok(resolveDomainForChannel("github/acme/pay-api", [org, pay] as Domain[]).domain?.name === "payments", "the excluded slice lands in the domain that claims it");
  ok(resolveDomainForChannel("github/acme/pay-api", [pay, org] as Domain[]).domain?.name === "payments", "…and the answer does not depend on declaration order");
}

{
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", containers: ["github/acme/pay-*"] }),
        defineDomain({ name: "b", containers: ["github/acme/pay-eu-*"] }),
      ]),
    "can match the SAME surface key",
    "two patterns that could match one key are refused at config load",
  );
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", containers: ["github/acme/pay-*"] }),
        defineDomain({ name: "b", containers: ["github/acme/pay-eu-*"] }),
      ]),
    "excludeContainers",
    "…and the refusal hands over the exact remedy",
  );
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", containers: ["github/acme"] }),
        defineDomain({ name: "b", containers: ["github/acme/pay-*"] }),
      ]),
    "can match the SAME surface key",
    "a tenant claim overlapping another domain's pattern is refused",
  );
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", containers: ["github/acme/pay-*"] }),
        defineDomain({ name: "b", containers: ["github/acme/pay-*"] }),
      ]),
    "can match the SAME surface key",
    "the identical pattern in two domains is refused",
  );
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", containers: ["github/acme"] }),
        defineDomain({ name: "b", containers: ["github/acme"] }),
      ]),
    "claimed in containers by both",
    "the duplicate-tenant message is unchanged",
  );
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", containers: ["github/acme"], excludeContainers: ["github/acme/pay-secrets"] }),
        defineDomain({ name: "b", containers: ["github/acme/pay-*"] }),
      ]),
    "can match the SAME surface key",
    "an exclusion that covers only PART of the overlap does not make it legal",
  );

  assertChannelExclusivity([
    defineDomain({ name: "a", containers: ["github/acme/pay-*"] }),
    defineDomain({ name: "b", containers: ["github/acme/ops-*"] }),
  ]);
  n++;
  assertChannelExclusivity([
    defineDomain({ name: "a", containers: ["github/acme/pay-*"] }),
    defineDomain({ name: "b", containers: ["github/other/pay-*"] }),
  ]);
  n++;
  assertChannelExclusivity([defineDomain({ name: "a", containers: ["github/acme", "github/acme/pay-*"] })]);
  n++;
  assertChannelExclusivity([
    defineDomain({ name: "a", containers: ["github/acme/pay-*"] }),
    defineDomain({ name: "b", channels: ["github/acme/pay-audit"] }),
  ]);
  n++;
}

{
  const refuse = (entry: string, needle: string, label: string) =>
    throws(() => assertDomainsValid([defineDomain({ name: "d", containers: [entry] })]), needle, label);

  refuse("github/acme/pay*x", "decidable at config load", "a mid-string `*` is refused");
  refuse("github/acme/pay-**", "decidable at config load", "`**` is refused");
  refuse("github/acme/pay-*-*", "decidable at config load", "a second `*` is refused");
  refuse("github/*/pay-*", "decidable at config load", "a `*` in the TENANT segment is refused — a glob narrows, never widens");
  refuse("*/acme/pay-*", "decidable at config load", "a `*` in the PLATFORM segment is refused");
  refuse("github/acme/pay-*/sub", "INTERMEDIATE containers are not supported", "a pattern with a deeper path is still the intermediate case");

  assertDomainsValid([defineDomain({ name: "d", containers: ["github/acme", "github/acme/pay-*", "github/acme/*"] })]);
  n++;

  const refuseEx = (d: Domain, needle: string, label: string) => throws(() => assertDomainsValid([d]), needle, label);
  refuseEx(
    defineDomain({ name: "d", containers: ["github/acme"], excludeContainers: ["github/acme"] }),
    "WHOLE TENANT",
    "a tenant-wide exclusion is refused (it cancels the claim or means nothing)",
  );
  refuseEx(
    defineDomain({ name: "d", containers: ["github/acme"], excludeContainers: ["github/other/x"] }),
    "dead exclusion",
    "an exclusion no claim of this domain can match is refused — it reads as a carve-out and grants everything",
  );
  refuseEx(
    defineDomain({ name: "d", containers: ["github/acme/pay-*"], excludeContainers: ["github/acme/pay-*"] }),
    "cancels the WHOLE",
    "an exclusion that cancels an entire containers entry is dead config",
  );
  refuseEx(
    defineDomain({ name: "d", channels: ["github/acme/pay-audit"], containers: ["github/acme/pay-*"], excludeContainers: ["github/acme/pay-audit"] }),
    "exclusions carve out of the CLAIM tier only",
    "an exclusion aimed at this domain's OWN roster entry is a contradiction, not a carve-out",
  );
  refuseEx(
    defineDomain({ name: "d", containers: ["github/acme"], excludeContainers: ["github/acme/pay-secrets/deep"] }),
    "not a surface key",
    "a deeper exclusion is refused on the same same-level grounds as a claim",
  );
  assertDomainsValid([defineDomain({ name: "d", containers: ["github/acme"], excludeContainers: ["github/acme/pay-secrets", "github/acme/tmp-*"] })]);
  n++;

  throws(
    () =>
      assertGovernanceDomains(
        [defineDomain({ name: "gov", governance: true, channels: ["slack/T1/C_ADMIN"], containers: ["slack/T1/C_ADMIN_*"], admins: ["slack/T1/U_A"] })],
        ["slack/T1"],
      ),
    "claims container(s)",
    "a governance domain with a PATTERN claim is refused, same as a tenant claim",
  );
  throws(
    () =>
      assertGovernanceDomains(
        [defineDomain({ name: "gov", governance: true, channels: ["slack/T1/C_ADMIN"], excludeContainers: ["slack/T1/C_X"], admins: ["slack/T1/U_A"] })],
        ["slack/T1"],
      ),
    "sets excludeContainers",
    "a governance domain with an exclusion is refused too",
  );
}

{
  const domains: Domain[] = [
    defineDomain({ name: "payments", containers: ["github/acme/pay-*"], excludeContainers: ["github/acme/pay-secrets"], ambientSupervisor: true }),
  ];
  resetAmbientSkipSightings();

  ok(ambientSupervisorEnabled("github/acme/pay-api", domains), "the gate is ON for a surface the pattern admits");
  const skip = ambientSkipFor("github/acme/pay-secrets", domains);
  ok(skip?.reason === "no-domain", "an EXCLUDED surface is in no domain, so the gate is off for it");
  ok(skip?.via === "excluded:payments:github/acme/pay-secrets", "…and the skip carries the exclusion as its provenance");

  const logged: string[] = [];
  const reason = await auditAmbientSkip({
    platform: "github",
    workspace: "acme",
    surfaceKey: "github/acme/pay-secrets",
    log: (m: string) => logged.push(m),
    domains,
  });
  ok(reason === "no-domain", "the recorder records the excluded surface");
  ok(logged[0]?.includes("excludeContainers"), "the operator line names the EXCLUSION — the edit is 'drop it', not 'add a claim you already wrote'");
  const rows = await readAudit({ action: "github.ambient_skipped", surface: "github/acme/pay-secrets" });
  ok(String((rows[0]?.detail as Record<string, unknown>)?.via ?? "").startsWith("excluded:"), "…and the audit row carries the exclusion provenance");
}

{
  throws(
    () => assertDomainsValid([defineDomain({ name: "eng", containers: ["teams/T1/team:G9"] })]),
    "GROUP rung",
    "a `containers` entry using the group rung is refused BY NAME (it belongs to the trust registry, not to a memory domain)",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "eng", containers: ["teams/T1"], excludeContainers: ["teams/T1/team:G9"] })]),
    "GROUP rung",
    "an `excludeContainers` entry using the group rung is refused the same way",
  );
  assertDomainsValid([defineDomain({ name: "eng", containers: ["teams/T1"], excludeContainers: ["teams/T1/G9"] })]);
  n++;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ domain-containers: ${n} assertions passed (OPE-205 the container tier + the audited ambient skip; OPE-417 same-level globs + exclusions; OPE-490 the group-rung refusal)\n`);
