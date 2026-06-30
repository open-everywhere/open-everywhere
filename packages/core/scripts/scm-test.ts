import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import { parsePrivateKey, signAppJwt, buildMintBody, mintInstallationToken, DEFAULT_PERMISSIONS, normalizePrivateKeyPem, type FetchFn } from "../agent/scm/mint.js";
import { authExtraHeader, cloneArgs, fetchArgs, pushArgs, botCommitter, identityArgs, checkoutCommand, isSafeCheckoutDir, redactSecret, CHECKOUT_OK, conventionProbe, parseConventionProbe, CONV_MARKER, CONVENTION_FILES } from "../agent/scm/git.js";
import { loadGitHubAppConfig } from "../agent/scm/config.js";
import { GitHubApp } from "../agent/scm/app.js";
import { repoAllowed } from "../agent/scm/provider.js";
import { compileNetworkPolicy } from "../agent/access/egress.js";
import type { EffectiveAccess } from "../agent/access/resolver.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

{
  ok(pkcs1.includes("BEGIN RSA PRIVATE KEY"), "fixture exports a PKCS#1 key (GitHub's format)");
  ok(!!parsePrivateKey(pkcs1), "parsePrivateKey accepts PKCS#1");
  ok(!!parsePrivateKey(pkcs8), "parsePrivateKey accepts PKCS#8");
}

{
  const now = 1_750_000_000;
  const jwt = await signAppJwt(parsePrivateKey(pkcs1), "Iv1.clientid", now);
  const { payload, protectedHeader } = await jwtVerify(jwt, createPublicKey(pubPem), { issuer: "Iv1.clientid", currentDate: new Date(now * 1000) });
  ok(protectedHeader.alg === "RS256", "JWT is signed RS256");
  ok(payload.iss === "Iv1.clientid", "JWT issuer is the client id");
  ok(payload.iat === now - 60, "iat is back-dated 60s for clock drift");
  ok(payload.exp === now + 540, "exp is 9 minutes out (≤ 10 max)");
}

{
  const body = buildMintBody(["web", "web", "api"]);
  ok(body.repositories.length === 2 && body.repositories.includes("web") && body.repositories.includes("api"), "mint body dedups repo names");
  ok(body.permissions.contents === "write" && body.permissions.pull_requests === "write" && body.permissions.metadata === "read", "default permissions are least-privilege");
  ok(buildMintBody(Array.from({ length: 600 }, (_, i) => `r${i}`)).repositories.length === 500, "repo list is capped at 500");
  ok(DEFAULT_PERMISSIONS.contents === "write", "exported default permissions are correct");
}

{
  let seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null = null;
  const fetchFn: FetchFn = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ token: "ghs_secret", expires_at: "2026-06-25T13:00:00Z", repository_selection: "selected", repositories: [{ full_name: "acme/web" }, { full_name: "acme/api" }] }),
    };
  };
  const tok = await mintInstallationToken({ jwt: "JWT", installationId: "4242", repoNames: ["web", "api"], fetchFn });
  ok(seen!.url.endsWith("/app/installations/4242/access_tokens"), "mint hits the installation access_tokens endpoint");
  ok(seen!.init.headers.authorization === "Bearer JWT", "mint sends the app JWT as Bearer");
  ok(JSON.parse(seen!.init.body).repositories.length === 2, "mint body carries the scoped repo subset");
  ok(tok.token === "ghs_secret" && tok.expiresAt === "2026-06-25T13:00:00Z", "token + expiry parsed from response");
  ok(tok.repositories.includes("acme/web"), "covered repositories parsed");

  const boom: FetchFn = async () => ({ ok: false, status: 403, text: async () => "forbidden", json: async () => ({}) });
  await assert.rejects(mintInstallationToken({ jwt: "x", installationId: "1", repoNames: [], fetchFn: boom }), /403 forbidden/);
  n++;
}

{
  const hdr = authExtraHeader("ghs_secret");
  ok(hdr === `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`, "extraheader is base64(x-access-token:TOKEN)");
  const clone = cloneArgs("acme/web", "ghs_secret", "/w/repo");
  ok(clone.includes("clone") && clone.includes("https://github.com/acme/web.git"), "clone targets the clean https url");
  ok(!clone.some((a) => a.includes("ghs_secret") && a.includes("https://")), "token is NOT embedded in the clone URL");
  ok(clone[0] === "-c" && clone[1].startsWith("http.extraheader="), "clone passes the token via -c http.extraheader (in-memory)");
  ok(pushArgs("ghs_secret", "fix/bug")[1].startsWith("http.extraheader="), "push re-injects the header");
  ok(fetchArgs("ghs_secret").includes("fetch"), "fetch re-injects the header");
}

{
  const c = botCommitter("open-everywhere", "12345");
  ok(c.name === "open-everywhere[bot]", "bot name is <slug>[bot]");
  ok(c.email === "12345+open-everywhere[bot]@users.noreply.github.com", "bot email is <id>+<slug>[bot]@users.noreply.github.com");
  const args = identityArgs("open-everywhere", "12345");
  ok(args.includes("user.name=open-everywhere[bot]") && args.includes("user.email=12345+open-everywhere[bot]@users.noreply.github.com"), "identity args stamp commit author without writing config");
}

{
  ok(loadGitHubAppConfig({}) === null, "plane is optional: null when unconfigured");
  const cfg = loadGitHubAppConfig({
    OE_GITHUB_APP_ID: "111",
    OE_GITHUB_APP_PRIVATE_KEY: pkcs1,
    OE_GITHUB_APP_SLUG: "open-everywhere",
    OE_GITHUB_BOT_USER_ID: "12345",
    OE_GITHUB_INSTALLATIONS: '{"acme":"4242"}',
    OE_GITHUB_OWNER: "globex",
    OE_GITHUB_INSTALLATION_ID: "9999",
  } as NodeJS.ProcessEnv)!;
  ok(cfg.appSlug === "open-everywhere" && cfg.botUserId === "12345", "config reads app fields");
  ok(cfg.installations.acme === "4242" && cfg.installations.globex === "9999", "config merges the JSON map and the single-owner pair");
}

{
  const calls: { installationId: string; body: { repositories: string[] } }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const installationId = url.match(/installations\/([^/]+)\//)![1];
    calls.push({ installationId, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => "", json: async () => ({ token: `tok_${installationId}`, expires_at: "2026-06-25T13:00:00Z", repositories: [] }) };
  };
  const app = new GitHubApp(
    { appId: "111", privateKeyPem: pkcs1, appSlug: "open-everywhere", botUserId: "12345", installations: { acme: "4242" } },
    { fetchFn, now: () => 1_750_000_000_000 },
  );
  const { tokens, ungranted } = await app.tokensForRepos(["acme/web", "acme/api", "globex/secret"]);
  ok(tokens.size === 1 && tokens.get("acme")!.token === "tok_4242", "one scoped token per granted owner");
  ok(calls.length === 1 && calls[0].body.repositories.length === 2, "the owner's two repos are scoped into a single token (mint per owner, not per repo)");
  ok(ungranted.length === 1 && ungranted[0] === "globex/secret", "a repo whose owner has no installation is reported ungranted, never widened");
  ok(app.committer().email === "12345+open-everywhere[bot]@users.noreply.github.com", "orchestrator exposes the bot committer");
}

{
  const escaped = pkcs1.replace(/\n/g, "\\n");
  ok(escaped.includes("\\n") && !escaped.includes("\n"), "fixture builds an escaped-newline PEM");
  ok(normalizePrivateKeyPem(escaped).includes("\n"), "normalizePrivateKeyPem restores newlines");
  ok(!!parsePrivateKey(escaped), "parsePrivateKey accepts an escaped-newline PEM (via normalize)");
  ok(normalizePrivateKeyPem(pkcs1) === pkcs1, "normalize is a no-op on a real-newline PEM");
}

{
  ok(repoAllowed("acme/web", ["acme/web", "acme/api"]), "repoAllowed accepts a granted repo");
  ok(!repoAllowed("acme/secret", ["acme/web"]), "repoAllowed rejects an ungranted repo");
}

{
  const cmd = checkoutCommand("acme/web", "ghs_secret", "repo", { name: "open-everywhere[bot]", email: "1+open-everywhere[bot]@users.noreply.github.com" });
  ok(cmd.includes("clone -- 'https://github.com/acme/web.git' 'repo'"), "checkout clones the clean https url");
  ok(!cmd.includes("ghs_secret@"), "token is NOT in the clone URL");
  ok(cmd.includes("http.extraheader=AUTHORIZATION: basic"), "token rides in http.extraheader");
  ok(cmd.includes("git -C 'repo' config http.extraheader"), "header is persisted to the clone so later push/fetch are authed");
  ok(cmd.includes("config user.name 'open-everywhere[bot]'"), "bot identity is configured");
  ok(cmd.includes(CHECKOUT_OK), "command prints the success sentinel");
  ok(isSafeCheckoutDir("svc/web") && !isSafeCheckoutDir("../etc"), "checkout dir guard blocks traversal");
  ok(!isSafeCheckoutDir("a'; rm -rf /"), "checkout dir guard blocks shell metacharacters");
}

{
  const tok = "ghs_secret";
  const b64 = Buffer.from(`x-access-token:${tok}`, "utf-8").toString("base64");
  const out = redactSecret(`fatal: ${tok} bad; header ${b64}`, tok);
  ok(!out.includes(tok) && !out.includes(b64) && out.includes("[REDACTED]"), "redactSecret scrubs token + base64 form");
}

{
  const probe = conventionProbe("repo");
  ok(probe.includes("AGENTS.md") && probe.includes("CLAUDE.md"), "probe checks both AGENTS.md and CLAUDE.md");
  ok(probe.indexOf("AGENTS.md") < probe.indexOf("CLAUDE.md"), "probe prefers AGENTS.md (listed first; shell breaks on first match)");
  ok(probe.includes("'repo'/"), "probe scopes to the checkout dir");
  ok(CONVENTION_FILES[0] === "AGENTS.md" && CONVENTION_FILES[1] === "CLAUDE.md", "AGENTS.md is the priority convention file");

  const cmd = checkoutCommand("acme/web", "ghs_x", "repo", { name: "open-everywhere[bot]", email: "1+open-everywhere[bot]@users.noreply.github.com" });
  ok(cmd.includes(CONV_MARKER), "checkoutCommand includes the convention probe");
  ok(cmd.indexOf(CONV_MARKER) < cmd.indexOf(CHECKOUT_OK), "probe runs before the OK sentinel");

  const found = parseConventionProbe(`some clone noise\n${CONV_MARKER} AGENTS.md 42 1337\n${CHECKOUT_OK}`);
  ok(found?.file === "AGENTS.md" && found.lines === 42 && found.bytes === 1337, "parseConventionProbe reads file/lines/bytes");
  ok(parseConventionProbe(`${CONV_MARKER} CLAUDE.md 5 90`)?.file === "CLAUDE.md", "parseConventionProbe handles the CLAUDE.md fallback");
  ok(parseConventionProbe(`${CHECKOUT_OK}`) === null, "parseConventionProbe returns null when no convention file");
  ok(parseConventionProbe(`${CONV_MARKER} AGENTS.md notanumber 5`) === null, "parseConventionProbe ignores a malformed line");
}

{
  const base = (repos: string[]): EffectiveAccess => ({
    mode: "channel", scopeKey: "x", connections: [], connectorCredentials: {}, reachableHosts: [], repos, plugins: [], skills: [], subagents: [], connectors: [], instructionStack: [], warnings: [],
  });
  const withRepos = await compileNetworkPolicy(base(["acme/web"]), async () => ({}));
  const allow = (typeof withRepos === "object" ? withRepos.allow : undefined) as Record<string, unknown[]> | undefined;
  ok(!!allow && "github.com" in allow, "granted repos add a github.com egress allow");
  ok(!!allow && allow["github.com"].length === 0, "github.com is a BARE allow (option-1: no firewall header)");
  ok((await compileNetworkPolicy(base([]), async () => ({}))) === "deny-all", "no hosts + no repos → deny-all (fail closed)");
}

console.log(`\n✓ scm: ${n} assertions passed (JWT, scoping, git-arg safety, identity, config, orchestrator, checkout cmd, convention probe, guards, egress)\n`);
