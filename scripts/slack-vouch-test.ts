import { assertPackageDistFresh } from "./core-dist-freshness.js";

assertPackageDistFresh("packages/core", "@open-everywhere/core");
assertPackageDistFresh("packages/providers/slack", "@open-everywhere/provider-slack");

const { bindFrom, registerIdentityMapper } = await import("@open-everywhere/core/agent/identity/binding.js");
type BindableContext = import("@open-everywhere/core/agent/identity/binding.js").BindableContext;
const { declaredTrustForKeys, defineSurface, isVouchedInternal, registerSurfaces } = await import(
  "@open-everywhere/core/agent/identity/trust.js"
);
const { memberPlaneVerdict, roomVouchedInternalFrom } = await import("@open-everywhere/core/agent/access/member-plane.js");
const { bindSlack, buildSlackAuth } = await import("@open-everywhere/provider-slack/agent/channels/slack-identity.js");

const { surfaces } = await import("../agent/identity/surfaces.js");
const { SETTINGS_OVERRIDES } = await import("../agent/settings/settings.js");

registerIdentityMapper("slack", bindSlack);

const TEAM = "T0EXAMPLE";
const WORKSPACE_KEY = `slack/${TEAM}`;
const E2E_CHANNEL = "C0EXGENRL";
const E2E_CHANNEL_2 = "C0EXCHAN003";
const OTHER_TEAM = "T0NOTOURS";

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

function eq(actual: unknown, expected: unknown, label: string): void {
  ok(Object.is(actual, expected), `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

interface SlackRoom {
  readonly channelId: string;
  readonly teamId?: string;
  readonly channelType?: string;
  readonly isExternal?: boolean;
  readonly trustChecked?: boolean;
  readonly dmPartnerTrust?: "internal" | "external";
}

function slackCtx(room: SlackRoom): BindableContext {
  const auth = buildSlackAuth({
    userId: "U0EXOWNER",
    teamId: room.teamId ?? TEAM,
    channelId: room.channelId,
    ...(room.channelType === undefined ? {} : { channelType: room.channelType }),
    ...(room.isExternal === undefined ? {} : { isExternal: room.isExternal }),
    ...(room.trustChecked === undefined ? {} : { trustChecked: room.trustChecked }),
    ...(room.dmPartnerTrust === undefined ? {} : { dmPartnerTrust: room.dmPartnerTrust }),
  });
  return { channel: { kind: "slack" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}

function roomVouch(room: SlackRoom): { readonly vouched: boolean; readonly trust?: string; readonly declaredTrust?: string } {
  const b = bindFrom(slackCtx(room));
  return { vouched: roomVouchedInternalFrom(b.declaredTrust, b.trust), trust: b.trust, declaredTrust: b.declaredTrust };
}

const CONFIRMED = { channelType: "channel", isExternal: false, trustChecked: true } as const;

{
  const slackEntries = surfaces.filter((s) => s.key === WORKSPACE_KEY || s.key.startsWith(`${WORKSPACE_KEY}/`));
  eq(slackEntries.length, 1, "🔴 the deployment declares EXACTLY ONE entry for its Slack workspace — a second one would make the grain assertions below ambiguous");
  eq(slackEntries[0]?.key, WORKSPACE_KEY, "…and it is the TENANT-grain key, not a room list");
  eq(slackEntries[0]?.trust, "internal", "…declared internal");
  eq(
    declaredTrustForKeys(WORKSPACE_KEY, `${WORKSPACE_KEY}/${E2E_CHANNEL}`),
    "internal",
    "the tenant line reaches a room nobody named — the any-rung ruling, at the resolver",
  );
  eq(
    declaredTrustForKeys(`slack/${OTHER_TEAM}`, `slack/${OTHER_TEAM}/C_ANY`),
    undefined,
    "NEGATIVE CONTROL: an undeclared workspace stays UNDECLARED (silence, never `public`) — so the tenant match above is real and not a matcher that says yes to everything",
  );
}

{
  const channel = roomVouch({ channelId: E2E_CHANNEL, ...CONFIRMED });
  eq(channel.trust, "internal", "a confirmed in-workspace channel binds internal");
  eq(channel.declaredTrust, "internal", "…and carries the operator's own declaration, before the join folded it in");
  ok(channel.vouched, "🔴 G4b: an ordinary channel under the vouched workspace reads roomVouchedInternal — this is what arming the plane would need");

  const groupDm = roomVouch({ channelId: "G0MPIM0001", channelType: "mpim" });
  eq(groupDm.trust, "internal", "a group DM (mpim) binds internal");
  eq(groupDm.declaredTrust, "internal", "…and the tenant rung is what declared it — nobody wrote its conversation id anywhere");
  ok(groupDm.vouched, "🔴 G4b: a GROUP DM under the vouched workspace reads roomVouchedInternal");

  const foreign = roomVouch({ channelId: "C_ANY", teamId: OTHER_TEAM, ...CONFIRMED });
  eq(foreign.trust, "internal", "NEGATIVE CONTROL: the foreign channel's own MAPPER verdict is internal — so the next line fails for the declaration's sake, not the mapper's");
  eq(foreign.declaredTrust, undefined, "…and the operator declared nothing about it");
  ok(!foreign.vouched, "🔴 NEGATIVE CONTROL: a confirmed channel in an UNDECLARED workspace is NOT vouched — the vouch is scoped to this workspace, not to Slack");
}

{
  const connect = roomVouch({ channelId: "C0CONNECT1", channelType: "channel", isExternal: true, trustChecked: true });
  eq(connect.declaredTrust, "internal", "the tenant declaration DOES match the Slack Connect channel — the demotion below is a real contest, not a miss");
  eq(connect.trust, "external", "🔴 `is_ext_shared: true` binds external — the mapper's verdict outranks the tenant declaration (uncertainty never resolves up)");
  ok(!connect.vouched, "🔴 a Slack Connect channel under the vouched workspace is NOT vouched for the member plane");

  const unconfirmed = roomVouch({ channelId: "C0UNCONF01", channelType: "channel" });
  eq(unconfirmed.trust, "external", "🔴 an UNCONFIRMED channel binds external — the vouch does not stand in for a check that never landed");
  ok(!unconfirmed.vouched, "…so it is not vouched for the member plane either");

  const externalPartner = roomVouch({ channelId: "D0PARTNER1", channelType: "im", dmPartnerTrust: "external" });
  eq(externalPartner.trust, "external", "🔴 a DM partner Slack POSITIVELY reports as external still binds external under the workspace vouch");

  const unverifiedPartner = roomVouch({ channelId: "D0PARTNER2", channelType: "im" });
  eq(unverifiedPartner.trust, "internal", "🔴 an UNVERIFIED DM partner in the vouched workspace binds internal — the widening the tenant grain buys, named in surfaces.ts");

  const connectGroupDm = roomVouch({ channelId: "G0MPIMEXT1", channelType: "mpim", isExternal: true, trustChecked: true });
  eq(connectGroupDm.declaredTrust, "internal", "the tenant declaration DOES match the Slack Connect group DM — the demotion below is a real contest, not a miss");
  eq(connectGroupDm.trust, "external", "🔴 `is_ext_shared: true` demotes a GROUP DM (OPE-1486) — the vouch cannot re-promote a shared mpim");
  ok(!connectGroupDm.vouched, "🔴 a Slack Connect GROUP DM under the vouched workspace is NOT vouched for the member plane");

  const unconfirmedGroupDm = roomVouch({ channelId: "G0MPIMUNC1", channelType: "mpim" });
  eq(unconfirmedGroupDm.trust, "internal", "🔴 an UNCONFIRMED group DM binds internal — the mpim class is demoted by evidence, never by its absence (contrast the unconfirmed CHANNEL above)");
  ok(unconfirmedGroupDm.vouched, "…so on an unconfirmed group DM the operator's declaration is the whole of the member-plane vouch");
}

{
  let refused = "";
  try {
    defineSurface({ key: `${WORKSPACE_KEY}/${E2E_CHANNEL}`, trust: "external" as never });
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  ok(
    refused.includes("unknown trust") && refused.includes("external"),
    "🔴 `trust: \"external\"` is REFUSED at config time — `public` is how an operator declares a room external, and there is no `external` declaration anywhere to test",
  );

  const carveOut = defineSurface({ key: `${WORKSPACE_KEY}/${E2E_CHANNEL}`, trust: "public" });
  try {
    registerSurfaces([...surfaces, carveOut]);
    eq(
      declaredTrustForKeys(WORKSPACE_KEY, `${WORKSPACE_KEY}/${E2E_CHANNEL}`),
      "public",
      "🔴 most-specific-wins: the ROOM entry beats the tenant entry",
    );
    ok(!isVouchedInternal(WORKSPACE_KEY, `${WORKSPACE_KEY}/${E2E_CHANNEL}`), "…so the carved-out room is not vouched internal");
    const demoted = roomVouch({ channelId: E2E_CHANNEL, ...CONFIRMED });
    eq(demoted.trust, "external", "🔴 the room-grain `public` declaration DEMOTES the room to external, above the mapper — a coarse tenant `internal` never re-promotes it");
    ok(!demoted.vouched, "…and the member gate's room vouch reads false there");
    const sibling = roomVouch({ channelId: E2E_CHANNEL_2, ...CONFIRMED });
    eq(sibling.trust, "internal", "NEGATIVE CONTROL: the sibling channel is untouched — the carve-out is one room, not the workspace");
    ok(sibling.vouched, "…and it stays vouched for the member plane");
  } finally {
    registerSurfaces(surfaces);
  }
  eq(
    declaredTrustForKeys(WORKSPACE_KEY, `${WORKSPACE_KEY}/${E2E_CHANNEL}`),
    "internal",
    "the shipped config is restored — the carve-out above was this suite's, never the deployment's",
  );
}

{
  eq(
    SETTINGS_OVERRIDES.connectors?.memberPlane,
    undefined,
    "🔴 the deployment declares NO `connectors.memberPlane` override — the plane ships dark, and this ticket only removes the config blocker",
  );
  const verdict = memberPlaneVerdict({
    armed: false,
    opTiered: true,
    granted: true,
    requester: { kind: "requester", principalId: "U0EXOWNER" },
    nonMemberWake: false,
    roomVouchedInternal: roomVouch({ channelId: E2E_CHANNEL, ...CONFIRMED }).vouched,
  });
  ok(!verdict.admit, "a vouched room does NOT admit the member plane while the plane is disarmed");
  eq(verdict.admit === false ? verdict.reason : undefined, "member_plane_disarmed", "🔴 the FIRST refusal is still `armed` — the vouch changes no live behaviour today");
}

console.log(`slack-vouch: ${passed} assertions passed`);
