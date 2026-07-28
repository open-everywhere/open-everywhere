
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readAudit, deploymentOrg, type UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";
import { githubPostArm, _resetGitHubInstallationTokenCache } from "../agent/channels/github-post-arm.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const GH_ORIGIN: UnifiedWakeOrigin = { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55 };

ok(githubPostArm.platform === "github", "arm is tagged platform=github");
ok(githubPostArm.describeRedriveTarget!(GH_ORIGIN) === "github acme/payments-api#55", "redrive target description: github owner/repo#issue (token-free)");
ok(githubPostArm.redriveContainerId!(GH_ORIGIN) === "acme/payments-api", "redrive container id: owner/repo");

{
  const seen: { origin: unknown; text: string }[] = [];
  const deps = { postGitHub: async (origin: UnifiedWakeOrigin, text: string) => { seen.push({ origin, text }); return "id-99"; } } as unknown as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2];
  const id = await githubPostArm.dispatchUnified!(GH_ORIGIN, "hello from the unified window", deps);
  ok(id === "id-99", "dispatchUnified returns the poster's comment id");
  ok(seen.length === 1 && seen[0]!.text === "hello from the unified window", "dispatchUnified routes the text through the injected poster (deps.postGitHub)");
  assert.deepStrictEqual(seen[0]!.origin, GH_ORIGIN, "dispatchUnified passes the github origin through unchanged");
}

{
  const savedEnv = { id: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
  const savedFetch = globalThis.fetch;
  const org = deploymentOrg();
  const before = (await readAudit({ org, platform: "github", action: "github.token_mint_failed" })).length;
  _resetGitHubInstallationTokenCache();
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as unknown as typeof fetch;

    let threw = false;
    try {
      await githubPostArm.dispatchUnified!({ ...GH_ORIGIN, installationId: 777 } as UnifiedWakeOrigin, "text", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    } catch {
      threw = true;
    }
    ok(threw, "a failed installation-token mint REJECTS the reply (never posts under a token it couldn't mint)");
    const after = await readAudit({ org, platform: "github", action: "github.token_mint_failed" });
    ok(after.length > before, "a failed installation-token mint appends a durable github.token_mint_failed audit row");
    ok(after[0]!.detail?.credential === "github.installation-token", "…naming which credential failed");
    ok(after[0]!.detail?.key === "777 payments-api", "…and which (installation, repo) it was scoped to — non-secret by construction");
    ok(!JSON.stringify(after[0]).includes("PRIVATE KEY"), "…and never the App private key");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedEnv.id;
    if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
    _resetGitHubInstallationTokenCache();
  }
}

console.log(`✓ github-post-arm: ${passed} assertions passed`);
