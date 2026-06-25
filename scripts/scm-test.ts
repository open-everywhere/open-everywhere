import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import { parsePrivateKey, signAppJwt, buildMintBody, mintInstallationToken, DEFAULT_PERMISSIONS, type FetchFn } from "../agent/scm/mint.js";
import { authExtraHeader, cloneArgs, fetchArgs, pushArgs, botCommitter, identityArgs } from "../agent/scm/git.js";
import { loadGitHubAppConfig } from "../agent/scm/config.js";
import { GitHubApp } from "../agent/scm/app.js";

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

console.log(`\n✓ scm: ${n} assertions passed (JWT sign/verify, token down-scoping, git-arg safety, bot identity, config, orchestrator)\n`);
