
import assert from "node:assert/strict";
import {
  githubSupervisorToken,
  githubSupervisorSentinel,
  classifyGitHubAmbientComment,
  buildGitHubSupervisorWake,
  handleGitHubSupervisorDispatch,
  shouldRotate,
  type GitHubSupervisorDeps,
  type GitHubSupervisorDispatch,
  type GitHubSupervisorSession,
  type GitHubAmbientComment,
} from "../agent/channels/github-supervisor.js";
import { renderWake } from "../agent/channels/normalized-wake.js";
import type { OpenEverywhereGitHubAuth } from "../agent/channels/github-identity.js";
import { UNTRUSTED_OPEN } from "../agent/access/untrusted.js";

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
const NOW = () => "2026-02-18T14:05:00.000Z";

ok(githubSupervisorSentinel(3) === "oe-sup:g3", "sentinel is oe-sup:g<gen>");
ok(githubSupervisorToken(OWNER, REPO, 1) === `github:${OWNER}/${REPO}:oe-sup:g1`, "token is github:<owner>/<repo>:oe-sup:g<gen>");
ok(githubSupervisorToken(OWNER, REPO, 2).includes(":oe-sup:g"), "token carries the :oe-sup:g infix hooks/spend + the supervisor model role key on");

const base: GitHubAmbientComment = { body: "looks good, shipping this after lunch", authorLogin: "human-dev", authorType: "User", repoPrivate: true };

ok(classifyGitHubAmbientComment(base, SLUG).addressing === "channel-watch", "plain comment on a private repo -> channel-watch (judged)");
ok(classifyGitHubAmbientComment({ ...base, body: `hey @${SLUG} can you review this` }, SLUG).addressing === "drop", "bot @mention -> DROP (owned by the native path — the two legs partition, never overlap)");
ok(classifyGitHubAmbientComment({ ...base, body: `email me at foo@${SLUG}rocks.dev` }, SLUG).addressing === "channel-watch", "an @slug with a trailing word-char is NOT a mention (matches the native gate) -> judged");
ok(classifyGitHubAmbientComment(base, undefined).addressing === "drop", "no bot slug -> DROP (fail-closed loop guard)");
ok(classifyGitHubAmbientComment(base, "  ").addressing === "drop", "blank bot slug -> DROP (fail-closed loop guard)");
ok(classifyGitHubAmbientComment({ ...base, authorType: "Bot", authorLogin: `${SLUG}[bot]` }, SLUG).addressing === "drop", "self-authored ([bot] reply) -> DROP");
ok(classifyGitHubAmbientComment({ ...base, authorType: "Bot", authorLogin: "dependabot[bot]" }, SLUG).addressing === "drop", "other bot-authored -> DROP (bot-to-bot loop guard)");
ok(classifyGitHubAmbientComment({ ...base, authorType: "User", authorLogin: `${SLUG.toUpperCase()}[BOT]` }, SLUG).addressing === "drop", "own login under a mislabelled type still DROPs (belt-and-braces, case-insensitive)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: false }, SLUG).addressing === "drop", "PUBLIC repo -> DROP (no drive-by ambient wakes)");
ok(classifyGitHubAmbientComment({ ...base, repoPrivate: undefined }, SLUG).addressing === "drop", "UNKNOWN repo privacy -> DROP (fail closed)");

const trigger = { id: "ic-42", authorLogin: "human-dev", sentAt: "2026-03-24T18:51:00Z", text: "should we bump the retry budget here?" };
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Flaky retries on cold start", trigger, engagementTier: "reserved" });
  const { message, context } = renderWake(nw, NOW);
  ok(message.startsWith("[channel-watch]"), "wake leads with the judged preamble");
  ok(message.includes("you are this repo's standing session"), "wake uses the REPO container noun");
  ok(message.includes("Calibration for this repo: RESERVED"), "the reserved calibration sentence rides the preamble (GitHub's platform default tier)");
  ok(message.includes(`<channel id="${OWNER}/${REPO}">`), "locus.channel = owner/repo (the silo grain)");
  ok(message.includes(`<thread ts="#42">`), "locus.thread = the issue number (the conversation the comment belongs to)");
  ok(message.includes(`trigger="true"`) && message.includes("should we bump the retry budget here?"), "the comment is the trigger message");
  ok(message.includes(UNTRUSTED_OPEN), "the comment body is untrusted-wrapped by the envelope");
  ok(context !== undefined && context.length === 1 && context[0]!.includes("Flaky retries on cold start"), "the issue title rides an untrusted-wrapped context block");
  ok(context![0]!.includes(UNTRUSTED_OPEN), "the title context is untrusted-wrapped too (payload-supplied text)");
}
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger });
  const { message, context } = renderWake(nw, NOW);
  ok(context === undefined, "no issue title -> no context block");
  ok(!message.includes("Calibration for this"), "no tier -> neutral -> no calibration sentence (byte-identical preamble)");
}
{
  const nw = buildGitHubSupervisorWake({ owner: OWNER, repo: REPO, issueNumber: 7, trigger, handoffNote: "Open asks: the retry-budget question in #42.", handoffFromGeneration: 1 });
  const { message } = renderWake(nw, NOW);
  ok(message.includes("Open asks: the retry-budget question in #42."), "a handoff note renders in the wake");
  ok(message.includes(`from-generation="1"`), "the handoff note is attributed to the outgoing generation");
}

const AUTH: OpenEverywhereGitHubAuth = { authenticator: "github", principalId: "human-dev", principalType: "github-user", attributes: { owner: OWNER, repo: REPO, issue_number: "42" } };
const SURFACE = `github/${OWNER}/${REPO}`;

function dispatch(over: Partial<GitHubSupervisorDispatch> = {}): GitHubSupervisorDispatch {
  return { surfaceKey: SURFACE, owner: OWNER, repo: REPO, issueNumber: 42, issueTitle: "Flaky retries", auth: AUTH, trigger, engagementTier: "reserved", ...over };
}

interface WakeCapture { token: string; message: string; context: readonly string[] }

{
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: true, handoffNote: null };
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
  ok(wakes[0]!.message.includes("you are this repo's standing session"), "the delivered message is the repo-supervisor wake");
  ok(touched.length === 1 && touched[0] === SURFACE, "touchSession records the wake on the current generation");
}

ok(shouldRotate({ lastWakeAt: NOW(), turnCount: 5, inputTokensTotal: 1000 }, NOW()) === false, "shouldRotate: a young, low-token generation is NOT rotated");
ok(shouldRotate({ lastWakeAt: "2026-07-01T00:00:00Z", turnCount: 5, inputTokensTotal: 1000 }, NOW()) === true, "shouldRotate: a stale (quiet-gap) generation rotates");

{
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: false, handoffNote: null };
  const audits: string[] = [];
  let forced = false;
  const wakes: WakeCapture[] = [];
  let first = true;
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    forceRotate: async () => { forced = true; return { token: githubSupervisorToken(OWNER, REPO, 2), generation: 2, handoffNote: "carried over" }; },
    audit: async (a) => { audits.push(a); },
    now: NOW,
    wake: async (w) => {
      if (first) { first = false; throw new Error("SESSION_TOKEN_LIMIT_REACHED"); }
      wakes.push({ token: w.token, message: w.message, context: w.context });
    },
  };
  await handleGitHubSupervisorDispatch(dispatch(), deps);
  ok(forced, "terminal death -> force-rotate to a fresh generation");
  ok(audits.includes("github.session_terminal_death"), "terminal death is audited");
  ok(wakes.length === 1 && wakes[0]!.token === githubSupervisorToken(OWNER, REPO, 2), "the trigger is re-delivered ONCE to the fresh generation (never lost)");
  ok(wakes[0]!.message.includes("carried over"), "the re-delivered wake carries the fresh generation's handoff note");
}

{
  const session: GitHubSupervisorSession = { token: githubSupervisorToken(OWNER, REPO, 1), generation: 1, freshGeneration: false, handoffNote: null };
  const deps: GitHubSupervisorDeps = {
    getOrCreateSession: async () => session,
    forceRotate: async () => { throw new Error("should not be called"); },
    now: NOW,
    wake: async () => { throw new Error("transient network blip"); },
  };
  await assert.rejects(() => handleGitHubSupervisorDispatch(dispatch(), deps), /transient network blip/, "a transient (non-terminal) wake error propagates");
  passed++;
}

console.log(`\n✓ github-supervisor: ${passed} assertions passed`);
