process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerSlackProvider } from "../agent/register.js";
import { buildFrontHandler, classifyEnvelope, ThreadFifo } from "../agent/channels/slack-front.js";
import { parseMessageEvent, renderWakeMessage } from "../agent/channels/slack-events.js";
import { parseSlackAppContext, sidePanelViewedRoom, slackDmSystemNote, SLACK_CHANNEL_ENTITY_TYPE } from "../agent/channels/slack-side-panel.js";
import { readAudit, PERSON_OPT_OUT_SHORTCUT_NOTICE, PERSON_OPT_OUT_UNREADABLE_NOTICE, type PersonOptOutState, type WakeMessageInput } from "@open-everywhere/core/agent/adapter-api.js";

registerSlackProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

const SECRET = "side-panel-secret";
const NOW_MS = 1_700_000_000_000;
const TEAM = "T1";
const ALICE = "U_ALICE";
const BOB = "U_BOB";
const DM = "D_ALICE";
const VIEWED = "CPLATFORM";
const SURFACE = `slack/${TEAM}/${DM}`;
const SEAT_TOKEN = `oe-dom:oe-dm/${SURFACE}:oe-sup:g1-abc`;

const channelEntity = (value: string, teamId = TEAM) => ({ type: SLACK_CHANNEL_ENTITY_TYPE, value, team_id: teamId });

{
  eq(parseSlackAppContext({ app_context: { entities: [channelEntity(VIEWED)] } }), { channelId: VIEWED, teamId: TEAM }, "parse: a channel entity is the viewed room");
  eq(
    parseSlackAppContext({ app_context: { entities: [{ type: "slack#/types/canvas_id", value: "F1" }, channelEntity("GPRIVATE")] } }),
    { channelId: "GPRIVATE", teamId: TEAM },
    "parse: the first CHANNEL entity wins over a non-channel one before it",
  );
  eq(parseSlackAppContext({ app_context: { entities: [channelEntity("D_SOMEONE")] } }), undefined, "parse: a DM id is not a room the panel adds");
  eq(parseSlackAppContext({ app_context: { entities: [channelEntity("C<!here>")] } }), undefined, "parse: a value that is not an id shape is refused — nothing unchecked reaches the note");
  eq(parseSlackAppContext({ app_context: {} }), undefined, "parse: an empty context is no room");
  eq(parseSlackAppContext({}), undefined, "parse: no context is no room");
  eq(parseSlackAppContext({ app_context: "C1" }), undefined, "parse: a malformed context is no room");
  const ev = parseMessageEvent({
    type: "event_callback",
    team_id: TEAM,
    event: { type: "message", channel_type: "im", channel: DM, user: ALICE, ts: "1.1", text: "hi", app_context: { entities: [channelEntity(VIEWED)] } },
  } as never);
  eq(ev?.appContext, { channelId: VIEWED, teamId: TEAM }, "parse: parseMessageEvent carries the room on a side-panel message.im");
  const plain = parseMessageEvent({ type: "event_callback", team_id: TEAM, event: { type: "message", channel_type: "im", channel: DM, user: ALICE, ts: "1.2", text: "hi" } } as never);
  ok(plain !== null && !("appContext" in plain), "parse: …and an ordinary DM carries no key at all");
}

{
  const internal = async (id: string) => id === VIEWED;
  const room = { channelId: VIEWED, teamId: TEAM };
  eq(await sidePanelViewedRoom({ room, teamId: TEAM, partnerTrust: "internal", channelInternal: internal }), VIEWED, "gate: a member viewing an internal room of this workspace passes it");
  eq(await sidePanelViewedRoom({ room, teamId: TEAM, partnerTrust: "external", channelInternal: internal }), undefined, "gate: 🔴 a GUEST passes nothing");
  eq(await sidePanelViewedRoom({ room, teamId: TEAM, partnerTrust: undefined, channelInternal: internal }), undefined, "gate: an unresolved person passes nothing (fail-closed)");
  eq(await sidePanelViewedRoom({ room: { channelId: VIEWED, teamId: "T_OTHER" }, teamId: TEAM, partnerTrust: "internal", channelInternal: internal }), undefined, "gate: another workspace's room passes nothing");
  eq(await sidePanelViewedRoom({ room: { channelId: VIEWED }, teamId: TEAM, partnerTrust: "internal", channelInternal: internal }), undefined, "gate: a room with no team passes nothing");
  eq(await sidePanelViewedRoom({ room: { channelId: "CCONNECT", teamId: TEAM }, teamId: TEAM, partnerTrust: "internal", channelInternal: internal }), undefined, "gate: 🔴 a room Slack does not confirm internal (Slack Connect) passes nothing");
  eq(
    await sidePanelViewedRoom({ room, teamId: TEAM, partnerTrust: "internal", channelInternal: async () => Promise.reject(new Error("conversations.info down")) }),
    undefined,
    "gate: a failed lookup passes nothing (fail-closed, never throws)",
  );
}

{
  const viewing = slackDmSystemNote({ viewedRoom: VIEWED })!;
  ok(viewing.includes(VIEWED) && viewing.includes(`<#${VIEWED}>`), "note: names the room and its Slack link");
  ok(viewing.includes("context only") && viewing.includes("none of that room's access"), "note: 🔴 says the room is CONTEXT, never access");
  const opted = slackDmSystemNote({ personOptOut: { optedOut: true, readable: true } })!;
  ok(opted.includes("opted out") && opted.includes("Do not promise to remember"), "note: the opt-out line tells the seat not to promise memory");
  eq(slackDmSystemNote({}), undefined, "note: nothing to say ⇒ no note");
  eq(slackDmSystemNote({ personOptOut: { optedOut: false, readable: true } }), undefined, "note: not opted out ⇒ no note");
  const ev = parseMessageEvent({ type: "event_callback", team_id: TEAM, event: { type: "message", channel_type: "im", channel: DM, user: ALICE, ts: "1.3", text: "hello" } } as never)!;
  const rendered = renderWakeMessage(ev, () => "2026-05-17T11:54:00.000Z", { dm: true, trust: "peer", systemNote: viewing });
  ok(rendered.includes("<system-note>") && rendered.includes(`viewing the room ${VIEWED}`), "note: the DM wake renders it as a trusted <system-note>");
  ok(rendered.includes("&lt;#CPLATFORM&gt;"), "note: …escaped inside the skeleton, so it cannot break the envelope");
  ok(!renderWakeMessage(ev, () => "2026-05-17T11:54:00.000Z", { dm: true, trust: "peer" }).includes("<system-note>"), "note: a wake with none renders byte-free of the element");
}

{
  const c = classifyEnvelope(JSON.stringify({ type: "event_callback", team_id: TEAM, event: { type: "app_context_changed", context: { entities: [channelEntity(VIEWED)] } } }), "application/json");
  eq(c.kind, "context-change", "classify: app_context_changed is ours");
  const messagesTab = classifyEnvelope(JSON.stringify({ type: "event_callback", team_id: TEAM, event: { type: "app_home_opened", tab: "messages", user: ALICE } }), "application/json");
  eq(messagesTab.kind, "forward", "classify: opening the Messages tab (the panel) still publishes nothing");
}

interface Dispatched {
  target: { token: string; surfaceKey: string };
  message: string;
  auth: { attributes?: Record<string, unknown> };
}

function mkReq(body: string, contentType: string): Request {
  const ts = String(Math.floor(NOW_MS / 1000));
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

async function runFront(
  body: string,
  contentType: string,
  opts: {
    partnerTrust?: "internal" | "external";
    internalRooms?: readonly string[];
    optedOut?: (principalId: string) => PersonOptOutState;
  } = {},
) {
  const dispatched: Dispatched[] = [];
  const waits: Array<Promise<unknown>> = [];
  const notices: Array<{ userId: string; text: string }> = [];
  const optOutReads: string[] = [];
  const fifo = new ThreadFifo(() => {});
  const fakeArgs = {
    from: () => ({ send: async () => ({}) }),
    to: (_channel: unknown, target: Dispatched["target"]) => ({
      send: async (message: string, sendOpts: { auth: Dispatched["auth"] }) => {
        dispatched.push({ target, message, auth: sendOpts.auth });
        return {};
      },
    }),
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
  };
  const internalRooms = opts.internalRooms ?? [VIEWED];
  const handler = buildFrontHandler(async () => new Response("inner"), {
    signingSecret: SECRET,
    now: () => NOW_MS,
    markEventSeen: async () => true,
    getBotIdentity: async () => ({ userId: "UBOT", botId: "B_OE_SELF" }),
    fifo,
    ambientEnabledFor: () => true,
    dmPartnerTrustFor: async () => opts.partnerTrust,
    channelFactsFor: async (id: string) =>
      id === DM ? { internal: true, channelType: "im", appCanRead: true } : { internal: internalRooms.includes(id), channelType: "channel", appCanRead: true },
    authorFactsFor: async (internal: boolean) => ({ surfaceInternal: internal, refuted: false }),
    openDirectMessageChannel: async () => DM,
    resolveDmSeat: async () => ({ token: SEAT_TOKEN, generation: 1, freshGeneration: false, tail: [] as readonly WakeMessageInput[] }) as never,
    touchDmSeatFn: async () => {},
    personOptOutFor: async (_org: string, principalId: string) => {
      optOutReads.push(principalId);
      return opts.optedOut ? opts.optedOut(principalId) : { optedOut: false, readable: true };
    },
    postPrivateNotice: async (userId: string, text: string) => void notices.push({ userId, text }),
  });
  const res = await handler(mkReq(body, contentType), fakeArgs as unknown as Parameters<typeof handler>[1]);
  await Promise.allSettled(waits);
  await fifo.enqueue("drain", async () => {});
  await Promise.allSettled(waits);
  return { res, dispatched, notices, optOutReads };
}

let eventSeq = 0;
function dmEvent(appContext?: unknown, over: Record<string, unknown> = {}): string {
  eventSeq++;
  return JSON.stringify({
    type: "event_callback",
    event_id: `Ev${eventSeq}`,
    team_id: TEAM,
    event: { type: "message", channel_type: "im", channel: DM, user: ALICE, ts: `1772106609.${String(eventSeq).padStart(6, "0")}`, text: "what is going on here?", ...(appContext === undefined ? {} : { app_context: appContext }), ...over },
  });
}

const JSON_TYPE = "application/json";
const noteOf = (m: string): string => /<system-note>([\s\S]*?)<\/system-note>/.exec(m)?.[1] ?? "";

{
  const r = await runFront(dmEvent({ entities: [channelEntity(VIEWED)] }), JSON_TYPE, { partnerTrust: "internal" });
  eq(r.res.status, 200, "dm: Slack gets its fast ack");
  eq(r.dispatched.length, 1, "dm: one wake");
  eq(r.dispatched[0]!.target.token, SEAT_TOKEN, "dm: 🔴 it rides the person's OWN DM seat — the panel is not a new seat");
  ok(noteOf(r.dispatched[0]!.message).includes(`viewing the room ${VIEWED}`), "dm: the viewed room rides the trusted note");
  const attrs = JSON.stringify(r.dispatched[0]!.auth.attributes ?? {});
  ok(!attrs.includes(VIEWED), "dm: 🔴 …and NOTHING about it reaches the delivery auth — no room id, so no grant can key on it");
  eq(r.dispatched[0]!.auth.attributes?.channel_id, DM, "dm: the auth still names the DM alone");

  const guest = await runFront(dmEvent({ entities: [channelEntity(VIEWED)] }), JSON_TYPE, { partnerTrust: "external" });
  eq(guest.dispatched.length, 0, "dm(guest): on the shipped grain a guest's DM wakes nothing, so no room can reach the model");

  const connect = await runFront(dmEvent({ entities: [channelEntity("CCONNECT")] }), JSON_TYPE, { partnerTrust: "internal" });
  ok(!connect.dispatched[0]!.message.includes("CCONNECT"), "dm(connect): a room Slack does not confirm internal never reaches the model");

  const foreign = await runFront(dmEvent({ entities: [channelEntity(VIEWED, "T_OTHER")] }), JSON_TYPE, { partnerTrust: "internal" });
  ok(!noteOf(foreign.dispatched[0]!.message).includes(VIEWED), "dm(foreign): another workspace's room never reaches the model");

  const plain = await runFront(dmEvent(), JSON_TYPE, { partnerTrust: "internal" });
  ok(!plain.dispatched[0]!.message.includes("<system-note>"), "dm(plain): an ordinary DM carries no note");
  eq(plain.optOutReads, [ALICE], "dm(plain): the opt-out is read once, for the writer");

  const opted = await runFront(dmEvent(), JSON_TYPE, { partnerTrust: "internal", optedOut: (p) => ({ optedOut: p === ALICE, readable: true }) });
  ok(noteOf(opted.dispatched[0]!.message).includes("opted out of agent actions"), "dm(opted out): the seat is told not to promise memory");
  const unread = await runFront(dmEvent(), JSON_TYPE, { partnerTrust: "internal", optedOut: () => ({ optedOut: true, readable: false }) });
  const unreadNote = noteOf(unread.dispatched[0]!.message);
  ok(unreadNote.includes("could not be read") && unreadNote.includes("do not tell them their opt-out is on"), "dm(store down): the seat is told the setting is unreadable");
  ok(!unreadNote.includes("has opted out"), "dm(store down): 🔴 …and never that the person opted out — the guess is not their decision");
}

{
  const FORM = "application/x-www-form-urlencoded";
  let seq = 0;
  const shortcut = (presser: string, author: string, channel = VIEWED) =>
    new URLSearchParams({
      payload: JSON.stringify({
        type: "message_action",
        callback_id: "oe_message_shortcut",
        trigger_id: `trig-${++seq}`,
        team: { id: TEAM },
        user: { id: presser },
        channel: { id: channel },
        message: { type: "message", user: author, ts: `1772106610.00000${seq}`, text: "Alice's draft plan for Q4" },
      }),
    }).toString();
  const aliceOut = (p: string): PersonOptOutState => ({ optedOut: p === ALICE, readable: true });
  const refusalsBefore = (await readAudit({ org: "default", action: "person.opt_out.refused", principalId: ALICE })).length;

  const refused = await runFront(shortcut(BOB, ALICE), FORM, { partnerTrust: "internal", optedOut: aliceOut });
  eq(refused.res.status, 200, "shortcut(refused): Slack gets its fast ack");
  eq(refused.dispatched.length, 0, "shortcut(refused): 🔴 Bob's shortcut on Alice's message wakes NOTHING");
  eq(refused.notices.length, 1, "shortcut(refused): Bob is told privately");
  eq(refused.notices[0]!.userId, BOB, "shortcut(refused): …Bob, not Alice");
  eq(refused.notices[0]!.text, PERSON_OPT_OUT_SHORTCUT_NOTICE, "shortcut(refused): …with the author-asked notice");
  ok(!refused.notices[0]!.text.includes(ALICE) && !refused.notices[0]!.text.toLowerCase().includes("open everywhere"), "shortcut(refused): the notice names no person and no brand");
  const rows = await readAudit({ org: "default", action: "person.opt_out.refused", principalId: ALICE });
  eq(rows.length, refusalsBefore + 1, "shortcut(refused): one refusal row names Alice");
  eq(rows[0]?.detail?.act, "message-shortcut", "shortcut(refused): …the leg");
  eq(rows[0]?.detail?.requestedBy, BOB, "shortcut(refused): …and who asked");
  ok(!JSON.stringify(rows[0]?.detail ?? {}).includes("draft plan"), "shortcut(refused): the row never carries the message");

  const own = await runFront(shortcut(ALICE, ALICE, DM), FORM, { partnerTrust: "internal", optedOut: aliceOut });
  eq(own.dispatched.length, 1, "shortcut(own): positive control — Alice's own shortcut WAKES");
  eq(own.notices.length, 0, "shortcut(own): Alice's own shortcut on her own message is not refused");
  ok(!own.optOutReads.slice(0, -1).includes(ALICE) && own.optOutReads.length === 1, "shortcut(own): …the shortcut leg reads no author opt-out — the one read is the DM seat's note for the presser");

  const other = await runFront(shortcut(ALICE, BOB, DM), FORM, { partnerTrust: "internal", optedOut: aliceOut });
  eq(other.dispatched.length, 1, "shortcut(other): positive control — a shortcut on a message by somebody who did not opt out WAKES");
  const refusedInDm = await runFront(shortcut(BOB, ALICE, DM), FORM, { partnerTrust: "internal", optedOut: aliceOut });
  eq(refusedInDm.dispatched.length, 0, "shortcut(refused, DM): …and the same road refuses Alice's message when Bob presses it");
  eq(other.notices.length, 0, "shortcut(other): a shortcut on a message by somebody who did not opt out is not refused");
  eq(other.optOutReads[0], BOB, "shortcut(other): …the shortcut leg reads the AUTHOR's opt-out, never the presser's");

  const down = await runFront(shortcut(BOB, ALICE), FORM, { partnerTrust: "internal", optedOut: () => ({ optedOut: true, readable: false }) });
  eq(down.dispatched.length, 0, "shortcut(store down): 🔴 an unreadable store refuses (fail-closed)");
  eq(down.notices.map((x) => x.text), [PERSON_OPT_OUT_UNREADABLE_NOTICE], "shortcut(store down): 🔴 …and tells Bob a setting could not be checked, never that Alice asked");
  const downRow = (await readAudit({ org: "default", action: "person.opt_out.refused", principalId: ALICE, limit: 1 }))[0];
  eq(downRow?.detail?.storeReadable, false, "shortcut(store down): the refusal row records the guess");
}

console.log(`✓ slack-side-panel: ${n} assertions`);
