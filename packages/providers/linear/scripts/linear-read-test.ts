import assert from "node:assert/strict";
import {
  registerConfig,
  resolveReadAdapter,
  supportedReadPlatforms,
  READ_ADAPTERS,
  ChannelScopeError,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerLinearProvider } from "../agent/register.js";
import { linearReadAdapter, linearRootComments, linearThreadLines, linearTopicLine } from "../agent/channels/linear-read.js";
import { readLinearIssue, type LinearCommentSummary } from "../agent/channels/linear-api.js";

registerLinearProvider();

const ORG = "org-1";
const TEAM = "team-pay";
const OWN_ISSUE = "issue-own";
const OTHER_ISSUE = "issue-other";
const DOMAINS: readonly Domain[] = [{ name: "pay", reach: [`linear/${ORG}/${TEAM}`] }] as unknown as readonly Domain[];
registerConfig({ loadDomains: () => DOMAINS } as unknown as Parameters<typeof registerConfig>[0]);

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}
function eq(a: unknown, b: unknown, label: string): void {
  assert.deepStrictEqual(a, b, label);
  passed++;
}
async function throws(fn: () => Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => err instanceof ChannelScopeError, label);
  passed++;
}

function linearTurn(opts: { issue?: string; comment?: string; parent?: string } = {}): BindableContext {
  return {
    channel: { kind: "linear" },
    session: {
      auth: {
        current: {
          attributes: {
            organization_id: ORG,
            team_id: TEAM,
            ...(opts.issue ? { issue_id: opts.issue } : {}),
            ...(opts.comment ? { comment_id: opts.comment } : {}),
            ...(opts.parent ? { parent_comment_id: opts.parent } : {}),
          },
          principalId: "U_LINEAR",
          principalType: "linear-user",
          authenticator: "linear",
        },
      },
    },
  } as unknown as BindableContext;
}

const RAW_NODES_NEWEST_FIRST = [
  { id: "c5", body: "and another root", createdAt: "t5", user: { id: "u3", displayName: "carol" } },
  { id: "c4", body: "deep reply", createdAt: "t4", parent: { id: "c3" }, user: { id: "u1", displayName: "alice" } },
  { id: "c3", body: "reply to root 1", createdAt: "t3", parent: { id: "c1" }, user: { id: "u2", displayName: "bob" } },
  { id: "c2", body: "second root", createdAt: "t2", user: { id: "u2", displayName: "bob" } },
  { id: "c1", body: "first root", createdAt: "t1", user: { id: "u1", displayName: "alice" } },
];

const ISSUE_PAYLOAD = {
  id: OWN_ISSUE,
  identifier: "PAY-7",
  title: "Balances drift",
  description: "the ledger disagrees",
  createdAt: "t0",
  creator: { id: "u1", name: "Alice A", displayName: "alice" },
  state: { name: "Todo", type: "unstarted" },
  comments: { nodes: RAW_NODES_NEWEST_FIRST, pageInfo: { hasNextPage: false } },
};

function transport(payload: unknown = ISSUE_PAYLOAD): { api: { fetch: typeof fetch }; bodies: string[] } {
  const bodies: string[] = [];
  const fetchFn = (async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? "");
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ data: { issue: payload } }),
      json: async () => ({ data: { issue: payload } }),
    };
  }) as unknown as typeof fetch;
  return { api: { fetch: fetchFn }, bodies };
}

const CREDENTIALS = { accessToken: "linear-test-token" };
function deps(t: ReturnType<typeof transport>, teamOf: Record<string, string | undefined> = {}) {
  return {
    api: t.api,
    credentials: CREDENTIALS,
    resolveIssueTeam: async (ref: string) => teamOf[ref],
  };
}

ok(supportedReadPlatforms().includes("linear"), "registerLinearProvider registers the linear read adapter");
ok(READ_ADAPTERS["linear"] === linearReadAdapter, "…and the registered adapter IS this bundle's");
{
  const resolved = resolveReadAdapter(linearTurn({ issue: OWN_ISSUE }), undefined, DOMAINS);
  ok(resolved.platform === "linear", "a linear turn resolves the linear platform");
  ok(resolved.adapter === linearReadAdapter, "…and resolves this adapter, not a 'not supported' throw");
}

eq(
  linearReadAdapter.wakeAddress(linearTurn({ issue: OWN_ISSUE, comment: "c1" })),
  { container: OWN_ISSUE, threadRoot: "c1" },
  "a TOP-LEVEL comment turn names the issue and the comment as its own thread root",
);
eq(
  linearReadAdapter.wakeAddress(linearTurn({ issue: OWN_ISSUE, comment: "c3", parent: "c1" })),
  { container: OWN_ISSUE, threadRoot: "c1" },
  "a THREADED reply turn names the issue and the thread's ROOT, not the reply",
);
eq(
  linearReadAdapter.wakeAddress(linearTurn({ issue: OWN_ISSUE })),
  { container: OWN_ISSUE },
  "a native @mention turn (no triggering comment) names the issue and NO thread root",
);
eq(linearReadAdapter.wakeAddress(linearTurn({})), undefined, "a turn with no issue names NO container (explicit undefined)");

{
  const t = transport();
  const read = await readLinearIssue(OWN_ISSUE, { api: t.api, credentials: CREDENTIALS });
  eq(
    read.comments.map((c) => c.id),
    ["c1", "c2", "c3", "c4", "c5"],
    "the newest-first page comes back CHRONOLOGICAL — oldest first",
  );
  eq(read.comments[0]?.parentId, undefined, "a top-level comment carries no parent id");
  eq(read.comments[2]?.parentId, "c1", "a threaded reply carries its root's id");
  eq(read.creatorName, "alice", "the issue's creator rides the read — the topic line's author");
  eq(read.createdAt, "t0", "…and its creation time — the topic line's timestamp");
  ok(t.bodies[0]?.includes("parent"), "the query asks Linear for each comment's parent");
  ok(t.bodies[0]?.includes("creator"), "…and for the issue's creator");
}

{
  const t = transport();
  const { lines, possiblyIncomplete } = await linearReadAdapter.readChannel(linearTurn({ issue: OWN_ISSUE, comment: "c1" }), OWN_ISSUE, 50, deps(t));
  eq(lines.length, 4, "the channel read is the topic plus the three ROOT comments");
  eq(possiblyIncomplete, false, "🔴 OPE-1015: a fully-fetched, untruncated issue DECLARES itself complete — not left absent for the heuristic to guess");
  const topic = lines[0]!;
  eq(
    { author: topic.author, authorId: topic.authorId, ts: topic.ts, text: topic.text, live: topic.live },
    { author: "alice", authorId: "u1", ts: "t0", text: "Balances drift [Todo]\n\nthe ledger disagrees", live: true },
    "🔴 OPE-1038: the first line carries the issue's STATE in its headline. 🔴 OPE-1039: it is marked LIVE — the channel's current state",
  );
  ok(typeof topic.readAt === "string" && topic.readAt.length > 0, "🔴 OPE-1039: the topic line carries a readAt stamp");
  eq(
    lines.slice(1).map((l) => l.text),
    ["first root", "second root", "and another root"],
    "…and the rest are the top-level comments, oldest first",
  );
  ok(
    lines.slice(1).every((l) => l.live === undefined),
    "🔴 negative control (OPE-1039): a comment line is never marked LIVE — only the topic is the current state",
  );
  ok(lines.every((l) => l.readAt === topic.readAt), "…and every line on the page shares the SAME read moment");
  ok(
    !lines.some((l) => l.text === "reply to root 1" || l.text === "deep reply"),
    "a THREADED REPLY never appears in the channel view — that is the Slack shape this ruling names",
  );
}
{
  const comments: LinearCommentSummary[] = [
    { id: "a", text: "root", createdAt: "1" },
    { id: "b", parentId: "a", text: "reply", createdAt: "2" },
  ];
  eq(linearRootComments(comments).map((c) => c.id), ["a"], "linearRootComments keeps only the parentless comments");
  eq(linearRootComments([comments[1]!]).length, 0, "…and a page of pure replies has NO roots (negative control)");
}
eq(
  linearTopicLine({ title: "Bare", description: "", comments: [], truncated: false, createdAt: "t0", creatorId: "u9" }),
  { author: "u9", authorId: "u9", ts: "t0", text: "Bare" },
  "🔴 negative control (OPE-1038): an issue with no resolvable state renders no invented status",
);
eq(
  linearTopicLine({ title: "Ship it", description: "", stateName: "In Progress", comments: [], truncated: false, createdAt: "t0", creatorId: "u9" }),
  { author: "u9", authorId: "u9", ts: "t0", text: "Ship it [In Progress]" },
  "an issue's state joins the topic headline",
);
eq(
  linearTopicLine({
    title: "Ship it",
    description: "ships on green",
    stateName: "In Progress",
    comments: [],
    truncated: false,
    createdAt: "t0",
    creatorId: "u9",
  }),
  { author: "u9", authorId: "u9", ts: "t0", text: "Ship it [In Progress]\n\nships on green" },
  "…and the description still follows, on its own paragraph",
);

{
  const t = transport();
  const { lines } = await linearReadAdapter.readThread(linearTurn({ issue: OWN_ISSUE, comment: "c1" }), OWN_ISSUE, "c1", 100, deps(t));
  eq(
    lines.map((l) => l.text),
    ["first root", "reply to root 1", "deep reply"],
    "a thread read is its root, its reply, and the reply BELOW that reply (transitive)",
  );
  eq(lines[1]?.author, "bob", "…and each line is attributed to its own author");
  ok(
    lines.every((l) => typeof l.readAt === "string" && l.live === undefined),
    "🔴 OPE-1039: a thread read dates every line but marks NONE live — a thread has no topic line to be the current state",
  );
}
{
  const t = transport();
  const { lines } = await linearReadAdapter.readThread(linearTurn({ issue: OWN_ISSUE, comment: "c2" }), OWN_ISSUE, "c2", 100, deps(t));
  eq(lines.map((l) => l.text), ["second root"], "a SECOND root's thread reads separately — no other root's replies leak in");
}
{
  const comments: LinearCommentSummary[] = [
    { id: "r1", text: "root one", createdAt: "1" },
    { id: "r2", text: "root two", createdAt: "2" },
    { id: "x", parentId: "r2", text: "under two", createdAt: "3" },
  ];
  eq(linearThreadLines(comments, "r1").map((l) => l.text), ["root one"], "a root nothing replies to reads as itself alone");
  eq(linearThreadLines(comments, "nope"), [], "an unknown root reads as an EMPTY thread, never as the whole issue");
  eq(linearThreadLines(comments, "r2").map((l) => l.text), ["root two", "under two"], "…and the other root keeps its own reply");
}

{
  const t = transport();
  const own = linearTurn({ issue: OWN_ISSUE, comment: "c1" });
  ok((await linearReadAdapter.readChannel(own, OWN_ISSUE, 50, deps(t))).lines.length === 4, "control: the turn's OWN issue reads");
  const before = t.bodies.length;
  await throws(() => linearReadAdapter.readChannel(own, OTHER_ISSUE, 50, deps(t, { [OTHER_ISSUE]: "team-legal" })), "an issue in another domain's team is refused");
  await throws(
    () => linearReadAdapter.readThread(own, OTHER_ISSUE, "c1", 100, deps(t, { [OTHER_ISSUE]: "team-legal" })),
    "the thread read runs the SAME fence",
  );
  await throws(() => linearReadAdapter.readChannel(own, OTHER_ISSUE, 50, deps(t, {})), "an issue whose team will not resolve is refused, not admitted");
  eq(t.bodies.length, before, "no refused read reached the network — the fence runs BEFORE the fetch");
}

{
  const truncatedPayload = {
    ...ISSUE_PAYLOAD,
    comments: { nodes: [RAW_NODES_NEWEST_FIRST[4]], pageInfo: { hasNextPage: true } },
  };
  const t = transport(truncatedPayload);
  const out = await linearReadAdapter.readChannel(linearTurn({ issue: OWN_ISSUE, comment: "c1" }), OWN_ISSUE, 50, deps(t));
  eq(out.lines.length, 2, "one topic line plus the single root on this page — a genuinely SHORT page");
  eq(out.possiblyIncomplete, true, "🔴 the vendor's own hasNextPage is what declares this partial, not the (short) line count");
  ok(typeof out.partialReason === "string" && out.partialReason.length > 0, "…and the reason rides as data — the vendor page limit, named");

  const threadOut = await linearReadAdapter.readThread(linearTurn({ issue: OWN_ISSUE, comment: "c1" }), OWN_ISSUE, "c1", 100, deps(t));
  eq(threadOut.possiblyIncomplete, true, "read_thread: the same vendor-truncation fact, from the same fetched page");
}
{
  const t = transport();
  const out = await linearReadAdapter.readChannel(linearTurn({ issue: OWN_ISSUE, comment: "c1" }), OWN_ISSUE, 2, deps(t));
  eq(out.lines.length, 2, "topic plus ONE root — the caller asked for only 2 lines total");
  eq(out.possiblyIncomplete, true, "🔴 a caller-limit trim is ALSO a real partial view, even though Linear itself was not truncated");
  ok(!("partialReason" in out), "…and it carries NO reason: nothing vendor-side explains it, so core states no cause");
}

console.log(`✓ linear-read: ${passed} assertions passed`);
