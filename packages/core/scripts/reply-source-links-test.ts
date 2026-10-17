// proves: REPLY-56, REPLY-57

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

const dir = join(tmpdir(), `open-everywhere-reply-source-links-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerSlackFixtureCodec, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
type PostIntent = import("../agent/channels/post-arms.js").PostIntent;
const { postReply, postHostNotice, replyAuditFor } = await import("../agent/channels/reply-post.js");
type ReplyAudit = import("../agent/channels/reply-post.js").ReplyAudit;
const { postUnifiedReply } = await import("../agent/channels/unified-reply.js");
const { editPostedMessage } = await import("../agent/channels/reply-edit.js");
const { recordOwnPost } = await import("../agent/channels/own-post-ledger.js");
const { MAX_SOURCE_LINKS, REPLY_PROVENANCE_ACTION } = await import("../agent/channels/reply-provenance.js");
const { noteAuthoredRecordRead } = await import("../agent/channels/read-reach.js");
const { recordReplyFeedback, REPLY_FEEDBACK_ACTION } = await import("../agent/channels/reply-feedback.js");

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
const OTHER_DM = "D2";
const CHAN = "C1";
const ANSWER = "The launch is on track for Thursday.";
const TITLE = "Launch checklist";
const URL_ = "https://www.notion.so/Launch-checklist-0123456789abcdef0123456789abcdef";
const PAGE = "0123456789abcdef0123456789abcdef";

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
      id: "reply-source-links-test",
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

function auditFor(turnId: string, channelId: string): ReplyAudit {
  return replyAuditFor(ctxFor(turnId, channelId), "tool", `wake-${turnId}`);
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "reply-source-links-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

const read = (turnId: string, channelId: string, over: { id?: string; name?: string; url?: string } = {}): void =>
  noteAuthoredRecordRead(ctxFor(turnId, channelId), { kind: "notion-page", id: over.id ?? PAGE, name: over.name ?? TITLE, url: over.url ?? URL_ });

async function rowFor(messageId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await readAudit({ org: ORG, action: REPLY_PROVENANCE_ACTION });
  return [...rows].reverse().find((r) => (r.detail as { id?: string } | undefined)?.id === messageId)?.detail as Record<string, unknown> | undefined;
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    read("turn_1", DM);
    await postReply({ platform: "slack", channelId: DM }, ANSWER, auditFor("turn_1", DM));
  });
  const c = last();
  ok(c?.member === "dispatchReply" && c.channelId === DM, "§1 precondition: the reply reached the arm in the DM");
  ok(
    c?.intent?.sources?.length === 1 && c.intent.sources[0]?.name === TITLE && c.intent.sources[0]?.url === URL_ && c.intent.sources[0]?.kind === "notion-page",
    `🔴 §1: the 1:1 reply hands the arm ONE numbered source link with the record's title and url (saw ${JSON.stringify(c?.intent)})`,
  );
  ok(c?.intent?.feedback === true && c.intent.terminal === true, "🔴 §1: …and asks for the native thumbs on the answer");
  ok(c?.text === ANSWER, "§1: the answer's text is unchanged — the link rides the intent, the arm draws it");
  const row = await rowFor(c!.id);
  ok(row?.links === 1, `🔴 §1: the reply.provenance row counts the ONE link the room saw (saw ${JSON.stringify(row)})`);
  ok(!JSON.stringify(row).includes(URL_), "§1: the row never carries the url");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    read("turn_2", CHAN);
    await postReply({ platform: "slack", channelId: CHAN }, ANSWER, auditFor("turn_2", CHAN));
  });
  const c = last();
  ok(c?.channelId === CHAN && (c.intent?.sources ?? []).length === 0, `🔴 §2: a reply in a SHARED room cites nothing (saw ${JSON.stringify(c?.intent)})`);
  ok(c?.intent?.feedback === true, "§2: …and the thumbs still go out");
  ok((await rowFor(c!.id))?.links === 0, "§2: the row records zero links");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    read("turn_3", OTHER_DM);
    await postReply({ platform: "slack", channelId: DM }, ANSWER, auditFor("turn_3", DM));
  });
  ok((last()?.intent?.sources ?? []).length === 0, `🔴 §3: a read scoped to ANOTHER conversation is never cited (saw ${JSON.stringify(last()?.intent)})`);
}

{
  const bad = ["http://www.notion.so/page", "javascript:alert(1)", "https://evil.example/a>b", "https://evil.example/a|b", "https://evil.example/a b", `https://x.example/${"a".repeat(600)}`];
  for (const [i, url] of bad.entries()) {
    const inTurn = newSession();
    await inTurn(async () => {
      read(`turn_4_${i}`, DM, { url });
      await postReply({ platform: "slack", channelId: DM }, `${ANSWER} ${i}`, auditFor(`turn_4_${i}`, DM));
    });
    ok((last()?.intent?.sources ?? []).length === 0, `🔴 §4: an unfit url is never cited — ${JSON.stringify(url.slice(0, 40))}`);
  }
  const inTurn = newSession();
  await inTurn(async () => {
    read("turn_4_title", DM, { name: "Plan\n[click](https://evil.example) <b>|x</b> *now*" });
    await postReply({ platform: "slack", channelId: DM }, `${ANSWER} title`, auditFor("turn_4_title", DM));
  });
  const name = last()?.intent?.sources?.[0]?.name ?? "";
  ok(name.length > 0 && !/[\n<>|[\]*]/u.test(name), `🔴 §4: a title is flattened to one line with no link grammar (saw ${JSON.stringify(name)})`);
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    for (let i = 0; i < MAX_SOURCE_LINKS + 2; i++) read("turn_5", DM, { id: `page-${i}`, name: `Page ${i}`, url: `https://www.notion.so/page-${i}` });
    read("turn_5", DM, { id: "page-0", name: "Page 0", url: "https://www.notion.so/page-0" });
    await postReply({ platform: "slack", channelId: DM }, `${ANSWER} many`, auditFor("turn_5", DM));
  });
  const names = (last()?.intent?.sources ?? []).map((s) => s.name);
  ok(
    names.length === MAX_SOURCE_LINKS && names.join(",") === Array.from({ length: MAX_SOURCE_LINKS }, (_, i) => `Page ${i}`).join(","),
    `🔴 §5: at most ${MAX_SOURCE_LINKS} links, in first-read order, one per record (saw ${JSON.stringify(names)})`,
  );
}

{
  await postHostNotice({ platform: "slack", channelId: DM }, "Heads up: the connector is reconnecting.");
  ok(last()?.intent?.feedback !== true && last()?.intent?.generated !== true, `🔴 §6: a HOST notice is not an answer: no thumbs, and not marked generated (saw ${JSON.stringify(last()?.intent)})`);
  const inTurn = newSession();
  await inTurn(async () => {
    const audit = replyAuditFor(ctxFor("turn_6", DM), "tool", "wake-6");
    read("turn_6", DM);
    await postUnifiedReply({ platform: "slack", channelId: DM }, "Working on it, part one.", {}, audit, undefined, { terminal: false });
    ok(last()?.member === "dispatchUnified" && last()?.intent?.feedback !== true, `🔴 §6: a NON-terminal part gets no thumbs (saw ${JSON.stringify(last()?.intent)})`);
    ok((last()?.intent?.sources ?? []).length === 0, "🔴 §6: …and no links: they go under the whole answer once, never under a part");
    ok(last()?.intent?.generated === true, "§6: …but it is model text, so it is marked generated");
    ok((await rowFor(last()!.id))?.links === 0, "🔴 §6: …and its reply.provenance row counts ZERO links, because the arm was handed none");
    await postUnifiedReply({ platform: "slack", channelId: DM }, "Here is the whole answer.", {}, audit, undefined, { terminal: true });
    ok(last()?.intent?.feedback === true, "§6: …and the terminal part of the same reply does");
    ok(last()?.intent?.sources?.[0]?.url === URL_, `🔴 §6 POSITIVE CONTROL: the terminal post of the same turn DOES carry the link (saw ${JSON.stringify(last()?.intent)})`);
    ok((await rowFor(last()!.id))?.links === 1, "§6: …and its row counts it");
  });
}

{
  const { postDomainAnswerFallback } = await import("../agent/tools/answer_domain_question.js");
  await postDomainAnswerFallback({ platform: "slack", channelId: DM }, { domain: { name: "launch", title: "Launch" }, question: "When do we ship?", answer: "Friday.", declined: false });
  const c = last();
  ok(c?.member === "dispatchUnified" && c.text.includes("Friday."), `§6b precondition: the fallback reached the arm through the unified door (saw ${JSON.stringify(c)})`);
  ok(c?.intent?.generated === true, `🔴 §6b/OPE-2542: the domain-answer fallback relays model text, so it is marked generated (saw ${JSON.stringify(c?.intent)})`);
  ok(c?.intent?.feedback !== true && (c?.intent?.sources ?? []).length === 0, "§6b: …and it carries no thumbs and no links: it has no reply audit");
  await postUnifiedReply({ platform: "slack", channelId: DM }, "A host line through the same door.");
  ok(last()?.intent?.generated !== true, `🔴 §6b NEGATIVE CONTROL: the same door with no audit and no flag is NOT marked (saw ${JSON.stringify(last()?.intent)})`);
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    read("turn_7", DM);
    const audit = auditFor("turn_7", DM);
    await recordOwnPost(ORG, { platform: "slack", channelId: DM }, "ts-own-7");
    await editPostedMessage({ platform: "slack", channelId: DM }, "ts-own-7", `${ANSWER} (edited)`, audit);
  });
  const c = last();
  ok(c?.member === "editMessage", "§7 precondition: the edit reached the arm");
  ok(c?.intent?.sources?.[0]?.url === URL_ && c.intent.feedback === true, `🔴 §7: an edit carries the links and the thumbs again (saw ${JSON.stringify(c?.intent)})`);
}

{
  const wrote = await recordReplyFeedback({
    surface: "teams",
    rating: "down",
    raterId: "29:person",
    channelId: "a:conv",
    messageId: "act-1",
    commentChars: 42,
    org: ORG,
    platform: "teams",
    workspace: "TEN1",
    surfaceKey: "teams/TEN1/a:conv",
  });
  ok(wrote, "§8: the row was written");
  const rows = await readAudit({ org: ORG, action: REPLY_FEEDBACK_ACTION });
  const d = rows[rows.length - 1]?.detail as Record<string, unknown> | undefined;
  ok(
    d?.rating === "down" && d.messageId === "act-1" && d.channelId === "a:conv" && d.surface === "teams" && d.via === "native",
    `🔴 §8: reply.feedback carries the rating and the rated message's ids (saw ${JSON.stringify(d)})`,
  );
  ok(d?.comment === true && d.commentChars === 42 && Object.keys(d).every((k) => !/text|words/u.test(k)), "🔴 §8: …and THAT a comment came, with its length — never its words");
  ok(rows[rows.length - 1]?.principalId === "29:person", "§8: the rater is the row's principal");
  ok(!(await recordReplyFeedback({ surface: "slack", rating: "up", raterId: "", channelId: "D1", messageId: "1.2", org: ORG, platform: "slack", workspace: TEAM, surfaceKey: "slack/T1/D1" })), "§8: a click with no rater writes nothing");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    read("turn_8b", DM);
    await postReply({ platform: "slack", channelId: DM }, "Connect Notion here: (a host link)", auditFor("turn_8b", DM), undefined, { host: true });
  });
  const c = last();
  ok(
    c?.intent?.feedback !== true && c?.intent?.generated !== true && (c?.intent?.sources ?? []).length === 0,
    `🔴 §8b: a host post with a reply audit gets no thumbs, no links and no generated mark (saw ${JSON.stringify(c?.intent)})`,
  );
  ok((await rowFor(c!.id))?.links === 0, "§8b: …and its row counts no link");
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
    read("turn_9", DM);
    await postReply({ platform: "slack", channelId: DM }, `${ANSWER} unproved`, auditFor("turn_9", DM));
  });
  ok((last()?.intent?.sources ?? []).length === 0, `🔴 §9: no proof of a 1:1 conversation, no link (saw ${JSON.stringify(last()?.intent)})`);
}

await removeTempDir(dir);
console.log(`reply-source-links: ${passed} assertions passed`);
