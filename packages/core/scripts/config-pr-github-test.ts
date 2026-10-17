import assert from "node:assert/strict";
import type { PrFetchFn } from "../agent/scm/pr.js";

const { makeGitHubConfigPrProvider } = await import("../agent/credentials/config-pr-github.js");
const { resetGitHubApp } = await import("../agent/scm/provider.js");
const { overrideSettingsForTest, resetSettingsForTest } = await import("../agent/settings/settings.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejectsWith(fn: () => Promise<unknown>, fragment: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not reject)`);
}

const PR_URL = "https://github.com/acme/config/pull/11";
const OPTS = { repo: "acme/config", head: "credential-binding/acme-key", base: "main", title: "Bind credential: acme/key → db", body: "ref db:acme:key", token: "tok" };

interface PrState {
  prState: "new" | "open-exists" | "closed-exists";
  posts: { title: string; body: string; head: string; base: string }[];
  gets: number;
  patched: { number: number; body: string }[];
  createFails?: boolean;
}
function prFetch(state: PrState): PrFetchFn {
  return async (url, init) => {
    if (init.method === "POST" && url.endsWith("/pulls")) {
      const b = JSON.parse(init.body!) as { title: string; body: string; head: string; base: string };
      state.posts.push(b);
      if (state.createFails) return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
      if (state.prState === "new") {
        return { ok: true, status: 201, text: async () => "", json: async () => ({ html_url: PR_URL, number: 11 }) };
      }
      return { ok: false, status: 422, text: async () => "A pull request already exists for acme:...", json: async () => ({}) };
    }
    if (init.method === "GET" && url.includes("/pulls?head=")) {
      state.gets++;
      ok(url.includes("state=all"), "openOrReopenPr GET looks across ALL states (not just open)");
      const st = state.prState === "closed-exists" ? "closed" : "open";
      return { ok: true, status: 200, text: async () => "", json: async () => [{ html_url: PR_URL, number: 11, state: st }] };
    }
    if (init.method === "PATCH" && /\/pulls\/\d+$/.test(url)) {
      const b = JSON.parse(init.body!) as { state: string; body: string };
      state.patched.push({ number: 11, body: b.body });
      return { ok: true, status: 200, text: async () => "", json: async () => ({ html_url: PR_URL, number: 11 }) };
    }
    throw new Error(`unexpected fetch ${init.method} ${url}`);
  };
}

{
  const state: PrState = { prState: "new", posts: [], gets: 0, patched: [] };
  const provider = makeGitHubConfigPrProvider({ prFetch: prFetch(state) });
  const out = await provider.openOrReopenPr(OPTS);
  ok(out.url === PR_URL && out.number === 11 && out.updated === false && out.reopened === false, "new: POST-creates the PR (updated:false, reopened:false)");
  ok(state.posts.length === 1 && state.posts[0].head === OPTS.head && state.posts[0].base === "main" && state.gets === 0 && state.patched.length === 0, "new: one POST, no GET/PATCH");
}

{
  const state: PrState = { prState: "open-exists", posts: [], gets: 0, patched: [] };
  const provider = makeGitHubConfigPrProvider({ prFetch: prFetch(state) });
  const out = await provider.openOrReopenPr(OPTS);
  ok(out.updated === true && out.reopened === false, "open-exists: 422 resolves to updated:true, reopened:false");
  ok(state.gets === 1 && state.patched.length === 0, "open-exists: looked up the PR, did NOT patch");
}

{
  const state: PrState = { prState: "closed-exists", posts: [], gets: 0, patched: [] };
  const provider = makeGitHubConfigPrProvider({ prFetch: prFetch(state) });
  const out = await provider.openOrReopenPr(OPTS);
  ok(out.updated === true && out.reopened === true, "closed-exists: reopened:true");
  ok(state.patched.length === 1 && state.patched[0].number === 11 && state.patched[0].body === OPTS.body, "closed-exists: PATCHed state=open with the refreshed body");
}

{
  const state: PrState = { prState: "new", posts: [], gets: 0, patched: [], createFails: true };
  const provider = makeGitHubConfigPrProvider({ prFetch: prFetch(state) });
  await rejectsWith(() => provider.openOrReopenPr(OPTS), "github binding PR create failed: 500", "create failure (non-422) throws loud");
}

{
  const savedApp = process.env.OE_GITHUB_APP_ID;
  const savedTok = process.env.GITHUB_TOKEN;
  delete process.env.OE_GITHUB_APP_ID;
  resetGitHubApp();
  const provider = makeGitHubConfigPrProvider();

  process.env.GITHUB_TOKEN = "ghp_test_pat";
  resetGitHubApp();
  await rejectsWith(() => provider.resolveWriteToken("acme/config"), "GITHUB_TOKEN is set, but this deployment signs in with the GitHub App", "resolveWriteToken: 🔴 app mode never falls back to the GITHUB_TOKEN personal access token");

  overrideSettingsForTest({ github: { auth: "token", tokenRepos: ["acme/config"] } });
  ok((await provider.resolveWriteToken("acme/config")) === "ghp_test_pat", "resolveWriteToken: token mode returns the personal access token for a repository it reaches");
  await rejectsWith(() => provider.resolveWriteToken("acme/other"), "the personal access token does not reach acme/other", "resolveWriteToken: 🔴 token mode refuses a repository the token does not reach");

  delete process.env.GITHUB_TOKEN;
  await rejectsWith(() => provider.resolveWriteToken("acme/config"), "no GitHub credential for the config repo", "resolveWriteToken: token mode fails loud with no token set");
  resetSettingsForTest();
  resetGitHubApp();
  await rejectsWith(() => provider.resolveWriteToken("acme/config"), "no GitHub credential for the config repo", "resolveWriteToken: app mode fails loud when neither App nor token is present");

  if (savedApp !== undefined) process.env.OE_GITHUB_APP_ID = savedApp;
  if (savedTok !== undefined) process.env.GITHUB_TOKEN = savedTok;
  else delete process.env.GITHUB_TOKEN;
  resetGitHubApp();
}

{
  const calls: string[] = [];
  const provider = makeGitHubConfigPrProvider({
    getBranchSha: async ({ branch }) => {
      calls.push(`getBranchSha:${branch}`);
      return branch === "main" ? "base-sha" : null;
    },
    createBranch: async ({ branch, sha }) => {
      calls.push(`createBranch:${branch}:${sha}`);
      return "created" as const;
    },
    contents: {
      getFile: async (_repo: string, path: string, branch: string) => {
        calls.push(`getFile:${branch}:${path}`);
        return { content: "x", sha: "s1" };
      },
      putFile: async (_repo: string, path: string, _content: string, _msg: string, branch: string) => {
        calls.push(`putFile:${branch}:${path}`);
        return "commit-sha";
      },
    },
    committer: () => ({ name: "bot", email: "bot@x" }),
  });

  ok((await provider.getBranchSha({ repo: "acme/config", branch: "main", token: "t" })) === "base-sha", "getBranchSha delegates to scm/refs");
  await provider.ensureBranch({ repo: "acme/config", branch: "feature", sha: "base-sha", token: "t" });
  const file = await provider.getFile({ repo: "acme/config", path: "p.json", branch: "feature", token: "t" });
  ok(file?.content === "x" && file.sha === "s1", "getFile delegates to scm/contents and returns {content, sha}");
  await provider.putFile({ repo: "acme/config", path: "p.json", content: "y", message: "m", branch: "feature", token: "t", committer: provider.committer() });
  ok(
    calls.includes("getBranchSha:main") && calls.includes("createBranch:feature:base-sha") && calls.includes("getFile:feature:p.json") && calls.includes("putFile:feature:p.json"),
    "all four file/branch ops delegate to the injected scm seams",
  );
  ok(provider.committer().name === "bot", "committer resolves the injected identity");
}

assert.ok(passed > 0);
console.log(`✓ config-pr-github: ${passed} assertions passed`);
