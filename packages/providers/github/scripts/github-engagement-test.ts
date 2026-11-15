import assert from "node:assert/strict";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
registerGithubProvider();
import {
  githubEngagedAdmits,
  githubEngagedFollowUpReach,
  githubEngagementAnchor,
  githubMachineAuthored,
  githubSeamPartition,
  markGitHubEngaged,
  resolveGitHubEngagement,
  type GitHubEngagementDeps,
  type GitHubSeamFacts,
} from "../agent/channels/github-engagement.js";
import type { EngagementRow, Partition } from "@open-everywhere/core/agent/adapter-api.js";

import { tmpdir as __oeTmpdir } from "node:os";
import { join as __oeJoin } from "node:path";
import { rmSync as __oeRmSync } from "node:fs";
const __oeSuiteStoreDir = __oeJoin(__oeTmpdir(), `open-everywhere-suite-github-engagement-${process.pid}`);
__oeRmSync(__oeSuiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __oeJoin(__oeSuiteStoreDir, "ops.sqlite3");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const FACTS: GitHubSeamFacts = {
  owner: "acme",
  repo: "widgets",
  number: 42,
  isPrivate: true,
  actorLogin: "dev1",
  isMention: false,
  authorIsBot: false,
  conversationKind: "issue",
};

function stubDeps(row: EngagementRow | null): GitHubEngagementDeps & { reads: string[]; writes: { key: string; at: string }[]; seen: string[] } {
  const reads: string[] = [];
  const writes: { key: string; at: string }[] = [];
  const seen: string[] = [];
  return {
    reads,
    writes,
    seen,
    getEngagement: async (_p: Partition, key: string) => {
      reads.push(key);
      return row;
    },
    markEngaged: async (_p: Partition, key: string, atIso: string) => {
      writes.push({ key, at: atIso });
    },
    markEventSeen: async (_org: string, key: string) => {
      const first = !seen.includes(key);
      seen.push(key);
      return first;
    },
    now: () => "2026-05-12T11:30:00.000Z",
  };
}

const engagedRow = (over: Partial<EngagementRow> = {}): EngagementRow => ({
  org: "oe",
  surfaceKey: "github/acme/widgets",
  threadTs: "acme/widgets#42",
  engagedAt: "2026-09-07T10:00:00.000Z",
  lastTurnAt: "2026-09-07T11:00:00.000Z",
  participating: true,
  silentStreak: 0,
  stopped: false,
  kind: "thread" as const,
  ...over,
});

ok(githubEngagementAnchor("acme", "widgets", 42) === "acme/widgets#42", "1a: the anchor is the container key `owner/repo#N`");
ok(githubEngagementAnchor("acme", "widgets", undefined) === undefined, "1b: NEGATIVE CONTROL — no container number, no anchor (a partial key would collide across issues)");
ok(githubEngagementAnchor(undefined, "widgets", 42) === undefined, "1c: NEGATIVE CONTROL — no owner, no anchor");
ok(githubEngagementAnchor("acme", undefined, 42) === undefined, "1d: NEGATIVE CONTROL — no repo, no anchor");
ok(githubEngagementAnchor("acme", "widgets", 43) !== githubEngagementAnchor("acme", "widgets", 42), "1e: two containers in one repo get two anchors — engagement is per issue, never per repo");

{
  const p = githubSeamPartition(FACTS);
  ok(p !== null && p.surfaceKey === "github/acme/widgets", "1f: the partition is the REPO grain — the same key `resolvePartition` gives a bound GitHub turn, which is what `stand_down` writes under");
  ok(p !== null && p.platform === "github", "1g: …on the github platform");
}

ok(githubMachineAuthored("someone", "User", "oe-app") === false, "2a: a person's comment is not machine-authored");
ok(githubMachineAuthored("oe-app[bot]", "Bot", "oe-app") === true, "2b: the app's OWN reply is — this is what stops an engaged issue looping on itself");
ok(githubMachineAuthored("OE-APP[BOT]", "User", "oe-app") === true, "2c: …matched case-insensitively, because GitHub does not normalise a login's case for us");
ok(githubMachineAuthored("dependabot[bot]", "Bot", "oe-app") === true, "2d: any Bot actor is machine-authored — a foreign bot must not wake an engaged issue either");
ok(githubMachineAuthored("someone", "User", undefined) === true, "🔴 2e: with NO app slug configured the answer is machine-authored — the app cannot tell its own reply from a person's, so it delivers nothing (fail closed)");
ok(githubMachineAuthored("someone", "User", "   ") === true, "2f: …and a blank slug is the same as none");

{
  const deps = stubDeps(null);
  const v = await resolveGitHubEngagement({ ...FACTS, isMention: true }, deps);
  ok(v.kind === "engage", "3a: an @mention resolves ENGAGE — the caller marks, and its own path answers the mention");
  ok(deps.reads.length === 0, "🔴 3b: …and pays NO registry read, because the mention is settled before any I/O");
}

{
  const deps = stubDeps(null);
  const v = await resolveGitHubEngagement(FACTS, deps);
  ok(v.kind === "hold" && v.stopped === false, "3c: a plain comment on an UN-ENGAGED issue HOLDS, and not as a stop — the caller keeps today's path");
  ok(deps.reads[0] === "acme/widgets#42", "3d: …after reading exactly the anchor the mapper publishes");
  ok(deps.reads.length === 1, "3e: …and reading it ONCE — the row carries both facts, and two reads could disagree");
}

{
  const v = await resolveGitHubEngagement(FACTS, stubDeps(engagedRow()));
  ok(v.kind === "deliver", "🔴 3f: a plain comment on an ENGAGED issue DELIVERS — this is the whole seam");
}

{
  const v = await resolveGitHubEngagement(FACTS, stubDeps(engagedRow({ stopped: true })));
  ok(v.kind === "hold" && v.stopped === true, "🔴 3g: …unless the agent was asked to stand down there, which HOLDS with `stopped: true`");
}

{
  const v = await resolveGitHubEngagement({ ...FACTS, isMention: true }, stubDeps(engagedRow({ stopped: true })));
  ok(v.kind === "engage", "🔴 3h: an @mention in a STOOD-DOWN issue still resolves ENGAGE — the mark is the re-invitation, and it is what lifts the flag");
}

{
  const v = await resolveGitHubEngagement({ ...FACTS, authorIsBot: true }, stubDeps(engagedRow()));
  ok(v.kind === "hold" && v.stopped === false, "🔴 3i: a BOT's comment in an engaged issue never delivers — the loop guard outranks engagement");
}

{
  const v = await resolveGitHubEngagement({ ...FACTS, number: undefined }, stubDeps(engagedRow()));
  ok(v.kind === "unanchored", "3j: a delivery naming no container is UNANCHORED even with a row present — there is nothing to address");
}

ok((await githubEngagedAdmits({ ...FACTS, isMention: true }, stubDeps(null))) === true, "4a: the gate admits an @mention without consulting the registry");
ok((await githubEngagedAdmits(FACTS, stubDeps(engagedRow()))) === true, "🔴 4b: …and admits a plain comment in an engaged issue, which is what turns a follow-up into a turn");
ok((await githubEngagedAdmits(FACTS, stubDeps(null))) === false, "🔴 4c: NEGATIVE CONTROL — it refuses a plain comment in an un-engaged issue, so the seam did not simply open the gate");
ok((await githubEngagedAdmits(FACTS, stubDeps(engagedRow({ stopped: true })))) === false, "🔴 4d: NEGATIVE CONTROL — and refuses one in a stood-down issue");
ok((await githubEngagedAdmits({ ...FACTS, authorIsBot: true }, stubDeps(engagedRow()))) === false, "4e: NEGATIVE CONTROL — and refuses the app's own comment");

ok(githubEngagedFollowUpReach(FACTS).reachable === true, "4f: a private-repo issue comment is reachable — the baseline every refusal below differs from by one input");
ok(githubEngagedFollowUpReach({ ...FACTS, isPrivate: false }).reachable === false, "🔴 4g: a PUBLIC repo is not — an uninvited native turn (sandbox checkout, judged spend) is private-repo only");
ok(githubEngagedFollowUpReach({ ...FACTS, isPrivate: undefined }).reachable === false, "🔴 4h: UNKNOWN privacy is not either — the floor is `private === true`, so it fails closed");
ok(githubEngagedFollowUpReach({ ...FACTS, conversationKind: "review_thread" }).reachable === false, "🔴 4i: an INLINE REVIEW comment is not — the anchor collapses to `owner/repo#N`, so a review thread shares its pull request's row");
ok(githubEngagedFollowUpReach({ ...FACTS, conversationKind: "pull_request" }).reachable === true, "🔴 4j: NEGATIVE CONTROL — a pull-request TIMELINE comment still is, so the refusal is about the review thread and not about pull requests");

{
  const pub = stubDeps(engagedRow());
  ok((await githubEngagedAdmits({ ...FACTS, isPrivate: false }, pub)) === false, "🔴 4k: the GATE refuses a plain comment in an ENGAGED container on a public repo — the floor is wired, not merely exported");
  ok(pub.reads.length === 0, "4l: …and paid NO registry read doing it, so the floor sits above the read");
  const rev = stubDeps(engagedRow());
  ok((await githubEngagedAdmits({ ...FACTS, conversationKind: "review_thread" }, rev)) === false, "🔴 4m: and refuses an inline review comment in the SAME engaged container");
  ok((await githubEngagedAdmits({ ...FACTS, isPrivate: false, isMention: true }, stubDeps(null))) === true, "🔴 4n: NEGATIVE CONTROL — an @MENTION is admitted on a public repo and in a review thread alike, because it never reaches this arm");
  ok((await githubEngagedAdmits({ ...FACTS, conversationKind: "review_thread", isMention: true }, stubDeps(null))) === true, "4o: …the review-thread half of the same control");
}

{
  const deps = stubDeps(null);
  const anchor = await markGitHubEngaged({ ...FACTS, isMention: true }, 9001, deps);
  ok(anchor === "acme/widgets#42", "5a: the mark returns the anchor it wrote");
  ok(deps.writes.length === 1 && deps.writes[0]!.key === "acme/widgets#42", "5b: …and writes exactly that key, so the mark and the read address one row");
  ok(deps.writes[0]!.at === "2026-05-12T11:30:00.000Z", "5c: …stamped with the injected clock");
}

{
  const deps = stubDeps(null);
  await markGitHubEngaged({ ...FACTS, isMention: true }, 9001, deps);
  await markGitHubEngaged({ ...FACTS, isMention: true }, 9001, deps);
  ok(deps.writes.length === 1, "🔴 5d: a REDELIVERED comment marks NOTHING the second time — the guard keys on the comment id");
  ok(deps.seen.filter((k) => k === "github-engage:acme/widgets#42:9001").length === 2, "5e: …and it asked the once-guard both times, so the dedupe is what refused rather than a missing call");
}

{
  const deps = stubDeps(null);
  await markGitHubEngaged({ ...FACTS, isMention: true }, 9001, deps);
  await markGitHubEngaged({ ...FACTS, isMention: true }, 9002, deps);
  ok(deps.writes.length === 2, "🔴 5f: NEGATIVE CONTROL — a SECOND, different comment marks again, so the guard is per comment and a real re-invitation still lands");
}

{
  const deps = stubDeps(null);
  await markGitHubEngaged({ ...FACTS, isMention: true, number: undefined }, 9001, deps);
  ok(deps.writes.length === 0, "5g: an unanchored delivery writes nothing");
}

{
  const deps = { ...stubDeps(null), markEventSeen: async () => true };
  const writes: string[] = [];
  const anchor = await markGitHubEngaged({ ...FACTS, isMention: true }, 9001, {
    ...deps,
    markEngaged: async (_p: Partition, key: string) => {
      writes.push(key);
    },
  });
  ok(
    anchor === "acme/widgets#42" && writes.length === 1,
    "5h: a guard that answers 'not seen' MARKS — the polarity, pinned. The store-error fail-open in `liveMarkEngageSeen` is unreached by any offline test",
  );
}

console.log(
  `✓ github-engagement: ${n} assertions passed (anchor derivation + author gate + the decision table with a negative control on every boolean + the native admission + its two reach floors + the mark's redelivery guard)`,
);
