import assert from "node:assert/strict";
import { seatCatchUpFetchFor, surfaceParityFor, type NormalizedMessage } from "@open-everywhere/core/agent/adapter-api.js";
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
import { fetchNotionCatchUpWindow } from "@open-everywhere/provider-notion/agent/channels/notion-catch-up.js";
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
  const soft = await fetchSlackSeatCatchUp({ container: "C1", sinceMs: SINCE }, { request: async () => { throw new Error("down"); }, identity: async () => ({}) });
  ok(soft.length === 0, "slack: a throwing transport fails soft to empty");
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
  const soft = await fetchDiscordSeatCatchUp({ container: "CH", sinceMs: SINCE }, { request: async () => { throw new Error("down"); } });
  ok(soft.length === 0, "discord: a throwing transport fails soft to empty");
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
  const soft = await fetchGitHubCatchUpWindow({ container: "acme/web#42", sinceMs: SINCE }, { fetchFn: (async () => { throw new Error("down"); }) as never, resolveToken: async () => "t" });
  ok(soft.length === 0, "github: a throwing transport fails soft to empty");
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
  const soft = await fetchLinearCatchUpWindow({ container: "OPE-42", sinceMs: SINCE }, { readIssue: (async () => { throw new Error("down"); }) as never });
  ok(soft.length === 0, "linear: a throwing read fails soft to empty");
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
        { discussionId: "D1", authorId: "N1", authorKind: "person", createdTime: AFTER, text: "said while away" },
        { discussionId: "D1", authorId: "N2", authorKind: "bot", createdTime: AFTER, text: "an integration posted" },
        { discussionId: "D1", createdTime: AFTER, text: "no author" },
        { discussionId: "D2", authorId: "N3", authorKind: "person", createdTime: AFTER, text: "a different discussion" },
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
  askedCredential.length = 0;
  await fetchNotionCatchUpWindow(
    { container: "page-1", sinceMs: SINCE, channelKey: "notion/ws-1/page-1" },
    { readComments, resolveCredential, domains: [] },
  );
  ok(askedCredential.length === 1, "notion: the credential is resolved once per read");
  const unconfigured = await fetchNotionCatchUpWindow({ container: "page-1", sinceMs: SINCE }, { readComments, resolveCredential: (async () => undefined) as never });
  ok(unconfigured.length === 0, "notion: an unresolvable credential reads nothing rather than guessing a key");
  const soft = await fetchNotionCatchUpWindow({ container: "page-1", sinceMs: SINCE }, { readComments: (async () => { throw new Error("down"); }) as never, resolveCredential });
  ok(soft.length === 0, "notion: a throwing read fails soft to empty");
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
  const soft = await fetchTeamsCatchUpWindow({ container: "team-1/chan-1", sinceMs: SINCE }, { request: async () => { throw new Error("down"); }, audit: quiet });
  ok(soft.length === 0, "teams: a throwing Graph call fails soft to empty (the requester itself fails LOUD by contract)");
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
  const failed = await fetchTeamsCatchUpWindow(
    { container: "team-1/chan-1", threadRoot: ROOT, sinceMs: SINCE, channelKey: KEY },
    { request: async (u: string) => { throw new Error(`read: Teams Graph GET failed (HTTP 404) for ${u} — {"error":{"code":"NotFound"}}`); }, audit },
  );
  ok(failed.length === 0, "teams/OPE-1817: a 404 still fails soft — a wake never depends on its catch-up");
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

console.log(`seat-catch-up parity: ${n} assertions passed`);
