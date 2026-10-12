import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import type { WakeTrust } from "@open-everywhere/core/agent/adapter-api.js";
import { DEFAULT_GOOGLE_CHAT_POLICY, validateGoogleChatPolicy, type GoogleChatPolicy } from "../agent/policy.js";
import {
  GOOGLE_CHAT_INGRESS_MAX_BODY_BYTES,
  handleGoogleChatDelivery,
  handleGoogleChatRequest,
  parseGoogleChatEvent,
  renderGoogleChatWake,
  type GoogleChatFrontDeps,
  type GoogleChatWakePlan,
} from "../agent/channels/google-chat-front.js";
import { bindGoogleChat } from "../agent/channels/google-chat-identity.js";
import { CHAT_ISSUER_ACCOUNT } from "../agent/channels/google-chat-auth.js";
import { googleChatWakeOriginCodec } from "../agent/channels/google-chat-origin-codec.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const kp = await generateKeyPair("RS256");
const keys: JWTVerifyGetKey = async () => kp.publicKey;
const AUTH = `Bearer ${await new SignJWT({})
  .setProtectedHeader({ alg: "RS256" })
  .setIssuer(CHAT_ISSUER_ACCOUNT)
  .setAudience("4242")
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(kp.privateKey)}`;

const POLICY: GoogleChatPolicy = {
  enabled: true,
  audience: { kind: "project-number", projectNumber: "4242" },
  workspace: "acme",
  internalDomainIds: ["C0acme"],
  directMessages: true,
};

interface World {
  readonly deps: GoogleChatFrontDeps;
  readonly rooms: GoogleChatWakePlan[];
  readonly dms: GoogleChatWakePlan[];
  readonly audits: { action: string; detail: Record<string, unknown> }[];
}

function world(policy: GoogleChatPolicy = POLICY, seated = new Set(["google-chat/acme/AAAAroom"])): World {
  const seen = new Set<string>();
  const rooms: GoogleChatWakePlan[] = [];
  const dms: GoogleChatWakePlan[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  return {
    rooms,
    dms,
    audits,
    deps: {
      policy: () => policy,
      chatSystemKeys: keys,
      markSeen: async (k) => (seen.has(k) ? false : (seen.add(k), true)),
      roomHasSeat: (k) => seated.has(k),
      wakeTrust: (auth) => (auth.attributes["gchat_trust"] === "internal" ? "member" : "unauth") as WakeTrust,
      dispatchRoom: async (p) => void rooms.push(p),
      dispatchDm: async (p) => void dms.push(p),
      audit: async (row) => void audits.push({ action: row.action, detail: row.detail }),
    },
  };
}

function msg(over: {
  space?: Record<string, unknown>;
  sender?: Record<string, unknown>;
  name?: string;
  thread?: string;
  threadReply?: boolean;
  mention?: boolean;
  type?: string;
  text?: string;
} = {}): string {
  const space = over.space ?? { name: "spaces/AAAAroom", spaceType: "SPACE" };
  const sp = String(space["name"]);
  return JSON.stringify({
    type: over.type ?? "MESSAGE",
    eventTime: "2026-10-12T10:00:00Z",
    space,
    message: {
      name: over.name ?? `${sp}/messages/m1`,
      sender: over.sender ?? { name: "users/111", displayName: "Tom", type: "HUMAN", domainId: "C0acme" },
      text: `@OE ${over.text ?? "what is the launch date?"}`,
      argumentText: ` ${over.text ?? "what is the launch date?"}`,
      thread: { name: over.thread ?? `${sp}/threads/t1` },
      ...(over.threadReply ? { threadReply: true } : {}),
      annotations: over.mention === false ? [] : [{ type: "USER_MENTION", userMention: { user: { name: "users/app", type: "BOT" }, type: "MENTION" } }],
      createTime: "2026-10-12T10:00:00Z",
    },
  });
}

ok(DEFAULT_GOOGLE_CHAT_POLICY.enabled === false && DEFAULT_GOOGLE_CHAT_POLICY.audience === null, "the shipped default is off, with no audience");
{
  const w = world(DEFAULT_GOOGLE_CHAT_POLICY);
  ok((await handleGoogleChatDelivery(AUTH, msg(), w.deps)).kind === "not-configured", "the shipped default answers not-configured");
  ok(w.rooms.length + w.dms.length + w.audits.length === 0, "an unconfigured surface dispatches and audits nothing");
  const noAud = world({ ...POLICY, audience: null });
  ok((await handleGoogleChatDelivery(AUTH, msg(), noAud.deps)).kind === "not-configured", "an enabled policy with no audience answers not-configured");
}
ok(validateGoogleChatPolicy({ ...POLICY, audience: null }).some((p) => p.includes("audience")), "validation refuses an enabled policy with no audience");
ok(validateGoogleChatPolicy({ ...POLICY, workspace: "Acme Corp" }).length > 0, "validation refuses a workspace that is not a segment");
ok(validateGoogleChatPolicy({ ...POLICY, audience: { kind: "endpoint-url", url: "http://agent.acme.com/x" } }).length > 0, "validation refuses a non-https endpoint audience");
ok(validateGoogleChatPolicy(POLICY).length === 0 && validateGoogleChatPolicy(DEFAULT_GOOGLE_CHAT_POLICY).length === 0, "the test policy and the shipped default validate");

{
  const w = world();
  const out = await handleGoogleChatDelivery("Bearer not.a.token", msg(), w.deps);
  ok(out.kind === "unauthorized", "a bad token is unauthorized");
  ok(w.rooms.length + w.dms.length + w.audits.length === 0, "an unverified delivery dispatches and audits nothing");
}

{
  const w = world();
  ok((await handleGoogleChatDelivery(AUTH, msg({ type: "ADDED_TO_SPACE" }), w.deps)).kind === "ignored", "ADDED_TO_SPACE is ignored");
  ok((await handleGoogleChatDelivery(AUTH, msg({ sender: { name: "users/app", type: "BOT" } }), w.deps)).kind === "ignored", "a bot's message is ignored (the loop guard)");
  ok((await handleGoogleChatDelivery(AUTH, msg({ name: "spaces/OTHER/messages/m1" }), w.deps)).kind === "ignored", "a message name of another space is ignored");
  ok((await handleGoogleChatDelivery(AUTH, msg({ thread: "spaces/OTHER/threads/t1" }), w.deps)).kind === "ignored", "a thread of another space is ignored");
  ok((await handleGoogleChatDelivery(AUTH, msg({ mention: false }), w.deps)).kind === "ignored", "a space message that does not address the app is ignored");
  ok((await handleGoogleChatDelivery(AUTH, "{oops", w.deps)).kind === "ignored", "a non-JSON body is ignored");
  ok(w.rooms.length + w.dms.length + w.audits.length === 0, "an ignored event dispatches and audits nothing");
}

{
  const w = world();
  const out = await handleGoogleChatDelivery(AUTH, msg(), w.deps);
  ok(out.kind === "admitted" && out.route === "room" && out.surfaceKey === "google-chat/acme/AAAAroom", "an @mention in a seated space wakes the room seat");
  const p = w.rooms[0]!;
  ok(p.origin.space === "spaces/AAAAroom" && p.origin.thread === "spaces/AAAAroom/threads/t1" && p.origin.workspace === "acme", "the origin freezes the space, thread and workspace");
  ok(p.origin.threadReply === undefined, "a top-level message is not thread-scoped");
  ok(p.trigger.body === "what is the launch date?", "the trigger is the argument text, the mention removed");
  ok(p.trust === "internal", "a listed domain id binds internal");
  ok(googleChatWakeOriginCodec.validate(p.origin as unknown as Record<string, unknown>), "the minted origin passes the codec");
  ok(w.audits.length === 1 && w.audits[0]!.action === "google-chat.admitted" && w.audits[0]!.detail["domainId"] === "C0acme", "admission is audited with the sender's domain id");
  ok((await handleGoogleChatDelivery(AUTH, msg(), w.deps)).kind === "duplicate" && w.rooms.length === 1, "a retried message name dispatches once");
  const rendered = renderGoogleChatWake(p, "wake-1");
  ok(rendered.message.includes("what is the launch date?"), "the rendered wake carries the message");

  const reply = await handleGoogleChatDelivery(AUTH, msg({ name: "spaces/AAAAroom/messages/m2", threadReply: true }), w.deps);
  ok(reply.kind === "admitted" && w.rooms[1]!.origin.threadReply === true, "a reply inside a thread carries the positive thread signal");
  ok(googleChatWakeOriginCodec.isThreadScoped(w.rooms[1]!.origin), "the codec reads a thread reply as thread-scoped");
}
{
  const w = world();
  const out = await handleGoogleChatDelivery(AUTH, msg({ sender: { name: "users/999", displayName: "Guest", type: "HUMAN", domainId: "C0other" } }), w.deps);
  ok(out.kind === "admitted", "an outside sender in a seated space is admitted");
  const p = w.rooms[0]!;
  ok(p.trust === "external" && p.auth.attributes["gchat_trust"] === "external", "an unlisted domain id binds external");
  ok(p.ingested[0]!.refuted === true, "an outside sender is refuted (the non-member carriage)");
  const noDomain = world();
  ok((await handleGoogleChatDelivery(AUTH, msg({ sender: { name: "users/998", type: "HUMAN" } }), noDomain.deps)).kind === "admitted" && noDomain.rooms[0]!.trust === "external", "a sender with no domain id binds external");
}
{
  const w = world(POLICY, new Set());
  const out = await handleGoogleChatDelivery(AUTH, msg(), w.deps);
  ok(out.kind === "refused" && out.reason === "no-domain", "a space with no seat is refused no-domain");
  ok(w.rooms.length === 0 && w.audits[0]!.action === "google-chat.refused", "the refusal is audited and nothing dispatches");
}

const DM = { name: "spaces/DDDDdm", spaceType: "DIRECT_MESSAGE", singleUserBotDm: true };
{
  const w = world();
  const out = await handleGoogleChatDelivery(AUTH, msg({ space: DM, mention: false }), w.deps);
  ok(out.kind === "admitted" && out.route === "dm" && w.dms.length === 1, "an internal person's DM wakes their DM seat (no mention needed)");
  ok(w.dms[0]!.auth.attributes["gchat_mode"] === "dm", "the DM auth says dm");
  const ext = await handleGoogleChatDelivery(
    AUTH,
    msg({ space: DM, mention: false, name: "spaces/DDDDdm/messages/m9", sender: { name: "users/999", type: "HUMAN", domainId: "C0other" } }),
    w.deps,
  );
  ok(ext.kind === "refused" && ext.reason === "external-dm", "an outside person's DM is refused");
  const extRow = w.audits.find((r) => r.detail["reason"] === "external-dm");
  ok(extRow?.action === "google-chat.refused" && extRow.detail["domainId"] === "C0other", "the external-dm refusal records the sender's domain id (how a DM-only deployment learns its own)");
  const off = world({ ...POLICY, directMessages: false });
  const offOut = await handleGoogleChatDelivery(AUTH, msg({ space: DM, mention: false }), off.deps);
  ok(offOut.kind === "refused" && offOut.reason === "dm-off" && off.dms.length === 0, "DMs turned off refuse a DM");
  const grp = world();
  const g = await handleGoogleChatDelivery(AUTH, msg({ space: { name: "spaces/GGGG", spaceType: "GROUP_CHAT" } }), grp.deps);
  ok(g.kind === "refused" && g.reason === "group-chat" && grp.rooms.length + grp.dms.length === 0, "a group chat is refused");
  const multi = world();
  const mm = await handleGoogleChatDelivery(AUTH, msg({ space: { name: "spaces/HHHH", spaceType: "DIRECT_MESSAGE", singleUserBotDm: false } }), multi.deps);
  ok(mm.kind === "refused" && mm.reason === "group-chat", "a DIRECT_MESSAGE space that is not a one-to-one with the app is refused as a group chat");
}

{
  const legacy = parseGoogleChatEvent(msg({ space: { name: "spaces/LLLL", type: "DM", singleUserBotDm: true } }));
  ok("event" in legacy && legacy.event.spaceKind === "dm", "the legacy `type: DM` field reads as a DM");
  const slash = JSON.parse(msg({ mention: false }));
  slash.message.slashCommand = { commandId: "1" };
  const s = parseGoogleChatEvent(JSON.stringify(slash));
  ok("event" in s && s.event.addressed, "a slash command addresses the app");
}

{
  const empty = bindGoogleChat({ channel: { kind: "google-chat" } });
  ok(empty.trust === "external" && empty.mode === "channel" && empty.visibility === "private" && empty.target === undefined, "the mapper fails closed with no attributes");
  const w = world();
  await handleGoogleChatDelivery(AUTH, msg(), w.deps);
  const b = bindGoogleChat({ channel: { kind: "google-chat" }, session: { auth: { current: w.rooms[0]!.auth as never } } });
  ok(b.workspace === "acme" && b.surface === "AAAAroom" && b.trust === "internal" && b.trustVerified === undefined, "a room binding: workspace, space id surface, internal, no trustVerified");
  const t = b.target as Record<string, unknown>;
  ok(t["space"] === "spaces/AAAAroom" && t["channelId"] === "spaces/AAAAroom" && t["thread"] === "spaces/AAAAroom/threads/t1", "the target carries the space, the notice address and the thread");
  await handleGoogleChatDelivery(AUTH, msg({ space: DM, mention: false }), w.deps);
  const d = bindGoogleChat({ channel: { kind: "google-chat" }, session: { auth: { current: w.dms[0]!.auth as never } } });
  ok(d.mode === "dm" && d.trustVerified === true, "an internal DM sets trustVerified");
}

{
  function probeRequest(auth: string | undefined, body: string): { req: Request; read: () => boolean } {
    let pulled = false;
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth !== undefined) headers["authorization"] = auth;
    const req = new Request("https://agent.example/eve/v1/google-chat", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
    return { req, read: () => pulled };
  }
  const pending: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>): void => void pending.push(p);

  const off = probeRequest(AUTH, msg());
  const r503 = await handleGoogleChatRequest(off.req, waitUntil, world(DEFAULT_GOOGLE_CHAT_POLICY).deps);
  ok(r503.status === 503 && !off.read(), "the route answers 503 under the shipped default, and reads no byte of the body");

  const bad = probeRequest("Bearer not.a.token", msg());
  const r401 = await handleGoogleChatRequest(bad.req, waitUntil, world().deps);
  ok(r401.status === 401 && !bad.read(), "the route answers 401 to a bad token, and reads no byte of the body");
  const none = probeRequest(undefined, msg());
  ok((await handleGoogleChatRequest(none.req, waitUntil, world().deps)).status === 401 && !none.read(), "no Authorization header is 401, with the body unread");

  const big = probeRequest(AUTH, "x".repeat(GOOGLE_CHAT_INGRESS_MAX_BODY_BYTES + 1));
  ok((await handleGoogleChatRequest(big.req, waitUntil, world().deps)).status === 413, "a verified body over the cap is 413");

  const w = world();
  const good = probeRequest(AUTH, msg());
  const r200 = await handleGoogleChatRequest(good.req, waitUntil, w.deps);
  ok(r200.status === 200 && (await r200.text()) === "{}", "a verified event is acknowledged with `{}` (no synchronous message)");
  await Promise.all(pending);
  ok(w.rooms.length === 1, "the acknowledged event wakes its seat in the background");
}

console.log(`✓ google-chat-front-test: ${passed} assertions`);
