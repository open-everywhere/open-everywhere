import assert from "node:assert/strict";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";

delete process.env.OE_EGRESS_SPOOF;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.DISCORD_BOT_TOKEN = "discord-test-token";

registerSlackProvider();
registerDiscordProvider();
registerTeamsProvider();

const { RESOURCE_CONNECTORS, resourceTypesFor } = await import("@open-everywhere/core/agent/access/resource-grant.js");
const { CONTAINER_RESOURCE_TYPE } = await import("@open-everywhere/core/agent/access/chat-write-grant.js");
const { PERSON_RESOURCE_TYPE } = await import("@open-everywhere/core/agent/channels/dm-audience.js");
const { postSurfaceText } = await import("@open-everywhere/core/agent/channels/surface-message-ops.js");
const { dispatchDirectMessage, canDeliverDirectMessage } = await import("@open-everywhere/core/agent/channels/post-arms.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const unknownCalls: string[] = [];
const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const fakeVendorHttp = (async (url: unknown) => {
  const u = String(url);
  if (u.includes("slack.com/api/chat.postMessage")) return json({ ok: true, ts: "1712.500000" });
  if (u.includes("slack.com/api/conversations.open")) return json({ ok: true, channel: { id: "D_SLACK_DM" } });
  if (u.includes("discord.com/api/") && u.endsWith("/users/@me/channels")) return json({ id: "1000000000000000001" });
  if (u.includes("discord.com/api/") && u.endsWith("/messages")) return json({ id: "1000000000000000002" });
  unknownCalls.push(u);
  return json({ error: "no fake for this endpoint" }, 500);
}) as typeof fetch;

await withPatchedFetch(fakeVendorHttp, async () => {
  ok(process.env.OE_EGRESS_SPOOF === undefined, "OE_EGRESS_SPOOF is unset — every post below is a real transport call, not a synthetic id");

  ok(RESOURCE_CONNECTORS.length > 0, "the closed table admits at least one connector");
  for (const connector of RESOURCE_CONNECTORS) {
    const types = resourceTypesFor(connector);
    ok(types.length > 0, `${connector} is listed as a connector and names at least one resource type`);

    if (types.includes(CONTAINER_RESOURCE_TYPE)) {
      const messageId = await postSurfaceText(connector, { channelId: "CONTAINER_1", text: "tier P1 parity probe" });
      ok(typeof messageId === "string" && messageId.length > 0, `${connector}:${CONTAINER_RESOURCE_TYPE} — the container transport returns a message id`);
    }

    if (types.includes(PERSON_RESOURCE_TYPE)) {
      ok(canDeliverDirectMessage(connector), `${connector}:${PERSON_RESOURCE_TYPE} — the provider registers a deliverDirectMessage arm`);
      const delivery = await dispatchDirectMessage(connector, { principalId: "PERSON_1", text: "tier P2 parity probe" });
      ok(
        typeof delivery.surfaceId === "string" && delivery.surfaceId.length > 0 && typeof delivery.messageId === "string" && delivery.messageId.length > 0,
        `${connector}:${PERSON_RESOURCE_TYPE} — the person transport returns a delivery with both public ids`,
      );
    }
  }
  ok(unknownCalls.length === 0, `every transport call hit an endpoint this file knows (unmatched: ${unknownCalls.join(", ") || "none"})`);

  ok(resourceTypesFor("teams").length === 0, "teams admits NO resource type — the closed table refuses it");
  ok(canDeliverDirectMessage("teams"), "…and NOT for want of a DM arm: the teams provider registers deliverDirectMessage");

  ok(resourceTypesFor("irc").length === 0, "a connector nobody implements names no resource type");
  ok(RESOURCE_CONNECTORS.includes("irc") === false, "…and does not appear in the admitted list");
});

console.log(`resource-grant-transport-parity: ${n} assertions passed`);
