import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";
import { defineDomain } from "../agent/memory/domain.js";
import { registerConfig } from "../agent/access/config.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";
import type { RequestApprovalInput } from "../agent/approvals/flow.js";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["U_ORG_ADMIN"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const {
  OE_COMMAND_NAME,
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
} = await import("../agent/commands/core.js");
const { parseDiscordOeCommandOptions, parseOeCommandInteraction, handleDiscordOeCommandInteraction, buildOeDiscordCommandDefinition } = await import(
  "../agent/commands/discord-commands.js"
);
const { classifyDiscordInteraction } = await import("../agent/channels/discord-front.js");

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

  const status = renderStatus({ version: "1.2.3", primaryModel: "zai/glm-5.2", utilityModel: "deepseek/deepseek-v4-flash" }, "sqlite");
  ok(status.includes("1.2.3"), "renderStatus includes the app version");
  ok(status.includes("zai/glm-5.2"), "renderStatus includes the primary model");
  ok(status.includes("deepseek/deepseek-v4-flash"), "renderStatus includes the utility model");
  ok(status.includes("sqlite"), "renderStatus includes the memory provider");
  ok(status.includes("telemetry: `unknown`"), "renderStatus defaults the telemetry line when the caller omits it");

  const statusWithTelemetry = renderStatus({ version: "1.2.3", primaryModel: "zai/glm-5.2", utilityModel: "deepseek/deepseek-v4-flash" }, "sqlite", "on (default collector)");
  ok(statusWithTelemetry.includes("telemetry: `on (default collector)`"), "renderStatus includes an explicit telemetry status");

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
  const def = buildOeDiscordCommandDefinition() as {
    name: string;
    type: number;
    options: { name: string; type: number; options?: { name: string; type: number; options?: { name: string; type: number; required?: boolean; min_value?: number }[] }[] }[];
  };
  ok(def.name === OE_COMMAND_NAME, 'registration JSON name is "oe"');
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
  registerAppInfo({ version: "9.9.9", primaryModel: "test/primary", utilityModel: "test/utility" });
  ok(getAppInfo().version === "9.9.9", "registerAppInfo updates the registered info");
  const statusReply = await runOeCommand({ kind: "status" }, discordBinding());
  ok(statusReply.includes("9.9.9") && statusReply.includes("test/primary") && statusReply.includes("test/utility"), "runOeCommand(status) reflects registered app info");
  resetAppInfo();
  ok(getAppInfo().version === "unknown", "resetAppInfo restores the unregistered default");
  registerAppInfo({ version: "9.9.9", primaryModel: "test/primary", utilityModel: "test/utility" });
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
  };

  const raiseReply = await runBudgetRaise(discordBinding(), 25, deps);
  ok(raiseReply.includes("$25.00") && raiseReply.includes("pending-123"), "runBudgetRaise's ack text names the amount and pending id");
  ok(recorded!.kind === "spend.set", "runBudgetRaise proposes a spend.set");
  ok((recorded!.args as { monthlyUsd: number }).monthlyUsd === 25, "runBudgetRaise freezes the requested USD amount");
  ok((recorded!.args as { reason: string }).reason.includes("<@U_REQUESTER>"), "runBudgetRaise's frozen reason names the requester (mention syntax shared by Slack + Discord)");
  ok(recorded!.scopeKey === "discord/G1/C1", "runBudgetRaise defaults to this surface's own scope");
  ok(recorded!.requestedBy === "U_REQUESTER", "runBudgetRaise's requestedBy is the invoking principal");
  ok(recorded!.channelId === "C1", "runBudgetRaise posts to this channel");

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

  await assert.rejects(
    () => runBudgetRaise(discordBinding({ mode: "dm", workspace: "U_DM_USER", target: { channelId: "U_DM_USER" } }), 10, deps),
    /DM/,
    "runBudgetRaise bubbles planSetSpendLimit's DM-without-explicit-scope refusal verbatim",
  );
  n++;
}

{
  const { default: slackCommandsChannel } = await import("../agent/channels/slack-commands.js");
  const routeDef = (
    slackCommandsChannel as unknown as {
      routes: readonly { method: string; path: string; handler: (req: Request, args: RouteHandlerArgs) => Promise<Response> }[];
    }
  ).routes[0];
  ok(routeDef.method === "POST" && routeDef.path === "/eve/v1/slack/commands", "slack-commands mounts POST /eve/v1/slack/commands");

  const call = (req: Request) => routeDef.handler(req, {} as RouteHandlerArgs);

  function slackSignature(secret: string, timestamp: string, body: string): string {
    return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  }
  function slackRequest(body: string, opts: { timestamp?: string; signature?: string; noHeaders?: boolean } = {}): Request {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (!opts.noHeaders) {
      const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
      headers.set("x-slack-request-timestamp", timestamp);
      headers.set("x-slack-signature", opts.signature ?? "v0=0000000000000000000000000000000000000000000000000000000000000000");
    }
    return new Request("https://example.test/eve/v1/slack/commands", { method: "POST", headers, body });
  }

  const helpBody = "command=%2Foe&text=help&team_id=T1&channel_id=C1&user_id=U1";
  const secret = "test-signing-secret";

  const prevSecret = process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;

  {
    const res = await call(slackRequest(helpBody, { timestamp: String(Math.floor(Date.now() / 1000)) }));
    ok(res.status === 401, "no SLACK_SIGNING_SECRET configured -> 401 (fail-closed)");
  }

  process.env.SLACK_SIGNING_SECRET = secret;

  {
    const res = await call(slackRequest(helpBody, { noHeaders: true }));
    ok(res.status === 401, "missing signature headers -> 401");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await call(slackRequest(helpBody, { timestamp, signature: "v0=not-a-real-signature" }));
    ok(res.status === 401, "a bad signature -> 401");
  }
  {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const sig = slackSignature(secret, staleTimestamp, helpBody);
    const res = await call(slackRequest(helpBody, { timestamp: staleTimestamp, signature: sig }));
    ok(res.status === 401, "a stale (>5min) timestamp -> 401 even with a correctly-computed signature");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, helpBody);
    const tampered = helpBody.replace("help", "clear");
    const res = await call(slackRequest(tampered, { timestamp, signature: sig }));
    ok(res.status === 401, "a body tampered with after signing -> 401");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, helpBody);
    const res = await call(slackRequest(helpBody, { timestamp, signature: sig }));
    ok(res.status === 200, "a validly-signed /oe help request succeeds");
    const json = (await res.json()) as { response_type: string; text: string };
    ok(json.response_type === "ephemeral", 'response_type is "ephemeral" — only the invoker sees it');
    ok(json.text.includes("/oe help"), "the ephemeral text is the rendered help");
  }
  {
    const statusBody = "command=%2Foe&text=status&team_id=T1&channel_id=C1&user_id=U1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, statusBody);
    const res = await call(slackRequest(statusBody, { timestamp, signature: sig }));
    const json = (await res.json()) as { text: string };
    ok(json.text.includes("Open Everywhere"), "a validly-signed /oe status request answers with deploy info");
  }
  {
    const otherBody = "command=%2Fother&text=&team_id=T1&channel_id=C1&user_id=U1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, otherBody);
    const res = await call(slackRequest(otherBody, { timestamp, signature: sig }));
    ok(res.status === 200, "a differently-named slash command still gets a clean 200 (not a crash)");
    const json = (await res.json()) as { text: string };
    ok(json.text.includes("/oe"), "the response explains this endpoint only handles /oe");
  }

  if (prevSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = prevSecret;
}

console.log(`\n✓ oe-commands: ${n} assertions passed (parsing, renderers, registration JSON, classification, ephemeral responses, budget glue, Slack signature gate)\n`);
