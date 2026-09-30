import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AccessRequestsConfig } from "../agent/access/config.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";
import { fileURLToPath } from "node:url";

const dir = join(tmpdir(), `open-everywhere-config-repo-mint-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

process.env.OE_GITHUB_APP_ID = "111";
process.env.OE_GITHUB_APP_PRIVATE_KEY = pkcs1;
process.env.OE_GITHUB_APP_SLUG = "open-everywhere";
process.env.OE_GITHUB_INSTALLATIONS = '{"acme":"4242"}';
delete process.env.GITHUB_TOKEN;

const CONFIG_REPO = "acme/agent-config";

const { resetGitHubApp } = await import("../agent/scm/provider.js");
resetGitHubApp();

const { executeAccessRequest } = await import("../agent/approvals/access-request.js");
const { executeAgentCreate } = await import("../agent/approvals/agent-create.js");
const { executeWebhookDeclare } = await import("../agent/approvals/webhook-declare.js");
const { deliverGroupsOverlay } = await import("../agent/identity/groups-delivery.js");
const { planDirectoryGroups } = await import("../agent/identity/group-sync.js");
const { emptyGroupsFile } = await import("../agent/identity/groups-codemod.js");
const { makeGitHubConfigPrProvider } = await import("../agent/credentials/config-pr-github.js");
const { resolvePrWriteToken } = await import("../agent/scm/write-token.js");
const { DEFAULT_PERMISSIONS } = await import("../agent/scm/mint.js");

interface MintCall {
  readonly installationId: string;
  readonly permissions: Record<string, string | undefined>;
  readonly repositories: readonly string[];
}
const mintCalls: MintCall[] = [];
const fakeFetch = (async (url: string, init: { body: string }) => {
  const match = String(url).match(/installations\/([^/]+)\/access_tokens/);
  if (!match) throw new Error(`unexpected network call in config-repo-mint-test: ${String(url)}`);
  const body = JSON.parse(init.body) as { permissions: Record<string, string | undefined>; repositories: string[] };
  mintCalls.push({ installationId: match[1], permissions: body.permissions, repositories: body.repositories });
  return {
    ok: true,
    status: 201,
    text: async () => "",
    json: async () => ({ token: `tok_${match[1]}`, expires_at: "2099-01-01T00:00:00Z", repositories: [] }),
  };
}) as unknown as typeof globalThis.fetch;

const SENTINEL = "config-repo-mint-test: stop after the mint";
const stopAfterMint = async (): Promise<never> => {
  throw new Error(SENTINEL);
};

const baseConfig: AccessRequestsConfig = {
  adminChannel: "C_ADMIN",
  configRepo: CONFIG_REPO,
  configBase: "main",
  baseBundles: () => [],
  baseBindings: () => [],
  baseWebhooks: () => [],
  baseAgents: () => ({ domains: [], silos: [], bundles: [], bindings: [], specs: [] }),
};

const REQUEST_ID = "11111111-2222-3333-4444-555555555555";
const frozen = {
  org: "default",
  scopeKey: "slack/T1/C1",
  requestId: REQUEST_ID,
  requestedBy: "U_ASK",
  channelId: "C1",
  threadTs: "1720009900.000100",
  configRepo: CONFIG_REPO,
};

const groupsPlan = planDirectoryGroups({
  provider: "okta",
  people: [
    {
      externalId: "alice",
      displayName: "alice",
      accounts: [{ platform: "slack", nativeId: "U-alice", grade: "attested" as const }],
      groups: ["Payments"],
      deprovisioned: false,
    },
  ],
  current: emptyGroupsFile(),
});

const FLOWS: readonly { readonly name: string; readonly file: string; readonly drive: () => Promise<unknown> }[] = [
  {
    name: "access-request",
    file: "packages/core/agent/approvals/access-request.ts",
    drive: () =>
      executeAccessRequest(
        { ...frozen, delta: { kind: "grant-connector", scope: { level: "surface", surface: "slack/T1/C1" }, connector: "linear", credential: "k" } },
        "U_TAP",
        { config: baseConfig, getBranchSha: stopAfterMint },
      ),
  },
  {
    name: "agent-create",
    file: "packages/core/agent/approvals/agent-create.ts",
    drive: () =>
      executeAgentCreate(
        {
          ...frozen,
          spec: { name: "support-desk", channels: ["slack/T1/C_AGENT"], memory: { kind: "new-readonly", provider: "notion", container: "root-page" } },
          agentsPath: "agent/memory/config/agents.generated.ts",
        },
        "U_TAP",
        { config: baseConfig, getBranchSha: stopAfterMint },
      ),
  },
  {
    name: "webhook-declare",
    file: "packages/core/agent/approvals/webhook-declare.ts",
    drive: () =>
      executeWebhookDeclare(
        {
          ...frozen,
          declaration: {
            id: "deploy-status",
            source: "oe-standard-webhook",
            secretRef: "OE_WEBHOOK_SECRET_DEPLOY_STATUS",
            broker: "env",
            target: "slack/T1/C-DEPLOYS",
            readableBy: [{ level: "domain", domain: "eng" }],
            instruction: "A CI deploy-status webhook fired. Summarise the result for the channel.",
          },
        },
        "U_TAP",
        { config: baseConfig, getBranchSha: stopAfterMint },
      ),
  },
  {
    name: "config-pr-github",
    file: "packages/core/agent/credentials/config-pr-github.ts",
    drive: async () => {
      const provider = makeGitHubConfigPrProvider({});
      await provider.resolveWriteToken(CONFIG_REPO);
      throw new Error(SENTINEL);
    },
  },
  {
    name: "groups-delivery",
    file: "packages/core/agent/identity/groups-delivery.ts",
    drive: () => deliverGroupsOverlay(groupsPlan, { config: baseConfig, getBranchSha: stopAfterMint }),
  },
];

await withPatchedFetch(fakeFetch, async () => {
  console.log("\n1. the five config-repo flows — one mint each, the default job set, nothing more:");
  {
    ok(groupsPlan.steps.length > 0, "fixture: the group plan CHANGES something (a no-op plan returns before the mint and would measure nothing)");
    ok(FLOWS.length === 5, `fixture: all FIVE config-repo flows are driven (found ${FLOWS.length})`);

    for (const flow of FLOWS) {
      const before = mintCalls.length;
      let message = "";
      try {
        await flow.drive();
      } catch (e) {
        message = (e as Error).message;
      }
      ok(message === SENTINEL, `${flow.name}: the drive reaches the mint and stops one line after it (message: "${message}")`);
      ok(mintCalls.length === before + 1, `${flow.name}: exactly one installation-token mint was captured`);

      const call = mintCalls[mintCalls.length - 1];
      ok(call.installationId === "4242", `${flow.name}: minted against the config repo owner's installation`);
      ok(call.repositories.length === 1 && call.repositories[0] === "agent-config", `${flow.name}: the mint is scoped to the ONE config repo — no other repo rides this token`);
      ok(
        JSON.stringify(call.permissions) === JSON.stringify(DEFAULT_PERMISSIONS),
        `🔴 ${flow.name}: the mint body is EXACTLY the pull-request job set — every family, every grade (got ${JSON.stringify(call.permissions)})`,
      );
      ok(call.permissions.workflows === undefined, `🔴 ${flow.name}: no workflows grade — a config-repo flow declares no capability, and it writes no workflow file`);
    }
  }

  console.log("\n2. the wide control — the rig can see an expansion:");
  {
    const before = mintCalls.length;
    const token = await resolvePrWriteToken(CONFIG_REPO, ["workflows"]);
    ok(mintCalls.length === before + 1 && token === "tok_4242", "control: the shared resolver mints and returns the owner's token");
    const call = mintCalls[mintCalls.length - 1];
    ok(call.permissions.workflows === "write", "🔴 control: a DECLARED capability reaches the mint body on this rig — so §1's absences are measurements, not a blind spot");
    ok(call.permissions.contents === "write" && call.permissions.pull_requests === "write", "control: …and the expansion only ever ADDS to the job set");
  }

  console.log("\n3. an owner outside the installation — every flow fails closed:");
  {
    process.env.OE_GITHUB_INSTALLATIONS = '{"someone-else":"9999"}';
    resetGitHubApp();
    for (const flow of FLOWS) {
      const before = mintCalls.length;
      let message = "";
      try {
        await flow.drive();
      } catch (e) {
        message = (e as Error).message;
      }
      ok(
        message.includes("no GitHub credential for the config repo"),
        `🔴 ${flow.name}: refuses when no installation covers the config repo's owner (message: "${message}")`,
      );
      ok(mintCalls.length === before, `${flow.name}: …and no token was minted at all — the refusal precedes the exchange`);
    }
    process.env.OE_GITHUB_INSTALLATIONS = '{"acme":"4242"}';
    resetGitHubApp();
  }
});

console.log("\n4. the source fence — one owner for the write set, and no implicit one:");
{
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.name === "dist" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
    );
  const sources = ["packages/core/agent", "packages/providers", "packages/adapters", "agent"].flatMap((d) => walk(join(repoRoot, d)));
  const rel = (p: string): string => p.slice(repoRoot.length);
  ok(sources.length > 100, "fence: the walk found the agent tree (a walk that found nothing would pass every assertion below)");
  ok(sources.some((p) => rel(p) === "packages/core/agent/scm/write-token.ts"), "fence: …and it reaches the resolver the rules below are about");
  for (const d of ["packages/adapters/", "agent/"]) {
    ok(sources.some((p) => rel(p).startsWith(d)), `fence: …and it reaches ${d} (a renamed tree would shrink the scan in silence)`);
  }

  const WRITE_SET_OWNERS = [
    "packages/core/agent/approvals/pr-open.ts",
    "packages/core/agent/scm/mint.ts",
    "packages/core/agent/scm/write-token.ts",
  ];
  const namesWriteSet = sources.filter((p) => readFileSync(p, "utf8").includes("DEFAULT_PERMISSIONS")).map(rel);
  ok(
    namesWriteSet.every((p) => WRITE_SET_OWNERS.includes(p)),
    `🔴 fence: only ${WRITE_SET_OWNERS.join(", ")} name DEFAULT_PERMISSIONS — found ${namesWriteSet.filter((p) => !WRITE_SET_OWNERS.includes(p)).join(", ")}`,
  );
  ok(
    namesWriteSet.length === WRITE_SET_OWNERS.length,
    `fence: …and ALL ${WRITE_SET_OWNERS.length} owners were actually found (a renamed file would shrink this scan and pass it) — found ${namesWriteSet.join(", ")}`,
  );

  const argumentLists = (text: string): string[] => {
    const needle = "tokensForRepos(";
    const out: string[] = [];
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
      let depth = 0;
      let j = i + needle.length - 1;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(text.slice(i + needle.length, j));
    }
    return out;
  };
  const oneArgument = (args: string): boolean => {
    let depth = 0;
    for (const c of args) {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) return false;
    }
    return true;
  };
  const implicit = sources.filter((p) => argumentLists(readFileSync(p, "utf8")).some(oneArgument)).map(rel);
  ok(
    implicit.length === 0,
    `🔴 fence: no call site takes the write set by OMITTING its permissions argument — found ${implicit.join(", ")}`,
  );
  const memorySource = readFileSync(join(repoRoot, "packages/providers/github/agent/memory/memory.ts"), "utf8");
  ok(memorySource.includes("tokensForRepos([repo], MEMORY_WRITE_PERMISSIONS)"), "fence: GitHub memory names its narrow memory-write set at the warm-token mint call site");

  for (const flow of FLOWS) {
    const text = readFileSync(join(repoRoot, flow.file), "utf8");
    ok(text.includes("resolveConfigRepoWriteToken"), `fence: ${flow.name} resolves its token through the shared config-repo helper`);
    ok(!/function resolveWriteToken\(/.test(text), `fence: ${flow.name} keeps no private mint body of its own`);
  }

  const codeOnly = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const HELPER = "packages/core/agent/scm/config-repo-token.ts";
  const callers = sources
    .filter((p) => rel(p).startsWith("packages/core/agent/") && rel(p) !== HELPER)
    .filter((p) => codeOnly(readFileSync(p, "utf8")).includes("resolveConfigRepoWriteToken"))
    .map(rel)
    .sort();
  const driven = FLOWS.map((f) => f.file).sort();
  ok(
    callers.length === driven.length && callers.every((p, i) => p === driven[i]),
    `🔴 fence: the flows this suite drives ARE every caller of the shared helper — drives [${driven.join(", ")}], tree has [${callers.join(", ")}]`,
  );
  ok(callers.length === 5, `fence: …and the tree still holds FIVE callers (found ${callers.length}) — the "five" this suite's prose claims is measured, not asserted by hand`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ config-repo mint (OPE-1823): ${n} assertions passed (all five config-repo bot-PR flows mint one narrow body through one resolver)\n`);
