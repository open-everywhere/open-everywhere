import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-disclosure-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "disc-test" });

import assert from "node:assert/strict";
import { ConfigLoadRefusalError, registerConfig } from "../agent/access/config.js";
import {
  assertComplianceDomains,
  defineDomain,
  requestorEntitlementChecksEnabled,
  type Domain,
} from "../agent/memory/domain.js";
import {
  attestGovernanceChannel,
  attestGovernanceFloor,
  computeAudienceFloor,
  registerGovernanceMemberSupplier,
  resolveAudienceFloor,
  resolveRoomRoster,
  rosterState,
  UNRESOLVED_ROSTER_TTL_MS,
  _resetAudienceFloorCacheForTest,
  _resetGovernanceMemberSupplierForTest,
  type AudienceFloor,
  type RoomRoster,
} from "../agent/access/audience-floor.js";
import {
  assertConnectorDisclosure,
  classifyConnectorDisclosure,
  ConnectorAudienceUnverifiedError,
  ConnectorEntitlementError,
  registerConnectorEntitlementProbe,
  _resetConnectorEntitlementProbeForTest,
} from "../agent/access/connector-disclosure.js";
import { connectorDmOnlyEnabled } from "../agent/access/connector-scope.js";
import { classifyCardDisclosure } from "../agent/approvals/card-disclosure.js";
import { classifyClickerFloor } from "../agent/approvals/clicker-floor.js";
import { classifyFireDisclosure } from "../agent/routines/fire-disclosure.js";
import { PaneRedirectError } from "../agent/access/pane-venue.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext } from "../agent/identity/binding.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { getSettings, overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

{
  const roots = [join(REPO, "agent"), join(REPO, "packages")];
  const walk = (dir: string, out: string[]): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist" || e === ".git" || e === "scripts") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const files = roots.flatMap((r) => walk(r, []));
  ok(files.length > 200, "source scan found the repo's TypeScript sources");

  const definers = files.filter((f) => /export function computeAudienceFloor\b/.test(readFileSync(f, "utf8")));
  ok(
    definers.length === 1 && definers[0].endsWith(join("agent", "access", "audience-floor.ts")),
    `exactly ONE computeAudienceFloor definition, in access/audience-floor.ts (found ${definers.length}: ${definers.join(", ")})`,
  );

  const paneSrc = readFileSync(join(REPO, "packages/core/agent/access/pane-venue.ts"), "utf8");
  const discSrc = readFileSync(join(REPO, "packages/core/agent/access/connector-disclosure.ts"), "utf8");
  ok(/from "\.\/audience-floor\.js"/.test(paneSrc), "consumer #1 (pane-venue.ts) imports the audience-floor seam");
  ok(/from "\.\/audience-floor\.js"/.test(discSrc), "consumer #2 (connector-disclosure.ts) imports the audience-floor seam");

  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  let fetches = 0;
  const roster: RoomRoster = { humanMemberIds: ["U_A", "U_B"], resolved: true, isPrivate: true, hasGuest: false };
  registerGovernanceMemberSupplier(async () => {
    fetches++;
    return roster;
  });
  const domains: Domain[] = [
    defineDomain({ name: "governance", governance: true, reach: ["slack/T1/C_ADMIN"], admins: ["slack/T1/U_A", "slack/T1/U_B"] }),
    defineDomain({ name: "org", match: "org", admins: [] }),
  ];
  const admins = new Set(["U_A", "U_B"]);
  const gov = await attestGovernanceChannel("slack/T1/C_ADMIN", domains, {
    org: "disc-test",
    platform: "slack",
    workspace: "T1",
    surface: "C_ADMIN",
  });
  const general = await resolveAudienceFloor("slack/T1/C_ADMIN", admins);
  ok(fetches === 1, "the shared roster memo means TWO consumers cost ONE platform call per window");
  ok(gov.floor === general.floor, "the governance tripwire and the general seam report the SAME floor");
  ok(general.floor === computeAudienceFloor(roster, admins), "the general seam's floor IS the pure primitive's answer");
  ok((await resolveRoomRoster("slack/T1/C_ADMIN")) === roster, "resolveRoomRoster returns the memoized roster");

  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
}

{
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const unresolved: RoomRoster = { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false };
    const shared: RoomRoster = { humanMemberIds: ["U_A", "U_EXT"], resolved: true, isPrivate: false, hasGuest: true };
    const answers: (RoomRoster | undefined)[] = [unresolved, undefined, shared];
    let fetches = 0;
    registerGovernanceMemberSupplier(async () => answers[fetches++]);
    const key = "slack/T1/C_SHARED";
    const verdict = (r: { floor: AudienceFloor; roster: RoomRoster }) =>
      classifyConnectorDisclosure({ floor: r.floor, roster: r.roster, complianceMode: false, directAddressed: true });

    ok(UNRESOLVED_ROSTER_TTL_MS < getSettings().governance.floorTtlMs, "the unresolved memo is SHORTER than the resolved one");
    const first = await resolveAudienceFloor(key, new Set());
    ok(first.roster.resolved === false && verdict(first).ok, "an unresolved roster with no state (unobservable) is inert (the polarity rule)");
    now += UNRESOLVED_ROSTER_TTL_MS - 1;
    await resolveAudienceFloor(key, new Set());
    ok(fetches === 1, "inside the short window an unresolved roster is served from the memo (no Slack call per consumer)");
    now += 1;
    const second = await resolveAudienceFloor(key, new Set());
    ok(fetches === 2, "an unresolved roster EXPIRES after UNRESOLVED_ROSTER_TTL_MS, not after the full floor TTL");
    ok(second.roster.resolved === false, "an absent supplier answer (undefined ⇒ UNRESOLVED_ROSTER) is returned as unresolved");
    now += UNRESOLVED_ROSTER_TTL_MS;
    const third = await resolveAudienceFloor(key, new Set());
    ok(fetches === 3, "an absent supplier answer gets the short memo too");
    const thirdVerdict = verdict(third);
    ok(
      !thirdVerdict.ok && thirdVerdict.reason === "audience-floor",
      "the first good read after a failure observes the guest and leg 1 refuses (no TTL-long disarm)",
    );
    now += getSettings().governance.floorTtlMs - 1;
    await resolveAudienceFloor(key, new Set());
    ok(fetches === 3, "a RESOLVED roster is still memoized for the full floor TTL");
  } finally {
    Date.now = realNow;
    _resetGovernanceMemberSupplierForTest();
    _resetAudienceFloorCacheForTest();
  }
}

{
  const base = {
    roster: { humanMemberIds: ["U_A"], resolved: true, isPrivate: false, hasGuest: false } as RoomRoster,
    complianceMode: false,
    directAddressed: true,
  };
  ok(classifyConnectorDisclosure({ ...base, floor: "member" }).ok, "member floor + compliance off → allow");
  ok(classifyConnectorDisclosure({ ...base, floor: "admin" }).ok, "admin floor + compliance off → allow");

  const guestSeen = classifyConnectorDisclosure({
    ...base,
    floor: "guest",
    roster: { humanMemberIds: ["U_A"], resolved: true, isPrivate: false, hasGuest: true },
  });
  ok(!guestSeen.ok && guestSeen.reason === "audience-floor", "observed guest → audience-floor refusal");
  const unknown = classifyConnectorDisclosure({
    ...base,
    floor: "guest",
    roster: { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false },
  });
  ok(unknown.ok, "UNRESOLVED roster (floor=guest by fail-closed default) is INERT for connector disclosure");

  const both = classifyConnectorDisclosure({
    ...base,
    floor: "guest",
    roster: { humanMemberIds: ["U_A"], resolved: true, isPrivate: false, hasGuest: true },
    complianceMode: true,
    entitled: true,
  });
  ok(!both.ok && both.reason === "audience-floor", "leg 1 is evaluated before leg 2 (floor beats an entitled requestor)");

  ok(classifyConnectorDisclosure({ ...base, floor: "member", complianceMode: true, entitled: true }).ok, "compliance ON + entitled → allow");
  const unent = classifyConnectorDisclosure({ ...base, floor: "member", complianceMode: true, entitled: false });
  ok(!unent.ok && unent.reason === "requestor-unentitled", "compliance ON + NOT entitled → refuse");
  const noSignal = classifyConnectorDisclosure({ ...base, floor: "member", complianceMode: true });
  ok(!noSignal.ok && noSignal.reason === "entitlement-unavailable", "compliance ON + no signal → FAIL CLOSED");
  ok(
    classifyConnectorDisclosure({ ...base, floor: "member", complianceMode: true, directAddressed: false }).ok,
    "compliance ON but AMBIENT (no requestor) → leg 2 does not run",
  );
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

function ctxFor(principalId: string, channelId: string, channelType: "channel" | "im", extra: Record<string, string> = {}): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          principalId,
          principalType: "slack-user",
          attributes: { team_id: "T1", channel_id: channelId, channel_type: channelType, ...extra },
        },
      },
    },
  } as unknown as BindableContext;
}

const plainDomains: Domain[] = [defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"] })];
const complianceDomains: Domain[] = [
  defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG"], requestorEntitlementChecks: true }),
];

const rowsFor = async (action: string) => (await readAudit({ org: "disc-test", action })).length;

{
  registerConfig(baseConfig(plainDomains) as never);
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  _resetConnectorEntitlementProbeForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A", "U_B"], resolved: true, isPrivate: false, hasGuest: false }));

  await assertConnectorDisclosure("notion", ctxFor("U_A", "C_ENG", "channel"));
  await assertConnectorDisclosure("notion", ctxFor("U_A", "D_DM", "im"));
  ok((await rowsFor("connector.refused")) === 0, "compliance OFF: no connector.refused rows");
  ok((await rowsFor("connector.entitlement_check")) === 0, "compliance OFF: no entitlement_check rows");
  ok((await rowsFor("governance.redirected")) === 0, "compliance OFF: no governance.redirected rows");
  n += 1;
}

{
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  await assertConnectorDisclosure("notion", ctxFor("U_A", "C_ENG", "channel"));
  ok((await rowsFor("connector.refused")) === 0, "no member supplier registered → the gate stays INERT (no refusal)");
}

{
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A", "U_GUEST"], resolved: true, isPrivate: false, hasGuest: true }));

  let threw = false;
  try {
    await assertConnectorDisclosure("notion", ctxFor("U_A", "C_SHARED", "channel"));
  } catch (err) {
    threw = true;
    ok(err instanceof PaneRedirectError, "leg 1 refuses with OPE-110's PaneRedirectError posture");
    ok((err as PaneRedirectError).target === "requester-dm", "leg 1 redirects to the requester's DM");
    ok(/guest\/external member/.test(String((err as PaneRedirectError).message)), "the directive explains the guest floor");
    ok(/partial disclosure is still disclosure/.test(String((err as PaneRedirectError).message)), "the directive forbids a partial render");
  }
  ok(threw, "leg 1 throws on an observed guest");

  const refused = await readAudit({ org: "disc-test", action: "connector.refused" });
  ok(refused.length === 1, "exactly one connector.refused row for the floor refusal");
  ok((refused[0].detail as { reason?: string })?.reason === "audience_floor", "the refusal row carries reason audience_floor");
  ok((refused[0].detail as { from?: string })?.from === "slack/T1/C_SHARED", "the refusal row names the room");
  const redirected = await readAudit({ org: "disc-test", action: "governance.redirected" });
  ok(redirected.length === 1, "the redirect is stamped governance.redirected (the OPE-110 action)");
  ok((redirected[0].detail as { kind?: string })?.kind === "connector.read", "the redirect row's kind is connector.read");
}

{
  registerConfig(baseConfig(complianceDomains) as never);
  ok(requestorEntitlementChecksEnabled(complianceDomains), "requestorEntitlementChecksEnabled reads the org pseudo-domain");
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A"], resolved: true, isPrivate: true, hasGuest: false }));
  registerConnectorEntitlementProbe(async () => false);

  let threw = false;
  try {
    await assertConnectorDisclosure("notion", ctxFor("U_A", "D_DM", "im"));
  } catch (err) {
    threw = true;
    ok(err instanceof ConnectorEntitlementError, "leg 2 refuses with ConnectorEntitlementError");
    ok((err as ConnectorEntitlementError).reason === "requestor-unentitled", "the refusal reason is requestor-unentitled");
  }
  ok(threw, "compliance ON + unentitled requestor → refused");
  const refused = await readAudit({ org: "disc-test", action: "connector.refused" });
  ok(
    refused.some((r) => (r.detail as { reason?: string })?.reason === "requestor_unentitled"),
    "the unentitled refusal is audited",
  );
}

{
  _resetAudienceFloorCacheForTest();
  registerConnectorEntitlementProbe(async () => true);
  await assertConnectorDisclosure("notion", ctxFor("U_A", "D_DM", "im"));
  const checks = await readAudit({ org: "disc-test", action: "connector.entitlement_check" });
  ok(checks.length === 1, "a compliance-mode ALLOW is audited (connector.entitlement_check)");
  ok((checks[0].detail as { verdict?: string })?.verdict === "allow", "the allow row records the verdict");
  n += 1;
}

{
  _resetAudienceFloorCacheForTest();
  _resetConnectorEntitlementProbeForTest();
  let threw = false;
  try {
    await assertConnectorDisclosure("notion", ctxFor("U_A", "D_DM", "im"));
  } catch (err) {
    threw = true;
    ok(err instanceof ConnectorEntitlementError, "no probe → ConnectorEntitlementError");
    ok((err as ConnectorEntitlementError).reason === "entitlement-unavailable", "no probe → entitlement-unavailable");
    ok(/registerConnectorEntitlementProbe/.test(String((err as Error).message)), "the error names the operator's fix");
  }
  ok(threw, "compliance ON with NO entitlement signal FAILS CLOSED");
  ok(
    (await readAudit({ org: "disc-test", action: "connector.refused" })).some(
      (r) => (r.detail as { reason?: string })?.reason === "entitlement_unavailable",
    ),
    "the fail-closed refusal is audited",
  );
}

{
  _resetAudienceFloorCacheForTest();
  registerConnectorEntitlementProbe(async () => {
    throw new Error("system of record unreachable");
  });
  await assert.rejects(
    () => assertConnectorDisclosure("notion", ctxFor("U_A", "D_DM", "im")),
    (err: unknown) => err instanceof ConnectorEntitlementError && err.reason === "entitlement-unavailable",
    "a throwing probe fails closed",
  );
  n++;
}

{
  _resetAudienceFloorCacheForTest();
  _resetConnectorEntitlementProbeForTest();
  const before = await rowsFor("connector.refused");
  await assertConnectorDisclosure("notion", ctxFor("U_A", "C_ENG", "channel"));
  ok((await rowsFor("connector.refused")) === before, "an AMBIENT turn is not entitlement-checked (no requestor)");
}

{
  _resetAudienceFloorCacheForTest();
  await assert.rejects(
    () => assertConnectorDisclosure("notion", ctxFor("U_A", "C_ENG", "channel", { oe_addressing: "direct-mention" })),
    (err: unknown) => err instanceof ConnectorEntitlementError,
    "an addressed mention in a channel IS entitlement-checked",
  );
  n++;
}

{
  const failed: RoomRoster = { humanMemberIds: [], resolved: false, unresolvedState: "failed", isPrivate: false, hasGuest: false };
  const unobservable: RoomRoster = { humanMemberIds: [], resolved: false, unresolvedState: "unobservable", isPrivate: false, hasGuest: false };
  const internal: RoomRoster = { humanMemberIds: ["U_A"], resolved: true, isPrivate: false, hasGuest: false };

  ok(rosterState(failed) === "failed", "rosterState: a roster marked failed is failed");
  ok(rosterState(unobservable) === "unobservable", "rosterState: a roster marked unobservable is unobservable");
  ok(rosterState({ ...unobservable, unresolvedState: undefined }) === "unobservable", "rosterState: an unresolved roster with NO state is unobservable");
  ok(rosterState({ ...internal, unresolvedState: "failed" }) === "resolved", "rosterState: a RESOLVED roster ignores a stray state");

  const failedVerdict = classifyConnectorDisclosure({ floor: "guest", roster: failed, complianceMode: false, directAddressed: true });
  ok(!failedVerdict.ok && failedVerdict.reason === "audience-unverified", "🔴 a FAILED roster read refuses connector disclosure (audience-unverified)");
  ok(
    classifyConnectorDisclosure({ floor: "guest", roster: unobservable, complianceMode: false, directAddressed: true }).ok,
    "an UNOBSERVABLE roster stays INERT for connector disclosure",
  );

  registerConfig(baseConfig(plainDomains) as never);
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  _resetConnectorEntitlementProbeForTest();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    let slackAnswer: RoomRoster = failed;
    let fetches = 0;
    registerGovernanceMemberSupplier(async (channelKey) => {
      if (!channelKey.startsWith("slack/")) return undefined;
      fetches++;
      return slackAnswer;
    });
    const refusedRows = async () =>
      ((await readAudit({ org: "disc-test", action: "connector.refused" })) as { detail?: Record<string, unknown> }[]).filter(
        (r) => r.detail?.reason === "audience_unverified",
      );

    let thrown: unknown;
    try {
      await assertConnectorDisclosure("notion", ctxFor("U_A", "C_FLAKY", "channel"));
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof ConnectorAudienceUnverifiedError, "🔴 runtime: a FAILED Slack roster read REFUSES the connector call (ConnectorAudienceUnverifiedError)");
    ok(!(thrown instanceof PaneRedirectError), "runtime: the failed-read refusal is NOT a redirect to the requester's DM (it can land in that DM)");
    ok(/ask again in about 30 seconds/.test(String((thrown as Error | undefined)?.message)), "runtime: the refusal tells the requester when to retry");
    const rows = await refusedRows();
    ok(rows.length === 1 && rows[0].detail?.from === "slack/T1/C_FLAKY", "runtime: one connector.refused row, reason audience_unverified, naming the room");

    await assert.rejects(
      () => assertConnectorDisclosure("notion", ctxFor("U_A", "D_FLAKY", "im")),
      (err: unknown) => err instanceof ConnectorAudienceUnverifiedError,
      "runtime: a FAILED read refuses in a Slack DM too",
    );
    n++;

    const before = (await refusedRows()).length;
    await assertConnectorDisclosure("notion", {
      channel: { kind: "notion" },
      session: { auth: { current: { principalId: "U_A", principalType: "notion-user", attributes: {} } } },
    } as unknown as BindableContext);
    ok((await refusedRows()).length === before, "negative control: a non-Slack key (unobservable) stays INERT under the same supplier");

    slackAnswer = internal;
    const fetchesBefore = fetches;
    now += UNRESOLVED_ROSTER_TTL_MS - 1;
    await assert.rejects(
      () => assertConnectorDisclosure("notion", ctxFor("U_A", "C_FLAKY", "channel")),
      (err: unknown) => err instanceof ConnectorAudienceUnverifiedError,
      "hold: inside the 30 s window the memoized FAILED read still refuses",
    );
    n++;
    ok(fetches === fetchesBefore, "hold: inside the window the roster is served from the memo (no Slack call)");
    now += 1;
    await assertConnectorDisclosure("notion", ctxFor("U_A", "C_FLAKY", "channel"));
    ok(fetches === fetchesBefore + 1, "hold: at 30 s the memo expires, the roster is read again, it resolves, and the call is allowed");
  } finally {
    Date.now = realNow;
    _resetGovernanceMemberSupplierForTest();
    _resetAudienceFloorCacheForTest();
  }
}

{
  const sharedPartial: RoomRoster = { humanMemberIds: [], resolved: true, isPrivate: true, hasGuest: true };
  const floor = computeAudienceFloor(sharedPartial, new Set(["U_ADMIN"]));
  ok(floor === "guest", "OPE-2311: a shared roster with an empty member list floors to guest");
  const attest = attestGovernanceFloor(sharedPartial, new Set(["U_ADMIN"]));
  ok(!attest.armed && attest.breach?.reason === "guest-present", "OPE-2311: #1 the governance channel does not arm (guest-present)");
  const conn = classifyConnectorDisclosure({ floor, roster: sharedPartial, complianceMode: false, directAddressed: true });
  ok(!conn.ok && conn.reason === "audience-floor", "OPE-2311: #2 connector disclosure refuses (audience-floor)");
  ok(!classifyFireDisclosure({ floor, roster: sharedPartial }).ok, "OPE-2311: #3 the triggered-fire disclosure floor refuses");
  ok(!classifyClickerFloor({ floor, roster: sharedPartial, beneficiaryClicker: false }).ok, "OPE-2311: #4 the clicker floor refuses");
  ok(!classifyCardDisclosure({ floor, roster: sharedPartial }).ok, "OPE-2311: #5 the card-disclosure floor refuses");
}

{
  assert.doesNotThrow(() => assertComplianceDomains(complianceDomains), "requestorEntitlementChecks on the org domain passes the lint");
  n++;
  assert.doesNotThrow(() => assertComplianceDomains(plainDomains), "an unset flag passes the lint");
  n++;
  assert.throws(
    () => assertComplianceDomains([defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"], requestorEntitlementChecks: true })]),
    /ORG-LEVEL compliance opt-in/,
    "requestorEntitlementChecks on a ROOM domain fails the lint loudly",
  );
  n++;
  ok(!requestorEntitlementChecksEnabled(plainDomains), "compliance mode is OFF by default");
}

{
  const walkSrc = (dir: string, out: string[]): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist" || e === ".git" || e === "scripts") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walkSrc(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  };

  const prodFiles = walkSrc(join(REPO, "packages"), []).concat(walkSrc(join(REPO, "agent"), []));
  const registrars = prodFiles.flatMap((f) => {
    const calls = readFileSync(f, "utf8").match(/(?<!export function )registerGovernanceMemberSupplier\(/g) ?? [];
    return calls.map(() => f);
  });
  ok(
    registrars.length === 1 && registrars[0].endsWith(join("providers", "slack", "agent", "channels", "slack-events.ts")),
    `n1: exactly ONE production registerGovernanceMemberSupplier CALL in the whole tree, in the Slack bundle (found ${registrars.length}: ${registrars.map((f) => f.slice(REPO.length + 1)).join(", ")})`,
  );

  const slackEventsSrc = readFileSync(registrars[0], "utf8");
  ok(
    /platform === "slack" && surface\) return slackGovernanceRoster\(surface\);/.test(slackEventsSrc) &&
      /\n\s*return undefined;/.test(slackEventsSrc),
    "n1: the one supplier is platform-gated to slack and returns undefined for every other channel key",
  );

  ok(
    /hasGuest: facts\.isExternal === true,/.test(slackEventsSrc),
    "n2: slackGovernanceRoster feeds hasGuest from the channel-level facts.isExternal bit",
  );
  const slackIdentitySrc = readFileSync(
    join(REPO, "packages/providers/slack/agent/channels/slack-identity.ts"),
    "utf8",
  );
  const isExternalExpr = /const isExternal = Boolean\(\s*([^)]*)\)/.exec(slackIdentitySrc)?.[1] ?? "";
  ok(
    isExternalExpr.length > 0 &&
      ["is_ext_shared", "is_org_shared", "is_shared", "is_pending_ext_shared"].every((b) => isExternalExpr.includes(b)),
    "n2: isExternal is derived from the four CHANNEL-shared bits",
  );
  ok(
    !/is_restricted|is_ultra_restricted|is_stranger/.test(isExternalExpr),
    "n2: the per-MEMBER guest flags (is_restricted / is_ultra_restricted / is_stranger) are NOT in the hasGuest path — a guest in an internal private channel cannot trip leg 1",
  );

  const scopeSrc = readFileSync(join(REPO, "packages/core/agent/access/connector-scope.ts"), "utf8");
  const wallAt = scopeSrc.indexOf("connectorDmOnlyEnabled() && mode !== \"dm\"");
  const gateAt = scopeSrc.indexOf("await assertConnectorDisclosure(");
  ok(wallAt > 0 && gateAt > wallAt, "n3: the DM-only wall is evaluated BEFORE the disclosure gate");
  ok(
    scopeSrc.slice(wallAt, gateAt).includes("!workSurfaceTierArmed"),
    "n3: the work-surface carve-out is part of that same wall condition (OPE-913), not a separate earlier branch",
  );
  overrideSettingsForTest({ connectors: { dmOnly: true, opTiering: false } });
  ok(connectorDmOnlyEnabled(), "n3: the DM-only wall DEFAULTS ON — leg 1 needs the wall down, or a work grant with opTiering armed, to see a channel turn");

  {
    _resetGovernanceMemberSupplierForTest();
    _resetAudienceFloorCacheForTest();
    _resetConnectorEntitlementProbeForTest();
    registerConfig(baseConfig(plainDomains) as never);
    registerGovernanceMemberSupplier(async (channelKey) => {
      const [platform] = channelKey.split("/");
      if (platform !== "slack") return undefined;
      return { humanMemberIds: ["U_A", "U_GUEST"], resolved: true, isPrivate: false, hasGuest: true };
    });

    const before = await rowsFor("connector.refused");
    await assertConnectorDisclosure("notion", {
      channel: { kind: "notion" },
      session: { auth: { current: { principalId: "U_A", principalType: "notion-user", attributes: {} } } },
    } as unknown as BindableContext);
    ok(
      (await rowsFor("connector.refused")) === before,
      "n1 (behavioural): a non-Slack surface is NOT floored — leg 1 is structurally unreachable there, guest or no guest",
    );

    await assert.rejects(
      () => assertConnectorDisclosure("notion", ctxFor("U_A", "C_SHARED_2", "channel")),
      (err: unknown) => err instanceof PaneRedirectError,
      "the SAME supplier DOES floor the Slack room — the narrowing is the platform gate, not a dead classifier",
    );
    n++;
  }

  const planesDoc = readFileSync(join(REPO, "docs/security/credentials-and-planes.md"), "utf8");
  ok(
    /externally-shared Slack channel/.test(planesDoc) && planesDoc.includes("connectors.dmOnly"),
    "claim: the shipped manual's audience-floor layer states the Slack-only, externally-shared, DM-wall-off reach",
  );
}

{
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  _resetConnectorEntitlementProbeForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_A", "U_GUEST"], resolved: true, isPrivate: false, hasGuest: true }));
  registerConfig({
    ...baseConfig(plainDomains),
    loadDomains: () => {
      throw new Error("malformed bundle: eng.yaml line 3");
    },
  } as never);
  const refusedBefore = await rowsFor("connector.refused");
  let thrown: unknown;
  try {
    await assertConnectorDisclosure("notion", ctxFor("U_A", "C_SHARED", "channel"));
  } catch (err) {
    thrown = err;
  }
  ok(thrown instanceof ConfigLoadRefusalError, "OPE-2156: 🔴 a registered config whose loadDomains() throws REFUSES the connector call — it no longer disarms the gate");
  ok((await rowsFor("connector.refused")) === refusedBefore + 1, "OPE-2156: …and the refusal writes one connector.refused row");
  const rows = (await readAudit({ org: "disc-test", action: "connector.refused" })) as { detail?: Record<string, unknown> }[];
  ok(rows.filter((r) => r.detail?.reason === "config_unavailable").length === 1, "OPE-2156: …whose reason names the config failure");
  registerConfig(baseConfig(plainDomains) as never);
}

_resetGovernanceMemberSupplierForTest();
_resetAudienceFloorCacheForTest();
_resetConnectorEntitlementProbeForTest();
await removeTempDir(tmp);
console.log(`✓ connector-disclosure: ${n} assertions passed`);
