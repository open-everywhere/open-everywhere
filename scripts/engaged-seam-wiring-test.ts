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
const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
overrideSettingsForTest({ github: { appSlug: "eve-bot", conversation: true } });
process.env.LINEAR_API_KEY = "linear-test-key";

const { resolvePartition, getOperationalStore, defineDomain, ambientSkipFor, OE_ADDRESSED_ATTR } = await import("@open-everywhere/core/agent/adapter-api.js");
const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
const { registerLinearProvider } = await import("@open-everywhere/provider-linear/agent/register.js");
const { registerNotionProvider } = await import("@open-everywhere/provider-notion/agent/register.js");
const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
registerDiscordProvider();
registerGithubProvider();
registerLinearProvider();
registerNotionProvider();
const { githubOnComment, githubAmbientLegAdmission } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { buildGitHubAuth } = await import("@open-everywhere/provider-github/agent/channels/github-identity.js");
const { linearOnAgentSession, _resetLinearGuestCache, _resetLinearViewerCache } = await import("@open-everywhere/provider-linear/agent/channels/linear.js");
const { handleNotionDelivery } = await import("@open-everywhere/provider-notion/agent/channels/notion-webhook.js");
const { dispatchTurn, authForRelayMessage, engagementCoordsFor } = await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js");
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

  const authAttrs = (r: unknown): Record<string, string> => (r as { auth: { attributes: Record<string, string> } }).auth.attributes;
  ok(authAttrs(mentionRes)[OE_ADDRESSED_ATTR] === "1", "🔴 github: an @mention wake carries oe_addressed='1' — this is what lets `@bot link <code>` claim after eve strips the mention token");
  ok(authAttrs(engagedRes)[OE_ADDRESSED_ATTR] === undefined, "🔴 github: an ENGAGED FOLLOW-UP carries NO stamp — it is not addressed, so a bare `link <code>` there is refused (the negative control)");

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

  const APP_NAME = "OeApp";
  const APP_USER_ID = "app-user-1";
  const RE_MENTION_COMMENT = "c-rementioned";
  const RE_MENTION_COMMENT_2 = "c-rementioned-2";
  const PLAIN_PROMPT_COMMENT = "c-plain-prompt";
  const SELF_MENTION_COMMENT = "c-self-mention";
  const AUTHORLESS_MENTION_COMMENT = "c-authorless-mention";
  const GUEST_MENTION_COMMENT = "c-guest-mention";
  const MENTION_BODY = `@${APP_NAME} which build token was posted while you were not listening?`;
  const MEMBER = { id: "member-1", name: "Member", guest: false };
  const PROMPT_COMMENTS: readonly { id: string; body: string; user?: { id: string; name?: string; guest?: boolean } }[] = [
    { id: RE_MENTION_COMMENT, body: MENTION_BODY, user: MEMBER },
    { id: RE_MENTION_COMMENT_2, body: MENTION_BODY, user: MEMBER },
    { id: PLAIN_PROMPT_COMMENT, body: "and what's that plus 6?", user: MEMBER },
    { id: SELF_MENTION_COMMENT, body: MENTION_BODY, user: { id: APP_USER_ID, name: APP_NAME } },
    { id: AUTHORLESS_MENTION_COMMENT, body: MENTION_BODY },
    { id: GUEST_MENTION_COMMENT, body: MENTION_BODY, user: { id: "guest-1", name: "Guest", guest: true } },
  ];

  const resp = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  const activities: string[] = [];
  let refuseNextActivity = false;
  const fakeLinear = (async (url: unknown, init: { body?: unknown }) => {
    const u = String(url);
    const body = String(init?.body ?? "");
    if (!u.includes("api.linear.app")) return resp(500, { error: "unexpected host" });
    if (body.includes("OeUserGuest")) return resp(200, { data: { user: { guest: false } } });
    if (body.includes("OeIssueTeam")) return resp(200, { data: { issue: { team: { id: TEAM, private: true } } } });
    if (body.includes("OeViewer")) return resp(200, { data: { viewer: { id: APP_USER_ID, name: APP_NAME, displayName: APP_NAME } } });
    if (body.includes("OeAmbientComment")) {
      const id = PROMPT_COMMENTS.find((c) => body.includes(c.id)) ?? PROMPT_COMMENTS[0]!;
      return resp(200, {
        data: {
          comment: {
            id: id.id,
            body: id.body,
            ...(id.user === undefined ? {} : { user: id.user }),
            issue: { id: ISSUE, identifier: "WIR-1", team: { id: TEAM, private: true } },
          },
        },
      });
    }
    if (refuseNextActivity && body.includes("AgentActivityCreate")) {
      refuseNextActivity = false;
      return resp(200, { data: { agentActivityCreate: { success: false } } });
    }
    activities.push(body);
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

    ok(
      (res as { auth: { attributes: Record<string, string> } }).auth.attributes[OE_ADDRESSED_ATTR] === "1",
      "🔴 linear: the Agent Session wake carries oe_addressed='1' — the session IS the address, which is what lets a bare `link <code>` claim in the agent's own thread",
    );

    ok((await store.getEngagement(part.org, part.surfaceKey, "wiring-issue-2")) === null, "🔴 linear: NEGATIVE CONTROL — a different issue in the same team holds no row");

    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — the issue is stood down");
    _resetLinearGuestCache();
    activities.length = 0;
    const stoodDownPrompt = await linearOnAgentSession({} as never, { ...(event("sess-2") as Record<string, unknown>), action: "prompted" } as never);
    const afterPrompt = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(
      afterPrompt !== null && afterPrompt.stopped === true,
      "🔴 linear: a `prompted` follow-up leaves the STOP in place — a reply in the agent's own thread is not a fresh invitation, so it cannot lift a stand-down",
    );
    ok(
      stoodDownPrompt === null,
      "🔴 OPE-1548 linear: a `prompted` follow-up on a STOOD-DOWN issue is SUPPRESSED — the addressed leg reads back the row it wrote, so the agent's own thread is silenced like every top-level comment",
    );
    ok(
      activities.filter((b) => b.includes("Standing down on this issue")).length === 1,
      "🔴 OPE-1548 linear: …and the already-materialised Agent Session is CLOSED with the fixed host line, exactly once — Linear has no invisible close, so a suppression that posted nothing would hang the requester's spinner",
    );

    _resetLinearGuestCache();
    const replayedPrompt = await linearOnAgentSession({} as never, { ...(event("sess-2") as Record<string, unknown>), action: "prompted" } as never);
    ok(replayedPrompt === null, "🔴 OPE-1548 linear: a REDELIVERED `prompted` is still suppressed — the ack guard never gates the suppression itself");
    ok(
      activities.filter((b) => b.includes("Standing down on this issue")).length === 1,
      "🔴 OPE-1548 linear: …and it posts NO second line — the ack is keyed on the DELIVERY, so a redelivery cannot double up on an issue that asked for quiet",
    );

    activities.length = 0;
    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — the issue is stood down for the failed-ack arm");
    refuseNextActivity = true;
    _resetLinearGuestCache();
    const failedAckPrompt = await linearOnAgentSession({} as never, { ...(event("sess-ack-fail") as Record<string, unknown>), action: "prompted" } as never);
    ok(
      failedAckPrompt === null,
      "🔴 OPE-1548 linear: a `prompted` follow-up whose ack FAILS is still SUPPRESSED — the ack guard never gates the suppression, so a broken post can never dispatch a turn",
    );
    ok(
      activities.filter((b) => b.includes("Standing down on this issue")).length === 0,
      "linear: precondition — the refused post landed NO line, which is the state the redelivery below must repair",
    );
    _resetLinearGuestCache();
    const retriedAckPrompt = await linearOnAgentSession({} as never, { ...(event("sess-ack-fail") as Record<string, unknown>), action: "prompted" } as never);
    ok(retriedAckPrompt === null, "OPE-1548 linear: the REDELIVERY of that same webhook is suppressed too");
    ok(
      activities.filter((b) => b.includes("Standing down on this issue")).length === 1,
      "🔴 OPE-1548 linear: …and it POSTS THE LINE — a failed post gives the claim back, so the guard is spent by a line that landed and never by one that did not",
    );

    _resetLinearGuestCache();
    await linearOnAgentSession({} as never, { ...(event("sess-ack-fail") as Record<string, unknown>), action: "prompted" } as never);
    ok(
      activities.filter((b) => b.includes("Standing down on this issue")).length === 1,
      "🔴 OPE-1548 linear: NEGATIVE CONTROL — a redelivery AFTER a successful ack posts no second line, so the release fires on failure only",
    );

    _resetLinearGuestCache();
    const createdOnStoodDown = await linearOnAgentSession({} as never, event("sess-3") as never);
    ok(
      createdOnStoodDown !== null && (createdOnStoodDown as { auth?: unknown }).auth !== undefined,
      "🔴 OPE-1548 linear: a `created` session on a STOOD-DOWN issue still DISPATCHES — a fresh assign or @mention is the way back in, so the gate must never reach it",
    );
    const afterCreated = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(afterCreated !== null && afterCreated.stopped === false, "🔴 linear: NEGATIVE CONTROL — a fresh `created` session CLEARS the stop, which is the documented way back in");

    _resetLinearGuestCache();
    activities.length = 0;
    const livePrompt = await linearOnAgentSession({} as never, { ...(event("sess-3b") as Record<string, unknown>), action: "prompted" } as never);
    ok(
      livePrompt !== null && (livePrompt as { auth?: unknown }).auth !== undefined,
      "🔴 OPE-1548 linear: NEGATIVE CONTROL — a `prompted` follow-up on a LIVE issue still dispatches, so the suppression is driven by the stored stop and not by the action",
    );
    ok(
      !activities.some((b) => b.includes("Standing down on this issue")),
      "🔴 OPE-1548 linear: NEGATIVE CONTROL — …and it posts no stand-down line, so the ack rides the suppression rather than every follow-up",
    );

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

    _resetLinearGuestCache();
    _resetLinearViewerCache();
    activities.length = 0;
    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — the issue is stood down again, so the re-address below has a stop to lift");
    const reMention = await linearOnAgentSession({} as never, {
      ...(event("sess-4") as Record<string, unknown>),
      action: "prompted",
      delivery: { id: "d-sess-4-rementioned" },
      agentActivity: { sourceCommentId: RE_MENTION_COMMENT },
    } as never);
    ok(
      reMention !== null && (reMention as { auth?: unknown }).auth !== undefined,
      "🔴 OPE-1807 linear: a `prompted` delivery whose OWN comment @mentions the app DISPATCHES on a stood-down issue — an explicit re-address is the way back in, whatever event shape carries it",
    );
    const afterReMention = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(
      afterReMention !== null && afterReMention.stopped === false,
      "🔴 OPE-1807 linear: …and the SAME call CLEARED the stop, keyed on the COMMENT — a session-keyed lift would find `sess-4`'s once-key spent, no-op, and leave the stop standing",
    );
    ok(
      !activities.some((b) => b.includes("Standing down on this issue")),
      "🔴 OPE-1807 linear: …and it posts NO stand-down line — the ack that tells a member to @mention must never be the answer to their @mention",
    );

    _resetLinearGuestCache();
    activities.length = 0;
    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — stopped again for the negative control");
    const plainPrompt = await linearOnAgentSession({} as never, {
      ...(event("sess-5") as Record<string, unknown>),
      action: "prompted",
      delivery: { id: "d-sess-5-plain" },
      agentActivity: { sourceCommentId: PLAIN_PROMPT_COMMENT },
    } as never);
    ok(
      plainPrompt === null,
      "🔴 OPE-1807 linear: NEGATIVE CONTROL — a comment-backed `prompted` whose comment names NOBODY is still SUPPRESSED, so the lift is driven by the comment's @mention and not by the presence of a comment",
    );
    const afterPlainPrompt = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(afterPlainPrompt !== null && afterPlainPrompt.stopped === true, "🔴 OPE-1807 linear: NEGATIVE CONTROL — …and the stop STANDS, so a plain follow-up cannot re-invite");
    ok(
      activities.filter((b) => b.includes("Standing down on this issue")).length === 1,
      "🔴 OPE-1807 linear: NEGATIVE CONTROL — …and the session is still closed with the fixed host line, exactly once",
    );

    const refusedLift = async (label: string, sessionId: string, commentId: string): Promise<void> => {
      _resetLinearGuestCache();
      activities.length = 0;
      ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), `linear: precondition — stopped for ${label}`);
      const res2 = await linearOnAgentSession({} as never, {
        ...(event(sessionId) as Record<string, unknown>),
        action: "prompted",
        delivery: { id: `d-${sessionId}-${commentId}` },
        agentActivity: { sourceCommentId: commentId },
      } as never);
      ok(res2 === null, `🔴 OPE-1807 linear: ${label} — the delivery is SUPPRESSED, not lifted`);
      const after2 = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
      ok(after2 !== null && after2.stopped === true, `🔴 OPE-1807 linear: ${label} — …and the stop STANDS, so this author cannot re-open an issue somebody closed`);
      ok(
        activities.filter((b) => b.includes("Standing down on this issue")).length === 1,
        `🔴 OPE-1807 linear: ${label} — …and exactly ONE fixed line is posted, so a refused lift never doubles up with the external-policy line`,
      );
    };

    await refusedLift("a SELF-authored @mention (our own reply)", "sess-6", SELF_MENTION_COMMENT);
    await refusedLift("an AUTHOR-LESS @mention (a bot or integration wrote it)", "sess-7", AUTHORLESS_MENTION_COMMENT);

    registerConfig({
      loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
      loadDomains: () => [{ name: "org", match: "org", externalPolicy: { authorGrain: "withhold" } }],
      loadSilos: () => [], domainsForSurface: () => [],
    } as never);
    await refusedLift("a GUEST's @mention under a `withhold` author grain", "sess-8", GUEST_MENTION_COMMENT);
    registerConfig({
      loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
      loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [],
    } as never);

    _resetLinearGuestCache();
    activities.length = 0;
    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — stopped for the member re-address control");
    const memberLift = await linearOnAgentSession({} as never, {
      ...(event("sess-9") as Record<string, unknown>),
      action: "prompted",
      delivery: { id: "d-sess-9-member" },
      agentActivity: { sourceCommentId: RE_MENTION_COMMENT_2 },
    } as never);
    ok(
      memberLift !== null && (memberLift as { auth?: unknown }).auth !== undefined,
      "🔴 OPE-1807 linear: NEGATIVE CONTROL — a MEMBER's @mention still lifts, so the author floor refuses by author and not by default",
    );
    const afterMemberLift = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(afterMemberLift !== null && afterMemberLift.stopped === false, "🔴 OPE-1807 linear: NEGATIVE CONTROL — …and the stop is cleared");

    _resetLinearGuestCache();
    ok(await store.markStopped(part.org, part.surfaceKey, ISSUE), "linear: precondition — stopped again, on an issue already lifted by this comment");
    const replayedLift = await linearOnAgentSession({} as never, {
      ...(event("sess-9") as Record<string, unknown>),
      action: "prompted",
      delivery: { id: "d-sess-9-member-replay" },
      agentActivity: { sourceCommentId: RE_MENTION_COMMENT_2 },
    } as never);
    const afterReplayedLift = await store.getEngagement(part.org, part.surfaceKey, ISSUE);
    ok(
      afterReplayedLift !== null && afterReplayedLift.stopped === true,
      "🔴 OPE-1807 linear: a REDELIVERED re-address leaves the NEW stop in place — the once-guard keys on the comment, so replaying one @mention cannot lift twice",
    );
    ok(replayedLift !== null, "OPE-1807 linear: …and the delivery still dispatches, the same trade a redelivered `created` has always made — the guard protects the row, not the turn");
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
    markEventSeen: async () => true,
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
            ? [{ name: "e2e-engaged", reach: [`notion/${WS}`] }]
            : [{ name: "e2e-engaged", reach: [`notion/${WS}/${PAGE}`] }],
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
    const { marked, sessionOpened } = await drive("direct", { authorGrain: "taint" });
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
    const { marked, sessionOpened } = await drive("direct", undefined);
    ok(!sessionOpened && marked.length === 0, "🔴 notion mark: under the SHIPPED policy (`withhold`) the excluded author's addressed wake is suppressed and enrols nothing");
  }

  {
    const { marked, sessionOpened } = await drive("channel-watch", { authorGrain: "taint" });
    ok(sessionOpened, "notion mark: precondition — a channel-watch wake still opens its session");
    ok(marked.length === 0, "🔴 notion mark: an AMBIENT wake enrols nothing — being read is not being invited");
  }

  {
    const { marked, sessionOpened } = await drive("direct", { authorGrain: "taint" });
    ok(sessionOpened && marked.length === 1, "🔴 notion mark: NEGATIVE CONTROL — under the `taint` opt-out grain the same author is admitted and DOES enrol, so control 1 measured the policy and not the fixture");
  }

  const part = resolvePartition({
    channel: { kind: "notion" as const },
    session: { auth: { current: buildNotionAuth({ workspaceId: WS, pageId: PAGE, principalId: AUTHOR }) as unknown as { attributes?: Readonly<Record<string, string>> } } },
  } as never);
  const ANCHOR = `${WS}/${PAGE}`;
  const driveLive = async (commentId: string) => {
    await handleNotionSupervisorDispatch({ ...dispatchInput("direct"), trigger: wakeMessage(commentId), externalPolicy: resolveExternalPolicy({ authorGrain: "taint" }) } as never, {
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

{
  const GH_OWNER = "addressed-org";
  const GH_REPO = "addressed-repo";
  const LIN_ORG = "addressed-linear-org";
  const LIN_TEAM = "addressed-team";
  const LIN_ISSUE = "addressed-issue-1";
  const GH_SURFACE = `github/${GH_OWNER}/${GH_REPO}`;
  const LIN_SURFACE = `linear/${LIN_ORG}/${LIN_TEAM}`;

  const addressedOnly = defineDomain({ name: "addressed-only", reach: [GH_SURFACE, LIN_SURFACE], ambientSupervisor: false });
  const domains = [addressedOnly];
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: ({ surface }: { readonly surface: string }) => (surface === GH_REPO || surface === LIN_TEAM ? ["addressed-only"] : []),
  } as never);

  ok(ambientSkipFor(GH_SURFACE, domains)?.reason === "domain-refused", "addressed-only: precondition — the fixture domain ROUTES the repo and refuses the ambient supervisor on it, which is the declared state and not the absent one");
  ok(ambientSkipFor(LIN_SURFACE, domains)?.reason === "domain-refused", "addressed-only: precondition — …and routes the team and refuses it there too");

  const ghCtx = (issueNumber = 11): unknown => ({
    repository: { owner: GH_OWNER, name: GH_REPO, fullName: `${GH_OWNER}/${GH_REPO}`, id: 2, private: true },
    conversation: { kind: "issue", issueNumber, pullRequestNumber: null },
    github: { installationId: 456 },
    sender: { login: "dev", id: 7, type: "User" },
    thread: { kind: "issue", post: async () => ({ id: 1 }), react: async () => {} },
  });
  const ghComment = (id: number, body: string): unknown => ({ id, body, author: { login: "dev", id: 7, type: "User" }, raw: { author_association: "MEMBER" } });

  const ghMention = await githubOnComment(ghCtx() as never, ghComment(401, "@eve-bot what's 12*12?") as never);
  ok(
    ghMention !== null && (ghMention as { auth?: unknown }).auth !== undefined,
    "🔴 OPE-1681 github: an @mention on an ADDRESSED-ONLY domain DISPATCHES — `ambientSupervisor` gates the ambient supervisor and has never gated the addressed door",
  );

  ok(
    (await githubOnComment(ghCtx(12) as never, ghComment(402, "and what's that plus 6?") as never)) === null,
    "🔴 OPE-1681 github: NEGATIVE CONTROL — a PLAIN comment in an issue nobody addressed returns null on the same domain, so the mention above passed a door and not an open gate",
  );

  const ghSeamFacts = (number: number, over: { readonly isPrivate?: boolean; readonly conversationKind?: string } = {}) => ({
    owner: GH_OWNER,
    repo: GH_REPO,
    number,
    isPrivate: true,
    actorLogin: "dev",
    isMention: false,
    authorIsBot: false,
    conversationKind: "issue",
    ...over,
  });

  const engagedAdm = await githubAmbientLegAdmission("channel-watch", GH_SURFACE, ghSeamFacts(11));
  ok(
    engagedAdm.engagedFollowUp,
    "OPE-1740 github ambient: precondition — the seam reads issue 11 as an ENGAGED container whose follow-up is in reach (a private repo, not an inline review comment)",
  );
  ok(
    engagedAdm.keep,
    "🔴 OPE-1740 github ambient: a PLAIN follow-up in an ENGAGED issue is KEPT on an ADDRESSED-ONLY domain — the enrolment is the address, and the chattiness flag governs uninvited talk only",
  );

  const unengagedAdm = await githubAmbientLegAdmission("channel-watch", GH_SURFACE, ghSeamFacts(12));
  ok(
    !unengagedAdm.engagedFollowUp,
    "OPE-1740 github ambient: precondition — issue 12 carries no engagement row, so the seam offers the gate nothing",
  );
  ok(
    !unengagedAdm.keep,
    "🔴 OPE-1740 github ambient: NEGATIVE CONTROL — the SAME plain comment in an UN-ENGAGED issue is still REFUSED (and audited `domain-refused`), so the line above passed a door and not an open gate",
  );

  const publicAdm = await githubAmbientLegAdmission("channel-watch", GH_SURFACE, ghSeamFacts(11, { isPrivate: false }));
  ok(
    !publicAdm.engagedFollowUp && !publicAdm.keep,
    "🔴 OPE-1740 github ambient: the REACH FLOOR is wired into the admission — the SAME engaged issue on a PUBLIC repo is refused, so the new door never widens an uninvited turn past the native leg's own floor",
  );
  const reviewAdm = await githubAmbientLegAdmission("channel-watch", GH_SURFACE, ghSeamFacts(11, { conversationKind: "review_thread" }));
  ok(
    !reviewAdm.engagedFollowUp && !reviewAdm.keep,
    "🔴 OPE-1740 github ambient: …and an INLINE REVIEW COMMENT is refused too — a review thread shares its pull request's anchor, so one @mention would otherwise admit dozens of them",
  );

  const ghPart = resolvePartition({
    channel: { kind: "github" as const },
    session: {
      auth: {
        current: buildGitHubAuth({ owner: GH_OWNER, repo: GH_REPO, actorLogin: "dev", isPrivate: true }) as unknown as {
          attributes?: Readonly<Record<string, string>>;
        },
      },
    },
  } as never);
  ok(await store.markStopped(ghPart.org, ghPart.surfaceKey, `${GH_OWNER}/${GH_REPO}#11`), "OPE-1740 github ambient: precondition — issue 11 is stood down");
  const stoppedAdm = await githubAmbientLegAdmission("channel-watch", GH_SURFACE, ghSeamFacts(11));
  ok(
    !stoppedAdm.keep && !stoppedAdm.engagedFollowUp,
    "🔴 OPE-1740 github ambient: a STOOD-DOWN issue's plain follow-up is refused again — the enrolment door never overrides the stop",
  );

  const resp = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  const fakeLinear = (async (url: unknown, init: { body?: unknown }) => {
    const u = String(url);
    const body = String(init?.body ?? "");
    if (!u.includes("api.linear.app")) return resp(500, { error: "unexpected host" });
    if (body.includes("OeUserGuest")) return resp(200, { data: { user: { guest: false } } });
    if (body.includes("OeIssueTeam")) return resp(200, { data: { issue: { team: { id: LIN_TEAM, private: true } } } });
    return resp(200, { data: { agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } } });
  }) as typeof fetch;

  await withPatchedFetch(fakeLinear, async () => {
    const event = (sessionId: string): unknown => ({
      action: "created",
      kind: "agent_session",
      organizationId: LIN_ORG,
      previousComments: [],
      delivery: { id: `d-${sessionId}` },
      agentSession: { id: sessionId, creator: { id: "creator-9" }, issueId: LIN_ISSUE, issue: { id: LIN_ISSUE, identifier: "ADR-1" } },
      raw: { agentSession: { issue: { team: { id: LIN_TEAM } } } },
    });
    _resetLinearGuestCache();
    const linMention = await linearOnAgentSession({} as never, event("addressed-sess-1") as never);
    ok(
      linMention !== null && (linMention as { auth?: unknown }).auth !== undefined,
      "🔴 OPE-1681 linear: an Agent Session opened by an @mention on an ADDRESSED-ONLY domain DISPATCHES — the addressed leg never consults the ambient opt-in",
    );

    const part = resolvePartition({
      channel: { kind: "linear" as const },
      session: { auth: { current: { attributes: { organization_id: LIN_ORG, team_id: LIN_TEAM }, principalId: "creator-9", principalType: "linear-user" } } },
    } as never);
    ok(await store.markStopped(part.org, part.surfaceKey, LIN_ISSUE), "addressed-only linear: precondition — the issue is stood down");
    _resetLinearGuestCache();
    ok(
      (await linearOnAgentSession({} as never, { ...(event("addressed-sess-2") as Record<string, unknown>), action: "prompted" } as never)) === null,
      "🔴 OPE-1681 linear: NEGATIVE CONTROL — a `prompted` follow-up on a STOOD-DOWN issue is still suppressed on the same domain, so the dispatch above is a door and not an open gate",
    );
  });
}

{
  const GUILD = "wiring-guild";
  const BASE = "wiring-base-channel";
  const THREAD = "wiring-auto-thread";
  const STRANGER = "wiring-other-thread";

  const prevDiscordToken = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;

  const domains = [defineDomain({ name: "addressed-guild", reach: [`discord/${GUILD}/${BASE}`], ambientSupervisor: false })];
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: ({ surface }: { readonly surface: string }) => (surface === BASE ? ["addressed-guild"] : []),
  } as never);
  ok(ambientSkipFor(`discord/${GUILD}/${BASE}`, domains)?.reason === "domain-refused", "discord: precondition — the fixture domain ROUTES the channel and refuses the ambient supervisor on it (see the addressed-only block for why `no-domain` must not pass here)");

  const relay = (over: Record<string, unknown>): unknown => ({
    id: "m1",
    content: "hello",
    channelId: BASE,
    channelType: "0",
    guildId: GUILD,
    author: { id: "U-human", username: "human", bot: false },
    mentionsBot: false,
    botName: "Aria",
    botId: "BOT",
    ...over,
  });
  const sends: unknown[] = [];
  const send = (async (message: unknown) => {
    sends.push(message);
    return {};
  }) as never;
  const opensThread = async () => THREAD;
  const neverThreads = async () => null;
  const parentIsBase = async () => BASE;

  const drive = async (msg: unknown, createThread: () => Promise<string | null>, resolveParent: () => Promise<string | undefined>) => {
    sends.length = 0;
    const auth = authForRelayMessage(msg as never);
    ok(auth !== null, "discord: precondition — a human relay message resolves an auth");
    await dispatchTurn(msg as never, auth as never, send, createThread as never, resolveParent as never);
    return sends.length;
  };

  ok(
    (await drive(relay({ id: "m-mention", mentionsBot: true, content: "<@BOT> summarise the topic" }), opensThread, parentIsBase)) === 1,
    "🔴 OPE-1670 discord: an @mention on an ADDRESSED-ONLY domain dispatches exactly one turn",
  );
  const threadCoords = engagementCoordsFor({ channelId: THREAD, guildId: GUILD })!;
  const threadRow = await store.getEngagement(threadCoords.p.org, threadCoords.p.surfaceKey, threadCoords.key);
  ok(
    threadRow !== null && threadRow.participating === true,
    "🔴 OPE-1670 discord: …and the row it wrote sits on the AUTO-THREAD as a participating one — the re-key moves the enrolment with the conversation",
  );
  const baseCoords = engagementCoordsFor({ channelId: BASE, guildId: GUILD })!;
  ok(
    (await store.getEngagement(baseCoords.p.org, baseCoords.p.surfaceKey, baseCoords.key)) === null,
    "🔴 OPE-1670 discord: NEGATIVE CONTROL — the BASE channel is left UN-engaged, so a later message there still needs its own mention",
  );

  const followUp = relay({ id: "m-follow", channelId: THREAD, channelType: "11", content: "expand that into three sentences" });
  ok(
    (await drive(followUp, neverThreads, parentIsBase)) === 1,
    "🔴 OPE-1670 discord: a PLAIN follow-up in the auto-thread dispatches exactly one turn — the read addresses the row the re-keyed mention wrote",
  );

  ok(
    (await drive(relay({ id: "m-stranger", channelId: STRANGER, channelType: "11", content: "expand that into three sentences" }), neverThreads, parentIsBase)) === 0,
    "🔴 OPE-1670 discord: NEGATIVE CONTROL — the SAME message in an UN-ENGAGED thread dispatches nothing, so the leg above rode the registry and not a gate that stopped gating",
  );

  ok(await store.markStopped(threadCoords.p.org, threadCoords.p.surfaceKey, threadCoords.key), "discord: precondition — the thread is stood down");
  ok(
    (await drive(relay({ id: "m-after-stop", channelId: THREAD, channelType: "11", content: "and who else works on it?" }), neverThreads, parentIsBase)) === 0,
    "🔴 OPE-1670 discord: a follow-up in a STOOD-DOWN thread dispatches nothing — the flag is read on every plain message, not only at mark time",
  );
  ok(
    (await drive(relay({ id: "m-back", channelId: THREAD, channelType: "11", mentionsBot: true, content: "<@BOT> back please" }), neverThreads, parentIsBase)) === 1,
    "🔴 OPE-1670 discord: a fresh @mention in the same thread dispatches — an address is the documented way back in",
  );
  const revived = await store.getEngagement(threadCoords.p.org, threadCoords.p.surfaceKey, threadCoords.key);
  ok(revived !== null && revived.stopped === false, "🔴 OPE-1670 discord: …and it CLEARS the stop, so plain follow-ups are admitted again");
  ok(
    (await drive(relay({ id: "m-follow-2", channelId: THREAD, channelType: "11", content: "one more sentence please" }), neverThreads, parentIsBase)) === 1,
    "OPE-1670 discord: …demonstrated — the plain follow-up that was silenced above dispatches again",
  );

  if (prevDiscordToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = prevDiscordToken;
}

{
  const { extractLinearCommentSignal } = await import("@open-everywhere/provider-linear/agent/channels/linear-supervisor.js");
  const comment = (action: string): unknown => ({ kind: "data", type: "Comment", action, organizationId: "org-9", raw: { data: { id: "cmt-9", issueId: "iss-9" } } });

  ok(extractLinearCommentSignal(comment("create") as never) !== null, "linear edit filter: precondition — a CREATED comment is a conversational trigger");
  ok(
    extractLinearCommentSignal(comment("update") as never) === null,
    "🔴 OPE-1673 linear: an UPDATED comment yields no signal — the ambient leg returns above the classifier, which is why §7.1.1 declares the edit wake unsupported here",
  );
  ok(extractLinearCommentSignal(comment("remove") as never) === null, "linear edit filter: a REMOVED comment yields none either");

  const SECRET = "edit-filter-secret";
  const notionBody = (type: string): string =>
    JSON.stringify({
      type,
      workspace_id: "edit-ws",
      entity: { id: "cmt-e", type: "comment" },
      data: { page_id: "edit-page", parent: { id: "edit-page", type: "page" } },
      authors: [{ id: "edit-author", type: "person" }],
    });
  const driveNotion = async (type: string) => {
    const raw = notionBody(type);
    return handleNotionDelivery(raw, "sha256=" + createHmac("sha256", SECRET).update(raw, "utf8").digest("hex"), {
      signingKeys: [{ credentialId: "channel-key", secret: SECRET }],
      allowUnverified: false,
      credentialFor: async () => ({ apiKey: "ntn_key" }),
      credentialForPage: () => undefined,
      domains: [],
      resolveBotUserId: async () => "edit-bot",
      ambientEnabled: () => true,
      fetch: (async () => new Response("unexpected", { status: 500 })) as never,
      dispatch: async () => {},
      attachSession: () => ({ cancel: async () => ({ status: "accepted" as const }) }),
    } as unknown as Parameters<typeof handleNotionDelivery>[2]);
  };
  const updated = await driveNotion("comment.updated");
  ok(
    updated.action === "ignored" && updated.detail === "comment.updated",
    "🔴 OPE-1673 notion: a `comment.updated` delivery answers `ignored` at step 4 — the edit never reaches the classifier, which is why §7.1.1 declares the edit wake unsupported here",
  );
  ok((await driveNotion("comment.created")).action !== "ignored", "🔴 OPE-1673 notion: NEGATIVE CONTROL — `comment.created` passes step 4, so the refusal above is the event type and not the fixture");
}

{
  const { linearWakeAddressing } = await import("@open-everywhere/provider-linear/agent/channels/linear-engagement.js");

  ok(linearWakeAddressing("channel-watch", true) === "thread-follow", "linear addressing: an engaged follow-up is PROMOTED — this is the value J-ENGAGED-linear step (b) gates on");
  ok(
    linearWakeAddressing("channel-watch", false) === "channel-watch",
    "🔴 linear addressing: NEGATIVE CONTROL — ambient chatter on a team that is not engaged stays `channel-watch`, so the promotion is evidence and not a rename",
  );
  ok(linearWakeAddressing("channel-watch", undefined) === "channel-watch", "linear addressing: an absent verdict is not an engaged one — the conservative word, so a caller that omits it claims nothing");
  ok(linearWakeAddressing("drop", true) === "drop", "linear addressing: `drop` is never promoted — it returns before the row is written, and the guard keeps that true if it ever did not");

  const { readFileSync } = await import("node:fs");
  const linearSource = readFileSync(new URL("../packages/providers/linear/agent/channels/linear.ts", import.meta.url), "utf8");
  ok(
    linearSource.includes('addressing: linearWakeAddressing(cls.addressing, seam.kind === "deliver")'),
    "🔴 linear addressing: the `linear.dispatched` row is BUILT from the seam verdict — without this call the mapping above is dead code and the journey reds again",
  );
  ok(
    !/detail:\s*\{\s*addressing:\s*cls\.addressing/.test(linearSource),
    "🔴 linear addressing: NEGATIVE CONTROL — the raw classifier value is no longer written into a dispatch detail, which is the exact line OPE-1578 removed",
  );
}

{
  const { githubWakeAddressing } = await import("@open-everywhere/provider-github/agent/channels/github-engagement.js");

  ok(githubWakeAddressing("channel-watch", true) === "thread-follow", "github addressing: an engaged follow-up is PROMOTED — this is the value J-ENGAGED-github step (b) gates on");
  ok(
    githubWakeAddressing("channel-watch", false) === "channel-watch",
    "🔴 github addressing: NEGATIVE CONTROL — ambient chatter in an issue that is not engaged stays `channel-watch`, so the promotion is evidence and not a rename",
  );
  ok(githubWakeAddressing("channel-watch", undefined) === "channel-watch", "github addressing: an absent verdict is not an engaged one — the conservative word, so a caller that omits it claims nothing");
  ok(githubWakeAddressing("direct", true) === "direct", "github addressing: an ADDRESSED comment is never promoted — a mention is an address, not a follow-up, and step (a) of the journey reads `direct`");
  ok(githubWakeAddressing("drop", true) === "drop", "github addressing: `drop` is never promoted — it returns before the row is written, and the guard keeps that true if it ever did not");

  const { readFileSync: readGitHubSource } = await import("node:fs");
  const githubSource = readGitHubSource(new URL("../packages/providers/github/agent/channels/github.ts", import.meta.url), "utf8");
  ok(
    githubSource.includes("addressing: githubWakeAddressing(cls.addressing, admission.engagedFollowUp)"),
    "🔴 github addressing: the `github.dispatched` row is BUILT from the admission's seam verdict — without this call the mapping above is dead code and the journey reds again",
  );
  ok(
    !/detail:\s*\{\s*addressing:\s*cls\.addressing/.test(githubSource),
    "🔴 github addressing: NEGATIVE CONTROL — the raw classifier value is no longer written into a dispatch detail, which is the exact line OPE-1752 removed",
  );
}

console.log(
  `✓ engaged-seam-wiring: ${n} assertions passed (the real githubOnComment / linearOnAgentSession / handleNotionDelivery / dispatchTurn ingresses ask the seam — mark, deliver, stop, and the way back in, each with a negative control; the addressed-only domain admits a mention on GitHub and Linear with the ambient supervisor OFF; Discord's auto-thread carries its own follow-up; the two edit filters this repository owns refuse an edit; plus Linear's and GitHub's dispatch-row promotions and their call sites)`,
);
