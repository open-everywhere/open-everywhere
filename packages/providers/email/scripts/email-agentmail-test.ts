import { createHmac, randomBytes } from "node:crypto";
import { agentMailSenderAuth, agentMailTransport, parseAgentMailDelivery, verifySvixSignature, AGENTMAIL_API_KEY_SECRET, AGENTMAIL_WEBHOOK_SECRET } from "../agent/transports/agentmail.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const keyBytes = randomBytes(24);
const SECRET = `whsec_${keyBytes.toString("base64")}`;
const NOW = 1_760_000_000_000;
function sign(id: string, ts: string, body: string, key: Buffer = keyBytes): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}
function payload(eventType: string, over: Record<string, unknown> = {}, msgOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event",
    event_type: eventType,
    event_id: "evt_1",
    message: {
      inbox_id: "Launch@agent.acme.com",
      thread_id: "thr_1",
      message_id: "<msg1@agent.acme.com>",
      labels: [],
      timestamp: "2026-10-11T10:00:00.000Z",
      from: "Ann <ann@acme.com>",
      to: ["launch@agent.acme.com"],
      cc: ["bob@acme.com"],
      subject: "Launch date",
      text: "Can you check?\n\n> earlier",
      extracted_text: "Can you check?",
      headers: { "Auto-Submitted": "no", "Authentication-Results": "mx.agentmail.to; spf=pass smtp.mailfrom=acme.com; dkim=pass header.d=acme.com; dmarc=pass header.from=acme.com" },
      attachments: [{ attachment_id: "a1", size: 10, filename: "plan.pdf", content_type: "application/pdf" }],
      ...msgOver,
    },
    thread: {},
    ...over,
  });
}

const ts = String(Math.floor(NOW / 1000));
const body = payload("message.received");
const good = { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": `v1,AAAA ${sign("msg_1", ts, body)}` };
ok(verifySvixSignature({ secret: SECRET, headers: good, rawBody: body, nowMs: NOW }).ok, "a correct signature verifies (any matching v1 entry)");
const WRONG_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const wrong = verifySvixSignature({ secret: WRONG_SECRET, headers: good, rawBody: body, nowMs: NOW });
ok(
  !wrong.ok && "reason" in wrong && !wrong.reason.includes(WRONG_SECRET) && !wrong.reason.includes(WRONG_SECRET.slice("whsec_".length)) && !wrong.reason.includes(SECRET),
  "a wrong secret refuses without naming the secret it was given",
);
ok(!verifySvixSignature({ secret: SECRET, headers: good, rawBody: body.replace("check", "chock"), nowMs: NOW }).ok, "a tampered body refuses");
ok(!verifySvixSignature({ secret: SECRET, headers: good, rawBody: body, nowMs: NOW + 301_000 }).ok, "a stale timestamp refuses");
ok(!verifySvixSignature({ secret: SECRET, headers: { ...good, "svix-id": "" }, rawBody: body, nowMs: NOW }).ok, "a missing header refuses");
ok(!verifySvixSignature({ secret: undefined, headers: good, rawBody: body, nowMs: NOW }).ok, "no configured secret refuses");
ok(!verifySvixSignature({ secret: SECRET, headers: { ...good, "svix-signature": sign("msg_1", ts, body).replace("v1,", "v2,") }, rawBody: body, nowMs: NOW }).ok, "a non-v1 signature is ignored");

const parsed = parseAgentMailDelivery({ "svix-id": "msg_1" }, body);
ok(parsed !== null && parsed.inbox === "launch@agent.acme.com", "the inbox normalises");
ok(parsed?.senderAuth === "pass" && parsed.deliveryId === "msg_1", "message.received is the vendor's pass, keyed by svix-id");
ok(parsed?.newText === "Can you check?" && parsed.fullText.includes("> earlier"), "the new text and the full text both parse");
ok(parsed?.headers["auto-submitted"] === "no", "loop-guard headers are lowercased and kept");
ok(parsed?.attachments[0]?.filename === "plan.pdf" && parsed.attachments[0].size === 10, "attachments are described, never fetched");
ok(parseAgentMailDelivery({}, payload("message.received.unauthenticated", {}, { headers: {} }))?.senderAuth === "none", "an unauthenticated event (no auth headers) reads none");
ok(parseAgentMailDelivery({}, payload("message.received.spam"))?.flagged === "spam", "a spam event reads flagged");
ok(parseAgentMailDelivery({}, payload("message.received.blocked"))?.flagged === "blocked", "a blocked event reads flagged");
ok(parseAgentMailDelivery({}, payload("message.received", {}, { headers: { "Authentication-Results": "mx; dmarc=fail header.from=acme.com" } }))?.senderAuth === "fail", "a dmarc=fail header lowers the vendor's pass");
ok(parseAgentMailDelivery({}, payload("message.received.unauthenticated", {}, { headers: { "Authentication-Results": "mx; dmarc=pass header.from=acme.com" } }))?.senderAuth === "none", "a header can never raise an unauthenticated event");
ok(parseAgentMailDelivery({}, payload("message.received", {}, { headers: {} }))?.senderAuth === "none", "message.received with no Authentication-Results reads none");
ok(parseAgentMailDelivery({}, payload("message.received", {}, { headers: { "Authentication-Results": "mx; spf=pass; dkim=pass; dmarc=none header.from=small.co" }, from: "partner@small.co" }))?.senderAuth === "none", "dmarc=none (a domain with no DMARC record) reads none, so the gate refuses it");
ok(parseAgentMailDelivery({}, payload("message.received", {}, { headers: { "Authentication-Results": "mx; dmarc=pass header.from=attacker.example" } }))?.senderAuth === "none", "a dmarc=pass for another domain than the From's reads none");
ok(agentMailSenderAuth(true, ["mx; dmarc=none", "evil; dmarc=pass header.from=acme.com"], "ann@acme.com") === "none", "only the FIRST Authentication-Results value can pass: a lower, sender-written one cannot");
ok(agentMailSenderAuth(true, ["mx; dmarc=pass header.from=acme.com", "x; dmarc=fail"], "ann@acme.com") === "fail", "a dmarc=fail in any value lowers to fail");
ok(agentMailSenderAuth(true, ["mx; dmarc=pass header.from=acme.com"], "not an address") === "none", "an unparseable From never passes");
ok(agentMailSenderAuth(true, ["mx; dmarc=pass"], "Ann <ann@acme.com>") === "none", "a dmarc=pass with no header.from is not a pass");
ok(agentMailSenderAuth(true, ["mx; dmarc=pass header.from=acme.com"], "Ann <ann@acme.com>") === "pass", "a dmarc=pass for the From's own domain passes");
ok(
  agentMailSenderAuth(true, ["mx.example; dmarc=none header.from=small.co; arc=pass (i=1 spf=pass; dkim=pass; dmarc=pass fromdomain=small.co)"], "partner@small.co") === "none",
  "a dmarc=pass echoed inside an ARC comment is not a pass",
);
ok(agentMailSenderAuth(true, ["mx; spf=pass (sender; dmarc=pass header.from=acme.com) smtp.mailfrom=acme.com"], "ann@acme.com") === "none", "a dmarc=pass hidden in another result's comment is not a pass");
ok(agentMailSenderAuth(true, ["mx; dmarc=pass header.from=acme.com; dmarc=none header.from=acme.com"], "ann@acme.com") === "none", "two dmarc results in one value are not a pass");
ok(agentMailSenderAuth(true, ["mx; dmarc=pass (p=none dis=none) header.from=acme.com"], "ann@acme.com") === "pass", "a dmarc=pass with its own policy comment still passes");
ok(parseAgentMailDelivery({}, payload("message.sent")) === null, "a non-inbound event is null");
ok(parseAgentMailDelivery({}, "not json") === null, "a non-JSON body is null");
ok(parseAgentMailDelivery({}, payload("message.received", {}, { thread_id: "" })) === null, "a delivery missing its thread is null");

const calls: { url: string; init: RequestInit }[] = [];
const secrets: Record<string, string> = { [AGENTMAIL_API_KEY_SECRET]: "am_key", [AGENTMAIL_WEBHOOK_SECRET]: SECRET };
const t = agentMailTransport("agentmail", "https://api.example.test", {
  now: () => NOW,
  secret: async (n) => secrets[n],
  fetch: (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ message_id: "<reply1>", thread_id: "thr_1" }), { status: 200 });
  }) as unknown as typeof fetch,
});
ok((await t.verify(good, body)).ok, "the transport verifies through its own secret");
const sent = await t.reply({ inbox: "launch@agent.acme.com", inReplyToMessageId: "<msg1@agent.acme.com>", to: ["ann@acme.com"], cc: ["bob@acme.com"], text: "Thursday." });
ok(sent.messageId === "<reply1>", "the reply returns the vendor's message id");
ok(calls[0]!.url === "https://api.example.test/v0/inboxes/launch%40agent.acme.com/messages/%3Cmsg1%40agent.acme.com%3E/reply", "the reply posts to the reply endpoint, ids encoded");
const sentBody = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
ok(JSON.stringify(sentBody.to) === '["ann@acme.com"]' && JSON.stringify(sentBody.cc) === '["bob@acme.com"]' && sentBody.text === "Thursday.", "the body carries exactly the host-decided recipients and text");
ok((calls[0]!.init.headers as Record<string, string>).authorization === "Bearer am_key", "the API key rides the bearer header");
const failing = agentMailTransport("agentmail", "https://api.example.test", {
  secret: async (n) => secrets[n],
  fetch: (async () => new Response("echo: Thursday. am_key", { status: 400 })) as unknown as typeof fetch,
});
let err = "";
try {
  await failing.reply({ inbox: "launch@agent.acme.com", inReplyToMessageId: "m", to: ["a@acme.com"], cc: [], text: "x" });
} catch (e) {
  err = String(e);
}
ok(err.includes("HTTP 400") && !err.includes("am_key") && !err.includes("Thursday"), "a refused reply names the status only — no body, no key");
const noKey = agentMailTransport("agentmail", "https://api.example.test", { secret: async () => undefined, fetch: (async () => new Response("{}")) as unknown as typeof fetch });
err = "";
try {
  await noKey.reply({ inbox: "launch@agent.acme.com", inReplyToMessageId: "m", to: ["a@acme.com"], cc: [], text: "x" });
} catch (e) {
  err = String(e);
}
ok(err.includes("no API key"), "no API key refuses before any call");

const reader = agentMailTransport("agentmail", "https://api.example.test", {
  secret: async (n) => secrets[n],
  fetch: (async () =>
    new Response(
      JSON.stringify({
        messages: [
          { message_id: "m1", from: "ann@acme.com", labels: ["received"], timestamp: "2026-10-11T10:00:00Z", text: "hi" },
          { message_id: "m2", from: "launch@agent.acme.com", labels: ["sent"], timestamp: "2026-10-11T10:01:00Z", text: "hello" },
          { message_id: "m3", from: "launch@agent.acme.com", labels: ["received", "unauthenticated"], timestamp: "2026-10-11T10:02:00Z", text: "spoof" },
          { message_id: "m4", from: "x@else.com", labels: ["received", "spam"], timestamp: "2026-10-11T10:03:00Z", text: "spam" },
        ],
      }),
    )) as unknown as typeof fetch,
});
const thread = await reader.readThread!("launch@agent.acme.com", "thr_1", 10);
ok(thread[0]!.sent !== true && thread[0]!.suspect !== true, "a received, unflagged message is neither sent nor suspect");
ok(thread[1]!.sent === true && thread[1]!.suspect !== true, "the vendor's sent label marks the agent's own message");
ok(thread[2]!.sent !== true && thread[2]!.suspect === true, "a received message claiming the inbox's From is not sent, and its unauthenticated label is suspect");
ok(thread[3]!.suspect === true, "a spam label is suspect");

console.log(`✓ email-agentmail-test: ${passed} assertions`);
