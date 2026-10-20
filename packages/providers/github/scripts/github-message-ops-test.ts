import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { surfaceMessageOps, friendlyGuardSource, getSettings, isFriendlyGuarded, overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { registerGithubProvider } from "../agent/register.js";
import { githubMessageOps } from "../agent/channels/github-message-ops.js";
import { _resetGitHubInstallationTokenCache } from "../agent/channels/github-post-arm.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const savedEnv = {
  appId: getSettings().github.appId,
  pem: process.env.GITHUB_APP_PRIVATE_KEY,
  slug: getSettings().github.appSlug,
  installs: getSettings().github.installations,
};
const savedFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
overrideSettingsForTest({ github: { appId: "app-899", appSlug: "oe-test-app", installations: { acme: "4242" } } });
process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;

const MINTED_TOKEN = "ghs_899";

let passThroughFetch: typeof fetch = (async () =>
  new Response("github-message-ops-test: this request is not this suite's and was not dialled", { status: 503 })) as unknown as typeof fetch;

function stubGitHubFetch(onCall: (url: string, init?: RequestInit) => Response): { calls: { url: string; method: string; body: string }[] } {
  const calls: { url: string; method: string; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: MINTED_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ full_name: "acme/payments-api" }] }),
        { status: 201 },
      );
    }
    if (new Headers(init?.headers ?? {}).get("authorization") !== `Bearer ${MINTED_TOKEN}`) return await passThroughFetch(input, init);
    calls.push({ url, method: String(init?.method), body: String(init?.body ?? "") });
    return onCall(url, init);
  }) as unknown as typeof fetch;
  return { calls };
}

try {
  {
    registerGithubProvider();
    const resolved = surfaceMessageOps("github");
    ok(resolved !== undefined, "registerGithubProvider() makes surfaceMessageOps('github') resolve to something (OPE-899 was: it resolved undefined)");
    ok(isFriendlyGuarded(resolved), "the registry stores the ops wrapped by the friendly-names guard (OPE-2482)");
    ok(friendlyGuardSource(resolved) === githubMessageOps, "…and it resolves to THIS module's ops object, by identity — the same one turn-anchor.ts's postSurfaceText dispatches to");
    ok(typeof resolved?.postText === "function" && typeof resolved?.editMessage === "function", "the resolved ops carry postText/editMessage");
    ok(resolved?.postFiles === undefined, "…and NO postFiles (GitHub has no attach-a-file-to-a-comment API)");
    ok(resolved?.setReaction === undefined, "…and NO setReaction (GitHub's fixed reaction set has no raised hand — the bare `stop` comment is the control)");
  }

  {
    _resetGitHubInstallationTokenCache();
    const { calls } = stubGitHubFetch(() => new Response(JSON.stringify({ id: 4242 }), { status: 201 }));
    const id = await githubMessageOps.postText("acme/payments-api#55", "stood down — nothing had run yet");
    ok(id === "4242", "postText returns the created comment id");
    ok(calls.length === 1 && calls[0]!.url === "https://api.github.com/repos/acme/payments-api/issues/55/comments", "targets the parsed owner/repo/issue's comments endpoint");
    ok(calls[0]!.method === "POST", "posts (not PATCHes)");
    ok(JSON.parse(calls[0]!.body).body === "stood down — nothing had run yet", "carries the text as the comment body");
  }
  {
    _resetGitHubInstallationTokenCache();
    const { calls } = stubGitHubFetch(() => new Response(JSON.stringify({ id: 4243 }), { status: 201 }));
    await githubMessageOps.postText("acme/payments-api#55", "a reply", { replyToMessageId: "999" });
    ok(!calls[0]!.body.includes("999"), "opts.replyToMessageId is accepted but never threaded into the POST body — GitHub's timeline stream is flat");
  }
  {
    let threw = false;
    let message = "";
    try {
      await githubMessageOps.postText("not-a-conversation-id", "text");
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    ok(threw, "postText: a malformed channelId (not owner/repo#number) refuses");
    ok(message.includes("not-a-conversation-id"), "…and names the bad id in the refusal");
  }

  {
    _resetGitHubInstallationTokenCache();
    const foreign: string[] = [];
    const restorePassThrough = passThroughFetch;
    passThroughFetch = (async (input: string | URL) => {
      foreign.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { calls } = stubGitHubFetch(() => new Response(JSON.stringify({ id: 4244 }), { status: 201 }));
      await githubMessageOps.postText("acme/payments-api#55", "the call under test");
      await globalThis.fetch("https://api.github.com/repos/other/repo/issues/9/comments", {
        method: "POST",
        headers: { authorization: "Bearer another-legs-token" },
        body: "{}",
      });
      ok(calls.length === 1, "🔴 a FOREIGN in-shard request landing inside the stub window is NOT counted — this is the flake OPE-1326 measured");
      ok(calls[0]!.url.includes("/repos/acme/payments-api/"), "…and the one call recorded is the ops' own");
      ok(foreign.length === 1 && foreign[0]!.includes("/repos/other/repo/"), "…while the foreign request was DELEGATED onward, not answered from this suite's fixture");
    } finally {
      passThroughFetch = restorePassThrough;
    }
  }

  {
    _resetGitHubInstallationTokenCache();
    const { calls } = stubGitHubFetch(() => new Response(JSON.stringify({ id: 4242 }), { status: 200 }));
    await githubMessageOps.editMessage("acme/payments-api#55", "4242", "corrected text");
    ok(calls.length === 1 && calls[0]!.url === "https://api.github.com/repos/acme/payments-api/issues/comments/4242", "edits the given comment id, addressed by owner/repo parsed off the container (issue number dropped — comment ids are repo-unique)");
    ok(calls[0]!.method === "PATCH", "PATCHes (not posts)");
    ok(JSON.parse(calls[0]!.body).body === "corrected text", "carries the new body");
  }
  {
    let threw = false;
    try {
      await githubMessageOps.editMessage("not-a-conversation-id", "1", "text");
    } catch {
      threw = true;
    }
    ok(threw, "editMessage: a malformed channelId refuses the same way postText's does");
  }
} finally {
  globalThis.fetch = savedFetch;
  overrideSettingsForTest({ github: { appId: savedEnv.appId, appSlug: savedEnv.slug, installations: savedEnv.installs } });
  if (savedEnv.pem === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = savedEnv.pem;
  _resetGitHubInstallationTokenCache();
}

console.log(`✓ ${n} github-message-ops assertions passed`);
