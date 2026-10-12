import { sendGoogleChatReply } from "../agent/channels/google-chat-post-arm.js";
import { googleChatMessageOps, postGoogleChatNotice } from "../agent/channels/google-chat-message-ops.js";
import { googleChatWakeOriginCodec, type GoogleChatOrigin } from "../agent/channels/google-chat-origin-codec.js";
import { GOOGLE_CHAT_MAX_TEXT, splitGoogleChatText } from "../agent/channels/google-chat-rest.js";
import type { GoogleChatPolicy } from "../agent/policy.js";
import { exportPKCS8, generateKeyPair } from "jose";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejects(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (mentions "${needle}", got: ${String(err)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const POLICY: GoogleChatPolicy = { enabled: true, audience: { kind: "project-number", projectNumber: "1" }, workspace: "acme", internalDomainIds: [], directMessages: true };
const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>)["authorization"]), body });
  const thread = (body["thread"] as { name?: string } | undefined)?.name ?? "spaces/AAAA/threads/new1";
  return new Response(JSON.stringify({ name: `spaces/AAAA/messages/r${calls.length}`, thread: { name: thread } }), { status: 200 });
}) as typeof fetch;
const tokenFetch = (async (url: string | URL, init?: RequestInit) =>
  String(url).startsWith("https://oauth2.googleapis.com/") ? new Response(JSON.stringify({ access_token: "ya29.t", expires_in: 3600 }), { status: 200 }) : fakeFetch(url, init)) as typeof fetch;
const kp = await generateKeyPair("RS256", { extractable: true });
const KEY = JSON.stringify({ type: "service_account", client_email: "bot@p.iam.gserviceaccount.com", private_key: await exportPKCS8(kp.privateKey) });
const live = (policy: GoogleChatPolicy = POLICY) => ({ policy: () => policy, fetch: tokenFetch, serviceAccountKey: async () => KEY });

const origin: GoogleChatOrigin = { platform: "google-chat", workspace: "acme", space: "spaces/AAAA", thread: "spaces/AAAA/threads/t1", messageName: "spaces/AAAA/messages/m1" };

const id = await sendGoogleChatReply(origin, "Thursday.", live());
ok(id === "spaces/AAAA/messages/r1", "the reply returns the created message name");
ok(calls[0]!.url === "https://chat.googleapis.com/v1/spaces/AAAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD", "the reply posts into the origin's space with the thread fallback option");
ok((calls[0]!.body["thread"] as { name: string }).name === "spaces/AAAA/threads/t1" && calls[0]!.body["text"] === "Thursday.", "the reply threads under the origin's thread");
ok(calls[0]!.auth === "Bearer ya29.t", "the reply carries the app's access token");

calls.length = 0;
const long = `${"a".repeat(GOOGLE_CHAT_MAX_TEXT)}\n${"b".repeat(100)}`;
await sendGoogleChatReply({ platform: "google-chat", workspace: "acme", space: "spaces/AAAA" }, long, live());
ok(calls.length === 2, "a reply over one Chat message goes out as two messages");
ok(calls[0]!.body["thread"] === undefined && calls[0]!.url.endsWith("/spaces/AAAA/messages"), "an origin with no thread posts its first piece as a new message");
ok((calls[1]!.body["thread"] as { name: string }).name === "spaces/AAAA/threads/new1", "the later piece follows the first one's thread");
ok(splitGoogleChatText("x".repeat(9000)).every((p) => p.length <= GOOGLE_CHAT_MAX_TEXT), "every piece fits one Chat message");
{
  const astral = `${"a".repeat(GOOGLE_CHAT_MAX_TEXT - 1)}😀${"b".repeat(10)}`;
  const pieces = splitGoogleChatText(astral);
  const roundTrips = pieces.every((p) => new TextDecoder().decode(new TextEncoder().encode(p)) === p);
  ok(roundTrips && pieces.join("") === astral, "a split never cuts through a surrogate pair, and loses nothing");
}

calls.length = 0;
await rejects(() => sendGoogleChatReply(origin, "x", live({ ...POLICY, enabled: false })), "turned off", "a disabled policy refuses the reply");
await rejects(() => sendGoogleChatReply(origin, "x", live({ ...POLICY, workspace: "other" })), "another workspace", "an origin of another workspace refuses");
await rejects(() => sendGoogleChatReply({ ...origin, space: "spaces/../x" } as GoogleChatOrigin, "x", live()), "not a valid Google Chat origin", "an invalid origin refuses");
ok(calls.length === 0, "every refusal made no network call");

ok((await postGoogleChatNotice("spaces/AAAA", "Approved.", live())) === "spaces/AAAA/messages/r1", "a host notice posts");
ok(calls[0]!.body["thread"] === undefined && calls[0]!.body["text"] === "Approved.", "a host notice lands in the space as a new message");
await rejects(() => postGoogleChatNotice("spaces/AAAA", "x", live({ ...POLICY, enabled: false })), "turned off", "a disabled policy refuses a notice");
await rejects(() => postGoogleChatNotice("C123", "x", live()), "not valid", "a notice to a non-space address refuses");
await rejects(() => googleChatMessageOps.editMessage("spaces/AAAA", "spaces/AAAA/messages/r1", "x"), "not built yet", "an edit refuses");

const v = (o: Record<string, unknown>): boolean => googleChatWakeOriginCodec.validate(o);
ok(v({ ...origin }), "a well-formed origin validates");
ok(v({ ...origin, extra: 1 }), "an unknown extra field is tolerated");
ok(!v({ ...origin, space: "spaces/" }), "an empty space id is refused");
ok(!v({ ...origin, thread: "spaces/BBBB/threads/t1" }), "a thread of another space is refused");
ok(!v({ ...origin, messageName: "spaces/BBBB/messages/m1" }), "a message of another space is refused");
ok(!v({ platform: "google-chat", workspace: "acme", space: "spaces/AAAA", threadReply: true }), "a thread reply with no thread is refused");
ok(!v({ ...origin, workspace: "Acme" }), "a workspace that is not a segment is refused");
const ref = googleChatWakeOriginCodec.threadRef(origin);
ok(ref.channelKey === "google-chat/spaces/AAAA" && ref.threadKey === "spaces/AAAA/threads/t1", "threadRef keys on the space and the thread");
ok(!googleChatWakeOriginCodec.isThreadScoped(origin) && googleChatWakeOriginCodec.isThreadScoped({ ...origin, threadReply: true }), "only threadReply makes an origin thread-scoped");

console.log(`✓ google-chat-post-arm-test: ${passed} assertions`);
