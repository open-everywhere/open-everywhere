
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-governance-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "gov-test" });

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
import { classifyPaneVenue, requirePaneVenue, fulfilPaneRead, PaneRedirectError, PaneDmDeliveredError } from "../agent/access/pane-venue.js";
import { registerPostArm, dispatchDirectMessage, canDeliverDirectMessage, directMessageCapablePlatforms, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext } from "../agent/identity/binding.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();


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
  const gov = defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_A", "slack/T1/U_B"] });
  const org = defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"] });
  const plain = defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"], admins: ["slack/T1/U_A"] });

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
  throwsGov(defineDomain({ name: "g", governance: true, match: "org", admins: ["slack/T1/U_A"] } as never), /is governance but has no reach/, "a match/pseudo governance domain");
  throwsGov(defineDomain({ name: "g", governance: true, reach: ["slack/T1/C"] }), /empty admins roster/, "a governance domain with no admins");
  throwsGov(
    defineDomain({ name: "g", governance: true, reach: Array.from({ length: GOVERNANCE_CHANNEL_MAX + 1 }, (_, i) => `slack/T1/C${i}`), admins: ["slack/T1/U_A"] }),
    /exceeds the .* governance cap/,
    "a governance domain over the channel cap",
  );
  throwsGov(defineDomain({ name: "g", governance: true, reach: ["notion/ws/pg"], admins: ["notion/U_A"] }), /not operator-vouched-internal/, "a governance domain with an un-vouched non-binding-trusted channel");

  assert.doesNotThrow(
    () => assertGovernanceDomains([defineDomain({ name: "g", governance: true, reach: ["notion/ws/pg"], admins: ["notion/U_A"] })], ["notion/ws"]),
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
    defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_A"] }),
    defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"] }),
  ];
  const set = governanceAdminSet("slack/T1/C_ADMIN", domains);
  ok(set.has("U_A") && set.has("U_ORG") && set.size === 2, "governanceAdminSet = domain admins ∪ org admins, PROJECTED to bare ids in the channel's own platform namespace (a RoomRoster speaks the platform's ids, not qualified keys)");
  const crossPlatform = [
    defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_A"] }),
    defineDomain({ name: "org", match: "org", admins: ["discord/U_A", "teams/U_ORG"] }),
  ];
  const projected = governanceAdminSet("slack/T1/C_ADMIN", crossPlatform);
  ok(projected.has("U_A") && projected.size === 1, "🔴 governanceAdminSet drops other platforms' roster entries — a discord/U_A admin is not U_A in a Slack governance room, and teams/U_ORG contributes nothing");
  ok(governanceAdminSet("eng", domains).size === 0, "governanceAdminSet on a key with no readable platform (a bare domain name) is EMPTY — fail closed, never a bare-id match");
}

{
  const domains = [
    defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_A", "slack/T1/U_B"] }),
    defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"] }),
  ];
  const attestCtx = { org: "gov-test", platform: "slack", workspace: "T1", surface: "C_ADMIN", principalId: "U_A" };

  _resetGovernanceMemberSupplierForTest();
  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A", "U_B"], resolved: true, isPrivate: true, hasGuest: false }));
  const armed = await attestGovernanceChannel("slack/T1/C_ADMIN", domains, attestCtx);
  ok(armed.armed, "attestGovernanceChannel arms on an all-admin private roster");
  ok((await readAudit({ org: "gov-test", action: "governance.floor_breach" })).length === 0, "no floor_breach audit row when armed");

  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A", "U_STRANGER"], resolved: true, isPrivate: true, hasGuest: false }));
  const breached = await attestGovernanceChannel("slack/T1/C_ADMIN", domains, attestCtx);
  ok(!breached.armed && breached.breach?.reason === "non-admin-member", "attestGovernanceChannel demotes fail-closed on a non-admin member");
  const breachRows = await readAudit({ org: "gov-test", action: "governance.floor_breach" });
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
  ok((await readAudit({ org: "gov-test", action: "governance.floor_breach" })).length === 1, "memoized attestation does not write a second floor_breach row");
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
    defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_ORG"] }),
    defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"] }),
  ];

  registerConfig(baseConfig([defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"] })]) as never);
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
  const redirected = await readAudit({ org: "gov-test", action: "governance.redirected" });
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
    ok((await readAudit({ org: "gov-test", action: "governance.floor_breach" })).some((r) => (r.detail as { missing?: string[] })?.missing?.includes("U_STRANGER")), "the breach in a governance channel stamps floor_breach naming the stranger");
  }
  _resetGovernanceMemberSupplierForTest();
  _resetGovernanceFloorCacheForTest();
}

{
  const govDomains: Domain[] = [
    defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_ORG"] }),
    defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"] }),
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

{
  const orgOnly = (delivery?: "channel" | "dm-fallback") => [
    defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"], ...(delivery ? { governanceDelivery: delivery } : {}) }),
  ];

  {
    let threw = false;
    try {
      assertGovernanceDomains([defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"], governanceDelivery: "dm-fallback" })], []);
    } catch (err) {
      threw = true;
      ok(/single ORG-WIDE knob/.test(String(err)), "the governanceDelivery lint explains it belongs on the org pseudo-domain");
    }
    ok(threw, "governanceDelivery on a non-org domain fails the config lint");
    assert.doesNotThrow(() => assertGovernanceDomains(orgOnly("dm-fallback"), []), "governanceDelivery on the org pseudo-domain passes the lint");
    n++;
  }

  {
    registerConfig(baseConfig(orgOnly()) as never);
    let ran = false;
    const value = await fulfilPaneRead(ctxFor("U_ORG", "C_GENERAL", "channel"), { kind: "spend.report.org", render: () => "x" }, async () => {
      ran = true;
      return { secret: "org-wide totals" };
    });
    ok(ran && value.secret === "org-wide totals", "without governanceDelivery the venue gate stays INERT (the read renders in place, as before OPE-44)");
  }

  const sent: DirectMessageRequest[] = [];
  const armWithDm = () =>
    registerPostArm({
      platform: "slack",
      deliverDirectMessage: async (input) => {
        sent.push(input);
        return { surfaceId: "D_REQUESTER", messageId: "1712.0001" };
      },
    });
  const armWithoutDm = () => registerPostArm({ platform: "slack" });

  armWithDm();
  ok(canDeliverDirectMessage("slack"), "canDeliverDirectMessage is true for a provider whose arm implements it");
  ok(!canDeliverDirectMessage("notion"), "canDeliverDirectMessage is false for a platform with no arm at all");
  ok(directMessageCapablePlatforms().includes("slack"), "directMessageCapablePlatforms lists the DM-capable provider");
  await assert.rejects(
    () => dispatchDirectMessage("notion", { principalId: "U_ORG", text: "hi" }),
    (err: unknown) => err instanceof Error && /no DM-delivery arm for platform "notion"/.test(err.message) && !/xox|token=/.test(err.message),
    "dispatchDirectMessage throws a loud, token-free refusal for a platform with no DM arm",
  );
  n++;

  {
    registerConfig(baseConfig(orgOnly("dm-fallback")) as never);
    sent.length = 0;
    let ran = false;
    let threw = false;
    try {
      await fulfilPaneRead(
        ctxFor("U_ORG", "C_GENERAL", "channel"),
        { kind: "spend.report.org", render: (v: { secret: string }) => `TOTALS: ${v.secret}` },
        async () => {
          ran = true;
          return { secret: "org-wide totals" };
        },
      );
    } catch (err) {
      threw = true;
      ok(err instanceof PaneDmDeliveredError, "a delivered DM throws PaneDmDeliveredError (not a plain redirect)");
      ok((err as PaneDmDeliveredError).dmSurfaceId === "D_REQUESTER", "the delivered error carries the DM conversation id");
      const msg = String((err as Error).message);
      ok(/sent you a DM/.test(msg), "the room directive asks for a pointer only");
      ok(!/org-wide totals/.test(msg) && !/TOTALS/.test(msg), "the room directive carries NO substance");
    }
    ok(threw, "the DM-delivery arm throws rather than returning the substance to the model");
    ok(ran, "the DM arm DOES compute the substance (redirect-and-FULFIL, not refuse)");
    ok(sent.length === 1 && sent[0].principalId === "U_ORG", "the substance was delivered to the requesting principal's DM");
    ok(/TOTALS: org-wide totals/.test(sent[0].text), "the DM carries the rendered substance");
    ok(/asked in slack\/T1\/C_GENERAL/.test(sent[0].text), "the DM envelope names where it was asked + why it arrived");

    const delivered = await readAudit({ org: "gov-test", action: "governance.dm_delivered" });
    ok(delivered.length === 1, "exactly one governance.dm_delivered audit row is written");
    const d = delivered[0].detail as { kind?: string; from?: string; to?: string; dmSurface?: string };
    ok(d.kind === "spend.report.org" && d.from === "slack/T1/C_GENERAL" && d.to === "requester-dm" && d.dmSurface === "D_REQUESTER", "governance.dm_delivered detail carries { kind, from, to, dmSurface }");
    ok(!JSON.stringify(delivered[0].detail).includes("org-wide totals"), "the audit row carries NO substance");
  }

  {
    sent.length = 0;
    let ran = false;
    let threw = false;
    try {
      await fulfilPaneRead(ctxFor("U_NOBODY", "C_GENERAL", "channel"), { kind: "spend.report.org", render: () => "x" }, async () => {
        ran = true;
        return {};
      });
    } catch (err) {
      threw = true;
      ok(err instanceof PaneRedirectError, "an unverifiable role refuses with the ordinary redirect error");
      ok(/holds no admin standing/.test(String((err as Error).message)), "the refusal names why the DM wasn't sent");
    }
    ok(threw && !ran && sent.length === 0, "an unverifiable role NEVER computes or delivers org-scope substance");
    const rows = await readAudit({ org: "gov-test", action: "governance.redirected" });
    ok(rows.some((r) => (r.detail as { refused?: string })?.refused === "role-unverified"), "a role-unverified refusal is audited as governance.redirected { refused }");
  }

  {
    armWithoutDm();
    let ran = false;
    let threw = false;
    try {
      await fulfilPaneRead(ctxFor("U_ORG", "C_GENERAL", "channel"), { kind: "spend.report.org", render: () => "x" }, async () => {
        ran = true;
        return {};
      });
    } catch (err) {
      threw = true;
      ok(err instanceof PaneRedirectError, "a provider with no DM arm refuses with the ordinary redirect error");
      ok(/can't DM on "slack"/.test(String((err as Error).message)), "the refusal names the platform that can't DM");
    }
    ok(threw && !ran, "a provider with no DM arm never computes org-scope substance");
    ok((await readAudit({ org: "gov-test", action: "governance.redirected" })).some((r) => (r.detail as { refused?: string })?.refused === "no-dm-arm"), "a missing DM arm is audited as governance.redirected { refused: no-dm-arm }");
  }

  {
    registerPostArm({
      platform: "slack",
      deliverDirectMessage: async () => {
        throw new Error("missing_scope: im:write");
      },
    });
    let threw = false;
    try {
      await fulfilPaneRead(ctxFor("U_ORG", "C_GENERAL", "channel"), { kind: "spend.report.org", render: (v: { secret: string }) => v.secret }, async () => ({ secret: "org-wide totals" }));
    } catch (err) {
      threw = true;
      ok(err instanceof PaneRedirectError && !(err instanceof PaneDmDeliveredError), "a failed DM post refuses (never reports delivery)");
      const msg = String((err as Error).message);
      ok(/missing_scope/.test(msg) && !/org-wide totals/.test(msg), "the refusal names the delivery failure and carries no substance");
    }
    ok(threw, "a failed DM post throws rather than returning the substance");
    ok((await readAudit({ org: "gov-test", action: "governance.dm_delivered" })).length === 1, "a failed DM post writes NO extra governance.dm_delivered row");
    ok((await readAudit({ org: "gov-test", action: "governance.redirected" })).some((r) => (r.detail as { refused?: string })?.refused === "dm-delivery-failed"), "a failed DM post is audited as governance.redirected { refused: dm-delivery-failed }");
  }

  {
    armWithDm();
    sent.length = 0;
    registerConfig(
      baseConfig([
        defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_ORG"] }),
        defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"], governanceDelivery: "dm-fallback" }),
      ]) as never,
    );
    _resetGovernanceFloorCacheForTest();
    let ran = false;
    let threw = false;
    try {
      await fulfilPaneRead(ctxFor("U_ORG", "C_GENERAL", "channel"), { kind: "spend.report.org", render: () => "x" }, async () => {
        ran = true;
        return {};
      });
    } catch (err) {
      threw = true;
      ok(err instanceof PaneRedirectError && (err as PaneRedirectError).target === "governance-channel", "with a governance channel configured the redirect still targets it, not the DM");
    }
    ok(threw && !ran && sent.length === 0, "the governance-channel redirect never computes the substance (OPE-110's shape preserved)");
  }

  {
    registerConfig(baseConfig(orgOnly("dm-fallback")) as never);
    sent.length = 0;
    const value = await fulfilPaneRead(ctxFor("U_ORG", "D_DM", "im"), { kind: "spend.report.org", render: () => "x" }, async () => ({ secret: "s" }));
    ok(value.secret === "s" && sent.length === 0, "asked IN the requester's DM the read renders inline (no re-delivery)");
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ governance: ${n} assertions passed (OPE-110 governance venue + OPE-44 DM-delivery arm)\n`);
