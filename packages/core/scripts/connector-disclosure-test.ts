import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-disclosure-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_ORG = "disc-test";

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import {
  assertComplianceDomains,
  defineDomain,
  requestorEntitlementChecksEnabled,
  type Domain,
} from "../agent/memory/domain.js";
import {
  attestGovernanceChannel,
  computeAudienceFloor,
  registerGovernanceMemberSupplier,
  resolveAudienceFloor,
  resolveRoomRoster,
  _resetAudienceFloorCacheForTest,
  _resetGovernanceMemberSupplierForTest,
  type RoomRoster,
} from "../agent/access/audience-floor.js";
import {
  assertConnectorDisclosure,
  classifyConnectorDisclosure,
  ConnectorEntitlementError,
  registerConnectorEntitlementProbe,
  _resetConnectorEntitlementProbeForTest,
} from "../agent/access/connector-disclosure.js";
import { connectorDmOnlyEnabled } from "../agent/access/connector-scope.js";
import { PaneRedirectError } from "../agent/access/pane-venue.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext } from "../agent/identity/binding.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
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
    defineDomain({ name: "governance", governance: true, channels: ["slack/T1/C_ADMIN"], admins: ["U_A", "U_B"] }),
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

const plainDomains: Domain[] = [defineDomain({ name: "org", match: "org", admins: ["U_ORG"] })];
const complianceDomains: Domain[] = [
  defineDomain({ name: "org", match: "org", admins: ["U_ORG"], requestorEntitlementChecks: true }),
];

const rowsFor = async (action: string) => (await readAudit({ action })).length;

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

  const refused = await readAudit({ action: "connector.refused" });
  ok(refused.length === 1, "exactly one connector.refused row for the floor refusal");
  ok((refused[0].detail as { reason?: string })?.reason === "audience_floor", "the refusal row carries reason audience_floor");
  ok((refused[0].detail as { from?: string })?.from === "slack/T1/C_SHARED", "the refusal row names the room");
  const redirected = await readAudit({ action: "governance.redirected" });
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
  const refused = await readAudit({ action: "connector.refused" });
  ok(
    refused.some((r) => (r.detail as { reason?: string })?.reason === "requestor_unentitled"),
    "the unentitled refusal is audited",
  );
}

{
  _resetAudienceFloorCacheForTest();
  registerConnectorEntitlementProbe(async () => true);
  await assertConnectorDisclosure("notion", ctxFor("U_A", "D_DM", "im"));
  const checks = await readAudit({ action: "connector.entitlement_check" });
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
    (await readAudit({ action: "connector.refused" })).some(
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
  assert.doesNotThrow(() => assertComplianceDomains(complianceDomains), "requestorEntitlementChecks on the org domain passes the lint");
  n++;
  assert.doesNotThrow(() => assertComplianceDomains(plainDomains), "an unset flag passes the lint");
  n++;
  assert.throws(
    () => assertComplianceDomains([defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], requestorEntitlementChecks: true })]),
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
  const wallAt = scopeSrc.indexOf("if (connectorDmOnlyEnabled() && mode !== \"dm\")");
  const gateAt = scopeSrc.indexOf("await assertConnectorDisclosure(");
  ok(wallAt > 0 && gateAt > wallAt, "n3: the DM-only wall is evaluated BEFORE the disclosure gate");
  const dmOnlyEnv = process.env.OE_CONNECTOR_DM_ONLY;
  delete process.env.OE_CONNECTOR_DM_ONLY;
  ok(connectorDmOnlyEnabled(), "n3: the DM-only wall DEFAULTS ON (unset env) — leg 1 needs OE_CONNECTOR_DM_ONLY=0 to see a channel turn");
  if (dmOnlyEnv !== undefined) process.env.OE_CONNECTOR_DM_ONLY = dmOnlyEnv;

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

  const discSrc = readFileSync(join(REPO, "packages/core/agent/access/connector-disclosure.ts"), "utf8");
  ok(
    !/POSITIVELY-OBSERVED guest\/external member/.test(discSrc),
    "claim: the over-wide 'POSITIVELY-OBSERVED guest/external member' promise is gone from the guard's header",
  );
  for (const [label, marker] of [
    ["names the ticket", "OPE-173"],
    ["names the one-surface narrowing", "registerSlackGovernanceMembers"],
    ["names the externally-shared narrowing", "is_pending_ext_shared"],
    ["names the DM-wall narrowing", "OE_CONNECTOR_DM_ONLY=0"],
  ] as const) {
    ok(discSrc.includes(marker), `claim: connector-disclosure.ts's header ${label} (${marker})`);
  }
  ok(
    scopeSrc.includes("OPE-173") && !/leg 1, always on/.test(scopeSrc),
    "claim: the connector-scope.ts call site no longer says leg 1 is 'always on' and points at the narrowings",
  );
  const planesDoc = readFileSync(join(REPO, "docs/security/credentials-and-planes.md"), "utf8");
  ok(
    /externally-shared Slack channel/.test(planesDoc) && planesDoc.includes("OE_CONNECTOR_DM_ONLY=0"),
    "claim: the shipped manual's audience-floor layer states the Slack-only, externally-shared, DM-wall-off reach",
  );
}

_resetGovernanceMemberSupplierForTest();
_resetAudienceFloorCacheForTest();
_resetConnectorEntitlementProbeForTest();
rmSync(tmp, { recursive: true, force: true });
console.log(`✓ connector-disclosure: ${n} assertions passed`);
