import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { assertPackageDistFresh } from "./core-dist-freshness.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";

assertPackageDistFresh("packages/core", "@open-everywhere/core");
for (const id of ["slack", "discord", "teams"]) {
  assertPackageDistFresh(`packages/providers/${id}`, `@open-everywhere/provider-${id}`);
}

delete process.env.OE_EGRESS_SPOOF;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.DISCORD_BOT_TOKEN = "discord-test-token";
process.env.MICROSOFT_APP_ID = "fixture-app-id-not-a-secret";
process.env.MICROSOFT_APP_PASSWORD = "fixture-app-secret-not-a-secret";

const dir = join(tmpdir(), `open-everywhere-resource-grant-parity-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_ORG = "parity-org";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();

const { RESOURCE_CONNECTORS, resourceTypesFor } = await import("@open-everywhere/core/agent/access/resource-grant.js");
const { CONTAINER_RESOURCE_TYPE } = await import("@open-everywhere/core/agent/access/chat-write-grant.js");
const { PERSON_RESOURCE_TYPE } = await import("@open-everywhere/core/agent/channels/dm-audience.js");
const { postSurfaceText } = await import("@open-everywhere/core/agent/channels/surface-message-ops.js");
const { dispatchDirectMessage, canDeliverDirectMessage } = await import("@open-everywhere/core/agent/channels/post-arms.js");
const { surfaceKeySegment } = await import("@open-everywhere/core/agent/adapter-api.js");
const { recordTeamsConversationReference } = await import("@open-everywhere/provider-teams/agent/channels/teams-conversation-ref.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const TEAMS_SERVICE_URL = "https://smba.trafficmanager.net/uk/";
const TEAMS_TENANT = "parity-tenant-id";
const RAW_CONTAINER: Readonly<Record<string, string>> = { teams: "19:parityConversation@thread.tacv2" };
const RAW_PERSON: Readonly<Record<string, string>> = { teams: "29:1parityBotFrameworkPersonId" };

const containerAddressId = (connector: string): string => surfaceKeySegment(RAW_CONTAINER[connector] ?? "CONTAINER_1");
const personAddressId = (connector: string): string => surfaceKeySegment(RAW_PERSON[connector] ?? "PERSON_1");

const unknownCalls: string[] = [];
const wireCalls: string[] = [];
const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const fakeVendorHttp = (async (url: unknown) => {
  const u = String(url);
  wireCalls.push(u);
  if (u.includes("slack.com/api/chat.postMessage")) return json({ ok: true, ts: "1712.500000" });
  if (u.includes("slack.com/api/conversations.open")) return json({ ok: true, channel: { id: "D_SLACK_DM" } });
  if (u.includes("discord.com/api/") && u.endsWith("/users/@me/channels")) return json({ id: "1000000000000000001" });
  if (u.includes("discord.com/api/") && u.endsWith("/messages")) return json({ id: "1000000000000000002" });
  if (u.includes("login.microsoftonline.com") || u.includes("botframework.com/oauth")) {
    return json({ access_token: "fixture-token-not-a-secret", token_type: "Bearer", expires_in: 3600 });
  }
  if (u.startsWith(TEAMS_SERVICE_URL) && u.endsWith("/activities")) return json({ id: "teams-activity-1" });
  unknownCalls.push(u);
  return json({ error: "no fake for this endpoint" }, 500);
}) as typeof fetch;

try {
  await withPatchedFetch(fakeVendorHttp, async () => {
    ok(process.env.OE_EGRESS_SPOOF === undefined, "OE_EGRESS_SPOOF is unset — every post below is a real transport call, not a synthetic id");

    await recordTeamsConversationReference({
      scope: "channel",
      tenantId: TEAMS_TENANT,
      conversationId: RAW_CONTAINER.teams!,
      serviceUrl: TEAMS_SERVICE_URL,
      userId: "29:1someOtherChannelSpeaker",
      teamId: "TEAM_PARITY",
    });
    await recordTeamsConversationReference({
      scope: "personal",
      tenantId: TEAMS_TENANT,
      conversationId: "19:1to1parityChat@thread.v2",
      serviceUrl: TEAMS_SERVICE_URL,
      userId: RAW_PERSON.teams!,
    });
    ok(
      containerAddressId("teams") !== RAW_CONTAINER.teams && personAddressId("teams") !== RAW_PERSON.teams,
      "the Teams address spelling really DIFFERS from the raw Bot Framework ids — otherwise the loop below would prove nothing about restoration",
    );

    ok(RESOURCE_CONNECTORS.length > 0, "the closed table admits at least one connector");
    for (const connector of RESOURCE_CONNECTORS) {
      const types = resourceTypesFor(connector);
      ok(types.length > 0, `${connector} is listed as a connector and names at least one resource type`);

      if (types.includes(CONTAINER_RESOURCE_TYPE)) {
        const messageId = await postSurfaceText(connector, { channelId: containerAddressId(connector), text: "tier P1 parity probe" });
        ok(typeof messageId === "string" && messageId.length > 0, `${connector}:${CONTAINER_RESOURCE_TYPE} — the container transport returns a message id for the ADDRESS spelling`);
      }

      if (types.includes(PERSON_RESOURCE_TYPE)) {
        ok(canDeliverDirectMessage(connector), `${connector}:${PERSON_RESOURCE_TYPE} — the provider registers a deliverDirectMessage arm`);
        const delivery = await dispatchDirectMessage(connector, { principalId: personAddressId(connector), text: "tier P2 parity probe" });
        ok(
          typeof delivery.surfaceId === "string" && delivery.surfaceId.length > 0 && typeof delivery.messageId === "string" && delivery.messageId.length > 0,
          `${connector}:${PERSON_RESOURCE_TYPE} — the person transport returns a delivery with both public ids for the ADDRESS spelling`,
        );
      }
    }
    ok(unknownCalls.length === 0, `every transport call hit an endpoint this file knows (unmatched: ${unknownCalls.join(", ") || "none"})`);

    ok(resourceTypesFor("teams").includes(CONTAINER_RESOURCE_TYPE) && resourceTypesFor("teams").includes(PERSON_RESOURCE_TYPE), "teams admits BOTH resource types");
    const teamsSends = wireCalls.filter((u) => u.startsWith(TEAMS_SERVICE_URL) && u.endsWith("/activities"));
    ok(
      teamsSends.some((u) => u.includes(encodeURIComponent(RAW_CONTAINER.teams!))),
      "the Teams container post reached the RAW conversation id on the wire — the index restored it from the address spelling",
    );
    ok(
      teamsSends.every((u) => !u.includes(encodeURIComponent(containerAddressId("teams")))),
      "…and the SPELLED id never reached the Bot Framework, which would refuse it",
    );

    ok(resourceTypesFor("irc").length === 0, "a connector nobody implements names no resource type");
    ok(RESOURCE_CONNECTORS.includes("irc") === false, "…and does not appear in the admitted list");
  });

  console.log(`resource-grant-transport-parity: ${n} assertions passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
