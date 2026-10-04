import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit, resolvePartition } from "@open-everywhere/core/agent/adapter-api.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-github-spend-gate-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.GITHUB_APP_SLUG = "eve-bot";

const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
registerGithubProvider();
const { githubOnComment } = await import("@open-everywhere/provider-github/agent/channels/github.js");

const { recordSpend } = await import("@open-everywhere/core/agent/spend/store.js");
const { periodOf } = await import("@open-everywhere/core/agent/spend/spend.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const provider = await import("@open-everywhere/core/agent/operational/provider.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const { buildGitHubAuth } = await import("@open-everywhere/provider-github/agent/channels/github-identity.js");
const authBindable = (owner: string, repo: string) => ({
  channel: { kind: "github" as const },
  session: { auth: { current: buildGitHubAuth({ owner, repo, actorLogin: "capuser", conversationKind: "issue", issueNumber: 1 }) as unknown as { attributes?: Readonly<Record<string, string>> } } },
});
const overPart = resolvePartition(authBindable("cap-org", "cap-repo") as never);
const okPart = resolvePartition(authBindable("ok-org", "ok-repo") as never);

const comment = (): unknown => ({ body: "@eve-bot please help", author: { login: "capuser", id: 7, type: "User" }, raw: { author_association: "MEMBER" } });
const ctxFor = (owner: string, repo: string, posted: string[]): unknown => ({
  repository: { owner, name: repo, fullName: `${owner}/${repo}`, id: 1, private: true },
  conversation: { kind: "issue", issueNumber: 1, pullRequestNumber: null },
  github: { installationId: 123 },
  sender: { login: "capuser", id: 7, type: "User" },
  thread: { kind: "issue", post: async (t: string) => { posted.push(t); return { id: 1 }; }, react: async () => {} },
});
const drive = async (owner: string, repo: string) => {
  const posted: string[] = [];
  const res = await githubOnComment(ctxFor(owner, repo, posted) as never, comment() as never);
  return { res, posted };
};

registerConfig({
  loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
  loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [],
  loadSpendBudgets: () => ({ perSurface: { [overPart.surfaceKey]: { surfaceMonthlyTokens: 1 } } }),
});
await recordSpend(overPart as never, { period: periodOf(new Date().toISOString()), usage: { inputTokens: 100, outputTokens: 100 } });

const over = await drive("cap-org", "cap-repo");
ok(over.res === null, "spend-gate: an over-budget github mention DECLINES the turn (returns null)");
ok(over.posted.length === 1 && over.posted[0]!.includes(overPart.surfaceKey), "spend-gate: the decline posts a VISIBLE refusal comment naming the surface scope key");
const gateRows = (await readAudit({ org: overPart.org, action: "spend.gate" })).filter((r) => r.detail?.key === overPart.surfaceKey);
ok(gateRows.length === 1 && gateRows[0]!.detail?.door === "mention" && gateRows[0]!.detail?.over === true, "spend-gate: an over-budget github mention writes ONE spend.gate row (door=mention, over=true)");

const under = await drive("ok-org", "ok-repo");
ok(under.res !== null && (under.res as { auth?: unknown }).auth !== undefined, "spend-gate: an under-budget github mention DISPATCHES (returns {auth})");
ok(under.posted.length === 0, "spend-gate: an under-budget github mention posts NO refusal");
ok((await readAudit({ org: okPart.org, action: "spend.gate" })).filter((r) => r.detail?.key === okPart.surfaceKey).length === 0, "spend-gate: an under-budget github mention writes NO spend.gate row");

const live = provider.getOperationalStore();
const broken = { ...live, spendTotals: async () => { throw new Error("store down"); } } as typeof live;
provider.registerOperationalStore(broken);
provider.resetOperationalStore();
const failOpen = await drive("cap-org", "cap-repo");
ok(failOpen.res !== null && (failOpen.res as { auth?: unknown }).auth !== undefined, "spend-gate: a THROWN github budget check fails OPEN (over-budget scope still dispatches)");
provider.registerOperationalStore(live);
provider.resetOperationalStore();

await removeTempDir(dir);
console.log(`\n✓ github-spend-gate: ${n} assertions passed (over-budget decline + refusal + audit, under-budget dispatch, fail-open on throw)`);
