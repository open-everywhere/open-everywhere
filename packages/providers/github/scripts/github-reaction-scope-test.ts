import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-github-scope-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.OE_TELEMETRY = "off";

const { deploymentOrg, getOperationalStore, markThreadEngaged, readAudit, registerOperationalStore, resetOperationalStore } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);
const {
  auditGitHubReactionClaimUnreadable,
  GITHUB_POSTED_MARK_TIMEOUT_MS,
  GITHUB_REACTION_CLAIM_UNREADABLE_ACTION,
  GITHUB_REACTION_POLL_BUDGET_ACTION,
  githubConversationInScope,
  githubPollBudgetKey,
  markGitHubConversationPosted,
  spendGitHubPollBudget,
} = await import("../agent/channels/github-reaction-scope.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const OWNER = "acme";
const REPO = "widgets";
const SURFACE = `github/${OWNER}/${REPO}`;
const HOUR = "2026-09-08T04:00:00.000Z";
const NEXT_HOUR = "2026-09-08T05:00:00.000Z";

{
  ok(!(await githubConversationInScope(SURFACE, OWNER, REPO, 1)), "🔴 a conversation with no post claim and no engagement row is OUT of scope");

  await markGitHubConversationPosted(OWNER, REPO, 2, HOUR);
  ok(await githubConversationInScope(SURFACE, OWNER, REPO, 2), "a conversation this bundle's reply path posted in is in scope");
  ok(!(await githubConversationInScope(SURFACE, OWNER, REPO, 3)), "negative control: the claim is per CONVERSATION — its neighbour is still out");

  await markThreadEngaged({ org: deploymentOrg(), surfaceKey: SURFACE } as Parameters<typeof markThreadEngaged>[0], `${OWNER}/${REPO}#4`, HOUR, { participating: true });
  ok(await githubConversationInScope(SURFACE, OWNER, REPO, 4), "🔴 a container an @mention engaged is in scope with NO post claim — the framework's own replies are covered");
  ok(!(await getOperationalStore().noticeClaimed(deploymentOrg(), "github-posted:acme/widgets#4")), "…and it really held no post claim, so the admission came from the engagement row");

  ok(await githubConversationInScope(SURFACE, OWNER, REPO, undefined), "a delivery naming no container is admitted — the arm's parse is what refuses it");
}

{
  const BUDGET = 3;
  const verdicts: boolean[] = [];
  for (let i = 0; i < BUDGET + 2; i++) verdicts.push((await spendGitHubPollBudget(OWNER, REPO, HOUR, BUDGET)).admitted);
  ok(verdicts.slice(0, BUDGET).every((v) => v), `the first ${BUDGET} polls of the hour are admitted`);
  ok(verdicts.slice(BUDGET).every((v) => !v), "🔴 …and every poll after the budget is refused");

  const counted = await spendGitHubPollBudget(OWNER, REPO, HOUR, BUDGET);
  ok(counted.polls === BUDGET, `the refusal reports the count it refused against (${counted.polls})`);

  ok((await spendGitHubPollBudget(OWNER, REPO, NEXT_HOUR, BUDGET)).admitted, "the next clock hour starts fresh");
  ok((await spendGitHubPollBudget(OWNER, "other-repo", HOUR, BUDGET)).admitted, "another repository in the same hour starts fresh");

  const rows = await readAudit({ org: deploymentOrg(), action: GITHUB_REACTION_POLL_BUDGET_ACTION });
  const mine = rows.filter((r) => r.surface === SURFACE);
  ok(mine.length === 1, `🔴 a tripped budget writes ONE row per repository per hour (got ${mine.length})`);
  const detail = mine[0]!.detail as Record<string, unknown>;
  ok(detail["budget"] === BUDGET && detail["polls"] === BUDGET, "…naming the budget it tripped and the count it stood at");
  ok(detail["hour"] === HOUR.slice(0, 13), "…and the clock hour, which is what an operator counts these by");
  ok(mine[0]!.workspace === OWNER, "…on the repo owner's workspace, so the control-plane read scopes it like every other github row");

  ok(!rows.some((r) => r.surface === `github/${OWNER}/other-repo`), "negative control: an admitted poll writes no budget row");

  ok(githubPollBudgetKey(OWNER, REPO, HOUR) !== githubPollBudgetKey(OWNER, REPO, NEXT_HOUR), "the budget key separates clock hours");
  ok(githubPollBudgetKey(OWNER, REPO, HOUR) !== githubPollBudgetKey(OWNER, "other-repo", HOUR), "…and repositories");
}

{
  const real = getOperationalStore();
  const broken = {
    ...real,
    noticeClaimed: async (): Promise<boolean> => {
      throw new Error("store down");
    },
    getEngagement: async (): Promise<null> => {
      throw new Error("store down");
    },
    getTaskResult: async (): Promise<null> => {
      throw new Error("store down");
    },
  };
  registerOperationalStore(broken as unknown as typeof real);
  resetOperationalStore();
  try {
    let reached = false;
    await getOperationalStore()
      .noticeClaimed("x", "y")
      .then(
        () => undefined,
        () => {
          reached = true;
        },
      );
    ok(reached, "(precondition) the throwing store is the one the gates now resolve");

    ok(await githubConversationInScope(SURFACE, OWNER, REPO, 99), "🔴 gate 1 FAILS OPEN — an unreadable store admits the poll");
    const verdict = await spendGitHubPollBudget(OWNER, REPO, HOUR, 1);
    ok(verdict.admitted, "🔴 gate 2 FAILS OPEN — an unreadable counter admits the poll");
    ok(verdict.polls === 0, "…and reports no count, because it read none");
  } finally {
    registerOperationalStore(real);
    resetOperationalStore();
  }
}

{
  const real = getOperationalStore();
  const stuck = {
    ...real,
    claimNotice: (): Promise<boolean> => new Promise<boolean>(() => undefined),
  };
  registerOperationalStore(stuck as unknown as typeof real);
  resetOperationalStore();
  try {
    let settled = false;
    void getOperationalStore()
      .claimNotice("x", "y", HOUR)
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok(!settled, "(precondition) the never-resolving store is the one the mark now writes through");

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const verdict = await Promise.race([
      markGitHubConversationPosted(OWNER, REPO, 77, HOUR).then(() => "returned" as const),
      new Promise<"hung">((resolve) => {
        deadline = setTimeout(() => resolve("hung"), GITHUB_POSTED_MARK_TIMEOUT_MS * 3);
      }),
    ]);
    const held = Date.now() - started;
    clearTimeout(deadline);
    ok(verdict === "returned", `🔴 a never-resolving claim store does NOT hold the mark open — the reply tool returns (verdict: ${verdict})`);
    ok(held >= GITHUB_POSTED_MARK_TIMEOUT_MS - 50, "…having actually waited for the ceiling, so the bound is the race and not an early throw");
  } finally {
    registerOperationalStore(real);
    resetOperationalStore();
  }
}

{
  await auditGitHubReactionClaimUnreadable(OWNER, REPO, HOUR, 3);
  const rows = (await readAudit({ org: deploymentOrg(), action: GITHUB_REACTION_CLAIM_UNREADABLE_ACTION })).filter((r) => r.surface === SURFACE);
  ok(rows.length === 1, `the unreadable-claim write lands one queryable row (got ${rows.length})`);
  const detail = rows[0]!.detail as Record<string, unknown>;
  ok(detail["skipped"] === 3, "…naming how many reactions the fail-closed dedupe skipped");
  ok(detail["hour"] === HOUR.slice(0, 13), "…and the clock hour, so an operator counts these the way they count budget trips");
  ok(rows[0]!.workspace === OWNER, "…on the repo owner's workspace, like every other github row");
}

await removeTempDir(dir);
console.log(`✓ github reaction-poll scope: ${n} assertions`);
