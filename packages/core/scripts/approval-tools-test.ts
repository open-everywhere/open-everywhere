import { __setTestValveForTest } from "../agent/testing/test-valves.js";
import setSpendLimitTool, { planSetSpendLimit, defaultScopeKey, hasApprovalCardPath } from "../agent/tools/set_spend_limit.js";
import { rosterStanding } from "../agent/spend/bypass.js";
import clearSpendLimitDynamic, { planClearSpendLimit } from "../agent/tools/clear_spend_limit.js";
import { planRevokeConnector } from "../agent/tools/revoke_connector.js";
import { planClearConnectorOverride } from "../agent/tools/clear_connector_override.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";
import { registerConfig } from "../agent/access/config.js";
import { registerCardPoster, cardPosterFor } from "../agent/approvals/flow.js";
import { PROPOSER_DECISION_NOTE, cardPostedTail, proposerTail } from "../agent/approvals/card-venue.js";
import { defineDomain } from "../agent/memory/domain.js";
import { execTool } from "./_tool-exec.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(msg.includes(needle), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

function slackBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return {
    org: "acme",
    platform: "slack",
    workspace: "T123",
    surface: "C456",
    mode: "channel",
    visibility: "public",
    trust: "internal",
    principalId: "U999",
    target: { channelId: "C456" },
    ...overrides,
  };
}

ok(defaultScopeKey(slackBinding(), "surface") === "slack/T123/C456", "defaultScopeKey surface = platform/workspace/surface");
ok(defaultScopeKey(slackBinding(), "workspace") === "slack/T123", "defaultScopeKey workspace = platform/workspace");
{
  const thread = slackBinding({ platform: "discord", workspace: "G1", surface: "T_THREAD", domainSurface: "C_PARENT", target: { channelId: "T_THREAD" } });
  ok(defaultScopeKey(thread, "surface") === "discord/G1/C_PARENT", "defaultScopeKey surface from a thread = the PARENT channel (domain/spend grain)");
  ok(defaultScopeKey(thread, "workspace") === "discord/G1", "defaultScopeKey workspace unaffected by thread grain");
}

const uncapped = { tokens: null, usd: null } as const;
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyTokens: 5_000_000, reason: "spike" }, { tokens: 1_000_000, usd: null }, "eng");
  ok(plan.kind === "spend.set", "planSetSpendLimit kind is spend.set");
  ok(plan.args.level === "surface", "planSetSpendLimit defaults level to surface");
  ok(plan.args.scopeKey === "slack/T123/C456", "planSetSpendLimit defaults scopeKey to this surface");
  ok(plan.scopeKey === plan.args.scopeKey, "planSetSpendLimit top-level scopeKey mirrors args.scopeKey");
  ok(plan.args.monthlyTokens === 5_000_000, "planSetSpendLimit freezes monthlyTokens");
  ok(plan.args.monthlyUsd === undefined, "planSetSpendLimit leaves an unproposed USD component absent (frozen args say only what changes)");
  ok(plan.args.reason === "spike", "planSetSpendLimit freezes reason");
  ok(plan.args.currentCap === 1_000_000, "planSetSpendLimit freezes the current token cap");
  ok(plan.args.currentUsd === null, "planSetSpendLimit freezes the current USD cap (null = uncapped)");
  ok(plan.args.org === "acme", "planSetSpendLimit freezes org from the binding");
  ok(plan.domain === "eng", "planSetSpendLimit freezes the passed-in domain");
}
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyUsd: 50, reason: "incident headroom" }, { tokens: null, usd: 25 }, null);
  ok(plan.args.monthlyUsd === 50 && plan.args.monthlyTokens === undefined, "planSetSpendLimit freezes a USD-only proposal");
  ok(plan.args.currentUsd === 25, "planSetSpendLimit freezes the current USD cap for the card");
}
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyTokens: 9, reason: "  trim  ", level: "workspace" }, uncapped, null);
  ok(plan.args.level === "workspace", "planSetSpendLimit honours an explicit level");
  ok(plan.args.scopeKey === "slack/T123", "planSetSpendLimit defaults scopeKey to the workspace for level:workspace");
  ok(plan.args.reason === "trim", "planSetSpendLimit trims reason");
  ok(plan.domain === null, "planSetSpendLimit passes through a null domain");
}
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyTokens: 1, reason: "x", scopeKey: "slack/T123/COTHER" }, uncapped, null);
  ok(plan.args.scopeKey === "slack/T123/COTHER", "planSetSpendLimit honours an explicit scopeKey override");
}
{
  registerCardPoster("discord", async () => undefined);
  ok(cardPosterFor("discord") !== undefined, "a registered card poster is what makes a platform card-capable");
  const plan = planSetSpendLimit(slackBinding({ platform: "discord", workspace: "G123", surface: "C456" }), { monthlyTokens: 1, reason: "x" }, uncapped, null);
  ok(plan.args.scopeKey === "discord/G123/C456", "planSetSpendLimit accepts a Discord binding (card path exists) and scopes to the guild surface");
}
ok(
  planSetSpendLimit(slackBinding({ platform: "teams" }), { monthlyTokens: 1, reason: "x" }, uncapped, null).kind === "spend.set",
  "planSetSpendLimit PLANS on a card-less surface — everything this pure layer can honestly answer (levels, scopes, amounts) is decidable without knowing where the card lands",
);
throwsWith(
  () => planSetSpendLimit(slackBinding({ principalId: undefined }), { monthlyTokens: 1, reason: "x" }, uncapped, null),
  "verified sender",
  "planSetSpendLimit refuses with no verified principal",
);
throwsWith(
  () => planSetSpendLimit(slackBinding(), { monthlyTokens: 1, reason: "   " }, uncapped, null),
  "non-empty reason",
  "planSetSpendLimit refuses a blank reason",
);
throwsWith(
  () => planSetSpendLimit(slackBinding(), { reason: "x" }, uncapped, null),
  "needs monthlyTokens or monthlyUsd",
  "planSetSpendLimit refuses a proposal with no cap component at all",
);

{
  const plan = planClearSpendLimit(slackBinding(), {}, { tokens: 2_000_000, usd: 75 }, null);
  ok(plan.kind === "spend.clear", "planClearSpendLimit kind is spend.clear");
  ok(plan.args.level === "surface", "planClearSpendLimit defaults level to surface");
  ok(plan.args.scopeKey === "slack/T123/C456", "planClearSpendLimit defaults scopeKey to this surface");
  ok(plan.args.currentCap === 2_000_000, "planClearSpendLimit freezes the current token cap");
  ok(plan.args.currentUsd === 75, "planClearSpendLimit freezes the current USD cap");
}
{
  const plan = planClearSpendLimit(slackBinding(), { level: "workspace" }, uncapped, "eng");
  ok(plan.args.scopeKey === "slack/T123", "planClearSpendLimit defaults scopeKey to the workspace for level:workspace");
  ok(plan.domain === "eng", "planClearSpendLimit freezes the passed-in domain");
}
{
  const plan = planClearSpendLimit(slackBinding({ platform: "discord", workspace: "G123", surface: "C456" }), {}, uncapped, null);
  ok(plan.args.scopeKey === "discord/G123/C456", "planClearSpendLimit accepts a Discord binding (card path exists)");
}
ok(
  planClearSpendLimit(slackBinding({ platform: "teams" }), {}, uncapped, null).kind === "spend.clear",
  "planClearSpendLimit PLANS on a card-less surface too — the pair MUST move together (OPE-312): a room that can raise a cap but never clear the override it set is a one-way door",
);
throwsWith(
  () => planClearSpendLimit(slackBinding({ principalId: undefined }), {}, uncapped, null),
  "verified sender",
  "planClearSpendLimit refuses with no verified principal",
);

{
  const plan = planRevokeConnector(slackBinding(), { connector: "notion", reason: "leaked token" }, "eng");
  ok(plan.kind === "connector.revoke", "planRevokeConnector kind is connector.revoke");
  ok(plan.args.connector === "notion", "planRevokeConnector freezes connector");
  ok(plan.args.reason === "leaked token", "planRevokeConnector freezes reason");
  ok(plan.args.scopeKey === "slack/T123/C456", "planRevokeConnector defaults scopeKey to this surface (no level concept)");
  ok(plan.domain === "eng", "planRevokeConnector freezes the passed-in domain");
}
{
  const plan = planRevokeConnector(slackBinding(), { connector: "  jira  ", reason: "x", scopeKey: "slack/T123/COTHER" }, null);
  ok(plan.args.connector === "jira", "planRevokeConnector trims connector");
  ok(plan.args.scopeKey === "slack/T123/COTHER", "planRevokeConnector honours an explicit scopeKey override");
}
ok(
  planRevokeConnector(slackBinding({ platform: "linear" }), { connector: "notion", reason: "x" }, null).kind === "connector.revoke",
  "planRevokeConnector PLANS on a card-less surface (OPE-303) — WHERE the card goes is the venue walk's question, asked in execute() where config can be read, not a property of the asking room",
);
throwsWith(
  () => planRevokeConnector(slackBinding({ principalId: undefined }), { connector: "notion", reason: "x" }, null),
  "verified sender",
  "planRevokeConnector refuses with no verified principal",
);
throwsWith(
  () => planRevokeConnector(slackBinding(), { connector: "  ", reason: "x" }, null),
  "non-empty connector",
  "planRevokeConnector refuses a blank connector name",
);
throwsWith(
  () => planRevokeConnector(slackBinding(), { connector: "notion", reason: "   " }, null),
  "non-empty reason",
  "planRevokeConnector refuses a blank reason",
);

{
  const plan = planClearConnectorOverride(slackBinding(), { connector: "notion" }, "eng");
  ok(plan.kind === "connector.clear", "planClearConnectorOverride kind is connector.clear");
  ok(plan.args.connector === "notion", "planClearConnectorOverride freezes connector");
  ok(plan.args.scopeKey === "slack/T123/C456", "planClearConnectorOverride defaults scopeKey to this surface");
  ok(plan.domain === "eng", "planClearConnectorOverride freezes the passed-in domain");
}
ok(
  planClearConnectorOverride(slackBinding({ platform: "linear" }), { connector: "notion" }, null).kind === "connector.clear",
  "planClearConnectorOverride PLANS on a card-less surface too — the pair moves together, as it must",
);

{
  ok(hasApprovalCardPath("discord") && !hasApprovalCardPath("teams"), "card-path: a REGISTERED poster makes a surface card-capable and an unregistered one does not — the predicate is a capability question, not a list of names");
  ok(
    planRevokeConnector(slackBinding({ platform: "discord" }), { connector: "notion", reason: "x" }, null).kind === "connector.revoke",
    "card-path: 🔴 …and break-glass revoke PLANS on Discord — the capability the `slack` literal was withholding from a surface that could render the card all along",
  );
  ok(
    planClearConnectorOverride(slackBinding({ platform: "discord" }), { connector: "notion" }, null).kind === "connector.clear",
    "card-path: …and so does its clear, which MUST widen with it — revoke-without-clear would be a one-way door",
  );
}
throwsWith(
  () => planClearConnectorOverride(slackBinding({ principalId: undefined }), { connector: "notion" }, null),
  "verified sender",
  "planClearConnectorOverride refuses with no verified principal",
);
throwsWith(
  () => planClearConnectorOverride(slackBinding(), { connector: "  " }, null),
  "non-empty connector",
  "planClearConnectorOverride refuses a blank connector name",
);

function discordDmBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return slackBinding({ platform: "discord", workspace: "300000000000000104", surface: "D1", mode: "dm", target: { channelId: "D1" }, ...overrides });
}
const setInput = { monthlyUsd: 0.1, reason: "test" } as const;
throwsWith(
  () => planSetSpendLimit(discordDmBinding(), { ...setInput, level: "workspace" }, uncapped, null),
  "belongs to no server",
  "planSetSpendLimit refuses a Discord-DM workspace default (would target the DM bucket, not a server)",
);
{
  const plan = planSetSpendLimit(discordDmBinding(), setInput, uncapped, null);
  ok(plan.args.scopeKey === "discord/300000000000000104/D1", "planSetSpendLimit ALLOWS a DM surface default now that the gate enforces it (OPE-267)");
}
{
  const plan = planSetSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), setInput, uncapped, null);
  ok(plan.args.scopeKey === "slack/T123/D9", "planSetSpendLimit ALLOWS a Slack-DM surface default too");
}
throwsWith(
  () => planSetSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), { ...setInput, level: "domain" }, uncapped, null),
  "spans every DM",
  "planSetSpendLimit still refuses a DM domain default — re-anchored onto BLAST RADIUS (it would cap everyone's DM), which stays true",
);
{
  const plan = planSetSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), { ...setInput, level: "workspace" }, uncapped, null);
  ok(plan.args.scopeKey === "slack/T123", "planSetSpendLimit ALLOWS a Slack-DM workspace default (a Slack DM keeps its real team id)");
}
{
  const plan = planSetSpendLimit(discordDmBinding(), { ...setInput, level: "workspace", scopeKey: "discord/G777" }, uncapped, null);
  ok(plan.args.scopeKey === "discord/G777", "planSetSpendLimit ALLOWS an explicit scopeKey from a DM (the escape hatch)");
}
throwsWith(
  () => planClearSpendLimit(discordDmBinding(), { level: "workspace" }, uncapped, null),
  "belongs to no server",
  "planClearSpendLimit refuses a Discord-DM workspace default",
);
{
  const plan = planClearSpendLimit(discordDmBinding(), { level: "workspace", scopeKey: "discord/G777" }, uncapped, null);
  ok(plan.args.scopeKey === "discord/G777", "planClearSpendLimit ALLOWS an explicit scopeKey from a DM");
}

throwsWith(
  () => defaultScopeKey(slackBinding(), "domain"),
  "has no default here",
  "defaultScopeKey: level:\"domain\" throws when this channel isn't a member of any domain (no config registered)",
);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "eng", reach: ["slack/T123/C456"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
ok(defaultScopeKey(slackBinding(), "domain") === "eng", 'defaultScopeKey: level:"domain" defaults to the CURRENT channel\'s own domain name');
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyTokens: 100, reason: "domain budget", level: "domain" }, uncapped, "eng");
  ok(plan.args.level === "domain", "planSetSpendLimit accepts level:\"domain\"");
  ok(plan.args.scopeKey === "eng", 'planSetSpendLimit defaults scopeKey to the domain name for level:"domain"');
}
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyUsd: 5, reason: "x", level: "domain", scopeKey: "sales" }, uncapped, "sales");
  ok(plan.args.level === "domain" && plan.args.scopeKey === "sales", "planSetSpendLimit honours an explicit domain scopeKey");
}
{
  const plan = planClearSpendLimit(slackBinding(), { level: "domain" }, uncapped, "eng");
  ok(plan.args.level === "domain" && plan.args.scopeKey === "eng", 'planClearSpendLimit defaults scopeKey to the domain name for level:"domain"');
}
throwsWith(
  () => planSetSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), { monthlyTokens: 1, reason: "x", level: "domain" }, uncapped, null),
  "spans every DM in the deployment",
  'planSetSpendLimit refuses a DM-defaulted level:"domain" scope (blast radius, not unenforceability)',
);
throwsWith(
  () => planClearSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), { level: "domain" }, uncapped, null),
  "spans every DM in the deployment",
  'planClearSpendLimit refuses a DM-defaulted level:"domain" scope',
);
{
  const plan = planSetSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), { monthlyTokens: 1, reason: "x", level: "domain", scopeKey: "eng" }, uncapped, "eng");
  ok(plan.args.scopeKey === "eng", 'planSetSpendLimit ALLOWS an explicit domain scopeKey from a DM (the escape hatch)');
}

ok(rosterStanding(["admin"], null) === true, "rosterStanding: org admin bypasses everywhere (no covering domain needed)");
ok(rosterStanding(["domain:eng"], "eng") === true, "rosterStanding: a domain admin bypasses inside their own domain");
ok(rosterStanding(["domain:eng"], "sales") === false, "rosterStanding: a domain admin does NOT bypass another domain's surface");
ok(rosterStanding(["domain:eng"], null) === false, "rosterStanding: a domain admin does NOT bypass an un-domained surface");
ok(rosterStanding([], "eng") === false, "rosterStanding: FAIL-CLOSED on no roles");

{
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");
  let scanned = 0;
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(toolsDir, f), "utf8");
    if (!src.includes("defineDynamic")) continue;
    scanned++;
    ok(
      !/^\s*approval:/m.test(src),
      `dynamic tool ${f} must NOT set \`approval:\` (breaks on resumed sessions — see pin comment)`,
    );
  }
  ok(scanned >= 5, `source scan actually covered the dynamic tools (saw ${scanned})`);
}

type ResolvedEntry = { description: string; execute(input: unknown, ctx: unknown): Promise<{ pendingId: string }> };
async function resolveClearSpendLimit(ctx: unknown): Promise<ResolvedEntry | null> {
  const handler = (clearSpendLimitDynamic as unknown as { events: Record<string, (event: unknown, ctx: unknown) => unknown> }).events["session.started"];
  return (await handler({}, ctx)) as ResolvedEntry | null;
}

{
  const clearEntry = await resolveClearSpendLimit({ channel: { kind: "slack" } });
  ok(clearEntry !== null, "clear_spend_limit resolves on a card-capable platform (so its description is readable here)");
  const descriptions: [string, string][] = [
    ["set_spend_limit", (setSpendLimitTool as unknown as { description: string }).description],
    ["clear_spend_limit", clearEntry!.description],
  ];
  for (const [name, desc] of descriptions) {
    ok(typeof desc === "string" && desc.length > 0, `${name} has a model-facing description`);
    ok(!/DM usage is uncapped/i.test(desc), `${name}: the description no longer claims DM usage is uncapped (false since OPE-267)`);
    ok(!/DM usage is never gated/i.test(desc), `${name}: …nor that DM usage is never gated`);
    ok(!/From a DM you MUST pass scopeKey/i.test(desc), `${name}: the description no longer demands an explicit scopeKey for every DM proposal`);
    ok(/DM turns are spend-capped/i.test(desc), `${name}: the description states that a DM is capped`);
    ok(/level:"surface"/.test(desc) && /THIS DM/.test(desc), `${name}: …and that the default level:"surface" targets THIS DM (the ask an over-budget admin actually makes)`);
    ok(/level:"domain" needs an explicit scopeKey/.test(desc), `${name}: the description keeps the DM domain-default refusal`);
    ok(/level:"workspace" on Discord/.test(desc), `${name}: …and the Discord-DM workspace-default refusal, which is platform-specific (a Slack DM keeps a real team id)`);
    ok(/level:"user"/.test(desc), `${name}: the description tells the model the per-user level exists`);
    ok(/user:<platform>\/<id>/.test(desc), `${name}: …and shows the principal scope key's SHAPE, which nothing else in the grammar would suggest`);
    ok(/USER-LEVEL[\s\S]{0,200}ORG ADMIN/.test(desc), `${name}: …and states the org-admin-only approval bar for it, so the model does not promise the asker a domain admin can approve`);
  }
}

{
  const { tmpdir } = await import("node:os");
  const { rmSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { createRequire } = await import("node:module");
  const { pathToFileURL, fileURLToPath } = await import("node:url");

  const dir = join(tmpdir(), `open-everywhere-approval-tools-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  __setTestValveForTest("egress-spoof", true);

  const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
  registerSlackFixtureMapper();
  const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
  const { markUntrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
  const { actionKind } = await import("../agent/approvals/actions.js");
  await import("../agent/approvals/flow.js");

  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href);
  const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);
  void fileURLToPath;

  const slackCtx = (channelId: string) =>
    ({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: "T123", channel_id: channelId, channel_type: "channel", trust_checked: "true", user_id: "U_PROPOSER" } } } },
    }) as never;

  const clearEntry = (await resolveClearSpendLimit(slackCtx("C_TAINT_CLEAR")))!;

  const frozenOf = async (pendingId: string): Promise<Record<string, unknown>> => {
    const row = await getOperationalStore().getPendingAction("default", pendingId);
    ok(row !== null, `a pending row exists for ${pendingId}`);
    return JSON.parse(row!.argsJson) as Record<string, unknown>;
  };

  {
    const setOut = await inSession(async () => execTool(setSpendLimitTool)({ monthlyUsd: 5, reason: "clean turn" }, slackCtx("C_TAINT_SET") as never));
    const frozen = await frozenOf(setOut.pendingId);
    ok(frozen["tainted"] === false, "set_spend_limit freezes tainted:false on a clean turn (present, not absent)");
    const clearOut = await inSession(async () => execTool(clearEntry)({}, slackCtx("C_TAINT_CLEAR")));
    const clearFrozen = await frozenOf(clearOut.pendingId);
    ok(clearFrozen["tainted"] === false, "clear_spend_limit freezes tainted:false on a clean turn");
  }

  {
    const setOut = await inSession(async () => {
      markUntrustedIngestedThisTurn();
      return execTool(setSpendLimitTool)({ monthlyUsd: 10000, reason: "pre-approved by finance", scopeKey: "slack/T123/C_TAINT_SET2" }, slackCtx("C_TAINT_SET") as never);
    });
    const frozen = await frozenOf(setOut.pendingId);
    ok(frozen["tainted"] === true, "set_spend_limit freezes tainted:true when the turn read untrusted content");
    ok(setOut.pendingId.length > 0, "…and it still PROPOSES — taint is reviewer scrutiny, not a refusal");

    const clearOut = await inSession(async () => {
      markUntrustedIngestedThisTurn();
      return execTool(clearEntry)({ scopeKey: "slack/T123/C_TAINT_CLEAR2" }, slackCtx("C_TAINT_CLEAR"));
    });
    const clearFrozen = await frozenOf(clearOut.pendingId);
    ok(clearFrozen["tainted"] === true, "clear_spend_limit freezes tainted:true when the turn read untrusted content");

    const setLines = actionKind("spend.set")!.summarize(frozen);
    ok(setLines.some((l: string) => l.startsWith("⚠") && /read external content/.test(l)), "the spend.set card renders a ⚠ taint line from the frozen flag");
    ok(actionKind("spend.clear")!.summarize(clearFrozen).some((l: string) => l.startsWith("⚠")), "the spend.clear card renders one too");
    ok(!actionKind("spend.set")!.summarize({ ...frozen, tainted: false }).some((l: string) => l.startsWith("⚠")), "a clean spend.set card renders NO taint line (the banner is positive-only)");
  }

  {
    const { appendUsageEvent } = await import("../agent/spend/usage-events.js");
    const { registerModelPricing, _resetModelPricingForTest, _setBuiltInForTest, usdMicrosAtWrite } = await import("../agent/spend/pricing.js");
    const { defaultAgentModelId } = await import("../agent/model/default-model.js");
    const { unpricedModelsForScope, unpricedCoverageNote } = await import("../agent/tools/set_spend_limit.js");

    _resetModelPricingForTest();
    registerModelPricing({ "test/priced-model": { inPerMtok: 1, outPerMtok: 2 } });
    const domainsForCoverage = [defineDomain({ name: "eng", reach: ["slack/T123/C456"] }), defineDomain({ name: "dm", match: "dm" })];
    const registerDomains = (list: ReturnType<typeof defineDomain>[]): void => {
      registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => list, loadSilos: () => [], domainsForSurface: () => [] });
    };
    registerDomains(domainsForCoverage);

    const seed = async (surfaceKey: string, model: string | undefined): Promise<void> => {
      await appendUsageEvent({
        org: "default",
        surfaceKey,
        sessionId: `s-${surfaceKey}-${model ?? "none"}`,
        principalId: "U_SPENDER",
        kind: "channel",
        ...(model !== undefined ? { model } : {}),
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });
    };
    await seed("slack/T123/C_COVER", "test/priced-model");
    await seed("slack/T123/C_COVER", "test/no-rate-model");
    await seed("slack/T123/C_COVER2", "test/neighbour-no-rate-model");
    await seed("slack/T123/C_ALLPRICED", "test/priced-model");

    const setOut = await inSession(async () =>
      execTool(setSpendLimitTool)({ monthlyUsd: 50, reason: "incident headroom", scopeKey: "slack/T123/C_COVER" }, slackCtx("C_COVER") as never),
    );
    const reported = (setOut as { unpricedModels?: string[] }).unpricedModels;
    ok(JSON.stringify(reported) === JSON.stringify(["test/no-rate-model"]), `🔴 OPE-1193: a USD proposal names EXACTLY the scope's unpriced models under unpricedModels (got ${JSON.stringify(reported)})`);
    ok(/Pricing coverage/.test(setOut.note) && setOut.note.includes("test/no-rate-model"), "OPE-1193: …and the note carries the sentence the model must relay, naming the model");
    ok(setOut.requested === true, "🔴 OPE-1193: the proposal still POSTS — pricing coverage is a report, never a refusal");
    ok(setOut.note.includes(PROPOSER_DECISION_NOTE.trim()), `🔴 OPE-2071: a requested:true set_spend_limit result carries the fixed decision note (${setOut.note})`);
    ok(setOut.note.includes("owning conversation session") && setOut.note.includes("Report the pending id and finish."), "OPE-2071: …naming the OWNING session and the finish instruction");
    ok(!setOut.note.includes("REJECTED by"), "OPE-2071 NEGATIVE CONTROL: no prior reject ⇒ no rejection line");
    const coverFrozen = await frozenOf(setOut.pendingId);
    ok(coverFrozen["monthlyUsd"] === 50 && coverFrozen["scopeKey"] === "slack/T123/C_COVER", "🔴 OPE-1193: …and the pending row is frozen with the proposed cap, unchanged by the report");
    ok(
      JSON.stringify(coverFrozen["coverage"]) === JSON.stringify({ measured: "gap", windowDays: 30, unratedModels: ["test/no-rate-model"], unobservedModels: [] }),
      `🔴 OPE-1482: the pending row FREEZES the gap for the card to render (got ${JSON.stringify(coverFrozen["coverage"])})`,
    );

    const cleanOut = await inSession(async () =>
      execTool(setSpendLimitTool)({ monthlyUsd: 50, reason: "fully priced", scopeKey: "slack/T123/C_ALLPRICED" }, slackCtx("C_COVER") as never),
    );
    ok((cleanOut as { unpricedModels?: string[] }).unpricedModels === undefined, "OPE-1193: a scope whose models are all priced reports NO unpricedModels field");
    ok(!/Pricing coverage/.test(cleanOut.note), "OPE-1193: …and its note carries no coverage sentence");
    ok(
      JSON.stringify((await frozenOf(cleanOut.pendingId))["coverage"]) === JSON.stringify({ measured: "full", windowDays: 30 }),
      "🔴 OPE-1482: a fully priced scope freezes \"full\" — a distinct state, never the empty list a failed read would also produce",
    );

    const quietOut = await inSession(async () =>
      execTool(setSpendLimitTool)({ monthlyUsd: 50, reason: "quiet room", scopeKey: "slack/T123/C_QUIET" }, slackCtx("C_COVER") as never),
    );
    ok(
      JSON.stringify((await frozenOf(quietOut.pendingId))["coverage"]) === JSON.stringify({ measured: "no-traffic", windowDays: 30 }),
      "🔴 OPE-1482: a scope with no traffic in the window freezes \"no-traffic\", never the full-coverage tick",
    );
    ok(!/Pricing coverage/.test(quietOut.note), "OPE-1482: …and the REPLY stays silent about it — there is no missing rate for the asker to go and commit");

    const tokensOnly = await inSession(async () =>
      execTool(setSpendLimitTool)({ monthlyTokens: 5_000_000, reason: "token bridge", scopeKey: "slack/T123/C_COVER" }, slackCtx("C_COVER") as never),
    );
    ok((tokensOnly as { unpricedModels?: string[] }).unpricedModels === undefined, "OPE-1193: a token-only proposal reports no pricing coverage — a token cap counts every call");
    ok((await frozenOf(tokensOnly.pendingId))["coverage"] === undefined, "OPE-1482: …and it freezes none either, so its card and audit row stay byte-identical to the pre-OPE-1482 shape");

    const atSurface = await unpricedModelsForScope("default", "surface", "slack/T123/C_COVER");
    ok(JSON.stringify(atSurface.models) === JSON.stringify(["test/no-rate-model"]), `🔴 OPE-1193: the surface read matches the key EXACTLY — "C_COVER2" is not swept in (got ${JSON.stringify(atSurface.models)})`);
    const atWorkspace = await unpricedModelsForScope("default", "workspace", "slack/T123");
    ok(atWorkspace.models.includes("test/no-rate-model") && atWorkspace.models.includes("test/neighbour-no-rate-model"), "OPE-1193: the workspace read spans the whole prefix, so it sees both channels' gaps");

    const criteriaRead = await unpricedModelsForScope("default", "domain", "dm");
    ok(criteriaRead.notMeasurable !== undefined && criteriaRead.models.length === 0, "🔴 OPE-1193: a CRITERIA domain reports notMeasurable, not an empty list that reads as \"no gap\"");
    ok(/criteria domain/i.test(criteriaRead.notMeasurable ?? ""), "OPE-1193: …and says why, in terms the reader can act on");
    const explicitRead = await unpricedModelsForScope("default", "domain", "eng");
    ok(explicitRead.notMeasurable === undefined, "OPE-1193: an EXPLICIT domain is measurable — the not-measurable answer is specific to the criteria layer, not a blanket give-up");

    await seed("slack/T123/C_UNSTAMPED", undefined);
    _setBuiltInForTest({});
    const noSole = await unpricedModelsForScope("default", "surface", "slack/T123/C_UNSTAMPED");
    ok(usdMicrosAtWrite({ inputTokens: 1_000_000, outputTokens: 500_000 }) === 0, "OPE-1193 control: with no sole configured model the ledger prices a stampless row at $0");
    ok(noSole.models.includes("(unstamped)"), "🔴 OPE-1193: …and the report lists it as (unstamped) — the seeded row is really there, and the fallback branch is really reached");
    _setBuiltInForTest({ [defaultAgentModelId()]: { inPerMtok: 1, outPerMtok: 2 } });
    const withSole = await unpricedModelsForScope("default", "surface", "slack/T123/C_UNSTAMPED");
    ok(usdMicrosAtWrite({ inputTokens: 1_000_000, outputTokens: 500_000 }) > 0, "OPE-1193 control: with the deploy's own model priced the ledger prices a stampless row above $0");
    ok(!withSole.models.includes("(unstamped)"), "🔴 OPE-1193: …and the report drops it — the tool's rule and usdMicrosAtWrite's agree in BOTH directions");
    _setBuiltInForTest(null);

    const mixed = unpricedCoverageNote({ models: ["(unknown)", "test/no-rate-model"] }, "slack/T123/C_COVER");
    ok(/no committed price: test\/no-rate-model/.test(mixed), "OPE-1193: a real model id gets the PRICING remedy — commit the rate");
    ok(/instrumentation gap/.test(mixed) && /\(unknown\)/.test(mixed), "🔴 OPE-1193: …and (unknown) gets the INSTRUMENTATION sentence instead, never 'commit a rate' for an id that does not exist");
    ok(!/no committed price: [^.]*\(unknown\)/.test(mixed), "🔴 OPE-1193: …and (unknown) never appears in the commit-a-rate list");
    ok(unpricedCoverageNote({ models: [] }, "slack/T123/C_COVER") === "", "OPE-1193: a clean scope adds no sentence at all");

    {
      const real = getOperationalStore();
      const throwing = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "usageSummary") {
            return () => {
              throw new Error("ledger unavailable (test)");
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      registerOperationalStore(throwing);
      resetOperationalStore();
      const brokenOut = await inSession(async () =>
        execTool(setSpendLimitTool)({ monthlyUsd: 75, reason: "ledger down", scopeKey: "slack/T123/C_BROKEN" }, slackCtx("C_COVER") as never),
      );
      registerOperationalStore(real);
      resetOperationalStore();
      ok(/Pricing coverage NOT MEASURED/.test(brokenOut.note), "🔴 OPE-1193: a failed ledger read SAYS SO in the note — never the same silence a fully priced scope produces");
      ok((brokenOut as { unpricedModels?: string[] }).unpricedModels === undefined, "OPE-1193: …and it names no models, because it measured none");
      ok(brokenOut.requested === true, "🔴 OPE-1193: …and the proposal still POSTS — a broken read is not a refusal either");
      const brokenFrozen = await frozenOf(brokenOut.pendingId);
      ok(
        (brokenFrozen["coverage"] as { measured?: string } | undefined)?.measured === "none",
        `🔴 OPE-1482: a failed ledger read freezes the NOT-MEASURED state for the card, never "full" (got ${JSON.stringify(brokenFrozen["coverage"])})`,
      );
      const workingOut = await inSession(async () =>
        execTool(setSpendLimitTool)({ monthlyUsd: 75, reason: "ledger up", scopeKey: "slack/T123/C_BROKEN2" }, slackCtx("C_COVER") as never),
      );
      ok(!/NOT MEASURED/.test(workingOut.note), "OPE-1193: a working read never claims NOT MEASURED — the sentence is specific to the failure");
    }

    {
      const desc = (setSpendLimitTool as unknown as { description: string }).description;
      ok(/Pricing coverage/.test(desc), "🔴 OPE-1193: the description keys the relay exception on the note's \"Pricing coverage\" sentence, which BOTH branches emit");
      ok(!/carries `unpricedModels`/.test(desc), "🔴 OPE-1193: …and no longer keys it on a field the not-measurable branch never sets");
      const gapNote = unpricedCoverageNote({ models: ["test/no-rate-model"] }, "slack/T123/C_COVER");
      const unmeasuredNote = unpricedCoverageNote({ models: [], notMeasurable: "the usage ledger could not be read on this turn, so no coverage was measured." }, "slack/T123/C_COVER");
      ok(/Pricing coverage/.test(gapNote) && /Pricing coverage/.test(unmeasuredNote), "OPE-1193: …and both branches really do carry that prefix, so the key matches what the tool emits");
    }

    _resetModelPricingForTest();
    registerDomains([defineDomain({ name: "eng", reach: ["slack/T123/C456"] })]);
  }

  __setTestValveForTest("egress-spoof", false);
}

{
  const { assertScopeKeyShapeForLevel, LEVELS } = await import("../agent/tools/set_spend_limit.js");
  const { CAP_LEVELS } = await import("../agent/operational/store.js");

  ok(JSON.stringify([...LEVELS]) === JSON.stringify([...CAP_LEVELS]), "OPE-274: set_spend_limit's LEVELS is operational/store.ts's CAP_LEVELS, not a second list");
  ok((CAP_LEVELS as readonly string[]).includes("user"), 'OPE-274: "user" is a level the spend_limit row can persist');

  ok(defaultScopeKey(slackBinding(), "user") === "user:slack/T123/U999", "OPE-274: level:\"user\" defaults to the ACTING sender's own qualified scope key");
  ok(defaultScopeKey(slackBinding({ platform: "discord", workspace: "G1", principalId: "3575545974" }), "user") === "user:discord/3575545974", "OPE-274: …qualified by the SURFACE's platform, so two vendors' id namespaces never collide");
  throwsWith(
    () => defaultScopeKey(slackBinding({ principalAttested: true } as Partial<SurfaceBinding>), "user"),
    'level:"user" has no default here',
    "🔴 OPE-274: a triggered fire cannot default a per-user proposal onto the person it is attributed to",
  );

  const dm = slackBinding({ mode: "dm", surface: "D1", target: { channelId: "D1" } });
  const dmPlan = planSetSpendLimit(dm, { monthlyUsd: 20, reason: "my own headroom", level: "user" }, uncapped, null);
  ok(dmPlan.args.level === "user" && dmPlan.args.scopeKey === "user:slack/T123/U999", 'OPE-274: level:"user" from a DM defaults to the asker and is accepted (nothing about a person is ambiguous in a DM)');

  const other = planSetSpendLimit(slackBinding(), { monthlyTokens: 5, reason: "trim", level: "user", scopeKey: "user:slack/T123/U_OTHER" }, uncapped, null);
  ok(other.args.scopeKey === "user:slack/T123/U_OTHER" && other.scopeKey === other.args.scopeKey, "OPE-274: an explicit principal scope key is frozen verbatim — the proposed scope is one the proposer NAMED, never re-derived at click time");

  throwsWith(() => planSetSpendLimit(slackBinding(), { monthlyTokens: 5, reason: "x", level: "user", scopeKey: "slack/T123" }, uncapped, null), "addresses a place, not a person", '🔴 OPE-274: level:"user" with a TENANT key is refused — it would store an allowance nobody can present');
  throwsWith(() => planSetSpendLimit(slackBinding(), { monthlyTokens: 5, reason: "x", level: "user", scopeKey: "slack/T123/U1" }, uncapped, null), "addresses a place, not a person", "🔴 OPE-274: …and an UNMARKED principal key is refused for the same reason — it parses as a tenant");
  throwsWith(() => planSetSpendLimit(slackBinding(), { monthlyTokens: 5, reason: "x", level: "surface", scopeKey: "user:slack/T123/U1" }, uncapped, null), "only works with level:\"user\"", "OPE-274: and the converse — a PERSON's key under level:\"surface\" would gate nothing, so it is refused");
  throwsWith(() => planClearSpendLimit(slackBinding(), { level: "user", scopeKey: "eng" }, uncapped, null), "addresses a place, not a person", "OPE-274: the CLEAR half carries the same fence — the pair moves together (OPE-303's rule)");
  assertScopeKeyShapeForLevel("t", "domain", "payments");
  assertScopeKeyShapeForLevel("t", "surface", "not-really-a-surface-key");
  ok(true, "OPE-274: the shape fence checks the USER level in both directions and leaves the other three's latitude untouched");

  const { readFileSync } = await import("node:fs");
  const setSrc = readFileSync(new URL("../agent/tools/set_spend_limit.ts", import.meta.url), "utf8");
  const clearSrc = readFileSync(new URL("../agent/tools/clear_spend_limit.ts", import.meta.url), "utf8");
  ok(/level === "user" \? null :/.test(setSrc) && /level === "user" \? null :/.test(clearSrc), "🔴 OPE-274: both propose tools freeze `domain: null` for a user-level proposal — a person's allowance is never a domain's business");
}

{
  const venue = { platform: "slack", channelId: "C1", surfaceKey: "slack/T1/C1", sameRoom: true } as const;
  const plain = cardPostedTail(venue, "approve it", {});
  ok(plain === PROPOSER_DECISION_NOTE, "OPE-2071: a same-room card with no prior reject gets exactly the fixed decision note");
  ok(!plain.includes("REJECTED"), "OPE-2071 NEGATIVE CONTROL: no prior reject ⇒ no rejection line");
  const withReject = proposerTail({ priorRejection: { decidedBy: "U_ADMIN", decidedAt: "2026-04-19T06:40:13Z" } });
  ok(withReject.startsWith(PROPOSER_DECISION_NOTE), "OPE-2071: the rejection line follows the fixed note");
  ok(withReject.includes("REJECTED by U_ADMIN at 2026-04-19T06:40:13Z"), `🔴 OPE-2071: the rejection line names who and when (${withReject})`);
  ok(withReject.includes("stop and report the rejection"), "OPE-2071: the rejection line tells a self-retrying proposer to stop");
  const redirected = cardPostedTail({ ...venue, surfaceKey: "slack/T1/C2", sameRoom: false }, "approve it", {});
  ok(redirected.includes("tell the user where it is") && redirected.endsWith(PROPOSER_DECISION_NOTE), "OPE-2071: a redirected card keeps its redirect instruction AND gets the note");

  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");
  let scanned = 0;
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(toolsDir, f), "utf8");
    if (!/\brequestApproval\(/.test(src)) continue;
    scanned++;
    const tails = (src.match(/\b(cardPostedTail|proposerTail)\([^)]*\bposted\)/g) ?? []).length;
    ok(tails >= 1, `🔴 OPE-2071: tool ${f} calls requestApproval, so its card-path result must pass through cardPostedTail/proposerTail with \`posted\``);
    ok(!/\bdescribeVenueRedirect\(/.test(src), `OPE-2071: tool ${f} must not build a card tail with the bare redirect (it skips the decision note)`);
  }
  ok(scanned >= 20, `OPE-2071: the source scan covered the approval-raising tools (saw ${scanned})`);
}

console.log(`✓ ${passed} approval-tools assertions passed`);
