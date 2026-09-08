import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GitHubApp } from "../agent/scm/app.js";
import { resetGitHubApp } from "../agent/scm/provider.js";
import { searchGithubIssues, githubWorkSearchAdapter } from "../agent/scm/github-search.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { registerIdentityMapper, type BindableContext } from "../agent/identity/binding.js";
import type { PrFetchFn } from "../agent/scm/pr.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

const mintFetch: PrFetchFn = async (url) => {
  const installationId = /installations\/([^/]+)\//.exec(url)![1];
  return { ok: true, status: 201, text: async () => "", json: async () => ({ token: `tok_${installationId}`, expires_at: "2026-06-25T13:00:00Z", repositories: [] }) };
};
const app = new GitHubApp(
  { appId: "111", privateKeyPem: pkcs1, appSlug: "open-everywhere", botUserId: "12345", installations: { acme: "4242", globex: "9999" } },
  { fetchFn: mintFetch, now: () => 1_750_000_000_000 },
);

{
  const calls: { url: string; token: string }[] = [];
  const searchFetch: PrFetchFn = async (url, init) => {
    calls.push({ url, token: (init.headers as Record<string, string>).authorization });
    if (url.includes("repo%3Aacme")) {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          items: [
            { number: 1, title: "Fix the thing", html_url: "https://github.com/acme/web/issues/1", repository_url: "https://api.github.com/repos/acme/web" },
            { number: 9, title: "Should never surface", html_url: "https://github.com/acme/other-repo/issues/9", repository_url: "https://api.github.com/repos/acme/other-repo" },
          ],
        }),
      };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({ items: [{ number: 5, title: "Globex bug", html_url: "https://github.com/globex/api/issues/5", repository_url: "https://api.github.com/repos/globex/api" }] }) };
  };

  const hits = await searchGithubIssues(["acme/web", "acme/api", "globex/api"], "auth failing", 10, { fetchFn: searchFetch, app });

  ok(calls.length === 2, `one Search API call per OWNER, not per repo (2 owners, got ${calls.length} calls)`);
  const acmeCall = calls.find((c) => c.url.includes("repo%3Aacme"))!;
  ok(acmeCall.url.includes("repo%3Aacme%2Fweb") && acmeCall.url.includes("repo%3Aacme%2Fapi"), "the acme call is repo:-qualified to BOTH of acme's granted repos in one query");
  ok(acmeCall.token === "Bearer tok_4242", "the acme call carries acme's OWN installation token");
  const globexCall = calls.find((c) => c.url.includes("repo%3Aglobex"))!;
  ok(globexCall.token === "Bearer tok_9999", "the globex call carries a DIFFERENT token — one mint per owner, not a shared token");

  ok(hits.length === 2, `only the two GRANTED-repo hits survive (${hits.length})`);
  ok(hits.some((h) => h.id === "acme/web#1"), "a hit from a granted repo carries id owner/repo#number");
  ok(
    hits.every((h) => h.id !== "acme/other-repo#9"),
    "🔴 the defensive repoAllowed re-check drops a hit from an UNGRANTED repo even when it came back from a granted owner's own call",
  );
  ok(hits.find((h) => h.id === "acme/web#1")!.url === "https://github.com/acme/web/issues/1", "the hit carries the issue url");
  ok(hits.find((h) => h.id === "acme/web#1")!.title === "Fix the thing", "the hit carries the title");

  await assert.rejects(searchGithubIssues(["nope/repo"], "q", 10, { fetchFn: searchFetch, app }), /no installation token/u, "NEGATIVE CONTROL: a repo whose owner has no installation token REFUSES rather than silently returning empty");
  await assert.rejects(searchGithubIssues(["acme/web"], "q", 10, { fetchFn: searchFetch, app: null }), /no GitHub App configured/u, "NEGATIVE CONTROL: no configured App refuses loudly");
}

{
  const PLATFORM = "githubsearchtestplatform";
  registerIdentityMapper(PLATFORM, (c) => {
    const a = (c as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
    return { workspace: a?.["ws"], surface: a?.["room"], mode: "channel", visibility: "public", trust: "internal", principalId: "U_GWS" };
  });
  function ctxIn(room: string): BindableContext {
    return {
      channel: { kind: PLATFORM },
      session: { auth: { current: { attributes: { ws: "W1", room }, principalId: "U_GWS", principalType: "test-user" } } },
    } as unknown as BindableContext;
  }
  const domain: Domain = defineDomain({ name: "gws-domain", reach: [`${PLATFORM}/W1/CROOM`] });
  registerConfig({
    loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/web"] })],
    loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "domain", domain: "gws-domain" } })],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [domain],
    loadSilos: () => [],
    domainsForSurface: ({ workspaceKey, surface }) => ([domain].filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name)),
  });

  const SAVED: Record<string, string | undefined> = {};
  function setEnv(name: string, value: string): void {
    if (!(name in SAVED)) SAVED[name] = process.env[name];
    process.env[name] = value;
  }
  setEnv("OE_GITHUB_APP_ID", "222");
  setEnv("OE_GITHUB_APP_PRIVATE_KEY", pkcs1);
  setEnv("OE_GITHUB_APP_SLUG", "open-everywhere");
  setEnv("OE_GITHUB_BOT_USER_ID", "12345");
  setEnv("OE_GITHUB_INSTALLATIONS", JSON.stringify({ acme: "4242" }));
  resetGitHubApp();

  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "tok_4242", expires_at: "2026-06-25T13:00:00Z", repositories: [] }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(
      JSON.stringify({ items: [{ number: 1, title: "T", html_url: "u", repository_url: "https://api.github.com/repos/acme/web" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const withInside = await githubWorkSearchAdapter.search(ctxIn("CROOM"), domain, "q", { limit: 10, insideDomain: true });
    const withoutInside = await githubWorkSearchAdapter.search(ctxIn("CROOM"), domain, "q", { limit: 10, insideDomain: false });
    assert.deepEqual(withInside, withoutInside, "insideDomain changes NOTHING about the query or the result — the repo grant already IS the domain's own space");
    ok(withInside.length === 1 && withInside[0]!.id === "acme/web#1", "the adapter reaches the real Search API path end-to-end (mount → grant → mint → search)");
  } finally {
    globalThis.fetch = savedFetch;
    resetGitHubApp();
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log(`✓ github-search: ${passed} assertions passed`);
