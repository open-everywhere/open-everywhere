import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-issue-actions-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const {
  parseGithubEntityId,
  setGithubIssueState,
  assignGithubIssue,
  addGithubIssueLabel,
  githubEntityAdapter,
} = await import("../agent/scm/issue-actions.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
type BindableContext = import("../agent/identity/binding.js").BindableContext;

registerConfig({
  loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/web"] })],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (status >= 200 && status < 300 ? "" : `boom ${status}`),
      json: async () => ({}),
    };
  }) as unknown as import("../agent/scm/pr.js").PrFetchFn;
  return { fetchFn, calls };
}

const resolveToken = async () => "test-token";

{
  ok(JSON.stringify(parseGithubEntityId("acme/web#42")) === JSON.stringify({ repo: "acme/web", number: 42 }), "parses owner/repo#123");
  assert.throws(() => parseGithubEntityId("not-a-valid-id"), /invalid GitHub entity id/, "a malformed id refuses (never silently targets the wrong issue)");
  n++;
  assert.throws(() => parseGithubEntityId("acme/web"), /invalid GitHub entity id/, "missing #number refuses");
  n++;
}

{
  const { fetchFn, calls } = fakeFetch();
  const outcome = await setGithubIssueState("acme/web#42", "Closed", { fetchFn, resolveToken });
  ok(outcome.includes("acme/web#42") && outcome.includes('"closed"'), `outcome names repo#number + the normalized state (${outcome})`);
  ok(calls.length === 1 && calls[0].method === "PATCH" && calls[0].url.endsWith("/repos/acme/web/issues/42"), "PATCHes the issue endpoint");
  ok((calls[0].body as { state: string }).state === "closed", "body carries the normalized state");
}
{
  const { fetchFn, calls } = fakeFetch();
  await assert.rejects(() => setGithubIssueState("acme/web#42", "in-review", { fetchFn, resolveToken }), /must be "open" or "closed"/, "an invalid state value refuses input validation");
  n++;
  ok(calls.length === 0, "the invalid-state refusal never reaches the network");
}
{
  const { fetchFn } = fakeFetch(422);
  await assert.rejects(() => setGithubIssueState("acme/web#42", "open", { fetchFn, resolveToken }), /GitHub issue action failed for acme\/web#42.*422/s, "a non-2xx response surfaces as a real error naming repo#number");
  n++;
}

{
  const { fetchFn, calls } = fakeFetch();
  const outcome = await assignGithubIssue("acme/web#42", "octocat", { fetchFn, resolveToken });
  ok(outcome.includes("octocat") && outcome.includes("acme/web#42"), "outcome names repo#number + assignee");
  ok(calls[0].method === "POST" && calls[0].url.endsWith("/issues/42/assignees"), "POSTs the assignees endpoint");
  ok(JSON.stringify((calls[0].body as { assignees: string[] }).assignees) === JSON.stringify(["octocat"]), "body carries the assignee as a one-element array (additive)");
}

{
  const { fetchFn, calls } = fakeFetch();
  const outcome = await addGithubIssueLabel("acme/web#7", "needs-triage", { fetchFn, resolveToken });
  ok(outcome.includes("needs-triage") && outcome.includes("acme/web#7"), "outcome names the label + repo#number");
  ok(calls[0].method === "POST" && calls[0].url.endsWith("/issues/7/labels"), "POSTs the labels endpoint");
  ok(JSON.stringify((calls[0].body as { labels: string[] }).labels) === JSON.stringify(["needs-triage"]), "body carries the label as a one-element array (additive)");
}

{
  const ctx = (attrs: Record<string, unknown>): BindableContext => ({ channel: { kind: "slack" }, session: { auth: { current: { attributes: attrs } } } }) as unknown as BindableContext;
  ok(typeof githubEntityAdapter.checkAccess === "function", "github declares checkAccess (a GitHub-specific access dimension)");
  githubEntityAdapter.checkAccess!(ctx({}), "acme/web#42", []);
  ok(true, "a granted repo's checkAccess passes silently");
  assert.throws(() => githubEntityAdapter.checkAccess!(ctx({}), "evil/repo#1", []), /not granted to this channel/, "an ungranted repo refuses (fail-closed, same as checkout_repo/open_pull_request)");
  n++;
}

{
  ok(githubEntityAdapter.platform === "github", "adapter declares platform=github");
  ok(typeof githubEntityAdapter.setState === "function", "adapter declares setState");
  ok(typeof githubEntityAdapter.assign === "function", "adapter declares assign");
  ok(typeof githubEntityAdapter.addLabel === "function", "adapter declares addLabel");
}

console.log(`✓ ${n} issue-actions assertions passed`);
