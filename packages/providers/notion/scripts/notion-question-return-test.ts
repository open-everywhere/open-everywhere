import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
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

async function wake(discussionId: string, message: string, opts: { respondThrows?: boolean; nonMember?: true } = {}): Promise<{ sent: string[]; responded: { requestId: string; text: string }[]; respondOptions: Record<string, unknown>[] }> {
  const sent: string[] = [];
  const responded: { requestId: string; text: string }[] = [];
  const respondOptions: Record<string, unknown>[] = [];
  const send = (async (payload: { message: string }) => {
    sent.push(payload.message);
  }) as unknown as Parameters<typeof liveNotionSupervisorDeps>[0];
  const respond = (async (input: { requestId: string; text: string }, options: Record<string, unknown>) => {
    if (opts.respondThrows) throw new Error("eve refused the respond — the request id is not in the proxy map");
    responded.push(input);
    respondOptions.push(options);
  }) as unknown as NonNullable<Parameters<typeof liveNotionSupervisorDeps>[3]>;
  const deps = liveNotionSupervisorDeps(send, SURFACE, undefined, respond);
  const auth = authFor(discussionId);
  if (opts.nonMember) auth.attributes.oe_chat_nonmember = "true";
  await deps.wake({ token: BARE_TOKEN, auth: auth as never, message, context: [], state: STATE });
  return { sent, responded, respondOptions };
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
  eq(row?.taskId, undefined, "…and with no task: only the work session has children that can ask, and they never reach this road (OPE-2351)");

  const answered = await wake(DISCUSSION, "<wake>yes, go ahead</wake>");
  eq(answered.sent.length, 0, "🔴 §2 the answering comment is NOT delivered as an ordinary send — that is what the parent eats");
  eq(answered.responded.length, 1, "🔴 §2 …it is delivered as `respond`, the ONE primitive that reaches a delegated worker");
  eq(answered.responded[0]?.requestId, REQUEST_ID, "…addressed to the request the worker is parked on");
  eq(answered.responded[0]?.text, "<wake>yes, go ahead</wake>", "…carrying the rendered wake verbatim, exactly what eve consumed before this leg existed");
  eq(answered.respondOptions.length, 1, "OPE-2336: the answer's respond options were captured");
  ok(!Object.prototype.hasOwnProperty.call(answered.respondOptions[0], "auth"), "🔴 OPE-2336: the answer hands its respond edge NO auth — the commenter's identity never reaches the held turn");
  {
    const src = readFileSync(new URL("../agent/channels/notion.ts", import.meta.url), "utf8");
    const edge = /function notionRespondFrom\([^]*?\.respond\(\s*\[[^]*?\],\s*\{([^]*?)\}\s*,?\s*\);/u.exec(src)?.[1];
    ok(edge !== undefined && !/\bauth\b/u.test(edge.replace(/\/\/.*$/gmu, "")), "🔴 OPE-2336: …and the eve `respond` call itself carries no `auth` key, in any form");
  }

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
  const stampRow = (): Promise<string | null> => getOperationalStore().getTaskResult(ORG, `oe-held-question-nonmember:${REQUEST_ID}`);
  await getOperationalStore().deleteTaskResult(ORG, `oe-held-question-nonmember:${REQUEST_ID}`);
  await rememberNotionQuestion({ org: ORG, namespacedToken: NAMESPACED_TOKEN, requestId: REQUEST_ID, discussionId: DISCUSSION });
  const member = await wake(DISCUSSION, "<wake>a member's answer</wake>");
  eq(member.responded.length, 1, "§5b precondition: the member's comment was delivered as the answer");
  eq(await stampRow(), null, "§5b NEGATIVE CONTROL: a member's answer records no stamp");

  await rememberNotionQuestion({ org: ORG, namespacedToken: NAMESPACED_TOKEN, requestId: REQUEST_ID, discussionId: DISCUSSION });
  const guest = await wake(DISCUSSION, "<wake>a guest's answer</wake>", { nonMember: true });
  eq(guest.responded.length, 1, "§5b precondition: the guest's comment was delivered as the answer");
  ok(!Object.prototype.hasOwnProperty.call(guest.respondOptions[0], "auth"), "§5b …and it still rides NO auth (OPE-2336 kept)");
  ok((await stampRow()) !== null, "🔴 §5b THE FIX: the guest's nonmember stamp is recorded on the held-question row");

  await getOperationalStore().deleteTaskResult(ORG, `oe-held-question-nonmember:${REQUEST_ID}`);
  await rememberNotionQuestion({ org: ORG, namespacedToken: NAMESPACED_TOKEN, requestId: REQUEST_ID, discussionId: DISCUSSION });
  const store = getOperationalStore() as { putTaskResult: (...a: unknown[]) => Promise<void> };
  const real = store.putTaskResult.bind(store);
  store.putTaskResult = async (...a: unknown[]) => {
    if (String(a[1]).startsWith("oe-held-question-nonmember:")) throw new Error("store blip");
    return real(...a);
  };
  let blip: Awaited<ReturnType<typeof wake>>;
  try {
    blip = await wake(DISCUSSION, "<wake>a guest's answer during a store blip</wake>", { nonMember: true });
  } finally {
    store.putTaskResult = real;
  }
  eq(blip.responded.length, 0, "🔴 §5b FAIL CLOSED: a guest's answer whose stamp could not be recorded is never delivered as an answer");
  eq(blip.sent.length, 1, "§5b …it falls through to the ordinary send, which carries the guest's own stamped bag");
  ok((await rowNow()) !== undefined, "§5b …with the question row left in place");
  await getOperationalStore().deleteTaskResult(ORG, `oe-question-bridge:${BARE_TOKEN}`);
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
    session: { continuation: { token: NAMESPACED_TOKEN, alias: () => {} } },
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
