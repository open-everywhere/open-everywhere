import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-email-integration-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerEmailProvider } = await import("@open-everywhere/provider-email/agent/register.js");
const { isOperatorSecretName } = await import("@open-everywhere/core/agent/ops/operator-secret-roster.js");
const { buildEmailAuth } = await import("@open-everywhere/provider-email/agent/channels/email-identity.js");
const { capabilitiesForPlatform, bindFrom, supportedReadPlatforms, emailTransport, registerEmailTransport, wakeOriginCodec } = await import("@open-everywhere/core/agent/adapter-api.js");
const { postArm } = await import("@open-everywhere/core/agent/channels/post-arms.js");
const { isUnifiedWakeOrigin, unifiedThreadRef, wakeBindingMatchesOrigin, isWakeSurfaceBinding } = await import("@open-everywhere/core/agent/channels/unified-window.js");
const { postUnifiedReply } = await import("@open-everywhere/core/agent/channels/unified-reply.js");
const { surfaceParityFor } = await import("@open-everywhere/core/agent/identity/surface-parity.js");
const { registerEmailPolicy, emailPolicy, resetEmailPolicyForTest } = await import("@open-everywhere/core/agent/email/policy.js");
import type { EmailReplyRequest, RenderedLine, UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  passed++;
};

await import("../agent/email/policy.js");
ok(emailPolicy().enabled === false, "the app's email policy registers and ships OFF");

registerEmailProvider();
ok(capabilitiesForPlatform("email").midTurnPost === true, "the manifest arms `reply` on email");
ok(capabilitiesForPlatform("email").reactions === false, "the manifest arms no reactions on email");
ok(typeof postArm("email")?.dispatchUnified === "function", "the email post arm is registered");
ok(postArm("email")?.editMessage === undefined, "the email post arm registers no edit (a sent mail cannot change)");
ok(wakeOriginCodec("email") !== undefined, "the email wake-origin codec is registered");
ok(supportedReadPlatforms().includes("email"), "the email read adapter is registered");
ok(surfaceParityFor("email") !== undefined, "the email surface parity declaration is registered");
ok(emailTransport("agentmail")?.id === "agentmail" && emailTransport("agentmail-eu")?.id === "agentmail-eu", "both AgentMail transports are registered");
ok(["AGENTMAIL_API_KEY", "AGENTMAIL_WEBHOOK_SECRET"].every(isOperatorSecretName), "the AgentMail key and webhook secret are on the operator-secret roster (adopt_env_secrets accepts them)");

type EmailOrigin = Extract<UnifiedWakeOrigin, { platform: "email" }>;
const origin: EmailOrigin = { platform: "email", inbox: "launch@agent.acme.com", threadId: "thr_1", messageId: "<m1>", to: ["ann@acme.com"], cc: ["bob@acme.com"] };
ok(isUnifiedWakeOrigin(origin), "a stored email origin validates through core");
ok(!isUnifiedWakeOrigin({ ...origin, to: ["launch@agent.acme.com"] }), "an origin that mails the agent's own inbox does not validate");
ok(unifiedThreadRef(origin).threadKey === "thr_1", "the thread ref is the codec's");

const auth = buildEmailAuth({
  inbox: "launch@agent.acme.com",
  domain: "agent.acme.com",
  surface: "launch",
  mode: "channel",
  trust: "internal",
  sender: "ann@acme.com",
  threadId: "thr_1",
  messageId: "<m1>",
});
const binding = bindFrom({ channel: { kind: "email" }, session: { auth: { current: auth as never } } });
ok(binding.platform === "email" && binding.workspace === "agent.acme.com" && binding.surface === "launch", "bindFrom resolves the email binding through the registered mapper");
ok(binding.visibility === "private" && binding.trust === "internal" && binding.mode === "channel", "the binding is private, with the gate's trust");
ok(wakeBindingMatchesOrigin(binding, origin), "the binding matches the origin it was frozen beside");
ok(!wakeBindingMatchesOrigin(binding, { ...origin, threadId: "thr_2" }), "an origin for another thread does not match");
ok(isWakeSurfaceBinding(JSON.parse(JSON.stringify(binding))), "the binding survives the durable frozen-binding grammar");
const external = bindFrom({ channel: { kind: "email" }, session: { auth: { current: { ...auth, attributes: { ...auth.attributes, email_trust: "external" } } as never } } });
ok(external.trust === "external", "an outside sender's binding is external");
const { registerSurfaces, defineSurface } = await import("@open-everywhere/core/agent/identity/trust.js");
registerSurfaces([defineSurface({ key: "email/agent.acme.com/launch", trust: "internal" })]);
const vouchedExternal = bindFrom({ channel: { kind: "email" }, session: { auth: { current: { ...auth, attributes: { ...auth.attributes, email_trust: "external" } } as never } } });
ok(vouchedExternal.trust === "external", "vouching the inbox does not promote an outside sender");
registerSurfaces([]);

const sent: EmailReplyRequest[] = [];
registerEmailTransport({
  id: "it-fake",
  sharedDomains: [],
  verify: async () => ({ ok: true }),
  parse: () => null,
  reply: async (r) => (sent.push(r), { messageId: "<reply-1>" }),
});
resetEmailPolicyForTest();
registerEmailPolicy({
  enabled: true,
  transport: "it-fake",
  orgDomains: ["acme.com"],
  maxRecipients: 10,
  maxInboundChars: 20_000,
  inboxes: [{ address: "launch@agent.acme.com", kind: "room", allowedSenders: ["*@acme.com"], why: "launch" }],
});
const id = await postUnifiedReply(origin, "Launch is Thursday.");
ok(id === "<reply-1>", "postUnifiedReply returns the transport's message id");
ok(sent.length === 1 && sent[0]!.inReplyToMessageId === "<m1>" && sent[0]!.to[0] === "ann@acme.com" && sent[0]!.cc[0] === "bob@acme.com", "the reply reaches the transport with the frozen recipients, threaded");
ok(sent[0]!.text.includes("Launch is Thursday."), "the reply carries the seat's text");

const { emailReadAdapter } = await import("@open-everywhere/provider-email/agent/channels/email-read.js");
registerEmailTransport({
  id: "it-fake",
  sharedDomains: [],
  verify: async () => ({ ok: true }),
  parse: () => null,
  reply: async (r) => (sent.push(r), { messageId: "<reply-1>" }),
  readThread: async () => [
    { messageId: "m1", from: "Ann <ann@acme.com>", sentAt: "2026-10-11T10:00:00Z", text: "internal" },
    { messageId: "m2", from: "launch@agent.acme.com", sentAt: "2026-10-11T10:01:00Z", text: "the agent", sent: true },
    { messageId: "m3", from: "launch@agent.acme.com", sentAt: "2026-10-11T10:02:00Z", text: "spoofed self" },
    { messageId: "m4", from: "ceo@acme.com", sentAt: "2026-10-11T10:03:00Z", text: "spoofed ceo", suspect: true },
    { messageId: "m5", from: "<a@x.com> <b@y.com>", sentAt: "2026-10-11T10:04:00Z", text: "unparseable" },
    { messageId: "m6", from: "partner@ext.com", sentAt: "2026-10-11T10:05:00Z", text: "outsider" },
  ],
});
const readCtx = { channel: { kind: "email" }, session: { auth: { current: auth as never } } } as never;
const lines = (await emailReadAdapter.readThread(readCtx, "launch@agent.acme.com", "thr_1", 10)) as readonly RenderedLine[];
const refuted = new Set(await emailReadAdapter.refutedAuthorIds!(readCtx, lines));
const byText = (t: string) => lines.find((l) => l.text === t)!;
ok(byText("the agent").bot === true, "a message the transport reports SENT is the agent's own line");
ok(byText("spoofed self").bot !== true && refuted.has(byText("spoofed self").authorId!), "a received message claiming the agent's own From is neither the agent's line nor trusted: it is refuted");
ok(refuted.has(byText("spoofed ceo").authorId!), "a flagged message is refuted even with an org From");
ok(byText("unparseable").authorId !== undefined && refuted.has(byText("unparseable").authorId!), "an unparseable From is refuted under a sentinel id, never skipped");
ok(refuted.has("partner@ext.com"), "an author off the org's domains is refuted");
ok(!refuted.has("ann@acme.com"), "an unflagged org author is not refuted");

resetEmailPolicyForTest();
registerEmailPolicy({
  enabled: true,
  transport: "it-fake",
  orgDomains: ["acme.com"],
  maxRecipients: 10,
  maxInboundChars: 20_000,
  inboxes: [
    { address: "launch@agent.acme.com", kind: "room", allowedSenders: ["*@acme.com"], why: "launch" },
    { address: "oe@agent.acme.com", kind: "personal", allowedSenders: [], why: "chief of staff" },
  ],
});
registerEmailTransport({
  id: "it-fake",
  sharedDomains: [],
  verify: async () => ({ ok: true }),
  parse: () => null,
  reply: async (r) => (sent.push(r), { messageId: "<reply-1>" }),
  readThread: async () => [
    { messageId: "p1", from: "rowan@acme.com", to: ["oe@agent.acme.com"], cc: ["bob@acme.com"], sentAt: "2026-10-11T10:00:00Z", text: "rowan asks" },
    { messageId: "p2", from: "oe@agent.acme.com", to: ["rowan@acme.com"], sentAt: "2026-10-11T10:01:00Z", text: "rowan's private answer", sent: true },
    { messageId: "p3", from: "bob@acme.com", to: ["oe@agent.acme.com", "rowan@acme.com"], sentAt: "2026-10-11T10:02:00Z", text: "bob reply-all" },
  ],
});
const dmAuth = (who: string) =>
  buildEmailAuth({ inbox: "oe@agent.acme.com", domain: "agent.acme.com", surface: "dm-x", mode: "dm", trust: "internal", sender: who, threadId: "thr_p", messageId: "p3" });
const bobCtx = { channel: { kind: "email" }, session: { auth: { current: dmAuth("bob@acme.com") as never } } } as never;
const bobLines = (await emailReadAdapter.readThread(bobCtx, "oe@agent.acme.com", "thr_p", 10)) as readonly RenderedLine[];
ok(!bobLines.some((l) => l.text === "rowan's private answer" || l.text === "rowan asks"), "a colleague's DM seat never reads another person's mail or the agent's answer to them");
ok(bobLines.length === 1 && bobLines[0]!.text === "bob reply-all", "a DM read keeps the bound person's own mail");
const rowanCtx = { channel: { kind: "email" }, session: { auth: { current: dmAuth("rowan@acme.com") as never } } } as never;
const rowanLines = (await emailReadAdapter.readThread(rowanCtx, "oe@agent.acme.com", "thr_p", 10)) as readonly RenderedLine[];
ok(rowanLines.map((l) => l.text).join("|") === "rowan asks|rowan's private answer", "the owner's DM read keeps their own mail and the agent's answer to them alone");

const badCtx = { channel: { kind: "email" }, session: { auth: { current: { ...dmAuth("rowan@acme.com"), principalId: "not an address" } as never } } } as never;
let badErr = "";
try {
  await emailReadAdapter.readThread(badCtx, "oe@agent.acme.com", "thr_p", 10);
} catch (e) {
  badErr = String(e);
}
ok(badErr.includes("needs the person this DM belongs to"), "a DM read with a principal that is not an address refuses");

console.log(`✓ email-provider-integration-test: ${passed} assertions`);
