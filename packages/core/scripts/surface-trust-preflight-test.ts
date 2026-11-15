import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-surface-trust-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

import {
  surfaceTrustPreflightChecks,
  surfaceTrafficFromAudit,
  registerSurfaceTrustPreflight,
  undeclaredSurfacesFix,
  type SurfaceTraffic,
} from "../agent/identity/trust-preflight.js";
import { runPreflightProbes, _resetPreflightProbesForTest } from "../agent/ops/probes.js";
import { defineSurface, type Surface } from "../agent/identity/trust.js";
import type { Check } from "../agent/ops/quickstart.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const NOW = new Date("2026-08-13T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const seen = (surfaceKey: string, firstDays: number, lastDays = 0): SurfaceTraffic => ({
  surfaceKey,
  firstSeen: daysAgo(firstDays),
  lastSeen: daysAgo(lastDays),
});
const run = (entries: readonly Surface[], traffic: readonly SurfaceTraffic[]): Check[] =>
  surfaceTrustPreflightChecks({ entries, traffic, now: NOW });
const find = (checks: readonly Check[], needle: string): Check | undefined => checks.find((c) => c.name.includes(needle));

{
  const checks = run(
    [defineSurface({ key: "slack/T0", trust: "internal" })],
    [seen("slack/T0/C_ENG", 90), seen("discord/G1/C_GENERAL", 40), seen("notion/WS/page-a", 12)],
  );
  const red = find(checks, "undeclared surfaces");
  eq(red?.status, "missing", "🔴 CHECK 1: a surface with traffic and NO declaration is a RED — this is what makes the `clean` default safe");
  ok(red?.detail.includes("discord/G1/C_GENERAL") === true, "…and it NAMES the surface, so the operator does not have to go looking");
  ok(red?.detail.includes("notion/WS/page-a") === true, "…every one of them");
  ok(red?.detail.includes("slack/T0/C_ENG") === false, "…and NOT the one the tenant declaration already covers");
  ok(red?.fix?.includes("defineSurface(") === true, "…and the fix is the literal line to add, not a description of the problem");

  {
    const teams = run([], [seen("teams/deadbeef-1111/19-abc-thread.tacv2", 30)]);
    const f = find(teams, "undeclared surfaces")?.fix ?? "";
    ok(f.includes("defineSurface("), "🔴 a TEAMS undeclared surface gets the tracked defineSurface remedy, like every platform");
    ok(!f.includes("OE_TEAMS_INTERNAL_SURFACES"), "…and names no environment variable — the vouch is config-as-code");
    ok(/teams\/<tenantId>"/.test(f), "…and offers the TENANT declaration, which is the vouch (a declaration counts at any rung)");
    ok(/single-window|SINGLE WINDOW/.test(f), "…and answers the single-window case, which is where the grain used to matter");
    ok(/OPE-1521/.test(f), "…naming the ticket that made the window floor walk the rungs — ONE line now serves both planes");
    ok(/membershipType/.test(f), "🔴 …and states the tenant grain's REACH, so the operator can choose the channel grain knowingly");

    const other = run([], [seen("discord/G1/C_GENERAL", 30)]);
    const g = find(other, "undeclared surfaces")?.fix ?? "";
    ok(g.includes("defineSurface("), "NEGATIVE CONTROL: a non-Teams surface still gets the defineSurface remedy");
    ok(g.includes("Declaring the tenant"), "…tenant-grain shortcut included, which is correct off Teams");
    ok(!/OPE-1521/.test(g), "…and no Teams-only window text where no Teams surface is undeclared");

    const mixed = undeclaredSurfacesFix(["discord/G1/C_GENERAL", "teams/deadbeef-1111/19-abc-thread.tacv2"]);
    ok(mixed.includes("Declaring the tenant"), "a mixed list keeps the generic remedy for its non-Teams example…");
    ok(/OPE-1521/.test(mixed), "…and still carries the Teams single-window clause for the Teams key behind it");
  }

  const green = run(
    [defineSurface({ key: "slack/T0", trust: "internal" }), defineSurface({ key: "discord/G1", trust: "public" })],
    [seen("slack/T0/C_ENG", 90), seen("discord/G1/C_GENERAL", 40)],
  );
  eq(find(green, "undeclared surfaces")?.status, "ok", "🔴 NEGATIVE CONTROL: with every surface declared the check is `ok` — and a `public` declaration COUNTS as declared");
  eq(
    green.filter((c) => c.status === "missing").length,
    0,
    "…and the report carries no red at all, so `ready` is not held down by a check that cannot be satisfied",
  );
}

{
  const checks = run(
    [
      defineSurface({ key: "github/acme/e2e-scratch", trust: "internal" }),
      defineSurface({ key: "github/acme/moved-away", trust: "internal" }),
    ],
    [seen("github/acme/e2e-scratch", 60, 1)],
  );
  const amber = find(checks, "dead declarations");
  eq(amber?.status, "info", "CHECK 2: a declaration that matched no traffic is AMBER, never a red — it is config working exactly as written");
  ok(amber?.detail.includes("github/acme/moved-away") === true, "…naming the dead key (a transferred repo, an archived channel, a deleted team)");
  ok(amber?.detail.includes("github/acme/e2e-scratch") === false, "…and NOT the live one");

  const live = run([defineSurface({ key: "github/acme/e2e-scratch", trust: "internal" })], [seen("github/acme/e2e-scratch", 60, 1)]);
  eq(find(live, "dead declarations"), undefined, "🔴 NEGATIVE CONTROL: with every declaration matching, no dead row is emitted");

  const tenant = run([defineSurface({ key: "github/acme", trust: "internal" })], [seen("github/acme/e2e-scratch", 60, 1)]);
  eq(find(tenant, "dead declarations"), undefined, "a TENANT declaration is alive when a surface under it has traffic");

  const dormant = run(
    [defineSurface({ key: "github/acme/one", trust: "internal" }), defineSurface({ key: "github/acme/two", trust: "internal" })],
    [seen("github/acme/one", 400, 200)],
  );
  eq(
    find(dormant, "dead declarations"),
    undefined,
    "a DORMANT deployment (newest traffic older than the window) emits no dead row — absence of traffic there is not evidence about the config",
  );
}

{
  const gridEntry = [defineSurface({ key: "slack/E_GRID", trust: "internal" })];
  const sibling = { ...seen("slack/T_SIB/C_ROOM", 60, 1), enterpriseKey: "slack/E_GRID" };

  const walked = run(gridEntry, [sibling]);
  eq(
    find(walked, "undeclared surfaces")?.status,
    "ok",
    "🔴 enterprise rung: traffic in a sibling workspace under a DECLARED Grid is covered — the check walks the same rungs the resolver walks",
  );
  eq(
    find(walked, "dead declarations"),
    undefined,
    "🔴 enterprise rung: the Grid's own line is ALIVE — it matched traffic through the rung, so the operator is never told to delete a working declaration",
  );

  const unwalked = run(gridEntry, [seen("slack/T_SIB/C_ROOM", 60, 1)]);
  eq(
    find(unwalked, "undeclared surfaces")?.status,
    "missing",
    "🔴 NEGATIVE CONTROL: with no enterpriseKey on the row, the same traffic reports UNDECLARED — the rung is what covers it, not the register",
  );
  ok(
    find(unwalked, "dead declarations")?.fix?.includes("slack/E…") === true,
    "…and the dead-declaration remedy WARNS about the rung before it says delete, which is the sentence that stops an operator dropping a live Grid line",
  );

  const otherGrid = run(gridEntry, [{ ...seen("slack/T_FOREIGN/C_ROOM", 60, 1), enterpriseKey: "slack/E_OTHER" }]);
  eq(
    find(otherGrid, "undeclared surfaces")?.status,
    "missing",
    "🔴 NEGATIVE CONTROL: traffic under an UNDECLARED Grid is still undeclared — the rung admits what the operator named, nothing else",
  );
}

{
  const groupEntry = [defineSurface({ key: "teams/T_ACME/team:ENG", trust: "internal" })];
  const inTeam = { ...seen("teams/T_ACME/19_channel", 60, 1), groupKey: "teams/T_ACME/team:ENG" };

  const walked = run(groupEntry, [inTeam]);
  eq(
    find(walked, "undeclared surfaces")?.status,
    "ok",
    "🔴 group rung: a room whose traffic row names a DECLARED group is covered — the check walks the same rungs the resolver walks",
  );
  eq(
    find(walked, "dead declarations"),
    undefined,
    "🔴 group rung: the group's own line is ALIVE — it matched traffic through the rung, so the operator is never told to delete a working declaration",
  );

  const unwalked = run(groupEntry, [seen("teams/T_ACME/19_channel", 60, 1)]);
  eq(
    find(unwalked, "undeclared surfaces")?.status,
    "missing",
    "🔴 NEGATIVE CONTROL: with no groupKey on the row, the same traffic reports UNDECLARED — the rung is what covers it, not the register",
  );
  ok(
    find(unwalked, "dead declarations")?.fix?.includes("team:…") === true,
    "…and the dead-declaration remedy WARNS about the group rung before it says delete, exactly as it does for the Grid rung",
  );

  const otherTeam = run(groupEntry, [{ ...seen("teams/T_ACME/19_other", 60, 1), groupKey: "teams/T_ACME/team:SALES" }]);
  eq(
    find(otherTeam, "undeclared surfaces")?.status,
    "missing",
    "🔴 NEGATIVE CONTROL: traffic in an UNDECLARED group is still undeclared — the rung admits what the operator named, nothing else",
  );

  const publicGroup = run(
    [defineSurface({ key: "teams/T_ACME/team:ENG", trust: "public" })],
    [inTeam],
  );
  eq(
    find(publicGroup, "undeclared surfaces")?.status,
    "ok",
    "group rung: a `public` group declaration covers the room too — check 1 is about silence, not about trust",
  );

  const bothRungs = { ...seen("slack/T_SIB/C_ROOM", 60, 1), groupKey: "slack/T_SIB/team:X", enterpriseKey: "slack/E_GRID" };
  eq(
    find(run([defineSurface({ key: "slack/E_GRID", trust: "internal" })], [bothRungs]), "undeclared surfaces")?.status,
    "ok",
    "both container rungs on one row: the ENTERPRISE declaration still covers it",
  );
  eq(
    find(run([defineSurface({ key: "slack/T_SIB/team:X", trust: "internal" })], [bothRungs]), "undeclared surfaces")?.status,
    "ok",
    "…and the GROUP declaration covers the same row on its own — adding a rung never shadows the other",
  );
}

{
  const channelEntry = [defineSurface({ key: "teams/T_ACME/19_chan", trust: "internal" })];
  const chain = { ...seen("teams/T_ACME/19_chan-messageid-1", 60, 1), containerKey: "teams/T_ACME/19_chan" };

  const walked = run(channelEntry, [chain]);
  eq(
    find(walked, "undeclared surfaces")?.status,
    "ok",
    "🔴 container grain: a reply chain whose row names its DECLARED channel is covered — the check reads both grains, as bindFrom and the window floor do",
  );
  eq(
    find(walked, "dead declarations"),
    undefined,
    "🔴 container grain: the channel's own line is ALIVE — a working channel-grain declaration is never reported dead",
  );

  eq(
    find(run(channelEntry, [seen("teams/T_ACME/19_chan-messageid-1", 60, 1)]), "undeclared surfaces")?.status,
    "missing",
    "🔴 NEGATIVE CONTROL: with no containerKey on the row, the same reply chain reports UNDECLARED — the second grain is what covers it",
  );

  const deadFix = find(run(channelEntry, [seen("teams/T_ACME/19_chan-messageid-1", 60, 1)]), "dead declarations")?.fix;
  ok(
    deadFix?.includes("teams/<tenant>/<channelId>") === true,
    "🔴 the dead-declaration remedy names the CHANNEL grain as the third shape that reports dead — the shape this deployment actually hits, because a traffic row names the reply chain",
  );
  ok(
    deadFix?.includes("THREE shapes") === true,
    "…and it counts them, so a later rung cannot be added while the sentence still says two",
  );

  eq(
    find(
      run(channelEntry, [{ ...seen("teams/T_ACME/19_other-messageid-1", 60, 1), containerKey: "teams/T_ACME/19_other" }]),
      "undeclared surfaces",
    )?.status,
    "missing",
    "🔴 NEGATIVE CONTROL: a reply chain in an UNDECLARED channel is still undeclared",
  );

  eq(
    find(run(channelEntry, [{ ...seen("teams/T_ACME/19_chan", 60, 1), containerKey: "teams/T_ACME/19_chan" }]), "undeclared surfaces")
      ?.status,
    "ok",
    "container grain: a container equal to the surface key is dropped, and the room is covered by its own key exactly as before",
  );
}

{
  const checks = run(
    [
      defineSurface({ key: "github/acme/payments-*", trust: "internal" }),
      defineSurface({ key: "github/acme/e2e-scratch", trust: "internal" }),
    ],
    [
      seen("github/acme/payments-api", 200),
      seen("github/acme/payments-vendor-scratch", 2),
      seen("github/acme/e2e-scratch", 1),
    ],
  );
  const amber = find(checks, "new matches");
  eq(amber?.status, "info", "CHECK 3: a pattern's new matches are AMBER");
  ok(amber?.name.includes("github/acme/payments-*") === true, "…and the row names the PATTERN responsible, not just the surfaces");
  ok(
    amber?.detail.includes("github/acme/payments-vendor-scratch") === true,
    "🔴 CHECK 3 IS THE ONLY SIGNAL FOR RENAME-ANNEXATION: a repo renamed INTO the glob's prefix inherits its trust, and this is what surfaces it",
  );
  ok(amber?.detail.includes("github/acme/payments-api") === false, "…and NOT a long-standing match, which would drown the new one");
  ok(
    amber?.detail.includes("github/acme/e2e-scratch") === false,
    "🔴 an EXACT entry never contributes: it enumerates one key, so it cannot annex anything — only a PATTERN can",
  );
  ok(amber?.fix?.includes("cannot prevent") === true, "🔴 the row says in terms that it is a DETECTOR, not a fence — an operator must not read it as a control");

  const tenantDiff = run([defineSurface({ key: "slack/T0", trust: "internal" })], [seen("slack/T0/C_BRAND_NEW", 1)]);
  ok(
    find(tenantDiff, "new matches")?.detail.includes("slack/T0/C_BRAND_NEW") === true,
    "a TENANT declaration is a pattern too — a room created yesterday inherits `internal` with no config change, which is exclude mode's fail-open",
  );

  const groupDiff = run(
    [defineSurface({ key: "teams/T_ACME/team:ENG", trust: "internal" })],
    [{ ...seen("teams/T_ACME/19_brand_new", 1), groupKey: "teams/T_ACME/team:ENG" }],
  );
  ok(
    find(groupDiff, "new matches")?.detail.includes("teams/T_ACME/19_brand_new") === true,
    "🔴 a GROUP declaration is a pattern too — a channel added to a declared team yesterday inherits its trust with no config change, and the detector must still see it",
  );
  ok(
    find(groupDiff, "new matches")?.name.includes("teams/T_ACME/team:ENG") === true,
    "…and the row names the GROUP line responsible, which is the line an operator would have to narrow",
  );
  const groupOverTenant = run(
    [defineSurface({ key: "teams/T_ACME", trust: "internal" }), defineSurface({ key: "teams/T_ACME/team:ENG", trust: "internal" })],
    [{ ...seen("teams/T_ACME/19_brand_new", 1), groupKey: "teams/T_ACME/team:ENG" }],
  );
  eq(
    find(groupOverTenant, "new matches")?.name.includes("teams/T_ACME/team:ENG"),
    true,
    "🔴 with a tenant line ABOVE the group line the row still fires, and names the GROUP — the more specific decider, exactly as the resolver ranks them",
  );
  const enumerated = run(
    [
      defineSurface({ key: "teams/T_ACME/team:ENG", trust: "internal" }),
      defineSurface({ key: "teams/T_ACME/19_brand_new", trust: "internal" }),
    ],
    [{ ...seen("teams/T_ACME/19_brand_new", 1), groupKey: "teams/T_ACME/team:ENG" }],
  );
  eq(
    find(enumerated, "new matches"),
    undefined,
    "🔴 NEGATIVE CONTROL: an EXACT entry beats the group entry and emits no row — a surface the operator enumerated was not annexed by anything",
  );

  const settled = run([defineSurface({ key: "github/acme/payments-*", trust: "internal" })], [seen("github/acme/payments-api", 200)]);
  eq(find(settled, "new matches"), undefined, "🔴 NEGATIVE CONTROL: with no recently-started traffic, no claim-diff row is emitted");
}

{
  const fresh = run([], []);
  eq(fresh.length, 1, "a deployment with no declarations and no traffic gets exactly one row");
  eq(fresh[0].status, "info", "…and it is INFO — nothing has gone wrong on a fresh install");
  ok(fresh[0].detail.includes("no traffic recorded") === true, "…saying so in terms");
  ok(
    find(fresh, "undeclared surfaces") === undefined,
    "🔴 it does NOT emit an `ok` undeclared-surfaces row — a green there would read as 'we checked and every surface is declared', which is the exact 'we could not ask' / 'we asked and it was fine' conflation this design forbids",
  );
  const declaredNoTraffic = run([defineSurface({ key: "slack/T0", trust: "internal" })], []);
  ok(declaredNoTraffic[0].detail.includes("1 surface declaration"), "…and with declarations but no traffic it reports the count, so the operator can tell the two apart");
}

{
  const rows = [
    { ts: "2026-08-10T00:00:00.000Z", platform: "slack", workspace: "T0", surface: "C1" },
    { ts: "2026-04-04T23:30:00.000Z", platform: "slack", workspace: "T0", surface: "C1" },
    { ts: "2026-08-12T00:00:00.000Z", platform: "slack", workspace: "T0", surface: "C1" },
    { ts: "2026-08-05T00:00:00.000Z", platform: "github", workspace: "acme", surface: "repo" },
    { ts: "2026-04-09T23:30:00.000Z", platform: "slack", workspace: "T0" },
  ];
  const folded = surfaceTrafficFromAudit(rows);
  eq(folded.length, 2, "the fold groups by surface key");
  eq(
    folded.find((f) => f.surfaceKey === "slack/T0/C1"),
    { surfaceKey: "slack/T0/C1", firstSeen: "2026-04-04T23:30:00.000Z", lastSeen: "2026-08-12T00:00:00.000Z" },
    "…and takes the EARLIEST as firstSeen and the LATEST as lastSeen, whatever order the rows arrive in",
  );
  ok(folded.every((f) => f.surfaceKey.split("/").length === 3), "🔴 a row with NO surface is SKIPPED — an org-scoped event names no room to declare");
}

{
  _resetPreflightProbesForTest();
  registerSurfaceTrustPreflight({
    entries: () => [defineSurface({ key: "slack/T0", trust: "internal" })],
    auditRows: async () => [{ ts: daysAgo(3), platform: "discord", workspace: "G1", surface: "C_OPEN" }],
    now: () => NOW,
  });
  const checks = await runPreflightProbes({});
  eq(find(checks, "undeclared surfaces")?.status, "missing", "the probe runs the checks over the register and the audit log");

  _resetPreflightProbesForTest();
  registerSurfaceTrustPreflight({
    entries: () => [defineSurface({ key: "slack/T0", trust: "internal" })],
    auditRows: async () => {
      throw new Error("no DATABASE_URL");
    },
    now: () => NOW,
  });
  const soft = await runPreflightProbes({});
  eq(soft.length, 1, "an unreachable store yields exactly one row");
  eq(
    soft[0].status,
    "info",
    "🔴 FAIL-SOFT: an unreachable store is INFO, never `missing` — a red there would be a complaint about the OPERATOR's shell wearing the costume of a complaint about the DEPLOYMENT's config, and it would hold `ready` down forever",
  );
  ok(soft[0].detail.includes("no DATABASE_URL"), "…and it says what actually failed");
  _resetPreflightProbesForTest();
}

{
  const { appendAudit } = await import("../agent/audit/audit.js");
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await appendAudit({ ts: recent, org: "acme", platform: "slack", workspace: "T_MINE", surface: "C_MINE", action: "slack.replied" });
  await appendAudit({
    ts: recent,
    org: "other-tenant",
    platform: "discord",
    workspace: "G_THEIRS",
    surface: "C_THEIRS",
    action: "discord.replied",
  });

  _resetPreflightProbesForTest();
  registerSurfaceTrustPreflight({
    entries: () => [defineSurface({ key: "github/acme/unrelated", trust: "internal" })],
  });
  const checks = await runPreflightProbes({});
  const red = find(checks, "undeclared surfaces");
  eq(red?.status, "missing", "the probe read the real store and found undeclared traffic");
  ok(
    red?.detail.includes("slack/T_MINE/C_MINE") === true,
    "🔴 POSITIVE CONTROL: THIS deployment's own undeclared surface IS named — the filter narrows the page, it does not empty it",
  );
  ok(
    red?.detail.includes("discord/G_THEIRS/C_THEIRS") === false,
    "🔴 DEFECT: the OTHER tenant's surface is NOT named — an unfiltered page reported another org's channels to this org's operator",
  );

  _resetPreflightProbesForTest();
  registerSurfaceTrustPreflight({ entries: () => [defineSurface({ key: "slack/T_MINE", trust: "internal" })] });
  const covered = await runPreflightProbes({});
  eq(
    find(covered, "undeclared surfaces")?.status,
    "ok",
    "…and with this org's own surface declared the check is `ok` — the foreign row raises no red from behind the filter either",
  );
  _resetPreflightProbesForTest();
}

console.log(`\n✓ surface-trust-preflight: ${n} assertions passed`);

// proves: AP-MOD-core-identity-trust-preflight

// proves: SET-056
