import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";

const dir = join(tmpdir(), `open-everywhere-engaged-seam-wiring-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.GITHUB_APP_SLUG = "eve-bot";
process.env.LINEAR_API_KEY = "linear-test-key";

const { resolvePartition, getOperationalStore } = await import("@open-everywhere/core/agent/adapter-api.js");
const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
const { registerLinearProvider } = await import("@open-everywhere/provider-linear/agent/register.js");
const { registerNotionProvider } = await import("@open-everywhere/provider-notion/agent/register.js");
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();
const { githubOnComment } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { buildGitHubAuth } = await import("@open-everywhere/provider-github/agent/channels/github-identity.js");
const { linearOnAgentSession, _resetLinearGuestCache } = await import("@open-everywhere/provider-linear/agent/channels/linear.js");
const { handleNotionDelivery } = await import("@open-everywhere/provider-notion/agent/channels/notion-webhook.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { handleNotionSupervisorDispatch } = await import("@open-everywhere/provider-notion/agent/channels/notion-supervisor.js");
const { buildNotionAuth } = await import("@open-everywhere/provider-notion/agent/channels/notion-identity.js");
const { resolveExternalPolicy } = await import("@open-everywhere/core/agent/adapter-api.js");
const { registerAuthorTrust, _resetAuthorTrustForTest } = await import("@open-everywhere/core/agent/identity/author-trust.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const store = getOperationalStore();
const NOW = "2026-05-12T11:30:00.000Z";

{
  const OWNER = "wiring-org";
  const REPO = "wiring-repo";
  const part = resolvePartition({
    channel: { kind: "github" as const },
    session: {
      auth: {
        current: buildGitHubAuth({ owner: OWNER, repo: REPO, actorLogin: "dev", isPrivate: true }) as unknown as {
          attributes?: Readonly<Record<string, string>>;
        },
      },
    },
  } as never);
  const anchor = `${OWNER}/${REPO}#7`;

  const ctx = (): unknown => ({
    repository: { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, id: 1, private: true },
    conversation: { kind: "issue", issueNumber: 7, pullRequestNumber: null },
    github: { installationId: 123 },
    sender: { login: "dev", id: 7, type: "User" },
    thread: { kind: "issue", post: async () => ({ id: 1 }), react: async () => {} },
  });
  const plain = (id: number): unknown => ({
    id,
    body: "and what's that plus 6?",
    author: { login: "dev", id: 7, type: "User" },
    raw: { author_association: "MEMBER" },
  });
  const mention = (id: number): unknown => ({
    id,
    body: "@eve-bot what's 12*12?",
    author: { login: "dev", id: 7, type: "User" },
    raw: { author_association: "MEMBER" },
  });
  const drive = async (comment: unknown) => githubOnComment(ctx() as never, comment as never);

  ok((await drive(plain(101))) === null, "🔴 github: a plain comment on an UN-ENGAGED issue returns null — the gate is still shut where nobody invited the agent");

  const mentionRes = await drive(mention(102));
  ok(mentionRes !== null && (mentionRes as { auth?: unknown }).auth !== undefined, "github: an @mention dispatches, exactly as before the seam");
  const afterMention = await store.getEngagement(part.org, part.surfaceKey, anchor);
  ok(afterMention !== null, `🔴 github: …and the SAME call ENROLLED the issue — a row now sits at ${anchor}, which is what stand_down later marks`);
  ok(afterMention?.participating === true, "github: …as a participating row, which is the state that clears a previous stand-down");

  const engagedRes = await drive(plain(103));
  ok(
    engagedRes !== null && (engagedRes as { auth?: unknown }).auth !== undefined,
    "🔴 github: the SAME plain comment that returned null above now DISPATCHES — the native gate asks the seam, which is the whole wiring claim",
  );

  ok(await store.markStopped(part.org, part.surfaceKey, anchor), "github: precondition — the stop flag is set on the row");
  ok((await drive(plain(104))) === null, "🔴 github: a plain comment in a STOOD-DOWN issue returns null — the stop is read on every comment, not only at mark time");

  await drive(mention(105));
  const revived = await store.getEngagement(part.org, part.surfaceKey, anchor);
  ok(revived !== null && revived.stopped === false, "🔴 github: a fresh @mention CLEARS the stop — `participating: true` is the documented way back in");
  ok((await drive(plain(106))) !== null, "github: …and plain comments deliver again");

  ok(await store.markStopped(part.org, part.surfaceKey, anchor), "github: precondition — stopped again");
  await drive(mention(105));
  const afterReplay = await store.getEngagement(part.org, part.surfaceKey, anchor);
  ok(
    afterReplay !== null && afterReplay.stopped === true,
    "🔴 github: a REDELIVERED @mention leaves the stop in place — the once-guard keys on the comment id, so a replay cannot lift a stand-down nobody asked to lift",
  );
  await drive(mention(107));
  const afterNew = await store.getEngagement(part.org, part.surfaceKey, anchor);
  ok(afterNew !== null && afterNew.stopped === false, "🔴 github: NEGATIVE CONTROL — a NEW @mention still lifts it, so the guard is per comment and not a blanket refusal");

  const reachCtx = (over: Record<string, unknown>): unknown => ({ ...(ctx() as Record<string, unknown>), ...over });
  const driveOn = async (over: Record<string, unknown>, comment: unknown) => githubOnComment(reachCtx(over) as never, comment as never);

  ok(
    (await driveOn({ repository: { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, id: 1, private: false } }, plain(301))) === null,
    "🔴 github: a plain comment in the ENGAGED issue of a PUBLIC repo returns null — an uninvited native turn is private-repo only, the floor the ambient leg already holds",
  );
  ok(
    (await driveOn({ repository: { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, id: 1 } }, plain(302))) === null,
    "🔴 github: …and UNKNOWN privacy refuses too — the floor is `private === true`, so a delivery that does not say fails closed",
  );
  ok(
    (await driveOn({ repository: { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, id: 1, private: false } }, mention(303))) !== null,
    "🔴 github: NEGATIVE CONTROL — an @MENTION on the same PUBLIC repo still dispatches, so the floor narrows the follow-up arm and nothing else",
  );

  const reviewThread = { conversation: { kind: "review_thread", issueNumber: null, pullRequestNumber: 7 } };
  ok(
    (await driveOn(reviewThread, plain(304))) === null,
    "🔴 github: a plain INLINE REVIEW comment on the engaged container returns null — a review thread shares the pull request's anchor, so it is not a container of its own",
  );
  ok(
    (await driveOn(reviewThread, mention(305))) !== null,
    "🔴 github: NEGATIVE CONTROL — an @MENTION inside the SAME review thread still dispatches, so the floor never narrows an address",
  );
  ok(
    (await drive(plain(306))) !== null,
    "🔴 github: NEGATIVE CONTROL — the unchanged private-repo issue comment still dispatches, so neither floor closed the arm itself",
  );

  const posted: string[] = [];
  const ackCtx = (): unknown => ({ ...(ctx() as Record<string, unknown>), thread: { kind: "issue", post: async (t: string) => { posted.push(t); return { id: 1 }; }, react: async () => {} } });
  const outsider = (id: number, body: string): unknown => ({ id, body, author: { login: "outsider", id: 9, type: "User" }, raw: { author_association: "CONTRIBUTOR" } });
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => [{ name: "org", match: "org", externalPolicy: { authorGrain: "withhold" } }],
    loadSilos: () => [], domainsForSurface: () => [],
  } as never);

  posted.length = 0;
  ok((await githubOnComment(ackCtx() as never, outsider(201, "@eve-bot help?") as never)) === null, "github: an excluded author's @mention is dropped");
  ok(posted.length === 1, "github: …and IS owed the one fixed ack line, because they addressed the app (OPE-885, unchanged)");

  posted.length = 0;
  ok((await githubOnComment(ackCtx() as never, outsider(202, "and what's that plus 6?") as never)) === null, "github: an excluded author's plain follow-up in the ENGAGED issue is dropped too");
  ok(
    posted.length === 0,
    "🔴 github: …and posts NOTHING — an unaddressed comment is owed nothing, so the seam's new reach past the mention gate cannot turn the ack into a public classification notice",
  );

  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [],
  } as never);
}

{
  const ORG = "wiring-linear-org";
  const TEAM = "wiring-team";
  const ISSUE = "wiring-issue-1";
  const part = resolvePartition({
    channel: { kind: "linear" as const },
    session: { auth: { current: { attributes: { organization_id: ORG, team_id: TEAM }, principalId: "creator-1", principalType: "linear-user" } } },
  } as never);

  const resp = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  const fakeLinear = (async (url: unknown, init: { body?: unknown }) => {
    const u = String(url);
    const body = String(init?.body ?? "");
    if (!u.includes("api.linear.app")) return resp(500, { error: "unexpected host" });
    if (body.includes("OeUserGuest")) return resp(200, { data: { user: { guest: false } } });
    if (body.includes("OeIssueTeam")) return resp(200, { data: { issue: { team: { id: TEAM, private: true } } } });
    return resp(200, { data: { agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } } });
  }) as typeof fetch;

  await withPatchedFetch(fakeLinear, async () => {
    const event = (sessionId: string): unknown => ({
      action: "created",
      kind: "agent_session",
      organizationId: ORG,
      previousComments: [],
      delivery: { id: `d-${sessionId}` },
      agentSession: { id: sessionId, creator: { id: "creator-1" }, issueId: ISSUE, issue: { id: ISSUE, identifier: "WIR-1" } },
      raw: { agentSession: { issue: { team: { id: TEAM } } } },
    });

    ok((await store.getEngagement(part.org, part.surfaceKey, ISSUE)) === null, "linear: precondition — the issue holds no engagement row");

    _resetLinearGuestCache();
    const res = await linearOnAgentSession({} as never, event("sess-1") as never);
    ok(res !== null && (res as { auth?: unknown }).auth !== undefined, "linear: the Agent Session dispatches, exactly as before the seam");
    const row = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(
      row !== null,
      "🔴 linear: …and the SAME call ENROLLED the ISSUE — the mention leg writes the row the plain-comment leg reads, which is the join Linear's one-shot session makes necessary",
    );
    ok(row?.participating === true, "linear: …as a participating row, so a later address clears a stand-down");

    ok((await store.getEngagement(part.org, part.surfaceKey, "wiring-issue-2")) === null, "🔴 linear: NEGATIVE CONTROL — a different issue in the same team holds no row");

    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — the issue is stood down");
    _resetLinearGuestCache();
    await linearOnAgentSession({} as never, { ...(event("sess-2") as Record<string, unknown>), action: "prompted" } as never);
    const afterPrompt = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(
      afterPrompt !== null && afterPrompt.stopped === true,
      "🔴 linear: a `prompted` follow-up leaves the STOP in place — a reply in the agent's own thread is not a fresh invitation, so it cannot lift a stand-down",
    );

    _resetLinearGuestCache();
    await linearOnAgentSession({} as never, event("sess-3") as never);
    const afterCreated = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(afterCreated !== null && afterCreated.stopped === false, "🔴 linear: NEGATIVE CONTROL — a fresh `created` session CLEARS the stop, which is the documented way back in");
    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — stopped again");
    _resetLinearGuestCache();
    await linearOnAgentSession({} as never, event("sess-3") as never);
    const afterReplay = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(
      afterReplay !== null && afterReplay.stopped === true,
      "🔴 linear: a REDELIVERED `created` leaves the stop in place — the once-guard keys on the Agent Session id, so a replayed delivery cannot lift a stand-down nobody asked to lift",
    );

    _resetLinearGuestCache();
    await linearOnAgentSession({} as never, event("sess-4") as never);
    const afterFresh = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(afterFresh !== null && afterFresh.stopped === false, "🔴 linear: NEGATIVE CONTROL — a NEW Agent Session still lifts it, so the guard is per delivery and not a blanket refusal");
  });
}

{
  const WS = "wiring-ws";
  const PAGE = "wiring-page";
  const DISCUSSION = "wiring-disc";
  const BOT = "wiring-bot";
  const AUTHOR = "wiring-author";
  const SECRET = "wiring-secret";
  const ANCHOR = `${WS}/${PAGE}`;

  const sign = (body: string): string => "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  const event = (): string =>
    JSON.stringify({
      type: "comment.created",
      workspace_id: WS,
      entity: { id: "cmt-1", type: "comment" },
      data: { page_id: PAGE, parent: { id: PAGE, type: "page" } },
      authors: [{ id: AUTHOR, type: "person" }],
    });
  const comment = (text: string): unknown => ({
    id: "cmt-1",
    discussion_id: DISCUSSION,
    parent: { type: "page_id", page_id: PAGE },
    created_by: { id: AUTHOR, object: "user", type: "person" },
    rich_text: [{ type: "text", plain_text: text, text: { content: text } }],
  });
  const makeFetch = (text: string) =>
    (async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && /\/v1\/comments\/[^?]+$/.test(input)) return new Response(JSON.stringify(comment(text)), { status: 200 });
      if (method === "GET" && input.includes("/v1/comments?block_id=")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    }) as unknown as Parameters<typeof handleNotionDelivery>[2]["fetch"];

  type Row = Awaited<ReturnType<typeof store.getEngagement>>;
  let ingressMarks = 0;
  const engagement = (row: Row) => ({
    getEngagement: async () => row,
    markEngaged: async () => {
      ingressMarks++;
      throw new Error("the Notion INGRESS must never mark — the write belongs below the external-author decision");
    },
    now: () => NOW,
  });
  const engagedRow = (stopped: boolean): Row =>
    ({
      org: "oe",
      surfaceKey: `notion/${WS}/${PAGE}`,
      threadTs: ANCHOR,
      engagedAt: NOW,
      lastTurnAt: NOW,
      participating: true,
      silentStreak: 0,
      stopped,
      kind: "thread" as const,
    }) as Row;

  const deliver = async (opts: { text: string; ambient: boolean; row: Row; declared?: boolean; claimed?: boolean }) => {
    ingressMarks = 0;
    let dispatched = false;
    let sent: { readonly addressing?: string; readonly engagedFollowUp?: boolean; readonly domainVia?: string } | undefined;
    const raw = event();
    const out = await handleNotionDelivery(raw, sign(raw), {
      signingKeys: [{ credentialId: "channel-key", secret: SECRET }],
      allowUnverified: false,
      credentialFor: async () => ({ apiKey: "ntn_key" }),
      credentialForPage: () => undefined,
      domains:
        opts.declared === false
          ? []
          : opts.claimed === true
            ? [{ name: "e2e-engaged", containers: [`notion/${WS}`] }]
            : [{ name: "e2e-engaged", channels: [`notion/${WS}/${PAGE}`] }],
      resolveBotUserId: async () => BOT,
      resolveBotName: async () => "Aria",
      ambientEnabled: () => opts.ambient,
      fetch: makeFetch(opts.text),
      dispatch: async (d: { readonly addressing?: string; readonly engagedFollowUp?: boolean; readonly domainVia?: string }) => {
        dispatched = true;
        sent = d;
      },
      attachSession: () => ({ cancel: async () => ({ status: "accepted" as const }) }),
      engagement: engagement(opts.row),
    } as unknown as Parameters<typeof handleNotionDelivery>[2]);
    return { out, dispatched, sent };
  };

  {
    const { out, dispatched } = await deliver({ text: "can you summarise this page?", ambient: false, row: null });
    ok(out.action === "ambient-disabled", "🔴 notion: NEGATIVE CONTROL — ambient off, page not engaged, plain comment ⇒ `ambient-disabled`, exactly as before");
    ok(!dispatched, "notion: …and nothing dispatched");
  }

  {
    const { out, dispatched, sent } = await deliver({ text: "hey Aria, what's 12*12?", ambient: false, row: null });
    ok(out.action === "dispatched" && dispatched, "🔴 notion: a NAME-DROP dispatches with ambient OFF — an addressed-only page can now be addressed at all");
    ok(out.detail === "direct", "notion: …classified `direct`, so the addressed stamp the link-claim hook reads is set");
    ok(ingressMarks === 0, "🔴 notion: …and the INGRESS marked NOTHING — zero calls to the injected writer, because the mark belongs below the external-author decision the dispatch core makes");
    ok(
      sent?.engagedFollowUp === undefined,
      "🔴 notion: …and the dispatch carries NO `engagedFollowUp` — an ADDRESSED comment never asks the seam, so the row must report `direct` and not a follow-up",
    );
    ok(
      sent?.domainVia === "roster",
      "🔴 notion: …and the dispatch carries `domainVia: roster` — the door read the operator's own list, and the row must say so rather than leave the origin unrecorded",
    );
  }

  {
    const { out, dispatched, sent } = await deliver({ text: "hey Aria, what's 12*12?", ambient: false, row: null, claimed: true });
    ok(out.action === "dispatched" && dispatched, "notion: a NAME-DROP on a page a WORKSPACE CLAIM reaches dispatches too — a claim declares the page as much as a roster entry does");
    ok(
      sent?.domainVia === "container",
      "🔴 notion: …and the dispatch carries `domainVia: container`, NOT `roster` — a claim reaches pages nobody enumerated, and it must not read like a page the operator listed",
    );
  }

  {
    const { out, dispatched, sent } = await deliver({ text: "and what's that plus 6?", ambient: false, row: engagedRow(false) });
    ok(out.action === "dispatched" && dispatched, "🔴 notion: a plain comment on an ENGAGED page dispatches with ambient OFF — the §2.5 posture, with no domain opt-in");
    ok(sent?.addressing === "channel-watch", "notion: …still classified `channel-watch`, because the supervisor judges an engaged follow-up rather than answering it as an address");
    ok(
      sent?.engagedFollowUp === true,
      "🔴 notion: …and the dispatch carries `engagedFollowUp` — the seam verdict the route turns into the row's `thread-follow`, which is the ONLY thing separating this wake from ambient chatter in the audit trail",
    );
  }

  {
    const { out, dispatched } = await deliver({ text: "and what's 5 plus 5?", ambient: true, row: engagedRow(true) });
    ok(out.action === "stood-down", "🔴 notion: a plain comment on a STOOD-DOWN page is suppressed even with ambient ON — the leg that would otherwise answer honours the stop");
    ok(out.detail === ANCHOR, "notion: …and the outcome names the anchor it was suppressed at");
    ok(!dispatched, "notion: …with no dispatch at all");
  }

  {
    const { out, dispatched } = await deliver({ text: "Aria, one more thing", ambient: true, row: engagedRow(true) });
    ok(out.action === "dispatched" && dispatched, "🔴 notion: NEGATIVE CONTROL — naming the agent on a stood-down page DISPATCHES rather than being suppressed, which is what lets the mark below lift the flag");
  }

  {
    const { out, dispatched, sent } = await deliver({ text: "can you summarise this page?", ambient: true, row: null });
    ok(out.action === "dispatched" && dispatched, "🔴 notion: NEGATIVE CONTROL — an ordinary comment on an ambient-ENABLED page still dispatches, so the seam narrowed nothing");
    ok(
      sent?.engagedFollowUp === undefined,
      "🔴 notion: NEGATIVE CONTROL — ambient chatter on an UN-ENGAGED page carries no `engagedFollowUp`, so the row stays `channel-watch` and the two wakes remain distinguishable",
    );
  }

  {
    const { out, dispatched, sent } = await deliver({ text: "can you summarise this page?", ambient: true, row: null, declared: false });
    ok(out.action === "dispatched" && dispatched, "notion: precondition — an ambient-ENABLED page in no declared domain still dispatches");
    ok(
      sent?.domainVia === "none",
      "🔴 notion: NEGATIVE CONTROL — and the dispatch carries `domainVia: none`, so the field reports the domain read and is not a constant the other two cases could pass on",
    );
  }

  {
    const { out, dispatched } = await deliver({ text: "hey Aria, what's 12*12?", ambient: false, row: null, declared: false });
    ok(out.action === "ambient-disabled", "🔴 notion: a NAME-DROP on a page in NO declared domain is still `ambient-disabled` — the addressed door's floor is the operator's own config");
    ok(!dispatched, "notion: …and nothing dispatched");
  }
}

{
  const WS = "mark-ws";
  const PAGE = "mark-page";
  const AUTHOR = "outside-author";

  const wakeMessage = (id: string) => ({ from: "human" as const, id, authorId: AUTHOR, sentAt: NOW, text: "hey Aria", trust: "unauth" as const });
  const dispatchInput = (addressing: "direct" | "channel-watch") => ({
    surfaceKey: `notion/${WS}/${PAGE}`,
    credentialId: "cred-1",
    addressing,
    pageId: PAGE,
    discussionId: "mark-disc",
    workspaceId: WS,
    auth: buildNotionAuth({ workspaceId: WS, pageId: PAGE, principalId: AUTHOR }),
    trigger: wakeMessage("cmt-1"),
    threadComments: [],
  });

  registerAuthorTrust([{ tenant: `notion/${WS}`, internal: ["notion/someone-else"] }]);

  const drive = async (addressing: "direct" | "channel-watch", policy: { authorGrain?: string } | undefined) => {
    const marked: string[] = [];
    let sessionOpened = false;
    await handleNotionSupervisorDispatch(
      { ...dispatchInput(addressing), ...(policy ? { externalPolicy: resolveExternalPolicy(policy as never) } : {}) } as never,
      {
        getOrCreateSession: async () => {
          sessionOpened = true;
          return { token: "notion:mark-page:oe-sup:g1", generation: 1, freshGeneration: false, tail: [] };
        },
        wake: async () => {},
        markEngaged: async (d: { pageId: string }) => {
          marked.push(d.pageId);
        },
      } as never,
    );
    return { marked, sessionOpened };
  };

  {
    const { marked, sessionOpened } = await drive("direct", undefined);
    ok(sessionOpened, "notion mark: precondition — an admitted addressed wake opens its session");
    ok(marked.length === 1 && marked[0] === PAGE, "🔴 notion mark: an ADDRESSED wake ENROLS the page, below the external-author gate");
  }

  {
    const { marked, sessionOpened } = await drive("direct", { authorGrain: "withhold" });
    ok(!sessionOpened, "notion mark: precondition — an excluded author's addressed wake is suppressed before the session opens");
    ok(
      marked.length === 0,
      "🔴 notion mark: a SUPPRESSED author enrols NOTHING — otherwise an author who may not task the agent could engage a page nobody opted in, and could clear a stand-down by naming the agent",
    );
  }

  {
    const { marked, sessionOpened } = await drive("channel-watch", undefined);
    ok(sessionOpened, "notion mark: precondition — a channel-watch wake still opens its session");
    ok(marked.length === 0, "🔴 notion mark: an AMBIENT wake enrols nothing — being read is not being invited");
  }

  {
    const { marked, sessionOpened } = await drive("direct", { authorGrain: "taint" });
    ok(sessionOpened && marked.length === 1, "🔴 notion mark: NEGATIVE CONTROL — under the shipped `taint` grain the same author is admitted and DOES enrol, so control 1 measured the policy and not the fixture");
  }

  const part = resolvePartition({
    channel: { kind: "notion" as const },
    session: { auth: { current: buildNotionAuth({ workspaceId: WS, pageId: PAGE, principalId: AUTHOR }) as unknown as { attributes?: Readonly<Record<string, string>> } } },
  } as never);
  const ANCHOR = `${WS}/${PAGE}`;
  const driveLive = async (commentId: string) => {
    await handleNotionSupervisorDispatch({ ...dispatchInput("direct"), trigger: wakeMessage(commentId) } as never, {
      getOrCreateSession: async () => ({ token: "notion:mark-page:oe-sup:g1", generation: 1, freshGeneration: false, tail: [] }),
      wake: async () => {},
    } as never);
  };

  await driveLive("cmt-live-1");
  const live = await store.getEngagement(part.org, part.surfaceKey, ANCHOR);
  ok(live !== null && live.participating === true, "notion mark: precondition — the LIVE writer enrolled the page, so the guard below is measured on a real row");

  ok(await store.markStopped(part.org, part.surfaceKey, ANCHOR), "notion mark: precondition — the page is stood down");
  await driveLive("cmt-live-1");
  const afterReplay = await store.getEngagement(part.org, part.surfaceKey, ANCHOR);
  ok(
    afterReplay !== null && afterReplay.stopped === true,
    "🔴 notion mark: a REDELIVERED name-drop leaves the stop in place — the once-guard keys on the comment id, so a retry cannot lift a stand-down nobody asked to lift",
  );

  await driveLive("cmt-live-2");
  const afterNew = await store.getEngagement(part.org, part.surfaceKey, ANCHOR);
  ok(afterNew !== null && afterNew.stopped === false, "🔴 notion mark: NEGATIVE CONTROL — a NEW name-drop still lifts it, so the guard is per comment and not a blanket refusal");

  _resetAuthorTrustForTest();
}

console.log(`✓ engaged-seam-wiring: ${n} assertions passed (the real githubOnComment / linearOnAgentSession / handleNotionDelivery ingresses ask the seam — mark, deliver, stop, and the way back in, each with a negative control)`);
