import assert from "node:assert/strict";

import { assertPackageDistFresh } from "./core-dist-freshness.js";

assertPackageDistFresh("packages/core", "@open-everywhere/core");
assertPackageDistFresh("packages/providers/teams", "@open-everywhere/provider-teams");

const { registerTeamsProvider } = await import("@open-everywhere/provider-teams/agent/register.js");
registerTeamsProvider();

const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineBundle, defineBinding } = await import("@open-everywhere/core/agent/access/bundle.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const { resolvePartition, domainKeyOf } = await import("@open-everywhere/core/agent/memory/partition.js");
const { surfaceKeySegment } = await import("@open-everywhere/core/agent/adapter-api.js");
const { chatWriteMount, chatWriteTargets, resolveChatWriteTarget, ChatWriteGrantError, CONTAINER_RESOURCE_TYPE } = await import(
  "@open-everywhere/core/agent/access/chat-write-grant.js"
);
const { chatDmMount, chatDmTargets } = await import("@open-everywhere/core/agent/access/chat-dm-grant.js");
const { resourceAddress } = await import("@open-everywhere/core/agent/access/resource-grant.js");
const { personAddress } = await import("@open-everywhere/core/agent/channels/dm-audience.js");
const { buildTeamsAuth } = await import("@open-everywhere/provider-teams/agent/channels/teams-identity.js");

type BindableContext = import("@open-everywhere/core/agent/adapter-api.js").BindableContext;
type Domain = import("@open-everywhere/core/agent/memory/domain.js").Domain;

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const TENANT = "grain-tenant-id";
const RAW_WAKE_CHANNEL = "19:grainWakeChannel@thread.tacv2";
const RAW_WAKE_CONVERSATION = `${RAW_WAKE_CHANNEL};messageid=1770032431388`;
const RAW_OTHER_CHANNEL = "19:grainOtherChannel@thread.tacv2";
const RAW_OUTSIDE_CHANNEL = "19:grainOutsideChannel@thread.tacv2";
const SLACK_TEAM = "T_GRAIN";
const SLACK_CHANNEL = "C_GRAIN";
const SLACK_PERSON = "U_GRAIN_SARAH";

const wakeChannelId = surfaceKeySegment(RAW_WAKE_CHANNEL);
const otherChannelId = surfaceKeySegment(RAW_OTHER_CHANNEL);
const outsideChannelId = surfaceKeySegment(RAW_OUTSIDE_CHANNEL);
const GRANTED_CONTAINER = resourceAddress("teams", CONTAINER_RESOURCE_TYPE, otherChannelId);
const OUTSIDE_CONTAINER = resourceAddress("teams", CONTAINER_RESOURCE_TYPE, outsideChannelId);
const GRANTED_PERSON = personAddress("slack", SLACK_PERSON);

const DOMAIN_NAME = "grain-fixture";
const domains: readonly Domain[] = [
  defineDomain({
    name: DOMAIN_NAME,
    channels: [`teams/${TENANT}/${wakeChannelId}`, `teams/${TENANT}/${otherChannelId}`, `slack/${SLACK_TEAM}/${SLACK_CHANNEL}`],
  }),
];

function arm(granted: readonly { readonly connector: string; readonly resources: readonly string[] }[]): void {
  registerConfig({
    loadBundles: () => [defineBundle({ name: "grain-bundle", ...(granted.length === 0 ? {} : { resourceGrants: granted as never }) })],
    loadBindings: () => [defineBinding({ bundle: "grain-bundle", scope: { level: "domain", domain: DOMAIN_NAME } })],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: ({ workspaceKey, surface }) => domains.filter((d) => (d.channels ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
  });
}

function teamsCtx(conversationId: string, channelId: string | undefined): BindableContext {
  const auth = buildTeamsAuth({
    userId: "29:grain-user",
    tenantId: TENANT,
    conversationId,
    ...(channelId === undefined ? {} : { channelId }),
    teamId: "19:grainTeam@thread.tacv2",
    serviceUrl: "https://smba.trafficmanager.net/uk/",
    scope: "channel",
  });
  return { channel: { kind: "teams" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}

const wake = teamsCtx(RAW_WAKE_CONVERSATION, RAW_WAKE_CHANNEL);

{
  arm([{ connector: "teams", resources: [GRANTED_CONTAINER] }]);
  const p = resolvePartition(wake);
  ok(p.surfaceKey !== domainKeyOf(p), "a real Teams channel wake resolves a surfaceKey and a domainKey that DIFFER — without this every assertion below is vacuous");
  ok(domainKeyOf(p) === `teams/${TENANT}/${wakeChannelId}`, "the DOMAIN grain is the channel key the roster lists");
  ok(p.surfaceKey.startsWith(`teams/${TENANT}/${wakeChannelId}`) && p.surfaceKey !== `teams/${TENANT}/${wakeChannelId}`, "the SURFACE grain carries the reply-chain suffix, which no roster lists");
}

{
  const targets = chatWriteTargets(wake, domains);
  ok(
    targets.length === 1 && targets[0].address === GRANTED_CONTAINER,
    `🔴 the granted in-domain container was not admitted on a real Teams wake — the fence read the wrong container grain. Admitted: [${targets.map((t) => t.address).join(", ")}]`,
  );
  ok(chatWriteMount(wake, () => domains), "🔴 post_message does not mount on a Teams wake that holds a container grant");
  const resolved = resolveChatWriteTarget(wake, domains, GRANTED_CONTAINER);
  ok(resolved.platform === "teams" && resolved.container === otherChannelId, "the per-call fence resolves the same target the mount admitted");
}

{
  arm([{ connector: "teams", resources: [GRANTED_CONTAINER, OUTSIDE_CONTAINER] }]);
  const targets = chatWriteTargets(wake, domains);
  ok(
    targets.length === 1 && targets[0].address === GRANTED_CONTAINER,
    "a granted container the domain does not roster is NOT admitted — the domain fence still holds at the corrected grain",
  );
  let boundary: string | undefined;
  try {
    resolveChatWriteTarget(wake, domains, OUTSIDE_CONTAINER);
  } catch (err) {
    boundary = err instanceof ChatWriteGrantError ? err.boundary : `wrong error class: ${String(err)}`;
  }
  ok(boundary === "cross-domain", `the out-of-roster container refuses cross-domain (got ${String(boundary)})`);
}

{
  arm([]);
  ok(chatWriteTargets(wake, domains).length === 0, "with no resource grant the same ctx admits nothing");
  ok(!chatWriteMount(wake, () => domains), "with no resource grant post_message correctly does not mount");
}

{
  arm([{ connector: "slack", resources: [GRANTED_PERSON] }]);
  const targets = chatDmTargets(wake, domains);
  ok(
    targets.length === 1 && targets[0].address === GRANTED_PERSON,
    `🔴 a Teams wake in a cross-surface domain did not reach the granted Slack person. Admitted: [${targets.map((t) => t.address).join(", ")}]`,
  );
  ok(chatDmMount(wake, () => domains), "🔴 dm_person does not mount on a Teams wake whose domain works on the granted person's platform");

  const personal = teamsCtx("19:1to1grainChat@thread.v2", undefined);
  const pp = resolvePartition(personal);
  ok(domainKeyOf(pp) === pp.surfaceKey, "a personal Teams chat resolves ONE grain — no channel id, so no domainSurface");
  ok(chatDmTargets(personal, domains).length === 0, "a Teams chat outside every domain reaches no granted person");
}

console.log(`chat-write-grant-domain-grain: ${n} assertions passed`);
