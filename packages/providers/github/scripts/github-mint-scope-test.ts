import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  registerConfig,
  CONVERSATION_WRITE_PERMISSIONS,
  entityActionFn,
  overrideSettingsForTest,
  type BindableContext,
  type PrFetchFn,
  type RepoCapability,
  type UnifiedWakeOrigin,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerGithubProvider } from "../agent/register.js";
import { githubReadAdapter } from "../agent/channels/github-read.js";
import { githubPostArm, _resetGitHubInstallationTokenCache } from "../agent/channels/github-post-arm.js";
import { buildGitHubAuth } from "../agent/channels/github-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

type Family = "issues" | "pull_requests" | "contents" | "metadata";
type Level = "read" | "write";
type Permissions = Partial<Record<Family, Level>>;
const RANK: Record<Level, number> = { read: 1, write: 2 };

interface EndpointRow {
  readonly method: string;
  readonly match: RegExp;
  readonly needs: readonly (readonly [Family, Level])[];
  readonly why: string;
}

const ENDPOINTS: readonly EndpointRow[] = [
  {
    method: "GET",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/u,
    needs: [
      ["issues", "read"],
      ["pull_requests", "read"],
    ],
    why: "the conversation opener — `/issues/{n}` serves an issue AND a pull request",
  },
  {
    method: "GET",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/u,
    needs: [
      ["issues", "read"],
      ["pull_requests", "read"],
    ],
    why: "the timeline comments of an issue OR a pull request",
  },
  {
    method: "GET",
    match: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/u,
    needs: [["pull_requests", "read"]],
    why: "review comments exist only on a pull request",
  },
  {
    method: "POST",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/u,
    needs: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
    why: "OPE-1020 — a comment on an issue OR a pull request, through one endpoint",
  },
  {
    method: "PATCH",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/u,
    needs: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
    why: "edit_reply rewrites a comment on either conversation kind",
  },
  {
    method: "POST",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/reactions$/u,
    needs: [["issues", "write"]],
    why: "GitHub lists the issue-reaction endpoint under Issues only",
  },
  {
    method: "PATCH",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/u,
    needs: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
    why: "OPE-1021 — set_state closes/reopens an issue OR a pull request through one endpoint",
  },
  {
    method: "POST",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/assignees$/u,
    needs: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
    why: "OPE-1021 — assign adds an assignee to an issue OR a pull request through one endpoint",
  },
  {
    method: "POST",
    match: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/u,
    needs: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
    why: "OPE-1021 — add_label labels an issue OR a pull request through one endpoint; a live run measured 403 on a PR",
  },
];

const MINT_URL = /^\/app\/installations\/[^/]+\/access_tokens$/u;

function pathOf(url: string): string {
  return url.replace(/^https:\/\/api\.github\.com/u, "").replace(/\?.*$/u, "");
}

function shortfall(perms: Permissions, row: EndpointRow): string[] {
  return row.needs
    .filter(([family, level]) => {
      const held = perms[family];
      return held === undefined || RANK[held] < RANK[level];
    })
    .map(([family, level]) => `${family}:${level}`);
}

function assertCovered(perms: Permissions, calls: readonly { method: string; url: string }[], label: string): void {
  ok(calls.length > 0, `${label}: the path actually called GitHub (a silent path proves nothing)`);
  for (const call of calls) {
    const path = pathOf(call.url);
    const row = ENDPOINTS.find((r) => r.method === call.method && r.match.test(path));
    ok(row !== undefined, `${label}: ${call.method} ${path} is named in the endpoint table`);
    if (!row) continue;
    const missing = shortfall(perms, row);
    ok(missing.length === 0, `${label}: the minted token covers ${call.method} ${path} (${row.why})${missing.length ? ` — MISSING ${missing.join(", ")}` : ""}`);
  }
}

{
  const readRow = ENDPOINTS[0]!;
  const postRow = ENDPOINTS[3]!;
  ok(shortfall({ issues: "read", pull_requests: "read", metadata: "read" }, readRow).length === 0, "checker: the conversation-READ set covers the conversation opener");
  ok(shortfall({ contents: "read", pull_requests: "read", metadata: "read" }, readRow).join() === "issues:read", "🔴 checker: the PR-READ set is REFUSED on the conversation opener — the exact OPE-1019 shortfall");
  ok(shortfall({ issues: "write" }, postRow).join() === "pull_requests:write", "🔴 checker: the pre-fix `{issues:write}` body is REFUSED on the comment POST — the exact OPE-1020 shortfall");
  ok(shortfall({ issues: "read", pull_requests: "read" }, postRow).join() === "issues:write,pull_requests:write", "checker: a READ level never satisfies a WRITE need");
  ok(shortfall(CONVERSATION_WRITE_PERMISSIONS as Permissions, postRow).length === 0, "checker: the conversation-WRITE set covers the comment POST");
  ok(!ENDPOINTS.some((r) => r.method === "DELETE" && r.match.test("/repos/acme/api/issues/7")), "checker: an unnamed method matches no row");
  const addLabelRow = ENDPOINTS.find((r) => r.method === "POST" && r.match.source.endsWith("\\/labels$"))!;
  ok(
    shortfall({ issues: "write", metadata: "read" }, addLabelRow).join() === "pull_requests:write",
    "🔴 checker: the pre-fix `{issues:write}` body is REFUSED on add_label's endpoint — the exact a live run shortfall",
  );
  ok(
    shortfall({ issues: "write", pull_requests: "write", metadata: "read" }, addLabelRow).length === 0,
    "checker: the pr-admin-expanded body covers add_label's endpoint",
  );
}

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
overrideSettingsForTest({ github: { appId: "12345", appSlug: "open-everywhere-test", installations: { acme: "777" } } });
process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
delete process.env.GITHUB_TOKEN;

registerGithubProvider();
registerConfig({
  loadDomains: () => [{ name: "d", reach: ["github/acme/api"] }],
} as unknown as Parameters<typeof registerConfig>[0]);

function githubTurn(opts: { issue?: number; pr?: number; kind?: string; review?: number }): BindableContext {
  const auth = buildGitHubAuth({
    owner: "acme",
    repo: "api",
    isPrivate: true,
    conversationKind: opts.kind ?? (opts.pr ? "pull_request" : "issue"),
    ...(opts.issue !== undefined ? { issueNumber: opts.issue } : {}),
    ...(opts.pr !== undefined ? { pullRequestNumber: opts.pr } : {}),
    ...(opts.review !== undefined ? { reviewThreadRootCommentId: opts.review } : {}),
    actorLogin: "alice",
    authorAssociation: "MEMBER",
  });
  return { channel: { kind: "github" }, session: { auth: { current: auth } } } as unknown as BindableContext;
}

interface Recorder {
  readonly calls: { method: string; url: string }[];
  readonly mints: Permissions[];
}

function recordGlobalFetch(): { rec: Recorder; restore: () => void } {
  const saved = globalThis.fetch;
  const rec: Recorder = { calls: [], mints: [] };
  globalThis.fetch = (async (url: string, init: { method?: string; body?: string }) => {
    const path = pathOf(String(url));
    if (MINT_URL.test(path)) {
      rec.mints.push((JSON.parse(init.body ?? "{}") as { permissions?: Permissions }).permissions ?? {});
      return new Response(
        JSON.stringify({ token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: [{ full_name: "acme/api" }] }),
        { status: 201 },
      );
    }
    rec.calls.push({ method: init.method ?? "GET", url: String(url) });
    return new Response(JSON.stringify({ id: 9001 }), { status: 201 });
  }) as unknown as typeof fetch;
  return { rec, restore: () => { globalThis.fetch = saved; } };
}

function readTransport(routes: readonly (readonly [string, unknown])[]): { fn: PrFetchFn; calls: { method: string; url: string }[] } {
  const calls: { method: string; url: string }[] = [];
  const fn: PrFetchFn = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url });
    const hit = routes.find(([fragment]) => url.includes(fragment));
    const body = hit ? hit[1] : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { fn, calls };
}

const ISSUE_7 = { title: "Broken", body: "it fails", user: { login: "alice", type: "User" }, created_at: "t0", comments: 2 };
const TIMELINE_7 = [{ id: 11, body: "looking", user: { login: "bob", type: "User" }, created_at: "t1" }];
const REVIEW_12 = [{ id: 555, body: "this line", user: { login: "bob", type: "User" }, created_at: "t1" }];

{
  const { rec, restore } = recordGlobalFetch();
  try {
    const channel = readTransport([
      ["/issues/7/comments", TIMELINE_7],
      ["/issues/7", ISSUE_7],
    ]);
    await githubReadAdapter.readChannel(githubTurn({ issue: 7 }), "acme/api#7", 50, channel.fn);
    ok(rec.mints.length > 0, "read_channel MINTED a token through the App (not a PAT, not nothing)");
    assertCovered(rec.mints[0]!, channel.calls, "read_channel");

    const thread = readTransport([["/pulls/12/comments", REVIEW_12]]);
    rec.mints.length = 0;
    await githubReadAdapter.readThread(githubTurn({ pr: 12, kind: "review_thread", review: 555 }), "acme/api#12", "555", 100, thread.fn);
    ok(rec.mints.length > 0, "read_thread MINTED a token through the App");
    assertCovered(rec.mints[0]!, thread.calls, "read_thread");

    assert.deepStrictEqual(
      rec.mints[0],
      { issues: "read", pull_requests: "read", metadata: "read" },
      "the conversation-read mint body is exactly {issues, pull_requests, metadata} — no contents, nothing at write level",
    );
    passed++;
  } finally {
    restore();
  }
}

{
  _resetGitHubInstallationTokenCache();
  const { rec, restore } = recordGlobalFetch();
  try {
    const origin: UnifiedWakeOrigin = { platform: "github", owner: "acme", repo: "api", issueNumber: 40, installationId: 777 };
    await githubPostArm.dispatchUnified!(origin, "a reply on a pull request", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    await githubPostArm.editMessage!({ platform: "github", channelId: "acme/api" } as Parameters<NonNullable<typeof githubPostArm.editMessage>>[0], "9001", "an edited reply");
    await githubPostArm.react!({ platform: "github", owner: "acme", repo: "api", issueNumber: 40, installationId: 777 } as Parameters<NonNullable<typeof githubPostArm.react>>[0], "eyes");

    ok(rec.mints.length === 1, "the post arm mints ONCE for the three calls (one warm token per installation+repo)");
    ok(rec.calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/40/comments")), "…and the reply POST is one of the recorded calls");
    ok(rec.calls.some((c) => c.method === "PATCH"), "…and the edit PATCH is another");
    ok(rec.calls.some((c) => c.url.endsWith("/reactions")), "…and the reaction POST is the third");
    assertCovered(rec.mints[0]!, rec.calls, "post arm");

    assert.deepStrictEqual(
      rec.mints[0],
      { issues: "write", pull_requests: "write", metadata: "read" },
      "🔴 the post arm's mint body carries BOTH write families — without pull_requests the agent is mute on every PR thread (OPE-1020)",
    );
    passed++;
    ok((rec.mints[0] as Permissions).contents === undefined, "…and NO contents: the reply arm still cannot push code");
  } finally {
    restore();
    _resetGitHubInstallationTokenCache();
  }
}

const SET_STATE = entityActionFn("github", "setState")!;
const ASSIGN = entityActionFn("github", "assign")!;
const ADD_LABEL = entityActionFn("github", "addLabel")!;
{
  async function driveTicketActions(
    capabilities: readonly RepoCapability[],
  ): Promise<{ mints: Permissions[]; perVerb: { label: string; call: { method: string; url: string } }[] }> {
    _resetGitHubInstallationTokenCache();
    const { rec, restore } = recordGlobalFetch();
    try {
      await SET_STATE("acme/api#47", "closed", undefined, capabilities);
      await ASSIGN("acme/api#47", "bob", undefined, capabilities);
      await ADD_LABEL("acme/api#47", "documentation", undefined, capabilities);
      ok(rec.calls.length === 3, "the three verbs made exactly one REST call each");
      return {
        mints: rec.mints,
        perVerb: [
          { label: "set_state", call: rec.calls[0]! },
          { label: "assign", call: rec.calls[1]! },
          { label: "add_label", call: rec.calls[2]! },
        ],
      };
    } finally {
      restore();
      _resetGitHubInstallationTokenCache();
    }
  }

  {
    const { mints, perVerb } = await driveTicketActions([]);
    ok(mints.length === 3, "each ticket-action verb minted its own token (no capability passed to share a warm one)");
    for (const mint of mints) {
      assert.deepStrictEqual(
        mint,
        { issues: "write", metadata: "read" },
        "🔴 with no capability, the mint body is exactly ISSUE_WRITE_PERMISSIONS — unchanged from before OPE-1024",
      );
    }
    for (const { label, call } of perVerb) {
      const path = pathOf(call.url);
      const row = ENDPOINTS.find((r) => r.method === call.method && r.match.test(path));
      ok(row !== undefined, `default ${label}: ${call.method} ${path} is named in the endpoint table`);
      if (!row) continue;
      ok(
        shortfall({ issues: "write", metadata: "read" }, row).join() === "pull_requests:write",
        `🔴 default ${label}: ${call.method} ${path} is REFUSED for lack of pull_requests:write — the exact a live run 403 (OPE-1021)`,
      );
    }
    passed++;
  }

  {
    const { mints, perVerb } = await driveTicketActions(["pr-admin"]);
    ok(mints.length === 3, "each ticket-action verb minted its own token (pr-admin case)");
    for (const mint of mints) {
      assert.deepStrictEqual(
        mint,
        { issues: "write", pull_requests: "write", metadata: "read" },
        "the pr-admin-expanded mint body carries BOTH write families — this is what OPE-1024 dissolves OPE-1021's 403 into",
      );
      ok(mint.contents === undefined, "…and NO contents: pr-admin still cannot push code");
    }
    for (const [i, { label, call }] of perVerb.entries()) {
      assertCovered(mints[i]!, [call], `pr-admin: ${label}`);
    }
    passed++;
  }
}

console.log(`✅ github-mint-scope-test: ${passed} assertions passed`);
