import assert from "node:assert/strict";
import {
  githubSupervisorToken,
  githubSupervisorSentinel,
  classifyGitHubAmbientComment,
  extractGitHubAmbientEvent,
  githubDispatchAuditDetail,
  buildGitHubSupervisorWake,
  handleGitHubSupervisorDispatch,
  shouldRotate,
  type GitHubSupervisorDeps,
  type GitHubSupervisorDispatch,
  type GitHubSupervisorSession,
  type GitHubAmbientComment,
} from "../agent/channels/github-supervisor.js";
import { renderWake, normalizeFenceNonce, UNTRUSTED_OPEN, OE_CHAT_NONMEMBER_ATTR, admissionFunction, defineSurface, registerSurfaces, _resetSurfacesForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpenEverywhereGitHubAuth } from "../agent/channels/github-identity.js";
import { githubAmbientLegKeeps, shouldSuppressNativeMention } from "../agent/channels/github.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SLUG = "open-everywhere";
const OWNER = "acme";
const REPO = "widgets";
const REPO_KEY = "ch_Z2l0aHViOmFjbWUvd2lkZ2V0cw";
const NOW = () => "2026-02-18T14:05:00.000Z";

ok(githubSupervisorSentinel(3) === "oe-sup:g3", "sentinel is oe-sup:g<gen>");
ok(githubSupervisorToken(OWNER, REPO, 1) === `github:${OWNER}/${REPO}:oe-sup:g1`, "token is github:<owner>/<repo>:oe-sup:g<gen>");
ok(githubSupervisorToken(OWNER, REPO, 2).includes(":oe-sup:g"), "token carries the :oe-sup:g infix hooks/spend + the supervisor model role key on");

for (const vouched of [true, false]) {
  for (const ambient of [true, false]) {
    const suppressed = shouldSuppressNativeMention(true, vouched);
    const mentionAddressing = vouched ? "direct" : "drop";
    const ambientKeeps = githubAmbientLegKeeps(mentionAddressing, ambient, false);
    ok(
      suppressed === ambientKeeps,
      `seated repo, vouched=${vouched}, ambient=${ambient}: EXACTLY ONE leg owns the @mention — native stands down iff the ambient leg keeps it (suppressed=${suppressed}, kept=${ambientKeeps}); any disagreement is a gap (nobody answers) or a double turn`,
    );
  }
}
ok(githubAmbientLegKeeps("direct", false, false), "🔴 the regression case: an ADDRESSED comment is kept with the chattiness flag OFF");
ok(!githubAmbientLegKeeps("channel-watch", false, false), "…while ordinary ambient talk with the flag off is still refused (and audited)");
ok(githubAmbientLegKeeps("channel-watch", true, false), "…and is kept when the domain opted in");
ok(!githubAmbientLegKeeps("drop", true, false), "the classifier's own DROP is final — the flag never re-opens it");

ok(githubAmbientLegKeeps("channel-watch", false, true), "🔴 the measured case: an ENGAGED container's plain follow-up is kept with the chattiness flag OFF — and the un-engaged row above, refused with the same two other inputs, is what makes this a door rather than an open gate");
ok(!githubAmbientLegKeeps("drop", false, true), "the classifier's own DROP is final — enrolment never re-opens it either");

{
  const detail = githubDispatchAuditDetail({
    addressing: "direct-mention",
    issueNumber: 42,
    commentId: "101",
    wakeId: "wake-101",
    repoPrivate: true,
    vouched: true,
  });
  ok(detail.commentId === "101" && detail.wakeId === "wake-101" && detail.issueNumber === 42, "github.dispatched carries the exact comment id and the one wake id minted for its window");
  const native = githubDispatchAuditDetail({ addressing: "channel-watch", issueNumber: 42, repoPrivate: true, vouched: false });
  ok(native.commentId === undefined && native.wakeId === undefined, "absent source ids remain absent on a native/non-window dispatch rather than being guessed");
}

const base: GitHubAmbientComment = { body: "looks good, shipping this after lunch", authorLogin: "human-dev", authorType: "User", repoPrivate: true };

ok(classifyGitHubAmbientComment(base, SLUG).addressing === "channel-watch", "plain comment on a private repo -> channel-watch (judged)");
ok(classifyGitHubAmbientComment({ ...base, body: `hey @${SLUG} can you review this` }, SLUG).addressing === "drop", "bot @mention -> DROP (owned by the native path — the two legs partition, never overlap)");
ok(classifyGitHubAmbientComment({ ...base, body: `email me at foo@${SLUG}rocks.dev` }, SLUG).addressing === "channel-watch", "an @slug with a trailing word-char is NOT a mention (matches the native gate) -> judged");
ok(classifyGitHubAmbientComment(base, undefined).addressing === "drop", "no bot slug -> DROP (fail-closed loop guard)");
ok(classifyGitHubAmbientComment(base, "  ").addressing === "drop", "blank bot slug -> DROP (fail-closed loop guard)");
ok(classifyGitHubAmbientComment({ ...base, authorType: "Bot", authorLogin: `${SLUG}[bot]` }, SLUG).addressing === "drop", "self-authored ([bot] reply) -> DROP");
ok(classifyGitHubAmbientComment({ ...base, authorType: "Bot", authorLogin: "dependabot[bot]" }, SLUG).addressing === "drop", "other bot-authored -> DROP (bot-to-bot loop guard)");
ok(classifyGitHubAmbientComment({ ...base, authorType: "User", authorLogin: `${SLUG.toUpperCase()}[BOT]` }, SLUG).addressing === "drop", "own login under a mislabelled type still DROPs (belt-and-braces, case-insensitive)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: false }, SLUG).addressing === "drop", "PUBLIC + un-vouched repo -> DROP (no drive-by ambient wakes)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: undefined }, SLUG).addressing === "drop", "UNKNOWN privacy + un-vouched repo -> DROP (fail closed)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: false }, SLUG, { vouched: true }).addressing === "channel-watch", "PUBLIC but VOUCHED repo -> channel-watch (vouch widens ambient; private flag is just a signal)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: true }, SLUG, { vouched: false }).addressing === "channel-watch", "PRIVATE un-vouched repo still ambient-wakes (per-repo path unchanged — never narrowed)");

const mention = { ...base, body: `hey @${SLUG} does this match what we agreed in Slack?` };
ok(classifyGitHubAmbientComment(mention, SLUG, { treatMentionAsDirect: true, vouched: true }).addressing === "direct", "single-window @mention on a VOUCHED repo -> direct (the unified window answers it, native suppressed)");
ok(classifyGitHubAmbientComment({ ...mention, repoPrivate: false }, SLUG, { treatMentionAsDirect: true, vouched: true }).addressing === "direct", "single-window @mention on a VOUCHED PUBLIC repo -> direct (vouch is the floor; private flag ignored — the Free-plan case)");
ok(classifyGitHubAmbientComment(mention, SLUG).addressing === "drop", "the SAME @mention WITHOUT treatMentionAsDirect -> DROP (byte-identical default; native path owns it)");
ok(classifyGitHubAmbientComment(mention, SLUG, { treatMentionAsDirect: true, vouched: false }).addressing === "drop", "single-window @mention on an UN-VOUCHED repo -> DROP (native NOT suppressed there — no double-handle, fail-closed)");
ok(classifyGitHubAmbientComment({ ...mention, repoPrivate: true }, SLUG, { treatMentionAsDirect: true }).addressing === "drop", "single-window @mention, PRIVATE but un-vouched -> DROP (private flag never admits the window — the vouch is the floor)");
ok(classifyGitHubAmbientComment(base, SLUG, { treatMentionAsDirect: true, vouched: true }).addressing === "channel-watch", "a NON-mention comment is unaffected by treatMentionAsDirect -> channel-watch (judged)");

const trigger = { id: "ic-42", authorLogin: "human-dev", sentAt: "2026-03-24T18:51:00Z", text: "should we bump the retry budget here?", trust: "unauth" as const };
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Flaky retries on cold start", trigger, engagementTier: "reserved" });
  const { message, context } = renderWake(nw, NOW);
  ok(message.startsWith("<wake ") && message.endsWith("</wake>"), "the wake is its envelope and nothing else (OPE-753)");
  ok(message.includes('addressing="channel-watch"'), "wake carries the ambient addressing the standing block keys the high silence bar to");
  ok(message.includes('container="repo"'), "wake uses the REPO container noun");
  ok(message.includes('engagement="reserved"'), "the reserved tier rides the envelope (GitHub's platform default tier)");
  ok(message.includes(`<channel id="${REPO_KEY}" container="repo">`), "locus.channel = owner/repo (the silo grain); the S1 <channel container> attribute mirrors the REPO noun (OPE-684)");
  ok(message.includes(`<thread ts="#42">`), "locus.thread = the issue number (the conversation the comment belongs to)");
  ok(message.includes(`trigger="true"`) && message.includes("should we bump the retry budget here?"), "the comment is the trigger message");
  ok(message.includes(UNTRUSTED_OPEN), "an UNVOUCHED author's comment body is untrusted-wrapped by the envelope");
  ok(context !== undefined && context.length === 1 && context[0]!.includes("Flaky retries on cold start"), "the issue title rides an untrusted-wrapped context block");
  ok(context![0]!.includes(UNTRUSTED_OPEN), "the title context is untrusted-wrapped too (payload-supplied text)");

  const member = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Flaky retries on cold start", trigger: { ...trigger, trust: "peer" }, engagementTier: "reserved" }), NOW);
  ok(member.message.includes("should we bump the retry budget here?"), "the member's comment still renders verbatim");
  ok(!member.message.includes(UNTRUSTED_OPEN), "a PEER-authored comment body is NOT untrusted-wrapped (OPE-577 — the fence keys on the author)");
  ok(member.context![0]!.includes(UNTRUSTED_OPEN), "…and the issue TITLE stays fenced regardless of who commented — it is payload text, not an authored message");
}
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger });
  const { message, context } = renderWake(nw, NOW);
  ok(context === undefined, "no issue title -> no context block");
  ok(!message.includes("engagement="), "no tier resolved -> NO engagement attribute at all (distinct from a resolved neutral)");
}

const TITLE = "Flaky retries on cold start";
{
  const refused = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: TITLE, trigger, admit: admissionFunction("members-only") }), NOW);
  ok(refused.context === undefined, "🔴 members-only REFUSES the title line, and no context block reaches the envelope");
  ok(!refused.message.includes(TITLE), "🔴 …and the title text is nowhere in the wake message either — the refusal is entry, not a render tweak");
  ok(refused.message.includes("should we bump the retry budget here?"), "negative control: the TRIGGER comment still reaches the seat — admission governs the slot, never the wake");

  const admitted = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: TITLE, trigger, admit: admissionFunction("wide") }), NOW);
  ok(admitted.context !== undefined && admitted.context.length === 1 && admitted.context[0]!.includes(TITLE), "negative control: `wide` (the default) admits the SAME line through the SAME seam");
  ok(admitted.context![0]!.includes(UNTRUSTED_OPEN), "…still untrusted-wrapped — admission is an entry rule, not a fencing rule");

  const bots = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: TITLE, trigger, admit: admissionFunction("wide-with-bots") }), NOW);
  ok(bots.context !== undefined && bots.context[0]!.includes(TITLE), "negative control: `wide-with-bots` admits it too — only members-only reads the vouch");

  const unpoliced = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: TITLE, trigger }), NOW);
  ok(normalizeFenceNonce(unpoliced.context![0]!) === normalizeFenceNonce(admitted.context![0]!), "no `admit` ⇒ no admission ⇒ the slot is byte-identical to the shipped-default one");
}
{
  const nw = buildGitHubSupervisorWake({
    owner: OWNER,
    repo: REPO,
    issueNumber: 7,
    trigger,
    tail: [{ from: "human", author: "octocat", authorId: "octocat", id: "c-prev", sentAt: "2026-02-09T21:34:00Z", trust: "peer", body: "the retry-budget question in #42" }],
  });
  const { message } = renderWake(nw, NOW);
  ok(message.includes("the retry-budget question in #42"), "the inherited tail renders in the wake");
  ok(message.indexOf("the retry-budget question in #42") < message.indexOf(trigger.text), "…before this wake's own trigger (oldest-first across the rotation boundary)");

  const cold = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger }), NOW).message;
  ok(!cold.includes("the retry-budget question in #42"), "…and a generation with NO inherited tail renders none of it");
}
{
  const plain = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, trigger }), NOW);
  ok(!plain.message.includes("platform="), "the wake names NO platform (the host routes on the opaque key)");
  ok(!plain.message.includes("Cross-surface disclosure"), "…and carries no disclosure sentence");
  ok(plain.message.includes(`<channel id="${REPO_KEY}" container="repo">`), "the channel carries its opaque key — that is what the host routes on");
}

{
  const wakeId = "wk-abc-123";
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, directMention: true, wakeId });
  const { message } = renderWake(nw, NOW);
  ok(message.includes('addressing="direct-mention"'), "direct-mention renders the ADDRESSED addressing, not channel-watch");
  ok(!message.includes('addressing="channel-watch"'), "direct-mention does NOT carry the ambient addressing");
  ok(message.includes(`<wake reason="channel-activity"`), "direct-mention keeps the full judged envelope, with reason collapsed to channel-activity");
  ok(message.includes(`wake-id="${wakeId}"`), "the wake-id survives in the envelope — the reply tool echoes it (the only reply route on the unified channel)");
  ok(message.includes(`mention="true"`), "the trigger is flagged as a @mention (response-obligation signal)");
  ok(message.includes(`<channel id="${REPO_KEY}" container="repo">`), "the addressed wake carries the opaque channel id and no platform");
  ok(message.includes(UNTRUSTED_OPEN), "the comment body is still untrusted-wrapped by the envelope (W1 holds on the addressed path)");
}
{
  const off = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, engagementTier: "reserved", directMention: false }), NOW);
  const plain = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, engagementTier: "reserved" }), NOW);
  ok(normalizeFenceNonce(off.message) === normalizeFenceNonce(plain.message), "directMention:false renders BYTE-IDENTICAL to the unset channel-watch wake (flag-off invariant)");
  ok(off.message !== plain.message, "…and the two renders carry DIFFERENT fence nonces (per-render, not a constant)");
  ok(normalizeFenceNonce(JSON.stringify(off.context)) === normalizeFenceNonce(JSON.stringify(plain.context)), "directMention:false context is byte-identical too");
  ok(off.message.includes('addressing="channel-watch"'), "the flag-off wake is still the silence-biased channel-watch ambient wake");
}

{
  const engaged = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, engagementTier: "reserved", threadEngaged: true }), NOW).message;
  ok(engaged.includes('follow-up="thread-engaged"'), "🔴 an engaged follow-up renders follow-up=\"thread-engaged\" on the GitHub wake");
  ok(engaged.includes('addressing="channel-watch"'), "…and keeps the channel-watch addressing (enrolment is a different fact from the silence bar)");

  const plain = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, engagementTier: "reserved" }), NOW).message;
  ok(plain.includes("follow-up=") === false, "negative control: a plain ambient comment carries NO follow-up attribute");
  const notEngaged = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, engagementTier: "reserved", threadEngaged: false }), NOW).message;
  ok(normalizeFenceNonce(notEngaged) === normalizeFenceNonce(plain), "negative control: threadEngaged:false renders byte-identical to the unset ambient wake");

  const mentioned = renderWake(buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Retry budget", trigger, directMention: true, threadEngaged: true }), NOW).message;
  ok(mentioned.includes('addressing="direct-mention"'), "an @mention in an engaged issue stays addressed (direct-mention)");
  ok(mentioned.includes("follow-up=") === false, "🔴 …and carries NO follow-up attribute — a mention is owed an answer whatever the enrolment says");
}

{
  const payload = {
    action: "created",
    issue: { number: 42, title: "Flaky retries on cold start" },
    comment: { id: 9001, body: "should we bump the retry budget?", user: { login: "human-dev", type: "User", id: 7 }, author_association: "MEMBER", created_at: "2026-03-24T18:51:00Z" },
    repository: { name: REPO, full_name: `${OWNER}/${REPO}`, id: 555, private: true, owner: { login: OWNER } },
    installation: { id: 4242 },
  } as unknown as Record<string, unknown>;
  const ev = extractGitHubAmbientEvent("issue_comment", payload);
  ok(ev !== null, "issue_comment created -> ambient candidate");
  ok(ev!.owner === OWNER && ev!.repo === REPO && ev!.issueNumber === 42, "extractor reads owner/repo/issue");
  ok(ev!.repoPrivate === true && ev!.installationId === 4242 && ev!.repositoryId === 555, "extractor reads privacy/installation/repo id");
  ok(ev!.comment.authorLogin === "human-dev" && ev!.comment.authorAssociation === "MEMBER" && ev!.comment.id === "9001", "extractor reads the comment author facts");
  ok(ev!.isPullRequest === false, "no issue.pull_request marker -> not a PR timeline comment");
  const prEv = extractGitHubAmbientEvent("issue_comment", { ...payload, issue: { number: 7, title: "t", pull_request: { url: "x" } } });
  ok(prEv !== null && prEv.isPullRequest === true && prEv.issueNumber === 7, "issue.pull_request marker -> PR timeline comment (same number space)");
  ok(extractGitHubAmbientEvent("issue_comment", { ...payload, action: "edited" }) === null, "edited comments are not ambient candidates (v1)");
  ok(extractGitHubAmbientEvent("pull_request_review_comment", payload) === null, "review-thread inline comments are out of ambient scope (v1)");
  ok(extractGitHubAmbientEvent("issues", payload) === null, "non-comment events are not ambient candidates");
  ok(extractGitHubAmbientEvent("issue_comment", { action: "created" }) === null, "a payload missing repo/issue/comment yields null (defensive)");
}

const AUTH: OpenEverywhereGitHubAuth = { authenticator: "github", principalId: "human-dev", principalType: "github-user", attributes: { owner: OWNER, repo: REPO, issue_number: "42" } };
const SURFACE = `github/${OWNER}/${REPO}`;

function dispatch(over: Partial<GitHubSupervisorDispatch> = {}): GitHubSupervisorDispatch {
  return { surfaceKey: SURFACE, owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: TITLE, auth: AUTH, trigger, admit: admissionFunction("wide"), engagementTier: "reserved", ingested: [], ...over };
}

interface WakeCapture { token: string; message: string; context: readonly string[] }

{
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: true, tail: [], };
  const wakes: WakeCapture[] = [];
  const touched: string[] = [];
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async (sk) => { touched.push(sk); },
    wake: async (w) => { wakes.push({ token: w.token, message: w.message, context: w.context }); },
    now: NOW,
  };
  await handleGitHubSupervisorDispatch(dispatch(), deps);
  ok(wakes.length === 1, "dispatch wakes once");
  ok(wakes[0]!.token === githubSupervisorToken(OWNER, REPO, 1), "wake uses the supervisor continuation token (the :oe-sup:g infix)");
  ok(wakes[0]!.message.includes('container="repo"') && wakes[0]!.message.includes('addressing="channel-watch"'), "the delivered message is the repo-supervisor wake");
  ok(touched.length === 1 && touched[0] === SURFACE, "touchSession records the wake on the current generation");
  await handleGitHubSupervisorDispatch(dispatch({ unified: true }), deps);
  ok(normalizeFenceNonce(wakes[1]!.message) === normalizeFenceNonce(wakes[0]!.message), "🔴 a unified dispatch delivers a BYTE-IDENTICAL wake — the platform-blind render names no surface either way");
  ok(!wakes[0]!.message.includes("platform="), "and neither wake carries a platform attribute");

  await handleGitHubSupervisorDispatch(dispatch({ admit: admissionFunction("members-only"), issueTitle: TITLE }), deps);
  const refusedWake = wakes[wakes.length - 1]!;
  ok(refusedWake.context.length === 0, "🔴 a members-only dispatch delivers NO context block — the policy crossed dispatch → builder");
  ok(!refusedWake.message.includes(TITLE), "🔴 …and the refused title reaches neither the context nor the message");
  await handleGitHubSupervisorDispatch(dispatch({ admit: admissionFunction("wide"), issueTitle: TITLE }), deps);
  const admittedWake = wakes[wakes.length - 1]!;
  ok(admittedWake.context.length === 1 && admittedWake.context[0]!.includes(TITLE), "negative control: the SAME dispatch under `wide` delivers the title");

  await handleGitHubSupervisorDispatch(dispatch({ threadEngaged: true }), deps);
  ok(wakes[wakes.length - 1]!.message.includes('follow-up="thread-engaged"'), "🔴 a dispatch with threadEngaged delivers follow-up=\"thread-engaged\"");
  await handleGitHubSupervisorDispatch(dispatch({ threadEngaged: false }), deps);
  ok(wakes[wakes.length - 1]!.message.includes("follow-up=") === false, "negative control: threadEngaged:false delivers no follow-up attribute");
}

{
  const src = readFileSync(fileURLToPath(new URL("../agent/channels/github.ts", import.meta.url)), "utf8");
  ok(src.includes("admit: seatAdmissionFor(surfaceKey)"), "🔴 the live ambient leg passes the domain's admission policy into the supervisor dispatch");
  ok(src.includes("threadEngaged: admission.engagedFollowUp,") && src.includes("addressing: githubWakeAddressing(cls.addressing, admission.engagedFollowUp)"), "🔴 the live ambient leg passes admission.engagedFollowUp to both the wake and the audit row");
  ok(src.includes("catchUp: (req) => seatCatchUp(\"github\", req),"), "🔴 …and the catch-up read passes NO `admit`, so the policy is the shared road's own and the two reads cannot disagree");
  ok(!/seatCatchUp\("github", req, \{[^}]*admit:/u.test(src), "NEGATIVE CONTROL: this leg does not smuggle its own admission policy back in past the shared road");
  ok(src.includes("const wakeId = singleWindow && vouched ? mintWakeId() : undefined"), "the live ambient leg mints the unified wake id once");
  ok(src.includes("window: wakeId") && src.includes("githubDispatchAuditDetail({") && src.includes("commentId: ev.comment.id") && src.includes("wakeId,"), "…and carries that same id beside the exact comment id on github.dispatched");
}

{
  const token = "oe-dom:acme-eng:oe-sup:g1";
  const session: GitHubSupervisorSession = { token, generation: 1, freshGeneration: false, tail: [], };
  const wakeId = "wk-dispatch-1";
  const window = { wakeId, origin: { platform: "github" as const, owner: OWNER, repo: REPO, issueNumber: 42, installationId: 4242 } };
  let captured: { message: string; window: unknown } | undefined;
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    wake: async (w) => { captured = { message: w.message, window: w.window }; },
    now: NOW,
  };
  await handleGitHubSupervisorDispatch(dispatch({ unified: true, directMention: true, window }), deps);
  ok(captured !== undefined, "the single-window direct @mention dispatches a wake");
  ok(captured!.message.includes('addressing="direct-mention"'), "the delivered wake is the ADDRESSED direct-mention wake (not a silence-biased watch)");
  ok(captured!.message.includes(`wake-id="${wakeId}"`), "the delivered wake renders the wake-id (the reply tool's routing key)");
  ok(JSON.stringify(captured!.window) === JSON.stringify(window), "deps.wake receives the window (its wiring diverts into the unified channel + registers the reply-target map)");
}

ok(shouldRotate({ createdAt: NOW(), lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === false, "shouldRotate: a young, low-token generation is NOT rotated");
ok(shouldRotate({ createdAt: NOW(), lastWakeAt: "2026-07-01T00:00:00Z", turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: a stale (quiet-gap) generation rotates");
ok(shouldRotate({ createdAt: "2026-05-01T00:00:00Z", lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: an AGED generation rotates even when just woken (OPE-345 expiry)");

for (const [label, err] of [
  ["a gateway blip", new Error("transient network blip")],
  ["an eve session-limit-shaped error", new Error("SESSION_TOKEN_LIMIT_REACHED")],
] as const) {
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: false, tail: [], };
  let touched = false;
  const wakes: WakeCapture[] = [];
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    touchSession: async () => { touched = true; },
    now: NOW,
    wake: async (w) => { wakes.push({ token: w.token, message: w.message, context: w.context }); throw err; },
  };
  await assert.rejects(() => handleGitHubSupervisorDispatch(dispatch(), deps), /transient network blip|SESSION_TOKEN_LIMIT_REACHED/, `${label} propagates out of the dispatch`);
  passed++;
  ok(wakes.length === 1, `${label}: exactly one wake attempt (no retry, no rotate-and-redeliver)`);
  ok(!touched, `${label}: the session is NOT touched`);
}

{
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { rmSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");

  const dir = join(tmpdir(), `open-everywhere-github-supervisor-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  process.env.GITHUB_APP_SLUG = SLUG;

  (await import("../agent/register.js")).registerGithubProvider();

  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
  const { SessionKey } = await import(abs("dist/src/context/keys.js"));

  const inSession = <T>(fn: () => Promise<T>, attributes?: Record<string, string>): Promise<T> => {
    const c = new ContextContainer();
    const auth = attributes ? { current: { attributes }, initiator: null } : null;
    c.set(SessionKey, { sessionId: "github-supervisor-test", auth, turn: 1, parent: undefined });
    return contextStorage.run(c, fn);
  };

  const githubChannelModule = (await import("../agent/channels/github.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  };

  const { shouldSuppressNativeMention } = await import("../agent/channels/github.js");
  ok(shouldSuppressNativeMention(true, true) === true, "single-window VOUCHED repo -> native mention SUPPRESSED (the unified window answers it instead)");
  ok(shouldSuppressNativeMention(true, false) === false, "single-window UN-VOUCHED repo -> native KEPT (ambient drops mentions there — no gap, no reply lost; fail-closed)");
  ok(shouldSuppressNativeMention(false, true) === false, "NON-single-window repo -> native KEPT (byte-identical: the native mention session engages exactly as today)");
  const turnStarted = (ctx: unknown) => githubChannelModule.adapter["turn.started"]!({}, ctx);
  const completed = (message: string | null, ctx: unknown) =>
    githubChannelModule.adapter["message.completed"]!({ finishReason: "stop", message }, ctx);

  const supervisorState = () => ({
    baseRef: null, baseSha: null, checkoutPath: null, conversationKind: "issue", defaultBranch: null,
    headRef: null, headSha: null, installationId: 4242, issueNumber: null, owner: OWNER,
    pullRequestNumber: null, repo: REPO, repositoryId: 555, reviewCommentId: null,
    reviewThreadRootCommentId: null, triggeringCommentId: null, triggeringUserLogin: null,
    oeSupervisor: true as const,
    oeReplyTarget: undefined as { issueNumber: number } | undefined,
  });

  {
    const state = supervisorState();
    await inSession(() => turnStarted({ state }), { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(state.oeReplyTarget?.issueNumber === 42, "turn.started snapshots the issue_number auth attribute as the reply target");
    await inSession(() => turnStarted({ state }), { owner: OWNER, repo: REPO, pull_request_number: "7" });
    ok(state.oeReplyTarget?.issueNumber === 7, "a PR timeline comment's pull_request_number anchors the SAME endpoint (issues/{n}/comments)");
    await inSession(() => turnStarted({ state }));
    ok(state.oeReplyTarget === undefined, "no auth anchor CLEARS the target (never carry a stale one forward)");
  }

  {
    const state = supervisorState();
    const posts: Array<{ method: string; path: string; body: unknown }> = [];
    const github = { request: async (input: { method: string; path: string; body?: unknown }) => { posts.push({ method: input.method, path: input.path, body: input.body }); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("the retry budget is fine — the flake is the cold-start race", { state, github });
    }, { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(posts.length === 0, "🔴 OPE-811: the supervisor's turn-final text posts NOTHING — completion text is not a delivery channel");
    const { readAudit: readDropped, deploymentOrg } = await import("@open-everywhere/core/agent/adapter-api.js");
    const dropped = (await readDropped({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "github");
    ok(dropped.length === 1, "OPE-811: the dropped prose is audited — one turn.supervisor_prose_dropped row on the github partition");
    ok(dropped[0]!.detail?.chars === "the retry budget is fine — the flake is the cold-start race".length, "OPE-811: the row counts the lost completion (a COUNT, never the text)");
    ok(!JSON.stringify(dropped[0]!.detail).includes("cold-start race"), "OPE-811: taint-clean — the dropped answer's text is not in the row");
    const replied = (await readDropped({ org: deploymentOrg(), action: "github.replied" }));
    ok(replied.length === 0, "OPE-811 negative control: a turn that never called `reply` writes NO github.replied row");
  }

  {
    const state = supervisorState();
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("this must not post", { state, github });
    });
    ok(posts.length === 0, "no per-turn target ⇒ the supervisor posts NOTHING");
    const { readAudit: readNoTarget, deploymentOrg } = await import("@open-everywhere/core/agent/adapter-api.js");
    ok((await readNoTarget({ org: deploymentOrg(), action: "github.no_target" })).length === 0, "OPE-811: the github.no_target row is retired with the poster that needed it");
    const dropped = (await readNoTarget({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.detail?.chars === "this must not post".length);
    ok(dropped.length === 1, "OPE-811: the undelivered completion is recorded as a dropped-prose row instead");
  }

  {
    const state = { ...supervisorState(), oeUnified: true as const, oeReplyTarget: undefined as { issueNumber: number; owner?: string; repo?: string } | undefined };
    const posts: Array<{ path: string }> = [];
    const github = { request: async (input: { path: string }) => { posts.push({ path: input.path }); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("cross-repo answer", { state, github });
    }, { owner: "acme", repo: "payments-api", issue_number: "9" });
    ok(state.oeReplyTarget?.owner === "acme" && state.oeReplyTarget?.repo === "payments-api", "unified turn.started snapshots THIS wake's owner/repo off the delivery auth");
    ok(posts.length === 0, "OPE-811: the unified completion posts nothing either — the snapshot feeds the audit partition, not a poster");
    posts.length = 0;
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("this must not post", { state, github });
    }, { issue_number: "9" });
    ok(state.oeReplyTarget === undefined, "unified path: a wake without owner/repo auth CLEARS the target");
    ok(posts.length === 0, "unified path: cleared target ⇒ posts NOTHING (never the seed repo)");
    const perRepo = supervisorState();
    await inSession(() => turnStarted({ state: perRepo, github }), { owner: "someone", repo: "elsewhere", issue_number: "3" });
    ok(perRepo.oeReplyTarget !== undefined && !("owner" in (perRepo.oeReplyTarget as Record<string, unknown>)), "non-unified snapshot stays {issueNumber} only (byte-identical off)");
  }

  {
    const state = supervisorState();
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    await inSession(async () => {
      await turnStarted({ state, github });
      await completed("NO_REPLY", { state, github });
    }, { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(posts.length === 0, "NO_REPLY suppresses the supervisor reply");
    const { readAudit, deploymentOrg } = await import("@open-everywhere/core/agent/adapter-api.js");
    const silences = await readAudit({ org: deploymentOrg(), action: "github.no_reply" });
    ok(silences.length >= 1, "judged silence writes a github.no_reply audit row (audited silence, Slack/Notion parity)");
  }

  {
    const { markSilentRoutineTurn } = await import("@open-everywhere/core/agent/adapter-api.js");
    const nonSupervisor = { ...supervisorState(), oeSupervisor: undefined, issueNumber: 42 };
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    let threw: unknown = null;
    await inSession(async () => {
      markSilentRoutineTurn();
      try {
        await completed("NO_REPLY", { state: nonSupervisor, github });
      } catch (err) {
        threw = err;
      }
    }, { owner: OWNER, repo: REPO, issue_number: "42" });
    ok(
      posts.length === 0 && threw === null,
      "SILENT routine: a non-supervisor github turn is DROPPED before eve's default poster (else it comments the literal string NO_REPLY)",
    );
  }

  {
    const { readAudit, deploymentOrg } = await import("@open-everywhere/core/agent/adapter-api.js");
    const nativeSilenceRows = async () => (await readAudit({ org: deploymentOrg(), action: "github.no_reply" })).filter((r) => r.detail?.route === "native");
    const nonSupervisor = () => ({ ...supervisorState(), oeSupervisor: undefined, issueNumber: 42 });

    {
      const state = nonSupervisor();
      const posts: unknown[] = [];
      const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
      const before = (await nativeSilenceRows()).length;
      let threw: unknown = null;
      await inSession(async () => {
        try {
          await completed("NO_REPLY", { state, github });
        } catch (err) {
          threw = err;
        }
      }, { owner: OWNER, repo: REPO, issue_number: "42" });
      ok(posts.length === 0 && threw === null, "🔴 OPE-883: a NATIVE turn closing with the NO_REPLY sentinel comments NOTHING (it commented the literal string before)");
      const rows = await nativeSilenceRows();
      ok(rows.length === before + 1, "OPE-883: the suppressed sentinel leaves exactly one github.no_reply row (silence stays observable)");
      const row = rows[0]!;
      ok(row.surface === `github/${OWNER}/${REPO}` && row.detail?.issueNumber === 42, "OPE-883: the silence row names the repo and the issue it went quiet on");
      ok(row.detail?.replied === false, "OPE-883 negative control: `replied` is present and FALSE — this turn delivered nothing at all");
      ok(String(row.detail?.reason).includes("sentinel"), "OPE-883: the row names WHY the turn went quiet (the sentinel), so a reader can tell it from an empty completion");
    }

    {
      const { markRepliedThisTurn, markNoReplyThisTurn } = await import("@open-everywhere/core/agent/adapter-api.js");
      const state = nonSupervisor();
      const posts: unknown[] = [];
      const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
      const before = (await nativeSilenceRows()).length;
      let threw: unknown = null;
      const c = new ContextContainer();
      c.set(SessionKey, { sessionId: "github-supervisor-test", auth: { current: { attributes: { owner: OWNER, repo: REPO, issue_number: "42" } }, initiator: null }, turn: { id: "turn-883" }, parent: undefined });
      await contextStorage.run(c, async () => {
        markRepliedThisTurn("turn-883");
        markNoReplyThisTurn("nothing_to_add");
        try {
          await completed("Done — I posted the summary above.", { state, github });
        } catch (err) {
          threw = err;
        }
      });
      ok(posts.length === 0 && threw === null, "OPE-883: a NATIVE turn that called `no_reply` comments NOTHING, even with trailing narration");
      const rows = await nativeSilenceRows();
      ok(rows.length === before + 1, "OPE-883: the `no_reply` tool route audits its silence too");
      ok(rows[0]!.detail?.replied === true, "OPE-883: `replied` is TRUE when the turn delivered through the reply tool — a different fact from silence after nothing");
      ok(!JSON.stringify(rows[0]!.detail).includes("summary above"), "OPE-883: taint-clean — the dropped narration is not in the row (ids, an enum reason and booleans only)");
    }

    {
      const { readAudit: readPosts, deploymentOrg } = await import("@open-everywhere/core/agent/adapter-api.js");
      const { _resetGitHubInstallationTokenCache } = await import("../agent/channels/github-post-arm.js");
      const { generateKeyPairSync } = await import("node:crypto");
      const replyPostRows = async () => (await readPosts({ org: deploymentOrg(), action: "reply.post" })).filter((r) => r.platform === "github");

      const state = { ...nonSupervisor(), triggeringUserLogin: "octo-reviewer" };
      const posts: unknown[] = [];
      const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
      const before = (await nativeSilenceRows()).length;
      const beforePosts = (await replyPostRows()).length;
      const beforeDrops = (await readPosts({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "github").length;
      const savedEnv = { id: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
      const savedFetch = globalThis.fetch;
      const wrote: string[] = [];
      let threw: unknown = null;
      _resetGitHubInstallationTokenCache();
      try {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
        process.env.GITHUB_APP_ID = "12345";
        process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
        globalThis.fetch = (async (url: string) => {
          const u = String(url);
          if (u.includes("access_tokens")) {
            return new Response(
              JSON.stringify({ token: "ghs_terminal", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: `${OWNER}/${REPO}` }] }),
              { status: 201 },
            );
          }
          wrote.push(u);
          return new Response(JSON.stringify({ id: 987654 }), { status: 201 });
        }) as unknown as typeof fetch;
        await inSession(async () => {
          try {
            await completed("The backfill finished at 04:10 UTC.", { state, github });
          } catch (err) {
            threw = err;
          }
        }, { owner: OWNER, repo: REPO, issue_number: "42" });
      } finally {
        globalThis.fetch = savedFetch;
        if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedEnv.id;
        if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
        _resetGitHubInstallationTokenCache();
      }
      ok(wrote.length === 0, `🔴 OPE-2006: a turn that ends in prose issues NO comment POST from the arm (saw ${JSON.stringify(wrote)}) — the closing text reaches nobody`);
      ok(posts.length === 0, "🔴 OPE-2006: …and eve's default reply-poster is not used either — the delegation went with the choke point, so there is no second door");
      ok(threw === null, `OPE-2006: the drop completes without throwing (saw ${String(threw)})`);
      ok((await replyPostRows()).length === beforePosts, "🔴 OPE-2006: NO reply.post row — that row counts DELIVERED messages, and an answer nobody received must never appear in it");
      const dropRows = (await readPosts({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "github");
      ok(dropRows.length === beforeDrops + 1, `🔴 OPE-2006: exactly ONE drop row records the lost answer (had ${beforeDrops}, now ${dropRows.length})`);
      const row = dropRows[0]!;
      ok(
        row.workspace === OWNER && row.surface === REPO,
        `OPE-2006: the row lands on the partition the reply TOOL's own rows use — workspace=owner, surface=the BARE repo segment (saw ${row.workspace}/${row.surface})`,
      );
      ok(row.detail?.chars === "The backfill finished at 04:10 UTC.".length && row.detail?.issueNumber === 42, "OPE-2006: …carrying the char count and the issue the answer was owed to");
      ok(!JSON.stringify(row.detail).includes("backfill"), "🔴 OPE-2006: …and NOT the model's words — the drop row is taint-clean like every other row on this plane");
      ok(
        row.principalId === "octo-reviewer",
        `🔴 OPE-2006: the row NAMES who the agent was answering (saw ${String(row.principalId)}) — an absent principalId MEANS "the delivery authenticated nobody", so a blank one would make every GitHub native row say something false`,
      );
      ok((await nativeSilenceRows()).length === before, "OPE-2006 negative control: a dropped ANSWER is not a judged silence — the two outcomes stay distinguishable");
    }

    {
      const { _resetGitHubInstallationTokenCache } = await import("../agent/channels/github-post-arm.js");
      const { readAudit: readPosts2, deploymentOrg } = await import("@open-everywhere/core/agent/adapter-api.js");
      const { generateKeyPairSync } = await import("node:crypto");
      const replyPostRows2 = async () => (await readPosts2({ org: deploymentOrg(), action: "reply.post" })).filter((r) => r.platform === "github");
      const state = { ...nonSupervisor(), conversationKind: "review_thread", issueNumber: null, pullRequestNumber: 7, reviewCommentId: 11, triggeringUserLogin: "octo-reviewer" };
      const posts: unknown[] = [];
      const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
      const beforePosts2 = (await replyPostRows2()).length;
      const beforeDrops2 = (await readPosts2({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "github").length;
      const savedEnv = { id: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
      const savedFetch = globalThis.fetch;
      const wrote: string[] = [];
      _resetGitHubInstallationTokenCache();
      try {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
        process.env.GITHUB_APP_ID = "12345";
        process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
        globalThis.fetch = (async (url: string) => {
          const u = String(url);
          if (u.includes("access_tokens")) {
            return new Response(
              JSON.stringify({ token: "ghs_review", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: `${OWNER}/${REPO}` }] }),
              { status: 201 },
            );
          }
          wrote.push(u);
          return new Response(JSON.stringify({ id: 111 }), { status: 201 });
        }) as unknown as typeof fetch;
        await inSession(async () => {
          await completed("Line 12 looks right to me.", { state, github }).catch(() => undefined);
        }, { owner: OWNER, repo: REPO, pull_request_number: "7" });
      } finally {
        globalThis.fetch = savedFetch;
        if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedEnv.id;
        if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
        _resetGitHubInstallationTokenCache();
      }
      ok(wrote.length === 0, `🔴 OPE-2006: a review-thread turn issues NO comment POST from this arm (saw ${JSON.stringify(wrote)}) — its closing prose is dropped like every other seat's`);
      ok(posts.length === 0, "🔴 OPE-2006: …and eve's inline-reply delegation does not run either — that was the last door, and it went with the poster");
      ok((await replyPostRows2()).length === beforePosts2, "OPE-2006: …so no reply.post row, because no byte left at all");
      const reviewDrops = (await readPosts2({ org: deploymentOrg(), action: "turn.supervisor_prose_dropped" })).filter((r) => r.platform === "github");
      ok(reviewDrops.length === beforeDrops2 + 1, `🔴 OPE-2006: …and the drop is still RECORDED on a review thread (had ${beforeDrops2}, now ${reviewDrops.length}) — the placement is what this seat lost, never the record`);
      ok(reviewDrops[0]!.detail?.conversationKind === "review_thread", "OPE-2006: …and the row names the conversation kind, so an operator can count what the review-thread trade costs");
    }
  }

  {
    const state = supervisorState();
    const posts: unknown[] = [];
    const github = { request: async (input: unknown) => { posts.push(input); return { ok: true, status: 201, body: {} }; } };
    await inSession(() => githubChannelModule.adapter["turn.failed"]!({ error: "boom" }, { state, github }));
    ok(posts.length === 0, "a failed supervisor turn posts NO error comment (reserved posture)");
    const { readAudit, deploymentOrg } = await import("@open-everywhere/core/agent/adapter-api.js");
    const fails = await readAudit({ org: deploymentOrg(), action: "github.supervisor_turn_failed" });
    ok(fails.length >= 1, "the failed supervisor turn is audited instead");
  }
}

{
  const ghWake = buildGitHubSupervisorWake({
    owner: OWNER, repo: REPO, issueNumber: 7,
    trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "principal" },
  });
  ok(ghWake.trigger.kind === "message" && ghWake.trigger.message.trust === "principal", "github builder: a resolved trigger trust rides into the wake");
  const ghDirect = buildGitHubSupervisorWake({
    owner: OWNER, repo: REPO, issueNumber: 7, directMention: true, wakeId: "wk_gh_1",
    trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "unauth" },
  });
  ok(ghDirect.trigger.kind === "message" && ghDirect.trigger.message.trust === "unauth", "github builder: a DIRECT-MENTION wake keeps the caller's fail-closed tier — directness never raises it");
  ok(ghDirect.trigger.kind === "message" && ghDirect.trigger.message.mention === true, "github builder: …and directness rides the `mention` flag instead (the negative control on the line above)");
  const directRender = renderWake(ghDirect, NOW).message;
  ok(directRender.includes(UNTRUSTED_OPEN), "github builder: an @mention from an UNVOUCHED author is still FENCED — being addressed is not standing");
  function __ope596GitHubPin(): void {
    void buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm" } });
  }
  void __ope596GitHubPin;
  const memberDirect = renderWake(
    buildGitHubSupervisorWake({
      owner: OWNER, repo: REPO, issueNumber: 7, directMention: true, wakeId: "wk_gh_1",
      trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "peer" },
    }),
    NOW,
  ).message;
  ok(memberDirect.includes(UNTRUSTED_OPEN) === false, "github builder: …and the SAME wake from a member is unfenced — the negative control that proves the fence tracks the tier");
}

{
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: true, tail: [], };
  const auths: OpenEverywhereGitHubAuth[] = [];
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    wake: async (w) => { auths.push(w.auth); },
    now: NOW,
  };
  const attrsOf = (a: OpenEverywhereGitHubAuth): Record<string, unknown> => (a.attributes ?? {}) as Record<string, unknown>;

  _resetSurfacesForTest();

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{ refuted: true }] }), deps);
  ok(attrsOf(auths[0]!)[OE_CHAT_NONMEMBER_ATTR] === "true", "taint carriage: a refuted author stamps oe_chat_nonmember on the auth the wake dep receives");

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{}] }), deps);
  ok(attrsOf(auths[1]!)[OE_CHAT_NONMEMBER_ATTR] === undefined, "taint carriage: an unrefuted author leaves oe_chat_nonmember ABSENT (negative control)");
  ok(auths[1] === AUTH, "taint carriage: an unmarked wake passes the caller's auth BY REFERENCE — byte-identical to before this existed");
  ok(attrsOf(AUTH)[OE_CHAT_NONMEMBER_ATTR] === undefined, "taint carriage: the stamp never mutates the caller's auth");

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [] }), deps);
  ok(auths[2] === AUTH, "taint carriage: an empty ingested set marks nothing (negative control)");

  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{ trust: "relay", refuted: true }] }), deps);
  ok(auths[3] === AUTH, "taint carriage: a `relay` author never marks, even when refuted (negative control — the machine floor)");

  registerSurfaces([defineSurface({ key: SURFACE, trust: "public" })]);
  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{}] }), deps);
  ok(attrsOf(auths[4]!)[OE_CHAT_NONMEMBER_ATTR] === "true", "taint carriage: a repo declared `public` marks through the ROOM leg with no refuted author");
  _resetSurfacesForTest();

  registerSurfaces([defineSurface({ key: SURFACE, trust: "internal" })]);
  await handleGitHubSupervisorDispatch(dispatch({ ingested: [{}] }), deps);
  ok(auths[5] === AUTH, "taint carriage: a repo declared `internal` marks nothing (negative control)");
  _resetSurfacesForTest();
}

console.log(`\n✓ github-supervisor: ${passed} assertions passed`);
