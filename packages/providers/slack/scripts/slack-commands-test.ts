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
    const { slashInvokerDmTrust, slashRoomVerdict, bindSlashCommand } = await import("../agent/channels/slack-commands.js");
    const { registerConfig, getConfig, defineDomain } = await import("@open-everywhere/core/agent/adapter-api.js");
    let prevConfig: ReturnType<typeof getConfig> | undefined;
    try {
      prevConfig = getConfig();
    } catch {
      prevConfig = undefined;
    }
    const USERS: Record<string, Record<string, unknown>> = {
      UGUEST: { id: "UGUEST", team_id: "T1", is_restricted: true },
      UMEMBER: { id: "UMEMBER", team_id: "T1" },
    };
    const ROOMS: Record<string, Record<string, unknown>> = {
      CINTERNAL: { id: "CINTERNAL", is_channel: true, is_private: false, is_ext_shared: false },
      CEXTERNAL: { id: "CEXTERNAL", is_channel: true, is_private: false, is_ext_shared: true },
      GPRIVATE: { id: "GPRIVATE", is_channel: true, is_private: true, is_ext_shared: false },
      CGROUPDM: { id: "CGROUPDM", is_mpim: true, is_private: true, is_ext_shared: false },
    };
    let roomReads = 0;
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    let probes = 0;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.endsWith("/users.info")) {
        probes++;
        const user = new URLSearchParams(String(init?.body ?? "")).get("user") ?? "";
        return json(USERS[user] ? { ok: true, user: USERS[user] } : { ok: false, error: "user_not_found" });
      }
      if (href.endsWith("/conversations.info")) {
        roomReads++;
        const channel = new URLSearchParams(String(init?.body ?? "")).get("channel") ?? "";
        return json(ROOMS[channel] ? { ok: true, channel: ROOMS[channel] } : { ok: true });
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

        const readsBefore = roomReads;
        const room = await signed("command=%2Foe&text=watch+more&team_id=T1&channel_id=C1&user_id=UMEMBER");
        ok(room.text.startsWith("I could not confirm that this room and you are inside the organisation") && room.text.includes("in your direct message"), `a channel Slack gives no verdict for stays refused, and the answer names the room and the DM door (got "${room.text.slice(0, 100)}")`);
        ok(roomReads === readsBefore + 1, "a channel command reads the room's conversations.info");

        const memberOff = await signed("command=%2Foe&text=suggest+off&team_id=T1&channel_id=CINTERNAL&user_id=UMEMBER");
        ok(memberOff.text.startsWith("Done. I won't suggest routines here."), `the stop lands in the internal channel (got "${memberOff.text.slice(0, 100)}")`);
        const memberOn = await signed("command=%2Foe&text=suggest+on&team_id=T1&channel_id=CINTERNAL&user_id=UMEMBER");
        ok(memberOn.text.startsWith("Done. I may suggest a routine here again."), `🔴 a member's /oe suggest on in an internal channel lifts the stop (got "${memberOn.text.slice(0, 100)}")`);
        const memberWatch = await signed("command=%2Foe&text=watch+less&team_id=T1&channel_id=CINTERNAL&user_id=UMEMBER");
        ok(memberWatch.text.startsWith("Done. Less:"), `🔴 a member's /oe watch less in an internal channel binds (got "${memberWatch.text.slice(0, 100)}")`);
        await signed("command=%2Foe&text=suggest+off&team_id=T1&channel_id=GPRIVATE&user_id=UMEMBER");
        const privateOn = await signed("command=%2Foe&text=suggest+on&team_id=T1&channel_id=GPRIVATE&user_id=UMEMBER");
        ok(privateOn.text.startsWith("Done. I may suggest a routine here again."), `a member's /oe suggest on in an internal private channel lifts the stop too (got "${privateOn.text.slice(0, 100)}")`);
        const externalOn = await signed("command=%2Foe&text=suggest+on&team_id=T1&channel_id=CEXTERNAL&user_id=UMEMBER");
        ok(externalOn.text.startsWith("Only a member"), `🔴 a Slack Connect room stays refused, even for a member and under a workspace vouch (got "${externalOn.text.slice(0, 100)}")`);
        const guestOn = await signed("command=%2Foe&text=suggest+on&team_id=T1&channel_id=CINTERNAL&user_id=UGUEST");
        ok(guestOn.text.startsWith("Only a member"), `🔴 a guest's /oe suggest on in an internal channel is refused (got "${guestOn.text.slice(0, 100)}")`);
        const groupOn = await signed("command=%2Foe&text=suggest+on&team_id=T1&channel_id=CGROUPDM&user_id=UMEMBER");
        ok(groupOn.text.startsWith("Only a member"), `a group DM's verdict is not stamped: its command stays fail-closed external (got "${groupOn.text.slice(0, 100)}")`);
        const unknownOn = await signed("command=%2Foe&text=suggest+on&team_id=T1&channel_id=CINTERNAL&user_id=UNOBODY");
        ok(unknownOn.text.startsWith("Only a member"), `🔴 a person users.info cannot check is not admitted on the room's verdict (got "${unknownOn.text.slice(0, 100)}")`);
        const guestWatch = await signed("command=%2Foe&text=watch+more&team_id=T1&channel_id=CINTERNAL&user_id=UGUEST");
        ok(guestWatch.text.startsWith("I could not confirm that this room and you are inside the organisation"), `🔴 a guest's /oe watch more in an internal channel binds nothing (got "${guestWatch.text.slice(0, 100)}")`);
        ok((await readAudit({ org: "default", action: "personal_watch.dial.set", principalId: "slack/T1/UGUEST" })).length === 0, "🔴 …and the guest still has no dial.set row");

        registerConfig({
          loadBundles: () => [],
          loadBindings: () => [],
          pluginRegistry: {},
          skillContent: {},
          loadDomains: () => [defineDomain({ name: "outside", match: "public" })],
          loadSilos: () => [],
          domainsForSurface: () => [],
          loadSpendBudgets: () => ({ default: { surfaceMonthlyUsd: 50 }, perDomain: { outside: { surfaceMonthlyUsd: 3 } } }),
        });
        const memberBudget = await signed("command=%2Foe&text=budget&team_id=T1&channel_id=CINTERNAL&user_id=UMEMBER");
        ok(memberBudget.text.includes("$50") && !memberBudget.text.includes("$3"), `🔴 a member's /oe budget in an internal channel shows the internal domain's cap, not the external domain's (got "${memberBudget.text.slice(0, 160)}")`);
        const guestBudget = await signed("command=%2Foe&text=budget&team_id=T1&channel_id=CINTERNAL&user_id=UGUEST");
        ok(guestBudget.status === 200 && guestBudget.text === "This channel's budget is for members of this organisation, so I can't show it to you.", `🔴 a guest's /oe budget in an internal channel is refused in one line (got "${guestBudget.text.slice(0, 160)}")`);
        ok(!guestBudget.text.includes("$") && !/\d/.test(guestBudget.text) && !guestBudget.text.includes("UGUEST") && !guestBudget.text.includes("CINTERNAL"), "🔴 …and the refusal carries no figure and no id");
        const unknownRefused = await signed("command=%2Foe&text=budget&team_id=T1&channel_id=CINTERNAL&user_id=UNOBODY");
        ok(unknownRefused.text === guestBudget.text, `🔴 a person users.info cannot check is refused the same way (got "${unknownRefused.text.slice(0, 160)}")`);
        const guestStatusAlias = await signed("command=%2Foe&text=budget+status&team_id=T1&channel_id=CINTERNAL&user_id=UGUEST");
        ok(guestStatusAlias.text === guestBudget.text, "…and so is the long form, /oe budget status");
        const guestDmBudget = await signed("command=%2Foe&text=budget&team_id=T1&channel_id=DGUEST&user_id=UGUEST");
        ok(guestDmBudget.text.startsWith("*Spending this month*"), `a guest's /oe budget in their own DM still answers: the ruling covers a channel (got "${guestDmBudget.text.slice(0, 100)}")`);
        const externalBudget = await signed("command=%2Foe&text=budget&team_id=T1&channel_id=CEXTERNAL&user_id=UMEMBER");
        ok(externalBudget.text.includes("$3") && !externalBudget.text.includes("$50"), `a member's /oe budget in a Slack Connect room still shows the external domain's cap (got "${externalBudget.text.slice(0, 160)}")`);
        const unknownBudget = await signed("command=%2Foe&text=budget&team_id=T1&channel_id=C1&user_id=UMEMBER");
        ok(unknownBudget.text.includes("$3"), `a room Slack gives no verdict for fails closed to the external domain's cap (got "${unknownBudget.text.slice(0, 160)}")`);
        const guestOnAgain = await signed("command=%2Foe&text=suggest+on&team_id=T1&channel_id=CINTERNAL&user_id=UGUEST");
        ok(guestOnAgain.text.startsWith("Only a member"), `🔴 the guest's /oe suggest on in that channel is still refused (got "${guestOnAgain.text.slice(0, 100)}")`);
        const guestWatchAgain = await signed("command=%2Foe&text=watch+less&team_id=T1&channel_id=CINTERNAL&user_id=UGUEST");
        ok(guestWatchAgain.text.startsWith("I could not confirm that this room and you are inside the organisation"), `🔴 the guest's /oe watch less in that channel is still refused (got "${guestWatchAgain.text.slice(0, 100)}")`);
        const guestCover = await signed("command=%2Foe&text=cover+on&team_id=T1&channel_id=DGUEST&user_id=UGUEST");
        ok(guestCover.text === "Cover is for members of this organisation, so I changed nothing.", `🔴 the guest's /oe cover on in their DM is still refused (got "${guestCover.text.slice(0, 100)}")`);
        ok((await readAudit({ org: "default", action: "personal_watch.dial.set", principalId: "slack/T1/UGUEST" })).length === 0, "🔴 …and the guest still has no dial.set row");
      });
      const guestInRoom = bindSlashCommand(new URLSearchParams("team_id=T1&channel_id=CX&user_id=UGUEST"), { room: { extShared: false } });
      ok(guestInRoom.trust === "external" && guestInRoom.roomTrust === "internal", "🔴 a guest in an internal room: person trust external, room trust internal");
      const memberInRoom = bindSlashCommand(new URLSearchParams("team_id=T1&channel_id=CX&user_id=UMEMBER"), { room: { extShared: false }, invokerMember: true });
      ok(memberInRoom.trust === "internal" && memberInRoom.roomTrust === "internal", "a confirmed member in an internal room: both legs internal");
      const memberInShared = bindSlashCommand(new URLSearchParams("team_id=T1&channel_id=CX&user_id=UMEMBER"), { room: { extShared: true }, invokerMember: true });
      ok(memberInShared.trust === "external" && memberInShared.roomTrust === "external", "a member in a Slack Connect room: both legs external");
      const noVerdict = bindSlashCommand(new URLSearchParams("team_id=T1&channel_id=CX&user_id=UMEMBER"), { invokerMember: true });
      ok(noVerdict.trust === "external" && noVerdict.roomTrust === "external", "no room verdict: both legs fail closed external");
      const roomParams = (channel: string, user = "UX") => new URLSearchParams(`team_id=T1&channel_id=${channel}&user_id=${user}`);
      const internalRoom = async () => ({ channelType: "channel", extShared: false, trustChecked: true });
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), internalRoom, async () => true)) === '{"room":{"extShared":false},"invokerMember":true}', "an internal room with a confirmed member gives the room and the member");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), internalRoom, async () => undefined)) === '{"room":{"extShared":false}}', "🔴 an unanswered invoker probe confirms no member: the person leg fails closed, the room leg keeps the room");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), internalRoom, () => new Promise(() => undefined))) === '{"room":{"extShared":false}}', "an invoker probe slower than the ack budget confirms no member either");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), async () => ({ channelType: "channel", extShared: true, trustChecked: true }), async () => true)) === '{"room":{"extShared":true},"invokerMember":true}', "an external room gives its external verdict");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), internalRoom, async () => false)) === '{"room":{"extShared":false}}', "a refuted invoker confirms no member");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), async () => ({}), async () => true)) === "{}", "an unchecked room stamps nothing");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), async () => ({ channelType: "mpim", extShared: false, trustChecked: true }), async () => true)) === "{}", "a group DM stamps nothing: its binding is unchanged");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), () => new Promise(() => undefined), async () => true)) === "{}", "a room read slower than the ack budget stamps nothing");
      ok(JSON.stringify(await slashRoomVerdict(roomParams("CX"), () => Promise.reject(new Error("boom")), async () => true)) === "{}", "a throwing room read stamps nothing");
      let asked = 0;
      ok(JSON.stringify(await slashRoomVerdict(roomParams("DX"), async () => (asked++, internalRoom()), async () => true)) === "{}" && asked === 0, "a 1:1 DM reads no room: its invoker leg answers there");
      const dmParams = new URLSearchParams("team_id=T1&channel_id=DX&user_id=UX");
      ok(JSON.stringify(await slashInvokerDmTrust(dmParams, async () => undefined)) === "{}", "an unanswered probe stamps nothing");
      ok(JSON.stringify(await slashInvokerDmTrust(dmParams, () => new Promise<boolean | undefined>(() => undefined))) === "{}", "a probe slower than the ack budget stamps nothing");
      ok(JSON.stringify(await slashInvokerDmTrust(dmParams, () => Promise.reject(new Error("boom")))) === "{}", "a throwing probe stamps nothing");
      ok((await slashInvokerDmTrust(dmParams, async () => false)).dmPartnerTrust === "external", "a guest verdict stamps external");
      ok((await slashInvokerDmTrust(dmParams, async () => true)).dmPartnerTrust === "internal", "a member verdict stamps internal");
    } finally {
      registerConfig(prevConfig ?? { loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [], loadSpendBudgets: () => ({}) });
      _resetSurfacesForTest();
      _resetAuthorMemberCache();
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    }
  }

  if (prevSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = prevSecret;
}

console.log(`\n✓ slack-commands: ${n} assertions passed (mount path + signature gate matrix + signed /oe responses + the DM invoker verdict + the channel room verdict)`);
