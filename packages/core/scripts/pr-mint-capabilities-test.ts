import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

registerSlackFixtureMapper();

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

process.env.OE_GITHUB_APP_ID = "111";
process.env.GITHUB_APP_PRIVATE_KEY = pkcs1;
process.env.OE_GITHUB_APP_SLUG = "open-everywhere";
process.env.OE_GITHUB_INSTALLATIONS = '{"acme":"4242"}';
delete process.env.GITHUB_TOKEN;

const BUNDLES = [{ name: "coding", repos: [{ repo: "acme/web", capabilities: ["workflows" as const] }, "acme/plain"] }];
const BINDINGS = [{ bundle: "coding", scope: { level: "surface" as const, surface: "slack/T1/C1" } }];

registerConfig({
  loadBundles: () => BUNDLES,
  loadBindings: () => BINDINGS,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "eng", reach: ["slack/T1/C1"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { resetGitHubApp } = await import("../agent/scm/provider.js");
resetGitHubApp();
const openPullRequestTool = (await import("../agent/tools/open_pull_request.js")).default;

interface MintCall {
  readonly installationId: string;
  readonly permissions: Record<string, string | undefined>;
  readonly repositories: readonly string[];
}
const mintCalls: MintCall[] = [];
const fakeFetch = (async (url: string, init: { body: string }) => {
  const match = String(url).match(/installations\/([^/]+)\/access_tokens/);
  if (!match) throw new Error(`unexpected network call in pr-mint-capabilities-test: ${String(url)}`);
  const body = JSON.parse(init.body) as { permissions: Record<string, string | undefined>; repositories: string[] };
  mintCalls.push({ installationId: match[1], permissions: body.permissions, repositories: body.repositories });
  return {
    ok: true,
    status: 201,
    text: async () => "",
    json: async () => ({ token: `tok_${match[1]}`, expires_at: "2099-01-01T00:00:00Z", repositories: [] }),
  };
}) as unknown as typeof globalThis.fetch;

const ctx = {
  channel: { kind: "slack" },
  session: {
    auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", trust_checked: "true", user_id: "U_ASK", oe_grain: "task" }, principalId: "U_ASK" } },
  },
  getSandbox: async () => {
    throw new Error("no sandbox in this test");
  },
} as never;

interface Entry {
  execute: (input: unknown, ctx: unknown) => Promise<unknown>;
}
await withPatchedFetch(fakeFetch, async () => {
  const handler = (openPullRequestTool as { events?: Record<string, (e: unknown, c: unknown) => unknown> }).events?.["session.started"];
  const entry = (handler ? await handler({}, ctx) : openPullRequestTool) as Entry;
  ok(typeof entry?.execute === "function", "open_pull_request is MOUNTED on this surface (a null resolver would make every assertion below vacuous)");

  const propose = async (repo: string): Promise<string> => {
    const before = mintCalls.length;
    let message = "";
    try {
      await entry.execute({ repo, head: "fix/ci", base: "main", title: "Update CI", body: "What changed." }, ctx);
    } catch (e) {
      message = (e as Error).message;
    }
    ok(mintCalls.length === before + 1, `propose(${repo}): exactly one staging mint was captured`);
    return message;
  };

  {
    const message = await propose("acme/web");
    ok(/no workspace to push from/.test(message), "the drive reaches the staging push and stops there — the mint above it has already run");

    const call = mintCalls[mintCalls.length - 1];
    ok(call.installationId === "4242" && call.repositories.length === 1 && call.repositories[0] === "web", "the mint is scoped to the granted owner's single repo");
    ok(call.permissions.workflows === "write", "🔴 OPE-1794: the PROPOSE-time staging mint carries workflows:write for a repo whose grant declares the workflows capability");
    ok(call.permissions.contents === "write" && call.permissions.pull_requests === "write", "…and keeps the PR job set's own families — the expansion only ever ADDS");
  }

  {
    await propose("acme/plain");
    const call = mintCalls[mintCalls.length - 1];
    ok(call.permissions.workflows === undefined, "🔴 a bare-string repo grant mints NO workflows grade — the expansion comes from the declaration, never from the mint");
    ok(call.permissions.contents === "write" && call.permissions.pull_requests === "write", "…and the bare grant still gets the default write set (the back-compat floor)");
  }

  {
    const { resolvePrWriteToken } = await import("../agent/scm/write-token.js");
    const proposeBody = mintCalls.find((c) => c.permissions.workflows === "write")!;
    const token = await resolvePrWriteToken("acme/web", ["workflows"]);
    ok(token === "tok_4242", "the shared resolver returns the owner's minted token");
    const publishBody = mintCalls[mintCalls.length - 1];
    ok(JSON.stringify(publishBody.permissions) === JSON.stringify(proposeBody.permissions), "🔴 the publish half mints the SAME body the propose half did — one resolver, no second place to forget");
  }
});
console.log(`\n✓ pr mint capabilities (OPE-1794): ${n} assertions passed (the staging mint carries the repo's declared capability sets, and both halves mint one body)\n`);
