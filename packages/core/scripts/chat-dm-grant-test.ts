import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-chat-dm-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const {
  RESOURCE_CAPABILITIES,
  RESOURCE_CAPABILITY_NAMES,
  DEFAULT_RESOURCE_CAPABILITIES,
  defaultResourceCapabilitiesFor,
  isResourceCapability,
  resourceCapabilityProblems,
  resourceCapabilityType,
} = await import("../agent/access/resource-capabilities.js");
const {
  parseResourceAddress,
  resourceAddress,
  resourceGrantCapabilities,
  resourceGrantProblems,
  resourceGrantType,
  resourceTypesFor,
} = await import("../agent/access/resource-grant.js");
type ResourceGrant = import("../agent/access/resource-grant.js").ResourceGrant;
const { assertBundlesValid } = await import("../agent/access/bundle.js");
type Bundle = import("../agent/access/bundle.js").Bundle;
const { resolveAccess } = await import("../agent/access/resolver.js");
const {
  PERSON_RESOURCE_TYPE,
  chatDmTargetsFrom,
  domainWorksOnPlatform,
  resolveChatDmTargetFrom,
} = await import("../agent/access/chat-dm-grant.js");
type ChatDmGrantError = import("../agent/access/chat-dm-grant.js").ChatDmGrantError;
const { CONTAINER_RESOURCE_TYPE, chatWriteTargetsFrom } = await import("../agent/access/chat-write-grant.js");
const {
  DM_RESUME_ACTION,
  DM_STOP_ACTION,
  dmDeliveryFooter,
  noteDmAudienceDelivery,
  personAddress,
  readDmAudience,
  resumeDmAudience,
  stopDmAudience,
} = await import("../agent/channels/dm-audience.js");
const { surfaceKeySegment } = await import("../agent/identity/binding.js");
const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { LEAN_SEAT_TOOLS } = await import("../agent/access/lean-seat.js");
const { WINDOW_UNGATED_TOOLS } = await import("../agent/access/window-gate-manifest.js");
const { readAudit } = await import("../agent/audit/audit.js");
type Domain = import("../agent/memory/domain.js").Domain;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const throws = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

const HOME = "slack/T1/C_HOME";
const DISCORD_HOME = "discord/G1/C_D_HOME";
const DOMAINS: readonly Domain[] = [
  { name: "eng", reach: [HOME, "slack/T1/C_ELSEWHERE"] },
  { name: "ops", reach: [DISCORD_HOME] },
];
const SARAH_ID = "U_SARAH";
const SARAH = personAddress("slack", SARAH_ID);
const MARK = personAddress("slack", "U_MARK");
const RAY_ID = "900000000000000042";
const RAY = personAddress("discord", RAY_ID);
const ELSEWHERE = resourceAddress("slack", CONTAINER_RESOURCE_TYPE, "C_ELSEWHERE");
const ORG = "default";

{
  ok(resourceTypesFor("slack").includes(PERSON_RESOURCE_TYPE), "slack implements the `person` resource type");
  ok(resourceTypesFor("discord").includes(PERSON_RESOURCE_TYPE), "discord implements the `person` resource type too (OPE-1077)");
  ok(resourceTypesFor("teams").includes(PERSON_RESOURCE_TYPE), "teams implements it too (OPE-1078) — at the surface-key spelling of its `29:` id");
  ok(RAY === "discord:person/900000000000000042", "a discord person address composes with the snowflake id intact");
  ok(SARAH === "slack:person/U_SARAH", "the person address composes as <connector>:person/<id>");
  const parsed = parseResourceAddress(SARAH);
  ok(parsed?.connector === "slack" && parsed.type === "person" && parsed.id === SARAH_ID, "a person address parses into three facts");
  for (const bad of ["slack:person/*", "slack:person/", "slack:*/U1", "slack:person/U1/U2"]) {
    ok(parseResourceAddress(bad) === undefined || resourceTypesFor("slack").includes(parseResourceAddress(bad)!.type) === false || bad.includes("*"), `"${bad}" is not a usable person address`);
  }
  ok(parseResourceAddress("slack:person/*") === undefined, "a wildcard person id does not parse");

  ok(isResourceCapability("dm"), "`dm` is implemented");
  ok(!isResourceCapability("im:write"), "a raw vendor permission string is NOT a capability");
  ok(RESOURCE_CAPABILITY_NAMES.includes("dm"), "`dm` is in the closed vocabulary");
  ok(RESOURCE_CAPABILITIES.dm.summary.length > 0, "`dm` carries an operator-facing summary");
  ok(resourceCapabilityType("dm") === PERSON_RESOURCE_TYPE, "`dm` acts on a person");
  ok(resourceCapabilityType("post") === CONTAINER_RESOURCE_TYPE, "`post` acts on a channel");

  ok(JSON.stringify(defaultResourceCapabilitiesFor("person")) === JSON.stringify(["dm"]), "a bare person row defaults to `dm`");
  ok(JSON.stringify(defaultResourceCapabilitiesFor("channel")) === JSON.stringify(["post"]), "a bare channel row still defaults to `post`");
  ok(JSON.stringify(DEFAULT_RESOURCE_CAPABILITIES) === JSON.stringify(["post"]), "tier P1's named default is unchanged");
  ok(defaultResourceCapabilitiesFor("nonesuch").length === 0, "an unimplemented type defaults to nothing");

  ok(resourceGrantCapabilities({ connector: "slack", resources: [SARAH] })[0] === "dm", "an unadorned person row grants `dm`");
  ok(resourceGrantCapabilities({ connector: "slack", resources: [ELSEWHERE] })[0] === "post", "an unadorned channel row still grants `post`");
  ok(resourceGrantType({ connector: "slack", resources: [SARAH, MARK] }) === "person", "a row of person addresses resolves to one type");
  ok(resourceGrantType({ connector: "slack", resources: [SARAH, ELSEWHERE] }) === undefined, "a MIXED row resolves to no single type");

  const wrong = resourceCapabilityProblems("row", ["post"], "person");
  ok(wrong.length === 1 && wrong[0]!.includes("acts on"), "`post` on a person row refuses, naming the type it acts on");
  ok(resourceCapabilityProblems("row", ["dm"], "person").length === 0, "`dm` on a person row is valid");
  ok(resourceCapabilityProblems("row", ["dm"], "channel").length === 1, "`dm` on a channel row refuses");
  ok(resourceCapabilityProblems("row", ["post"], "channel").length === 0, "tier P1's own spelling stays valid");
}

{
  const bundle = (grants: readonly ResourceGrant[]): Bundle[] => [{ name: "b", resourceGrants: grants } as Bundle];
  ok(resourceGrantProblems("b", [{ connector: "slack", resources: [SARAH] }]).length === 0, "a well-formed person row loads");
  ok(throws(() => assertBundlesValid(bundle([{ connector: "slack", resources: [SARAH] }]))) === "", "a well-formed person row passes assertBundlesValid");

  const mixed = resourceGrantProblems("b", [{ connector: "slack", resources: [SARAH, ELSEWHERE] }]);
  ok(mixed.length === 1 && mixed[0]!.includes("mixes resource types"), "a row mixing a person and a channel refuses at load");
  ok(mixed[0]!.includes('"channel"') && mixed[0]!.includes('"person"'), "the mixed-row refusal names BOTH types, so an operator can see what to split");

  const wrongCap = resourceGrantProblems("b", [{ connector: "slack", resources: [SARAH], capabilities: ["post"] }]);
  ok(wrongCap.length === 1 && wrongCap[0]!.includes("acts on"), "`post` on a person row refuses at load");

  const rawPerm = resourceGrantProblems("b", [{ connector: "slack", resources: [SARAH], capabilities: ["im:write"] as never }]);
  ok(rawPerm.length === 1 && rawPerm[0]!.includes("never raw vendor permission strings"), "a raw Slack scope is not writable as a person capability");

  ok(resourceGrantProblems("b", [{ connector: "discord", resources: [RAY] }]).length === 0, "a well-formed discord person row loads");
  ok(throws(() => assertBundlesValid(bundle([{ connector: "discord", resources: [RAY] }]))) === "", "a discord person row passes assertBundlesValid");
  ok(resourceGrantCapabilities({ connector: "discord", resources: [RAY] })[0] === "dm", "an unadorned discord person row grants `dm`");
  const discordMixed = resourceGrantProblems("b", [{ connector: "discord", resources: [RAY, "discord:channel/900000000000000001"] }]);
  ok(discordMixed.length === 1 && discordMixed[0]!.includes("mixes resource types"), "the one-row-one-type rule holds on discord too");

  const unknownConnector = resourceGrantProblems("b", [{ connector: "irc", resources: ["irc:person/U1"] }]);
  ok(unknownConnector.length > 0, "a person row on a connector this table does not admit refuses at load");

  ok(parseResourceAddress("teams:person/29:1abc") === undefined, "a REAL teams person id does not parse — the `29:` prefix carries a second colon");
  const TEAMS_RAW_PERSON = "29:1boTframeworkPersonId";
  const TEAMS_PERSON = personAddress("teams", TEAMS_RAW_PERSON);
  ok(TEAMS_PERSON === `teams:person/${surfaceKeySegment(TEAMS_RAW_PERSON)}`, "personAddress composes a teams person address at the surface-key spelling");
  ok(TEAMS_PERSON !== `teams:person/${TEAMS_RAW_PERSON}`, "…which is NOT the raw id — the two really are different strings");
  ok(parseResourceAddress(TEAMS_PERSON)?.id === surfaceKeySegment(TEAMS_RAW_PERSON), "…and the composed address parses back to that same spelling");
  ok(personAddress("teams", TEAMS_PERSON.slice("teams:person/".length)) === TEAMS_PERSON, "composing from an ALREADY-spelled id is a no-op — one address, however it is reached");
  ok(personAddress("slack", SARAH_ID) === SARAH && personAddress("discord", RAY_ID) === RAY, "…and the spelling changes nothing for slack or discord, whose ids are already safe");
}

{
  const request = { mode: "channel", platform: "slack", workspace: "T1", channel: "C_HOME", domains: ["eng"] } as const;
  const bind = (bundle: string) => ({ bundle, scope: { level: "org" } as const });
  const access = resolveAccess(
    { ...request },
    [
      { name: "core", resourceGrants: [{ connector: "slack", resources: [SARAH] }] } as Bundle,
      { name: "more", resourceGrants: [{ connector: "slack", resources: [SARAH, MARK], capabilities: ["dm"] }] } as Bundle,
    ],
    [bind("core"), bind("more")],
  );
  ok(JSON.stringify(access.resourceCapabilities[SARAH]) === JSON.stringify(["dm"]), "two bundles naming the same person union to `dm`");
  ok(access.resourceCapabilities[MARK]?.includes("dm") === true, "the second bundle's own person is granted too");
  ok(access.resourceCapabilities["slack:person/U_NOBODY"] === undefined, "an unnamed person carries no grant at all");
}

{
  const granted = { [SARAH]: ["dm"] as const };
  ok(domainWorksOnPlatform(HOME, "slack", DOMAINS), "the eng domain works on slack");
  ok(!domainWorksOnPlatform(DISCORD_HOME, "slack", DOMAINS), "the ops domain does NOT work on slack");

  const targets = chatDmTargetsFrom(HOME, granted, DOMAINS);
  ok(targets.length === 1 && targets[0]!.principalId === SARAH_ID, "a granted person on a surface this domain works on resolves");
  ok(targets[0]!.address === SARAH, "the resolved target carries the address exactly as config wrote it");

  ok(chatDmTargetsFrom(HOME, {}, DOMAINS).length === 0, "a deployment that granted nobody resolves no DM target");
  ok(chatDmTargetsFrom(HOME, { [ELSEWHERE]: ["post"] }, DOMAINS).length === 0, "a tier-P1 channel grant grants no DM");
  ok(chatWriteTargetsFrom(HOME, granted, DOMAINS).length === 0, "a tier-P2 person grant grants no cross-container post");

  ok(chatDmTargetsFrom(DISCORD_HOME, granted, DOMAINS).length === 0, "a caller whose domain holds no slack container resolves no slack person");

  ok(chatDmTargetsFrom("", granted, DOMAINS).length === 0, "an unreadable caller surface resolves nothing");
}

{
  const rayGranted = { [RAY]: ["dm"] as const };
  ok(domainWorksOnPlatform(DISCORD_HOME, "discord", DOMAINS), "the ops domain works on discord");
  ok(domainWorksOnPlatform(HOME, "discord", DOMAINS) === false, "the eng domain does NOT work on discord — it rosters no discord container");

  const targets = chatDmTargetsFrom(DISCORD_HOME, rayGranted, DOMAINS);
  ok(targets.length === 1, "a granted discord person on a domain that works on discord resolves");
  ok(targets[0]!.platform === "discord" && targets[0]!.principalId === RAY_ID, "the resolved id is the bare snowflake `deliverDirectMessage` takes");
  ok(targets[0]!.address === RAY, "the discord target carries the address exactly as config wrote it");

  ok(chatWriteTargetsFrom(DISCORD_HOME, rayGranted, DOMAINS).length === 0, "a discord person grant grants no cross-container post");

  const refusal = (surfaceKey: string, g: Record<string, readonly ("dm" | "post")[]>, requested: string): ChatDmGrantError => {
    try {
      resolveChatDmTargetFrom(surfaceKey, g, DOMAINS, requested);
    } catch (e) {
      return e as ChatDmGrantError;
    }
    throw new Error(`expected a refusal for ${requested}`);
  };

  const ungranted = refusal(DISCORD_HOME, {}, RAY);
  ok(ungranted.boundary === "ungranted", "a discord person nobody granted refuses as `ungranted`");
  ok(ungranted.platform === "discord", "the refusal names the RECIPIENT's platform — what the dm.refused row files under");
  ok(ungranted.message.includes("presence alone"), "the discord ungranted refusal says presence is not a grant");

  ok(chatDmTargetsFrom(HOME, rayGranted, DOMAINS).length === 0, "a slack-only domain names no discord person, however the bundle is bound");
  const cross = refusal(HOME, rayGranted, RAY);
  ok(cross.boundary === "cross-domain", "a granted discord person refuses as `cross-domain` for a domain with no discord container");
  ok(cross.message.includes("memory/config/domains.ts"), "the discord cross-domain refusal names the DOMAIN remedy");
  ok(cross.message !== ungranted.message, "the two discord refusals are different messages, because the remedies are different files");

  const malformed = refusal(DISCORD_HOME, rayGranted, RAY_ID);
  ok(malformed.boundary === "malformed", "a bare discord snowflake (no address form) is `malformed`, never `ungranted`");
}

{
  const granted = { [SARAH]: ["dm"] as const };
  const refusal = (surfaceKey: string | undefined, g: Record<string, readonly ("dm" | "post")[]>, requested: string): ChatDmGrantError => {
    try {
      resolveChatDmTargetFrom(surfaceKey, g, DOMAINS, requested);
    } catch (e) {
      return e as ChatDmGrantError;
    }
    throw new Error(`expected a refusal for ${requested}`);
  };

  const admitted = resolveChatDmTargetFrom(HOME, granted, DOMAINS, SARAH);
  ok(admitted.principalId === SARAH_ID && admitted.platform === "slack", "the granted, in-domain person resolves");

  const malformed = refusal(HOME, granted, "just-sarah");
  ok(malformed.boundary === "malformed", "a string that is not an address is `malformed`, not `ungranted`");
  ok(malformed.message.includes("slack:person/U0123ABC"), "the malformed refusal shows the address form");

  const ungranted = refusal(HOME, granted, MARK);
  ok(ungranted.boundary === "ungranted", "a person nobody granted refuses as `ungranted`");
  ok(ungranted.message.includes("resourceGrants"), "the ungranted refusal names the CONFIG remedy");
  ok(ungranted.message.includes("presence alone"), "the ungranted refusal says presence is not a grant");
  ok(!ungranted.message.includes("channels"), "the ungranted refusal does NOT send an operator to the domain roster");

  const cross = refusal(DISCORD_HOME, granted, SARAH);
  ok(cross.boundary === "cross-domain", "a granted person on a surface the domain does not work on refuses as `cross-domain`");
  ok(cross.message.includes("memory/config/domains.ts"), "the cross-domain refusal names the DOMAIN remedy");
  ok(cross.message !== ungranted.message, "the two refusals are different messages, because the remedies are different files");

  const blind = refusal(undefined, granted, SARAH);
  ok(blind.boundary === "cross-domain", "an unreadable caller identity refuses rather than admitting");
}

{
  const subject = { org: ORG, address: SARAH, platform: "slack", workspace: "T1", principalId: SARAH_ID };

  const fresh = await readDmAudience(ORG, SARAH);
  ok(!fresh.stopped && !fresh.delivered, "an unknown person is neither stopped nor already delivered to");

  await noteDmAudienceDelivery(ORG, SARAH, "2026-08-24T10:00:00.000Z");
  const afterFirst = await readDmAudience(ORG, SARAH);
  ok(afterFirst.delivered, "after the first delivery the person is marked delivered, so later messages flow");
  ok(afterFirst.row?.firstDmAt === "2026-08-24T10:00:00.000Z", "the first delivery time is recorded");

  await noteDmAudienceDelivery(ORG, SARAH, "2026-08-24T11:00:00.000Z");
  ok((await readDmAudience(ORG, SARAH)).row?.firstDmAt === "2026-08-24T10:00:00.000Z", "a later delivery does NOT move the first-delivery stamp");

  const stopped = await stopDmAudience({ ...subject, at: "2026-01-29T18:22:00.000Z" });
  ok(stopped.changed, "the first stop reports that it changed something");
  const afterStop = await readDmAudience(ORG, SARAH);
  ok(afterStop.stopped, "the stop is durable and reads back");
  ok(afterStop.delivered, "the stop does not erase the delivery record");

  const again = await stopDmAudience({ ...subject, at: "2026-08-24T13:00:00.000Z" });
  ok(!again.changed, "re-stopping reports that nothing changed");
  ok((await readDmAudience(ORG, SARAH)).row?.stoppedAt === "2026-01-29T18:22:00.000Z", "the trail keeps when the boundary was FIRST drawn");

  await noteDmAudienceDelivery(ORG, SARAH, "2026-08-24T14:00:00.000Z");
  ok((await readDmAudience(ORG, SARAH)).stopped, "recording a delivery does not clear a stop");

  const resumed = await resumeDmAudience(subject);
  ok(resumed.changed, "the resume reports that it lifted a stop");
  const afterResume = await readDmAudience(ORG, SARAH);
  ok(!afterResume.stopped, "after the resume the person is no longer stopped");
  ok(afterResume.delivered, "the resume keeps the delivery record, so the next message still flows without a second card");

  const noop = await resumeDmAudience(subject);
  ok(!noop.changed, "resuming when nothing was stopped reports that nothing changed");

  const rows = await readAudit({ org: ORG });
  ok(rows.some((r) => r.action === DM_STOP_ACTION && (r.detail as { address?: string })?.address === SARAH), "the stop writes an audit row naming the person");
  ok(rows.some((r) => r.action === DM_RESUME_ACTION), "the resume writes its own audit row");
  ok(
    rows.filter((r) => r.action === DM_STOP_ACTION).some((r) => (r.detail as { changed?: boolean })?.changed === false),
    "a repeated stop is recorded as having changed nothing — evidence the first one did not feel like it worked",
  );
}

{
  const { assertChatDmAllowed } = await import("../agent/access/chat-dm-grant.js");
  const { registerConfig } = await import("../agent/access/config.js");
  const { resolvePartition } = await import("../agent/memory/partition.js");
  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: "U_ASKER", attributes: { team_id: "T1", channel_id: "C_HOME", channel_type: "channel" } } } },
  } as never;
  const LIVE_SURFACE = resolvePartition(ctx).surfaceKey;
  const LIVE_DOMAINS: readonly Domain[] = [{ name: "eng", reach: [LIVE_SURFACE] }];

  const withGrant = (grants: readonly ResourceGrant[]) => {
    registerConfig({
      loadBundles: () => [{ name: "dm", resourceGrants: grants } as Bundle],
      loadBindings: () => [{ bundle: "dm", scope: { level: "org" } }],
      loadDomains: () => LIVE_DOMAINS as never,
      domainsForSurface: () => ["eng"],
      pluginRegistry: {},
      skillContent: {},
    } as never);
  };

  const MARK_ID = "U_MARK";
  withGrant([{ connector: "slack", resources: [MARK] }]);
  const first = await assertChatDmAllowed(ctx, LIVE_DOMAINS, MARK);
  ok(first.target.principalId === MARK_ID, "a granted, in-domain person is admitted");
  ok(!first.delivered, "the FIRST delivery reports delivered:false, so the tool cards it");

  await noteDmAudienceDelivery(ORG, MARK, "2026-08-24T10:00:00.000Z");
  const second = await assertChatDmAllowed(ctx, LIVE_DOMAINS, MARK);
  ok(second.delivered, "a LATER delivery reports delivered:true, so the tool flows it");

  await stopDmAudience({ org: ORG, address: MARK, platform: "slack", workspace: "T1", principalId: MARK_ID, at: "2026-01-29T18:22:00.000Z" });
  let boundary = "";
  let message = "";
  try {
    await assertChatDmAllowed(ctx, LIVE_DOMAINS, MARK);
  } catch (e) {
    boundary = (e as ChatDmGrantError).boundary;
    message = (e as Error).message;
  }
  ok(boundary === "stopped", "a stopped person refuses with the `stopped` boundary, not `ungranted`");
  ok(message.includes("stop sending them direct messages"), "the refusal NAMES the boundary in words the seat can repeat");
  ok(message.includes("no configuration overrides"), "the refusal says no config lifts it");
  ok(message.includes("only they can lift it"), "the refusal names who CAN lift it");

  withGrant([]);
  withGrant([{ connector: "slack", resources: [MARK] }]);
  let reBoundary = "";
  try {
    await assertChatDmAllowed(ctx, LIVE_DOMAINS, MARK);
  } catch (e) {
    reBoundary = (e as ChatDmGrantError).boundary;
  }
  ok(reBoundary === "stopped", "RE-GRANTING does not clear the recipient's stop");

  await resumeDmAudience({ org: ORG, address: MARK, platform: "slack", workspace: "T1", principalId: MARK_ID });
  const restored = await assertChatDmAllowed(ctx, LIVE_DOMAINS, MARK);
  ok(restored.target.principalId === MARK_ID, "after the recipient resumes, the grant works again");
  ok(restored.delivered, "the restored route flows — the person was already carded once");

  const refusals = (await readAudit({ org: ORG })).filter((r) => r.action === "dm.refused");
  ok(refusals.some((r) => (r.detail as { boundary?: string })?.boundary === "stopped"), "a stopped refusal is audited under its own boundary");
  ok(refusals.every((r) => !("text" in (r.detail as object))), "no refusal row carries message text");

  withGrant([]);
  await stopDmAudience({ org: ORG, address: SARAH, platform: "slack", workspace: "T1", principalId: SARAH_ID, at: "2026-08-24T15:00:00.000Z" });
  let probeBoundary = "";
  try {
    await assertChatDmAllowed(ctx, LIVE_DOMAINS, SARAH);
  } catch (e) {
    probeBoundary = (e as ChatDmGrantError).boundary;
  }
  ok(probeBoundary === "ungranted", "an ungranted caller cannot tell a stopped person from an unstopped one");
}

{
  const { assertChatDmAllowed } = await import("../agent/access/chat-dm-grant.js");
  const { registerConfig } = await import("../agent/access/config.js");
  const { registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
  const { resolvePartition } = await import("../agent/memory/partition.js");
  const { sqliteOperationalStore } = await import("../agent/operational/sqlite.js");
  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: "U_ASKER", attributes: { team_id: "T1", channel_id: "C_HOME", channel_type: "channel" } } } },
  } as never;
  const LIVE_SURFACE = resolvePartition(ctx).surfaceKey;
  const LIVE_DOMAINS: readonly Domain[] = [{ name: "eng", reach: [LIVE_SURFACE] }];
  const KIT = personAddress("slack", "U_KIT");
  registerConfig({
    loadBundles: () => [{ name: "dm", resourceGrants: [{ connector: "slack", resources: [KIT] }] } as Bundle],
    loadBindings: () => [{ bundle: "dm", scope: { level: "org" } }],
    loadDomains: () => LIVE_DOMAINS as never,
    domainsForSurface: () => ["eng"],
    pluginRegistry: {},
    skillContent: {},
  } as never);

  registerOperationalStore({
    ...sqliteOperationalStore,
    getDmAudience: async () => {
      throw new Error("connection reset");
    },
  } as never);
  resetOperationalStore();

  const state = await readDmAudience(ORG, KIT);
  ok(state.stopped, "an unreadable store suppresses — the fail-closed direction");
  ok(!state.readable, "and it says so, rather than presenting the guess as a fact");

  let boundary = "";
  let message = "";
  try {
    await assertChatDmAllowed(ctx, LIVE_DOMAINS, KIT);
  } catch (e) {
    boundary = (e as ChatDmGrantError).boundary;
    message = (e as Error).message;
  }
  ok(boundary === "unreadable", "the refusal is `unreadable`, NOT `stopped` — an outage is not a person's decision");
  ok(!message.includes("asked this agent to stop"), "the refusal never claims the person asked for anything");
  ok(message.includes("Nobody refused you"), "the refusal says plainly that nobody refused");
  ok(message.includes("operator"), "and it names who should look at it");

  registerOperationalStore(sqliteOperationalStore);
  resetOperationalStore();
}

{
  const footer = dmDeliveryFooter({ requestedBy: "U_ASKER", fromContainer: HOME });
  ok(footer.includes("U_ASKER"), "the footer names WHO asked");
  ok(footer.includes(HOME), "the footer names WHERE the ask came from");
  ok(footer.toLowerCase().includes("stop"), "the footer tells the recipient how to stop it");
}

{
  const dm = TOOL_CONSEQUENCE["dm_person"];
  ok(dm !== undefined, "dm_person carries a TOOL_CONSEQUENCE row");
  ok(dm!.tier === "gate:member", "dm_person is gate:member — the audience axis, by definition");
  ok(dm!.via.kind === "action-kind" && dm!.via.action === "chat.dm", "dm_person proposes the chat.dm ActionKind");
  ok(dm!.taint === "disclose", "dm_person discloses taint on the card rather than auto-rejecting");
  ok(dm!.reason.includes("DOES NOT REPEAT"), "the consequence row states the honest bound: the card gates the FIRST message only");

  const stop = TOOL_CONSEQUENCE["set_dm_delivery"];
  ok(stop !== undefined, "set_dm_delivery carries a TOOL_CONSEQUENCE row");
  ok(stop!.tier === "open", "set_dm_delivery is `open` — a card in front of \"please stop\" would be absurd");

  ok(LEAN_SEAT_TOOLS.has("set_dm_delivery"), "the recipient's stop is on the lean seat — it is the DM seat's own verb");
  ok(!LEAN_SEAT_TOOLS.has("dm_person"), "the DM verb is NOT on the lean seat — a delegating seat routes it to a worker");
  ok(WINDOW_UNGATED_TOOLS.has("dm_person"), "dm_person is grain-ungated — its control is the grant, not the grain");
  ok(WINDOW_UNGATED_TOOLS.has("set_dm_delivery"), "set_dm_delivery is grain-ungated — grain-gating it would strand the seat a person asks to stop");

  const { actionKind } = await import("../agent/approvals/actions.js");
  await import("../agent/approvals/flow.js");
  ok(actionKind("chat.dm")?.policy === "member", "the chat.dm ActionKind is registered through flow.ts at policy member");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ chat-dm-grant: ${n} assertions`);
