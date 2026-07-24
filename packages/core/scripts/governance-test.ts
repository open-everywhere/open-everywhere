
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-governance-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_ORG = "gov-test";

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import {
  defineDomain,
  assertGovernanceDomains,
  governanceDomains,
  isGovernanceChannel,
  governanceChannelFor,
  GOVERNANCE_CHANNEL_MAX,
  type Domain,
} from "../agent/memory/domain.js";
import {
  computeAudienceFloor,
  attestGovernanceFloor,
  attestGovernanceChannel,
  governanceAdminSet,
  registerGovernanceMemberSupplier,
  _resetGovernanceMemberSupplierForTest,
  _resetGovernanceFloorCacheForTest,
  floorBreachNotice,
  type RoomRoster,
} from "../agent/access/audience-floor.js";
import { classifyPaneVenue, requirePaneVenue, PaneRedirectError } from "../agent/access/pane-venue.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  n++;
};

{
  const gov = defineDomain({ name: "governance", governance: true, channels: ["slack/T1/C_ADMIN"], admins: ["U_A", "U_B"] });
  const org = defineDomain({ name: "org", match: "org", admins: ["U_ORG"] });
  const plain = defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], admins: ["U_A"] });

  assert.doesNotThrow(() => assertGovernanceDomains([gov, org, plain], []), "valid governance domain (slack = binding-trusted) passes the lint");
  n++;

  ok(governanceDomains([gov, org, plain]).length === 1, "governanceDomains returns only the flagged domain");
  ok(isGovernanceChannel("slack/T1/C_ADMIN", [gov, org, plain]), "isGovernanceChannel true for a governance channel");
  ok(!isGovernanceChannel("slack/T1/C_ENG", [gov, org, plain]), "isGovernanceChannel false for an ordinary domain channel");
  ok(governanceChannelFor([gov, org, plain]) === "slack/T1/C_ADMIN", "governanceChannelFor picks the first governance channel");
  ok(governanceChannelFor([org, plain]) === undefined, "governanceChannelFor is undefined with no governance domain + no fallback");
  ok(governanceChannelFor([org, plain], "slack/T1/C_FALLBACK") === "slack/T1/C_FALLBACK", "governanceChannelFor uses the OE_ACCESS_ADMIN_CHANNEL fallback alias");

  const throwsGov = (d: Domain, needle: RegExp, label: string) => {
    let threw = false;
    try {
      assertGovernanceDomains([d], []);
    } catch (err) {
      threw = true;
      ok(needle.test(String(err)), `${label}: message explains it`);
    }
    ok(threw, `${label}: throws`);
  };
  throwsGov(defineDomain({ name: "g", governance: true, match: "org", admins: ["U_A"] } as never), /explicit channels domain/, "a match/pseudo governance domain");
  throwsGov(defineDomain({ name: "g", governance: true, channels: ["slack/T1/C"] }), /empty admins roster/, "a governance domain with no admins");
  throwsGov(
    defineDomain({ name: "g", governance: true, channels: Array.from({ length: GOVERNANCE_CHANNEL_MAX + 1 }, (_, i) => `slack/T1/C${i}`), admins: ["U_A"] }),
    /exceeds the .* governance cap/,
    "a governance domain over the channel cap",
  );
  throwsGov(defineDomain({ name: "g", governance: true, channels: ["notion/ws/pg"], admins: ["U_A"] }), /not operator-vouched-internal/, "a governance domain with an un-vouched non-binding-trusted channel");

  assert.doesNotThrow(
    () => assertGovernanceDomains([defineDomain({ name: "g", governance: true, channels: ["notion/ws/pg"], admins: ["U_A"] })], ["notion/ws"]),
    "a governance domain whose non-slack channel is operator-vouched passes",
  );
  n++;
}

{
  const admins = new Set(["U_A", "U_B"]);
  const roster = (over: Partial<RoomRoster>): RoomRoster => ({ humanMemberIds: ["U_A", "U_B"], resolved: true, isPrivate: true, hasGuest: false, ...over });

  ok(computeAudienceFloor(roster({}), admins) === "admin", "floor = admin when every human is an admin, private, resolved");
  ok(computeAudienceFloor(roster({ humanMemberIds: ["U_A", "U_X"] }), admins) === "member", "floor = member when a non-admin human is present");
  ok(computeAudienceFloor(roster({ isPrivate: false }), admins) === "member", "floor = member (never admin) when the channel is public, even all-admin");
  ok(computeAudienceFloor(roster({ resolved: false }), admins) === "guest", "floor = guest (fail-closed) when membership is unresolved");
  ok(computeAudienceFloor(roster({ hasGuest: true }), admins) === "guest", "floor = guest when a guest/external member is present");
  ok(computeAudienceFloor(roster({ humanMemberIds: [] }), admins) === "member", "floor = member (not admin) for an empty resolved membership");

  ok(attestGovernanceFloor(roster({}), admins).armed, "attest: armed when floor = admin");
  const nonAdmin = attestGovernanceFloor(roster({ humanMemberIds: ["U_A", "U_X"] }), admins);
  ok(!nonAdmin.armed && nonAdmin.breach?.reason === "non-admin-member", "attest: non-admin-member breach");
  ok(JSON.stringify(nonAdmin.breach?.missing) === JSON.stringify(["U_X"]), "attest: breach names exactly the off-roster member(s)");
  ok(attestGovernanceFloor(roster({ resolved: false }), admins).breach?.reason === "members-unresolved", "attest: members-unresolved breach");
  ok(attestGovernanceFloor(roster({ isPrivate: false }), admins).breach?.reason === "public-channel", "attest: public-channel breach");
  ok(attestGovernanceFloor(roster({ hasGuest: true }), admins).breach?.reason === "guest-present", "attest: guest-present breach");
  ok(/isn't on the roster/.test(floorBreachNotice(nonAdmin.breach!)), "floorBreachNotice names the off-roster member for a non-admin breach");

  const domains = [
    defineDomain({ name: "governance", governance: true, channels: ["slack/T1/C_ADMIN"], admins: ["U_A"] }),
    defineDomain({ name: "org", match: "org", admins: ["U_ORG"] }),
  ];
  const set = governanceAdminSet("slack/T1/C_ADMIN", domains);
  ok(set.has("U_A") && set.has("U_ORG") && set.size === 2, "governanceAdminSet = domain admins ∪ org admins");
}

{
  const domains = [
    defineDomain({ name: "governance", governance: true, channels: ["slack/T1/C_ADMIN"], admins: ["U_A", "U_B"] }),
    defineDomain({ name: "org", match: "org", admins: ["U_ORG"] }),
  ];
  const attestCtx = { org: "gov-test", platform: "slack", workspace: "T1", surface: "C_ADMIN", principalId: "U_A" };

  _resetGovernanceMemberSupplierForTest();
  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A", "U_B"], resolved: true, isPrivate: true, hasGuest: false }));
  const armed = await attestGovernanceChannel("slack/T1/C_ADMIN", domains, attestCtx);
  ok(armed.armed, "attestGovernanceChannel arms on an all-admin private roster");
  ok((await readAudit({ action: "governance.floor_breach" })).length === 0, "no floor_breach audit row when armed");

  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A", "U_STRANGER"], resolved: true, isPrivate: true, hasGuest: false }));
  const breached = await attestGovernanceChannel("slack/T1/C_ADMIN", domains, attestCtx);
  ok(!breached.armed && breached.breach?.reason === "non-admin-member", "attestGovernanceChannel demotes fail-closed on a non-admin member");
  const breachRows = await readAudit({ action: "governance.floor_breach" });
  ok(breachRows.length === 1, "exactly one governance.floor_breach audit row is written on the breach");
  ok(
    (breachRows[0].detail as { missing?: string[]; domain?: string })?.missing?.includes("U_STRANGER") === true &&
      (breachRows[0].detail as { domain?: string })?.domain === "governance",
    "floor_breach detail carries the missing member + the governance domain name",
  );

  registerGovernanceMemberSupplier(async () => {
    throw new Error("supplier must not be called within the memo window");
  });
  const cached = await attestGovernanceChannel("slack/T1/C_ADMIN", domains, attestCtx);
  ok(!cached.armed, "attestation is memoized within the TTL (no re-fetch)");
  ok((await readAudit({ action: "governance.floor_breach" })).length === 1, "memoized attestation does not write a second floor_breach row");
  _resetGovernanceMemberSupplierForTest();
  _resetGovernanceFloorCacheForTest();
}

{
  const armed = { armed: true as const, floor: "admin" as const };
  ok(classifyPaneVenue({ isRequesterDm: false, isGovernanceChannel: true, attestation: armed }).placement === "inline", "armed governance channel renders inline");
  ok(classifyPaneVenue({ isRequesterDm: true, isGovernanceChannel: false }).placement === "inline", "the requester's own DM renders inline");
  const redirGov = classifyPaneVenue({ isRequesterDm: false, isGovernanceChannel: false, governanceChannel: "slack/T1/C_ADMIN" });
  ok(redirGov.placement === "redirect" && redirGov.target === "governance-channel" && redirGov.channel === "slack/T1/C_ADMIN", "a plain channel redirects to the governance channel when configured");
  const redirDm = classifyPaneVenue({ isRequesterDm: false, isGovernanceChannel: false });
  ok(redirDm.placement === "redirect" && redirDm.target === "requester-dm", "a plain channel redirects to the requester DM when no governance channel is configured");
  const brokenGov = classifyPaneVenue({ isRequesterDm: false, isGovernanceChannel: true, attestation: { armed: false, floor: "member", breach: { reason: "non-admin-member", missing: ["U_X"], members: ["U_A", "U_X"] } }, governanceChannel: "slack/T1/C_ADMIN" });
  ok(brokenGov.placement === "redirect", "a BREACHED governance channel does NOT render inline (fail-closed demote)");
}

const baseConfig = (domains: readonly Domain[]) => ({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: () => [],
});

function ctxFor(principalId: string, channelId: string, channelType: "channel" | "im"): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          principalId,
          principalType: "slack-user",
          attributes: { team_id: "T1", channel_id: channelId, channel_type: channelType, is_private: channelType === "im" ? "true" : "true" },
        },
      },
    },
  } as unknown as BindableContext;
}

{
  const govDomains: Domain[] = [
    defineDomain({ name: "governance", governance: true, channels: ["slack/T1/C_ADMIN"], admins: ["U_ORG"] }),
    defineDomain({ name: "org", match: "org", admins: ["U_ORG"] }),
  ];

  registerConfig(baseConfig([defineDomain({ name: "org", match: "org", admins: ["U_ORG"] })]) as never);
  {
    const decision = await requirePaneVenue(ctxFor("U_ORG", "C_GENERAL", "channel"), { kind: "spend.report.org" });
    ok(decision.placement === "inline", "requirePaneVenue is INERT (inline) when no governance domain is configured");
  }

  registerConfig(baseConfig(govDomains) as never);
  _resetGovernanceMemberSupplierForTest();
  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_ORG"], resolved: true, isPrivate: true, hasGuest: false }));
  {
    const decision = await requirePaneVenue(ctxFor("U_ORG", "C_ADMIN", "channel"), { kind: "spend.report.org" });
    ok(decision.placement === "inline", "requirePaneVenue renders inline in an ARMED governance channel");
  }

  {
    const decision = await requirePaneVenue(ctxFor("U_ORG", "D_DM", "im"), { kind: "spend.report.org" });
    ok(decision.placement === "inline", "requirePaneVenue renders inline in the requester's own DM (view-only fallback)");
  }

  _resetGovernanceFloorCacheForTest();
  {
    let threw = false;
    try {
      await requirePaneVenue(ctxFor("U_ORG", "C_GENERAL", "channel"), { kind: "spend.report.org" });
    } catch (err) {
      threw = true;
      ok(err instanceof PaneRedirectError, "requirePaneVenue throws a PaneRedirectError from a non-governance channel");
      ok((err as PaneRedirectError).target === "governance-channel" && (err as PaneRedirectError).channel === "slack/T1/C_ADMIN", "the redirect targets the configured governance channel");
      ok(/I've posted it in slack\/T1\/C_ADMIN/.test(String((err as PaneRedirectError).message)), "the directive tells the agent to deliver in the governance channel + leave a pointer");
    }
    ok(threw, "requirePaneVenue redirects (throws) from a plain channel");
  }
  const redirected = await readAudit({ action: "governance.redirected" });
  ok(redirected.length >= 1, "a governance.redirected audit row is stamped on the redirect");
  ok(
    (redirected[0].detail as { from?: string; to?: string; kind?: string })?.from === "slack/T1/C_GENERAL" &&
      (redirected[0].detail as { to?: string })?.to === "governance-channel" &&
      (redirected[0].detail as { kind?: string })?.kind === "spend.report.org",
    "governance.redirected detail carries { from, to, kind }",
  );

  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_ORG", "U_STRANGER"], resolved: true, isPrivate: true, hasGuest: false }));
  {
    let threw = false;
    try {
      await requirePaneVenue(ctxFor("U_ORG", "C_ADMIN", "channel"), { kind: "spend.report.org" });
    } catch (err) {
      threw = true;
      ok(err instanceof PaneRedirectError, "a breached governance channel redirects fail-closed rather than rendering inline");
    }
    ok(threw, "requirePaneVenue redirects from a breached governance channel");
    ok((await readAudit({ action: "governance.floor_breach" })).some((r) => (r.detail as { missing?: string[] })?.missing?.includes("U_STRANGER")), "the breach in a governance channel stamps floor_breach naming the stranger");
  }
  _resetGovernanceMemberSupplierForTest();
  _resetGovernanceFloorCacheForTest();
}

{
  const govDomains: Domain[] = [
    defineDomain({ name: "governance", governance: true, channels: ["slack/T1/C_ADMIN"], admins: ["U_ORG"] }),
    defineDomain({ name: "org", match: "org", admins: ["U_ORG"] }),
  ];
  registerConfig(baseConfig(govDomains) as never);
  _resetGovernanceMemberSupplierForTest();
  _resetGovernanceFloorCacheForTest();
  const spendReport = (await import("../agent/tools/spend_report.js")).default;

  await assert.rejects(
    async () => spendReport.execute({ scope: "org" }, ctxFor("U_ORG", "C_GENERAL", "channel") as never),
    (err: unknown) => err instanceof PaneRedirectError,
    "spend_report scope:org redirects pane output out of a non-governance channel (dual gate wired)",
  );
  n++;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ governance: ${n} assertions passed (OPE-110 governance venue: config lint + floor tripwire + dual gate + redirect-and-fulfil)\n`);
