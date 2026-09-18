import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  classifyDiscordEvent,
  buildDiscordEventsHandler,
  PUBLIC_DISCORD_EVENTS_ROUTE,
} from "@open-everywhere/provider-discord/agent/channels/discord-events.js";
import type { RouteHandlerArgs } from "eve/channels";

import { pinSuiteStore } from "../packages/core/scripts/_suite-store.js";
pinSuiteStore("discord-events");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const NOW_MS = 1_753_000_000_000;
const TS = String(Math.floor(NOW_MS / 1000));

function signed(body: string, timestamp = TS): Headers {
  const sig = edSign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  return new Headers({ "x-signature-ed25519": sig, "x-signature-timestamp": timestamp });
}

const GUILD = "111222333";
const USER = "444555666";

function authorized(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    application_id: "app-1",
    type: 1,
    event: {
      type: "APPLICATION_AUTHORIZED",
      timestamp: "2026-07-25T10:00:00.000000+00:00",
      data: { integration_type: 0, user: { id: USER, username: "jo" }, scopes: ["bot", "applications.commands"], guild: { id: GUILD, name: "Acme" }, ...extra },
    },
  });
}

function deauthorized(): string {
  return JSON.stringify({
    version: 1,
    application_id: "app-1",
    type: 1,
    event: { type: "APPLICATION_DEAUTHORIZED", timestamp: "2026-07-25T11:00:00.000000+00:00", data: { user: { id: USER, username: "jo" } } },
  });
}

ok(classifyDiscordEvent(JSON.stringify({ version: 1, application_id: "app-1", type: 0 })).kind === "ack", "PING (type 0) is acked, never audited");
ok(classifyDiscordEvent(JSON.stringify({ type: 7 })).kind === "ack", "an unknown webhook type is acked");
ok(classifyDiscordEvent("not json").kind === "ack", "an unparseable body is acked (never a 4xx — Discord would retry then suspend)");
ok(classifyDiscordEvent("[1,2,3]").kind === "ack", "a non-object body is acked");

{
  const other = JSON.stringify({ version: 1, type: 1, event: { type: "ENTITLEMENT_CREATE", data: {} } });
  ok(classifyDiscordEvent(other).kind === "ack", "a monetization/social event is acked, unaudited (only install/uninstall is ours)");
  ok(classifyDiscordEvent(JSON.stringify({ version: 1, type: 1, event: {} })).kind === "ack", "an event with no type is acked");
}

{
  const d = classifyDiscordEvent(authorized());
  ok(d.kind === "audit", "APPLICATION_AUTHORIZED is audited");
  if (d.kind !== "audit") process.exit(1);
  ok(d.action === "surface.app_installed", "install takes the cross-platform surface.app_installed action");
  ok(d.workspace === GUILD, "the GUILD is the workspace (the org boundary, matching bindDiscord)");
  ok(d.principalId === USER, "the authorizing user is the principal");
  ok(Array.isArray(d.detail["scopes"]) && (d.detail["scopes"] as string[]).includes("bot"), "the granted scope NAMES ride in the detail (the grant's shape)");
  ok(d.detail["integrationType"] === 0, "integration_type 0 (guild install) is recorded");
  ok(d.detail["guildId"] === GUILD, "the guild id is recorded in the detail too");
  ok(d.detail["eventTimestamp"] === "2026-07-25T10:00:00.000000+00:00", "Discord's own event timestamp is preserved (deliveries are not ordering-guaranteed)");
}

{
  const body = JSON.stringify({
    version: 1,
    type: 1,
    event: { type: "APPLICATION_AUTHORIZED", data: { integration_type: 1, user: { id: USER }, scopes: ["applications.commands"] } },
  });
  const d = classifyDiscordEvent(body);
  if (d.kind !== "audit") process.exit(1);
  ok(d.workspace === "user-install", "a USER install (integration_type 1) partitions under the honest `user-install` sentinel, never a fabricated guild id");
  ok(d.detail["guildId"] === undefined, "a user install records no guild id");
}

{
  const d = classifyDiscordEvent(deauthorized());
  if (d.kind !== "audit") process.exit(1);
  ok(d.action === "surface.app_uninstalled", "uninstall takes surface.app_uninstalled");
  ok(d.principalId === USER, "the deauthorizing user is the principal");
  ok(d.workspace === "unknown", "a guild-install uninstall has no guild in the payload ⇒ workspace `unknown` (the paired install row names it)");
  ok(d.detail["scopes"] === undefined, "no scopes are invented for an uninstall");
}

const args = {} as RouteHandlerArgs;
{
  const handler = buildDiscordEventsHandler({ publicKey: PUBLIC_KEY_HEX, now: () => NOW_MS, audit: async () => {} });
  const body = authorized();

  const missing = await handler(new Request("https://x/e", { method: "POST", body }), args);
  ok(missing.status === 401, "no signature headers → 401 (fail closed)");

  const wrong = await handler(
    new Request("https://x/e", { method: "POST", body, headers: new Headers({ "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": TS }) }),
    args,
  );
  ok(wrong.status === 401, "a bad signature → 401");

  const tampered = await handler(new Request("https://x/e", { method: "POST", body: authorized({ tampered: true }), headers: signed(body) }), args);
  ok(tampered.status === 401, "a signature over a DIFFERENT body → 401 (the raw bytes are what's signed)");

  const stale = await handler(new Request("https://x/e", { method: "POST", body, headers: signed(body, String(Math.floor(NOW_MS / 1000) - 3600)) }), args);
  ok(stale.status === 401, "a stale timestamp → 401 (the skew window is enforced)");
}

{
  const rows: { action: string; workspace: string; principalId?: string }[] = [];
  const handler = buildDiscordEventsHandler({
    publicKey: PUBLIC_KEY_HEX,
    now: () => NOW_MS,
    audit: async (row) => void rows.push({ action: row.action, workspace: row.workspace, ...(row.principalId ? { principalId: row.principalId } : {}) }),
  });

  const ping = JSON.stringify({ version: 1, application_id: "app-1", type: 0 });
  const pong = await handler(new Request("https://x/e", { method: "POST", body: ping, headers: signed(ping) }), args);
  ok(pong.status === 204 && (await pong.text()) === "", "a verified PING answers 204 with an EMPTY body (Discord's endpoint-verification contract)");
  ok(rows.length === 0, "a PING writes no audit row");

  const body = authorized();
  const res = await handler(new Request("https://x/e", { method: "POST", body, headers: signed(body) }), args);
  ok(res.status === 204 && (await res.text()) === "", "a verified install answers 204 with an empty body");
  ok(rows.length === 1 && rows[0]!.action === "surface.app_installed" && rows[0]!.workspace === GUILD, "the install wrote exactly one surface.app_installed row on the guild");

  const off = deauthorized();
  await handler(new Request("https://x/e", { method: "POST", body: off, headers: signed(off) }), args);
  ok(rows.length === 2 && rows[1]!.action === "surface.app_uninstalled", "the uninstall wrote exactly one surface.app_uninstalled row");
}

{
  const handler = buildDiscordEventsHandler({
    publicKey: PUBLIC_KEY_HEX,
    now: () => NOW_MS,
    audit: async () => {
      throw new Error("store down");
    },
  });
  const body = authorized();
  const res = await handler(new Request("https://x/e", { method: "POST", body, headers: signed(body) }), args);
  ok(res.status === 204, "a failed audit write still acks 204 — a non-2xx makes Discord retry, then SUSPEND the endpoint");
}

{
  const { PUBLIC_DISCORD_ROUTE } = await import("@open-everywhere/provider-discord/agent/channels/discord-front.js");
  ok((PUBLIC_DISCORD_EVENTS_ROUTE as string) !== (PUBLIC_DISCORD_ROUTE as string), "Webhook Events sit on their OWN url (the developer portal configures the two separately)");
  const channel = (await import("@open-everywhere/provider-discord/agent/channels/discord.js")).default as unknown as { routes: { path: string; method?: string }[] };
  ok(channel.routes.some((r) => r.path === PUBLIC_DISCORD_EVENTS_ROUTE), "the events route is mounted on the discord channel");
  ok(channel.routes.some((r) => r.path === PUBLIC_DISCORD_ROUTE), "mounting it left the interactions front route intact (additive, never a replacement)");
}

console.log(`\n✓ discord-events: ${passed} assertions passed`);
