import { sendEmailReply } from "../agent/channels/email-post-arm.js";
import { emailWakeOriginCodec } from "../agent/channels/email-origin-codec.js";
import { postEmailThreadNotice, emailMessageOps } from "../agent/channels/email-message-ops.js";
import type { EmailPolicy, EmailReplyRequest, EmailTransport, Principal, UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";

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

type EmailOrigin = Extract<UnifiedWakeOrigin, { platform: "email" }>;
const POLICY: EmailPolicy = {
  enabled: true,
  transport: "fake",
  orgDomains: ["acme.com"],
  maxRecipients: 3,
  maxInboundChars: 20_000,
  inboxes: [{ address: "launch@agent.acme.com", kind: "room", allowedSenders: ["*@acme.com", "partner@ext.com"], why: "launch" }],
};
const PRINCIPALS: readonly Principal[] = [];
const sent: EmailReplyRequest[] = [];
const transport: EmailTransport = {
  id: "fake",
  sharedDomains: [],
  verify: async () => ({ ok: true }),
  parse: () => null,
  reply: async (r) => (sent.push(r), { messageId: `r${sent.length}` }),
};
const origin: EmailOrigin = { platform: "email", inbox: "launch@agent.acme.com", threadId: "t1", messageId: "m1", to: ["partner@ext.com"], cc: ["bob@acme.com", "carol@acme.com", "dan@acme.com"] };
const deps = (policy: EmailPolicy = POLICY, t: EmailTransport | undefined = transport) => ({ policy: () => policy, principals: () => PRINCIPALS, transport: () => t });

const id = await sendEmailReply(origin, "Thursday.", deps());
ok(id === "r1", "the reply returns the transport's id");
ok(sent[0]!.inReplyToMessageId === "m1" && sent[0]!.inbox === "launch@agent.acme.com", "the reply threads under the origin's message, from the inbox");
ok(JSON.stringify(sent[0]!.to) === '["partner@ext.com"]', "the reply goes to the frozen primary recipient");
ok(sent[0]!.cc.length === 2, "the Cc is capped so To and Cc stay within maxRecipients");

const narrowed: EmailPolicy = { ...POLICY, orgDomains: ["acme.com"], inboxes: [{ ...POLICY.inboxes[0]!, allowedSenders: ["*@acme.com"] }] };
await rejects(() => sendEmailReply(origin, "x", deps(narrowed)), "may no longer receive mail", "a primary recipient the current policy dropped refuses the reply");
const sentBefore = sent.length;
await sendEmailReply({ ...origin, to: ["bob@acme.com"], cc: ["partner@ext.com"] }, "x", deps(narrowed));
ok(sent.length === sentBefore + 1 && !sent.at(-1)!.cc.includes("partner@ext.com"), "a Cc the current policy dropped is left off at send time");
await rejects(() => sendEmailReply(origin, "x", deps({ ...POLICY, enabled: false })), "turned off", "a disabled policy refuses");
await rejects(() => sendEmailReply({ ...origin, inbox: "gone@agent.acme.com" }, "x", deps()), "no longer one of this deployment's inboxes", "a removed inbox refuses");
await rejects(() => sendEmailReply(origin, "x", { ...deps(), transport: () => undefined }), "no email transport", "an unregistered transport refuses");
await rejects(() => sendEmailReply({ ...origin, to: [] }, "x", deps()), "not a valid email origin", "an origin with no recipient refuses");
const n = sent.length;
await sendEmailReply(origin, "y".repeat(60_000), deps());
ok(sent.length === n + 1 && sent.at(-1)!.text.length < 60_000 && sent.at(-1)!.text.includes("cut at"), "an over-long reply is cut and says so");

const v = (o: Record<string, unknown>): boolean => emailWakeOriginCodec.validate(o);
ok(v({ ...origin }), "a well-formed origin validates");
ok(v({ ...origin, futureField: 1 }), "an unknown extra field is tolerated (stored-data compatibility)");
ok(!v({ ...origin, to: [] }), "no recipient refuses");
ok(!v({ ...origin, to: ["Not An Address"] }), "a malformed recipient refuses");
ok(!v({ ...origin, to: ["Bob@acme.com"] }), "a non-normalised recipient refuses");
ok(!v({ ...origin, cc: ["launch@agent.acme.com"] }), "the agent's own inbox as a recipient refuses");
ok(!v({ ...origin, cc: Array.from({ length: 20 }, (_, i) => `p${i}@acme.com`) }), "more than 20 recipients refuses");
ok(!v({ ...origin, threadId: "" }), "an empty thread refuses");
const ref = emailWakeOriginCodec.threadRef(origin);
ok(!ref.channelKey.includes(":") && !ref.threadKey.includes(":"), "the thread ref is colon-free");
ok(emailWakeOriginCodec.isThreadScoped(origin) === false, "an email wake is never thread-scoped");

const noticeSent: EmailReplyRequest[] = [];
const threaded: EmailTransport = {
  ...transport,
  reply: async (r) => (noticeSent.push(r), { messageId: "n1" }),
  readThread: async () => [
    { messageId: "m1", from: "Partner <partner@ext.com>", to: ["launch@agent.acme.com"], cc: ["stranger@else.com", "bob@acme.com"], sentAt: "2026-10-11T10:00:00Z", text: "hi" },
    { messageId: "m2", from: "launch@agent.acme.com", to: ["partner@ext.com"], sentAt: "2026-10-11T10:01:00Z", text: "reply" },
  ],
};
const ndeps = { policy: () => POLICY, principals: () => PRINCIPALS, transport: () => threaded };
ok((await postEmailThreadNotice("launch@agent.acme.com/t1", "Card posted.", ndeps)) === "n1", "a host notice sends one reply into the thread");
ok(noticeSent[0]!.inReplyToMessageId === "m1", "it answers the latest message from somebody other than the agent");
ok(noticeSent[0]!.to[0] === "partner@ext.com" && !noticeSent[0]!.cc.includes("stranger@else.com") && !noticeSent[0]!.cc.includes("launch@agent.acme.com"), "its recipients are the thread's allowed participants — never a stranger, never the agent");
await rejects(() => postEmailThreadNotice("not-an-address", "x", ndeps), "<inbox>/<thread>", "a malformed address refuses");
const strangersOnly: EmailTransport = { ...threaded, readThread: async () => [{ messageId: "m1", from: "stranger@else.com", to: ["launch@agent.acme.com"], sentAt: "", text: "" }] };
await rejects(() => postEmailThreadNotice("launch@agent.acme.com/t1", "x", { ...ndeps, transport: () => strangersOnly }), "nobody on the email thread may receive mail", "a thread with nobody allowed gets no notice");
const PERSONAL_POLICY: EmailPolicy = { ...POLICY, inboxes: [...POLICY.inboxes, { address: "oe@agent.acme.com", kind: "personal", allowedSenders: [], why: "chief of staff" }] };
const personalSent: EmailReplyRequest[] = [];
const tomOnly: EmailTransport = {
  ...transport,
  reply: async (r) => (personalSent.push(r), { messageId: "p1" }),
  readThread: async () => [
    { messageId: "m1", from: "rowan@acme.com", to: ["oe@agent.acme.com"], cc: ["bob@acme.com"], sentAt: "2026-10-11T10:00:00Z", text: "hi" },
    { messageId: "m2", from: "oe@agent.acme.com", to: ["rowan@acme.com"], sentAt: "2026-10-11T10:01:00Z", text: "answer", sent: true },
  ],
};
const pdeps = { policy: () => PERSONAL_POLICY, principals: () => PRINCIPALS, transport: () => tomOnly };
ok((await postEmailThreadNotice("oe@agent.acme.com/t1", "Done.", pdeps)) === "p1", "a personal-inbox notice sends");
ok(JSON.stringify(personalSent[0]!.to) === '["rowan@acme.com"]' && personalSent[0]!.cc.length === 0, "a personal-inbox notice goes to the thread's one person only, never to a Cc");
const tomAndBob: EmailTransport = {
  ...tomOnly,
  readThread: async () => [
    { messageId: "m1", from: "rowan@acme.com", to: ["oe@agent.acme.com"], cc: ["bob@acme.com"], sentAt: "2026-10-11T10:00:00Z", text: "hi" },
    { messageId: "m3", from: "bob@acme.com", to: ["oe@agent.acme.com", "rowan@acme.com"], sentAt: "2026-10-11T10:02:00Z", text: "reply-all" },
  ],
};
await rejects(() => postEmailThreadNotice("oe@agent.acme.com/t1", "Done.", { ...pdeps, transport: () => tomAndBob }), "exactly one person", "a personal-inbox thread with a second person gets no notice");
ok(personalSent.length === 1, "the refused notice sent nothing");
await rejects(() => emailMessageOps.editMessage("launch@agent.acme.com/t1", "m1", "x"), "cannot be edited", "an email cannot be edited");

console.log(`✓ email-post-arm-test: ${passed} assertions`);
