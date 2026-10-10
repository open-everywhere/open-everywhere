// proves: SEAT-15

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-domain-containers-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "containers-test" });

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
  domainRoster,
  domainContainers,
  type Domain,
} from "../agent/memory/domain.js";
import { auditAmbientSkip, resetAmbientSkipSightings } from "../agent/channels/ambient-skip.js";
import { readAudit } from "../agent/audit/audit.js";
import { siloCoveringDomains } from "../agent/control/auth.js";
import { adminControlRoles } from "../agent/access/roles.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

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
  const claimant = defineDomain({ name: "platform", reach: ["github/acme"], memory: "platform-silo" });
  const carveOut = defineDomain({ name: "payments", reach: ["github/acme/billing"], memory: "payments-silo" });
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
    () => assertDomainsValid([defineDomain({ name: "d", reach: ["notion/ws123/db456/row789"] })]),
    "INTERMEDIATE containers are not supported",
    "a four-segment containers entry is refused by name",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", reach: ["notion/ws123/db456/row789"] })]),
    "ancestor walk",
    "…and the refusal states the reason that earns it, not a blanket depth rule",
  );
  {
    const exact = defineDomain({ name: "d", reach: ["notion/ws123/db456"] });
    assertDomainsValid([exact]);
    ok(resolveDomainForChannel("notion/ws123/db456", [exact]).via === "roster", "an exact three-segment reach entry is legal, and routes via the roster");
    ok(domainRoster(exact).length === 1 && domainContainers(exact).length === 0, "…and it counts as the roster half of reach, never the container half");
  }
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", reach: ["github"] })]),
    "none of the three legal shapes",
    "a one-segment containers entry is refused",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "d", reach: ["github/"] })]),
    "none of the three legal shapes",
    "an empty tenant segment is refused",
  );

  assertDomainsValid([defineDomain({ name: "d", reach: ["github/acme"] })]);
  n++;
  assertDomainsValid([defineDomain({ name: "d", reach: ["github/acme/api", "github/other"] })]);
  n++;

  throws(
    () => assertDomainsValid([defineDomain({ name: "org", match: "org", reach: ["github/acme"] })]),
    "must have EITHER a reach list OR match",
    "containers on a match pseudo-domain is refused",
  );

  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", reach: ["github/acme"] }),
        defineDomain({ name: "b", reach: ["github/acme"] }),
      ]),
    "is reached by both",
    "one tenant claimed by two domains is refused",
  );

  {
    const wide = defineDomain({ name: "platform", reach: ["github/acme"] });
    const narrow = defineDomain({ name: "payments", reach: ["github/acme/billing"] });
    assertChannelExclusivity([wide, narrow]);
    ok(domainForChannel("github/acme/billing", [wide, narrow])?.name === "payments", "an exact key beats another domain's whole-tenant entry");
    ok(domainForChannel("github/acme/billing", [narrow, wide])?.name === "payments", "…in either declaration order — the order is not the tiebreak");
    ok(domainForChannel("github/acme/other", [wide, narrow])?.name === "platform", "…and the tenant keeps everything the exact key did not name");
  }
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", reach: ["github/acme/pay-*"] }),
        defineDomain({ name: "b", reach: ["github/acme/pay-*"] }),
      ]),
    "match exactly the SAME keys",
    "two entries of equal reach in two domains are refused",
  );

  throws(
    () =>
      assertGovernanceDomains(
        [defineDomain({ name: "gov", governance: true, reach: ["slack/T1/C_ADMIN", "slack/T1"], admins: ["slack/T1/U_A"] })],
        ["slack/T1"],
      ),
    "reaches container(s)",
    "a governance domain with a containers claim is refused",
  );
}

{
  const claimOnly = defineDomain({ name: "platform", reach: ["github/acme"], memory: "platform-silo", admins: ["github/U_P"] });
  const org = defineDomain({ name: "org", match: "org", memory: "org-brain" });
  ok(siloCoveringDomains("platform-silo", [claimOnly, org]).join(",") === "platform", "a claim-only domain covers its own silo");
  ok(siloCoveringDomains("org-brain", [claimOnly, org]).length === 0, "a criteria pseudo-domain still covers nothing");
  ok(adminControlRoles("U_P", [claimOnly, org], "github", undefined).join(",") === "domain:platform", "a claim-only domain's admins still get its domain role");
}

{
  const routed = defineDomain({ name: "platform", reach: ["github/acme"] });
  const live = defineDomain({ name: "watched", reach: ["github/acme/watched"], ambientSupervisor: true });
  const quiet = defineDomain({ name: "quiet", reach: ["github/acme/quiet"], ambientSupervisor: false });
  const domains: Domain[] = [routed, live, quiet];

  ok(ambientSupervisorEnabled("github/acme/api", domains), "🔴 DEFAULT ON: an explicit domain that sets no flag, with no org domain at all, is ambient");
  ok(!ambientSupervisorEnabled("github/nobody/api", domains), "🔴 FAIL CLOSED: a surface in no domain, on a deployment with NO org domain, is OFF");
  const gapNoOrg = ambientSkipFor("github/nobody/api", domains);
  ok(gapNoOrg?.reason === "no-domain" && gapNoOrg.via === "none", "…and the recorder reports it as the no-domain config gap");
  ok(ambientSupervisorEnabled("github/nobody/api", [defineDomain({ name: "org", match: "org" })]), "🔴 DEFAULT ON: an org domain that sets no flag (the scaffold's) leaves an unrouted surface ambient");
  ok(ambientSupervisorEnabled("github/acme/watched", domains), "an explicit `true` is on");
  ok(ambientSkipFor("github/acme/api", domains) === undefined, "a default-on surface has no skip reason, so the recorder never contradicts the gate");

  ok(!ambientSupervisorEnabled("github/acme/quiet", domains), "🔴 OPT-OUT: an explicit `ambientSupervisor: false` turns it off for that domain");
  const refused = ambientSkipFor("github/acme/quiet", domains);
  ok(refused?.reason === "domain-refused", "an opted-out domain reports domain-refused");
  ok(refused?.domain === "quiet" && refused.declaredBy === "quiet" && refused.via === "roster", "the refusal names the domain, who declared the false, and how the surface reached it");

  const orgOff = defineDomain({ name: "org", match: "org", ambientSupervisor: false });
  const withOrgOff: Domain[] = [...domains, orgOff];
  ok(!ambientSupervisorEnabled("github/nobody/api", withOrgOff), "🔴 OPT-OUT: `org: false` turns off an unrouted surface");
  ok(!ambientSupervisorEnabled("github/acme/api", withOrgOff), "🔴 INHERITS: an explicit domain that sets no flag inherits `org: false`");
  ok(ambientSupervisorEnabled("github/acme/watched", withOrgOff), "an explicit `true` still wins over `org: false`");
  const inherited = ambientSkipFor("github/acme/api", withOrgOff);
  ok(
    inherited?.reason === "domain-refused" && inherited.domain === "platform" && inherited.declaredBy === "org" && inherited.via === "container:github/acme",
    "an inherited refusal names the ROUTING domain and the org as the domain that declared the false",
  );
  const unrouted = ambientSkipFor("github/nobody/api", withOrgOff);
  ok(unrouted?.reason === "domain-refused" && unrouted.domain === "org" && unrouted.via === "none", "an unrouted surface under `org: false` is a decision by org, not a config gap");

  const orgOn = defineDomain({ name: "org", match: "org", ambientSupervisor: true });
  ok(!ambientSupervisorEnabled("github/acme/quiet", [...domains, orgOn]), "an explicit `false` still wins over `org: true`");
}

{
  const domains: Domain[] = [
    defineDomain({ name: "watched", reach: ["github/acme/watched"], ambientSupervisor: true }),
    defineDomain({ name: "org", match: "org", ambientSupervisor: false }),
  ];
  let loadFails = false;
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => {
      if (loadFails) throw new Error("domain set did not load");
      return domains;
    },
    loadSilos: () => [],
    domainsForSurface: () => [],
  } as never);
  resetAmbientSkipSightings();

  const logged: string[] = [];
  const skip = { platform: "github", workspace: "acme", surfaceKey: "github/acme/unrouted", log: (m: string) => logged.push(m) };

  const first = await auditAmbientSkip(skip);
  ok(first === "domain-refused", "auditAmbientSkip returns the recorded reason");
  const second = await auditAmbientSkip(skip);
  ok(second === "domain-refused", "a repeat skip still reports its reason to the caller");

  ok(logged.length === 2, "the log line is UNCONDITIONAL — every skipped delivery says so");
  ok(logged[0].includes('domain "org" sets ambientSupervisor: false'), "the log names the domain that DECLARED the false, which is the line to change");
  ok(logged[0].includes("That is a decision, not a gap"), "…and calls it a decision, not a config gap");

  const rows = await readAudit({ org: "containers-test", action: "github.ambient_skipped" });
  ok(rows.length === 1, "the audit row is written ONCE per surface+reason, not once per delivery");
  ok(rows[0].surface === "github/acme/unrouted", "the row names the surface a deployer would add");
  ok((rows[0].detail as Record<string, unknown>).reason === "domain-refused", "the row carries the closed-set reason");
  ok((rows[0].detail as Record<string, unknown>).domain === "org", "the row names the domain that routes the surface");
  ok((rows[0].detail as Record<string, unknown>).via === "none", "the row carries the routing provenance");
  ok(
    (rows[0].detail as Record<string, unknown>).dedupe === "process",
    "🔴 …and the row SAYS it is deduped per process, so a reader joining by time cannot take it for a per-delivery record of one message",
  );

  const bogus = await auditAmbientSkip({ platform: "github", workspace: "acme", surfaceKey: "github/acme/watched" });
  ok(bogus === undefined, "an ENGAGED surface records nothing, even if an ingress calls the recorder by mistake");
  ok((await readAudit({ org: "containers-test", action: "github.ambient_skipped" })).length === 1, "…and writes no row");

  loadFails = true;
  const gapLog: string[] = [];
  const gap = await auditAmbientSkip({ platform: "github", workspace: "acme", surfaceKey: "github/acme/gap", log: (m: string) => gapLog.push(m) });
  ok(gap === "no-domain", "a domain set that will not load records no-domain");
  ok(gapLog[0]?.includes("did not load"), "…and the line names the config error");
  ok(!gapLog[0]?.includes('declares no "org" domain') && !gapLog[0]?.includes("reach"), "🔴 …and ONLY the config error: no claim that org is missing, no reach edit");
  const gapRows = await readAudit({ org: "containers-test", action: "github.ambient_skipped", surface: "github/acme/gap" });
  ok((gapRows[0]?.detail as Record<string, unknown>)?.via === "none", "…and its row says via=none");
  ok((gapRows[0]?.detail as Record<string, unknown>)?.loadFailed === true, "…and marks the row loadFailed, so a reader can tell the two roads apart");
  loadFails = false;

  const noOrgLog: string[] = [];
  const noOrg = await auditAmbientSkip({
    platform: "github",
    workspace: "acme",
    surfaceKey: "github/acme/no-org",
    log: (m: string) => noOrgLog.push(m),
    domains: [defineDomain({ name: "watched", reach: ["github/acme/watched"], ambientSupervisor: true })],
  });
  ok(noOrg === "no-domain", "an unrouted surface with no org domain records no-domain");
  ok(noOrgLog[0]?.includes('declares no "org" domain') && noOrgLog[0]?.includes("add an \"org\" domain"), "…and the line says there is no org domain and names adding one");
  ok(noOrgLog[0]?.includes('the whole tenant "github/acme"') && noOrgLog[0]?.includes('"github/acme/<prefix>*"'), "…and spells out the container forms too, so the wide fix is one paste");
  const noOrgRows = await readAudit({ org: "containers-test", action: "github.ambient_skipped", surface: "github/acme/no-org" });
  ok((noOrgRows[0]?.detail as Record<string, unknown>)?.loadFailed === undefined, "…and its row is NOT marked loadFailed");
}

{
  const payments = defineDomain({
    name: "payments",
    reach: ["github/acme/pay-*"],
    exclude: ["github/acme/pay-secrets"],
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

  const listed = defineDomain({ name: "audit", reach: ["github/acme/pay-audit"] });
  const withRoster: Domain[] = [payments, listed];
  ok(resolveDomainForChannel("github/acme/pay-audit", withRoster).via === "roster", "the exact roster still beats any pattern");
  ok(resolveDomainForChannel("github/acme/pay-audit", withRoster).domain?.name === "audit", "…so a listed surface stays where it was listed");
  ok(resolveDomainForChannel("github/acme/pay-audit", [listed, payments] as Domain[]).domain?.name === "audit", "…regardless of declaration order");

  const tenant: Domain[] = [defineDomain({ name: "platform", reach: ["github/acme"] })];
  ok(resolveDomainForChannel("github/acme/api/deeper", tenant).domain?.name === "platform", "a TENANT claim still covers keys at any depth");
  ok(resolveDomainForChannel("github/acme", tenant).domain?.name === "platform", "…and still contains the bare tenant key");

  const flat: Domain[] = [defineDomain({ name: "flat", reach: ["github/acme/*"] })];
  ok(resolveDomainForChannel("github/acme/anything", flat).domain?.name === "flat", "an empty-prefix glob matches every same-level surface");
  ok(resolveDomainForChannel("github/acme/anything/deeper", flat).via === "none", "…and is strictly narrower than the tenant claim: no deeper key");

  const org = defineDomain({ name: "platform", reach: ["github/acme"], exclude: ["github/acme/pay-*"] });
  const pay = defineDomain({ name: "payments", reach: ["github/acme/pay-*"] });
  assertChannelExclusivity([org, pay]);
  n++;
  assertDomainsValid([org, pay]);
  n++;
  ok(resolveDomainForChannel("github/acme/api", [org, pay] as Domain[]).domain?.name === "platform", "the broad claim keeps everything it did not hand over");
  ok(resolveDomainForChannel("github/acme/pay-api", [org, pay] as Domain[]).domain?.name === "payments", "the excluded slice lands in the domain that claims it");
  ok(resolveDomainForChannel("github/acme/pay-api", [pay, org] as Domain[]).domain?.name === "payments", "…and the answer does not depend on declaration order");
}

{
  const nested: Domain[] = [
    defineDomain({ name: "wide", reach: ["github/acme/pay-*"] }),
    defineDomain({ name: "narrow", reach: ["github/acme/pay-eu-*"] }),
  ];
  assertChannelExclusivity(nested);
  n++;
  ok(domainForChannel("github/acme/pay-eu-1", nested)?.name === "narrow", "a LONGER glob beats a shorter one");
  ok(domainForChannel("github/acme/pay-eu-1", [...nested].reverse())?.name === "narrow", "…in either declaration order");
  ok(domainForChannel("github/acme/pay-us-1", nested)?.name === "wide", "…and the shorter glob keeps what the longer one does not reach");
  ok(resolveDomainForChannel("github/acme/pay-eu-1", nested).via === "container:github/acme/pay-eu-*", "the provenance names the WINNING entry, verbatim");

  const tenantVsGlob: Domain[] = [
    defineDomain({ name: "platform", reach: ["github/acme"] }),
    defineDomain({ name: "payments", reach: ["github/acme/pay-*"] }),
  ];
  assertChannelExclusivity(tenantVsGlob);
  n++;
  ok(domainForChannel("github/acme/pay-1", tenantVsGlob)?.name === "payments", "a glob beats another domain's whole tenant");
  ok(domainForChannel("github/acme/other", tenantVsGlob)?.name === "platform", "…and the tenant keeps the rest — no exclusion needed for the hand-over");

  const ladder: Domain[] = [
    defineDomain({ name: "tenant-domain", reach: ["github/acme"] }),
    defineDomain({ name: "glob-domain", reach: ["github/acme/pay-*"] }),
    defineDomain({ name: "long-glob-domain", reach: ["github/acme/pay-eu-*"] }),
    defineDomain({ name: "exact-domain", reach: ["github/acme/pay-eu-1"] }),
  ];
  assertChannelExclusivity(ladder);
  assertDomainsValid(ladder);
  ok(domainForChannel("github/acme/pay-eu-1", ladder)?.name === "exact-domain", "ladder: the exact key wins");
  ok(domainForChannel("github/acme/pay-eu-2", ladder)?.name === "long-glob-domain", "ladder: the longer glob wins the rest of its prefix");
  ok(domainForChannel("github/acme/pay-us-2", ladder)?.name === "glob-domain", "ladder: the shorter glob wins the rest of its prefix");
  ok(domainForChannel("github/acme/anything", ladder)?.name === "tenant-domain", "ladder: the tenant wins everything else");
  const reversed = [...ladder].reverse();
  ok(domainForChannel("github/acme/pay-eu-1", reversed)?.name === "exact-domain", "ladder reversed: still the exact key");
  ok(domainForChannel("github/acme/pay-eu-2", reversed)?.name === "long-glob-domain", "ladder reversed: still the longer glob");
  ok(domainForChannel("github/acme/pay-us-2", reversed)?.name === "glob-domain", "ladder reversed: still the shorter glob");
  ok(domainForChannel("github/acme/anything", reversed)?.name === "tenant-domain", "ladder reversed: still the tenant");

  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", reach: ["github/acme/pay-*"] }),
        defineDomain({ name: "b", reach: ["github/acme/pay-*"] }),
      ]),
    "match exactly the SAME keys",
    "the identical glob in two domains is refused",
  );
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", reach: ["github/acme"] }),
        defineDomain({ name: "b", reach: ["github/acme"] }),
      ]),
    "is reached by both",
    "the identical tenant in two domains is refused, with its own remedy",
  );
  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", reach: ["github/acme/api"] }),
        defineDomain({ name: "b", reach: ["github/acme/api"] }),
      ]),
    "is in the reach of both",
    "the identical exact key in two domains is refused",
  );
  assertChannelExclusivity([
    defineDomain({ name: "a", reach: ["github/acme/pay-*"], exclude: ["github/acme/pay-*"] }),
    defineDomain({ name: "b", reach: ["github/acme/pay-*"] }),
  ]);
  n++;

  throws(
    () =>
      assertChannelExclusivity([
        defineDomain({ name: "a", reach: ["github/acme/api"], exclude: ["github/acme/api"] }),
      ]),
    "routes to NO domain",
    "a room a domain names outright but excludes is refused — silence is not an outcome config may pick by accident",
  );

  assertChannelExclusivity([
    defineDomain({ name: "a", reach: ["github/acme/pay-*"] }),
    defineDomain({ name: "b", reach: ["github/acme/ops-*"] }),
  ]);
  n++;
  assertChannelExclusivity([
    defineDomain({ name: "a", reach: ["github/acme/pay-*"] }),
    defineDomain({ name: "b", reach: ["github/other/pay-*"] }),
  ]);
  n++;
  assertChannelExclusivity([defineDomain({ name: "a", reach: ["github/acme", "github/acme/pay-*"] })]);
  n++;
}

{
  const refuse = (entry: string, needle: string, label: string) =>
    throws(() => assertDomainsValid([defineDomain({ name: "d", reach: [entry] })]), needle, label);

  refuse("github/acme/pay*x", "decidable at config load", "a mid-string `*` is refused");
  refuse("github/acme/pay-**", "decidable at config load", "`**` is refused");
  refuse("github/acme/pay-*-*", "decidable at config load", "a second `*` is refused");
  refuse("github/*/pay-*", "decidable at config load", "a `*` in the TENANT segment is refused — a glob narrows, never widens");
  refuse("*/acme/pay-*", "decidable at config load", "a `*` in the PLATFORM segment is refused");
  refuse("github/acme/pay-*/sub", "INTERMEDIATE containers are not supported", "a pattern with a deeper path is still the intermediate case");

  assertDomainsValid([defineDomain({ name: "d", reach: ["github/acme", "github/acme/pay-*", "github/acme/*"] })]);
  n++;

  const refuseEx = (d: Domain, needle: string, label: string) => throws(() => assertDomainsValid([d]), needle, label);
  refuseEx(
    defineDomain({ name: "d", reach: ["github/acme"], exclude: ["github/acme"] }),
    "WHOLE TENANT",
    "a tenant-wide exclusion is refused (it cancels the claim or means nothing)",
  );
  refuseEx(
    defineDomain({ name: "d", reach: ["github/acme"], exclude: ["github/other/x"] }),
    "dead exclusion",
    "an exclusion no claim of this domain can match is refused — it reads as a carve-out and grants everything",
  );
  refuseEx(
    defineDomain({ name: "d", reach: ["github/acme/pay-*"], exclude: ["github/acme/pay-*"] }),
    "cancels the WHOLE",
    "an exclusion that cancels an entire container reach entry is dead config",
  );
  refuseEx(
    defineDomain({ name: "d", reach: ["github/acme/pay-audit", "github/acme/pay-*"], exclude: ["github/acme/pay-audit"] }),
    "an exclusion and the exact key it cancels are a contradiction",
    "an exclusion aimed at this domain's OWN roster entry is a contradiction, not a carve-out",
  );
  refuseEx(
    defineDomain({ name: "d", reach: ["github/acme"], exclude: ["github/acme/pay-secrets/deep"] }),
    "not a surface key",
    "a deeper exclusion is refused on the same same-level grounds as a claim",
  );
  assertDomainsValid([defineDomain({ name: "d", reach: ["github/acme"], exclude: ["github/acme/pay-secrets", "github/acme/tmp-*"] })]);
  n++;

  throws(
    () =>
      assertGovernanceDomains(
        [defineDomain({ name: "gov", governance: true, reach: ["slack/T1/C_ADMIN", "slack/T1/C_ADMIN_*"], admins: ["slack/T1/U_A"] })],
        ["slack/T1"],
      ),
    "reaches container(s)",
    "a governance domain with a PATTERN claim is refused, same as a tenant claim",
  );
  throws(
    () =>
      assertGovernanceDomains(
        [defineDomain({ name: "gov", governance: true, reach: ["slack/T1/C_ADMIN"], exclude: ["slack/T1/C_X"], admins: ["slack/T1/U_A"] })],
        ["slack/T1"],
      ),
    "sets exclude",
    "a governance domain with an exclusion is refused too",
  );
}

{
  const payments = defineDomain({ name: "payments", reach: ["github/acme/pay-*"], exclude: ["github/acme/pay-secrets"], ambientSupervisor: true });
  resetAmbientSkipSightings();

  ok(ambientSupervisorEnabled("github/acme/pay-api", [payments]), "the gate is ON for a surface the pattern admits");
  ok(ambientSupervisorEnabled("github/acme/pay-secrets", [payments, defineDomain({ name: "org", match: "org" })]), "an EXCLUDED surface inherits the default (on) when org sets nothing");
  ok(!ambientSupervisorEnabled("github/acme/pay-secrets", [payments]), "…and is OFF when there is no org domain to fall to (the fail-closed arm)");

  const domains: Domain[] = [payments, defineDomain({ name: "org", match: "org", ambientSupervisor: false })];
  const skip = ambientSkipFor("github/acme/pay-secrets", domains);
  ok(skip?.reason === "domain-refused" && skip.domain === "org", "under `org: false`, an EXCLUDED surface is refused by org, which now routes it");
  ok(skip?.via === "excluded:payments:github/acme/pay-secrets", "…and the skip carries the exclusion as its provenance");

  const logged: string[] = [];
  const reason = await auditAmbientSkip({
    platform: "github",
    workspace: "acme",
    surfaceKey: "github/acme/pay-secrets",
    log: (m: string) => logged.push(m),
    domains,
  });
  ok(reason === "domain-refused", "the recorder records the excluded surface");
  ok(logged[0]?.includes("excluded:payments"), "the operator line carries the exclusion provenance");
  const rows = await readAudit({ org: "containers-test", action: "github.ambient_skipped", surface: "github/acme/pay-secrets" });
  ok(String((rows[0]?.detail as Record<string, unknown>)?.via ?? "").startsWith("excluded:"), "…and the audit row carries the exclusion provenance");

  const exLog: string[] = [];
  const exReason = await auditAmbientSkip({ platform: "github", workspace: "acme", surfaceKey: "github/acme/pay-secrets", log: (m: string) => exLog.push(m), domains: [payments] });
  ok(exReason === "no-domain", "an EXCLUDED surface with no org domain records no-domain");
  ok(exLog[0]?.includes('its exclude entry "github/acme/pay-secrets"') && exLog[0]?.includes("drop or narrow that exclusion"), "🔴 …and the operator line names the EXCLUSION — the edit is 'drop it', not 'add a reach entry you already wrote'");
}

{
  throws(
    () => assertDomainsValid([defineDomain({ name: "eng", reach: ["teams/T1/team:G9"] })]),
    "GROUP rung",
    "a `reach` entry using the group rung is refused BY NAME (it belongs to the trust registry, not to a memory domain)",
  );
  throws(
    () => assertDomainsValid([defineDomain({ name: "eng", reach: ["teams/T1"], exclude: ["teams/T1/team:G9"] })]),
    "GROUP rung",
    "an `exclude` entry using the group rung is refused the same way",
  );
  assertDomainsValid([defineDomain({ name: "eng", reach: ["teams/T1"], exclude: ["teams/T1/G9"] })]);
  n++;
}

await removeTempDir(tmp);
console.log(`\n✓ domain-containers: ${n} assertions passed (OPE-205 containers + the audited ambient skip; OPE-417 same-level globs + exclusions; OPE-490 the group-rung refusal; OPE-254 one reach list, most-specific-wins)\n`);

// proves: AP-MOD-core-identity-surface-key-grammar
