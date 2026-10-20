import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readAudit, deploymentOrg, platformFailureClass, type UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";
import { githubPostArm, _resetGitHubInstallationTokenCache } from "../agent/channels/github-post-arm.js";

import { rmSync as __rmSuiteStore } from "node:fs";
import { join as __joinSuiteStore } from "node:path";
import { tmpdir as __tmpdirSuiteStore } from "node:os";
const __suiteStoreDir = __joinSuiteStore(__tmpdirSuiteStore(), `open-everywhere-suite-github-post-arm-${process.pid}`);
__rmSuiteStore(__suiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __joinSuiteStore(__suiteStoreDir, "ops.sqlite3");

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
  const org = deploymentOrg();
  const before = (await readAudit({ org, platform: "github", action: "github.token_mint_failed" })).length;
  _resetGitHubInstallationTokenCache();
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_mismatched", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/some-other-repo" }] }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as unknown as typeof fetch;

    let threw = false;
    let message = "";
    try {
      await githubPostArm.dispatchUnified!({ ...GH_ORIGIN, installationId: 778 } as UnifiedWakeOrigin, "text", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    ok(threw, "OPE-914: a mint that grants a repo OTHER than the one requested REJECTS — the arm never serves a token scoped to nothing that matches");
    ok(message.includes("acme/payments-api") && message.includes("acme/some-other-repo"), "OPE-914: the refusal names both the expected repo and what was actually granted");
    const after = await readAudit({ org, platform: "github", action: "github.token_mint_failed" });
    ok(after.length > before, "OPE-914: the mismatch is as loud as any other mint failure — same durable audit row");

    _resetGitHubInstallationTokenCache();
    const beforeMatch = (await readAudit({ org, platform: "github", action: "github.token_mint_failed" })).length;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_matched", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ id: 2 }), { status: 201 });
    }) as unknown as typeof fetch;
    const id = await githubPostArm.dispatchUnified!({ ...GH_ORIGIN, installationId: 779 } as UnifiedWakeOrigin, "text", {} as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2]);
    ok(id === "2", "negative control: a mint that DOES grant the requested repo posts normally");
    const afterMatch = await readAudit({ org, platform: "github", action: "github.token_mint_failed" });
    ok(afterMatch.length === beforeMatch, "negative control: a matching grant appends NO mint-failure row");
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
        return new Response(JSON.stringify({ token: "ghs_faketoken", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
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
    if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_811", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
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

{
  const savedEnv = {
    appId: process.env.OE_GITHUB_APP_ID,
    pem: process.env.GITHUB_APP_PRIVATE_KEY,
    slug: process.env.OE_GITHUB_APP_SLUG,
    installs: process.env.OE_GITHUB_INSTALLATIONS,
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  process.env.OE_GITHUB_APP_ID = "app-862";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;
  process.env.OE_GITHUB_APP_SLUG = "oe-test-app";
  process.env.OE_GITHUB_INSTALLATIONS = JSON.stringify({ acme: "4242" });
  const savedFetch = globalThis.fetch;

  ok(typeof githubPostArm.editMessage === "function", "🔴 OPE-862: the github arm implements editMessage");

  {
    _resetGitHubInstallationTokenCache();
    const seen: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_edit", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
      seen.push({ url, method: String(init?.method), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ id: 555 }), { status: 200 });
    }) as typeof fetch;
    await githubPostArm.editMessage!({ platform: "github", channelId: "acme/payments-api" }, "555", "corrected text");
    ok(seen.length === 1, "editMessage: exactly one PATCH reached GitHub");
    ok(seen[0]!.method === "PATCH", "editMessage: uses PATCH, not POST");
    ok(seen[0]!.url === "https://api.github.com/repos/acme/payments-api/issues/comments/555", "editMessage: addresses the resolved comment id under the parsed owner/repo");
    ok(JSON.parse(seen[0]!.body).body === "corrected text", "editMessage: sends the replacement text as the comment body");
  }

  {
    let err: unknown;
    try {
      await githubPostArm.editMessage!({ platform: "github", channelId: "not-a-composite-locus" }, "1", "text");
    } catch (e) {
      err = e;
    }
    ok(err instanceof Error, "editMessage: a locus with no owner/repo split refuses");
    ok(platformFailureClass(err) === "definitive", "OPE-825: a malformed locus classifies DEFINITIVE — nothing left this host");
  }

  {
    _resetGitHubInstallationTokenCache();
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_edit2", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
    let err: unknown;
    try {
      await githubPostArm.editMessage!({ platform: "github", channelId: "acme/payments-api" }, "999", "text");
    } catch (e) {
      err = e;
    }
    ok(platformFailureClass(err) === "definitive", "OPE-862/825: a 404 comment PATCH classifies DEFINITIVE");

    _resetGitHubInstallationTokenCache();
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_edit3", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
      return new Response(JSON.stringify({ message: "Service unavailable" }), { status: 503 });
    }) as typeof fetch;
    let ambErr: unknown;
    try {
      await githubPostArm.editMessage!({ platform: "github", channelId: "acme/payments-api" }, "999", "text");
    } catch (e) {
      ambErr = e;
    }
    ok(platformFailureClass(ambErr) === "ambiguous", "OPE-862/825: a 503 comment PATCH classifies AMBIGUOUS");
  }

  globalThis.fetch = savedFetch;
  if (savedEnv.appId === undefined) delete process.env.OE_GITHUB_APP_ID; else process.env.OE_GITHUB_APP_ID = savedEnv.appId;
  if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
  if (savedEnv.slug === undefined) delete process.env.OE_GITHUB_APP_SLUG; else process.env.OE_GITHUB_APP_SLUG = savedEnv.slug;
  if (savedEnv.installs === undefined) delete process.env.OE_GITHUB_INSTALLATIONS; else process.env.OE_GITHUB_INSTALLATIONS = savedEnv.installs;
  _resetGitHubInstallationTokenCache();
}

{
  type ReactBag = Parameters<NonNullable<typeof githubPostArm.resolveReactTarget>>[0];
  const bag = (fields: Record<string, string | number>): ReactBag =>
    ({
      str: (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : undefined),
      num: (k: string) => (typeof fields[k] === "number" ? (fields[k] as number) : undefined),
      ctx: {} as never,
    }) as ReactBag;

  ok(typeof githubPostArm.resolveReactTarget === "function" && typeof githubPostArm.react === "function", "🔴 OPE-862: the github arm implements the REACT pair (resolveReactTarget + react)");

  const t = githubPostArm.resolveReactTarget!(bag({ owner: "acme", repo: "payments-api", issueNumber: 55, installationId: 4242 }));
  assert.deepStrictEqual(t, { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55, installationId: 4242 }, "resolveReactTarget builds the issue anchor from the binding");
  ok(githubPostArm.resolveReactTarget!(bag({ repo: "payments-api", issueNumber: 55 })) === null, "negative control: no owner ⇒ NO react target");
  ok(githubPostArm.resolveReactTarget!(bag({ owner: "acme", repo: "payments-api" })) === null, "negative control: no issue anchor ⇒ NO react target");

  const savedEnv = { id: process.env.GITHUB_APP_ID, pem: process.env.GITHUB_APP_PRIVATE_KEY };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  process.env.GITHUB_APP_ID = "app-862-react";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;
  const savedFetch = globalThis.fetch;

  {
    _resetGitHubInstallationTokenCache();
    const seen: { url: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_react", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
      seen.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ id: 1, content: "+1" }), { status: 201 });
    }) as typeof fetch;
    await githubPostArm.react!(t as never, "thumbsup");
    ok(seen.length === 1 && seen[0]!.url === "https://api.github.com/repos/acme/payments-api/issues/55/reactions", "react: posts to the resolved issue's reactions endpoint");
    ok(JSON.parse(seen[0]!.body).content === "+1", 'react: "thumbsup" maps onto GitHub\'s own "+1" content value');
  }

  {
    _resetGitHubInstallationTokenCache();
    let networkCalled = false;
    globalThis.fetch = (async () => {
      networkCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let err: unknown;
    try {
      await githubPostArm.react!(t as never, "white_check_mark");
    } catch (e) {
      err = e;
    }
    ok(err instanceof Error && /has no GitHub reaction equivalent/.test((err as Error).message), 'react: an unmapped emoji name (e.g. "white_check_mark") refuses with an honest, naming error');
    ok((err as Error).message.includes("eyes") && (err as Error).message.includes("rocket"), "react: the refusal names GitHub's real vocabulary, so the model can retry with a supported name");
    ok(platformFailureClass(err) === "definitive", "OPE-862/825: an unmapped emoji classifies DEFINITIVE — decided before any byte left this host");
    ok(networkCalled === false, "react: an unmapped emoji never reaches the network — no token minted, no request sent");
  }

  {
    _resetGitHubInstallationTokenCache();
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_react2", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
    let err: unknown;
    try {
      await githubPostArm.react!(t as never, "eyes");
    } catch (e) {
      err = e;
    }
    ok(platformFailureClass(err) === "definitive", "OPE-862/825: a 404 reactions POST classifies DEFINITIVE");

    _resetGitHubInstallationTokenCache();
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_react3", expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }), { status: 201 });
      return new Response(JSON.stringify({ message: "Service unavailable" }), { status: 503 });
    }) as typeof fetch;
    let ambErr: unknown;
    try {
      await githubPostArm.react!(t as never, "eyes");
    } catch (e) {
      ambErr = e;
    }
    ok(platformFailureClass(ambErr) === "ambiguous", "OPE-862/825: a 503 reactions POST classifies AMBIGUOUS");
  }

  globalThis.fetch = savedFetch;
  if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = savedEnv.id;
  if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
  _resetGitHubInstallationTokenCache();
}

{
  ok(githubPostArm.dispatchReply !== undefined, "CONTROL: the arm still has its one post primitive — the deletion above took a splitter, never the route");
  ok(!("splitText" in githubPostArm), "🔴 OPE-2006: the arm declares NO splitText — the member is gone from PostArm, so re-adding it here would be declaring a capability nothing reads");
}

console.log(`✓ github-post-arm: ${passed} assertions passed`);
