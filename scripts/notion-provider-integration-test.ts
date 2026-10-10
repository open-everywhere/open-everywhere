import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { setRegisteredConnectorCredentials, capabilitiesForPlatform, readAudit } from "@open-everywhere/core/agent/adapter-api.js";

const dir = join(tmpdir(), `open-everywhere-notion-integration-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.NOTION_CHANNEL_API_KEY = "ntn-test-key";

registerNotionProvider();
registerSlackProvider();
setRegisteredConnectorCredentials([
  {
    connector: "notion",
    allows: ["api-key"],
    credentials: [{ id: "channel-key", type: "api-key", secretRef: "NOTION_CHANNEL_API_KEY", broker: "env", intake: false }],
  },
]);

const reply = (await import("@open-everywhere/core/agent/tools/reply.js")).default;
const { resolveReplyTarget } = await import("@open-everywhere/core/agent/channels/reply-post.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
let notionResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: { id: "notion-comment-1" } };
const realFetch = globalThis.fetch;
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
function fakeHttp(): void {
  globalThis.fetch = (async (url: unknown, init: { body?: unknown; method?: string }) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (u.includes("api.notion.com")) return resp(notionResponse.status, notionResponse.body);
    return resp(500, { error: "unexpected host" });
  }) as typeof fetch;
}
function restoreHttp(): void {
  globalThis.fetch = realFetch;
}

function notionCtx(discussionId: string | undefined, credentialId?: string, worker?: { readonly taskLabel: string }) {
  return {
    channel: { kind: "notion" },
    session: {
      auth: {
        current: {
          attributes: {
            workspace_id: "W1",
            page_id: "P1",
            ...(discussionId ? { discussion_id: discussionId } : {}),
            ...(credentialId ? { credential_id: credentialId } : {}),
            ...(worker ? { oe_grain: "task", oe_task_label: worker.taskLabel } : {}),
          },
          principalId: "U3",
          principalType: "notion-user",
        },
      },
    },
  };
}

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ArmedTool {
  readonly description: string;
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
}
const armReply = (tool: unknown, ctx: unknown): ArmedTool | null =>
  (tool as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as ArmedTool | null;

assert.deepStrictEqual(
  capabilitiesForPlatform("notion"),
  { midTurnPost: true, reactions: false, closingProseDropped: true },
  "registerNotionProvider registers notion's manifest (midTurnPost wired, no reactions, closing prose dropped on EVERY seat — the one completion handler routes every session through the shared arm and delegates to no default poster)",
);
n++;

const notionArmed = armReply(reply, { channel: { kind: "notion" } });
ok(notionArmed !== null, "reply arms on a Notion session (mid-turn post via createCommentReply)");
const slackArmed = armReply(reply, { channel: { kind: "slack" } });
ok(slackArmed !== null && slackArmed.description === notionArmed!.description, "reply: ONE description on notion + slack (no per-surface variant)");

{
  const target = resolveReplyTarget(notionCtx("disc-1") as never);
  ok(target?.platform === "notion" && (target as { discussionId: string }).discussionId === "disc-1", "resolveReplyTarget: notion carries the discussion id (the reply anchor)");
  ok(resolveReplyTarget(notionCtx(undefined) as never) === null, "resolveReplyTarget: a discussion-less notion ctx → null (no anchor to post to)");

  const carried = resolveReplyTarget(notionCtx("disc-1", "payments-channel-key") as never) as { credentialId?: string } | null;
  ok(carried?.credentialId === "payments-channel-key", "resolveReplyTarget: notion carries the DELIVERY's credential onto the reply target");
  const uncarried = resolveReplyTarget(notionCtx("disc-1") as never) as { credentialId?: string } | null;
  ok(uncarried !== null && uncarried.credentialId === undefined, "resolveReplyTarget: a delivery that stowed no credential leaves it absent (negative control — the arm then falls back to the page's domain binding)");
}

calls = [];
notionResponse = { status: 200, body: { id: "notion-comment-42" } };
fakeHttp();
try {
await inSession(async () => {
  const armed = armReply(reply, notionCtx("disc-1"))!;
  const res = await armed.execute({ text: "notion answer" }, notionCtx("disc-1"));
  ok(res.posted === true && res.id === "notion-comment-42", "reply: on Notion returns the created comment id");
  ok(calls.length === 1 && calls[0].method === "POST" && calls[0].url.includes("api.notion.com") && calls[0].url.endsWith("/v1/comments"), "reply: on Notion POSTs to /v1/comments");
  const payload = JSON.parse(calls[0].body) as { discussion_id?: string; rich_text?: Array<{ text?: { content?: string } }> };
  ok(payload.discussion_id === "disc-1", "reply: on Notion posts into the SAME discussion (the thread it was woken on)");
  ok(payload.rich_text?.[0]?.text?.content === "notion answer", "reply: on Notion carries the model text as rich text");
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.some((r) => r.detail?.platform === "notion" && r.detail?.id === "notion-comment-42"), "reply: audits a reply.post row stamped platform=notion");
});
} finally {
  restoreHttp();
}

{
  const rawText = "the fix is in";
  const expectedText = "[review PR] " + rawText;

  calls = [];
  notionResponse = { status: 200, body: { id: "notion-comment-508" } };
  fakeHttp();
  try {
    await inSession(async () => {
      const ctx = notionCtx("disc-508", undefined, { taskLabel: "review PR" });
      const armed = armReply(reply, ctx)!;
      await armed.execute({ text: rawText }, ctx);
    });
  } finally {
    restoreHttp();
  }
  {
    const payload = JSON.parse(calls[0]!.body) as { rich_text?: Array<{ text?: { content?: string } }> };
    ok(payload.rich_text?.[0]?.text?.content === expectedText, "🔴 OPE-508: a task-grain worker's reply carries the bracket prefix in the posted body");
    const audit = await readAudit({ org: "default", action: "reply.post" });
    const row = audit.find((r) => r.detail?.id === "notion-comment-508");
    ok(row?.detail?.chars === expectedText.length, "🔴 OPE-521: the audited chars count the PREFIXED text actually posted");
    ok(row?.detail?.chars !== rawText.length, "OPE-521 negative control: audited chars must NOT equal the unprefixed raw length — that was the undercount this ticket fixes");
    ok(row?.detail?.route === "tool", "OPE-811: and the row's route names the reply TOOL — the only delivery channel on this surface");
  }

  calls = [];
  notionResponse = { status: 200, body: { id: "notion-comment-508-bare" } };
  fakeHttp();
  try {
    await inSession(async () => {
      const ctx = notionCtx("disc-508-bare");
      const armed = armReply(reply, ctx)!;
      await armed.execute({ text: rawText }, ctx);
    });
  } finally {
    restoreHttp();
  }
  {
    const payload = JSON.parse(calls[0]!.body) as { rich_text?: Array<{ text?: { content?: string } }> };
    ok(payload.rich_text?.[0]?.text?.content === rawText, "OPE-508 negative control: a non-worker (no oe_grain=task) reply is NOT bracketed");
    const audit = await readAudit({ org: "default", action: "reply.post" });
    ok(audit.find((r) => r.detail?.id === "notion-comment-508-bare")?.detail?.chars === rawText.length, "OPE-521 negative control: a non-worker reply's audited chars equal the raw (unprefixed) length");
  }
}

await inSession(async () => {
  const armed = armReply(reply, notionCtx(undefined))!;
  await assert.rejects(() => armed.execute({ text: "x" }, notionCtx(undefined)), /couldn't resolve/, "reply: a Notion ctx with no discussion id throws an honest error");
  n++;
});

{
  const { signNotionBody, buildCommentCreatedEvent } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const { verifyNotionSignature } = await import("@open-everywhere/provider-notion/agent/channels/notion-api.js");
  const secret = "notion-verif-token";
  const raw = JSON.stringify(buildCommentCreatedEvent({ workspaceId: "ws", commentId: "c1", pageId: "p1" }));
  const sig = signNotionBody(secret, raw);
  ok(verifyNotionSignature(secret, raw, sig), "a signed notion forge body verifies against the real verifyNotionSignature");
  ok(!verifyNotionSignature(secret, raw + "x", sig), "a tampered notion body fails verification");
  ok(!verifyNotionSignature("wrong", raw, sig), "the wrong notion secret fails verification");
}

{
  const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/adapter-api.js");
  overrideSettingsForTest({ webhooks: { allowUnverifiedNotion: true } });
  delete process.env.NOTION_WEBHOOK_SECRET;
  const { recordSpend } = await import("@open-everywhere/core/agent/spend/store.js");
  const { periodOf } = await import("@open-everywhere/core/agent/spend/spend.js");
  const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
  const { resolvePartition } = await import("@open-everywhere/core/agent/adapter-api.js");
  const notionChannel = (await import("@open-everywhere/provider-notion/agent/channels/notion.js")).default as unknown as {
    routes: ReadonlyArray<{ handler: (req: Request, args: unknown) => Promise<Response> }>;
  };
  const routeHandler = notionChannel.routes[0]!.handler;

  const BOT = "bot-user-id-999", AUTHOR = "author-user-id-111";
  process.env.NOTION_BOT_USER_ID = BOT;
  const partOf = (ws: string, page: string) => resolvePartition({ channel: { kind: "notion" as const }, session: { auth: { current: { attributes: { workspace_id: ws, page_id: page }, principalId: AUTHOR } } } } as never);
  const overPart = partOf("WSCAP", "PAGECAP");
  const okPart = partOf("WSOK", "PAGEOK");

  const mentionRT = [
    { type: "mention", plain_text: "@OE", mention: { type: "user", user: { id: BOT } } },
    { type: "text", plain_text: " please summarise", text: { content: " please summarise" } },
  ];
  let deliveryNo = 0;
  let currentComment = "comment-0";
  const event = (ws: string, page: string): string =>
    JSON.stringify({ type: "comment.created", workspace_id: ws, entity: { id: currentComment, type: "comment" }, data: { page_id: page, parent: { id: page, type: "page" } }, authors: [{ id: AUTHOR, type: "person" }] });
  const retrievedComment = (page: string) => ({ id: currentComment, discussion_id: `disc-${page}`, parent: { type: "page", page_id: page }, created_by: { id: AUTHOR, object: "user" }, rich_text: mentionRT });

  const realFetch = globalThis.fetch;
  let posts: string[] = [];
  let currentPage = "PAGECAP";
  globalThis.fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const url = String(input), method = (init.method ?? "GET").toUpperCase();
    const R = (b: unknown, s = 200) => ({ ok: s >= 200 && s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) }) as unknown as Response;
    if (method === "GET" && /\/v1\/comments\/[^?]+$/.test(url)) return R(retrievedComment(currentPage));
    if (method === "GET" && url.includes("/v1/comments?block_id=")) return R({ results: [] });
    if (method === "GET" && url.endsWith("/v1/users/me")) return R({ id: BOT, type: "bot", name: "Aria" });
    if (method === "POST" && url.endsWith("/v1/comments")) { posts.push(String(init.body ?? "")); return R({ id: "reply-1" }); }
    return R({ error: "unexpected host" }, 500);
  }) as typeof fetch;
  try {

  let sendCalled = false;
  const args = () => ({
    from: () => ({ send: async () => { sendCalled = true; return { id: "sess-1" }; } }),
    resolveSession: async () => undefined,
    waitUntil: (_p: Promise<unknown>) => {},
    to: () => ({ send: async () => ({ id: "sess-1" }) }),
  });
  const drive = async (ws: string, page: string) => {
    posts = []; sendCalled = false; currentPage = page; currentComment = `comment-${++deliveryNo}`;
    let threw: unknown;
    try { await routeHandler(new Request("http://x/eve/v1/notion", { method: "POST", body: event(ws, page) }), args()); } catch (e) { threw = e; }
    return { posts, sendCalled, threw };
  };

  const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => [defineDomain({ name: "notion-ambient", match: "org", ambientSupervisor: true })],
    loadSilos: () => [], domainsForSurface: () => [],
    loadSpendBudgets: () => ({ perSurface: { [overPart.surfaceKey]: { surfaceMonthlyTokens: 1 } } }),
  });
  await recordSpend(overPart as never, { period: periodOf(new Date().toISOString()), usage: { inputTokens: 100, outputTokens: 100 } });

  const over = await drive("WSCAP", "PAGECAP");
  ok(over.sendCalled === false, "spend-gate: an over-budget notion mention never reaches the model dispatch (declined before it)");
  ok(over.posts.some((b) => b.includes(overPart.surfaceKey) && b.includes("holding off")), "spend-gate: the decline posts a VISIBLE refusal reply naming the surface scope key");
  const gateRows = (await readAudit({ org: overPart.org, action: "spend.gate" })).filter((r) => r.detail?.key === overPart.surfaceKey);
  ok(gateRows.length === 1 && gateRows[0]!.detail?.door === "mention" && gateRows[0]!.detail?.over === true, "spend-gate: an over-budget notion mention writes ONE spend.gate row (door=mention, over=true)");
  ok((await readAudit({ org: overPart.org, action: "notion.dispatched" })).filter((r) => r.surface === "PAGECAP").length === 0, "spend-gate: a declined notion wake skips the notion.dispatched audit (gate is before dispatch)");

  const under = await drive("WSOK", "PAGEOK");
  ok(under.sendCalled === true, "spend-gate: an under-budget notion mention PROCEEDS to the model dispatch (send invoked)");
  ok(!under.posts.some((b) => b.includes("holding off")), "spend-gate: an under-budget notion mention posts NO refusal");
  ok((await readAudit({ org: okPart.org, action: "spend.gate" })).filter((r) => r.detail?.key === okPart.surfaceKey).length === 0, "spend-gate: an under-budget notion mention writes NO spend.gate row");

  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  const live = provider.getOperationalStore();
  const broken = { ...live, spendTotals: async () => { throw new Error("store down"); } } as typeof live;
  provider.registerOperationalStore(broken);
  provider.resetOperationalStore();
  const failOpen = await drive("WSCAP", "PAGECAP");
  ok(failOpen.sendCalled === true && !failOpen.posts.some((b) => b.includes("holding off")), "spend-gate: a THROWN notion budget check fails OPEN (over-budget wake still dispatches, no refusal)");
  provider.registerOperationalStore(live);
  provider.resetOperationalStore();

  } finally {
    globalThis.fetch = realFetch;
    overrideSettingsForTest({ webhooks: { allowUnverifiedNotion: false } });
  }
}

{
  const { overrideSettingsForTest, resolvePartition } = await import("@open-everywhere/core/agent/adapter-api.js");
  const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
  const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
  const { markNotionEngaged } = await import("@open-everywhere/provider-notion/agent/channels/notion-engagement.js");
  const notionChannel = (await import("@open-everywhere/provider-notion/agent/channels/notion.js")).default as unknown as {
    routes: ReadonlyArray<{ handler: (req: Request, args: unknown) => Promise<Response> }>;
  };
  const routeHandler = notionChannel.routes[0]!.handler;

  overrideSettingsForTest({ webhooks: { allowUnverifiedNotion: true } });
  delete process.env.NOTION_WEBHOOK_SECRET;

  const BOT = "bot-user-id-777", AUTHOR = "author-user-id-222";
  const WS = "WSENG";
  const ENGAGED_PAGE = "PAGEENGAGED";
  const AMBIENT_PAGE = "PAGEAMBIENT";
  process.env.NOTION_BOT_USER_ID = BOT;

  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => [
      defineDomain({ name: "notion-addressed-only", reach: [`notion/${WS}/${ENGAGED_PAGE}`], ambientSupervisor: false }),
      defineDomain({ name: "notion-ambient-on", reach: [`notion/${WS}/${AMBIENT_PAGE}`], ambientSupervisor: true }),
    ],
    loadSilos: () => [], domainsForSurface: () => [],
    loadSpendBudgets: () => ({}),
  });

  await markNotionEngaged({ workspaceId: WS, pageId: ENGAGED_PAGE }, "seed-comment-1");

  const plainRT = [{ type: "text", plain_text: "and what's that plus 6?", text: { content: "and what's that plus 6?" } }];
  const event = (page: string): string =>
    JSON.stringify({ type: "comment.created", workspace_id: WS, entity: { id: `comment-${page}`, type: "comment" }, data: { page_id: page, parent: { id: page, type: "page" } }, authors: [{ id: AUTHOR, type: "person" }] });

  const realFetch = globalThis.fetch;
  let currentPage = ENGAGED_PAGE;
  globalThis.fetch = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const url = String(input), method = (init.method ?? "GET").toUpperCase();
    const R = (b: unknown, s = 200) => ({ ok: s >= 200 && s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) }) as unknown as Response;
    if (method === "GET" && /\/v1\/comments\/[^?]+$/.test(url))
      return R({ id: `comment-${currentPage}`, discussion_id: `disc-${currentPage}`, parent: { type: "page", page_id: currentPage }, created_by: { id: AUTHOR, object: "user", type: "person" }, rich_text: plainRT });
    if (method === "GET" && url.includes("/v1/comments?block_id=")) return R({ results: [] });
    if (method === "GET" && url.endsWith("/v1/users/me")) return R({ id: BOT, type: "bot", name: "Aria" });
    if (method === "POST" && url.endsWith("/v1/comments")) return R({ id: "reply-1" });
    return R({ error: "unexpected host" }, 500);
  }) as typeof fetch;

  const args = () => ({
    from: () => ({ send: async () => ({ id: "sess-eng" }) }),
    resolveSession: async () => undefined,
    waitUntil: (_p: Promise<unknown>) => {},
    to: () => ({ send: async () => ({ id: "sess-eng" }) }),
  });
  const drive = async (page: string) => {
    currentPage = page;
    await routeHandler(new Request("http://x/eve/v1/notion", { method: "POST", body: event(page) }), args());
  };
  const addressingOn = async (page: string): Promise<readonly unknown[]> => {
    const part = resolvePartition({ channel: { kind: "notion" as const }, session: { auth: { current: { attributes: { workspace_id: WS, page_id: page }, principalId: AUTHOR } } } } as never);
    const rows = await readAudit({ org: part.org, action: "notion.dispatched" });
    return rows.filter((r) => r.surface === page).map((r) => r.detail?.addressing);
  };
  const viaOn = async (page: string): Promise<readonly unknown[]> => {
    const part = resolvePartition({ channel: { kind: "notion" as const }, session: { auth: { current: { attributes: { workspace_id: WS, page_id: page }, principalId: AUTHOR } } } } as never);
    const rows = await readAudit({ org: part.org, action: "notion.dispatched" });
    return rows.filter((r) => r.surface === page).map((r) => r.detail?.via);
  };

  try {
    const { ambientSupervisorEnabled, getConfig } = await import("@open-everywhere/core/agent/adapter-api.js");
    ok(
      ambientSupervisorEnabled(`notion/${WS}/${ENGAGED_PAGE}`, getConfig().loadDomains()) === false &&
        ambientSupervisorEnabled(`notion/${WS}/${AMBIENT_PAGE}`, getConfig().loadDomains()) === true,
      "engaged-audit: precondition — the engaged page's domain has ambient OFF and the control page's has it ON, so the two rows differ by the engagement registry and not by the opt-in",
    );

    await drive(ENGAGED_PAGE);
    const engagedSeen = await addressingOn(ENGAGED_PAGE);
    ok(
      engagedSeen.length === 1 && engagedSeen[0] === "thread-follow",
      `🔴 engaged-audit: the REAL route's notion.dispatched row reports \`thread-follow\` for a plain follow-up on an engaged page (saw ${JSON.stringify(engagedSeen)}) — the value J-ENGAGED-notion's follow-up leg gates on`,
    );
    const engagedVia = await viaOn(ENGAGED_PAGE);
    ok(
      engagedVia.length === 1 && engagedVia[0] === "roster",
      `🔴 engaged-audit: …and the same row records \`via: roster\` (saw ${JSON.stringify(engagedVia)}) — the domain origin the addressed door gated on, without which a workspace-wide claim reads like a page an operator listed`,
    );

    await drive(AMBIENT_PAGE);
    const ambientSeen = await addressingOn(AMBIENT_PAGE);
    ok(
      ambientSeen.length === 1 && ambientSeen[0] === "channel-watch",
      `🔴 engaged-audit: NEGATIVE CONTROL — ambient chatter on an UN-ENGAGED page still reports \`channel-watch\` (saw ${JSON.stringify(ambientSeen)}), so the promotion is the engagement row's doing and not the route's`,
    );
  } finally {
    globalThis.fetch = realFetch;
    overrideSettingsForTest({ webhooks: { allowUnverifiedNotion: false } });
  }
}

{
  const { defineSurface, registerSurfaces, applySubtreeSurfaceClaims, _resetSurfacesForTest } = await import(
    "@open-everywhere/core/agent/adapter-api.js"
  );
  const { notionTrustRoots } = await import("@open-everywhere/provider-notion/agent/channels/notion-ancestry-trust.js");
  const WS = "wsub-1";
  const PAGE = "11111111-1111-4111-8111-111111111111";

  _resetSurfacesForTest();
  ok(notionTrustRoots().byWorkspace.size === 0, "subtree: nothing declared ⇒ NO trust root (fail-closed)");

  registerSurfaces([defineSurface({ key: `notion/${WS}/${PAGE}`, trust: "internal" })]);
  applySubtreeSurfaceClaims();
  ok(notionTrustRoots().byWorkspace.size === 0, "🔴 subtree: a plain Notion entry vouches ONE page and is not a root");

  registerSurfaces([defineSurface({ key: `notion/${WS}/${PAGE}`, trust: "internal", subtree: true })]);
  applySubtreeSurfaceClaims();
  ok(
    notionTrustRoots().byWorkspace.get(WS)?.has(PAGE.replace(/-/g, "")) === true,
    "🔴 subtree: registerNotionProvider() declared the capability, so a `subtree: true` line reaches the bundle's register",
  );

  registerSurfaces([defineSurface({ key: "slack/T0ACME/C0BOARD", trust: "internal", subtree: true })]);
  let refused = false;
  try {
    applySubtreeSurfaceClaims();
  } catch (e) {
    refused = e instanceof Error && e.message.includes("slack");
  }
  ok(refused, "🔴 subtree: a claim on a REGISTERED-but-not-subtree-capable platform is a BOOT ERROR naming it");

  _resetSurfacesForTest();
  ok(notionTrustRoots().byWorkspace.size === 0, "subtree: dropping the register drops the root with it");
}

console.log(`\n✓ notion-provider-integration: ${n} assertions passed (manifest row, reply gate, target, execute + audit, no-anchor throw, forge-signer round-trip, attended-mention spend gate, the engaged wake's own dispatch-row addressing, subtree-trust composition)`);
