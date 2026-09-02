import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-notion-question-return-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { registerNotionProvider } = await import("../agent/register.js");
registerNotionProvider();
const { liveNotionSupervisorDeps } = await import("../agent/channels/notion.js");
const { notionQuestionContainerKey, notionQuestionKey, rememberNotionQuestion } = await import("../agent/channels/notion-question-return.js");
const { getOperationalStore, deploymentOrg, readBridgedQuestion, QUESTION_ANSWERED_AUDIT_ACTION, readAudit } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

const ORG = deploymentOrg();
const SURFACE = "notion/workspace_acme/page_widgets";
const PAGE = "page_widgets";
const DISCUSSION = "disc_alpha";
const OTHER_DISCUSSION = "disc_beta";
const REQUEST_ID = "task_abc123:call_xyz";
const STATE = { discussionId: null, pageId: null, workspaceId: null } as const;

const BARE_TOKEN = `notion:${PAGE}:oe-sup:g1`;
const NAMESPACED_TOKEN = `notion:${BARE_TOKEN}`;

const authFor = (discussionId: string): { attributes: Record<string, string>; principalId: string; authenticator: string; principalType: string } => ({
  authenticator: "notion",
  principalId: "notion_user_h1",
  principalType: "notion-user",
  attributes: { workspace_id: "workspace_acme", page_id: PAGE, discussion_id: discussionId },
});

async function wake(discussionId: string, message: string, opts: { respondThrows?: boolean } = {}): Promise<{ sent: string[]; responded: { requestId: string; text: string }[] }> {
  const sent: string[] = [];
  const responded: { requestId: string; text: string }[] = [];
  const send = (async (payload: { message: string }) => {
    sent.push(payload.message);
  }) as unknown as Parameters<typeof liveNotionSupervisorDeps>[0];
  const respond = (async (input: { requestId: string; text: string }) => {
    if (opts.respondThrows) throw new Error("eve refused the respond — the request id is not in the proxy map");
    responded.push(input);
  }) as unknown as NonNullable<Parameters<typeof liveNotionSupervisorDeps>[3]>;
  const deps = liveNotionSupervisorDeps(send, SURFACE, undefined, respond);
  await deps.wake({ token: BARE_TOKEN, auth: authFor(discussionId) as never, message, context: [], state: STATE });
  return { sent, responded };
}

const rowNow = (): Promise<unknown> => readBridgedQuestion(getOperationalStore(), ORG, BARE_TOKEN);

{
  eq(notionQuestionKey(NAMESPACED_TOKEN, true), BARE_TOKEN, "🔴 the eve-context token strips to the token the dispatch minted");
  eq(notionQuestionKey(BARE_TOKEN, false), BARE_TOKEN, "…and the dispatch's own token is passed through unstripped");
  eq(
    notionQuestionKey(NAMESPACED_TOKEN, true),
    notionQuestionKey(BARE_TOKEN, false),
    "🔴 …so the two call sites key ONE row — the whole leg is inert if these disagree, with no error anywhere",
  );
  ok(notionQuestionKey(NAMESPACED_TOKEN, false) !== BARE_TOKEN, "…and stripping is NOT a no-op — the namespaced spelling differs from the bare one");
  eq(notionQuestionKey("", true), undefined, "an empty token keys nothing");
  eq(notionQuestionContainerKey(DISCUSSION), `notion:${DISCUSSION}`, "the room key is the DISCUSSION — a page's other discussions are other conversations");
}

{
  eq(await rowNow(), undefined, "wiring precondition: no outstanding question yet");
  const before = await wake(DISCUSSION, "<wake>an ordinary comment</wake>");
  eq(before.responded.length, 0, "🔴 with NO outstanding question, a comment is NEVER delivered as an answer");
  eq(before.sent.length, 1, "…it is an ordinary send, exactly as it was before this leg existed");

  eq(
    await rememberNotionQuestion({ org: ORG, namespacedToken: NAMESPACED_TOKEN, requestId: REQUEST_ID, discussionId: DISCUSSION }),
    true,
    "the posted question is remembered",
  );
  const row = (await rowNow()) as { requestId: string; containerKey?: string; taskId?: string } | undefined;
  eq(row?.requestId, REQUEST_ID, "…under the request id eve's proxy map is keyed on — the only value that can route an answer");
  eq(row?.containerKey, `notion:${DISCUSSION}`, "…bound to the discussion it is showing in");
  eq(row?.taskId, "task_abc123", "…with the owning task DERIVED for the audit join (never for routing)");

  const answered = await wake(DISCUSSION, "<wake>yes, go ahead</wake>");
  eq(answered.sent.length, 0, "🔴 §2 the answering comment is NOT delivered as an ordinary send — that is what the parent eats");
  eq(answered.responded.length, 1, "🔴 §2 …it is delivered as `respond`, the ONE primitive that reaches a delegated worker");
  eq(answered.responded[0]?.requestId, REQUEST_ID, "…addressed to the request the worker is parked on");
  eq(answered.responded[0]?.text, "<wake>yes, go ahead</wake>", "…carrying the rendered wake verbatim, exactly what eve consumed before this leg existed");

  const rows = (await readAudit({ org: ORG, limit: 200 })).filter((r) => r.action === QUESTION_ANSWERED_AUDIT_ACTION);
  eq(rows.length, 1, "…and one row records the routing");
  const detail = rows[0]?.detail as Record<string, unknown>;
  eq(detail["requestId"], REQUEST_ID, "…naming the request");
  eq(detail["route"], "native", "…and the route, so a reader can tell it from the unified window's own arm");
  ok(!JSON.stringify(detail).includes("go ahead"), "🔴 …and the ANSWER TEXT is never audited — it is a person's prose in a discussion thread");

  eq(await rowNow(), undefined, "🔴 §3 the row is consumed on delivery");
  const after = await wake(DISCUSSION, "<wake>and one more thing</wake>");
  eq(after.responded.length, 0, "🔴 §3 …so the NEXT comment is an ordinary wake again");
  eq(after.sent.length, 1, "…delivered as a send");
}

{
  await rememberNotionQuestion({ org: ORG, namespacedToken: NAMESPACED_TOKEN, requestId: REQUEST_ID, discussionId: DISCUSSION });
  const foreign = await wake(OTHER_DISCUSSION, "<wake>unrelated chatter on another thread</wake>");
  eq(foreign.responded.length, 0, "🔴 §4 a comment on a DIFFERENT discussion is NOT the answer");
  eq(foreign.sent.length, 1, "…it is delivered as an ordinary wake, so the person who wrote it is still heard");
  ok((await rowNow()) !== undefined, "🔴 §4 …and the row is LEFT IN PLACE, so the question stays open for the room it is showing in");

  const right = await wake(DISCUSSION, "<wake>yes</wake>");
  eq(right.responded.length, 1, "…while the discussion the question IS showing in answers it");
  eq(await rowNow(), undefined, "…and consumes the row");
}

{
  await rememberNotionQuestion({ org: ORG, namespacedToken: NAMESPACED_TOKEN, requestId: REQUEST_ID, discussionId: DISCUSSION });
  const refused = await wake(DISCUSSION, "<wake>an answer eve will not take</wake>", { respondThrows: true });
  eq(refused.responded.length, 0, "§5 the respond threw");
  eq(refused.sent.length, 1, "🔴 §5 …and the comment still reached the seat as an ordinary wake — a failed answer must never be a lost message");
  ok((await rowNow()) !== undefined, "🔴 §5 …with the row left in place, so the question is still answerable");
}

{
  await getOperationalStore().deleteTaskResult(ORG, `oe-question-bridge:${BARE_TOKEN}`);
  eq(await rowNow(), undefined, "wiring precondition: no row before the handler runs");

  const notionChannel = (await import("../agent/channels/notion.js")).default as unknown as {
    adapter: Record<string, (data: unknown, channel: unknown, ctx?: unknown) => Promise<void>>;
  };
  const rawHandler = notionChannel.adapter["input.requested"];
  assert.ok(typeof rawHandler === "function", "§6 the shipped channel really registers an `input.requested` handler");
  n++;
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href);
  const { SessionKey } = await import(pathToFileURL(join(eveRoot, "dist/src/context/keys.js")).href);
  const handler = (data: unknown, channel: unknown): Promise<void> => {
    const container = new ContextContainer();
    container.set(SessionKey, { sessionId: "notion-question-return", auth: null, turn: 1, parent: undefined });
    return contextStorage.run(container, () => rawHandler(data, channel)) as Promise<void>;
  };

  const posts: string[] = [];
  const { registerPostArm } = await import("@open-everywhere/core/agent/adapter-api.js");
  registerPostArm({
    platform: "notion",
    async dispatchReply(_target: unknown, text: string) {
      posts.push(text);
      return "comment_1";
    },
  } as never);

  const channel = {
    state: { oeReplyTarget: { discussionId: DISCUSSION, pageId: PAGE, workspaceId: "workspace_acme" } },
    session: { continuation: { token: NAMESPACED_TOKEN, rekey: () => {} } },
  };
  await handler(
    { requests: [{ requestId: REQUEST_ID, kind: "question", prompt: "Ship it?", options: [], action: { toolName: "ask_question" } }] },
    channel,
  );

  eq(posts.length, 1, "§6 the handler posted the prompt into the discussion");
  const written = (await rowNow()) as { requestId: string; containerKey?: string } | undefined;
  eq(written?.requestId, REQUEST_ID, "🔴 §6 …and REMEMBERED it, keyed from `channel.continuation.token` — the leg that was missing entirely");
  eq(written?.containerKey, `notion:${DISCUSSION}`, "…bound to the discussion it posted into");

  await getOperationalStore().deleteTaskResult(ORG, `oe-question-bridge:${BARE_TOKEN}`);
  registerPostArm({
    platform: "notion",
    async dispatchReply() {
      throw new Error("Notion refused the comment");
    },
  } as never);
  await handler(
    { requests: [{ requestId: "task_zzz:call_1", kind: "question", prompt: "Ship it?", options: [], action: { toolName: "ask_question" } }] },
    channel,
  );
  eq(await rowNow(), undefined, "🔴 §6 a question that could NOT be posted writes no row — a dropped question must never eat the room's next comment");
}

console.log(`✓ notion-question-return: ${n} assertions passed`);
