import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surfaceKeySegment, _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { removeTempDir } from "./_temp-dir.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const dir = join(tmpdir(), `open-everywhere-teams-declared-target-${process.pid}`);
await removeTempDir(dir);
_setDeploymentIdentityForTest({ org: "acme" });
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const SERVICE_URL = "https://smba.trafficmanager.net/uk/";
const TENANT = "tenant-one";
const RAW_CHANNEL_CONV = "19:engRoom@thread.tacv2;messageid=100000001";
const RAW_CHANNEL_GRAIN = "19:engRoom@thread.tacv2";
const KEY_CHANNEL_GRAIN = surfaceKeySegment(RAW_CHANNEL_GRAIN);
const RAW_PERSON = "29:1hazelBotFrameworkPersonId";
const KEY_PERSON = surfaceKeySegment(RAW_PERSON);
const RAW_PERSONAL_CONV = "a:1hazelPersonalChat";
const RAW_GROUP_CONV = "19:abcGroupChat@thread.v2";

const { recordTeamsConversationReference } = await import("../agent/channels/teams-conversation-ref.js");
const { resolveTeamsDeclaredTarget } = await import("../agent/channels/teams-declared-target.js");
const { resolveTeamsTarget } = await import("../agent/register.js");

try {
  {
    const room = await resolveTeamsDeclaredTarget({ kind: "room", platform: "teams", workspace: TENANT, surface: KEY_CHANNEL_GRAIN });
    ok(!room.ok && room.reason.includes("no captured Teams conversation reference") && room.reason.includes("@mention it once"), "uncaptured room: refuses, and names the fix");
    const person = await resolveTeamsDeclaredTarget({ kind: "person", platform: "teams", principalId: RAW_PERSON });
    ok(!person.ok && person.reason.includes("no captured Teams 1:1 chat") && person.reason.includes("one direct message"), "uncaptured person: refuses, and names the fix");
  }

  await recordTeamsConversationReference({ scope: "channel", tenantId: TENANT, conversationId: RAW_CHANNEL_CONV, serviceUrl: SERVICE_URL, userId: RAW_PERSON, teamId: "TEAM_A" });
  await recordTeamsConversationReference({ scope: "personal", tenantId: TENANT, conversationId: RAW_PERSONAL_CONV, serviceUrl: SERVICE_URL, userId: RAW_PERSON });
  await recordTeamsConversationReference({ scope: "groupChat", tenantId: TENANT, conversationId: RAW_GROUP_CONV, serviceUrl: SERVICE_URL, userId: RAW_PERSON });

  {
    const room = await resolveTeamsDeclaredTarget({ kind: "room", platform: "teams", workspace: TENANT, surface: KEY_CHANNEL_GRAIN });
    ok(room.ok, `room: resolves once the bot heard from the channel (got ${JSON.stringify(room)})`);
    if (!room.ok) throw new Error("unreachable");
    ok(room.facts.target?.["conversationId"] === RAW_CHANNEL_GRAIN, "room: the spelling restores to the RAW channel-grain id the Bot Framework accepts");
    ok(room.facts.target?.["serviceUrl"] === SERVICE_URL, "room: the captured regional serviceUrl rides the target");
    ok(room.facts.surfaceKey === `teams/${TENANT}/${KEY_CHANNEL_GRAIN}`, "room: the surface key is the spelling bindTeams derives");
    const dest = resolveTeamsTarget(room.facts as never);
    ok(dest !== null && dest.mode === "channel", "room: the routine resolver turns the facts into a CHANNEL dispatch target");

    const wrongTenant = await resolveTeamsDeclaredTarget({ kind: "room", platform: "teams", workspace: "tenant-two", surface: KEY_CHANNEL_GRAIN });
    ok(!wrongTenant.ok && wrongTenant.reason.includes(`belongs to Teams tenant ${TENANT}, not tenant-two`), "🔴 room: a target naming ANOTHER tenant is refused, never posted across tenants");
  }

  {
    const personalAsRoom = await resolveTeamsDeclaredTarget({ kind: "room", platform: "teams", workspace: TENANT, surface: surfaceKeySegment(RAW_PERSONAL_CONV) });
    ok(!personalAsRoom.ok && personalAsRoom.reason.includes("dm:teams/<29: id>"), "🔴 room: a 1:1 chat named as a ROOM refuses and names the dm: form — it never fires as a channel");
    const group = await resolveTeamsDeclaredTarget({ kind: "room", platform: "teams", workspace: TENANT, surface: surfaceKeySegment(RAW_GROUP_CONV) });
    ok(group.ok, `room: a group chat resolves (got ${JSON.stringify(group)})`);
    if (!group.ok) throw new Error("unreachable");
    const dest = resolveTeamsTarget(group.facts as never);
    ok(dest !== null && dest.mode === "mpim", "🔴 room: a group chat binds as mpim — the DM family, with the standing grain — never as a channel");
  }

  for (const id of [RAW_PERSON, KEY_PERSON]) {
    const person = await resolveTeamsDeclaredTarget({ kind: "person", platform: "teams", principalId: id });
    ok(person.ok, `person (${id}): resolves to the captured 1:1 chat (got ${JSON.stringify(person)})`);
    if (!person.ok) throw new Error("unreachable");
    ok(person.facts.target?.["conversationId"] === RAW_PERSONAL_CONV, `person (${id}): the target is the PERSONAL chat, never the channel the person also spoke in`);
    const dest = resolveTeamsTarget(person.facts as never);
    ok(dest !== null && dest.mode === "dm", `person (${id}): the routine resolver binds it as a DM`);
  }
} finally {
  await removeTempDir(dir);
}
console.log(`✓ teams-declared-target: ${n} assertions passed`);
