import assert from "node:assert/strict";
import { getSettings, overrideSettingsForTest } from "../agent/settings/settings.js";
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookContext, HookEvent } from "eve/hooks";
import { decideActingIdentity, namedOwnAccountVendor, type OwnAccountVendor } from "../agent/connections/own-account-ask.js";
import {
  humanActingConnectors,
  ownAccountAskVendors,
  ownAccountVendorAliasProblems,
  OwnAccountVendorsUnavailableError,
  OWN_ACCOUNT_VENDOR_ALIASES,
  _resetHumanActingCacheForTest,
} from "../agent/connections/own-account-vendors.js";
import { GITHUB_OWN_ACCOUNT_VENDOR } from "../agent/scm/github-acting-identity.js";
import { stampOwnAccountAsk } from "../agent/hooks/own-account-ask.js";
import { registerConfig } from "../agent/access/config.js";
import { defineConnectorCredentials, oauthConnectorHome, type ConnectorCredentials } from "../agent/access/connector-credentials.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { registerIdentityMapper, type BindableContext } from "../agent/identity/binding.js";
import { resetGitHubApp } from "../agent/scm/provider.js";
import { githubWorkSearchAdapter } from "../agent/scm/github-search.js";
import { checkPrStatusEntry } from "../agent/tools/check_pr_status.js";
import { getPrFeedbackEntry } from "../agent/tools/get_pr_feedback.js";
import { readGithubIssueEntry } from "../agent/tools/read_github_issue.js";
import { walkPrEntry } from "../agent/tools/walk_pr.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const GITHUB_CONNECTOR = "github";
const GH: readonly OwnAccountVendor[] = [{ aliases: ["github.com"], connector: GITHUB_CONNECTOR }];
const NOTION: OwnAccountVendor = { aliases: ["notion.so"], connector: "notion" };

ok(namedOwnAccountVendor(["read that PR with my own GitHub account"], GH)?.connector === GITHUB_CONNECTOR, "`my own GitHub account` is a GitHub own-account ask");
ok(namedOwnAccountVendor(["check my github login for me"], GH)?.connector === GITHUB_CONNECTOR, "`my github login` is a GitHub own-account ask");
ok(namedOwnAccountVendor(["look in github using my own credentials"], GH)?.connector === GITHUB_CONNECTOR, "an adjacent possessive binds to github");
ok(namedOwnAccountVendor(["read my own github.com account"], GH)?.connector === GITHUB_CONNECTOR, "the `github.com` alias is recognised");

ok(namedOwnAccountVendor(["read PR 12 in the widgets repo"], GH) === undefined, "an ordinary GitHub read is not an own-account ask");
ok(namedOwnAccountVendor(["ask my account manager about the github invoice"], GH) === undefined, "`my account manager` is not an own-account ask");
ok(namedOwnAccountVendor(["read that page with my own account at the bank"], GH) === undefined, "a possessive with no github nearby does not bind to github");
ok(namedOwnAccountVendor(["walk through my own account settings"], GH) === undefined, "`through` does not name github — this alias list carries no short word");
ok(namedOwnAccountVendor(["highlight my own credentials in the report"], GH) === undefined, "`highlight` does not name github");
ok(
  namedOwnAccountVendor(["walk through my own account settings"], [{ aliases: ["gh"], connector: GITHUB_CONNECTOR }])?.connector === GITHUB_CONNECTOR,
  "negative control: a SHORT alias does bind inside `through` — the hazard the long-word rule avoids is real",
);

const mixed = "read the Q3 page in Notion while I check my own GitHub account";
ok(namedOwnAccountVendor([mixed], [NOTION]) === undefined, "a GitHub possessive does not make a NOTION own-account ask");
ok(namedOwnAccountVendor([mixed], GH)?.connector === GITHUB_CONNECTOR, "the same sentence IS a GitHub own-account ask");

const ask = namedOwnAccountVendor(["read that PR with my own GitHub account"], GH);
ok(ask !== undefined, "the ask used by the decision arms is recognised");
const refused = decideActingIdentity({
  ask: ask!,
  callerCanSpendPersonal: false,
  connector: GITHUB_CONNECTOR,
  consentRouteAvailable: false,
  deploymentAdmitsGrant: false,
  personalGrantHeld: false,
});
ok(refused.refusal !== undefined, "a GitHub own-account ask is REFUSED");
ok(refused.identity === undefined, "a refused verdict carries NO identity — a caller cannot read one off it");
ok(refused.requiredIdentity === "human-acting", "the refusal records that the request required the human-acting identity");
ok(refused.reason === "own-account-ask-no-grant", "the refusal names the closed reason");
ok(refused.refusal!.includes(GITHUB_CONNECTOR), "the refusal sentence names github");
ok(refused.refusal!.includes("no consent flow to start"), "the refusal says plainly that no consent route exists here");
ok(refused.refusal!.includes("cannot lend a personal github account at all"), "the refusal names the STRUCTURAL absence, not a domain declaration");
ok(!refused.refusal!.includes("no domain here admits one"), "…and never the domain sentence, which is the fixable absence and not this one");

const ordinary = decideActingIdentity({
  callerCanSpendPersonal: false,
  connector: GITHUB_CONNECTOR,
  consentRouteAvailable: false,
  deploymentAdmitsGrant: false,
  personalGrantHeld: false,
});
ok(ordinary.refusal === undefined, "a turn with no own-account ask is NOT refused");
ok(ordinary.identity === "install", "a turn with no own-account ask runs under the install identity");
ok(ordinary.askRecognised === false, "a turn with no own-account ask records no ask");

const held = decideActingIdentity({
  ask: ask!,
  callerCanSpendPersonal: false,
  connector: GITHUB_CONNECTOR,
  consentRouteAvailable: true,
  deploymentAdmitsGrant: true,
  personalGrantHeld: true,
});
ok(held.refusal !== undefined, "a held grant does not let a GitHub read run under the install token");
ok(held.identity === undefined, "the held-grant refusal carries no identity either");
ok(
  decideActingIdentity({ ask: ask!, callerCanSpendPersonal: true, connector: GITHUB_CONNECTOR, consentRouteAvailable: true, deploymentAdmitsGrant: true, personalGrantHeld: true }).identity === "human-acting",
  "negative control: a caller that CAN spend personally is allowed the human-acting identity, so arm 6 is about the caller",
);

ok(ownAccountVendorAliasProblems().length === 0, "§7 every shipped alias passes the registry's own rule");
ok(ownAccountVendorAliasProblems({ github: ["gh"] }).length > 0, "§7 negative control: a SHORT alias is refused — that is the hazard the rule exists for");
ok(ownAccountVendorAliasProblems({ github: ["GitHub.com"] }).length > 0, "§7 negative control: an upper-cased alias is refused — the grammar lower-cases the sentence, not the alias");
ok((OWN_ACCOUNT_VENDOR_ALIASES[GITHUB_CONNECTOR] ?? []).includes("github.com"), "§7 the registry declares github's spoken alias");
ok(GITHUB_OWN_ACCOUNT_VENDOR.connector === GITHUB_CONNECTOR, "§7 the shipped vendor's connector is the access plane's own `github`");
ok((GITHUB_OWN_ACCOUNT_VENDOR.aliases ?? []).includes("github.com"), "🔴 §7 the shipped vendor carries the REGISTRY's aliases — a literal here would drift from the producer");

function githubCatalogue(): ConnectorCredentials {
  return defineConnectorCredentials({
    description: "github, for the registry arms",
    connector: GITHUB_CONNECTOR,
    allows: ["user-oauth"],
    humanActing: { supported: true, credentialTypes: ["user-oauth"] },
    credentials: [{ id: "user-oauth", type: "user-oauth", grantFamily: "human-acting", home: oauthConnectorHome("github.com/login/oauth"), lifecycle: { refresh: "refresh-token" } }],
  });
}
function researchNoteOnlyCatalogue(): ConnectorCredentials {
  return defineConnectorCredentials({
    description: "a vendor somebody researched and nobody configured",
    connector: "linear",
    allows: ["user-oauth"],
    humanActing: { supported: true, credentialTypes: ["user-oauth"] },
    credentials: [{ id: "workspace", type: "user-oauth", home: oauthConnectorHome("linear.app") }],
  });
}
ok(humanActingConnectors([githubCatalogue()]).includes(GITHUB_CONNECTOR), "§7 a catalogue with BOTH halves is a human-acting connector");
ok(!humanActingConnectors([researchNoteOnlyCatalogue()]).includes("linear"), "🔴 §7 a declared-but-unconfigured vendor is NOT — the research note alone never widens the grammar");
ok(humanActingConnectors([]).length === 0, "§7 no catalogues ⇒ no human-acting connectors");

const PLATFORM = "githubgatetestplatform";
registerIdentityMapper(PLATFORM, (c) => {
  const a = (c as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return { workspace: a?.["ws"], surface: a?.["room"], mode: "channel", visibility: "public", trust: "internal", principalId: "U_G" };
});

{
  const domain: Domain = defineDomain({ name: "gate-domain", reach: [`${PLATFORM}/W1/CROOM`] });
  const goodConfig = {
    loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/api"] })],
    loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "domain", domain: "gate-domain" } })],
    loadConnectorCredentials: () => [githubCatalogue()],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [domain],
    loadSilos: () => [],
    domainsForSurface: ({ workspaceKey, surface }: { workspaceKey?: string; surface?: string }) =>
      [domain].filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
  };
  registerConfig(goodConfig);

  ok(
    ownAccountAskVendors().some((v) => v.connector === GITHUB_CONNECTOR && (v.aliases ?? []).includes("github.com")),
    "🔴 §8 the producer's vendor list holds github WITH its aliases once the catalogue declares the family",
  );

  function producerCtx(sessionId: string, attrs: Record<string, unknown>): HookContext {
    return { session: { auth: { current: { attributes: attrs } }, id: sessionId, turn: { id: "turn_1" } } } as unknown as HookContext;
  }
  const delivery = (message: string): HookEvent<"message.received"> => ({ data: { message } }) as unknown as HookEvent<"message.received">;

  const bag: Record<string, unknown> = {};
  stampOwnAccountAsk(delivery("read acme/api#7 with my own GitHub account"), producerCtx("seat-1", bag));
  ok(bag["oe_own_account_ask"] === "seat-1|turn_1|github", "🔴 §8 a GitHub own-account ask is STAMPED — the fact a delegated worker reads");
  const aliasBag: Record<string, unknown> = {};
  stampOwnAccountAsk(delivery("read it with my own github.com login"), producerCtx("seat-2", aliasBag));
  ok(aliasBag["oe_own_account_ask"] === "seat-2|turn_1|github", "§8 …and so is the same ask spelled with the registry's alias");
  const plainBag: Record<string, unknown> = {};
  stampOwnAccountAsk(delivery("what is the status of PR 12 in acme/api?"), producerCtx("seat-3", plainBag));
  ok(plainBag["oe_own_account_ask"] === undefined, "§8 negative control: an ordinary GitHub ask is not stamped");

  const throwingConfig = {
    loadBundles: () => [],
    loadBindings: () => [],
    loadConnectorCredentials: (): readonly ConnectorCredentials[] => {
      throw new Error("catalogue unreadable");
    },
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  };
  registerConfig(throwingConfig);
  ok(humanActingConnectors().includes(GITHUB_CONNECTOR), "🔴 §8 an unreadable catalogue reuses the LAST GOOD list — it never narrows the grammar");
  _resetHumanActingCacheForTest();
  let thrown: unknown;
  try {
    humanActingConnectors();
  } catch (err) {
    thrown = err;
  }
  ok(thrown instanceof OwnAccountVendorsUnavailableError, "🔴 §8 an unreadable catalogue with nothing cached THROWS — `[]` would be a silent substitution");
  ok(String((thrown as Error).message).includes("OPE-1641"), "§8 …and the message names the defect it prevents, so an operator can act on it");
  let vendorsThrew = false;
  try {
    ownAccountAskVendors();
  } catch {
    vendorsThrew = true;
  }
  ok(vendorsThrew, "§8 the producer's vendor list propagates it rather than shortening itself");
  const degradedGrantBag: Record<string, unknown> = {};
  stampOwnAccountAsk(delivery("read it with my own notion account"), producerCtx("seat-9", degradedGrantBag));
  ok(degradedGrantBag["oe_own_account_ask"] === "seat-9|turn_1|notion", "🔴 §8 a degraded read still stamps the half that cannot fail — it never disarms the grammar wholesale");
  const seatStampedBag: Record<string, unknown> = { oe_own_account_ask: "seat-1|turn_1|github" };
  stampOwnAccountAsk(delivery("what did we ship last week?"), producerCtx("seat-1", seatStampedBag));
  ok(seatStampedBag["oe_own_account_ask"] === "seat-1|turn_1|github", "🔴 §8 …and a delivery it graded with the NARROWER list CLEARS NOTHING — the live seat stamp survives");
  registerConfig(goodConfig);
  _resetHumanActingCacheForTest();
  const gradableBag: Record<string, unknown> = { oe_own_account_ask: "seat-1|turn_1|github" };
  stampOwnAccountAsk(delivery("what did we ship last week?"), producerCtx("seat-1", gradableBag));
  ok(gradableBag["oe_own_account_ask"] === undefined, "§8 negative control: a delivery it CAN grade still clears this session's stale stamp");
}

{
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const SAVED: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string): void => {
    if (!(name in SAVED)) SAVED[name] = process.env[name];
    process.env[name] = value;
  };
  const savedGithub = getSettings().github;
  overrideSettingsForTest({ github: { appId: "222", appSlug: "open-everywhere", botUserId: "12345", installations: { acme: "4242" } } });
  setEnv("GITHUB_APP_PRIVATE_KEY", pkcs1);
  resetGitHubApp();

  let urls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "tok_4242", expires_at: "2099-01-01T00:00:00Z", repositories: [] }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/search/issues")) {
      return new Response(JSON.stringify({ items: [{ number: 1, title: "T", html_url: "u", repository_url: "https://api.github.com/repos/acme/api" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/\/(reviews|comments|check-runs)/u.test(String(url))) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(
      JSON.stringify({
        html_url: "https://github.com/acme/api/pull/7",
        title: "T",
        state: "open",
        merged_at: null,
        draft: false,
        updated_at: "2026-01-01T00:00:00Z",
        comments: 0,
        head: { sha: "deadbeef" },
        base: { repo: { private: false } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  function turn(stamp?: string, as: { id: string; root?: string } = { id: "seat-1" }): BindableContext {
    return {
      channel: { kind: PLATFORM },
      session: {
        auth: { current: { attributes: { ws: "W1", room: "CROOM", ...(stamp === undefined ? {} : { oe_own_account_ask: stamp }) }, principalId: "U_G", principalType: "test-user" } },
        id: as.id,
        ...(as.root === undefined ? {} : { parent: { rootSessionId: as.root } }),
      },
    } as unknown as BindableContext;
  }
  const GITHUB_STAMP = "seat-1|-|github";
  const NOTION_STAMP = "seat-1|-|notion";

  async function refusalOf(verb: () => Promise<unknown>): Promise<string | undefined> {
    urls = [];
    try {
      await verb();
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  const VERBS: readonly { name: string; run: (ctx: BindableContext) => Promise<unknown> }[] = [
    { name: "check_pr_status", run: (ctx) => checkPrStatusEntry.execute!({ repo: "acme/api", number: 7 }, ctx as never) as Promise<unknown> },
    { name: "get_pr_feedback", run: (ctx) => getPrFeedbackEntry.execute!({ repo: "acme/api", number: 7 }, ctx as never) as Promise<unknown> },
    { name: "read_github_issue", run: (ctx) => readGithubIssueEntry.execute!({ repo: "acme/api", number: 7 }, ctx as never) as Promise<unknown> },
    { name: "search", run: (ctx) => githubWorkSearchAdapter.search(ctx, undefined, "q", { limit: 5, insideDomain: false }) },
    { name: "walk_pr", run: (ctx) => walkPrEntry.execute!({ repo: "acme/api", number: 7 }, ctx as never) as Promise<unknown> },
  ];

  try {
    for (const verb of VERBS) {
      const refused = await refusalOf(() => verb.run(turn(GITHUB_STAMP)));
      ok(refused !== undefined, `🔴 §9 ${verb.name} REFUSES a turn that asked for the member's own GitHub account`);
      ok(refused?.includes("own github account") === true, `§9 …${verb.name} with the gate's own sentence, which names the account that was asked for`);
      ok(urls.length === 0, `§9 …and ${verb.name} fetched NOTHING — the refusal lands before the App installation is minted`);

      const worker = await refusalOf(() => verb.run(turn(GITHUB_STAMP, { id: "worker-9", root: "seat-1" })));
      ok(worker?.includes("own github account") === true, `🔴 §9 a DELEGATED worker running ${verb.name} is refused too`);

      const throughNotion = await refusalOf(() => verb.run(turn(NOTION_STAMP)));
      ok(throughNotion === undefined, `§9 negative control: a NOTION stamp does not refuse ${verb.name}`);
      const ordinaryRead = await refusalOf(() => verb.run(turn()));
      ok(ordinaryRead === undefined, `§9 negative control: an unstamped turn runs ${verb.name} normally`);
      ok(urls.length > 0, `§9 …and that ordinary ${verb.name} really reached GitHub, so the control is not vacuous`);
    }
  } finally {
    globalThis.fetch = savedFetch;
    resetGitHubApp();
    overrideSettingsForTest({ github: savedGithub });
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");

  const SCAN_ROOTS: readonly string[] = ["packages/core/agent", "packages/providers/github/agent"];

  function derivedResolverNames(): readonly string[] {
    const names: string[] = [];
    const scmDir = join(repoRoot, "packages/core/agent/scm");
    for (const entry of readdirSync(scmDir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || /-test\.ts$|\.test\.ts$/u.test(entry.name)) continue;
      const src = readFileSync(join(entry.parentPath, entry.name), "utf8");
      for (const m of src.matchAll(/export\s+(?:async\s+function|function|const)\s+(resolve\w*Token)\b/gu)) names.push(m[1]!);
    }
    for (const m of readFileSync(join(scmDir, "app.ts"), "utf8").matchAll(/^\s{2}async\s+(tokensForRepos)\s*\(/gmu)) names.push(m[1]!);
    return [...new Set(names)];
  }
  const RESOLVER_NAMES = derivedResolverNames();
  ok(RESOLVER_NAMES.length >= 4, `§9 the resolver names are derived from their exporting modules (${RESOLVER_NAMES.join(", ") || "none"})`);
  ok(RESOLVER_NAMES.includes("resolvePrWriteToken"), "🔴 §9 the WRITE resolver in its own module is derived too — a resolver that moves to a new file must not fall out of the scan");
  const RESOLVES_INSTALLATION_TOKEN = new RegExp(`\\b(?:${RESOLVER_NAMES.join("|")})\\b`, "u");

  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//gu, " ")
      .replace(/\/\/[^\n]*/gu, " ")
      .replace(/`[\s\S]*?`/gu, " ")
      .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''")
      .split("\n")
      .filter((line) => !/^\s*import\b/u.test(line) && !/^\s*\}\s*from\s/u.test(line) && !/^\s*export\s*\{/u.test(line))
      .join("\n");
  }

  const UNGATED_BY_DECISION: Readonly<Record<string, string>> = {
    "packages/core/agent/approvals/access-request.ts": "WRITE — it opens the access-request bot pull request",
    "packages/core/agent/approvals/agent-create.ts": "WRITE — it opens the create_agent bot pull request",
    "packages/core/agent/approvals/pr-open.ts": "WRITE — the approved open_pull_request execution",
    "packages/core/agent/approvals/webhook-declare.ts": "WRITE — it opens the declare_webhook bot pull request",
    "packages/core/agent/approvals/mcp-server-propose.ts": "WRITE — it opens the propose_mcp_server bot pull request",
    "packages/core/agent/approvals/allow-rule-pr.ts": "WRITE — it opens the domain rule bot pull request a person confirmed from a card (OPE-2456)",
    "packages/core/agent/approvals/email-sender.ts": "WRITE — it opens the allowed-sender bot pull request a person approved from a card (OPE-2440)",
    "packages/core/agent/credentials/config-pr-github.ts": "WRITE — it stages a config-repo pull request",
    "packages/core/agent/identity/groups-delivery.ts": "WRITE — it opens the group-overlay bot pull request",
    "packages/core/agent/routines/github-entity-read.ts":
      "INGRESS — a routine re-fetches an entity under the routine's own declared principal, with no requester turn behind it, so there is no own-account ask to honour",
    "packages/core/agent/scm/app.ts": "the mint itself — what every call site calls, not a call site",
    "packages/core/agent/scm/broker.ts": "the egress broker's mint, reached from checkout_repo, which is gated",
    "packages/core/agent/scm/config-repo-token.ts":
      "WRITE, and the resolver itself — the one mint the eight config-repo bot-PR flows share (OPE-1823); its eight call sites, approvals/access-request.ts, approvals/agent-create.ts, approvals/webhook-declare.ts, approvals/mcp-server-propose.ts, approvals/allow-rule-pr.ts, approvals/email-sender.ts, credentials/config-pr-github.ts and identity/groups-delivery.ts, are named on the same write decision",
    "packages/core/agent/scm/credential.ts":
      "the resolver itself — the one GitHub credential choice (OPE-2530) that write-token.ts, pr-status.ts and issue-actions.ts call; it has no requester turn of its own, and every call site is gated or named here",
    "packages/core/agent/scm/issue-actions.ts": "WRITE — issue-write permissions",
    "packages/core/agent/scm/pr-status.ts": "the resolvers themselves, not a call site",
    "packages/core/agent/scm/write-token.ts":
      "WRITE, and the resolver itself — the one mint both open_pull_request halves share (OPE-1794); its two call sites, tools/open_pull_request.ts and approvals/pr-open.ts, are named above on the same write decision",
    "packages/core/agent/tools/open_pull_request.ts": "WRITE",
    "packages/core/agent/tools/post_pr_walkthrough.ts": "WRITE — it reads status and diff to compose the post it makes",
    "packages/providers/github/agent/channels/github-catch-up.ts":
      "INGRESS — the standing seat's since-last-wake catch-up reads the room under the deployment's installation before a turn exists; no requester turn is behind it, so there is no own-account ask to honour; its container is the one the wake itself already admitted, so there is no requester-named repository a personal credential could answer differently",
    "packages/providers/github/agent/memory/memory.ts": "the memory backing — an org-default subtree pull with no requester turn behind it",
  };

  function tsUnder(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.isDirectory()) tsUnder(`${dir}/${entry.name}`, out);
      else if (entry.name.endsWith(".ts")) out.push(`${dir}/${entry.name}`);
    }
    return out;
  }

  const resolvers = SCAN_ROOTS.flatMap((root) => tsUnder(root)).filter((rel) => RESOLVES_INSTALLATION_TOKEN.test(codeOnly(readFileSync(join(repoRoot, rel), "utf8"))));
  ok(resolvers.length >= 20, `§9 the scan found the installation-token resolvers (${resolvers.length})`);
  ok(resolvers.some((r) => r.startsWith("packages/providers/github/")), "§9 the scan reaches the github bundle, not core alone");
  ok(resolvers.includes("packages/core/agent/routines/github-entity-read.ts"), "🔴 §9 the scan is RECURSIVE — it reaches a resolver outside agent/tools and agent/scm");
  for (const rel of resolvers) {
    const gated = /assertGithubActingIdentity\(/u.test(readFileSync(join(repoRoot, rel), "utf8"));
    const reason = UNGATED_BY_DECISION[rel];
    ok(
      gated || reason !== undefined,
      `🔴 §9 ${rel} resolves a GitHub installation token — gate it with \`assertGithubActingIdentity\`, or add it to UNGATED_BY_DECISION with the reason`,
    );
    ok(!(gated && reason !== undefined), `§9 ${rel} is gated OR exempted, never listed as both`);
  }
  for (const rel of Object.keys(UNGATED_BY_DECISION)) {
    ok(resolvers.includes(rel), `§9 UNGATED_BY_DECISION names ${rel}, which still resolves an installation token`);
  }
  for (const rel of ["packages/core/agent/tools/check_pr_status.ts", "packages/core/agent/tools/walk_pr.ts", "packages/core/agent/scm/github-search.ts", "packages/providers/github/agent/channels/github-read.ts"]) {
    ok(resolvers.includes(rel), `§9 the scan reaches ${rel}`);
  }

  const MINTER = "packages/providers/github/agent/channels/github-post-arm.ts";
  const SCAN_BLIND_SPOTS: Readonly<Record<string, string>> = {
    "packages/providers/github/agent/channels/github-reaction-feedback.ts":
      "INGRESS — the reaction-feedback poll reads the reactions on a comment the agent itself posted, with no requester turn behind it, so there is no own-account ask to honour",
  };
  const derivedBlindSpots = tsUnder("packages/providers/github/agent")
    .filter((rel) => rel !== MINTER && /\binstallationTokenFor\b/u.test(codeOnly(readFileSync(join(repoRoot, rel), "utf8"))))
    .sort();
  ok(
    JSON.stringify(derivedBlindSpots) === JSON.stringify(Object.keys(SCAN_BLIND_SPOTS).sort()),
    `🔴 §9 the DERIVED blind-spot set (${derivedBlindSpots.join(", ") || "none"}) matches what SCAN_BLIND_SPOTS declares — a NEW bundle module that mints through installationTokenFor lands here, with its reason, or this reds`,
  );
  ok(codeOnly(readFileSync(join(repoRoot, MINTER), "utf8")).includes("installationTokenFor"), `§9 the minter ${MINTER} is really the module that exports the mint — the subtraction above is not silently removing the wrong file`);
  for (const [rel, reason] of Object.entries(SCAN_BLIND_SPOTS)) {
    const source = codeOnly(readFileSync(join(repoRoot, rel), "utf8"));
    ok(/\binstallationTokenFor\b/u.test(source), `🔴 §9 ${rel} still mints through the bundle's own installationTokenFor — ${reason}`);
    ok(!resolvers.includes(rel), `🔴 §9 the tree scan CANNOT see ${rel}, which is why the doc names it by hand`);
  }
  const gatedReads = resolvers.filter((rel) => /assertGithubActingIdentity\(/u.test(readFileSync(join(repoRoot, rel), "utf8")));
  const blindReads = derivedBlindSpots.length;
  ok(gatedReads.length === 8, `🔴 §9 EIGHT reads call the seam (found ${gatedReads.length}) — connectors-and-providers.md states that number`);
  ok(gatedReads.length + blindReads === 9, `🔴 §9 the tree holds NINE GitHub reads (${gatedReads.length} gated + ${blindReads} the scan cannot see) — connectors-and-providers.md states that number`);
  assert.ok(true);
}

console.log(`✓ github acting identity: ${passed} assertions`);
