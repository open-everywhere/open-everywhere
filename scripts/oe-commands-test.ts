import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { createHmac } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import type { SurfaceBinding } from "@open-everywhere/core/agent/identity/binding.js";
import type { RequestApprovalInput } from "@open-everywhere/core/agent/approvals/flow.js";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["discord/U_ORG_ADMIN"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { overrideSettingsForTest, resetSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
const {
  oeCommandName,
  parseOeCommandTokens,
  parseSlackCommandText,
  renderHelp,
  renderStatus,
  renderBudgetStatus,
  computeBudgetStatusFacts,
  runBudgetRaise,
  runBudgetClear,
  runOeCommand,
  registerAppInfo,
  getAppInfo,
  resetAppInfo,
  normalizeAppVersion,
  hasRealAppVersion,
  APP_VERSION_UNVERSIONED,
} = await import("@open-everywhere/core/agent/commands/core.js");
const { parseDiscordOeCommandOptions, parseOeCommandInteraction, handleDiscordOeCommandInteraction, buildOeDiscordCommandDefinition, DISCORD_COMMAND_DESCRIPTION_MAX } = await import(
  "@open-everywhere/provider-discord/agent/commands/discord-commands.js"
);
const { classifyDiscordInteraction } = await import("@open-everywhere/provider-discord/agent/channels/discord-front.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function discordBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return {
    org: "default",
    platform: "discord",
    workspace: "G1",
    surface: "C1",
    mode: "channel",
    visibility: "private",
    trust: "external",
    principalId: "U_REQUESTER",
    target: { channelId: "C1", guildId: "G1" },
    ...overrides,
  };
}

{
  ok(parseSlackCommandText(undefined).kind === "help", "bare /oe (no text) defaults to help");
  ok(parseSlackCommandText("").kind === "help", "empty text defaults to help");
  ok(parseSlackCommandText("   ").kind === "help", "whitespace-only text defaults to help");
  ok(parseSlackCommandText("help").kind === "help", '"help" parses to help');
  ok(parseSlackCommandText("status").kind === "status", '"status" parses to status');
  ok(parseSlackCommandText("budget").kind === "budget-status", 'bare "budget" defaults to budget-status');
  ok(parseSlackCommandText("budget status").kind === "budget-status", '"budget status" parses to budget-status');
  ok(parseSlackCommandText("budget clear").kind === "budget-clear", '"budget clear" parses to budget-clear');
  {
    const cmd = parseSlackCommandText("budget raise 25");
    ok(cmd.kind === "budget-raise" && cmd.usd === 25, '"budget raise 25" parses to budget-raise usd=25');
  }
  {
    const cmd = parseSlackCommandText("  budget   raise   12.50  ");
    ok(cmd.kind === "budget-raise" && cmd.usd === 12.5, "collapses runs of whitespace and parses a decimal amount");
  }
  ok(parseSlackCommandText("budget raise").kind === "error", '"budget raise" with no amount errors');
  ok(parseSlackCommandText("budget raise abc").kind === "error", '"budget raise abc" (non-numeric) errors');
  ok(parseSlackCommandText("budget raise -5").kind === "error", '"budget raise -5" (non-positive) errors');
  ok(parseSlackCommandText("budget raise 0").kind === "error", '"budget raise 0" (zero) errors');
  ok(parseSlackCommandText("budget bogus").kind === "error", 'unknown budget action errors');
  ok(parseSlackCommandText("bogus").kind === "error", "unknown top-level command errors");
  ok(parseOeCommandTokens([]).kind === "help", "empty token list defaults to help (shared core)");
}

{
  ok(parseDiscordOeCommandOptions(undefined).kind === "help", "undefined options -> help (safe default)");
  ok(parseDiscordOeCommandOptions([]).kind === "help", "empty options array -> help");
  ok(parseDiscordOeCommandOptions("not an array").kind === "help", "garbage (non-array) options -> help, never throws");
  ok(parseDiscordOeCommandOptions([{ name: "status" }]).kind === "status", 'top-level "status" subcommand');
  ok(parseDiscordOeCommandOptions([{ name: "help" }]).kind === "help", 'top-level "help" subcommand');
  ok(parseDiscordOeCommandOptions([{ name: "budget", options: [{ name: "status" }] }]).kind === "budget-status", "budget status subcommand");
  ok(parseDiscordOeCommandOptions([{ name: "budget", options: [] }]).kind === "budget-status", "budget group with no chosen subcommand defaults to status");
  ok(parseDiscordOeCommandOptions([{ name: "budget", options: [{ name: "clear" }] }]).kind === "budget-clear", "budget clear subcommand");
  {
    const cmd = parseDiscordOeCommandOptions([{ name: "budget", options: [{ name: "raise", options: [{ name: "usd", value: 25 }] }] }]);
    ok(cmd.kind === "budget-raise" && cmd.usd === 25, "budget raise with a numeric usd option");
  }
  {
    const cmd = parseDiscordOeCommandOptions([{ name: "budget", options: [{ name: "raise", options: [{ name: "usd", value: "30" }] }] }]);
    ok(cmd.kind === "budget-raise" && cmd.usd === 30, "budget raise coerces a string-shaped usd value");
  }
  ok(
    parseDiscordOeCommandOptions([{ name: "budget", options: [{ name: "raise", options: [] }] }]).kind === "error",
    "budget raise with no usd option errors",
  );
  ok(
    parseDiscordOeCommandOptions([{ name: "budget", options: [{ name: "raise", options: [{ name: "usd", value: -5 }] }] }]).kind === "error",
    "budget raise with a non-positive usd errors",
  );
  ok(
    parseDiscordOeCommandOptions([{ name: "budget", options: [{ name: "bogus" }] }]).kind === "error",
    "unknown budget subcommand errors",
  );
  ok(parseDiscordOeCommandOptions([{ name: "bogus" }]).kind === "error", "unknown top-level subcommand errors");
}

{
  const help = renderHelp();
  for (const needle of ["/oe status", "/oe budget", "/oe budget raise", "/oe budget clear", "/oe help"]) {
    ok(help.includes(needle), `renderHelp mentions "${needle}"`);
  }

  const status = renderStatus(
    { version: "1.2.3", primaryModel: "zai/glm-5.2", utilityModel: "deepseek/deepseek-v4-flash", deploymentSha: "abc1234", evePin: "0.44.0" },
    "sqlite",
  );
  ok(status.includes("1.2.3"), "renderStatus includes the app version");
  ok(status.includes("zai/glm-5.2"), "renderStatus includes the primary model");
  ok(status.includes("deepseek/deepseek-v4-flash"), "renderStatus includes the utility model");
  ok(status.includes("sqlite"), "renderStatus includes the memory provider");
  ok(status.includes("telemetry: `unknown`"), "renderStatus defaults the telemetry line when the caller omits it");
  ok(status.includes("deployment sha: `abc1234`"), "renderStatus includes the deployment sha");
  ok(status.includes("eve: `0.44.0`"), "renderStatus includes the eve pin");
  const statusUnknownVersion = renderStatus(
    { version: "1.2.3", primaryModel: "zai/glm-5.2", utilityModel: "deepseek/deepseek-v4-flash", deploymentSha: "unknown", evePin: "unknown" },
    "sqlite",
  );
  ok(statusUnknownVersion.includes("deployment sha: `unknown`"), "renderStatus states \"unknown\" rather than fabricating a sha when unregistered");

  ok(normalizeAppVersion("0.0.0") === APP_VERSION_UNVERSIONED, "normalizeAppVersion collapses the npm placeholder to the unversioned sentinel");
  ok(normalizeAppVersion("") === APP_VERSION_UNVERSIONED, "…and an empty string");
  ok(normalizeAppVersion("  0.0.0  ") === APP_VERSION_UNVERSIONED, "…and a padded placeholder (the raw value is trimmed before it is judged)");
  ok(normalizeAppVersion("unknown") === "unknown", "🔴 normalizeAppVersion leaves \"unknown\" alone — nobody-told-us and nothing-to-tell stay two answers");
  ok(normalizeAppVersion("1.2.3") === "1.2.3", "🔴 NEGATIVE CONTROL: a REAL version passes through untouched — a fork that versions its own deploy keeps its answer");
  ok(normalizeAppVersion("0.0.1") === "0.0.1", "…and a neighbouring version is not swallowed: the match is the exact placeholder, never a prefix");
  ok(normalizeAppVersion("0.0.0-rc.1") === "0.0.0-rc.1", "…and a prerelease built on the placeholder is a real, distinguishing version");

  const statusUnversioned = renderStatus(
    { version: APP_VERSION_UNVERSIONED, primaryModel: "zai/glm-5.2", utilityModel: "deepseek/deepseek-v4-flash", deploymentSha: "abc1234", evePin: "0.44.0" },
    "sqlite",
  );
  ok(statusUnversioned.split("\n")[0] === "*Open Everywhere*", "renderStatus prints NO version on the title when the build carries none");
  ok(!statusUnversioned.includes("v0.0.0") && !statusUnversioned.includes(`v${APP_VERSION_UNVERSIONED}`), "…and never renders the sentinel as if it were a version number");
  ok(statusUnversioned.includes("deployment sha: `abc1234`"), "…while the sha line — the identity that DOES separate two builds — is unchanged");
  ok(status.split("\n")[0] === "*Open Everywhere* v1.2.3", "🔴 NEGATIVE CONTROL: a real version still rides the title, so the suppression is conditional and not a deletion");

  registerAppInfo({ version: "0.0.0", primaryModel: "m", utilityModel: "u", deploymentSha: "sha1", evePin: "0.44.0" });
  ok(getAppInfo().version === APP_VERSION_UNVERSIONED, "registerAppInfo normalises the placeholder, so every consumer reads the same word");
  ok(!hasRealAppVersion(getAppInfo()), "hasRealAppVersion is false for an unversioned build");
  registerAppInfo({ version: "2.5.0", primaryModel: "m", utilityModel: "u", deploymentSha: "sha1", evePin: "0.44.0" });
  ok(getAppInfo().version === "2.5.0", "🔴 NEGATIVE CONTROL: registerAppInfo leaves a real version alone");
  ok(hasRealAppVersion(getAppInfo()), "…and hasRealAppVersion is true for it");
  resetAppInfo();
  ok(getAppInfo().version === "unknown", "an UNREGISTERED app still reads \"unknown\" — the OPE-991 default is untouched");
  ok(!hasRealAppVersion(getAppInfo()), "…and it prints no version either: both non-answers are suppressed, for two different reasons");
  const statusUnregistered = renderStatus(getAppInfo(), "sqlite");
  ok(statusUnregistered.split("\n")[0] === "*Open Everywhere*", "…so an unregistered app's title carries no `vunknown` either");

  const statusWithTelemetry = renderStatus(
    { version: "1.2.3", primaryModel: "zai/glm-5.2", utilityModel: "deepseek/deepseek-v4-flash", deploymentSha: "abc1234", evePin: "0.44.0" },
    "sqlite",
    "on (default collector)",
  );
  ok(statusWithTelemetry.includes("telemetry: `on (default collector)`"), "renderStatus includes an explicit telemetry status");

  ok(!status.includes("compaction fires at"), "renderStatus omits the compaction line when the app registered no window");
  ok(!status.includes("context window:"), "renderStatus omits the context-window line when the app registered no window");
  const statusWithWindow = renderStatus(
    {
      version: "1.2.3",
      primaryModel: "zai/glm-5.2",
      utilityModel: "deepseek/deepseek-v4-flash",
      deploymentSha: "abc1234",
      evePin: "0.44.0",
      contextWindowTokens: 1_050_000,
      compactionThresholdTokens: 210_000,
    },
    "sqlite",
  );
  ok(statusWithWindow.includes("context window: `1,050,000` tokens"), "renderStatus groups the context window with commas");
  ok(statusWithWindow.includes("compaction fires at `210,000` (20%)"), "renderStatus states the absolute compaction threshold and its percent");
  const statusHalf = renderStatus(
    {
      version: "1.2.3",
      primaryModel: "zai/glm-5.2",
      utilityModel: "deepseek/deepseek-v4-flash",
      deploymentSha: "abc1234",
      evePin: "0.44.0",
      contextWindowTokens: 1_050_000,
    },
    "sqlite",
  );
  ok(!statusHalf.includes("context window:"), "renderStatus omits the line when only the window is registered");

  const uncapped = renderBudgetStatus({
    surfaceKey: "discord/G1/C1",
    workspaceKey: "discord/G1",
    surfaceTokens: 1234,
    workspaceTokens: 5678,
    surfaceUsd: 1.5,
    workspaceUsd: 9.25,
    caps: {},
  });
  ok(uncapped.includes("discord/G1/C1"), "renderBudgetStatus includes the surface scope key");
  ok(uncapped.includes("discord/G1"), "renderBudgetStatus includes the workspace scope key");
  ok(uncapped.includes("1,234"), "renderBudgetStatus formats surface token count with separators");
  ok((uncapped.match(/uncapped/g) ?? []).length === 4, "all four cap components render as uncapped when no caps are configured");

  const capped = renderBudgetStatus({
    surfaceKey: "discord/G1/C1",
    workspaceKey: "discord/G1",
    surfaceTokens: 900_000,
    workspaceTokens: 900_000,
    surfaceUsd: 4.5,
    workspaceUsd: 4.5,
    caps: { surfaceMonthlyTokens: 1_000_000, surfaceMonthlyUsd: 5, workspaceMonthlyTokens: 2_000_000, workspaceMonthlyUsd: 10 },
  });
  ok(capped.includes("1,000,000"), "renderBudgetStatus formats a configured token cap");
  ok(capped.includes("$5.00"), "renderBudgetStatus formats a configured USD cap");
}

{
  type VersionAnswer = {
    version: string;
    deploymentSha: string;
    evePin: string;
    contextWindowTokens?: number;
    compactionThresholdTokens?: number;
  };
  const agentVersion = (await import("@open-everywhere/core/agent/tools/agent_version.js")).default;
  const runTool = async (): Promise<VersionAnswer> => (await agentVersion.execute({}, {} as never)) as unknown as VersionAnswer;

  registerAppInfo({
    version: "0.0.0",
    primaryModel: "zai/glm-5.2",
    utilityModel: "deepseek/deepseek-v4-flash",
    deploymentSha: "sha-abc",
    evePin: "0.44.0",
    contextWindowTokens: 1_050_000,
    compactionThresholdTokens: 525_000,
  });
  const answer = await runTool();
  ok(answer.deploymentSha === "sha-abc", "agent_version returns the registered deployment sha");
  ok(answer.version === APP_VERSION_UNVERSIONED, "…and the NORMALISED version, so the tool and the command answer the same word");
  ok(answer.contextWindowTokens === 1_050_000, "🔴 agent_version returns the registered context window");
  ok(answer.compactionThresholdTokens === 525_000, "🔴 …and the registered compaction threshold — the number `/oe status` prints");

  const grouped = (v: unknown) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rendered = renderStatus(getAppInfo(), "sqlite");
  ok(
    rendered.includes(`context window: \`${grouped(answer.contextWindowTokens)}\` tokens`) &&
      rendered.includes(`fires at \`${grouped(answer.compactionThresholdTokens)}\``),
    "🔴 the command's line and the tool's fields carry the SAME two numbers — the disagreement the tool's header claims to prevent",
  );

  registerAppInfo({ version: "1.2.3", primaryModel: "m", utilityModel: "u", deploymentSha: "sha-def", evePin: "0.44.0" });
  const halfAnswer = await runTool();
  ok(halfAnswer.deploymentSha === "sha-def", "the second registration reached the tool (so the fields below are read fresh, not cached)");
  ok(halfAnswer.contextWindowTokens === undefined, "🔴 NEGATIVE CONTROL: an app that registered no window gets NO window field — never a default");
  ok(halfAnswer.compactionThresholdTokens === undefined, "…and no threshold field either");

  const declared = Object.keys((agentVersion.outputSchema as { shape: Record<string, unknown> }).shape);
  ok(declared.includes("contextWindowTokens") && declared.includes("compactionThresholdTokens"), "🔴 both fields are DECLARED in the output schema, not merely returned");

  resetAppInfo();
}

{
  const def = buildOeDiscordCommandDefinition() as {
    name: string;
    type: number;
    options: { name: string; type: number; options?: { name: string; type: number; options?: { name: string; type: number; required?: boolean; min_value?: number }[] }[] }[];
  };
  ok(def.name === oeCommandName() && def.name === "oe", 'registration JSON name is "oe" with no `identity.commandName` configured');
  ok(def.type === 1, "registration JSON type is CHAT_INPUT (1)");
  const topNames = def.options.map((o) => o.name);
  ok(topNames.includes("budget") && topNames.includes("status") && topNames.includes("help"), "top-level options are budget/status/help");
  const statusOpt = def.options.find((o) => o.name === "status")!;
  const helpOpt = def.options.find((o) => o.name === "help")!;
  ok(statusOpt.type === 1 && helpOpt.type === 1, "top-level status/help are SUB_COMMAND (1), directly invokable");
  const budgetGroup = def.options.find((o) => o.name === "budget")!;
  ok(budgetGroup.type === 2, "budget is a SUB_COMMAND_GROUP (2) — not directly invokable bare, a documented Discord/Slack grammar difference");
  const budgetSubNames = (budgetGroup.options ?? []).map((o) => o.name);
  ok(
    budgetSubNames.includes("status") && budgetSubNames.includes("raise") && budgetSubNames.includes("clear"),
    "budget group has status/raise/clear subcommands",
  );
  const raiseSub = (budgetGroup.options ?? []).find((o) => o.name === "raise")!;
  const usdOpt = (raiseSub.options ?? []).find((o) => o.name === "usd")!;
  ok(usdOpt.type === 10, "raise's usd option is type NUMBER (10)");
  ok(usdOpt.required === true, "raise's usd option is required");
  ok(usdOpt.min_value === 0.01, "raise's usd option has a positive min_value");
}

{
  ok(
    classifyDiscordInteraction(JSON.stringify({ type: 2, data: { name: "oe" } })).kind === "oe-command",
    'an "/oe" application command classifies as ours',
  );
  ok(
    classifyDiscordInteraction(JSON.stringify({ type: 2, data: { name: "ask" } })).kind === "forward",
    "a different application command still forwards to discordChannel",
  );
  ok(classifyDiscordInteraction(JSON.stringify({ type: 2 })).kind === "forward", "an application command with no data forwards");
  ok(classifyDiscordInteraction(JSON.stringify({ type: 1 })).kind === "forward", "PING is unaffected by the oe-command branch");
}

function discordOeInteraction(opts: {
  name?: string;
  options?: unknown;
  userId?: string;
  bot?: boolean;
  channelId?: string | null;
  guildId?: string;
}): Record<string, unknown> {
  const { name = "oe", options = [{ name: "help" }], userId = "U_REQUESTER", bot = false, channelId = "C1", guildId = "G1" } = opts;
  const base: Record<string, unknown> = {
    type: 2,
    data: { name, options },
    guild_id: guildId,
    member: { user: { id: userId, bot } },
  };
  if (channelId !== null) base.channel_id = channelId;
  return base;
}

{
  ok(parseOeCommandInteraction({ type: 1 }) === null, "parseOeCommandInteraction: a non-command interaction is null (not ours)");
  ok(parseOeCommandInteraction(discordOeInteraction({ name: "ask" })) === null, 'parseOeCommandInteraction: a different command name is null');

  const resHelp = await handleDiscordOeCommandInteraction(discordOeInteraction({ options: [{ name: "help" }] }));
  ok(resHelp !== null, "handleDiscordOeCommandInteraction answers a well-formed /oe help invocation");
  ok((resHelp as { type: number }).type === 4, "response type is CHANNEL_MESSAGE_WITH_SOURCE (4)");
  ok((resHelp as { data: { flags: number } }).data.flags === 64, "response is flagged EPHEMERAL (64) — only the invoker sees it");
  ok((resHelp as { data: { content: string } }).data.content.includes("/oe help"), "help content renders");

  const resStatus = await handleDiscordOeCommandInteraction(discordOeInteraction({ options: [{ name: "status" }] }));
  ok((resStatus as { data: { content: string } }).data.content.includes("Open Everywhere"), "/oe status answers with deploy info");

  const resBot = await handleDiscordOeCommandInteraction(discordOeInteraction({ bot: true }));
  ok((resBot as { data: { content: string } }).data.content.toLowerCase().includes("bot"), "a bot-authored invocation is refused with an ephemeral note, never silently dispatched");

  const resNoChannel = await handleDiscordOeCommandInteraction(discordOeInteraction({ channelId: null }));
  ok((resNoChannel as { data: { content: string } }).data.content.toLowerCase().includes("channel"), "a missing channel id is refused with an ephemeral note");

  const resNotOurs = await handleDiscordOeCommandInteraction(discordOeInteraction({ name: "ask" }));
  ok(resNotOurs === null, "a non-oe interaction returns null so the front route falls back to forwarding");

  const resBadOption = await handleDiscordOeCommandInteraction(discordOeInteraction({ options: [{ name: "budget", options: [{ name: "raise", options: [] }] }] }));
  ok((resBadOption as { data: { content: string } }).data.content.toLowerCase().includes("usd"), "a malformed budget-raise invocation surfaces a helpful ephemeral error, never throws");
}

{
  const before = getAppInfo();
  ok(before.version === "unknown", "app info starts unregistered (unknown)");
  ok(before.deploymentSha === "unknown", "app info starts with an unknown deployment sha");
  ok(before.evePin === "unknown", "app info starts with an unknown eve pin");
  registerAppInfo({ version: "9.9.9", primaryModel: "test/primary", utilityModel: "test/utility", deploymentSha: "cafe123", evePin: "0.44.0" });
  ok(getAppInfo().version === "9.9.9", "registerAppInfo updates the registered info");
  ok(getAppInfo().deploymentSha === "cafe123", "registerAppInfo updates the registered deployment sha");
  const statusReply = await runOeCommand({ kind: "status" }, discordBinding());
  ok(statusReply.includes("9.9.9") && statusReply.includes("test/primary") && statusReply.includes("test/utility"), "runOeCommand(status) reflects registered app info");
  ok(statusReply.includes("cafe123") && statusReply.includes("0.44.0"), "runOeCommand(status) reflects the registered deployment sha and eve pin");
  resetAppInfo();
  ok(getAppInfo().version === "unknown", "resetAppInfo restores the unregistered default");
  ok(getAppInfo().deploymentSha === "unknown", "resetAppInfo restores the unknown deployment sha");
  registerAppInfo({ version: "9.9.9", primaryModel: "test/primary", utilityModel: "test/utility", deploymentSha: "cafe123", evePin: "0.44.0" });
}

{
  const facts = await computeBudgetStatusFacts(discordBinding(), {
    effectiveCaps: async () => ({ surfaceMonthlyTokens: 1_000_000, surfaceMonthlyUsd: 5 }),
    surfaceTokens: async () => 400_000,
    workspaceTokens: async () => 800_000,
    scopeUsdSpend: async () => ({ surfaceUsd: 2, workspaceUsd: 3 }),
    nowISO: () => "2026-07-06T00:00:00.000Z",
  });
  ok(facts.surfaceKey === "discord/G1/C1", "computeBudgetStatusFacts derives the surface scope key via defaultScopeKey");
  ok(facts.workspaceKey === "discord/G1", "computeBudgetStatusFacts derives the workspace scope key via defaultScopeKey");
  ok(facts.surfaceTokens === 400_000 && facts.workspaceTokens === 800_000, "computeBudgetStatusFacts passes through injected token figures");
  ok(facts.surfaceUsd === 2 && facts.workspaceUsd === 3, "computeBudgetStatusFacts passes through injected USD figures");
  ok(renderBudgetStatus(facts).includes("400,000"), "the composed render reflects the injected figures");
}

{
  let recorded: RequestApprovalInput | undefined;
  const deps = {
    effectiveCaps: async () => ({ surfaceMonthlyUsd: 5 }),
    requestApproval: async (input: RequestApprovalInput) => {
      recorded = input;
      return { id: "pending-123", expiresAt: "2026-07-07T00:00:00.000Z" };
    },
    friendlyScopeLabel: async () => undefined,
    readSpendCoverage: async () => ({ models: ["test/no-rate-model"] }),
  };

  const raiseReply = await runBudgetRaise(discordBinding(), 25, deps);
  ok(raiseReply.includes("$25.00") && raiseReply.includes("pending-123"), "runBudgetRaise's ack text names the amount and pending id");
  ok(recorded!.kind === "spend.set", "runBudgetRaise proposes a spend.set");
  ok((recorded!.args as { monthlyUsd: number }).monthlyUsd === 25, "runBudgetRaise freezes the requested USD amount");
  ok((recorded!.args as { reason: string }).reason.includes("<@U_REQUESTER>"), "runBudgetRaise's frozen reason names the requester (mention syntax shared by Slack + Discord)");
  ok(recorded!.scopeKey === "discord/G1/C1", "runBudgetRaise defaults to this surface's own scope");
  ok(recorded!.requestedBy === "U_REQUESTER", "runBudgetRaise's requestedBy is the invoking principal");
  ok(recorded!.channelId === "C1", "runBudgetRaise posts to this channel");
  ok(
    JSON.stringify((recorded!.args as { coverage?: unknown }).coverage) === JSON.stringify({ measured: "gap", windowDays: 30, unratedModels: ["test/no-rate-model"], unobservedModels: [] }),
    `runBudgetRaise freezes the pricing coverage onto the card's args (got ${JSON.stringify((recorded!.args as { coverage?: unknown }).coverage)})`,
  );

  recorded = undefined;
  const clearReply = await runBudgetClear(discordBinding(), deps);
  ok(clearReply.includes("pending-123"), "runBudgetClear's ack text names the pending id");
  ok(recorded!.kind === "spend.clear", "runBudgetClear proposes a spend.clear");
  ok(recorded!.scopeKey === "discord/G1/C1", "runBudgetClear defaults to this surface's own scope");

  await assert.rejects(
    () => runBudgetRaise(discordBinding({ target: {} }), 10, deps),
    /couldn't resolve this channel's id/,
    "runBudgetRaise refuses when no channel id can be resolved",
  );
  n++;

  for (const [label, run] of [
    ["/oe budget raise", () => runBudgetRaise(discordBinding({ platform: "teams" }), 10, deps)],
    ["/oe budget clear", () => runBudgetClear(discordBinding({ platform: "teams" }), deps)],
  ] as const) {
    await assert.rejects(run, /approval-card path/, `${label} still refuses on a card-less surface — the fence moved to the door that promises "posted in this channel", it did not disappear`);
    n++;
  }
  ok((await runBudgetRaise(discordBinding(), 25, deps)).includes("$25.00"), "…and the fence takes NOTHING from a card-capable surface: the same raise still acks");

  recorded = undefined;
  const dmRaise = await runBudgetRaise(
    discordBinding({ mode: "dm", workspace: "U_DM_USER", target: { channelId: "U_DM_USER" } }),
    10,
    deps,
  );
  ok(dmRaise.includes("$10.00"), "runBudgetRaise from a DM acks the amount — a DM's own cap is enforceable since OPE-267");
  ok(recorded!.kind === "spend.set", "runBudgetRaise from a DM proposes a spend.set");
  ok(recorded!.scopeKey === "discord/U_DM_USER/C1", "runBudgetRaise from a DM defaults to that DM's OWN surface key, never the workspace bucket");
  n += 3;
}

{
  const domains = [
    defineDomain({ name: "eng", reach: ["discord/G1/C_ENG"] }),
    defineDomain({ name: "sales", reach: ["discord/G1/C_SALES"] }),
  ];
  let recorded: RequestApprovalInput | undefined;
  const scanned: Record<string, { usd: number; tokens: number; calls: number }> = {
    eng: { usd: 12.5, tokens: 123456, calls: 42 },
    sales: { usd: 99.75, tokens: 9, calls: 3 },
  };
  let scannedFor: string | undefined;
  let scannedWith: { org: string; nowISO: string; days: number } | undefined;
  const deps = {
    effectiveCaps: async () => ({ surfaceMonthlyUsd: 5 }),
    requestApproval: async (input: RequestApprovalInput) => {
      recorded = input;
      return { id: "pending-scan", expiresAt: "2026-09-10T00:00:00.000Z" };
    },
    friendlyScopeLabel: async () => undefined,
    readSpendCoverage: async () => ({ models: [] }),
    domains,
    nowISO: () => "2026-09-09T10:00:00.000Z",
    domainSpendWindow: async (org: string, domain: string, nowISO: string, days: number) => {
      scannedFor = domain;
      scannedWith = { org, nowISO, days };
      return { domain, periods: ["2026-08", "2026-09"], ...scanned[domain] };
    },
  };
  const inDomain = (surface: string) => discordBinding({ surface, trust: "internal", target: { channelId: surface, guildId: "G1" } });

  const engReply = await runBudgetRaise(inDomain("C_ENG"), 25, deps as never);
  ok(scannedFor === "eng", "budget raise: the scan resolves the requester's OWN domain from their binding — the caller never names one");
  ok(
    scannedWith!.org === "default" && scannedWith!.days === 30 && scannedWith!.nowISO === "2026-09-09T10:00:00.000Z",
    `budget raise: the scan is pinned to the requester's own org and a 30-day window (got ${JSON.stringify(scannedWith)})`,
  );
  ok(engReply.includes("`eng`") && engReply.includes("$12.50"), `budget raise: the ack shows the requester their own domain's 30-day spend (got: ${engReply})`);
  ok(engReply.includes("123,456") && engReply.includes("42"), "budget raise: the ack carries the domain's token and call totals too");
  ok(engReply.includes("2026-08, 2026-09"), "budget raise: the ack NAMES the calendar months summed — the ledger's grain is a month, and the line says so instead of claiming an exact 30 days");
  ok(!engReply.includes("99.75") && !engReply.includes("`sales`"), "budget raise: a requester in one domain sees NOTHING of another domain's spend");
  const salesReply = await runBudgetRaise(inDomain("C_SALES"), 25, deps as never);
  ok(scannedFor === "sales" && salesReply.includes("$99.75"), "budget raise: a requester in the other domain gets THAT domain's figure (negative control — the answer tracks the requester)");
  ok(!salesReply.includes("12.50"), "budget raise: …and still sees nothing of the first domain's spend");

  ok(recorded!.kind === "spend.set", "budget raise: the scan did not turn the raise into an act — it is still a spend.set PROPOSAL");
  ok(salesReply.includes("An admin needs to Approve it."), "budget raise: the ack still says an admin decides — the raise stays admin-gated");
  ok(JSON.stringify(recorded!.args).indexOf("99.75") === -1, "budget raise: the scanned figure is NOT frozen onto the card — it is the asker's evidence, not the approver's");

  scannedFor = undefined;
  const dmReply = await runBudgetRaise(discordBinding({ mode: "dm", workspace: "U_DM", target: { channelId: "U_DM" } }), 10, deps as never);
  ok(scannedFor === undefined, "budget raise: a DM resolves to no domain, so the scan does not run at all");
  ok(/No domain spend to show/.test(dmReply) && /DM/.test(dmReply), "budget raise: a DM ack states that no domain spend is shown, and why — never a silent zero");

  const brokenReply = await runBudgetRaise(inDomain("C_ENG"), 25, {
    ...deps,
    domainSpendWindow: async () => {
      throw new Error("ledger unreachable");
    },
  } as never);
  ok(brokenReply.includes("pending-scan"), "budget raise: a failed scan still returns the working proposal ack — the read is fail-soft");
  ok(/NOT shown/.test(brokenReply) && !brokenReply.includes("$0.00"), "budget raise: a failed scan says the ledger could not be read, never a $0.00 that would read as a clean bill");
}

{
  overrideSettingsForTest({ identity: { name: "Aria", commandName: "aria" } });
  try {
    ok(oeCommandName() === "aria", "configured: oeCommandName() resolves the setting");
    const def = buildOeDiscordCommandDefinition() as { name: string; description: string; options: { name: string; description: string }[] };
    ok(def.name === "aria", "🔴 configured: Discord REGISTERS the command under the configured name");
    ok(def.description.startsWith("Aria "), `configured: the registration description names the agent (got "${def.description}")`);
    ok(!def.description.includes("Open Everywhere"), "configured: …and not the brand");
    ok(def.options.find((o) => o.name === "help")!.description.includes("/aria"), "configured: the help subcommand's description spells /aria");
    ok(
      classifyDiscordInteraction(JSON.stringify({ type: 2, data: { name: "aria" } })).kind === "oe-command",
      "🔴 configured: the Discord router MATCHES the configured name — the command it registered is answered, not forwarded",
    );
    ok(
      classifyDiscordInteraction(JSON.stringify({ type: 2, data: { name: "oe" } })).kind === "forward",
      "configured: the old `oe` name is no longer ours — it forwards like any other command",
    );
    ok(parseOeCommandInteraction(discordOeInteraction({ name: "aria" })) !== null, "configured: the interaction parser accepts the configured name");
    ok(parseOeCommandInteraction(discordOeInteraction({ name: "oe" })) === null, "configured: …and refuses the old one");
    const help = renderHelp();
    ok(help.includes("/aria status") && help.includes("/aria rate") && help.includes("/aria help"), "🔴 configured: the help text spells the configured command");
    ok(!/\/oe\b/.test(help), "configured: …and never `/oe`");
    const unknown = parseOeCommandTokens(["frobnicate"]);
    ok(unknown.kind === "error" && unknown.message.includes('"/aria help"'), "configured: the unknown-command error points at /aria help");
    const badRaise = parseOeCommandTokens(["budget", "raise", "x"]);
    ok(badRaise.kind === "error" && badRaise.message.includes("/aria budget raise"), "configured: the budget-raise error spells /aria");
    const discordBad = parseDiscordOeCommandOptions([{ name: "nope" }]);
    ok(discordBad.kind === "error" && discordBad.message.includes('"/aria"') && discordBad.message.includes("/aria help"), "configured: Discord's unknown-subcommand error spells /aria");
    const status = renderStatus({ version: "1.2.3", primaryModel: "m", utilityModel: "u", deploymentSha: "abc", evePin: "0.71.0" }, "sqlite");
    overrideSettingsForTest({ identity: { name: "A Very Long Configured Agent Name That Fills The Whole Setting Width!" } });
    const longDef = buildOeDiscordCommandDefinition() as { description: string };
    ok(longDef.description.length <= DISCORD_COMMAND_DESCRIPTION_MAX, `configured: a long name never pushes the description past Discord's ${DISCORD_COMMAND_DESCRIPTION_MAX}-character limit`);
    overrideSettingsForTest({ identity: { name: "Aria" } });
    ok(status.startsWith("*Aria* v1.2.3"), `🔴 configured: the status header carries the configured name (got "${status.split("\n")[0]}")`);
    ok(!status.includes("Open Everywhere"), "configured: …and not the brand");
  } finally {
    resetSettingsForTest();
  }
  ok(oeCommandName() === "oe" && renderHelp().includes("/oe status"), "unconfigured: the command is /oe again");
  ok(
    renderStatus({ version: "1.2.3", primaryModel: "m", utilityModel: "u", deploymentSha: "abc", evePin: "0.71.0" }, "sqlite").startsWith("*Open Everywhere* v1.2.3"),
    "unconfigured: the status header falls back to the brand default",
  );
}

console.log(`\n✓ oe-commands: ${n} assertions passed (parsing, renderers, registration JSON, classification, ephemeral responses, budget glue — the Slack signature gate moved to @open-everywhere/provider-slack)\n`);
