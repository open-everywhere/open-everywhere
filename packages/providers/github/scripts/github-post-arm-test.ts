
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readAudit, deploymentOrg, platformFailureClass, type UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";
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

{
  const savedEnv = { id: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
  const savedFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

  const stubFetch = (commentStatus: number, commentBody: unknown) =>
    (async (url: string) => {
      const u = String(url);
      if (u.includes("access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_faketoken", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
      }
      return new Response(JSON.stringify(commentBody), { status: commentStatus });
    }) as unknown as typeof fetch;

  try {
    _resetGitHubInstallationTokenCache();
    globalThis.fetch = stubFetch(201, { id: 8675309 });
    const id = await githubPostArm.dispatchUnified!({ ...GH_ORIGIN, installationId: 888 } as UnifiedWakeOrigin, "ok text", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    ok(id === "8675309", "success control: a landed comment POST returns the real comment id");

    _resetGitHubInstallationTokenCache();
    globalThis.fetch = stubFetch(403, { message: "Resource not accessible by integration" });
    let definitiveErr: unknown;
    try {
      await githubPostArm.dispatchUnified!({ ...GH_ORIGIN, installationId: 889 } as UnifiedWakeOrigin, "text", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    } catch (err) {
      definitiveErr = err;
    }
    ok(definitiveErr instanceof Error, "a 403 comment POST throws");
    ok((definitiveErr as { status?: unknown }).status === 403, "the thrown error carries the real numeric status (403)");
    ok(platformFailureClass(definitiveErr) === "definitive", "OPE-825: a 403 on the comment POST classifies DEFINITIVE — nothing landed, a retry is legitimate");

    _resetGitHubInstallationTokenCache();
    globalThis.fetch = stubFetch(503, { message: "Service unavailable" });
    let ambiguousErr: unknown;
    try {
      await githubPostArm.dispatchUnified!({ ...GH_ORIGIN, installationId: 890 } as UnifiedWakeOrigin, "text", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    } catch (err) {
      ambiguousErr = err;
    }
    ok(platformFailureClass(ambiguousErr) === "ambiguous", "OPE-825: a 503 on the comment POST classifies AMBIGUOUS (fail-closed default — it may have landed)");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedEnv.id;
    if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
    _resetGitHubInstallationTokenCache();
  }
}

{
  const savedEnv = { id: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  try {
    let err: unknown;
    try {
      await githubPostArm.dispatchUnified!(GH_ORIGIN, "text", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    } catch (e) {
      err = e;
    }
    ok(err instanceof Error, "no App credentials configured ⇒ the arm throws");
    ok(platformFailureClass(err) === "definitive", "OPE-825: a pre-flight 'no App credentials' refusal classifies DEFINITIVE — the call never left this host");
  } finally {
    if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedEnv.id;
    if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
  }
}

{
  type Bag = Parameters<NonNullable<typeof githubPostArm.resolveTarget>>[0];
  const bag = (fields: Record<string, string | number>): Bag =>
    ({
      str: (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : undefined),
      num: (k: string) => (typeof fields[k] === "number" ? (fields[k] as number) : undefined),
      ctx: {} as never,
    }) as Bag;

  ok(githubPostArm.resolveTarget !== undefined && githubPostArm.dispatchReply !== undefined, "🔴 OPE-811: the github arm implements the MID-TURN pair (resolveTarget + dispatchReply)");

  const issue = githubPostArm.resolveTarget!(bag({ owner: "acme", repo: "payments-api", issueNumber: 55, installationId: 4242 }));
  assert.deepStrictEqual(issue, { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55, installationId: 4242 }, "resolveTarget builds the issue target from the binding, installation id included");

  const pr = githubPostArm.resolveTarget!(bag({ owner: "acme", repo: "payments-api", pullRequestNumber: 7 }));
  ok(pr !== null && (pr as { issueNumber: number }).issueNumber === 7, "a PR timeline comment anchors the SAME /issues/{n}/comments endpoint");
  ok(pr !== null && !("installationId" in (pr as Record<string, unknown>)), "an absent installation id is OMITTED, never guessed — the arm falls back to the owner→installation map");

  ok(githubPostArm.resolveTarget!(bag({ repo: "payments-api", issueNumber: 55 })) === null, "negative control: no owner ⇒ NO target");
  ok(githubPostArm.resolveTarget!(bag({ owner: "acme", issueNumber: 55 })) === null, "negative control: no repo ⇒ NO target");
  ok(githubPostArm.resolveTarget!(bag({ owner: "acme", repo: "payments-api" })) === null, "negative control: no issue/PR anchor ⇒ NO target");
  ok(githubPostArm.resolveTarget!(bag({ owner: "acme", repo: "payments-api", issueNumber: 0 })) === null, "negative control: a zero anchor is not an issue number ⇒ NO target");

  const savedEnv = { id: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
  const savedFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  process.env.GITHUB_APP_ID = "app-811";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;
  _resetGitHubInstallationTokenCache();
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_811", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
    if (url.endsWith("/comments")) return new Response(JSON.stringify({ id: 987 }), { status: 201, headers: { "content-type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const id = await githubPostArm.dispatchReply!({ platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55, installationId: 4242 } as never, "the mid-turn answer");
    ok(id === "987", "🔴 OPE-811: dispatchReply posts the comment and returns the platform message id");
    ok(seen.some((u) => u === "https://api.github.com/repos/acme/payments-api/issues/55/comments"), "OPE-811: it posts to the resolved issue's comments endpoint, never a guessed one");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedEnv.id;
    if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
    _resetGitHubInstallationTokenCache();
  }
}

console.log(`✓ github-post-arm: ${passed} assertions passed`);
