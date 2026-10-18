process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.DATABASE_URL;

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";
import { withPatchedFetch } from "./_fetch-test-utils.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
}

{
  const { default: slackCommandsChannel } = await import("../agent/channels/slack-commands.js");
  const routeDef = (
    slackCommandsChannel as unknown as {
      routes: readonly { method: string; path: string; handler: (req: Request, args: RouteHandlerArgs) => Promise<Response> }[];
    }
  ).routes[0];
  ok(routeDef.method === "POST" && routeDef.path === "/eve/v1/slack/commands", "slack-commands mounts POST /eve/v1/slack/commands");

  const call = (req: Request) => routeDef.handler(req, {} as RouteHandlerArgs);

  function slackSignature(secret: string, timestamp: string, body: string): string {
    return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  }
  function slackRequest(body: string, opts: { timestamp?: string; signature?: string; noHeaders?: boolean } = {}): Request {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (!opts.noHeaders) {
      const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
      headers.set("x-slack-request-timestamp", timestamp);
      headers.set("x-slack-signature", opts.signature ?? "v0=0000000000000000000000000000000000000000000000000000000000000000");
    }
    return new Request("https://example.test/eve/v1/slack/commands", { method: "POST", headers, body });
  }

  const helpBody = "command=%2Foe&text=help&team_id=T1&channel_id=C1&user_id=U1";
  const secret = "test-signing-secret";

  const prevSecret = process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;

  {
    const res = await call(slackRequest(helpBody, { timestamp: String(Math.floor(Date.now() / 1000)) }));
    ok(res.status === 401, "no SLACK_SIGNING_SECRET configured -> 401 (fail-closed)");
  }

  process.env.SLACK_SIGNING_SECRET = secret;

  {
    const res = await call(slackRequest(helpBody, { noHeaders: true }));
    ok(res.status === 401, "missing signature headers -> 401");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await call(slackRequest(helpBody, { timestamp, signature: "v0=not-a-real-signature" }));
    ok(res.status === 401, "a bad signature -> 401");
  }
  {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const sig = slackSignature(secret, staleTimestamp, helpBody);
    const res = await call(slackRequest(helpBody, { timestamp: staleTimestamp, signature: sig }));
    ok(res.status === 401, "a stale (>5min) timestamp -> 401 even with a correctly-computed signature");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, helpBody);
    const tampered = helpBody.replace("help", "clear");
    const res = await call(slackRequest(tampered, { timestamp, signature: sig }));
    ok(res.status === 401, "a body tampered with after signing -> 401");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, helpBody);
    const res = await call(slackRequest(helpBody, { timestamp, signature: sig }));
    ok(res.status === 200, "a validly-signed /oe help request succeeds");
    const json = (await res.json()) as { response_type: string; text: string };
    ok(json.response_type === "ephemeral", 'response_type is "ephemeral" — only the invoker sees it');
    ok(json.text.includes("/oe help"), "the ephemeral text is the rendered help");
  }
  {
    const statusBody = "command=%2Foe&text=status&team_id=T1&channel_id=C1&user_id=U1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, statusBody);
    const res = await call(slackRequest(statusBody, { timestamp, signature: sig }));
    const json = (await res.json()) as { text: string };
    ok(json.text.includes("Open Everywhere"), "a validly-signed /oe status request answers with deploy info");
  }
  {
    const otherBody = "command=%2Fother&text=&team_id=T1&channel_id=C1&user_id=U1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, otherBody);
    const res = await call(slackRequest(otherBody, { timestamp, signature: sig }));
    ok(res.status === 200, "a differently-named slash command still gets a clean 200 (not a crash)");
    const json = (await res.json()) as { text: string };
    ok(json.text.includes("/oe"), "the response explains this endpoint only handles /oe");
  }

  {
    const { overrideSettingsForTest, resetSettingsForTest } = await import("@open-everywhere/core/agent/adapter-api.js");
    overrideSettingsForTest({ identity: { name: "Aria", commandName: "aria" } });
    try {
      const ariaBody = "command=%2Faria&text=help&team_id=T1&channel_id=C1&user_id=U1";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = await call(slackRequest(ariaBody, { timestamp, signature: slackSignature(secret, timestamp, ariaBody) }));
      const json = (await res.json()) as { text: string };
      ok(json.text.includes("/aria help") && !json.text.includes("only handles"), "🔴 configured: the route ANSWERS the configured /aria command with the help");
      const oldTs = String(Math.floor(Date.now() / 1000));
      const oldRes = await call(slackRequest(helpBody, { timestamp: oldTs, signature: slackSignature(secret, oldTs, helpBody) }));
      const oldJson = (await oldRes.json()) as { text: string };
      ok(oldJson.text.includes('only handles "/aria"'), "configured: the old /oe now gets the corrective note naming /aria");
    } finally {
      resetSettingsForTest();
    }
  }

  {
    const { registerSurfaces, defineSurface, _resetSurfacesForTest, readAudit, registerIdentityMapper } = await import("@open-everywhere/core/agent/adapter-api.js");
    const { bindSlack } = await import("../agent/channels/slack-identity.js");
    registerIdentityMapper("slack", bindSlack);
    const { _resetAuthorMemberCache } = await import("../agent/channels/slack-events.js");
    const { slashInvokerDmTrust } = await import("../agent/channels/slack-commands.js");
    const USERS: Record<string, Record<string, unknown>> = {
      UGUEST: { id: "UGUEST", team_id: "T1", is_restricted: true },
      UMEMBER: { id: "UMEMBER", team_id: "T1" },
    };
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    let probes = 0;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.endsWith("/users.info")) {
        probes++;
        const user = new URLSearchParams(String(init?.body ?? "")).get("user") ?? "";
        return json(USERS[user] ? { ok: true, user: USERS[user] } : { ok: false, error: "user_not_found" });
      }
      return json({ ok: true });
    }) as typeof fetch;
    const signed = async (body: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = await call(slackRequest(body, { timestamp, signature: slackSignature(secret, timestamp, body) }));
      return { status: res.status, text: ((await res.json()) as { text: string }).text };
    };
    const prevToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-slack-commands-test";
    registerSurfaces([defineSurface({ key: "slack/T1", trust: "internal" })]);
    _resetAuthorMemberCache();
    try {
      await withPatchedFetch(fakeFetch, async () => {
        const guest = await signed("command=%2Foe&text=watch+more&team_id=T1&channel_id=DGUEST&user_id=UGUEST");
        ok(guest.status === 200 && guest.text === "The watch is for members of this organisation, so I changed nothing.", `🔴 a guest's /oe watch more in their DM is refused in one line (got "${guest.text.slice(0, 100)}")`);
        const guestRows = await readAudit({ org: "default", action: "personal_watch.dial.refused", principalId: "slack/T1/UGUEST" });
        ok(guestRows.length === 1 && guestRows[0]!.detail?.["reason"] === "not-member" && guestRows[0]!.detail?.["via"] === "command", "🔴 …and files one personal_watch.dial.refused row, reason not-member");
        ok((await readAudit({ org: "default", action: "personal_watch.dial.set", principalId: "slack/T1/UGUEST" })).length === 0, "🔴 …and no dial.set row: nothing was bound");

        const member = await signed("command=%2Foe&text=watch+more&team_id=T1&channel_id=DMEMBER&user_id=UMEMBER");
        ok(member.text.startsWith("Done. More:"), `the legitimate member's /oe watch more in their DM still binds (got "${member.text.slice(0, 100)}")`);
        ok((await readAudit({ org: "default", action: "personal_watch.dial.set", principalId: "slack/T1/UMEMBER" })).length === 1, "…with one dial.set row");

        const before = probes;
        const room = await signed("command=%2Foe&text=watch+more&team_id=T1&channel_id=C1&user_id=UMEMBER");
        ok(room.text.startsWith("I could not confirm that this room is inside the organisation") && room.text.includes("in your direct message"), `a channel command names the room and the DM door, not the member (got "${room.text.slice(0, 100)}")`);
        ok(probes === before, "a channel command asks users.info nothing: the room's verdict is the binding's trust there");
      });
      const dmParams = new URLSearchParams("team_id=T1&channel_id=DX&user_id=UX");
      ok(JSON.stringify(await slashInvokerDmTrust(dmParams, async () => undefined)) === "{}", "an unanswered probe stamps nothing");
      ok(JSON.stringify(await slashInvokerDmTrust(dmParams, () => new Promise<boolean | undefined>(() => undefined))) === "{}", "a probe slower than the ack budget stamps nothing");
      ok(JSON.stringify(await slashInvokerDmTrust(dmParams, () => Promise.reject(new Error("boom")))) === "{}", "a throwing probe stamps nothing");
      ok((await slashInvokerDmTrust(dmParams, async () => false)).dmPartnerTrust === "external", "a guest verdict stamps external");
      ok((await slashInvokerDmTrust(dmParams, async () => true)).dmPartnerTrust === "internal", "a member verdict stamps internal");
    } finally {
      _resetSurfacesForTest();
      _resetAuthorMemberCache();
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    }
  }

  if (prevSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = prevSecret;
}


console.log(`\n✓ slack-commands: ${n} assertions passed (mount path + signature gate matrix + signed /oe responses + the DM invoker verdict)`);
