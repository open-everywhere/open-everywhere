import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seatCatchUpFetchFor,
  seatCatchUpPrecisionFor,
  surfaceParityFor,
  seatCatchUp,
  registerSeatCatchUp,
  _resetSeatCatchUp,
  SEAT_CATCH_UP_ACTION,
  DEFAULT_TIMESTAMP_PRECISION_MS,
  type NormalizedMessage,
  type SeatCatchUpFetch,
  type SeatCatchUpRequest,
} from "@open-everywhere/core/agent/adapter-api.js";
import { SLACK_TIMESTAMP_PRECISION_MS } from "@open-everywhere/provider-slack/agent/channels/slack-wake-backscroll.js";
import { DISCORD_TIMESTAMP_PRECISION_MS } from "@open-everywhere/provider-discord/agent/channels/discord-backscroll.js";
import { TEAMS_TIMESTAMP_PRECISION_MS } from "@open-everywhere/provider-teams/agent/channels/teams-catch-up.js";
import { GITHUB_TIMESTAMP_PRECISION_MS } from "@open-everywhere/provider-github/agent/channels/github-catch-up.js";
import { LINEAR_TIMESTAMP_PRECISION_MS } from "@open-everywhere/provider-linear/agent/channels/linear-catch-up.js";
import { NOTION_TIMESTAMP_PRECISION_MS } from "@open-everywhere/provider-notion/agent/channels/notion-catch-up.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { fetchSlackSeatCatchUp } from "@open-everywhere/provider-slack/agent/channels/slack-wake-backscroll.js";
import { fetchDiscordSeatCatchUp } from "@open-everywhere/provider-discord/agent/channels/discord-backscroll.js";
import { fetchGitHubCatchUpWindow } from "@open-everywhere/provider-github/agent/channels/github-catch-up.js";
import { fetchLinearCatchUpWindow, linearOrgFromChannelKey } from "@open-everywhere/provider-linear/agent/channels/linear-catch-up.js";
import { fetchNotionCatchUpWindow, type NotionCatchUpDeps } from "@open-everywhere/provider-notion/agent/channels/notion-catch-up.js";
import { readNotionComments } from "@open-everywhere/provider-notion/agent/channels/notion-api.js";
import {
  TEAMS_CATCH_UP_ACTION,
  fetchTeamsCatchUpWindow,
  parseTeamsCatchUpContainer,
  teamsCatchUpScopeFromChannelKey,
} from "@open-everywhere/provider-teams/agent/channels/teams-catch-up.js";
import type { AuditInput } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SINCE = Date.parse("2026-09-12T12:00:00.000Z");
const AFTER = "2026-09-10T19:05:00.000Z";
const byId = (ms: readonly NormalizedMessage[], id: string) => ms.find((m) => m.id === id);

{
  const calls: Array<{ method: string; params: Record<string, string> }> = [];
  const request = async (method: string, params: Record<string, string>) => {
    calls.push({ method, params });
    if (method !== "conversations.history") return { ok: false, error: "unexpected" };
    return {
      ok: true,
      messages: [
        { ts: String((SINCE + 60_000) / 1000), user: "U1", text: "a person spoke while the seat was away" },
        { ts: String((SINCE + 70_000) / 1000), text: "who said this?" },
      ],
    };
  };
  const deps = { request, identity: async () => ({ userId: "UBOT", botId: "BBOT" }) };
  const out = await fetchSlackSeatCatchUp({ container: "C1", sinceMs: SINCE, excludeId: "9999.0" }, deps);
  ok(calls[0]?.method === "conversations.history", "slack: the catch-up reads the channel's own history");
  ok(calls[0]?.params.latest === "9999.0", "slack: the trigger's ts is the window's upper bound (a Slack ts is both a time and an id)");
  ok(Number(calls[0]?.params.oldest) >= SINCE / 1000, "slack: the window is bounded below by the seat's own last wake");
  ok(out.length === 1 && out[0].sender === "human", "slack: an attributable person's message normalizes as human");
  ok(out[0].ms === SINCE + 60_000, "slack: the Slack ts becomes an epoch-ms time");
  ok(out.every((m) => m.text !== "who said this?"), "slack: VISIBILITY GATE — an unattributable message never reaches the seat");
  await assert.rejects(
    () => fetchSlackSeatCatchUp({ container: "C1", sinceMs: SINCE }, { request: async () => { throw new Error("down"); }, identity: async () => ({}) }),
    /down/,
    "slack: a throwing transport reaches the shared failure boundary",
  );
  ok(true, "slack: a throwing transport reaches the shared failure boundary");
  await assert.rejects(
    () => fetchSlackSeatCatchUp({ container: "C1", sinceMs: SINCE }, { request: async () => undefined, identity: async () => ({}) }),
    /Slack catch-up conversations\.history failed/,
  );
  ok(true, "slack: the live requester's swallowed/non-ok shape is restored to a catch-up failure");
}

{
  const seen: Array<{ channelId: string; query: Record<string, string> }> = [];
  const request = async (channelId: string, query: Record<string, string>) => {
    seen.push({ channelId, query });
    return [
      { id: "200", type: 0, timestamp: new Date(SINCE + 60_000).toISOString(), content: "said while away", author: { id: "D1", username: "dee" } },
      { id: "201", type: 0, timestamp: new Date(SINCE + 70_000).toISOString(), content: "anonymous", author: {} },
    ];
  };
  const out = await fetchDiscordSeatCatchUp({ container: "CH", threadRoot: "TH", sinceMs: SINCE, excludeId: "999" }, { request });
  ok(seen[0]?.channelId === "TH", "discord: a thread-bound seat reads the THREAD's own channel id");
  ok(seen[0]?.query.before === "999", "discord: the trigger's snowflake is the `before=` anchor");
  ok(out.length === 1 && out[0].id === "200", "discord: an attributable message normalizes; an unattributable one is dropped");
  ok(out[0].type === "thread" && out[0].threadId === "TH", "discord: a thread-bound read tags its messages thread-scoped");
  await assert.rejects(() => fetchDiscordSeatCatchUp({ container: "CH", sinceMs: SINCE }, { request: async () => { throw new Error("down"); } }), /down/);
  ok(true, "discord: a throwing transport reaches the shared failure boundary");
  await assert.rejects(
    () => fetchDiscordSeatCatchUp({ container: "CH", sinceMs: SINCE }, { request: async () => undefined }),
    /Discord catch-up request failed/,
  );
  ok(true, "discord: the live requester's missing-token/non-ok shape is restored to a catch-up failure");
}

{
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    return {
      ok: true,
      json: async () => [
        { id: 11, created_at: AFTER, body: "a reviewer commented", user: { login: "ada" } },
        { id: 12, created_at: AFTER, body: "ci says red", user: { login: "ci-app", type: "Bot" } },
        { id: 13, created_at: AFTER, body: "ghost", user: {} },
      ],
    };
  }) as never;
  const out = await fetchGitHubCatchUpWindow({ container: "acme/web#42", sinceMs: SINCE }, { fetchFn, selfLogin: "oe[bot]", resolveToken: async () => "t" });
  ok(urls[0]?.includes("/repos/acme/web/issues/42/comments"), "github: the catch-up reads the conversation the seat was woken on");
  ok(urls[0]?.includes("since="), "github: the vendor's own `since` filter does the narrowing");
  ok(out.length === 2, "github: the two attributable comments survive and the unattributed one does not");
  ok(byId(out, "11")?.sender === "human", "github: a person's comment normalizes as human");
  ok(byId(out, "12")?.sender === "bot", "github: an App actor is MARKED AWARENESS, not silently dropped");
  const unaddressable = await fetchGitHubCatchUpWindow({ container: "not-a-container", sinceMs: SINCE }, { fetchFn, resolveToken: async () => "t" });
  ok(unaddressable.length === 0, "github: an unparseable container reads nothing rather than guessing a repo");
  await assert.rejects(
    () => fetchGitHubCatchUpWindow({ container: "acme/web#42", sinceMs: SINCE }, { fetchFn: (async () => { throw new Error("down"); }) as never, resolveToken: async () => "t" }),
    /down/,
  );
  ok(true, "github: a throwing transport reaches the shared failure boundary");
  await assert.rejects(
    () => fetchGitHubCatchUpWindow(
      { container: "acme/web#42", sinceMs: SINCE },
      { fetchFn: (async () => ({ ok: true, json: async () => ({ message: "not a comment page" }) })) as never, resolveToken: async () => "t" },
    ),
    /GitHub catch-up returned a malformed response/,
  );
  ok(true, "github: a 2xx non-array response reaches the shared failure boundary instead of reading as quiet");
}

{
  const asked: string[] = [];
  const readIssue = (async (ref: string) => {
    asked.push(ref);
    return {
      description: "",
      comments: [
        { id: "c-old", authorId: "L1", createdAt: new Date(SINCE - 60_000).toISOString(), text: "before the seat last looked" },
        { id: "c-new", authorId: "L1", createdAt: AFTER, text: "said while away" },
        { id: "c-reply", parentId: "c-new", authorId: "L2", createdAt: AFTER, text: "a threaded reply" },
        { id: "c-ghost", createdAt: AFTER, text: "no author" },
      ],
      truncated: false,
    };
  }) as never;
  const out = await fetchLinearCatchUpWindow({ container: "OPE-42", sinceMs: SINCE }, { readIssue });
  ok(asked[0] === "OPE-42", "linear: the catch-up reads the issue the seat was woken on");
  ok(linearOrgFromChannelKey("linear/org-b/T1") === "org-b", "linear: the ORG is read off the channel key — a multi-org read resolves that org's credential");
  ok(linearOrgFromChannelKey("slack/T/C") === undefined && linearOrgFromChannelKey(undefined) === undefined, "linear: a non-Linear or absent key yields no org (the single-org answer)");
  ok(out.length === 2, "linear: only comments newer than the seat's last wake survive, and only attributable ones");
  ok(byId(out, "c-new")?.type === "channel", "linear: a top-level comment is container-scoped");
  ok(byId(out, "c-reply")?.threadId === "c-new", "linear: a reply carries its parent as the thread root");
  ok(out.every((m) => m.id !== "c-ghost"), "linear: VISIBILITY GATE — an unattributable comment never reaches the seat");
  await assert.rejects(() => fetchLinearCatchUpWindow({ container: "OPE-42", sinceMs: SINCE }, { readIssue: (async () => { throw new Error("down"); }) as never }), /down/);
  ok(true, "linear: a throwing read reaches the shared failure boundary");
}

{
  const asked: Array<{ page: string; block?: string }> = [];
  const askedCredential: Array<string | undefined> = [];
  const readComments = (async (pageId: string, opts: { block?: string }) => {
    asked.push({ page: pageId, block: opts.block });
    if (opts.block !== undefined) throw new Error(`notion: no such block ${opts.block} (a discussion id is not a block id)`);
    return {
      discussionCount: 2,
      blocksScanned: 1,
      truncated: false,
      comments: [
        { id: "c-1", discussionId: "D1", authorId: "N1", authorKind: "person", createdTime: AFTER, text: "said while away" },
        { id: "c-2", discussionId: "D1", authorId: "N2", authorKind: "bot", createdTime: AFTER, text: "an integration posted" },
        { id: "c-3", discussionId: "D1", createdTime: AFTER, text: "no author" },
        { id: "c-4", discussionId: "D2", authorId: "N3", authorKind: "person", createdTime: AFTER, text: "a different discussion" },
      ],
    };
  }) as never;
  const resolveCredential = (async (id?: string) => {
    askedCredential.push(id);
    return { apiKey: "k" };
  }) as never;
  const out = await fetchNotionCatchUpWindow({ container: "page-1", threadRoot: "D1", sinceMs: SINCE }, { readComments, resolveCredential, domains: [] });
  ok(asked[0]?.page === "page-1" && asked[0]?.block === undefined, "notion: the read sweeps the PAGE — there is no per-discussion endpoint to drill into");
  ok(out.length === 2, "notion: the two attributable comments in the seat's own discussion survive");
  ok(out.every((m) => m.type === "thread" && m.threadId === "D1"), "notion: every comment is thread-scoped — a Notion wake is thread-first");
  ok(out.every((m) => m.text !== "a different discussion"), "notion: another discussion on the same page never enters the seat's context");
  ok(out.some((m) => m.sender === "bot"), "notion: an integration author is MARKED AWARENESS, not silently dropped");

  {
    const READER = "channel-key";
    const SIBLING_CRED = "payments-channel-key";
    const BOT_READER = "U_BOT_READER";
    const BOT_SIBLING = "U_BOT_SIBLING";
    const resolvedFor: string[] = [];
    const ourOwnWords = (async () => ({
      discussionCount: 1,
      blocksScanned: 1,
      truncated: false,
      comments: [
        { id: "s-1", discussionId: "D1", authorId: BOT_SIBLING, createdTime: AFTER, text: "posted by our SIBLING integration" },
        { id: "s-2", discussionId: "D1", authorId: BOT_READER, createdTime: AFTER, text: "posted by the READING integration" },
        { id: "s-3", discussionId: "D1", authorId: "N-HUMAN", createdTime: AFTER, text: "a person said this" },
      ],
    })) as never;
    const twoIntegrations = [{ name: "payments", credentials: [{ connector: "notion", credential: "channel-key", use: SIBLING_CRED }] }] as never;
    const siblingAware: NotionCatchUpDeps = {
      readComments: ourOwnWords,
      resolveCredential: (async () => ({ apiKey: "k" })) as never,
      domains: twoIntegrations,
      selfActorIdFor: async (credentialId) => {
        resolvedFor.push(credentialId);
        return credentialId === SIBLING_CRED ? BOT_SIBLING : BOT_READER;
      },
    };
    const withSet = await fetchNotionCatchUpWindow({ container: "page-1", threadRoot: "D1", sinceMs: SINCE }, siblingAware);
    ok(resolvedFor.includes(READER) && resolvedFor.includes(SIBLING_CRED), "🔴 OPE-1921: the catch-up resolves EVERY configured integration's bot id, not only the one this read runs under");
    ok(withSet.find((m) => m.id === "s-1")?.sender === "self", "🔴 OPE-1921: a reply the SIBLING integration posted reads as `self` — the seat's own words, whichever integration wrote them");
    ok(withSet.find((m) => m.id === "s-1")?.authorId === undefined, "…and carries NO author id, exactly as our own reply always has — so wake-trust cannot hand it a human standing");
    ok(withSet.find((m) => m.id === "s-2")?.sender === "self", "the READING integration's own reply still reads as `self` — the set is an addition, not a replacement");
    ok(withSet.find((m) => m.id === "s-3")?.sender === "human" && withSet.find((m) => m.id === "s-3")?.authorId === "N-HUMAN", "NEGATIVE CONTROL: a real person is untouched — the set marks OUR ids self, not every id");

    const oneId = await fetchNotionCatchUpWindow({ container: "page-1", threadRoot: "D1", sinceMs: SINCE }, { ...siblingAware, selfActorId: BOT_READER });
    ok(oneId.find((m) => m.id === "s-1")?.sender === "human", "🔴 OPE-1921 CONTROL: with ONE id, the sibling integration's reply reads as a PERSON's — the seat answering from its own words as if someone else wrote them");
    ok(oneId.find((m) => m.id === "s-1")?.authorId === BOT_SIBLING, "…and carries an author id, which is what puts it at the `unauth` sender floor rather than `self`");
    ok(oneId.find((m) => m.id === "s-2")?.sender === "self", "…while the READING integration's own reply is recognised either way, so the control differs in exactly one thing");
  }

  asked.length = 0;
  await fetchNotionCatchUpWindow(
    { container: "page-1", threadRoot: "D1", threadAnchor: "block-80-plus", sinceMs: SINCE },
    {
      readComments: (async (pageId: string, opts: { block?: string }) => {
        asked.push({ page: pageId, block: opts.block });
        return { discussionCount: 0, blocksScanned: 1, truncated: false, comments: [] };
      }) as never,
      resolveCredential,
      domains: [],
    },
  );
  ok(asked[0]?.block === "block-80-plus", "🔴 notion/OPE-1843: an authenticated inline block anchor drills into that exact block instead of scanning the page's oldest 80 blocks");
  ok(out.map((m) => m.id).join(",") === "c-1,c-2", "🔴 notion: each comment normalizes under its OWN Notion id — the only thing `excludeId` can match on a surface whose comments share one floored instant");
  const deduped = await fetchNotionCatchUpWindow({ container: "page-1", threadRoot: "D1", sinceMs: SINCE }, { readComments, resolveCredential, domains: [] });
  ok(deduped.filter((m) => m.id === "c-1").length === 1, "notion: an id identifies exactly one comment, so removing the wake's own message removes one message");
  {
    const noId = (async () => ({
      discussionCount: 1,
      blocksScanned: 1,
      truncated: false,
      comments: [{ discussionId: "D1", authorId: "N1", authorKind: "person", createdTime: AFTER, text: "served with no id" }],
    })) as never;
    const fallback = await fetchNotionCatchUpWindow({ container: "page-1", threadRoot: "D1", sinceMs: SINCE }, { readComments: noId, resolveCredential, domains: [] });
    ok(fallback.length === 1 && fallback[0].id === `D1:${AFTER}`, "notion: a comment served with no id falls back to the discussion-plus-time label rather than vanishing");
  }
  askedCredential.length = 0;
  await fetchNotionCatchUpWindow(
    { container: "page-1", sinceMs: SINCE, channelKey: "notion/ws-1/page-1" },
    { readComments, resolveCredential, domains: [] },
  );
  ok(askedCredential.length === 1, "notion: the credential is resolved once per read");
  const unconfigured = await fetchNotionCatchUpWindow({ container: "page-1", sinceMs: SINCE }, { readComments, resolveCredential: (async () => undefined) as never });
  ok(unconfigured.length === 0, "notion: an unresolvable credential reads nothing rather than guessing a key");
  await assert.rejects(
    () => fetchNotionCatchUpWindow({ container: "page-1", sinceMs: SINCE }, { readComments: (async () => { throw new Error("down"); }) as never, resolveCredential }),
    /down/,
  );
  ok(true, "notion: a throwing read reaches the shared failure boundary");
}

{
  const PAGE = "page-1";
  const SAID_WHILE_AWAY = "said in the discussion while the seat was away";
  const ancient = Array.from({ length: 100 }, (_, i) => ({
    id: `old-${i}`,
    discussion_id: "D1",
    created_time: "2026-08-01T09:00:00.000Z",
    created_by: { id: "N9", type: "person" },
    rich_text: [{ plain_text: `an old comment ${i}` }],
  }));
  const recent = { id: "new-1", discussion_id: "D1", created_time: AFTER, created_by: { id: "N1", type: "person" }, rich_text: [{ plain_text: SAID_WHILE_AWAY }] };

  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes("/v1/blocks/")) return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });
    const second = u.includes("start_cursor=cursor-2");
    return new Response(
      JSON.stringify(second ? { results: [recent], has_more: false, next_cursor: null } : { results: ancient, has_more: true, next_cursor: "cursor-2" }),
      { status: 200 },
    );
  }) as never;

  const deps = (over: Record<string, unknown> = {}) => ({
    readComments: ((pageId: string, opts: Record<string, unknown>) => readNotionComments(pageId, { ...opts, ...over, fetch: fetchFn } as never)) as never,
    resolveCredential: (async () => ({ apiKey: "k" })) as never,
    domains: [],
  });

  calls.length = 0;
  const out = await fetchNotionCatchUpWindow({ container: PAGE, threadRoot: "D1", sinceMs: SINCE }, deps());
  ok(out.length === 1 && out[0]!.text === SAID_WHILE_AWAY, "🔴 notion/OPE-1831: a seat on a PAGE-ANCHORED discussion whose anchor has outgrown one page of comments STILL READS the comment said while it was away");
  ok(calls.filter((c) => c.includes("/v1/comments")).length === 2, "🔴 notion/OPE-1831: …because the sweep FOLLOWED the anchor's next_cursor. One call is the oldest hundred, and on this page every one of them predates the seat's last wake");
  ok(calls.some((c) => c.includes("start_cursor=cursor-2")), "notion/OPE-1831: the second call carries the cursor Notion handed back, so the pages are the same anchor's and not a repeat of the first");

  calls.length = 0;
  const unpaginated = await fetchNotionCatchUpWindow({ container: PAGE, threadRoot: "D1", sinceMs: SINCE }, deps({ maxCommentPages: 1 }));
  ok(unpaginated.length === 0, "🔴 notion/OPE-1831 CONTROL: the SAME page read with ONE call carries nothing said in the window — a discussion that did carry the message reads as a quiet room, with no error anywhere");
  ok(calls.filter((c) => c.includes("/v1/comments")).length === 1, "notion/OPE-1831 CONTROL: …and it really did make only the one call");

  calls.length = 0;
  const capEaten = await fetchNotionCatchUpWindow({ container: PAGE, threadRoot: "D1", sinceMs: SINCE }, deps({ sinceMs: undefined }));
  ok(capEaten.length === 0, "🔴 notion/OPE-1831 CONTROL: with the time window NOT handed to the sweep, the oldest hundred comments eat `maxComments` and the seat reads nothing — so the window bound is load-bearing beside the pagination, not a tidy-up");
  ok(calls.filter((c) => c.includes("/v1/comments")).length === 2, "notion/OPE-1831 CONTROL: …and the loss is the CAP's, not the fetch's — both pages were read, so the recent comment was in hand and was dropped");

  calls.length = 0;
  const small = (async (url: string) => {
    calls.push(String(url));
    return String(url).includes("/v1/blocks/")
      ? new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 })
      : new Response(JSON.stringify({ results: [recent], has_more: false, next_cursor: null }), { status: 200 });
  }) as never;
  const quiet1 = await fetchNotionCatchUpWindow({ container: PAGE, threadRoot: "D1", sinceMs: SINCE }, {
    readComments: ((pageId: string, opts: Record<string, unknown>) => readNotionComments(pageId, { ...opts, fetch: small } as never)) as never,
    resolveCredential: (async () => ({ apiKey: "k" })) as never,
    domains: [],
  });
  ok(quiet1.length === 1, "notion/OPE-1831: a page whose comments fit in one call reads exactly as before — the follow stops the moment Notion reports no more");
  ok(calls.filter((c) => c.includes("/v1/comments")).length === 1, "🔴 notion/OPE-1831: …and costs exactly ONE call, so the fix buys the deep read without charging every ordinary page for it");

  const overflowing = [...ancient, { ...ancient[0]!, id: "old-100" }];
  const pageOnly = (async (url: string) => {
    const u = String(url);
    if (u.includes("/v1/blocks/")) return new Response(JSON.stringify({ results: [{ id: "blk-1", paragraph: {} }], has_more: false }), { status: 200 });
    if (u.includes("block_id=blk-1")) return new Response(JSON.stringify({ results: [recent], has_more: false, next_cursor: null }), { status: 200 });
    return new Response(JSON.stringify({ results: overflowing, has_more: false, next_cursor: null }), { status: 200 });
  }) as never;
  const starved = await readNotionComments(PAGE, { apiKey: "k", fetch: pageOnly, maxComments: 100, maxBlockScans: 80 } as never);
  ok(starved.blocksScanned === 0 && starved.truncated, "🔴 notion/OPE-1831 CONTROL: a hundred ancient PAGE-level comments fill `maxComments` and the sweep stops with ZERO blocks scanned — the live-run shape, where the block walk that holds the seat's discussion never runs");
  ok(!starved.comments.some((c) => c.text === SAID_WHILE_AWAY), "🔴 notion/OPE-1831 CONTROL: …so the block-anchored comment is absent from a read that reported no error at all");
  const windowed = await readNotionComments(PAGE, { apiKey: "k", fetch: pageOnly, maxComments: 100, maxBlockScans: 80, sinceMs: SINCE } as never);
  ok(windowed.blocksScanned === 1, "🔴 notion/OPE-1831: handing the sweep the WINDOW un-starves the block walk — the ancient page comments no longer charge the cap, so the blocks are scanned");
  ok(windowed.comments.some((c) => c.text === SAID_WHILE_AWAY), "🔴 notion/OPE-1831: …and the BLOCK-anchored comment the seat was waiting for is in the read. This is the live-run fix, and the two lines above are its control");

  const endless = (async (url: string) =>
    String(url).includes("/v1/blocks/")
      ? new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 })
      : new Response(JSON.stringify({ results: ancient, has_more: true, next_cursor: "more" }), { status: 200 })) as never;
  const cut = await readNotionComments(PAGE, { apiKey: "k", fetch: endless, maxComments: 1000, maxBlockScans: 80, maxCommentPages: 2 } as never);
  ok(cut.truncated, "🔴 notion/OPE-1831: an anchor the PAGE BOUND cut off reports `truncated` — a short list that looks complete is a false claim about what the sweep saw");
  const whole = await readNotionComments(PAGE, { apiKey: "k", fetch: small, maxComments: 1000, maxBlockScans: 80, maxCommentPages: 2 } as never);
  ok(!whole.truncated, "notion/OPE-1831: NEGATIVE CONTROL — an anchor Notion finished reports `truncated` false, so the bit above is driven and not a constant");
}

{
  const PAGE = "page-long";
  const SAID_ON_A_NEW_BLOCK = "said on a block appended after the page passed 80 children";
  const children = Array.from({ length: 120 }, (_, i) => ({ id: `blk-${i}`, type: "paragraph", paragraph: { rich_text: [] } }));
  const recent = { id: "new-1", discussion_id: "D1", created_time: AFTER, created_by: { id: "N1", type: "person" }, rich_text: [{ plain_text: SAID_ON_A_NEW_BLOCK }] };

  const calls: string[] = [];
  const longPage = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/children")) {
      const second = u.includes("start_cursor=children-2");
      const slice = second ? children.slice(100) : children.slice(0, 100);
      return new Response(JSON.stringify({ results: slice, has_more: !second, next_cursor: second ? null : "children-2" }), { status: 200 });
    }
    const onLast = u.includes(`block_id=${children[119]!.id}`);
    return new Response(JSON.stringify({ results: onLast ? [recent] : [], has_more: false, next_cursor: null }), { status: 200 });
  }) as never;

  const notionDeps = (over: Record<string, unknown> = {}): NotionCatchUpDeps => ({
    readComments: ((pageId: string, opts: Record<string, unknown>) => readNotionComments(pageId, { ...opts, ...over, fetch: longPage } as never)) as never,
    resolveCredential: (async () => ({ apiKey: "k" })) as never,
    domains: [],
  });

  calls.length = 0;
  const read = await fetchNotionCatchUpWindow({ container: PAGE, sinceMs: SINCE }, notionDeps());
  ok(read.length === 1 && read[0]!.text === SAID_ON_A_NEW_BLOCK, "🔴 notion/OPE-1843: a PAGE-LEVEL seat on a 120-block page READS the discussion on the newest block — the scan budget is spent at the end of the page, where an append-only doc's live conversation is");
  ok(calls.filter((c) => /block_id=blk-/.test(c)).length === 80, "notion/OPE-1843: …within the SAME 80-block budget — the order changed, the cost did not");
  ok(calls.filter((c) => c.includes("/children")).length === 2, "notion/OPE-1843: finding the page's last child costs one `getBlockChildren` call per hundred blocks — two here, against the eighty comment-list calls the scan itself spends");

  calls.length = 0;
  const documentOrder = await readNotionComments(PAGE, { apiKey: "k", fetch: longPage, maxComments: 100, maxBlockScans: 80, sinceMs: SINCE } as never);
  ok(documentOrder.comments.length === 0, "🔴 notion/OPE-1843 CONTROL: the SAME page swept in DOCUMENT order reads NOTHING — the budget is spent on blocks 0-79 and the discussion is on block 119");
  ok(documentOrder.truncated, "notion/OPE-1843 CONTROL: …and the sweep DID know it was partial, so the coverage miss existed as a fact the read could not deliver anywhere");

  const shortChildren = [{ id: "blk-a", type: "paragraph", paragraph: { rich_text: [] } }, { id: "blk-b", type: "paragraph", paragraph: { rich_text: [] } }];
  const shortPage = (async (url: string) => {
    const u = String(url);
    if (u.includes("/children")) return new Response(JSON.stringify({ results: shortChildren, has_more: false, next_cursor: null }), { status: 200 });
    return new Response(JSON.stringify({ results: u.includes("block_id=blk-b") ? [recent] : [], has_more: false, next_cursor: null }), { status: 200 });
  }) as never;
  const inOrder = await readNotionComments(PAGE, { apiKey: "k", fetch: shortPage, maxComments: 100, maxBlockScans: 80, sinceMs: SINCE } as never);
  const reversed = await readNotionComments(PAGE, { apiKey: "k", fetch: shortPage, maxComments: 100, maxBlockScans: 80, sinceMs: SINCE, blockScanOrder: "newest-first" } as never);
  ok(inOrder.comments.length === 1 && reversed.comments.length === 1 && !inOrder.truncated && !reversed.truncated, "notion/OPE-1843: a page INSIDE the cap reads identically under both orders — only an over-cap page gains or pays anything");

  const rows: AuditInput[] = [];
  const audit = async (e: AuditInput): Promise<void> => { rows.push(e); };
  const req: SeatCatchUpRequest = { container: PAGE, sinceMs: SINCE, channelKey: "notion/ws-1/page-long" };
  const declared = { timestampPrecisionMs: NOTION_TIMESTAMP_PRECISION_MS };

  registerSeatCatchUp("notion", ((r: SeatCatchUpRequest) => fetchNotionCatchUpWindow({ container: r.container, sinceMs: r.sinceMs }, notionDeps())) as SeatCatchUpFetch, declared);
  rows.length = 0;
  const longRow = await seatCatchUp("notion", req, { audit, admit: () => true });
  const longDetail = JSON.stringify(rows[0]?.detail ?? {});

  const quietPage = (async (url: string) => {
    const u = String(url);
    if (u.includes("/children")) {
      const second = u.includes("start_cursor=children-2");
      return new Response(JSON.stringify({ results: second ? children.slice(100) : children.slice(0, 100), has_more: !second, next_cursor: second ? null : "children-2" }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
  }) as never;
  registerSeatCatchUp("notion", ((r: SeatCatchUpRequest) => fetchNotionCatchUpWindow({ container: r.container, sinceMs: r.sinceMs }, {
    readComments: ((pageId: string, opts: Record<string, unknown>) => readNotionComments(pageId, { ...opts, fetch: quietPage } as never)) as never,
    resolveCredential: (async () => ({ apiKey: "k" })) as never,
    domains: [],
  })) as SeatCatchUpFetch, declared);
  rows.length = 0;
  await seatCatchUp("notion", req, { audit, admit: () => true });
  const quietDetail = JSON.stringify(rows[0]?.detail ?? {});

  ok(longRow.messages.length === 1, "🔴 notion/OPE-1843: the shared road hands the seat the comment from the 120-block page — the coverage miss is closed at the road, not only inside the provider");
  ok(longDetail !== quietDetail, "🔴 notion/OPE-1843: …so the `seat.catch_up` row for a >80-block page carrying a discussion is NOT byte-identical to a quiet page's. This is the ticket's acceptance, and before the fix the two rows agreed exactly");
  ok(quietDetail.includes('"outcome":"empty"') && quietDetail.includes('"raw":0'), "notion/OPE-1843 CONTROL: the quiet page really does write `outcome=empty raw=0` — the row the over-cap page used to write too");
  ok(longDetail.includes('"outcome":"read"') && longDetail.includes('"kept":1'), "notion/OPE-1843: …and the read page writes `outcome=read kept=1`, which is a different row on the two keys a triage query reads first");

  _resetSeatCatchUp("notion");
}

{
  const urls: string[] = [];
  const request = async (url: string) => {
    urls.push(url);
    return {
      value: [
        { id: "m1", createdDateTime: AFTER, body: { content: "said while away" }, from: { user: { id: "E1", displayName: "Ada" } } },
        { id: "m2", createdDateTime: AFTER, body: { content: "a connector posted" }, from: { application: { displayName: "Flow" } } },
        { id: "m3", body: { content: "no create time" }, from: { user: { id: "E2" } } },
        { createdDateTime: AFTER, body: { content: "no id" }, from: { user: { id: "E3" } } },
        { id: "m4", createdDateTime: AFTER, body: { content: "no author at all" }, from: {} },
      ],
    };
  };
  const quiet = async () => {};
  ok(parseTeamsCatchUpContainer("team-1/chan-1")?.teamId === "team-1", "teams: the container carries BOTH ids Graph needs");
  ok(parseTeamsCatchUpContainer("chan-only") === undefined, "teams: a half address reads nothing rather than guessing a team");
  const out = await fetchTeamsCatchUpWindow({ container: "team-1/chan-1", sinceMs: SINCE }, { request, audit: quiet });
  ok(urls[0]?.includes("/teams/team-1/channels/chan-1/messages"), "teams: the catch-up reads over Microsoft Graph, the transport `read_channel` uses");
  ok(out.length === 2, "teams: both attributable messages survive");
  ok(out.every((m) => m.text !== "no create time"), "teams: a message Graph gave no create time for is DROPPED — core bounds the window by time");
  ok(out.every((m) => m.text !== "no id"), "teams: a message with no id is DROPPED — core dedupes and excludes the trigger by id");
  ok(out.every((m) => m.text !== "no author at all"), "teams: VISIBILITY GATE — a message Graph named no author for never reaches the seat");
  ok(out.some((m) => m.sender === "human") && out.some((m) => m.sender === "bot"), "teams: an application author is MARKED AWARENESS beside the person");
  const threaded = await fetchTeamsCatchUpWindow({ container: "team-1/chan-1", threadRoot: "root-1", sinceMs: SINCE }, { request, audit: quiet });
  ok(urls.length === 3 && urls[1]!.endsWith("/channels/chan-1/messages?$top=50"), "teams: a chain-bound wake still reads the CHANNEL — Graph's channel endpoint carries the chain roots");
  ok(urls[2]!.includes("/messages/root-1/replies"), "🔴 teams: …and ALSO the chain, because Graph serves roots and replies from different endpoints and neither holds the other");
  ok(threaded.some((m) => m.type === "thread" && m.threadId === "root-1"), "teams: the chain half tags its messages thread-scoped");
  ok(threaded.some((m) => m.type === "channel"), "teams: …and the channel half stays container-scoped — the two halves are told apart, not merged into one kind");
  await assert.rejects(
    () => fetchTeamsCatchUpWindow({ container: "team-1/chan-1", sinceMs: SINCE }, { request: async () => { throw new Error("down"); }, audit: quiet }),
    /every Graph read failed/,
  );
  ok(true, "teams: every Graph read failing reaches the shared failure boundary");
}

{
  const ROOT = "1757600000000";
  const reply = { id: "r1", createdDateTime: AFTER, body: { content: "said in the chain while away" }, from: { user: { id: "E1", displayName: "Ada" } } };
  const root = { id: ROOT, createdDateTime: "2026-09-11T11:00:00.000Z", body: { content: "the chain root" }, from: { user: { id: "E1" } } };
  const graph = async (url: string) => ({ value: url.includes(`/messages/${ROOT}/replies`) ? [reply] : [root] });

  const rows: AuditInput[] = [];
  const audit = async (entry: AuditInput) => {
    rows.push(entry);
  };
  const KEY = "teams/TEN-1/19-chan-1-thread.tacv2";

  const chain = await fetchTeamsCatchUpWindow({ container: "team-1/chan-1", threadRoot: ROOT, sinceMs: SINCE, channelKey: KEY }, { request: graph, audit });
  ok(chain.length === 1 && chain[0]!.text === "said in the chain while away", "🔴 teams/OPE-1817: a seat bound to a reply chain READS THAT CHAIN — the message said while it was idle comes back");

  const channelRead = await fetchTeamsCatchUpWindow({ container: "team-1/chan-1", sinceMs: SINCE, channelKey: KEY }, { request: graph, audit });
  ok(channelRead.length === 0, "🔴 teams/OPE-1817 CONTROL: the same recorded Graph answer read at the CHANNEL carries none of the chain's replies — the two live runs shape");

  ok(rows.length === 3 && rows.every((r) => r.action === TEAMS_CATCH_UP_ACTION), "teams/OPE-1817: every GRAPH CALL writes exactly one row, under one action name (two for a chain-bound wake, one for a container-bound one)");
  ok(rows[0]!.workspace === "TEN-1" && rows[0]!.surface === "19-chan-1-thread.tacv2", "teams/OPE-1817: the row is filed under the seat's own workspace and surface, from the domain-grain channel key");
  const rootsRow = rows[0]!.detail!;
  ok(rootsRow["resource"] === "channel-messages" && rootsRow["raw"] === 1 && rootsRow["kept"] === 0, "🔴 teams/OPE-1817: raw 1 / kept 0 on the channel half — the row separates OUR bound dropping a message from Graph returning none");
  const chainRow = rows[1]!.detail!;
  ok(chainRow["resource"] === "thread-replies" && String(chainRow["path"]).endsWith(`/messages/${ROOT}/replies`), "🔴 teams/OPE-1817: the second row names WHICH Graph call the read made, and the chain root it addressed");
  ok(chainRow["status"] === "ok" && chainRow["raw"] === 1 && chainRow["kept"] === 1, "teams/OPE-1817: a healthy read records the raw Graph count beside the kept count");
  ok(rows[2]!.detail!["resource"] === "channel-messages", "🔴 teams/OPE-1817: a wake naming NO chain makes the channel call ALONE — the field that tells the next red ship which container the seat read");

  rows.length = 0;
  const empty = await fetchTeamsCatchUpWindow({ container: "team-1/chan-1", threadRoot: ROOT, sinceMs: SINCE, channelKey: KEY }, { request: async () => ({ value: [] }), audit });
  ok(empty.length === 0 && rows.length === 2 && rows.every((r) => r.detail!["status"] === "ok" && r.detail!["raw"] === 0), "🔴 teams/OPE-1817: a genuine EMPTY page records status ok with raw 0");
  rows.length = 0;
  await assert.rejects(
    () => fetchTeamsCatchUpWindow(
      { container: "team-1/chan-1", threadRoot: ROOT, sinceMs: SINCE, channelKey: KEY },
      { request: async (u: string) => { throw new Error(`read: Teams Graph GET failed (HTTP 404) for ${u} — {"error":{"code":"NotFound"}}`); }, audit },
    ),
    /every Graph read failed/,
  );
  ok(true, "teams/OPE-1817: two 404s propagate to the shared fail-soft boundary");
  ok(rows.length === 2 && rows.every((r) => r.detail!["status"] === "error" && r.detail!["httpStatus"] === 404), "🔴 teams/OPE-1817: …and both rows say 404, so a 404 and an empty room are no longer the same evidence");
  ok(!JSON.stringify(rows[0]!.detail).includes("NotFound"), "teams/OPE-1817: the row takes the STATUS out of the vendor error and never the response body");

  rows.length = 0;
  const halfDown = await fetchTeamsCatchUpWindow(
    { container: "team-1/chan-1", threadRoot: ROOT, sinceMs: SINCE, channelKey: KEY },
    { request: async (u: string) => { if (!u.includes("/replies")) throw new Error("read: Teams Graph GET failed (HTTP 500) for x"); return { value: [reply] }; }, audit },
  );
  ok(halfDown.length === 1, "🔴 teams/OPE-1817: the channel call failing still returns the CHAIN's messages — fail-soft is per read, not per wake");
  ok(rows.length === 2 && rows[0]!.detail!["status"] === "error" && rows[1]!.detail!["status"] === "ok", "teams/OPE-1817: …and the two rows say which half failed");

  rows.length = 0;
  const half = await fetchTeamsCatchUpWindow({ container: "chan-only", sinceMs: SINCE, channelKey: KEY }, { request: graph, audit });
  ok(half.length === 0 && rows[0]!.detail!["status"] === "unaddressable" && rows[0]!.detail!["resource"] === "none", "teams/OPE-1817: a half address records `unaddressable` — no Graph call was made at all");

  rows.length = 0;
  await fetchTeamsCatchUpWindow({ container: "team-1/chan-1", threadRoot: ROOT, sinceMs: SINCE, channelKey: KEY }, { request: graph, audit });
  const dump = JSON.stringify(rows);
  ok(rows.length === 2 && dump.includes(ROOT), "teams/OPE-1817 PRECONDITION: both rows are in the dump, and it does carry the ids — so the absences below are measurements");
  ok(!dump.includes("said in the chain") && !dump.includes("the chain root"), "🔴 teams/OPE-1817: NEGATIVE CONTROL — neither call's message body reaches any audit row");
  ok(!dump.includes("Ada"), "🔴 teams/OPE-1817: …and no author name reaches one either");

  ok(teamsCatchUpScopeFromChannelKey(KEY)?.workspace === "TEN-1", "teams/OPE-1817: the domain-grain key splits into the row's workspace and surface");
  ok(teamsCatchUpScopeFromChannelKey("slack/W/C") === undefined && teamsCatchUpScopeFromChannelKey(undefined) === undefined, "teams/OPE-1817: a foreign or absent key yields NO scope — the row says `unknown` rather than borrowing another surface's");
}

{
  registerSlackProvider();
  registerDiscordProvider();
  registerTeamsProvider();
  registerGithubProvider();
  registerLinearProvider();
  registerNotionProvider();
  for (const platform of ["slack", "discord", "teams", "github", "linear", "notion"]) {
    const declared = surfaceParityFor(platform)?.["seat-catch-up"];
    const supported = declared === "supported" || (typeof declared === "object" && "supported" in declared);
    const registered = seatCatchUpFetchFor(platform) !== undefined;
    ok(declared !== undefined, `${platform}: the parity ledger answers the seat-catch-up row`);
    ok(
      supported === registered,
      `${platform}: the ledger and the registry agree — a surface never claims a catch-up it cannot do, nor hides one it can`,
    );
  }
}

{
  const BODY = "said while the seat was away";
  const CALL_SITES: Readonly<Record<string, string>> = {
    slack: "packages/providers/slack/agent/channels/slack-events.ts",
    discord: "packages/providers/discord/agent/channels/discord-gateway.ts",
    teams: "packages/providers/teams/agent/channels/teams-front.ts",
    github: "packages/providers/github/agent/channels/github.ts",
    linear: "packages/providers/linear/agent/channels/linear.ts",
    notion: "packages/providers/notion/agent/channels/notion.ts",
  };
  const rows: AuditInput[] = [];
  const audit = async (e: AuditInput) => {
    rows.push(e);
  };
  const drives: ReadonlyArray<{
    readonly platform: string;
    readonly req: SeatCatchUpRequest;
    readonly reads: SeatCatchUpFetch;
    readonly empty: SeatCatchUpFetch;
    readonly fails: SeatCatchUpFetch;
  }> = [
    {
      platform: "slack",
      req: { container: "C1", sinceMs: SINCE, channelKey: "slack/T1/C1" },
      reads: (r) =>
        fetchSlackSeatCatchUp(r, {
          request: async () => ({ ok: true, messages: [{ ts: String((SINCE + 60_000) / 1000), user: "U1", text: BODY }] }),
          identity: async () => ({ userId: "UBOT", botId: "BBOT" }),
        }),
      empty: (r) => fetchSlackSeatCatchUp(r, { request: async () => ({ ok: true, messages: [] }), identity: async () => ({}) }),
      fails: (r) => fetchSlackSeatCatchUp(r, { request: async () => { throw new Error("slack unavailable"); }, identity: async () => ({}) }),
    },
    {
      platform: "discord",
      req: { container: "CH", sinceMs: SINCE, channelKey: "discord/G1/CH" },
      reads: (r) =>
        fetchDiscordSeatCatchUp(r, {
          request: async () => [{ id: "200", type: 0, timestamp: new Date(SINCE + 60_000).toISOString(), content: BODY, author: { id: "D1" } }],
        }),
      empty: (r) => fetchDiscordSeatCatchUp(r, { request: async () => [] }),
      fails: (r) => fetchDiscordSeatCatchUp(r, { request: async () => { throw new Error("discord unavailable"); } }),
    },
    {
      platform: "teams",
      req: { container: "team-1/chan-1", sinceMs: SINCE, channelKey: "teams/TEN-1/chan-1" },
      reads: (r) =>
        fetchTeamsCatchUpWindow(r, {
          request: async () => ({ value: [{ id: "m1", createdDateTime: AFTER, body: { content: BODY }, from: { user: { id: "E1" } } }] }),
          audit: async () => {},
        }),
      empty: (r) => fetchTeamsCatchUpWindow(r, { request: async () => ({ value: [] }), audit: async () => {} }),
      fails: (r) => fetchTeamsCatchUpWindow(r, { request: async () => { throw new Error("teams unavailable"); }, audit: async () => {} }),
    },
    {
      platform: "github",
      req: { container: "acme/web#42", sinceMs: SINCE, channelKey: "github/acme/web-42" },
      reads: (r) =>
        fetchGitHubCatchUpWindow(r, {
          fetchFn: (async () => ({ ok: true, json: async () => [{ id: 11, created_at: AFTER, body: BODY, user: { login: "ada" } }] })) as never,
          resolveToken: async () => "t",
        }),
      empty: (r) => fetchGitHubCatchUpWindow(r, { fetchFn: (async () => ({ ok: true, json: async () => [] })) as never, resolveToken: async () => "t" }),
      fails: (r) => fetchGitHubCatchUpWindow(r, { fetchFn: (async () => { throw new Error("github unavailable"); }) as never, resolveToken: async () => "t" }),
    },
    {
      platform: "linear",
      req: { container: "OPE-42", sinceMs: SINCE, channelKey: "linear/org-b/OPE-42" },
      reads: (r) =>
        fetchLinearCatchUpWindow(r, {
          readIssue: (async () => ({ description: "", comments: [{ id: "c-new", authorId: "L1", createdAt: AFTER, text: BODY }], truncated: false })) as never,
        }),
      empty: (r) => fetchLinearCatchUpWindow(r, { readIssue: (async () => ({ description: "", comments: [], truncated: false })) as never }),
      fails: (r) => fetchLinearCatchUpWindow(r, { readIssue: (async () => { throw new Error("linear unavailable"); }) as never }),
    },
    {
      platform: "notion",
      req: { container: "page-1", threadRoot: "D1", sinceMs: SINCE, channelKey: "notion/ws-1/page-1" },
      reads: (r) =>
        fetchNotionCatchUpWindow(r, {
          readComments: (async () => ({
            discussionCount: 1,
            blocksScanned: 1,
            truncated: false,
            comments: [{ discussionId: "D1", authorId: "N1", authorKind: "person", createdTime: AFTER, text: BODY }],
          })) as never,
          resolveCredential: (async () => ({ apiKey: "k" })) as never,
          domains: [],
        }),
      empty: (r) =>
        fetchNotionCatchUpWindow(r, {
          readComments: (async () => ({ discussionCount: 0, blocksScanned: 1, truncated: false, comments: [] })) as never,
          resolveCredential: (async () => ({ apiKey: "k" })) as never,
          domains: [],
        }),
      fails: (r) =>
        fetchNotionCatchUpWindow(r, {
          readComments: (async () => { throw new Error("notion unavailable"); }) as never,
          resolveCredential: (async () => ({ apiKey: "k" })) as never,
          domains: [],
        }),
    },
  ];

  ok(drives.length === 6, "OPE-1831: the row is asked of all SIX surfaces — a drive list short of one is a surface nobody checked");

  for (const d of drives) {
    const real = seatCatchUpFetchFor(d.platform);
    ok(real !== undefined, `🔴 ${d.platform}: ON THE SHARED ROAD — its provider registers a catch-up fetch, so its reads go through \`seatCatchUp\` and get the row with them`);
    const declared: { readonly timestampPrecisionMs: number } = { timestampPrecisionMs: seatCatchUpPrecisionFor(d.platform) };

    const wiring = readFileSync(fileURLToPath(new URL(`../${CALL_SITES[d.platform]!}`, import.meta.url)), "utf-8");
    ok(
      new RegExp(`seatCatchUp\\(\\s*\\n?\\s*"${d.platform}"`).test(wiring),
      `🔴 ${d.platform}: its wake path CALLS \`seatCatchUp("${d.platform}", …)\` — the registration proves the fetch exists, and only the call site proves the seam is reached at all (${CALL_SITES[d.platform]})`,
    );

    rows.length = 0;
    registerSeatCatchUp(d.platform, d.reads, declared);
    const res = await seatCatchUp(d.platform, d.req, { audit, admit: () => true });
    ok(res.messages.length === 1, `${d.platform} PRECONDITION: the canned transport really did reach the seat — without this the row assertions below would pass on a fetch that read nothing`);
    ok(rows.length === 1, `🔴 ${d.platform}: driving the catch-up writes EXACTLY ONE audit row — not zero, and not one per vendor call`);
    ok(rows[0]!.action === SEAT_CATCH_UP_ACTION && rows[0]!.platform === d.platform, `${d.platform}: the row is the shared \`seat.catch_up\` action, stamped with this surface's own platform`);
    ok(rows[0]!.detail!["outcome"] === "read", `🔴 ${d.platform}: …and it says \`read\` — the outcome this drive forced`);
    ok(rows[0]!.detail!["raw"] === 1 && rows[0]!.detail!["kept"] === 1, `${d.platform}: the row carries the raw count beside the kept count`);
    ok(rows[0]!.detail!["container"] === d.req.container, `${d.platform}: the row names the container the seat was asked to read`);
    ok(!JSON.stringify(rows[0]).includes(BODY), `🔴 ${d.platform}: NEGATIVE CONTROL — the message body never reaches the row, on this surface as on every other`);

    rows.length = 0;
    registerSeatCatchUp(d.platform, d.empty, declared);
    await seatCatchUp(d.platform, d.req, { audit, admit: () => true });
    ok(rows.length === 1 && rows[0]!.detail!["outcome"] === "empty", `🔴 ${d.platform}: a quiet room writes its own row, reading \`empty\` — an empty catch-up is now a RECORDED fact on every surface, not an absence`);

    rows.length = 0;
    registerSeatCatchUp(d.platform, d.fails, declared);
    const failed = await seatCatchUp(d.platform, d.req, { audit, admit: () => true });
    ok(failed.messages.length === 0, `${d.platform}: a failed catch-up remains fail-soft to the wake`);
    ok(rows.length === 1 && rows[0]!.detail!["outcome"] === "failed", `🔴 ${d.platform}/OPE-1842: a transport failure writes \`failed\`, never the quiet-room \`empty\` outcome`);
    ok(rows[0]!.detail!["reason"] === "fetch-threw", `${d.platform}: the shared failure row names the fetch boundary without recording message content`);

    registerSeatCatchUp(d.platform, real!, declared);
    ok(seatCatchUpFetchFor(d.platform) === real, `${d.platform}: the real fetch is back on the road after the drive`);
    ok(seatCatchUpPrecisionFor(d.platform) === declared.timestampPrecisionMs, `${d.platform}: …under its OWN declared stamp unit, not the default a stub registration would have left behind`);
  }

  rows.length = 0;
  _resetSeatCatchUp("nosuchsurface");
  const gone = await seatCatchUp("nosuchsurface", { container: "X", sinceMs: SINCE }, { audit });
  ok(gone.unavailable !== undefined, "OPE-1831 PRECONDITION: an unregistered platform still answers with the unavailable note");
  ok(rows.length === 1 && rows[0]!.detail!["outcome"] === "unavailable", "🔴 OPE-1831: a surface OFF the road records `unavailable`, not `empty` — the fact a red ship needs and the one an empty message list destroyed");
}

{
  const UNITS: ReadonlyArray<{ platform: string; ms: number; constant: number; why: string }> = [
    { platform: "slack", ms: 1, constant: SLACK_TIMESTAMP_PRECISION_MS, why: "a Slack `ts` is a second with a six-digit fraction" },
    { platform: "discord", ms: 1, constant: DISCORD_TIMESTAMP_PRECISION_MS, why: "a snowflake encodes milliseconds" },
    { platform: "teams", ms: 1, constant: TEAMS_TIMESTAMP_PRECISION_MS, why: "Graph `createdDateTime` carries milliseconds" },
    { platform: "linear", ms: 1, constant: LINEAR_TIMESTAMP_PRECISION_MS, why: "GraphQL `createdAt` carries milliseconds" },
    { platform: "github", ms: 1_000, constant: GITHUB_TIMESTAMP_PRECISION_MS, why: "`created_at` is stamped to the SECOND" },
    { platform: "notion", ms: 60_000, constant: NOTION_TIMESTAMP_PRECISION_MS, why: "`created_time` floors to the MINUTE (OPE-1711)" },
  ];
  ok(UNITS.length === 6, "OPE-1847: the unit is asked of all SIX surfaces — a table short of one is a surface nobody checked");

  const rows: AuditInput[] = [];
  const audit = async (e: AuditInput) => {
    rows.push(e);
  };
  const WAKE = Date.parse("2026-01-15T12:40:31.400Z");

  for (const u of UNITS) {
    const register = readFileSync(fileURLToPath(new URL(`../packages/providers/${u.platform}/agent/register.ts`, import.meta.url)), "utf-8");
    ok(
      new RegExp(`registerSeatCatchUp\\("${u.platform}",[^;]*timestampPrecisionMs:`).test(register),
      `🔴 ${u.platform}: its provider DECLARES a stamp unit when it registers its catch-up fetch — ${u.why}`,
    );

    ok(u.constant === u.ms, `${u.platform}: its declared unit is ${u.ms} ms — ${u.why}`);
    ok(seatCatchUpPrecisionFor(u.platform) === u.ms, `🔴 ${u.platform}: …and the LIVE registry reports that unit, so the road applies what the provider declared rather than the default`);

    const unitFloor = (ms: number): number => Math.floor(ms / u.ms) * u.ms;
    const TRIGGER_STAMP = unitFloor(WAKE);
    const LAST_WAKE = WAKE - 90_000;
    const line = (id: string, ms: number, text: string): NormalizedMessage => ({ id, ms, authorId: "U1", sender: "human", type: "channel", text });
    const fixture = [
      line("way-old", unitFloor(LAST_WAKE) - u.ms, "the previous wake read this"),
      line("since-unit-floor", unitFloor(LAST_WAKE), "said just after the seat looked away"),
      line("trigger-unit-floor", TRIGGER_STAMP, "the build token you are being asked about"),
      line("trig", TRIGGER_STAMP, "the message that woke the seat"),
      line("next-unit", TRIGGER_STAMP + u.ms, "posted after the wake was dispatched"),
    ];
    const stub: SeatCatchUpFetch = async (r) => fixture.filter((m) => m.ms >= r.sinceMs);
    const req = { container: "C1", sinceMs: LAST_WAKE, untilMs: TRIGGER_STAMP, excludeId: "trig", channelKey: `${u.platform}/WS-1/room-1` };
    const real = seatCatchUpFetchFor(u.platform);
    rows.length = 0;
    registerSeatCatchUp(u.platform, stub, { timestampPrecisionMs: u.ms });
    const kept = (await seatCatchUp(u.platform, req, { audit, admit: () => true })).messages.map((m) => m.id);
    ok(kept.includes("trigger-unit-floor"), `🔴 ${u.platform}: a message stamped at the TRIGGER'S OWN instant reaches the seat — the live-run defect, asked of this surface`);
    ok(kept.includes("since-unit-floor"), `🔴 ${u.platform}: the message at the FLOOR of the last wake's own unit reaches the seat — below the unfloored \`lastWakeAt\` on a coarse surface, and exactly at an inclusive bound on a millisecond-grain one`);
    ok(!kept.includes("trig"), `🔴 ${u.platform}: the wake's OWN message is removed BY ID and never arrives twice — the only removal that works once the bound admits the trigger's whole unit`);
    ok(!kept.includes("way-old"), `${u.platform}: a message a whole unit before the window is still dropped — the widening is one unit, not an open window`);
    ok(!kept.includes("next-unit"), `${u.platform}: a message in the NEXT unit is still dropped — the widening is one unit at the top too`);
    ok(rows.length === 1 && rows[0]!.detail!["precisionMs"] === u.ms, `${u.platform}: the \`seat.catch_up\` row carries the unit it applied, so a red ship names the bound without a second deploy`);

    registerSeatCatchUp(u.platform, stub, {});
    const bare = (await seatCatchUp(u.platform, req, { audit, admit: () => true })).messages.map((m) => m.id);
    if (u.ms === DEFAULT_TIMESTAMP_PRECISION_MS) {
      ok(bare.length === kept.length, `${u.platform}: NEGATIVE CONTROL — this surface stamps at the default unit, so removing its declaration changes nothing HERE; the source check (a1) is what holds the declaration on it`);
    } else {
      ok(!bare.includes("since-unit-floor") && bare.length < kept.length, `🔴 ${u.platform}: NEGATIVE CONTROL — with the declaration REMOVED the same window LOSES the message inside the last wake's own unit, so the widening is what does the work`);
    }
    registerSeatCatchUp(u.platform, real!, { timestampPrecisionMs: u.ms });
  }
}

{
  const BODY = "a member spoke while the seat was away";
  const rows: AuditInput[] = [];
  const audit = async (e: AuditInput) => {
    rows.push(e);
  };
  const SINCE_FRESH = SINCE - 6 * 3600_000;
  const admissionDrives: ReadonlyArray<{
    readonly platform: string;
    readonly req: SeatCatchUpRequest;
    readonly member: SeatCatchUpFetch;
    readonly machine?: SeatCatchUpFetch;
  }> = [
    {
      platform: "slack",
      req: { container: "C1", sinceMs: SINCE_FRESH, channelKey: "slack/T1/C1" },
      member: (r) =>
        fetchSlackSeatCatchUp(r, {
          request: async () => ({ ok: true, messages: [{ ts: String((SINCE + 60_000) / 1000), user: "U1", text: BODY }] }),
          identity: async () => ({ userId: "UBOT", botId: "BBOT" }),
        }),
      machine: (r) =>
        fetchSlackSeatCatchUp(r, {
          request: async () => ({ ok: true, messages: [{ ts: String((SINCE + 60_000) / 1000), bot_id: "B9", text: BODY }] }),
          identity: async () => ({ userId: "UBOT", botId: "BBOT" }),
        }),
    },
    {
      platform: "discord",
      req: { container: "CH", sinceMs: SINCE_FRESH, channelKey: "discord/G1/CH" },
      member: (r) =>
        fetchDiscordSeatCatchUp(r, {
          request: async () => [{ id: "200", type: 0, timestamp: new Date(SINCE + 60_000).toISOString(), content: BODY, author: { id: "D1" } }],
        }),
      machine: (r) =>
        fetchDiscordSeatCatchUp(r, {
          request: async () => [{ id: "201", type: 0, timestamp: new Date(SINCE + 60_000).toISOString(), content: BODY, author: { id: "D9", bot: true } }],
        }),
    },
    {
      platform: "teams",
      req: { container: "team-1/chan-1", sinceMs: SINCE_FRESH, channelKey: "teams/TEN-1/chan-1" },
      member: (r) =>
        fetchTeamsCatchUpWindow(r, {
          request: async () => ({ value: [{ id: "m1", createdDateTime: AFTER, body: { content: BODY }, from: { user: { id: "E1" } } }] }),
          audit: async () => {},
        }),
      machine: (r) =>
        fetchTeamsCatchUpWindow(r, {
          request: async () => ({ value: [{ id: "m9", createdDateTime: AFTER, body: { content: BODY }, from: { application: { id: "APP9" } } }] }),
          audit: async () => {},
        }),
    },
    {
      platform: "github",
      req: { container: "acme/web#42", sinceMs: SINCE_FRESH, channelKey: "github/acme/web-42" },
      member: (r) =>
        fetchGitHubCatchUpWindow(r, {
          fetchFn: (async () => ({ ok: true, json: async () => [{ id: 11, created_at: AFTER, body: BODY, user: { login: "ada" } }] })) as never,
          resolveToken: async () => "t",
        }),
      machine: (r) =>
        fetchGitHubCatchUpWindow(r, {
          fetchFn: (async () => ({ ok: true, json: async () => [{ id: 19, created_at: AFTER, body: BODY, user: { login: "robo", type: "Bot" } }] })) as never,
          resolveToken: async () => "t",
        }),
    },
    {
      platform: "linear",
      req: { container: "OPE-42", sinceMs: SINCE_FRESH, channelKey: "linear/org-b/OPE-42" },
      member: (r) =>
        fetchLinearCatchUpWindow(r, {
          readIssue: (async () => ({ description: "", comments: [{ id: "c-new", authorId: "L1", createdAt: AFTER, text: BODY }], truncated: false })) as never,
        }),
    },
    {
      platform: "notion",
      req: { container: "page-1", threadRoot: "D1", sinceMs: SINCE_FRESH, channelKey: "notion/ws-1/page-1" },
      member: (r) =>
        fetchNotionCatchUpWindow(r, {
          readComments: (async () => ({
            discussionCount: 1,
            blocksScanned: 1,
            truncated: false,
            comments: [{ discussionId: "D1", authorId: "N1", createdTime: AFTER, text: BODY }],
          })) as never,
          resolveCredential: (async () => ({ apiKey: "k" })) as never,
          domains: [],
        }),
      machine: (r) =>
        fetchNotionCatchUpWindow(r, {
          readComments: (async () => ({
            discussionCount: 1,
            blocksScanned: 1,
            truncated: false,
            comments: [{ discussionId: "D1", authorId: "N9", authorKind: "bot", createdTime: AFTER, text: BODY }],
          })) as never,
          resolveCredential: (async () => ({ apiKey: "k" })) as never,
          domains: [],
        }),
    },
  ];

  ok(admissionDrives.length === 6, "🔴 OPE-1857: the admission road is asked of all SIX surfaces — a drive list short of one is a surface whose seat nobody checked");

  for (const d of admissionDrives) {
    const real = seatCatchUpFetchFor(d.platform);
    const declared: { readonly timestampPrecisionMs: number } = { timestampPrecisionMs: seatCatchUpPrecisionFor(d.platform) };

    rows.length = 0;
    registerSeatCatchUp(d.platform, d.member, declared);
    const got = await seatCatchUp(d.platform, d.req, { audit });
    ok(
      got.messages.length === 1 && got.messages[0]!.from === "human",
      `🔴 ${d.platform}: an ordinary member's message whose bot signal the VENDOR OMITS reaches the seat as a PERSON — the live-run defect, asked of this surface`,
    );
    ok(
      rows.length === 1 && rows[0]!.detail!["outcome"] === "read" && rows[0]!.detail!["kept"] === 1,
      `🔴 ${d.platform}: …and its row reads \`read kept=1\`, not the \`empty raw=1 kept=0 admission-dropped-all\` a fail-open-to-bot normalizer writes`,
    );

    if (d.machine) {
      rows.length = 0;
      registerSeatCatchUp(d.platform, d.machine, declared);
      const refused = await seatCatchUp(d.platform, d.req, { audit });
      ok(
        refused.messages.length === 0,
        `🔴 ${d.platform}: a MACHINE author the vendor positively names is REFUSED with no \`admit\` passed — proof the shared road resolved the domain's policy itself, and the negative control that stops (a) passing on an unpoliced read`,
      );
      ok(
        rows.length === 1 && rows[0]!.detail!["reason"] === "admission-dropped-all",
        `${d.platform}: …and the row names the stage that emptied it, so the next red ship reads the policy off the row`,
      );
    }

    registerSeatCatchUp(d.platform, real!, declared);
    ok(seatCatchUpFetchFor(d.platform) === real && seatCatchUpPrecisionFor(d.platform) === declared.timestampPrecisionMs, `${d.platform}: the real fetch is back on the road under its own declared unit`);
  }
}

{
  const SELF = "00000000-0000-4000-8000-0000000005e1";
  const asked: string[] = [];
  const drive = (selfActorIdFor?: NotionCatchUpDeps["selfActorIdFor"]) =>
    fetchNotionCatchUpWindow(
      { container: "page-1", threadRoot: "D1", sinceMs: SINCE, channelKey: "notion/ws-1/page-1" },
      {
        readComments: (async () => ({
          discussionCount: 1,
          blocksScanned: 1,
          truncated: false,
          comments: [{ discussionId: "D1", authorId: SELF, createdTime: AFTER, text: "the seat's own previous reply" }],
        })) as never,
        resolveCredential: (async () => ({ apiKey: "k" })) as never,
        domains: [],
        ...(selfActorIdFor ? { selfActorIdFor } : {}),
      },
    );

  const own = await drive(async (credentialId) => {
    asked.push(credentialId);
    return SELF;
  });
  ok(own.length === 1 && own[0]!.sender === "self", "🔴 OPE-1857: a comment authored by the DEPLOYMENT'S OWN integration normalizes as `self` — the seat meets its own prior reply as its own words, not as a person's");
  ok(own[0]!.authorId === undefined, "OPE-1857: …and carries no author id, the shape every other surface's self post has");
  ok(asked.length === 1 && asked[0] === "channel-key", "OPE-1857: the self id is resolved under the key the ORG DEFAULT integration is stored as, which is the same key the ingress road's own cache uses — one integration, one memoised answer");

  const unresolved = await drive();
  ok(unresolved.length === 1 && unresolved[0]!.sender === "human", "🔴 OPE-1857: NEGATIVE CONTROL — with no self resolver the identical comment reads as a PERSON, so the resolver is what does the work");

  const src = readFileSync(fileURLToPath(new URL("../packages/providers/notion/agent/channels/notion-catch-up.ts", import.meta.url)), "utf-8");
  ok(/const liveDeps[\s\S]{0,600}?selfActorIdFor:/u.test(src), "🔴 OPE-1857: the LIVE deps resolve the self actor id — an injected seam proven in a test and absent from `liveDeps` would leave the deployment with the defect the assertions above just ruled out");
}

console.log(`seat-catch-up parity: ${n} assertions passed`);
