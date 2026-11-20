// proves: SEAT-09, SEAT-10, SEAT-11

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-engaged-wake-contract-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
overrideSettingsForTest({ github: { appSlug: "eve-bot", conversation: true } });

const { renderWake, resolvePartition, getOperationalStore, ENGAGED_FOLLOW_UP_CONTEXT } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);
const { engagedFollowUpContract, conversationEnrolledForSilence, NO_REPLY_ADDRESSED_TO_OTHER_REFUSAL } = await import(
  "@open-everywhere/core/agent/channels/engaged-wake.js"
);
const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
registerGithubProvider();
const { githubOnComment } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { buildGitHubAuth } = await import("@open-everywhere/provider-github/agent/channels/github-identity.js");
const { buildGitHubSupervisorWake } = await import("@open-everywhere/provider-github/agent/channels/github-supervisor.js");
const { slackThreadFollowWake, slackChannelWatchWake } = await import(
  "@open-everywhere/provider-slack/agent/channels/slack-events.js"
);
const { buildLinearSupervisorWake } = await import("@open-everywhere/provider-linear/agent/channels/linear-supervisor.js");
const { buildNotionSupervisorWake } = await import("@open-everywhere/provider-notion/agent/channels/notion-supervisor.js");
const { buildTeamsSupervisorWake } = await import("@open-everywhere/provider-teams/agent/channels/teams-supervisor.js");
const { discordNativeWake, buildDiscordUnifiedWake } = await import(
  "@open-everywhere/provider-discord/agent/channels/discord-gateway.js"
);

const noReply = (await import("@open-everywhere/core/agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (input: { reason: string; explanation?: string }, ctx: unknown) => Promise<{ acknowledged: boolean }>;
};
const { NO_REPLY_ON_ENGAGED_ACTION } = await import("@open-everywhere/core/agent/channels/engaged-wake.js");
const { consumeNoReplyThisTurn } = await import("@open-everywhere/core/agent/channels/no-reply-signal.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href);
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const NOW = () => "2026-09-12T12:00:00.000Z";
const ATTR = 'follow-up="thread-engaged"';
const FOLLOW_UP = "and what's that plus 6?";

{
  ok(
    engagedFollowUpContract({ addressing: "channel-watch", threadEngaged: true }) === "thread-engaged",
    "helper: a JUDGED wake on an enrolled conversation states the contract",
  );
  ok(
    engagedFollowUpContract({ addressing: "thread-follow", threadEngaged: true }) === "thread-engaged",
    "helper: a `thread-follow` wake on an enrolled conversation states the contract",
  );
  ok(
    engagedFollowUpContract({ addressing: "thread-follow" }) === undefined,
    "🔴 helper: `thread-follow` alone states NOTHING — the tier is reached past an `isEngaged` gate a name-drop's WARM latch also satisfies, so deriving the contract from it would tell an uninvited seat it is enrolled",
  );
  ok(engagedFollowUpContract({ addressing: "channel-watch" }) === undefined, "helper: an UNSET verdict states nothing");
  ok(
    engagedFollowUpContract({ addressing: "channel-watch", threadEngaged: false }) === undefined,
    "helper: an explicit NOT-enrolled states nothing",
  );
  ok(
    engagedFollowUpContract({ addressing: "direct-mention", threadEngaged: true }) === undefined,
    "🔴 helper: an ADDRESSED @mention states nothing — it is owed an answer whatever the registry says, so the clause would decide nothing",
  );
  ok(
    engagedFollowUpContract({ addressing: "direct", threadEngaged: true }) === undefined,
    "🔴 helper: a `direct` wake states nothing — it renders the body VERBATIM with no envelope, so the attribute would be dropped on the floor",
  );
  ok(
    engagedFollowUpContract({ addressing: "name-drop", threadEngaged: true }) === undefined,
    "🔴 helper: a `name-drop` wake states nothing — that mechanic owns its own contract (`channel-not-following` on a base channel), and a relay with no bot name states none at all, which is a documented byte-identity guard",
  );
}

{
  const ev = { channelId: "C0ENG", ts: "2.0", threadTs: "1.0", userId: "U1", text: FOLLOW_UP };
  const opts = { trust: "peer" as const };
  const follow = (extra: Record<string, unknown>): string =>
    renderWake(slackThreadFollowWake(ev as never, { ...opts, ...extra } as never), NOW).message;
  ok(follow({ threadEngaged: true }).includes(ATTR), "🔴 slack: the engaged-conversation `thread-follow` wake states the enrolment");
  ok(
    !follow({ threadEngaged: false }).includes("follow-up="),
    "🔴 slack: NEGATIVE CONTROL — the SAME `thread-follow` wake on a WARM row states nothing. A name-drop latch writes `participating: false`, and that seat's bar is RAISED, not lowered",
  );
  ok(!follow({}).includes("follow-up="), "slack: NEGATIVE CONTROL — an UNSET verdict on a `thread-follow` wake states nothing either");
  const watch = (extra: Record<string, unknown>): string =>
    renderWake(slackChannelWatchWake(ev as never, { ...opts, ...extra } as never), NOW).message;
  ok(watch({ threadEngaged: true }).includes(ATTR), "slack: the standing seat's judged wake states it off the engagement row");
  ok(!watch({}).includes("follow-up="), "slack: NEGATIVE CONTROL — an un-enrolled judged wake states nothing");
  ok(
    !watch({ threadEngaged: true, directMention: true }).includes("follow-up="),
    "slack: NEGATIVE CONTROL — an ADDRESSED @mention states nothing",
  );
}

{
  const trigger = { id: "c1", authorId: "u1", sentAt: NOW(), text: FOLLOW_UP, trust: "peer" as const };
  const wakeOf = (extra: Record<string, unknown>): string =>
    renderWake(buildLinearSupervisorWake({ teamId: "TEAM", issueId: "iss", issueIdentifier: "ENG-1", trigger, ...extra } as never), NOW)
      .message;
  ok(wakeOf({ threadEngaged: true }).includes(ATTR), "🔴 linear: the engaged issue's plain follow-up states the enrolment");
  ok(!wakeOf({}).includes("follow-up="), "linear: NEGATIVE CONTROL — an un-enrolled judged wake states nothing");
  ok(
    !wakeOf({ threadEngaged: true, directMention: true }).includes("follow-up="),
    "linear: NEGATIVE CONTROL — an ADDRESSED @mention states nothing",
  );
}

{
  const trigger = { from: "human" as const, id: "c1", authorId: "u1", sentAt: NOW(), text: FOLLOW_UP, trust: "peer" as const };
  const wakeOf = (extra: Record<string, unknown>): string =>
    renderWake(buildNotionSupervisorWake({ addressing: "channel-watch", pageId: "PAGE", discussionId: "D1", trigger, ...extra } as never), NOW)
      .message;
  ok(wakeOf({ threadEngaged: true }).includes(ATTR), "🔴 notion: the engaged page's plain comment states the enrolment");
  ok(!wakeOf({}).includes("follow-up="), "notion: NEGATIVE CONTROL — an un-enrolled judged wake states nothing");
  ok(
    !wakeOf({ addressing: "direct", threadEngaged: true }).includes("follow-up="),
    "notion: NEGATIVE CONTROL — a `direct` wake renders no envelope, so it states nothing",
  );
}

{
  const trigger = { id: "c1", authorLogin: "dev", sentAt: NOW(), text: FOLLOW_UP, trust: "peer" as const };
  const wakeOf = (extra: Record<string, unknown>): string =>
    renderWake(buildGitHubSupervisorWake({ owner: "o", repo: "r", issueNumber: 7, trigger, ...extra } as never), NOW).message;
  ok(wakeOf({ threadEngaged: true }).includes(ATTR), "🔴 github ambient: the engaged issue's plain follow-up states the enrolment");
  ok(!wakeOf({}).includes("follow-up="), "github ambient: NEGATIVE CONTROL — an un-enrolled judged wake states nothing");
  ok(
    !wakeOf({ threadEngaged: true, directMention: true }).includes("follow-up="),
    "github ambient: NEGATIVE CONTROL — an ADDRESSED @mention states nothing",
  );
}

{
  const trigger = { id: "m1", author: "dev", authorId: "u1", sentAt: NOW(), text: FOLLOW_UP, trust: "peer" as const };
  const native = (addressing: string, extra: Record<string, unknown> = {}): string =>
    renderWake(discordNativeWake({ channelId: "CH", isThread: true, isDm: false, addressing, trigger, ...extra } as never), NOW).message;
  ok(
    native("thread-follow", { threadEngaged: true }).includes(ATTR),
    "🔴 discord: the engaged non-mention wake states the enrolment (it used to carry the tier alone)",
  );
  ok(
    !native("thread-follow", { threadEngaged: false }).includes("follow-up="),
    "🔴 discord: NEGATIVE CONTROL — the SAME `thread-follow` wake on a WARM row states nothing. Its own thread name-drop writes exactly such a row",
  );
  ok(!native("direct", { threadEngaged: true }).includes("follow-up="), "discord: NEGATIVE CONTROL — a `direct` wake renders no envelope, so it states nothing");

  const unified = (extra: Record<string, unknown>): string =>
    renderWake(
      buildDiscordUnifiedWake({ guildId: "G", channelId: "CH", isThread: true, addressing: "channel-watch", trigger, ...extra } as never),
      NOW,
    ).message;
  ok(unified({ threadEngaged: true }).includes(ATTR), "discord: the unified divert's judged wake states it off the engagement row");
  ok(!unified({}).includes("follow-up="), "discord: NEGATIVE CONTROL — an un-enrolled judged wake states nothing");
}

{
  const trigger = { id: "a1", authorId: "u1", authorName: "dev", sentAt: NOW(), text: FOLLOW_UP, trust: "peer" as const };
  const wakeOf = (extra: Record<string, unknown>): string =>
    renderWake(buildTeamsSupervisorWake({ channelId: "19:chan", directMention: false, wakeId: "w1", trigger, ...extra } as never), NOW).message;
  ok(wakeOf({ threadEngaged: true }).includes(ATTR), "🔴 teams: the engaged reply chain's plain follow-up states the enrolment (OPE-2610)");
  ok(!wakeOf({}).includes("follow-up="), "teams: NEGATIVE CONTROL — an un-enrolled judged wake states nothing");
  ok(
    !wakeOf({ threadEngaged: true, directMention: true }).includes("follow-up="),
    "teams: NEGATIVE CONTROL — an ADDRESSED @mention states nothing",
  );
  ok(
    wakeOf({ threadEngaged: true, nameDrop: true }).includes(ATTR),
    "🔴 teams: a name-drop INSIDE an enrolled chain states the enrolment — never `channel-not-following` in a chain an @mention enrolled",
  );
  ok(
    wakeOf({ nameDrop: true }).includes('follow-up="channel-not-following"'),
    "teams: NEGATIVE CONTROL — a name-drop in an un-enrolled chain keeps `channel-not-following`",
  );
  ok(
    NO_REPLY_ADDRESSED_TO_OTHER_REFUSAL.includes("You are engaged in this conversation"),
    "teams: …and the REFUSAL states the enrolment itself, for the native-path channel that renders no wake",
  );
}

{
  const OWNER = "contract-org";
  const REPO = "contract-repo";
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
  const comment = (id: number, body: string): unknown => ({
    id,
    body,
    author: { login: "dev", id: 7, type: "User" },
    raw: { author_association: "MEMBER" },
  });
  const drive = async (c: unknown): Promise<{ context?: readonly string[] } | null> =>
    (await githubOnComment(ctx() as never, c as never)) as { context?: readonly string[] } | null;

  const mentionRes = await drive(comment(201, "@eve-bot what's 12*12? reply with just the number"));
  ok(mentionRes !== null, "github: precondition — the @mention dispatches");
  ok(
    (await getOperationalStore().getEngagement(part.org, part.surfaceKey, anchor)) !== null,
    "github: precondition — the @mention ENROLLED the issue",
  );
  ok(
    (mentionRes?.context ?? []).every((c) => !c.includes(ENGAGED_FOLLOW_UP_CONTEXT)),
    "🔴 github: NEGATIVE CONTROL — the ADDRESSED @mention carries NO enrolment line. It is owed an answer whatever the registry says, and a line on every mention would be the unconditional stamp this table exists to rule out",
  );

  const followRes = await drive(comment(202, FOLLOW_UP));
  ok(followRes !== null, "github: precondition — the plain follow-up in the engaged issue dispatches (the OPE-1501 seam)");
  ok(
    (followRes?.context ?? []).some((c) => c.includes(ENGAGED_FOLLOW_UP_CONTEXT)),
    "🔴 github: the engaged follow-up carries the enrolment fact in its turn context — the whole of OPE-1740. A live run declined this exact comment as `addressed_to_other` because nothing in the turn said the issue was engaged",
  );

  const journey = readFileSync(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url), "utf8");
  ok(
    journey.includes(`const followId = await github.comment(issue, \`${FOLLOW_UP} ref \${staleMarker}\`);`),
    "🔴 fixture: `J-ENGAGED-github` step (b) still posts the exact text this file drives through the ingress above — so the two cannot drift apart unnoticed. The trailing `ref <marker>` is OPE-1748's: the comment is the trigger of a wake, and the journey's catch-up leg asserts the LAST wake does not re-show it. A run-unique suffix names nobody and changes no ingress decision, so the text this file drives is still the text the journey posts",
  );
  ok(
    !/\b(ask|for|cc)\b\s+@?\w+/i.test(FOLLOW_UP),
    "🔴 fixture: that follow-up names nobody — so the live-run decline was the deployment's defect, not the fixture's",
  );

  ok(
    await conversationEnrolledForSilence(part, anchor),
    "🔴 silence verb: the predicate reads the very row the engaged ingress wrote — so what `no_reply` refuses and what the seat was told come off one fact",
  );
  ok(
    !(await conversationEnrolledForSilence(part, `${OWNER}/${REPO}#999`)),
    "silence verb: NEGATIVE CONTROL — an un-enrolled conversation is not enrolled",
  );
  ok(!(await conversationEnrolledForSilence(part, undefined)), "silence verb: NEGATIVE CONTROL — no anchor reads as not enrolled");
  ok(
    await getOperationalStore().markStopped(part.org, part.surfaceKey, anchor),
    "silence verb: precondition — the stop flag is set",
  );
  ok(
    !(await conversationEnrolledForSilence(part, anchor)),
    "🔴 silence verb: a STOOD-DOWN conversation is NOT enrolled — `stand_down` has already run, so nothing is owed an answer here",
  );
  ok(
    NO_REPLY_ADDRESSED_TO_OTHER_REFUSAL.includes("nothing_to_add") && NO_REPLY_ADDRESSED_TO_OTHER_REFUSAL.includes("stand_down"),
    "silence verb: the corrective names the endings that REMAIN — a refusal that only said \"reply\" would buy a confabulated answer on a turn with nothing to say",
  );
}

{
  const OWNER = "refusal-org";
  const REPO = "refusal-repo";
  const attributes = buildGitHubAuth({
    owner: OWNER,
    repo: REPO,
    repositoryFullName: `${OWNER}/${REPO}`,
    isPrivate: true,
    conversationKind: "issue",
    issueNumber: 9,
    actorLogin: "dev",
  }) as unknown as { attributes?: Readonly<Record<string, string>> };
  const seatCtx = () => ({ channel: { kind: "github" as const }, session: { auth: { current: attributes } } });
  const part = resolvePartition(seatCtx() as never);
  const anchor = `${OWNER}/${REPO}#9`;

  await inSession(async () => {
    const res = await noReply.execute({ reason: "addressed_to_other" }, seatCtx());
    ok(res.acknowledged === true, "🔴 refusal: NEGATIVE CONTROL — `addressed_to_other` in an UN-ENROLLED issue is accepted, unchanged");
    ok(consumeNoReplyThisTurn() === "addressed_to_other", "refusal: …and it records the silence, so an uninvited seat still goes quiet");
  });

  await githubOnComment(
    {
      repository: { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, id: 2, private: true },
      conversation: { kind: "issue", issueNumber: 9, pullRequestNumber: null },
      github: { installationId: 123 },
      sender: { login: "dev", id: 7, type: "User" },
      thread: { kind: "issue", post: async () => ({ id: 1 }), react: async () => {} },
    } as never,
    { id: 401, body: "@eve-bot what's 12*12?", author: { login: "dev", id: 7, type: "User" }, raw: { author_association: "MEMBER" } } as never,
  );
  ok(
    (await getOperationalStore().getEngagement(part.org, part.surfaceKey, anchor)) !== null,
    "refusal: precondition — the @mention enrolled the issue through the real ingress",
  );

  await inSession(async () => {
    const before = (await readAudit({ org: part.org, action: NO_REPLY_ON_ENGAGED_ACTION })).length;
    let threw = "";
    try {
      await noReply.execute({ reason: "addressed_to_other" }, seatCtx());
    } catch (e) {
      threw = String(e);
    }
    ok(
      threw.includes("addressed_to_other` is not available"),
      "🔴 refusal: the SAME call on the ENROLLED issue is REFUSED — the model is never asked to re-decide addressing on an engaged wake (OPE-1740)",
    );
    ok(threw.includes("nothing_to_add"), "refusal: the corrective names the ending that remains, so a seat with nothing to say is not pushed into confabulating one");
    ok(consumeNoReplyThisTurn() === null, "🔴 refusal: a refused call records NO silence — the turn's reply obligation is still open");
    ok(
      (await readAudit({ org: part.org, action: NO_REPLY_ON_ENGAGED_ACTION })).length === before + 1,
      "refusal: the refusal is AUDITED — a seat that keeps trying is countable in the actions-only posture prod runs in",
    );
  });

  await inSession(async () => {
    const res = await noReply.execute({ reason: "nothing_to_add" }, seatCtx());
    ok(
      res.acknowledged === true,
      "🔴 refusal: every OTHER reason is untouched on the SAME enrolled issue — the guard removes a false claim, never the option of being quiet",
    );
    ok(consumeNoReplyThisTurn() === "nothing_to_add", "refusal: …and that silence is recorded normally");
  });

  await inSession(async () => {
    const first = await noReply.execute({ reason: "nothing_to_add" }, seatCtx());
    ok(first.acknowledged === true, "refusal: precondition — the turn records silence on the ENROLLED issue");
    const second = await noReply.execute({ reason: "addressed_to_other" }, seatCtx());
    ok(
      second.acknowledged === true,
      "🔴 refusal: a SECOND call with the refused reason on an already-silent turn is NOT refused — the redundant arm ends the turn instead of this one reopening it",
    );
    ok(consumeNoReplyThisTurn() === "nothing_to_add", "refusal: …and the turn's recorded reason is still the FIRST one — no second silence row");
  });

  ok(await getOperationalStore().markStopped(part.org, part.surfaceKey, anchor), "refusal: precondition — the stop flag is set");
  await inSession(async () => {
    const res = await noReply.execute({ reason: "addressed_to_other" }, seatCtx());
    ok(res.acknowledged === true, "🔴 refusal: NEGATIVE CONTROL — a STOOD-DOWN issue accepts the reason again");
    ok(consumeNoReplyThisTurn() === "addressed_to_other", "refusal: …and records the silence");
  });
}

{
  const { engagedQuestionWake, NO_REPLY_ON_ENGAGED_QUESTION_ACTION } = await import("@open-everywhere/core/agent/channels/engaged-wake.js");
  const { engagedQuestionThisTurn } = await import("@open-everywhere/core/agent/channels/engaged-question-signal.js");
  const { markRepliedThisTurn } = await import("@open-everywhere/core/agent/channels/reply-signal.js");
  const requesterHook = await import("@open-everywhere/core/agent/hooks/requester-identity.js");
  const consumed = (requesterHook.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> })
    .events["delivery.consumed"]!;
  const notionWake = (text: string, extra: Record<string, unknown> = { threadEngaged: true }): string =>
    renderWake(
      buildNotionSupervisorWake({
        addressing: "channel-watch",
        pageId: "PAGE",
        discussionId: "D1",
        trigger: { from: "human" as const, id: "c9", authorId: "u1", sentAt: NOW(), text, trust: "peer" as const },
        ...extra,
      } as never),
      NOW,
    ).message;

  ok(engagedQuestionWake(notionWake(FOLLOW_UP)), "🔴 engaged question: an engaged Notion follow-up that asks a question is an engaged question");
  ok(!engagedQuestionWake(notionWake("thanks, that's great")), "engaged question: NEGATIVE CONTROL — an engaged follow-up that asks nothing is not");
  ok(!engagedQuestionWake(notionWake(FOLLOW_UP, {})), "engaged question: NEGATIVE CONTROL — an UN-enrolled channel-watch question is not");
  ok(
    !engagedQuestionWake(notionWake("see https://example.test/page?id=4 for the numbers")),
    "engaged question: NEGATIVE CONTROL — a `?` inside a URL query is not a question mark",
  );
  ok(!engagedQuestionWake(undefined), "engaged question: NEGATIVE CONTROL — no delivered text is not a question");
  ok(
    !engagedQuestionWake(`${notionWake(FOLLOW_UP)}\n\n${notionWake("and what about 7?")}`),
    "🔴 engaged question: NEGATIVE CONTROL — one message that holds TWO wakes is not one engaged question",
  );
  ok(engagedQuestionWake(notionWake("can you check *that?*")), "engaged question: a `?` before closing markdown emphasis still counts");

  const attributes = buildGitHubAuth({
    owner: "question-org",
    repo: "question-repo",
    repositoryFullName: "question-org/question-repo",
    isPrivate: true,
    conversationKind: "issue",
    issueNumber: 11,
    actorLogin: "dev",
  }) as unknown as { attributes?: Readonly<Record<string, string>> };
  const seatCtx = (turn: string) => ({ channel: { kind: "github" as const }, session: { auth: { current: attributes }, turn: { id: turn } } });
  const part = resolvePartition(seatCtx("t0") as never);
  const deliver = (turn: string, text: string, deliveryId = `d-${turn}`) =>
    consumed({ data: { deliveryId, parts: [{ kind: "text", text }], turnId: turn } }, seatCtx(turn));
  const refusedWith = async (reason: string, turn: string): Promise<string> => {
    try {
      await noReply.execute({ reason }, seatCtx(turn));
      return "";
    } catch (e) {
      return String(e);
    }
  };

  for (const reason of ["nothing_to_add", "not_relevant", "awaiting_context"]) {
    await inSession(async () => {
      const turn = `turn-q-${reason}`;
      await deliver(turn, notionWake(FOLLOW_UP));
      ok(engagedQuestionThisTurn(turn), `engaged question: precondition — the delivery.consumed hook marks the turn (${reason})`);
      const before = (await readAudit({ org: part.org, action: NO_REPLY_ON_ENGAGED_QUESTION_ACTION })).length;
      const threw = await refusedWith(reason, turn);
      ok(
        threw.includes(`\`${reason}\` is not available`),
        `🔴 engaged question: \`${reason}\` on an engaged follow-up that asks a question is REFUSED — the question is addressed to the agent`,
      );
      ok(consumeNoReplyThisTurn() === null, `🔴 engaged question: the refused \`${reason}\` records NO silence — the turn still owes its answer`);
      ok(
        threw.includes("`other`") && threw.includes("someone else") && threw.includes("`duplicate`") && threw.includes("`stand_down`"),
        `engaged question: the \`${reason}\` refusal names the exits that stay open, including \`other\` for a question put to another person`,
      );
      ok(
        (await readAudit({ org: part.org, action: NO_REPLY_ON_ENGAGED_QUESTION_ACTION })).length === before + 1,
        `engaged question: the \`${reason}\` refusal is AUDITED`,
      );
    });
  }

  await inSession(async () => {
    await deliver("turn-q-stop", notionWake(FOLLOW_UP));
    const res = await noReply.execute({ reason: "user_requested_silence" }, seatCtx("turn-q-stop"));
    ok(res.acknowledged === true, "engaged question: NEGATIVE CONTROL — `user_requested_silence` stays open on an engaged question");
    ok(consumeNoReplyThisTurn() === "user_requested_silence", "engaged question: …and records the silence");
  });

  await inSession(async () => {
    await deliver("turn-q-ack", notionWake("thanks, that's great"));
    const res = await noReply.execute({ reason: "nothing_to_add" }, seatCtx("turn-q-ack"));
    ok(res.acknowledged === true, "🔴 engaged question: NEGATIVE CONTROL — `nothing_to_add` on an engaged follow-up that asks NOTHING is accepted");
    ok(consumeNoReplyThisTurn() === "nothing_to_add", "engaged question: …and records the silence");
  });

  await inSession(async () => {
    await deliver("turn-q-old", notionWake(FOLLOW_UP));
    await deliver("turn-q-new", notionWake("thanks, that's great"));
    ok(!engagedQuestionThisTurn("turn-q-new"), "🔴 engaged question: a NEW turn that asks nothing clears the earlier turn's mark");
    const res = await noReply.execute({ reason: "nothing_to_add" }, seatCtx("turn-q-new"));
    ok(res.acknowledged === true, "engaged question: NEGATIVE CONTROL — the earlier turn's question does not fence the later turn");
    consumeNoReplyThisTurn();
  });

  await inSession(async () => {
    await deliver("turn-q-batch", notionWake(FOLLOW_UP));
    await deliver("turn-q-batch", "A background task settled. End this turn with `no_reply` (reason `nothing_to_add`).", "d-turn-q-batch-2");
    ok(!engagedQuestionThisTurn("turn-q-batch"), "🔴 engaged question: a SECOND delivery in the same turn clears the mark");
    const res = await noReply.execute({ reason: "nothing_to_add" }, seatCtx("turn-q-batch"));
    ok(res.acknowledged === true, "🔴 engaged question: NEGATIVE CONTROL — a two-delivery turn accepts `nothing_to_add`");
    consumeNoReplyThisTurn();
  });

  await inSession(async () => {
    await deliver("turn-q-refire", notionWake(FOLLOW_UP));
    await deliver("turn-q-refire", notionWake(FOLLOW_UP));
    ok(engagedQuestionThisTurn("turn-q-refire"), "🔴 engaged question: a re-run of the hook for the SAME delivery id keeps the mark");
    const threw = await refusedWith("nothing_to_add", "turn-q-refire");
    ok(threw.includes("is not available"), "engaged question: …and the fence still refuses `nothing_to_add`");
    consumeNoReplyThisTurn();
  });

  await inSession(async () => {
    await deliver("turn-q-answered", notionWake(FOLLOW_UP));
    markRepliedThisTurn("turn-q-answered");
    const res = await noReply.execute({ reason: "nothing_to_add" }, seatCtx("turn-q-answered"));
    ok(res.acknowledged === true, "🔴 engaged question: NEGATIVE CONTROL — after the turn posted its answer, `nothing_to_add` is accepted");
    consumeNoReplyThisTurn();
  });

  await inSession(async () => {
    await deliver("turn-q-unenrolled", notionWake(FOLLOW_UP, {}));
    const res = await noReply.execute({ reason: "nothing_to_add" }, seatCtx("turn-q-unenrolled"));
    ok(res.acknowledged === true, "🔴 engaged question: NEGATIVE CONTROL — `nothing_to_add` on an UN-enrolled channel-watch question is accepted");
    consumeNoReplyThisTurn();
  });
}

await removeTempDir(dir);
console.log(`✓ engaged-wake contract: ${n} assertions`);
