import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { GitHubApp } from "../agent/scm/app.js";
import type { FetchFn } from "../agent/scm/mint.js";
import { resetGitHubApp } from "../agent/scm/provider.js";
import { checkoutCommandBrokered, CHECKOUT_OK } from "../agent/scm/git.js";
import { brokerAuthHeader, mintGitReadBroker, mergeGitReadBroker, withBareAllowHost, GIT_BROKER_HOSTS } from "../agent/scm/broker.js";
import { stampEnforcement, isEnforced } from "../agent/access/enforcement.js";
import checkoutRepoGated from "../agent/tools/checkout_repo.js";
import { resolveWindowGated } from "../agent/access/window-gated.js";

const checkoutRepoTool = (await resolveWindowGated(checkoutRepoGated, { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_grain: "task" } } } } } as never)) as { execute(input: unknown, ctx: unknown): Promise<any> };

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));

{
  const h = brokerAuthHeader("ghs_secret");
  const expected = `Basic ${Buffer.from("x-access-token:ghs_secret", "utf-8").toString("base64")}`;
  ok(h.Authorization === expected, "brokerAuthHeader: 'Authorization: Basic base64(x-access-token:<token>)' — Eve's own broker header shape");
  ok(Object.keys(h).length === 1, "brokerAuthHeader: exactly one header");
}

{
  const calls: { installationId: string; repositories: string[] }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const installationId = url.match(/installations\/([^/]+)\//)![1];
    const body = JSON.parse(init.body) as { repositories: string[] };
    calls.push({ installationId, repositories: body.repositories });
    return {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ token: `tok_${installationId}`, expires_at: "2026-07-05T00:00:00Z", repositories: [] }),
    };
  };
  const app = new GitHubApp(
    { appId: "1", privateKeyPem: pkcs1, appSlug: "open-everywhere", installations: { acme: "4242", globex: "9999" } },
    { fetchFn, now: () => 1_751_000_000_000 },
  );

  const { rulesByOwner, ungranted } = await mintGitReadBroker(app, ["acme/web", "acme/api", "globex/only", "orphan/repo"]);
  ok(calls.length === 2, "mintGitReadBroker: one mint call per owner (acme, globex) — an installation token can't span owners");
  const acmeCall = calls.find((c) => c.installationId === "4242")!;
  ok(acmeCall.repositories.length === 2 && acmeCall.repositories.includes("web") && acmeCall.repositories.includes("api"), "mintGitReadBroker: acme's mint is the UNION of every granted repo under it, not just one");
  ok(rulesByOwner.size === 2 && rulesByOwner.has("acme") && rulesByOwner.has("globex"), "mintGitReadBroker: one rule per owner with a usable installation");
  ok(ungranted.length === 1 && ungranted[0] === "orphan/repo", "mintGitReadBroker: an owner with no installation is reported ungranted, never silently widened");

  const acmeRule = rulesByOwner.get("acme")!;
  ok(acmeRule.match?.path?.startsWith === "/acme/", "mintGitReadBroker: the rule is narrowed to this owner's own path prefix");
  ok(
    acmeRule.transform?.[0]?.headers?.Authorization === `Basic ${Buffer.from("x-access-token:tok_4242", "utf-8").toString("base64")}`,
    "mintGitReadBroker: the rule's header carries THIS owner's minted token",
  );

  calls.length = 0;
  const empty = await mintGitReadBroker(app, []);
  ok(empty.rulesByOwner.size === 0 && empty.ungranted.length === 0 && calls.length === 0, "mintGitReadBroker: empty repo set → no rules, no ungranted, no mint call");

  const tooMany = Array.from({ length: 501 }, (_, i) => `acme/r${i}`);
  await assert.rejects(mintGitReadBroker(app, tooMany), /caps a single installation.*500/, "mintGitReadBroker: an owner over the 500-repo cap throws a clear error");
  n++;
  ok(calls.length === 0, "mintGitReadBroker: the cap is asserted before minting — no network call for the offending owner");
}

{
  const rule = { match: { path: { startsWith: "/acme/" } }, transform: [{ headers: { Authorization: "Basic X" } }] };
  const rulesByOwner = new Map([["acme", rule]]);

  ok(GIT_BROKER_HOSTS.length === 2 && GIT_BROKER_HOSTS.includes("github.com") && GIT_BROKER_HOSTS.includes("codeload.github.com"), "GIT_BROKER_HOSTS names exactly the two hosts Eve's own broker covers");

  const base = { allow: { "github.com": [], "api.acme.test": [{}] } };
  const merged = mergeGitReadBroker(base as never, rulesByOwner) as { allow: Record<string, unknown[]> };
  ok(merged.allow["github.com"].length === 1 && merged.allow["github.com"][0] === rule, "mergeGitReadBroker: github.com's bare allow is REPLACED by the owner rule, not appended alongside it");
  ok(merged.allow["codeload.github.com"].length === 1 && merged.allow["codeload.github.com"][0] === rule, "mergeGitReadBroker: codeload.github.com gets the SAME owner rule (Eve's own broker covers both hosts)");
  ok(merged.allow["api.acme.test"].length === 1, "mergeGitReadBroker: an unrelated host's rules are left untouched");

  ok(mergeGitReadBroker("deny-all", new Map()) === "deny-all", "mergeGitReadBroker: empty rules leaves deny-all as deny-all");

  const fromDenyAll = mergeGitReadBroker("deny-all", rulesByOwner) as { allow: Record<string, unknown[]> };
  ok(Object.keys(fromDenyAll.allow).sort().join(",") === "codeload.github.com,github.com", "mergeGitReadBroker: from deny-all, ONLY the two git hosts become reachable — nothing else opens up");
}

{
  const readRule = { match: { path: { startsWith: "/acme/" } }, transform: [{ headers: { Authorization: "Basic READ" } }] };
  const brokered = { allow: { "github.com": [readRule], "codeload.github.com": [readRule], "api.acme.test": [{ transform: [{ headers: { Authorization: "Bearer X" } }] }] } };

  const swapped = withBareAllowHost(brokered as never, "github.com") as { allow: Record<string, unknown[]> };
  ok(Array.isArray(swapped.allow["github.com"]) && swapped.allow["github.com"].length === 0, "withBareAllowHost: github.com becomes a BARE allow (no transform) — the inline write token now rides un-overridden");
  ok(swapped.allow["codeload.github.com"].length === 1 && swapped.allow["codeload.github.com"][0] === readRule, "withBareAllowHost: codeload's broker rule is preserved byte-for-byte (only the named host is lifted)");
  ok(swapped.allow["api.acme.test"].length === 1, "withBareAllowHost: an unrelated credentialed host is untouched — the swapped policy stays complete for setNetworkPolicy");

  ok((brokered.allow["github.com"] as unknown[]).length === 1 && brokered.allow["github.com"][0] === readRule, "withBareAllowHost: does NOT mutate the input — the brokered policy is still intact to restore from");

  ok(withBareAllowHost("deny-all", "github.com") === "deny-all", "withBareAllowHost: 'deny-all' is returned unchanged (fail-closed — never fabricate an allow map)");
  ok(withBareAllowHost("allow-all", "github.com") === "allow-all", "withBareAllowHost: 'allow-all' is returned unchanged (no per-host rule to lift)");
}

{
  const cmd = checkoutCommandBrokered("acme/web", "repo", { name: "open-everywhere[bot]", email: "1+open-everywhere[bot]@users.noreply.github.com" });
  ok(!cmd.includes("http.extraheader"), "checkoutCommandBrokered: no extraheader — auth happens at the firewall, not in this command");
  ok(!cmd.includes("Authorization") && !cmd.includes("x-access-token"), "checkoutCommandBrokered: no token or header material anywhere in the command");
  ok(cmd.includes(`git clone -- 'https://github.com/acme/web.git' 'repo'`), "checkoutCommandBrokered: clones the bare (token-free) HTTPS URL");
  ok(cmd.includes("user.name 'open-everywhere[bot]'") && cmd.includes("user.email '1+open-everywhere[bot]@users.noreply.github.com'"), "checkoutCommandBrokered: still stamps the bot commit identity");
  ok(cmd.includes(CHECKOUT_OK) && cmd.indexOf("git clone") < cmd.indexOf(CHECKOUT_OK), "checkoutCommandBrokered: clone runs before the OK sentinel");
}

{
  ok(isEnforced() === true, "isEnforced: outside any Eve context, defaults to enforced (fail-closed)");
  stampEnforcement(false);
  ok(isEnforced() === true, "isEnforced: a stamp attempted outside a session is a no-op — still fail-closed");

  await contextStorage.run(new ContextContainer(), async () => {
    ok(isEnforced() === true, "isEnforced: a fresh session starts enforced (defineState's initial())");
    stampEnforcement(false);
    ok(isEnforced() === false, "isEnforced: reads back exactly what THIS session stamped");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    ok(isEnforced() === true, "isEnforced: a DIFFERENT session is unaffected by a previous session's stamp");
  });
}

{
  registerConfig({
    loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/web", "acme/api"] })],
    loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "org" } })],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  process.env.OE_GITHUB_APP_ID = "111";
  process.env.OE_GITHUB_APP_PRIVATE_KEY = pkcs1;
  process.env.OE_GITHUB_APP_SLUG = "open-everywhere";
  process.env.OE_GITHUB_INSTALLATIONS = JSON.stringify({ acme: "4242" });
  resetGitHubApp();

  const mintCalls: { repositories: string[]; permissions: Record<string, string> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { repositories: string[]; permissions: Record<string, string> };
    mintCalls.push({ repositories: body.repositories, permissions: body.permissions });
    return {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ token: `tok_${mintCalls.length}`, expires_at: "2026-07-05T00:00:00Z", repositories: [] }),
    };
  }) as typeof fetch;
  try {

  const ctxFor = (getSandbox: () => Promise<unknown>) =>
    ({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", oe_grain: "task" }, principalId: "U1", principalType: "slack-user" } } },
      getSandbox,
    }) as unknown as BindableContext;

  const runCallsA: string[] = [];
  const policyCallsA: unknown[] = [];
  const sandboxA = {
    run: async (opts: { command: string }) => {
      runCallsA.push(opts.command);
      return { stdout: CHECKOUT_OK, stderr: "", exitCode: 0 };
    },
    setNetworkPolicy: async (policy: unknown) => {
      policyCallsA.push(policy);
    },
  };
  await contextStorage.run(new ContextContainer(), async () => {
    stampEnforcement(true);
    const result = await checkoutRepoTool.execute({ repo: "acme/web" }, ctxFor(async () => sandboxA) as never);
    ok((result as { ok: boolean }).ok === true, "checkout_repo (enforced): succeeds");
  });
  ok(policyCallsA.length === 1, "checkout_repo (enforced): setNetworkPolicy is called once, applying the merged firewall policy");
  const appliedPolicy = policyCallsA[0] as { allow: Record<string, { match?: { path?: { startsWith?: string } } }[]> };
  ok(appliedPolicy.allow["github.com"]?.[0]?.match?.path?.startsWith === "/acme/", "checkout_repo (enforced): the applied policy carries the owner-scoped git broker rule");
  ok(runCallsA.length === 1 && !runCallsA[0].includes("http.extraheader"), "checkout_repo (enforced): the clone command carries NO token — it stayed at the firewall");
  ok(mintCalls.length === 1 && mintCalls[0].repositories.length === 2 && mintCalls[0].repositories.includes("web") && mintCalls[0].repositories.includes("api"), "checkout_repo (enforced): mints the UNION of the session's granted repos, not just the one being checked out");
  ok(mintCalls[0].permissions.contents === "read", "checkout_repo (enforced): the broker mint is READ-ONLY");

  mintCalls.length = 0;
  const runCallsB: string[] = [];
  const policyCallsB: unknown[] = [];
  const sandboxB = {
    run: async (opts: { command: string }) => {
      runCallsB.push(opts.command);
      return { stdout: CHECKOUT_OK, stderr: "", exitCode: 0 };
    },
    setNetworkPolicy: async (policy: unknown) => {
      policyCallsB.push(policy);
    },
  };
  await contextStorage.run(new ContextContainer(), async () => {
    stampEnforcement(false);
    const result = await checkoutRepoTool.execute({ repo: "acme/web" }, ctxFor(async () => sandboxB) as never);
    ok((result as { ok: boolean }).ok === true, "checkout_repo (fallback): succeeds");
  });
  ok(policyCallsB.length === 0, "checkout_repo (fallback): setNetworkPolicy is NOT called — enforcement isn't available on this backend/config");
  ok(runCallsB.length === 1 && runCallsB[0].includes("http.extraheader"), "checkout_repo (fallback): the clone command carries the in-sandbox token, exactly as before this change");
  ok(mintCalls.length === 1 && mintCalls[0].repositories.length === 1 && mintCalls[0].repositories[0] === "web", "checkout_repo (fallback): mints only the ONE repo being checked out (today's behavior), not the session's union");

  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OE_GITHUB_APP_ID;
    delete process.env.OE_GITHUB_APP_PRIVATE_KEY;
    delete process.env.OE_GITHUB_APP_SLUG;
    delete process.env.OE_GITHUB_INSTALLATIONS;
    resetGitHubApp();
  }
}

console.log(`\n✓ scm-broker: ${n} assertions passed (union-mint per owner, 500-cap, merge-no-duplicate-github-rule, withBareAllowHost push-window swap, checkoutCommandBrokered, enforcement-state seam, checkout_repo enforced-vs-fallback)\n`);
