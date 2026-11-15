// proves: REPLY-58

import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-reply-follow-ups-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerSlackFixtureCodec, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
type PostIntent = import("../agent/channels/post-arms.js").PostIntent;
const { postReply, postHostNotice, replyAuditFor } = await import("../agent/channels/reply-post.js");
const { postUnifiedReply } = await import("../agent/channels/unified-reply.js");
const { editPostedMessage } = await import("../agent/channels/reply-edit.js");
const { recordOwnPost } = await import("../agent/channels/own-post-ledger.js");
const { normalizeFollowUps, FOLLOW_UP_MAX, FOLLOW_UP_TEXT_MAX } = await import("../agent/channels/reply-follow-ups.js");
const { unifiedReplyEntry, baseReplyEntry } = await import("../agent/tools/reply.js");
const editReply = await import("../agent/tools/edit_reply.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;

registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const ORG = "acme";
const TEAM = "T1";
const DM = "D1";
const CHAN = "C1";
const ANSWER = "Your next three meetings are on Thursday.";
const NEXT = ["Move the 2pm", "Show Friday too", "Draft an agenda"];

const calls: { member: string; channelId: string; text: string; intent: PostIntent | undefined; id: string }[] = [];
const last = () => calls[calls.length - 1];

registerPostArm({
  platform: "slack",
  resolveTarget: (bag) => {
    const channelId = bag.str("channelId");
    return channelId ? { platform: "slack", channelId } : null;
  },
  isDirectConversation: (locus) => locus.channelId.startsWith("D"),
  dispatchReply: async (target, text, _replier, intent) => {
    const id = `ts-${calls.length + 1}`;
    calls.push({ member: "dispatchReply", channelId: (target as { channelId: string }).channelId, text, intent, id });
    return id;
  },
  dispatchUnified: async (origin, text, _deps, _replier, intent) => {
    const id = `ts-${calls.length + 1}`;
    calls.push({ member: "dispatchUnified", channelId: (origin as { channelId: string }).channelId, text, intent, id });
    return id;
  },
  editMessage: async (locus, messageId, text, intent) => {
    calls.push({ member: "editMessage", channelId: locus.channelId, text, intent, id: messageId });
  },
});

function ctxFor(turnId: string, channelId: string): BindableContext {
  return {
    channel: { kind: "channel:slack" },
    session: {
      id: "reply-follow-ups-test",
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: {
            oe_platform: "slack",
            oe_grain: "standing",
            channel_id: channelId,
            team_id: TEAM,
            channel_type: channelId.startsWith("D") ? "im" : "channel",
            trust_checked: "true",
          },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as unknown as BindableContext;
}

const auditFor = (turnId: string, channelId: string) => replyAuditFor(ctxFor(turnId, channelId), "tool", `wake-${turnId}`);

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "reply-follow-ups-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

const shown = (): readonly string[] => last()?.intent?.followUps ?? [];

{
  ok(FOLLOW_UP_MAX === 3 && FOLLOW_UP_TEXT_MAX === 75, "§1: three follow-ups at most, 75 characters each (Slack's button label cap)");
  const tooLong = "x".repeat(FOLLOW_UP_TEXT_MAX + 1);
  const exact = "y".repeat(FOLLOW_UP_TEXT_MAX);
  const got = normalizeFollowUps(["  Move the\n2pm  ", "", "   ", tooLong, "move THE 2pm", exact, "Show Friday too", "Draft an agenda"]);
  ok(
    JSON.stringify(got) === JSON.stringify(["Move the 2pm", exact, "Show Friday too"]),
    `🔴 §1: one line each, blanks and repeats dropped, an over-long item DROPPED (never cut), at most three, in order (saw ${JSON.stringify(got)})`,
  );
  ok(normalizeFollowUps(undefined).length === 0 && normalizeFollowUps("Move it").length === 0 && normalizeFollowUps([1, null, {}]).length === 0, "§1: anything but a list of strings answers none");
  ok(normalizeFollowUps(["日本語".repeat(25)]).length === 1, "§1: the cap counts code points, not UTF-16 units");
  const hidden = ["Show Friday too\u{E0049}\u{E0047}\u{E004E}", "Move\u200Bthe 2pm", "Draft \u202Ean agenda", "Cancel\u0085it", "Close\nit", "Keep this one"];
  const kept = normalizeFollowUps(hidden);
  ok(JSON.stringify(kept) === JSON.stringify(["Close it", "Keep this one"]), `🔴 §1: an item with a format character is DROPPED, never stripped; a line break still reads as a space (saw ${JSON.stringify(kept)})`);
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    await postReply({ platform: "slack", channelId: DM }, ANSWER, auditFor("turn_2", DM), undefined, { followUps: NEXT });
  });
  ok(last()?.member === "dispatchReply" && last()?.channelId === DM, "§2 precondition: the per-surface reply reached the arm in the DM");
  ok(JSON.stringify(shown()) === JSON.stringify(NEXT), `🔴 §2: the per-surface 1:1 answer hands the arm its follow-ups (saw ${JSON.stringify(last()?.intent)})`);
  ok(last()?.text === ANSWER, "§2: the answer's text is unchanged — the follow-ups ride the intent, the arm draws them");
  await inTurn(async () => {
    await postUnifiedReply({ platform: "slack", channelId: DM }, ANSWER, {}, auditFor("turn_2u", DM), undefined, { terminal: true }, { followUps: NEXT });
  });
  ok(last()?.member === "dispatchUnified", "§2 precondition: the unified reply reached the arm");
  ok(JSON.stringify(shown()) === JSON.stringify(NEXT), `🔴 §2: the unified 1:1 answer hands the arm its follow-ups (saw ${JSON.stringify(last()?.intent)})`);
  ok(last()?.intent?.feedback === true, "§2: …beside the thumbs, which do not change");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    await postReply({ platform: "slack", channelId: CHAN }, ANSWER, auditFor("turn_3", CHAN), undefined, { followUps: NEXT });
  });
  ok(last()?.channelId === CHAN && shown().length === 0, `🔴 §3: an answer in a SHARED room carries no follow-ups (saw ${JSON.stringify(last()?.intent)})`);
  ok(last()?.intent?.feedback === true, "§3: …and the thumbs still go out");
  await inTurn(async () => {
    await postUnifiedReply({ platform: "slack", channelId: CHAN }, ANSWER, {}, auditFor("turn_3u", CHAN), undefined, { terminal: true }, { followUps: NEXT });
  });
  ok(shown().length === 0, "🔴 §3: …on the unified door too");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    await postUnifiedReply({ platform: "slack", channelId: DM }, "Looking now, one moment.", {}, auditFor("turn_4", DM), undefined, { terminal: false }, { followUps: NEXT });
  });
  ok(last()?.intent?.terminal === false && shown().length === 0, `🔴 §4: a done:false part carries no follow-ups (saw ${JSON.stringify(last()?.intent)})`);
  await inTurn(async () => {
    await postReply({ platform: "slack", channelId: DM }, "Connect Notion here: (a host link)", auditFor("turn_4h", DM), undefined, { host: true, followUps: NEXT });
  });
  ok(shown().length === 0, "🔴 §4: a host post carries no follow-ups");
  await postHostNotice({ platform: "slack", channelId: DM }, "Heads up: the connector is reconnecting.");
  ok(shown().length === 0, "§4: a host notice carries none");
  await inTurn(async () => {
    await postReply({ platform: "slack", channelId: DM }, `${ANSWER} plain`, auditFor("turn_4n", DM));
  });
  ok(last()?.intent !== undefined && !("followUps" in (last()?.intent ?? {})), "§4: an answer that offers none hands the arm no follow-up field at all");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    await recordOwnPost(ORG, { platform: "slack", channelId: DM }, "ts-own-5");
    await editPostedMessage({ platform: "slack", channelId: DM }, "ts-own-5", `${ANSWER} (edited)`, auditFor("turn_5", DM), {}, { followUps: NEXT });
  });
  ok(last()?.member === "editMessage", "§5 precondition: the edit reached the arm");
  ok(JSON.stringify(shown()) === JSON.stringify(NEXT), `🔴 §5: an edit of a 1:1 answer carries the follow-ups (saw ${JSON.stringify(last()?.intent)})`);
  await inTurn(async () => {
    await editPostedMessage({ platform: "slack", channelId: DM }, "ts-own-5", `${ANSWER} (edited again)`, auditFor("turn_5b", DM));
  });
  ok(shown().length === 0, "§5: an edit that names none hands the arm none");
  await inTurn(async () => {
    await recordOwnPost(ORG, { platform: "slack", channelId: CHAN }, "ts-own-5c");
    await editPostedMessage({ platform: "slack", channelId: CHAN }, "ts-own-5c", `${ANSWER} (edited)`, auditFor("turn_5c", CHAN), {}, { followUps: NEXT });
  });
  ok(shown().length === 0, "🔴 §5: an edit in a SHARED room carries none");
}

{
  type Schema = { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
  const schemaOf = (tool: unknown): Schema => (tool as { inputSchema: Schema }).inputSchema;
  const messy = ["a".repeat(500), "", "One", "Two", "Three", "Four"];
  const u = schemaOf(unifiedReplyEntry).safeParse({ text: ANSWER, wake: "w1", followUps: messy });
  ok(u.success && Array.isArray(u.data?.followUps), "🔴 §6: the unified `reply` accepts followUps, an over-long and a fourth item included");
  const b = schemaOf(baseReplyEntry).safeParse({ text: ANSWER, followUps: messy });
  ok(b.success && Array.isArray(b.data?.followUps), "🔴 §6: the per-surface `reply` accepts followUps");
  ok(schemaOf(baseReplyEntry).safeParse({ text: ANSWER }).success, "§6: followUps stays optional");
  const e = schemaOf(editReply.unifiedEditReplyEntry).safeParse({ text: ANSWER, wake: "w1", message_id: "ts-1", followUps: messy });
  ok(e.success && Array.isArray(e.data?.followUps), "🔴 §6: the unified `edit_reply` accepts followUps");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    await postReply({ platform: "slack", channelId: DM }, "Ask <@U0SOMEONE1> for the deck.", auditFor("turn_8", DM), undefined, { followUps: ["Ask <@U0SOMEONE1> about it"] });
  });
  const item = shown()[0] ?? "";
  ok(item.length > 0 && !item.includes("<@") && !item.includes("U0SOMEONE1"), `🔴 §8: a follow-up that names a person carries no mention token and no raw id (saw ${JSON.stringify(item)})`);
  ok(last()?.text.includes("<@U0SOMEONE1>") === true, "§8 control: the answer's body still renders a mention, by the body rule");
}

{
  registerPostArm({
    platform: "slack",
    dispatchReply: async (target, text, _replier, intent) => {
      const id = `ts-${calls.length + 1}`;
      calls.push({ member: "dispatchReply", channelId: (target as { channelId: string }).channelId, text, intent, id });
      return id;
    },
  });
  const inTurn = newSession();
  await inTurn(async () => {
    await postReply({ platform: "slack", channelId: DM }, `${ANSWER} unproved`, auditFor("turn_7", DM), undefined, { followUps: NEXT });
  });
  ok(shown().length === 0, `🔴 §7: no proof of a 1:1 conversation, no follow-ups (saw ${JSON.stringify(last()?.intent)})`);
}

await removeTempDir(dir);
console.log(`reply-follow-ups: ${passed} assertions passed`);
