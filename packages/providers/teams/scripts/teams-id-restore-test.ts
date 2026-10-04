import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surfaceKeySegment } from "@open-everywhere/core/agent/adapter-api.js";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { removeTempDir } from "./_temp-dir.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const dir = join(tmpdir(), `open-everywhere-teams-id-restore-${process.pid}`);
await removeTempDir(dir);
_setDeploymentIdentityForTest({ org: "acme" });
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.MICROSOFT_APP_ID = "fixture-app-id-not-a-secret";
process.env.MICROSOFT_APP_PASSWORD = "fixture-app-secret-not-a-secret";

const SERVICE_URL = "https://smba.trafficmanager.net/uk/";
const ROGUE_URL = "https://evil.example/";
const TENANT = "tenant-one";

const RAW_CHANNEL_CONV = "19:engRoom@thread.tacv2;messageid=100000001";
const KEY_CHANNEL_CONV = surfaceKeySegment(RAW_CHANNEL_CONV);
const RAW_CHANNEL_GRAIN = "19:engRoom@thread.tacv2";
const KEY_CHANNEL_GRAIN = surfaceKeySegment(RAW_CHANNEL_GRAIN);
const RAW_PERSON = "29:1hazelBotFrameworkPersonId";
const KEY_PERSON = surfaceKeySegment(RAW_PERSON);
const RAW_COLD_PERSON = "29:1rowanNeverDmedBefore";
const KEY_COLD_PERSON = surfaceKeySegment(RAW_COLD_PERSON);

const { registerTeamsProvider } = await import("../agent/register.js");
const { teamsAddressRowsFor, recordTeamsConversationReference } = await import("../agent/channels/teams-conversation-ref.js");
const { teamsMessageOps } = await import("../agent/channels/teams-message-ops.js");
const { teamsPostArm } = await import("../agent/channels/teams-post-arm.js");
const { teamsIdIndexRow, restoreTeamsConversationId, restoreTeamsPersonId, TEAMS_CONVERSATION_KEY_KIND, TEAMS_PERSON_KEY_KIND } = await import(
  "../agent/channels/teams-id-restore.js"
);

try {
  registerTeamsProvider();

  {
    ok(KEY_CHANNEL_CONV !== RAW_CHANNEL_CONV, "a Teams conversation id and its surface-key spelling are DIFFERENT strings");
    ok(KEY_PERSON !== RAW_PERSON, "…and so are a Teams person id and its spelling");
    ok(/^[A-Za-z0-9._-]+$/u.test(KEY_CHANNEL_CONV) && /^[A-Za-z0-9._-]+$/u.test(KEY_PERSON), "both spellings are inside the resource-address id charset");
    ok(surfaceKeySegment(KEY_CHANNEL_CONV) === KEY_CHANNEL_CONV, "the spelling is idempotent — spelling a spelling changes nothing");
  }

  {
    const row = teamsIdIndexRow(TEAMS_CONVERSATION_KEY_KIND, RAW_CHANNEL_CONV, TENANT, "2026-08-24T00:00:00.000Z");
    ok(row?.refKey === KEY_CHANNEL_CONV, "the index row keys on the SPELLING — the string a grant address carries");
    ok(row?.address["rawId"] === RAW_CHANNEL_CONV, "…and holds the RAW id, which is the only thing the Bot Framework accepts");
    ok(row?.address["serviceUrl"] === undefined, "…and carries NO serviceUrl: an index row is a spelling, never a reachability claim");
    ok(row?.tenant === TENANT && row?.platform === "teams", "…stamped with the tenant and the platform");

    ok(teamsIdIndexRow(TEAMS_CONVERSATION_KEY_KIND, "C0123ABC", TENANT, "t") === undefined, "an id that EQUALS its own spelling gets no row — the restore returns it unchanged anyway");
    ok(teamsIdIndexRow(TEAMS_PERSON_KEY_KIND, "@@@", TENANT, "t") === undefined, "an id that cleans to nothing gets no row — it has no spelling to key on");
  }

  {
    const channel = teamsAddressRowsFor({ scope: "channel", tenantId: TENANT, conversationId: RAW_CHANNEL_CONV, serviceUrl: SERVICE_URL, userId: RAW_PERSON, teamId: "TEAM_A" });
    const convKey = channel.find((r) => r.kind === TEAMS_CONVERSATION_KEY_KIND);
    const personKey = channel.find((r) => r.kind === TEAMS_PERSON_KEY_KIND);
    ok(convKey?.refKey === KEY_CHANNEL_CONV, "a channel activity contributes the conversation index row");
    ok(personKey?.refKey === KEY_PERSON, "🔴 a CHANNEL activity contributes the person index row too — the index is scope-agnostic");
    ok(channel.some((r) => r.kind === "personal") === false, "…while the personal ADDRESS row stays scope-selective, unchanged");

    const convKeys = channel.filter((r) => r.kind === TEAMS_CONVERSATION_KEY_KIND).map((r) => r.refKey).sort();
    ok(
      JSON.stringify(convKeys) === JSON.stringify([KEY_CHANNEL_CONV, KEY_CHANNEL_GRAIN].sort()),
      "🔴 a channel activity contributes an index row at BOTH grains — the reply chain it arrived on AND the channel a roster entry names",
    );
    ok(
      channel.find((r) => r.kind === TEAMS_CONVERSATION_KEY_KIND && r.refKey === KEY_CHANNEL_GRAIN)?.address["rawId"] === RAW_CHANNEL_GRAIN,
      "…and the channel-grain row holds the RAW channel-grain id, never the reply-chain one — a grant addresses the channel, not a thread inside it",
    );

    const personal = teamsAddressRowsFor({ scope: "personal", tenantId: TENANT, conversationId: "19:hazel1to1@thread.v2", serviceUrl: SERVICE_URL, userId: RAW_PERSON });
    ok(
      personal.filter((r) => r.kind === TEAMS_CONVERSATION_KEY_KIND).length === 1,
      "a suffix-free conversation id writes exactly ONE conversation index row — the channel-grain twin is not a duplicate of every id",
    );

    const rogue = teamsAddressRowsFor({ scope: "channel", tenantId: TENANT, conversationId: RAW_CHANNEL_CONV, serviceUrl: ROGUE_URL, userId: RAW_PERSON, teamId: "TEAM_A" });
    ok(rogue.length === 0, "🔴 an UNTRUSTED serviceUrl writes NO row of any species, index rows and both channel grains included — one gate, not two");
  }

  {
    ok((await restoreTeamsConversationId(KEY_CHANNEL_CONV)) === KEY_CHANNEL_CONV, "an unknown spelling comes back UNCHANGED — the seam never guesses a raw id");
    ok((await restoreTeamsPersonId(KEY_PERSON)) === KEY_PERSON, "…the same for a person");

    await recordTeamsConversationReference({ scope: "channel", tenantId: TENANT, conversationId: RAW_CHANNEL_CONV, serviceUrl: SERVICE_URL, userId: RAW_PERSON, teamId: "TEAM_A" });

    ok((await restoreTeamsConversationId(KEY_CHANNEL_CONV)) === RAW_CHANNEL_CONV, "🔴 the SPELLED conversation id restores to the RAW one — this is the seam");
    ok((await restoreTeamsPersonId(KEY_PERSON)) === RAW_PERSON, "🔴 the SPELLED person id restores to the RAW `29:` one");
    ok((await restoreTeamsConversationId(RAW_CHANNEL_CONV)) === RAW_CHANNEL_CONV, "an ALREADY-RAW id is returned unchanged — every pre-existing caller is untouched");
    ok((await restoreTeamsPersonId("29:1someoneWeHaveNeverSeen")) === "29:1someoneWeHaveNeverSeen", "…even one this deployment holds no row for");
    ok((await restoreTeamsConversationId("19-neverSeen-thread.tacv2")) === "19-neverSeen-thread.tacv2", "an unknown spelling STILL comes back unchanged after the store has rows");

    ok(KEY_CHANNEL_GRAIN !== KEY_CHANNEL_CONV, "the two grains really are two spellings — otherwise the assertion below would prove nothing");
    ok(
      (await restoreTeamsConversationId(KEY_CHANNEL_GRAIN)) === RAW_CHANNEL_GRAIN,
      "🔴 the CHANNEL-GRAIN spelling restores to the raw channel id — the grain a roster entry names is now one this deployment holds",
    );
  }

  const sends: { url: string; method: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com") || url.includes("botframework.com/oauth")) {
      return new Response(JSON.stringify({ access_token: "fixture-token-not-a-secret", token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    sends.push({ url, method: String(init?.method ?? "POST"), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ id: "activity-1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    {
      sends.length = 0;
      const id = await teamsMessageOps.postText(KEY_CHANNEL_CONV, "a granted post");
      ok(id === "activity-1", "postText at the ADDRESS spelling posts — a grant is deliverable");
      const send = sends.find((c) => c.url.endsWith("/activities"));
      ok(send?.url.includes(encodeURIComponent(RAW_CHANNEL_CONV)) === true, "🔴 …and the wire carried the RAW conversation id, restored from the spelling");
      ok(send?.url.includes(encodeURIComponent(KEY_CHANNEL_CONV)) === false, "…never the spelling, which the Bot Framework would refuse");

      sends.length = 0;
      const grantId = await teamsMessageOps.postText(KEY_CHANNEL_GRAIN, "a granted container post");
      ok(grantId === "activity-1", "🔴 postText at the ROSTER spelling posts — a Teams container grant is deliverable");
      const grantSend = sends.find((c) => c.url.endsWith("/activities"));
      const grantConversation = decodeURIComponent(grantSend?.url.slice(0, -"/activities".length).split("/v3/conversations/")[1] ?? "");
      ok(grantConversation === RAW_CHANNEL_GRAIN, `…and the wire carried the raw CHANNEL id (got: ${grantConversation})`);
      ok(grantConversation !== RAW_CHANNEL_CONV, "…never the reply chain the seeding activity arrived on — a container grant addresses the channel, not a thread inside it");

      sends.length = 0;
      await teamsMessageOps.editMessage(KEY_CHANNEL_CONV, "activity-1", "edited");
      const edit = sends.find((c) => c.method === "PUT");
      ok(edit?.url.includes(encodeURIComponent(RAW_CHANNEL_CONV)) === true, "editMessage restores the raw id too — the edit endpoint is the same address");

      let refusal = "";
      try {
        await teamsMessageOps.postText("19-neverSeen-thread.tacv2", "hello");
        ok(false, "postText on an unrestorable spelling must REFUSE, never silently no-op");
      } catch (e) {
        refusal = String((e as Error).message);
      }
      ok(refusal.includes("19-neverSeen-thread.tacv2"), "…naming the id the caller gave — a loud, honest refusal");
    }

    {
      await recordTeamsConversationReference({ scope: "personal", tenantId: TENANT, conversationId: "19:hazel1to1@thread.v2", serviceUrl: SERVICE_URL, userId: RAW_PERSON });
      sends.length = 0;
      const delivered = await teamsPostArm.deliverDirectMessage!({ principalId: KEY_PERSON, text: "a granted DM" });
      ok(delivered.surfaceId === "19:hazel1to1@thread.v2", "🔴 a DM at the ADDRESS spelling lands in the stored 1:1 chat");
      ok(sends.every((c) => !c.url.endsWith("/v3/conversations")), "…with no conversation create — the stored reference was found from the spelling");

      sends.length = 0;
      await recordTeamsConversationReference({ scope: "channel", tenantId: TENANT, conversationId: "19:otherRoom@thread.tacv2", serviceUrl: SERVICE_URL, userId: RAW_COLD_PERSON, teamId: "TEAM_A" });
      const cold = await teamsPostArm.deliverDirectMessage!({ principalId: KEY_COLD_PERSON, text: "a first DM" });
      const create = sends.find((c) => c.url.endsWith("/v3/conversations"));
      ok(create !== undefined, "a person with no 1:1 reference makes the arm OPEN one");
      ok(JSON.parse(create!.body).members?.[0]?.id === RAW_COLD_PERSON, "🔴 …and the members list carries the RAW `29:` id — the spelling would be refused by Microsoft");
      ok(JSON.parse(create!.body).members?.[0]?.id !== KEY_COLD_PERSON, "…proven by inequality, not just by reading the code");
      ok(cold.messageId.length > 0, "…and the first message is delivered");
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`✓ teams-id-restore: ${n} assertions passed`);
} finally {
  await removeTempDir(dir);
}
