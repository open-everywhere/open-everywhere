import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `oe-friendly-ids-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { personWords, placeWords, rawIdLeaks, requesterWords, samePerson } = await import("../agent/channels/friendly-ids.js");
const { dmDeliveryFooter, dmStoppedRefusalMessage, dmUnreadableRefusalMessage } = await import("../agent/channels/dm-audience.js");
const { signInCardText } = await import("../agent/approvals/connector-op.js");
const cr = await import("../agent/connections/consent-resume.js");
const { grantRoomNoticeText } = await import("../agent/access/credential-grant-notice.js");
const { grantFooterPlace } = await import("../agent/access/credential-grant-card.js");
const { blockedPingText } = await import("../agent/status/attention.js");
await import("../agent/approvals/chat-dm.js");
const { actionKind } = await import("../agent/approvals/actions.js");

let n = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  n++;
}
function eq<T>(a: T, b: T, msg: string): void {
  assert.deepEqual(a, b, msg);
  n++;
}
function clean(text: string, what: string): void {
  eq(rawIdLeaks(text), [], `${what} carries no raw id or key (got ${JSON.stringify(text)})`);
}

const ROWAN = "U0EXOWNER";
const TEAM = "T0EXAMPLE";
const DM = `slack/${TEAM}/D0EXAMPLE`;
const ROOM = `slack/${TEAM}/C0123ABCD`;

eq(personWords({ id: ROWAN, platform: "slack", reader: ROWAN }), "you", "the reader is \"you\"");
eq(personWords({ id: `slack/${TEAM}/${ROWAN}`, reader: ROWAN }), "you", "…matched across a principal key and a bare id");
eq(personWords({ id: ROWAN, platform: "slack" }), `<@${ROWAN}>`, "a Slack person renders as the platform mention");
eq(personWords({ id: "discord/123456789012345678" }), "<@123456789012345678>", "a Discord principal key renders as the mention");
eq(personWords({ id: ROWAN, platform: "slack", label: "Rowan Lee" }), "Rowan Lee", "a resolved display name wins");
eq(personWords({ id: ROWAN, platform: "slack", label: ROWAN }), `<@${ROWAN}>`, "a label that only repeats the id is not a name");
eq(personWords({ id: "29:1abcDEF", platform: "teams" }), "someone", "a platform with no mention syntax and no label says \"someone\", never the id");
eq(requesterWords(ROWAN, ROOM), `<@${ROWAN}>`, "a card's requester takes the platform from the scope key it was proposed in");
ok(samePerson(`slack/${TEAM}/${ROWAN}`, ROWAN) && !samePerson(ROWAN, "U0OTHER001"), "samePerson compares the native ids");

eq(placeWords({ key: ROOM }), "<#C0123ABCD>", "a Slack channel renders as the channel mention");
eq(placeWords({ key: DM }), "a direct message", "a Slack DM renders as plain words");
eq(placeWords({ key: `slack/${TEAM}` }), "your Slack workspace", "a workspace key renders as plain words");
eq(placeWords({ key: "teams/tenant-1/19:abc@thread.v2" }), "a Microsoft Teams conversation", "a Teams conversation renders as plain words");
eq(placeWords({ key: "github/acme/widgets" }), "acme/widgets", "a GitHub room renders as its readable owner/repo");
eq(rawIdLeaks("Target: acme/widgets"), [], "…which is not a leak");
eq(placeWords({ key: ROOM, label: "#launch" }), "#launch", "a resolved label wins");
eq(placeWords({ key: "wrun_example79" }), "another conversation", "an eve session id never renders");
eq(placeWords({ key: "oe-grant-room::eng::C1" }), "another conversation", "a grant room key never renders");
eq(placeWords({ key: "eng" }), "the eng domain", "a domain name renders as words");
eq(placeWords({ key: `user:slack/${TEAM}/${ROWAN}` }), `<@${ROWAN}>`, "a person's scope renders as that person");

eq(rawIdLeaks(`Sent by the agent on behalf of ${ROWAN}, from slack/${TEAM}.`), [ROWAN, `slack/${TEAM}`], "🔴 the live footer leaks both the member id and the scope key, in text order");
ok(rawIdLeaks("in wrun_example79").length === 1, "an eve session id is a leak");
ok(rawIdLeaks(`asked by <@${ROWAN}> in <#C0123ABCD>`).length === 0, "a platform mention is not a leak");
ok(rawIdLeaks(`open https://example.com/${ROWAN}/x`).length === 0, "an id inside a URL is not a leak");
ok(rawIdLeaks("SUMMARY THE CHANGELOG").length === 0, "an all-capitals word with no digit is not an id");

const toRowanFromAnother = dmDeliveryFooter({ platform: "slack", recipientId: "U0BOB00001", requestedBy: `slack/${TEAM}/${ROWAN}`, from: ROOM });
clean(toRowanFromAnother, "a footer for somebody else's errand");
ok(toRowanFromAnother.includes(`<@${ROWAN}> asked for this in <#C0123ABCD>.`), "…names who asked and where, as mentions");
ok(toRowanFromAnother.includes("Reply here to ask me to stop"), "…and keeps the stop line");
const ownFromRoom = dmDeliveryFooter({ platform: "slack", recipientId: ROWAN, requestedBy: ROWAN, from: ROOM });
clean(ownFromRoom, "a footer for the reader's own errand");
ok(ownFromRoom.includes("_You asked for this in <#C0123ABCD>."), "…says \"you\"");
eq(dmDeliveryFooter({ platform: "slack", recipientId: ROWAN, requestedBy: ROWAN, from: DM, sameConversation: true }), "", "🔴 a DM in the conversation the person asked from carries no footer at all");
ok(dmDeliveryFooter({ platform: "slack", recipientId: "U0BOB00001", requestedBy: ROWAN, from: DM, sameConversation: true }).includes("Reply here to ask me to stop"), "🔴 a DM to anyone but the person who asked keeps the stop line, even marked same-conversation");
const grantFooter = dmDeliveryFooter({ platform: "slack", recipientId: "U0BOB00001", requestedBy: `slack/${TEAM}/${ROWAN}`, ...grantFooterPlace("wrun_example79", undefined) });
clean(grantFooter, "a grant card's footer keyed on an eve session");
ok(grantFooter.includes("in another conversation."), "…which names the place in plain words");
const pingFooter = dmDeliveryFooter({ platform: "slack", recipientId: ROWAN, requestedBy: ROWAN });
eq(pingFooter, "\n\n_You asked for this. Reply here to ask me to stop and I will not start another DM with you._", "the blocked ping's footer says \"you\" and names no place");

const card = signInCardText({ connector: "notion", url: "https://connect.example.com/auth/LINK", resumes: true });
clean(card, "the sign-in card");
ok(card.includes("your own Notion account") && card.includes("Once you connect it, I pick the job up again."), "…names the vendor and says the job resumes on its own");
ok(!/say so|say the word/i.test(card), "…and asks for nothing but the sign-in");
const noResume = signInCardText({ connector: "notion", url: "https://connect.example.com/auth/LINK" });
clean(noResume, "the sign-in card with no recorded detour");
ok(noResume.includes("tell me here and I'll pick the job up") && !noResume.includes("I pick the job up again"), "🔴 with no consent detour recorded, the card promises no automatic resume");

const rec = { detourId: "d", connector: "notion", origin: { org: "default", surfaceKey: DM, target: { platform: "slack", channelId: "D0EXAMPLE" } as never, principalId: ROWAN }, startedAtMs: 0, expiresAtMs: 1 };
for (const [what, line] of [["resumed", cr.consentResumedLine(rec)], ["offer", cr.consentResumeOfferLine(rec)], ["expired", cr.consentExpiredLine(rec)]] as const) {
  clean(line, `the ${what} consent line`);
  ok(!/say the word/i.test(line), `the ${what} consent line never says "say the word"`);
}

const notice = grantRoomNoticeText("The line.", { requesterPrincipalId: `slack/${TEAM}/${ROWAN}`, ownerSlug: "bob" }, "2026-10-11T12:00:00.000Z");
clean(notice, "the grant room notice");

clean(blockedPingText("Waiting on your review", "<#C0123ABCD>"), "the blocked ping");

const chatDm = actionKind("chat.dm")!;
const dmArgs = { org: "default", scopeKey: ROOM, platform: "slack", principalId: "U0SARAH001", grant: "slack:person/U0SARAH001", text: "Hello.", footer: toRowanFromAnother, requestedBy: ROWAN };
clean((chatDm.summarize(dmArgs as never) as string[]).join("\n"), "the chat-DM card");
clean(chatDm.plainSummary!(dmArgs as never), "the chat-DM card's plain summary");

clean(dmStoppedRefusalMessage("slack", "U0SARAH001"), "the stopped-recipient refusal");
clean(dmUnreadableRefusalMessage("slack", "U0SARAH001"), "the unreadable-stop refusal");

rmSync(dir, { recursive: true, force: true });
console.log(`✓ friendly-ids: ${n} assertions passed`);
