process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerSlackProvider } from "../agent/register.js";
import { buildFrontHandler, classifyEnvelope, dmFifoKey, ThreadFifo, EventDedupe } from "../agent/channels/slack-front.js";
import { supervisorFifoKey } from "../agent/channels/slack-events.js";
import { parseSlackShortcutPayload, shortcutMessageEvent, shortcutWakeKey, globalShortcutText } from "../agent/channels/slack-shortcut.js";
import { resolveSlackAttachment, _resetSlackAttachmentsForTest } from "../agent/channels/slack-attachments.js";
import { UNTRUSTED_OPEN, type WakeMessageInput } from "@open-everywhere/core/agent/adapter-api.js";

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

const SECRET = "shortcut-secret";
const NOW_MS = 1_700_000_000_000;
const TEAM = "T1";
const INVOKER = "U_INVOKER";
const AUTHOR = "U_AUTHOR";
const DM_CHANNEL = "D_INVOKER";
const PUBLIC_CHANNEL = "C_SUPPORT";
const MSG_TS = "1769912729.916000";
const TRIGGER = "13345224609.738474920.8088930838d88f008e0";
const DM_SURFACE = `slack/${TEAM}/${DM_CHANNEL}`;
const SEAT_TOKEN = `oe-dom:oe-dm/${DM_SURFACE}:oe-sup:g3-abc123`;
const UNREADABLE_CHANNEL = "C_NOT_A_MEMBER";
const FILE = { id: "F1", name: "receipt.png", mimetype: "image/png", url_private: "https://files.slack.test/F1" };

function messageShortcut(over: Record<string, unknown> = {}, msgOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message_action",
    callback_id: "oe_message_shortcut",
    trigger_id: TRIGGER,
    team: { id: TEAM },
    user: { id: INVOKER, username: "invoker" },
    channel: { id: DM_CHANNEL },
    response_url: "https://hooks.slack.test/actions/x",
    message: { type: "message", user: AUTHOR, ts: MSG_TS, text: "the refund for order 4417 never landed", ...msgOver },
    ...over,
  };
}

function globalShortcut(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "shortcut",
    callback_id: "oe_global_shortcut",
    trigger_id: TRIGGER,
    team: { id: TEAM },
    user: { id: INVOKER, username: "invoker" },
    ...over,
  };
}

function urlencoded(payload: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

const FORM = "application/x-www-form-urlencoded";

function mkReq(body: string, contentType = FORM): Request {
  const ts = String(Math.floor(NOW_MS / 1000));
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

{
  const c = (payload: Record<string, unknown>) => classifyEnvelope(urlencoded(payload), FORM);

  const msg = c(messageShortcut());
  eq(msg.kind, "shortcut", "classify: a `message_action` payload is a shortcut, not a forward");
  ok(msg.kind === "shortcut" && msg.shortcut.kind === "message", "classify: …and it decodes as the MESSAGE family");
  const glob = c(globalShortcut());
  eq(glob.kind, "shortcut", "classify: a `shortcut` payload is a shortcut, not a forward");
  ok(glob.kind === "shortcut" && glob.shortcut.kind === "global", "classify: …and it decodes as the GLOBAL family");
  ok(msg.reason.includes("never forwarded"), "classify: the reason says the front owns it (eve's onShortcut is unconfigured — a forward is a no-op)");

  eq(
    classifyEnvelope(urlencoded({ type: "block_actions", actions: [{ action_id: "eve_input:answer" }] }), FORM).kind,
    "forward",
    "classify: eve's OWN HITL block_actions click still FORWARDS — the shortcut branch did not widen",
  );
  eq(
    classifyEnvelope(urlencoded({ type: "view_submission", view: { callback_id: "eve_modal" } }), FORM).kind,
    "forward",
    "classify: eve's own view_submission still forwards",
  );
  eq(classifyEnvelope("command=%2Foe&text=status", FORM).kind, "forward", "classify: a slash command still forwards (it carries no `payload` at all)");
  eq(classifyEnvelope(urlencoded({ type: "message_action" }), FORM).kind, "forward", "classify: a message_action MISSING its ids is refused and falls to the forward default — fail-closed, never a half-built wake");
  eq(
    classifyEnvelope(JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: PUBLIC_CHANNEL, ts: MSG_TS } }), "application/json").kind,
    "mention",
    "classify: a JSON app_mention is untouched by the new branch",
  );
}

{
  const m = parseSlackShortcutPayload(messageShortcut());
  ok(m !== null, "parse: a well-formed message_action parses");
  eq(m?.kind, "message", "parse: kind is `message`");
  eq(m?.callbackId, "oe_message_shortcut", "parse: the callback id is the trigger's name");
  eq(m?.triggerId, TRIGGER, "parse: the trigger id rides through — it is the idempotency key");
  eq(m?.userId, INVOKER, "parse: `user.id` is the INVOKER");
  eq(m?.teamId, TEAM, "parse: the team id rides through");
  eq(m?.channelId, DM_CHANNEL, "parse: `channel.id` is the conversation the message lives in");
  eq(m?.message?.text, "the refund for order 4417 never landed", "parse: the target message's text is carried verbatim");
  eq(m?.message?.ts, MSG_TS, "parse: the target message's ts is carried");
  eq(m?.message?.userId, AUTHOR, "parse: 🔴 the message AUTHOR is carried SEPARATELY from the invoker — the two are never merged");
  eq(m?.message?.threadTs, undefined, "parse: no thread_ts on the payload ⇒ none on the parse (never invented)");
  eq(parseSlackShortcutPayload(messageShortcut({}, { thread_ts: "1769912660.000100" }))?.message?.threadTs, "1769912660.000100", "parse: a threaded target carries its thread root");

  const g = parseSlackShortcutPayload(globalShortcut());
  eq(g?.kind, "global", "parse: a `shortcut` payload parses as global");
  eq(g?.channelId, undefined, "parse: a global shortcut names NO channel — the field stays absent rather than defaulted");
  eq(g?.message, undefined, "parse: …and carries no message");

  eq(parseSlackShortcutPayload(messageShortcut({ callback_id: undefined })), null, "parse: no callback_id ⇒ refused (the trigger has no name)");
  eq(parseSlackShortcutPayload(messageShortcut({ trigger_id: undefined })), null, "parse: no trigger_id ⇒ refused (no idempotency key)");
  eq(parseSlackShortcutPayload(messageShortcut({ user: {} })), null, "parse: no user.id ⇒ refused (no principal — the one fact a wake may never guess)");
  eq(parseSlackShortcutPayload(globalShortcut({ user: {} })), null, "parse: …the same refusal on the global family");
  eq(parseSlackShortcutPayload(messageShortcut({ channel: {} })), null, "parse: a message_action with no channel.id ⇒ refused (its target cannot be addressed)");
  eq(parseSlackShortcutPayload(messageShortcut({}, { ts: undefined })), null, "parse: a message_action with no message.ts ⇒ refused");
  eq(parseSlackShortcutPayload({ type: "block_actions", callback_id: "x", trigger_id: "y", user: { id: INVOKER } }), null, "parse: a block_actions payload is not a shortcut");
  eq(parseSlackShortcutPayload(undefined), null, "parse: undefined ⇒ null, never a throw");
  eq(parseSlackShortcutPayload("not an object"), null, "parse: a string ⇒ null, never a throw");
  eq(parseSlackShortcutPayload([messageShortcut()]), null, "parse: an ARRAY is not a payload object");

  eq(parseSlackShortcutPayload(messageShortcut({}, { text: undefined }))?.message?.text, "", "parse: a message with no text parses with an EMPTY body, not a refusal");
}

{
  const sc = parseSlackShortcutPayload(messageShortcut())!;
  const ev = shortcutMessageEvent(sc, DM_CHANNEL, "im");

  eq(ev.userId, INVOKER, "map: 🔴 the principal is the INVOKER, never the message's author");
  ok(ev.userId !== AUTHOR, "map: 🔴 …negative control — it is NOT the author id, which the payload also carries");

  ok(ev.text.includes("the refund for order 4417 never landed"), "map: the target message's text reaches the wake as the content");
  ok(ev.text !== "the refund for order 4417 never landed", "map: 🔴 …and it arrives FENCED — the target message's own author is never graded on this path, so the body cannot inherit a tier and must carry a wrapper instead");
  ok(ev.text.includes(UNTRUSTED_OPEN), "map: 🔴 …specifically the untrusted-content fence, not some other transformation");
  eq(ev.authoredText, "", "map: a message shortcut is a forward with no covering note — the invoker typed nothing, so authoredText is empty");
  eq(ev.ts, MSG_TS, "map: a message shortcut takes the target message's REAL ts, so the reply anchors under it");
  eq(ev.channelId, DM_CHANNEL, "map: the channel is the one passed in (resolved by the caller, never guessed here)");
  eq(ev.channelType, "im", "map: the resolved channel type rides through — it is what picks the DM road");
  eq(ev.isAppMention, false, "map: no `<@bot>` in the body, so isAppMention is false — addressedness rides on directMention instead");
  eq(ev.teamId, TEAM, "map: the team id rides through (the partition is keyed on it)");
  eq(shortcutMessageEvent(parseSlackShortcutPayload(messageShortcut({}, { thread_ts: "1769912660.000100" }))!, DM_CHANNEL, "im").threadTs, "1769912660.000100", "map: a threaded target keeps its thread root, so the reply lands in that thread");
  eq(ev.attachments, undefined, "map: a message with no files carries no attachments (never an empty array)");

  const withFileSc = parseSlackShortcutPayload(messageShortcut({}, { files: [FILE] }))!;
  const withFile = shortcutMessageEvent(withFileSc, DM_CHANNEL, "im", NOW_MS, { admitAttachments: true });
  eq(withFile.attachments?.length, 1, "map: 🔴 the target message's FILES ride through, parsed by the same parseSlackFiles the Events API path uses");
  eq(withFile.attachments?.[0]?.id, "F1", "map: …and it is that file");
  eq(shortcutMessageEvent(withFileSc, DM_CHANNEL, "im", NOW_MS).attachments, undefined, "map: 🔴 …and it defaults to WITHHELD — a caller that has not established the app can read the room carries no files");
  eq(
    shortcutMessageEvent(withFileSc, DM_CHANNEL, "im", NOW_MS, { admitAttachments: false }).attachments,
    undefined,
    "map: 🔴 …an explicit refusal drops the REFERENCE too, never an id describe_image would fail closed on",
  );
  _resetSlackAttachmentsForTest();
  parseSlackShortcutPayload(messageShortcut({}, { files: [FILE] }));
  eq(resolveSlackAttachment("F1"), undefined, "map: 🔴 parsing a shortcut REGISTERS NOTHING — the registry is seeded by the front door, after the gates, never at classification time");
  eq(resolveSlackAttachment("F_NEVER_SEEN"), undefined, "map: negative control — the registry does not answer for a file no shortcut ever carried");

  const g = parseSlackShortcutPayload(globalShortcut())!;
  const gev = shortcutMessageEvent(g, DM_CHANNEL, "im", NOW_MS);
  ok(gev.text.includes("oe_global_shortcut"), "map: a global shortcut wakes with the TRIGGER NAME as its content");
  eq(gev.text, globalShortcutText(g), "map: …that content is the trigger line, unfenced — a callback id is operator config, not somebody's message");
  eq(gev.authoredText, gev.text, "map: a global shortcut's body IS what the invoker did, so it is their own authored text");
  eq(gev.threadTs, undefined, "map: a global shortcut anchors to no thread");

  eq(gev.ts, "1700000000.000000", "map: a global shortcut mints its `ts` from the clock, in Slack's seconds.microseconds shape");
  ok(!gev.ts.includes(TRIGGER), "map: 🔴 …and it is NOT the trigger id — negative control on the bug that shipped a message dated 2392");
  eq(
    new Date(Number.parseFloat(gev.ts) * 1000).toISOString(),
    new Date(NOW_MS).toISOString(),
    "map: 🔴 …so the wake's rendered `sent-at` is the moment the button was pressed — asserted through the SAME parseFloat the envelope uses, not a restatement of the format",
  );
}

{
  const a = parseSlackShortcutPayload(messageShortcut())!;
  const redelivered = parseSlackShortcutPayload(messageShortcut())!;
  const secondClick = parseSlackShortcutPayload(messageShortcut({ trigger_id: "13345224609.738474920.SECOND" }))!;

  eq(shortcutWakeKey(a), shortcutWakeKey(redelivered), "key: Slack redelivering the SAME click keys the same — one wake");
  ok(shortcutWakeKey(a) !== shortcutWakeKey(secondClick), "key: 🔴 a SECOND click on the SAME message keys differently — invoking a shortcut twice on purpose is two wakes, not a swallowed one");
  ok(shortcutWakeKey(a).includes(TRIGGER), "key: it is keyed on the trigger id");
  ok(!shortcutWakeKey(a).includes(MSG_TS), "key: …and NOT on the message ts, which is what would have swallowed the second click");
}

interface Dispatched {
  target: { token: string; wakeId: string; origin: Record<string, unknown>; surfaceKey: string };
  message: string;
  auth: { attributes?: Record<string, unknown> };
}

class SpyFifo extends ThreadFifo {
  readonly keys: string[] = [];
  readonly failures: Array<{ key: string; err: unknown }> = [];
  constructor() {
    super((key, err) => void this.failures.push({ key, err }));
  }
  override enqueue(key: string, run: () => Promise<void>): Promise<void> {
    this.keys.push(key);
    return super.enqueue(key, run);
  }
}

async function runFront(
  body: string,
  opts: {
    dedupe?: EventDedupe;
    fifo?: SpyFifo;
    channelFacts?: (channelId: string) => { internal: boolean; channelType?: string; appCanRead?: boolean };
    dmChannel?: string | null;
    ambient?: boolean;
    hearVoiceClips?: NonNullable<Parameters<typeof buildFrontHandler>[1]>["hearVoiceClips"];
  } = {},
) {
  const dispatched: Dispatched[] = [];
  const waits: Array<Promise<unknown>> = [];
  const seatCalls: Array<{ surfaceKey: string; channelId?: string }> = [];
  const dmOpens: string[] = [];
  let innerCalled = false;
  const fifo = opts.fifo ?? new SpyFifo();

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

  const handler = buildFrontHandler(
    async () => {
      innerCalled = true;
      return new Response("inner");
    },
    {
      signingSecret: SECRET,
      now: () => NOW_MS,
      markEventSeen: async () => true,
      getBotIdentity: async () => ({ userId: "UBOT", botId: "B_OE_SELF" }),
      fifo,
      ...(opts.dedupe ? { dedupe: opts.dedupe } : {}),
      ambientEnabledFor: () => opts.ambient !== false,
      dmPartnerTrustFor: async () => "internal" as const,
      channelFactsFor: async (channelId: string) =>
        opts.channelFacts
          ? opts.channelFacts(channelId)
          : channelId === DM_CHANNEL
            ? { internal: true, channelType: "im", appCanRead: true }
            : channelId === UNREADABLE_CHANNEL
              ? { internal: true, channelType: "channel", appCanRead: false }
              : { internal: true, channelType: "channel", appCanRead: true },
      authorFactsFor: async (internal: boolean) => ({ surfaceInternal: internal, refuted: false }),
      openDirectMessageChannel: async (userId: string) => {
        dmOpens.push(userId);
        return opts.dmChannel === null ? undefined : (opts.dmChannel ?? DM_CHANNEL);
      },
      resolveDmSeat: async (_org, dm, _at) => {
        seatCalls.push(dm);
        return { token: SEAT_TOKEN, generation: 3, freshGeneration: false, tail: [] as readonly WakeMessageInput[] } as never;
      },
      touchDmSeatFn: async () => {},
      ...(opts.hearVoiceClips ? { hearVoiceClips: opts.hearVoiceClips } : {}),
    },
  );
  const res = await handler(mkReq(body), fakeArgs as unknown as Parameters<typeof handler>[1]);
  const settled = await Promise.allSettled(waits);
  return { dispatched, seatCalls, dmOpens, innerCalled, res, fifo, settled };
}

{
  const r = await runFront(urlencoded(messageShortcut()));

  eq(r.res.status, 200, "join(message): Slack gets its fast ack");
  eq(r.innerCalled, false, "join(message): 🔴 eve's slackChannel is NEVER reached — the shortcut is ours end to end");
  eq(r.dispatched.length, 1, "join(message): exactly ONE wake was dispatched");
  const d = r.dispatched[0]!;
  eq(d.target.token, SEAT_TOKEN, "join(message): it rides the DM WINDOW's seat token — the same seat a DM message wakes, not a new session");
  eq(d.target.surfaceKey, DM_SURFACE, "join(message): the surface key is derived by the ordinary partition resolver");
  eq(
    (d.auth.attributes ?? {})["oe_addressing"],
    "direct-mention",
    "join(message): 🔴 the wake is ADDRESSED — a shortcut is somebody pressing a button aimed at this app, so it takes the direct-mention road and never the judge that asks whether the agent was addressed",
  );
  ok(d.message.includes('addressing="direct-mention"'), "join(message): …and the rendered envelope says so too");
  ok(typeof d.target.wakeId === "string" && d.target.wakeId.length > 0, "join(message): a host-minted wake id rides along, like every other unified-window wake");
  eq(r.seatCalls.length, 1, "join(message): the DM seat was resolved once");
  eq(r.seatCalls[0]!.surfaceKey, DM_SURFACE, "join(message): …for this DM's surface");
  eq(r.dmOpens.length, 0, "join(message): no `conversations.open` — a message shortcut already names its conversation");
  ok(r.fifo.keys.includes(dmFifoKey(DM_CHANNEL)), "join(message): it serialized on the DM's OWN fifo, so a shortcut and a DM message cannot interleave");
  eq(r.fifo.failures.length, 0, "join(message): the wake delivered — no loud failure recorded");

  ok(d.message.includes("the refund for order 4417 never landed"), "join(message): 🔴 the shortcut's target MESSAGE reached the model as the wake content");
  const attrs = d.auth.attributes ?? {};
  eq(attrs.channel_id, DM_CHANNEL, "join(message): the delivery auth names this DM");
  eq(attrs.channel_type, "im", "join(message): …bound as a 1:1 DM");
  eq(attrs.team_id, TEAM, "join(message): …in this workspace");
  ok(JSON.stringify(attrs).includes(INVOKER), "join(message): 🔴 the delivery auth carries the INVOKER");
  ok(!JSON.stringify(attrs).includes(AUTHOR), "join(message): 🔴 …and NOT the message's author — negative control on the whole security property");
}

{
  const r = await runFront(urlencoded(globalShortcut()));

  eq(r.res.status, 200, "join(global): Slack gets its fast ack");
  eq(r.innerCalled, false, "join(global): eve is not reached");
  eq(r.dispatched.length, 1, "join(global): one wake dispatched");
  eq(r.dmOpens, [INVOKER], "join(global): 🔴 it opened the INVOKER's own DM — a global shortcut names no room, so the invoker's DM is the only room they chose");
  eq(r.dispatched[0]!.target.surfaceKey, DM_SURFACE, "join(global): the wake lands on that DM's window");
  ok(r.dispatched[0]!.message.includes("oe_global_shortcut"), "join(global): 🔴 with no message to carry, the TRIGGER NAME is the wake content");
  ok(r.fifo.keys.includes(dmFifoKey(DM_CHANNEL)), "join(global): serialized on that DM's fifo");
  eq(r.fifo.failures.length, 0, "join(global): delivered — no loud failure");
}

{
  const r = await runFront(urlencoded(globalShortcut()), { dmChannel: null });

  eq(r.res.status, 200, "join(no-im:write): Slack still gets its ack — a shortcut that wakes nothing must not look like a broken endpoint");
  eq(r.dispatched.length, 0, "join(no-im:write): 🔴 NOTHING was woken — never a wake in a guessed room");
  eq(r.seatCalls.length, 0, "join(no-im:write): …and no seat was minted for a room that was never resolved");
  eq(r.innerCalled, false, "join(no-im:write): it is still not forwarded to eve (which could do nothing with it either)");
}

{
  const inChannel = urlencoded(messageShortcut({ channel: { id: PUBLIC_CHANNEL } }));

  const on = await runFront(inChannel, { ambient: true });
  ok(on.fifo.keys.includes(supervisorFifoKey(PUBLIC_CHANNEL)), "join(channel): with the unified window ON it serializes on the CHANNEL SUPERVISOR's fifo — the addressed road a single-window @mention takes");
  ok(!on.fifo.keys.includes(dmFifoKey(PUBLIC_CHANNEL)), "join(channel): …and never the DM road");
  eq(on.seatCalls.length, 0, "join(channel): no DM seat is minted for a channel shortcut");
  eq(on.innerCalled, false, "join(channel): still never forwarded to eve");
  eq(on.res.status, 200, "join(channel): acked");
  eq(on.dispatched.length, 0, "join(channel): the wake does NOT dispatch offline — the supervisor route's live internal confirmation refuses, so this leg is proven at the ROUTING grain only (the e2e leg proves the rest)");
  eq(on.fifo.failures.length, 0, "join(channel): …and it refuses cleanly — the FIFO records no loud failure, so the enqueue is sound even though delivery is out of reach here");

  const off = await runFront(inChannel, { ambient: false });
  eq(off.dispatched.length, 0, "join(channel, ambient off): nothing is woken — the refusal is real, and documented");
  eq(off.fifo.keys.length, 0, "join(channel, ambient off): 🔴 nothing was enqueued at all — it did NOT quietly become a name-drop wake");
  eq(off.res.status, 200, "join(channel, ambient off): Slack is still acked");
}

{
  const dedupe = new EventDedupe();
  const fifo = new SpyFifo();
  const first = await runFront(urlencoded(messageShortcut()), { dedupe, fifo });
  const retry = await runFront(urlencoded(messageShortcut()), { dedupe, fifo });
  eq(first.dispatched.length, 1, "idempotency: the first delivery of a click wakes");
  eq(retry.dispatched.length, 0, "idempotency: 🔴 Slack redelivering the SAME click wakes nothing a second time");

  const second = await runFront(urlencoded(messageShortcut({ trigger_id: "13345224609.738474920.SECOND" })), { dedupe, fifo });
  eq(second.dispatched.length, 1, "idempotency: 🔴 …but a SECOND, deliberate click on the SAME message DOES wake — the key is the click, not the message");
}

{
  const withFile = (channelId: string) => urlencoded(messageShortcut({ channel: { id: channelId } }, { files: [FILE] }));

  _resetSlackAttachmentsForTest();
  const denied = await runFront(withFile(UNREADABLE_CHANNEL));
  eq(denied.res.status, 200, "gate(unreadable): Slack still gets its ack");
  eq(
    resolveSlackAttachment("F1"),
    undefined,
    "gate(unreadable): 🔴 the file was NOT registered — describe_image fails closed on it, so the bot token can never be pointed at a room the app is not in",
  );
  ok(denied.fifo.keys.includes(supervisorFifoKey(UNREADABLE_CHANNEL)), "gate(unreadable): the click still wakes — withholding the file is not a drop, and the message's text still reaches the model");

  _resetSlackAttachmentsForTest();
  const admitted = await runFront(withFile(PUBLIC_CHANNEL));
  eq(
    resolveSlackAttachment("F1")?.urlPrivate,
    "https://files.slack.test/F1",
    "gate(readable): 🔴 positive control — in a room the app IS in, the same file IS registered, so describe_image resolves the id the wake advertises",
  );
  eq(resolveSlackAttachment("F1")?.teamId, TEAM, "gate(readable): …with the workspace it came from, for token routing");
  eq(resolveSlackAttachment("F_NEVER_SEEN"), undefined, "gate(readable): negative control — the registry still answers for nothing else");

  _resetSlackAttachmentsForTest();
  await runFront(withFile(DM_CHANNEL));
  eq(resolveSlackAttachment("F1")?.urlPrivate, "https://files.slack.test/F1", "gate(dm): a message shortcut in the app's own DM carries its file — the app is in that room by construction");
}

{
  const inChannel = urlencoded(messageShortcut({ channel: { id: PUBLIC_CHANNEL } }, { files: [FILE] }));

  _resetSlackAttachmentsForTest();
  const dropped = await runFront(inChannel, { ambient: false });
  eq(dropped.dispatched.length, 0, "seed(ambient off): nothing was woken — the addressed drop, unchanged");
  eq(
    resolveSlackAttachment("F1"),
    undefined,
    "seed(ambient off): 🔴 …and nothing was REGISTERED either — a click that wakes nothing must not evict a real upload's record from the shared LRU",
  );

  _resetSlackAttachmentsForTest();
  const woken = await runFront(inChannel, { ambient: true });
  ok(woken.fifo.keys.includes(supervisorFifoKey(PUBLIC_CHANNEL)), "seed(ambient on): the click reached the supervisor DISPATCHER — as far as this offline tier can see a channel wake go (§8)");
  eq(resolveSlackAttachment("F1")?.urlPrivate, "https://files.slack.test/F1", "seed(ambient on): 🔴 positive control — the wake that happens DOES seed the registry");

  _resetSlackAttachmentsForTest();
  const dedupe = new EventDedupe();
  await runFront(inChannel, { dedupe });
  _resetSlackAttachmentsForTest();
  const retry = await runFront(inChannel, { dedupe });
  eq(retry.dispatched.length, 0, "seed(redelivery): Slack redelivering the click wakes nothing a second time");
  eq(resolveSlackAttachment("F1"), undefined, "seed(redelivery): 🔴 …and re-seeds nothing — the registration sits BEHIND the dedupe, not in front of it");
}

{
  const CLIP = { id: "F_CLIP", name: "audio_message.webm", mimetype: "audio/webm", url_private: "https://files.slack.com/files-pri/T1-F_CLIP/audio_message.webm" };
  let hearCalls = 0;
  const spy: NonNullable<Parameters<typeof buildFrontHandler>[1]>["hearVoiceClips"] = async (ev) => (hearCalls++, ev);
  const woken = await runFront(urlencoded(messageShortcut({ channel: { id: PUBLIC_CHANNEL } }, { files: [CLIP] })), { ambient: true, hearVoiceClips: spy });
  ok(woken.fifo.keys.includes(supervisorFifoKey(PUBLIC_CHANNEL)), "voice(shortcut): the shortcut on a clip message DID reach the seat's queue (the positive control for the road)");
  eq(hearCalls, 0, "voice(shortcut): 🔴 …and the target message's voice clip was NOT heard — another person's speech never leaves the shortcut's untrusted fence");
}

{
  const blind = () => ({ internal: false });

  const r = await runFront(urlencoded(messageShortcut()), { channelFacts: blind });
  eq(r.res.status, 200, "unresolved: Slack still gets its ack — a dropped shortcut must not look like a broken endpoint");
  eq(r.dispatched.length, 0, "unresolved: 🔴 NOTHING was woken — a shortcut never routes on a room it could not identify");
  eq(r.fifo.keys.length, 0, "unresolved: 🔴 …and nothing was enqueued on ANY fifo — in particular not the channel supervisor's, which is where a DM's content used to land");
  eq(r.seatCalls.length, 0, "unresolved: no seat was minted");
  eq(r.innerCalled, false, "unresolved: still not forwarded to eve");

  const resolved = await runFront(urlencoded(messageShortcut()), { channelFacts: () => ({ internal: true, channelType: "im", appCanRead: true }) });
  eq(resolved.dispatched.length, 1, "unresolved: positive control — with a resolved `im` the same click wakes the DM window as before");
  eq(resolved.fifo.keys.includes(dmFifoKey(DM_CHANNEL)), true, "unresolved: …on the DM's own fifo");

  const g = await runFront(urlencoded(globalShortcut()), { channelFacts: blind });
  eq(g.dispatched.length, 1, "unresolved(global): a global shortcut resolves no room — it wakes the DM it opened, whatever conversations.info says");
}

{
  const GRID = "E_GRID";
  const OTHER_GRID = "E_OTHER";
  const withGrid = { enterprise: { id: GRID } };

  eq(parseSlackShortcutPayload(messageShortcut(withGrid))?.enterpriseId, GRID, "grid(parse): a MESSAGE shortcut carries the payload's `enterprise.id`");
  eq(parseSlackShortcutPayload(globalShortcut(withGrid))?.enterpriseId, GRID, "grid(parse): …and so does a GLOBAL shortcut — both families take the same rung");
  eq(
    parseSlackShortcutPayload(messageShortcut())?.enterpriseId,
    undefined,
    "grid(parse) NEGATIVE CONTROL: an ordinary single-workspace payload names no enterprise — an absent rung, not an empty one",
  );
  ok(!("enterpriseId" in parseSlackShortcutPayload(messageShortcut())!), "grid(parse) NEGATIVE CONTROL: …and the key is ABSENT, so nothing downstream spreads an undefined");

  {
    const orgWide = parseSlackShortcutPayload(messageShortcut({ team: null, ...withGrid }));
    eq(orgWide?.enterpriseId, GRID, "grid(parse): an ORG-WIDE install names only the enterprise (`team` is null) — the rung is still read");
    eq(orgWide?.teamId, undefined, "grid(parse): …and the absent workspace stays absent rather than being invented from the enterprise");

    const perWorkspace = parseSlackShortcutPayload(messageShortcut({ team: { id: TEAM, enterprise_id: GRID } }));
    eq(perWorkspace?.enterpriseId, GRID, "grid(parse): 🔴 a PER-WORKSPACE install on a Grid nests the rung as `team.enterprise_id` — read it, or every such install loses the rung");
    eq(perWorkspace?.teamId, TEAM, "grid(parse): …and its workspace is read as usual, from the same `team` object");

    eq(
      parseSlackShortcutPayload(messageShortcut({ team: null, enterprise_id: GRID }))?.enterpriseId,
      GRID,
      "grid(parse): 🔴 a top-level `enterprise_id` STRING is the third spelling — read it too, or an install that sends only this one loses the rung",
    );

    eq(
      parseSlackShortcutPayload(messageShortcut({ team: { id: TEAM, enterprise_id: OTHER_GRID }, ...withGrid }))?.enterpriseId,
      GRID,
      "grid(parse): with more than one spelling present the top-level `enterprise` object wins — one answer, not a shape-dependent one",
    );
    eq(
      parseSlackShortcutPayload(messageShortcut({ team: { id: TEAM, enterprise_id: OTHER_GRID }, enterprise_id: GRID }))?.enterpriseId,
      GRID,
      "grid(parse): …and the top-level string beats the one nested under `team`, so the order is widest-first throughout",
    );
  }

  eq(
    parseSlackShortcutPayload(messageShortcut({ team: null, context_enterprise_id: "E_FOREIGN" }))?.enterpriseId,
    undefined,
    "grid(parse): 🔴 `context_enterprise_id` is REFUSED — on a Connect payload it can name another org, so trusting it would let a foreign Grid vouch our room",
  );

  eq(
    parseSlackShortcutPayload(messageShortcut({ user: { id: INVOKER, enterprise_user: { enterprise_id: "E_STRANGER" } } }))?.enterpriseId,
    undefined,
    "grid(parse): 🔴 the INVOKER's own `enterprise_user.enterprise_id` is NOT the room's rung — a stranger's Grid must never vouch our room",
  );

  eq(
    shortcutMessageEvent(parseSlackShortcutPayload(messageShortcut(withGrid))!, DM_CHANNEL, "im").enterpriseId,
    GRID,
    "grid(map): `shortcutMessageEvent` spreads the rung onto the ParsedMessageEvent every wake route already reads",
  );
  ok(
    !("enterpriseId" in shortcutMessageEvent(parseSlackShortcutPayload(messageShortcut())!, DM_CHANNEL, "im")),
    "grid(map) NEGATIVE CONTROL: a non-Grid shortcut spreads NO key, so its wake auth is byte-identical to before",
  );

  {
    const r = await runFront(urlencoded(messageShortcut(withGrid)));
    eq(r.dispatched.length, 1, "grid(join): the Grid shortcut wakes exactly once, as any shortcut does");
    eq(
      (r.dispatched[0]!.auth.attributes ?? {})["enterprise_id"],
      GRID,
      "grid(join): 🔴 the dispatched wake auth carries `enterprise_id` — the attribute `bindSlack` turns into the trust rung above the workspace",
    );
  }
  {
    const plain = await runFront(urlencoded(messageShortcut()));
    eq(plain.dispatched.length, 1, "grid(join) NEGATIVE CONTROL: the same click without an enterprise still wakes");
    eq(
      (plain.dispatched[0]!.auth.attributes ?? {})["enterprise_id"],
      undefined,
      "grid(join) NEGATIVE CONTROL: 🔴 …and stamps NO enterprise_id — the payload's `enterprise` object is what carries the rung, nothing else",
    );
  }
  {
    const global = await runFront(urlencoded(globalShortcut(withGrid)));
    eq(global.dispatched.length, 1, "grid(join): a GLOBAL shortcut wakes the invoker's own DM");
    eq(
      (global.dispatched[0]!.auth.attributes ?? {})["enterprise_id"],
      GRID,
      "grid(join): …and carries the rung there too — both shortcut families reach the same stamp",
    );
  }
}

console.log(`✓ slack-shortcut-test: ${n} assertion(s) passed`);
