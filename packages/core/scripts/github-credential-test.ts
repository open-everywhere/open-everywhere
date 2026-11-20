import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { SandboxNetworkMatcher } from "eve/sandbox";
import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { defineSettings, getSettings, overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { getGitHubApp, resetGitHubApp } from "../agent/scm/provider.js";
import { GitHubApp } from "../agent/scm/app.js";
import { githubAuthMode, githubCredentialConfigured, resolveRepoToken, tokenReaches, tokenRepos } from "../agent/scm/credential.js";
import { resolveConversationReadToken, resolveReadToken, resolveSurfaceReadToken } from "../agent/scm/pr-status.js";
import { resolvePrWriteToken } from "../agent/scm/write-token.js";
import { brokerAuthHeader, sessionGitBroker, tokenGitReadRules, withBareAllowHost } from "../agent/scm/broker.js";
import { READ_PERMISSIONS } from "../agent/scm/mint.js";
import listReposTool from "../agent/tools/list_repos.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const rejects = async (fn: () => Promise<unknown>, needle: string, label: string): Promise<string> => {
  let message = "";
  try {
    await fn();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(message.includes(needle), `${label} (saw: ${message || "no throw"})`);
  n++;
  return message;
};

const TOKEN = "ghp_github_credential_canary";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

function fakeApp(): { app: GitHubApp; mints: string[][] } {
  const mints: string[][] = [];
  const app = new GitHubApp(
    { appId: "1", privateKeyPem: pkcs1, appSlug: "acme-oe", installations: { acme: "4242" } },
    {
      fetchFn: async (_url, init) => {
        mints.push((JSON.parse(init.body) as { repositories: string[] }).repositories);
        return { ok: true, status: 201, text: async () => "", json: async () => ({ token: "ghs_minted", expires_at: "2099-01-01T00:00:00Z", repositories: [] }) };
      },
      now: () => 1_751_000_000_000,
    },
  );
  return { app, mints };
}

registerConfig({
  loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/bot", "acme/web", "globex/api"] })],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadAccessRequests: () => ({ configRepo: "acme/bot" }) as never,
});
for (const k of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_TOKEN"]) delete process.env[k];
resetSettingsForTest();
resetGitHubApp();

{
  ok(getSettings().github.auth === "app", "§1 the shipped sign-in mode is the App");
  ok(getSettings().github.tokenRepos.length === 0, "§1 the shipped token reach names no extra repository");
  assert.throws(() => defineSettings({ github: { auth: "pat" as never } }), /github\.auth: must be "app" or "token"/);
  n++;
  assert.throws(() => defineSettings({ github: { tokenRepos: ["just-a-name"] } }), /github\.tokenRepos: must be a list of repositories/);
  n++;
  ok(defineSettings({ github: { auth: "token", tokenRepos: ["acme/web"] } }) !== undefined, "§1 a well-formed token declaration validates");
}

{
  process.env.GITHUB_TOKEN = TOKEN;
  ok(githubAuthMode() === "app" && getGitHubApp() === null, "§2 positive control: app mode, and no App configured — the token is the only credential present");
  const unused = await rejects(
    () => resolveRepoToken("acme/web", READ_PERMISSIONS, { app: null }),
    'GITHUB_TOKEN is set, but this deployment signs in with the GitHub App (github.auth "app")',
    "§2 🔴 app mode with no App refuses, even with GITHUB_TOKEN set — before OPE-2530 it returned the token",
  );
  ok(!unused.includes(TOKEN), "§2 the refusal names the variable, never its value");
  const { app, mints } = fakeApp();
  await rejects(
    () => resolveRepoToken("globex/api", READ_PERMISSIONS, { app }),
    "the GitHub App is not installed on globex/api",
    "§2 🔴 app mode with no installation for the repo refuses by name — before OPE-2530 it returned the token",
  );
  ok((await resolveRepoToken("acme/web", READ_PERMISSIONS, { app })) === "ghs_minted" && mints.length === 1, "§2 app mode mints through the App where it is installed");
}

{
  overrideSettingsForTest({ github: { auth: "token" } });
  overrideSettingsForTest({ github: { appId: "1", appSlug: "acme-oe", installations: { acme: "4242" } } });
  process.env.GITHUB_APP_PRIVATE_KEY = pkcs1;
  resetGitHubApp();
  ok(getGitHubApp() === null, "§3 🔴 token mode: getGitHubApp() is null even with the App fully configured — one credential per host");
  ok(tokenRepos().join() === "acme/bot", "§3 token mode: with no github.tokenRepos the token reaches the deployment's own repository only");
  ok(tokenReaches("Acme/Bot"), "§3 the reach compares names case-insensitively, as GitHub does");
  const { app, mints } = fakeApp();
  ok((await resolveRepoToken("acme/bot", READ_PERMISSIONS, { app })) === TOKEN && mints.length === 0, "§3 🔴 token mode returns the token for its own repository and never mints, even when handed an App");
  const outside = await rejects(
    () => resolveRepoToken("acme/web", READ_PERMISSIONS),
    "the personal access token does not reach acme/web",
    "§3 🔴 token mode refuses a granted repository outside its reach",
  );
  ok(outside.includes("acme/bot") && outside.includes("github.tokenRepos") && !outside.includes(TOKEN), "§3 the refusal names the reach and the setting that widens it, and never the token");
  overrideSettingsForTest({ github: { auth: "token", tokenRepos: ["acme/web", "acme/bot"] } });
  ok(tokenRepos().join() === "acme/bot,acme/web", "§3 github.tokenRepos widens the reach, with no duplicate of the own repository");
  ok((await resolveRepoToken("acme/web", READ_PERMISSIONS)) === TOKEN, "§3 a repository named in github.tokenRepos is reached");
  delete process.env.GITHUB_TOKEN;
  await rejects(() => resolveRepoToken("acme/bot", READ_PERMISSIONS, { subject: "the config repo" }), 'no GitHub credential for the config repo: this deployment signs in to GitHub with a personal access token (github.auth "token"), and GITHUB_TOKEN is not set', "§3 token mode with no token refuses, and never falls back to the App");
  ok(!(await githubCredentialConfigured()), "§3 token mode with no token holds no credential, App secrets or not");
  process.env.GITHUB_TOKEN = TOKEN;
  ok(await githubCredentialConfigured(), "§3 token mode with the token set holds its credential");
}

{
  overrideSettingsForTest({ github: { auth: "token", tokenRepos: [] } });
  ok((await resolveReadToken("acme/bot")) === TOKEN, "§4 the PR read resolves the token in token mode");
  ok((await resolveConversationReadToken("acme/bot")) === TOKEN, "§4 the conversation read resolves the token in token mode");
  ok((await resolvePrWriteToken("acme/bot", [])) === TOKEN, "§4 the PR write resolves the token in token mode");
  await rejects(() => resolvePrWriteToken("acme/web", []), "does not reach acme/web", "§4 🔴 the PR write refuses outside the token's reach");
  await rejects(() => resolveSurfaceReadToken("acme/bot"), "the GitHub conversation surface needs the GitHub App", "§4 🔴 the conversation SURFACE read is App-only: token mode refuses it");
  overrideSettingsForTest({ github: { auth: "app" } });
  resetGitHubApp();
  await rejects(() => resolveReadToken("globex/api"), "the GitHub App is not installed on globex/api", "§4 🔴 app mode: the PR read never falls back to the set token");
  await rejects(() => resolvePrWriteToken("globex/api", []), "the GitHub App is not installed on globex/api", "§4 🔴 app mode: the PR write never falls back to the set token");
}

{
  const rules = tokenGitReadRules(TOKEN, ["acme/bot"]);
  ok(rules.length === 2 && rules.every((r) => r.match?.path === undefined || !("startsWith" in r.match.path)), "§5 🔴 two rules, and neither is a path PREFIX (a prefix would stamp a dot-segment path)");
  ok(rules.every((r) => r.transform[0]?.headers?.Authorization === brokerAuthHeader(TOKEN).Authorization), "§5 each rule carries the token in the broker's header shape");
  const vercelStamps = (method: string, path: string, query: Record<string, string> = {}) =>
    rules.some((r) => {
      const m = r.match!;
      if (m.method && !m.method.includes(method)) return false;
      if (m.path && "exact" in m.path && path !== m.path.exact) return false;
      if (m.path && "regex" in m.path && !new RegExp(m.path.regex).test(path)) return false;
      if (m.path && "startsWith" in m.path && !path.startsWith(m.path.startsWith)) return false;
      const exactOf = (x: SandboxNetworkMatcher | undefined): string | undefined => (x && "exact" in x ? x.exact : undefined);
      return (m.queryString ?? []).every((q) => query[exactOf(q.key) ?? ""] === exactOf(q.value));
    });
  ok(vercelStamps("GET", "/acme/bot.git/info/refs", { service: "git-upload-pack" }) && vercelStamps("POST", "/acme/bot.git/git-upload-pack"), "§5 positive control: a clone's two requests are stamped");
  ok(!vercelStamps("GET", "/acme/bot.git/info/refs", { service: "git-receive-pack" }), "§5 🔴 a push's ref advertisement (service=git-receive-pack) is not stamped");
  ok(!vercelStamps("POST", "/acme/bot.git/git-receive-pack"), "§5 🔴 a push's pack upload is not stamped");
  ok(!vercelStamps("POST", "/acme/bot.git/git-upload-pack/../../../acme/other.git/git-receive-pack"), "§5 🔴 a dot-segment path behind the clone path is not stamped");
  ok(!vercelStamps("POST", "/acme/bot.git/git-upload-pack/%2e%2e/%2e%2e/other.git/git-receive-pack"), "§5 🔴 a percent-encoded dot-segment path is not stamped");
  ok(!vercelStamps("POST", "/acme/botX.git/git-upload-pack") && !vercelStamps("POST", "/acme/web.git/git-upload-pack"), "§5 🔴 a sibling repository is not stamped");

  const acl = (await import(new URL("../../../deploy/egress-proxy/control/acl.ts", import.meta.url).href)) as {
    decide(policy: unknown, req: { host: string; method?: string; path?: string }): { allow: boolean; headers?: Record<string, string> };
  };
  const policy = { allow: { "github.com": rules } };
  const at = (method: string, path: string) => acl.decide(policy, { host: "github.com", method, path });
  ok(at("GET", "/acme/bot.git/info/refs?service=git-upload-pack").allow && at("POST", "/acme/bot.git/git-upload-pack").allow, "§5 self-host: a clone's two requests are allowed");
  ok(!at("POST", "/acme/bot.git/git-receive-pack").allow && !at("GET", "/acme/bot.git/info/refs?service=git-receive-pack").allow, "§5 🔴 self-host: a push from the sandbox is DENIED while the token rules stand");
  ok(!at("POST", "/acme/bot.git/git-upload-pack/../../../acme/other.git/git-receive-pack").allow, "§5 🔴 self-host: a dot-segment path is denied");
  ok(acl.decide(withBareAllowHost(policy as never, "github.com"), { host: "github.com", method: "POST", path: "/acme/bot.git/git-receive-pack" }).allow, "§5 🔴 self-host: with the rules lifted for the approved push, the push is allowed");

  overrideSettingsForTest({ github: { auth: "token", tokenRepos: [] } });
  const broker = await sessionGitBroker(["acme/bot", "acme/web"]);
  ok(broker !== null && broker.covers("acme/bot") && !broker.covers("acme/web"), "§5 the session broker covers only the granted repositories the token reaches");
  ok(broker!.rules.length === 2, "§5 …with two rules for the one reached repository");
}

{
  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1" }, principalId: "U1", principalType: "slack-user" } } },
  };
  const list = listReposTool as unknown as { execute(i: unknown, c: unknown): Promise<{ repos: string[]; sourceControlConfigured: boolean }> };
  const tokenOut = await list.execute({}, ctx);
  ok(tokenOut.repos.join() === "acme/bot" && tokenOut.sourceControlConfigured, `§6 🔴 token mode: list_repos lists only the granted repositories the token reaches (saw ${tokenOut.repos.join()})`);
  overrideSettingsForTest({ github: { auth: "app" } });
  const appOut = await list.execute({}, ctx);
  ok(appOut.repos.length === 3 && appOut.sourceControlConfigured, "§6 app mode: list_repos lists every granted repository, as before");
}

{
  overrideSettingsForTest({ github: { auth: "token", tokenRepos: ["acme/web"] } });
  resetGitHubApp();
  ok(getGitHubApp() === null && (await resolveReadToken("acme/web")) === TOKEN, "§7 before: token mode presents the token");
  overrideSettingsForTest({ github: { auth: "app" } });
  ok(getGitHubApp() !== null, "§7 🔴 after one setting: the App is back, with nothing else changed");
  const { app, mints } = fakeApp();
  ok((await resolveReadToken("acme/web", app)) === "ghs_minted" && mints.length === 1, "§7 after: the same read mints through the App, and the leftover github.tokenRepos entry is inert");
}

resetSettingsForTest();
for (const k of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_TOKEN"]) delete process.env[k];
resetGitHubApp();

console.log(`\n✓ github-credential: ${n} assertions passed (settings, app mode without fallback, token reach, every resolver, firewall rules, list_repos, one-step upgrade)\n`);

// proves: TOOL-list_repos
