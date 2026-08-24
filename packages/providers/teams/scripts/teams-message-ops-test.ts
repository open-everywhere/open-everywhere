import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { surfaceMessageOps } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const dir = join(tmpdir(), `open-everywhere-teams-message-ops-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_ORG = "acme";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.MICROSOFT_APP_ID = "fixture-app-id-not-a-secret";
process.env.MICROSOFT_APP_PASSWORD = "fixture-app-secret-not-a-secret";

const SERVICE_URL = "https://smba.trafficmanager.net/uk/";
const ROGUE_URL = "https://evil.example/";
const TENANT = "tenant-one";

const { registerTeamsProvider } = await import("../agent/register.js");
const { teamsMessageOps } = await import("../agent/channels/teams-message-ops.js");
const { teamsAddressRowsFor, recordTeamsConversationReference } = await import("../agent/channels/teams-conversation-ref.js");

try {
  {
    registerTeamsProvider();
    const resolved = surfaceMessageOps("teams");
    ok(resolved !== undefined, "registerTeamsProvider() makes surfaceMessageOps('teams') resolve to something (OPE-899 was: it resolved undefined)");
    ok(resolved === teamsMessageOps, "…and it resolves to THIS module's ops object, by identity — the same one turn-anchor.ts's postSurfaceText dispatches to");
    ok(typeof resolved?.postText === "function" && typeof resolved?.editMessage === "function", "the resolved ops carry postText/editMessage");
    ok(resolved?.postFiles === undefined, "…and NO postFiles (Teams has no attach-a-file-to-a-message primitive)");
    ok(resolved?.setReaction === undefined, "…and NO setReaction (Teams has no reaction primitive beyond the `angry` stop trigger)");
  }

  {
    const CHANNEL_CONV = "19:team-chan@thread.tacv2;messageid=100000001";
    const addressKinds = (rows: readonly { readonly kind: string }[]): string[] =>
      rows.filter((r) => r.kind === "personal" || r.kind === "team" || r.kind === "conversation").map((r) => r.kind).sort();
    const rowsChannel = teamsAddressRowsFor({ scope: "channel", tenantId: TENANT, conversationId: CHANNEL_CONV, serviceUrl: SERVICE_URL, teamId: "TEAM_A" });
    ok(JSON.stringify(addressKinds(rowsChannel)) === JSON.stringify(["conversation", "team"]), "a channel activity writes TWO address rows — team AND conversation");
    const teamRow = rowsChannel.find((r) => r.kind === "team");
    const convRow = rowsChannel.find((r) => r.kind === "conversation");
    ok(teamRow !== undefined && convRow !== undefined, "…one of each kind");
    ok(convRow?.refKey === CHANNEL_CONV, "the conversation row keys on the EXACT id, reply-chain suffix included");
    ok(teamRow?.address["conversationId"] === "19:team-chan@thread.tacv2", "🔴 the team row strips the reply-chain suffix — the two rows name DIFFERENT addresses, on purpose");
    ok(convRow?.address["conversationId"] !== teamRow?.address["conversationId"], "…proven by inequality, not just by reading the code");

    const rowsPersonal = teamsAddressRowsFor({ scope: "personal", tenantId: TENANT, conversationId: "19:1on1@thread.v2", serviceUrl: SERVICE_URL, userId: "29:hazel" });
    ok(JSON.stringify(addressKinds(rowsPersonal)) === JSON.stringify(["conversation", "personal"]), "a personal activity writes TWO address rows — personal AND conversation");

    const rowsGroup = teamsAddressRowsFor({ scope: "groupChat", tenantId: TENANT, conversationId: "19:group@thread.v2", serviceUrl: SERVICE_URL });
    ok(JSON.stringify(addressKinds(rowsGroup)) === JSON.stringify(["conversation"]), "🔴 a group-chat activity writes EXACTLY one address row — never a personal/team row (unsupported, never faked)");

    const rowsRogue = teamsAddressRowsFor({ scope: "channel", tenantId: TENANT, conversationId: CHANNEL_CONV, serviceUrl: ROGUE_URL, teamId: "TEAM_A" });
    ok(rowsRogue.length === 0, "🔴 an UNTRUSTED serviceUrl writes NO row of any species — OPE-899 extends the double allowlist, it does not bypass it");
  }

  {
    const CONV = "19:reply-chain@thread.tacv2;messageid=42";
    await recordTeamsConversationReference({ scope: "channel", tenantId: TENANT, conversationId: CONV, serviceUrl: SERVICE_URL, teamId: "TEAM_B" });

    const sends: { url: string; method: string; body: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com") || url.includes("botframework.com/oauth")) {
        return new Response(JSON.stringify({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      sends.push({ url, method: String(init?.method ?? "POST"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ id: "activity-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const id = await teamsMessageOps.postText(CONV, "the turn was stopped");
      ok(id === "activity-1", "postText returns the Connector's created-activity id");
      const plainSend = sends.find((c) => c.url.includes("/activities") && c.method === "POST");
      ok(plainSend !== undefined, "postText POSTs a message activity");
      ok(plainSend!.url.includes(encodeURIComponent(CONV)), "…to the resolved conversation's own id — the EXACT one recorded, not a guessed one");
      ok(plainSend!.url === `${SERVICE_URL.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(CONV)}/activities`, "…at the plain send path — no reply anchor when opts carries none");
      ok(JSON.parse(plainSend!.body).text === "the turn was stopped", "…carrying the exact text");

      sends.length = 0;
      await teamsMessageOps.postText(CONV, "threaded", { replyToMessageId: "root-activity-9" });
      const reply = sends.find((c) => c.url.includes("root-activity-9"));
      ok(reply !== undefined, "🔴 opts.replyToMessageId threads onto the reply-activity endpoint, not the plain conversation one");

      sends.length = 0;
      await teamsMessageOps.editMessage(CONV, "activity-1", "edited: the turn was stopped");
      const edit = sends.find((c) => c.method === "PUT");
      ok(edit !== undefined, "editMessage PUTs the update");
      ok(edit!.url.includes("activity-1"), "…at the given activity id");
      ok(JSON.parse(edit!.body).text === "edited: the turn was stopped", "…carrying the new text");

      let refusalMsg = "";
      try {
        await teamsMessageOps.postText("19:never-seen@thread.v2", "hello");
        ok(false, "postText on an unknown conversation id must REFUSE, never silently no-op");
      } catch (e) {
        refusalMsg = String((e as Error).message);
      }
      ok(refusalMsg.includes("never-seen"), "…naming the id it could not resolve — a loud, honest refusal, never a guessed target");

      let editRefusalMsg = "";
      try {
        await teamsMessageOps.editMessage("19:never-seen@thread.v2", "activity-1", "x");
        ok(false, "editMessage on an unknown conversation id must REFUSE too");
      } catch (e) {
        editRefusalMsg = String((e as Error).message);
      }
      ok(editRefusalMsg.includes("never-seen"), "…same honest refusal");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(`✓ teams-message-ops: ${n} assertions passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
