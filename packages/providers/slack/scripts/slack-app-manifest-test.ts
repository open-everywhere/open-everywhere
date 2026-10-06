import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPLOY_HOST_PLACEHOLDER,
  normalizeDeployHost,
  surfaceAppManifest,
  surfaceAppManifestSurfaces,
  surfaceAppNameProblem,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerSlackOps } from "../agent/ops.js";
import {
  SLACK_APP_NAME_MAX,
  SLACK_DEFAULT_APP_NAME,
  SLACK_DEPLOY_HOST_PLACEHOLDER,
  SLACK_SHORTCUT_NAME_MAX,
  slackAppManifestTemplate,
} from "../agent/app-manifest.js";
import { overrideSettingsForTest, resetSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { classifyEnvelope } from "../agent/channels/slack-front.js";
import { SLACK_PROVIDER_EVENTS } from "../agent/provider-events.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

ok(
  SLACK_DEPLOY_HOST_PLACEHOLDER === DEPLOY_HOST_PLACEHOLDER,
  `the bundle's placeholder ("${SLACK_DEPLOY_HOST_PLACEHOLDER}") is the one core substitutes ("${DEPLOY_HOST_PLACEHOLDER}")`,
);

const template = slackAppManifestTemplate();
interface SlackManifestShape {
  display_information: { name: string };
  features: {
    app_home?: { home_tab_enabled?: boolean; messages_tab_enabled?: boolean; messages_tab_read_only_enabled?: boolean };
    bot_user: { display_name: string };
    slash_commands: { url: string; usage_hint?: string; description?: string }[];
    shortcuts: unknown[];
  };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } };
  settings: { event_subscriptions: { request_url: string; bot_events: string[] }; interactivity: { is_enabled: boolean; request_url: string }; org_deploy_enabled: boolean };
}
const parsed = JSON.parse(template) as SlackManifestShape;
ok(parsed.oauth_config.scopes.bot.length >= 10, `the template declares its bot scopes (${parsed.oauth_config.scopes.bot.length})`);
ok(parsed.features.slash_commands[0]?.url.includes(DEPLOY_HOST_PLACEHOLDER), "the slash-command URL carries the placeholder");
ok(parsed.settings.event_subscriptions.request_url.includes(DEPLOY_HOST_PLACEHOLDER), "the events request URL carries the placeholder");
ok(parsed.settings.interactivity.is_enabled === true, "interactivity is enabled — the shortcuts and every card button need it");
ok(parsed.settings.interactivity.request_url.includes(DEPLOY_HOST_PLACEHOLDER), "the interactivity request URL carries the placeholder");
ok(parsed.oauth_config.redirect_urls?.length === 1, "the manifest declares exactly one OAuth redirect URL");
ok(parsed.settings.org_deploy_enabled === false, "org-wide (Enterprise Grid) install is OFF — /setup has no Grid branch");
ok(parsed.oauth_config.redirect_urls[0]?.includes(DEPLOY_HOST_PLACEHOLDER) === true, "the OAuth redirect URL carries the placeholder");
ok(parsed.oauth_config.redirect_urls[0]?.endsWith("/setup/callback") === true, "…and it is the /setup callback route");
const templatePlaceholders = template.split(DEPLOY_HOST_PLACEHOLDER).length - 1;
ok(templatePlaceholders === 4, `the template carries four placeholders — three request URLs plus the OAuth redirect (found ${templatePlaceholders})`);

ok(parsed.features.app_home?.messages_tab_enabled === true, "the Messages tab is on — a DM is the primary wake");
ok(parsed.features.app_home?.messages_tab_read_only_enabled === false, "…and writable (read-only blocks the person from sending)");
ok(parsed.features.app_home?.home_tab_enabled === false, "…and the Home tab is off — the product routes no app_home_opened");

ok(parsed.display_information.name === SLACK_DEFAULT_APP_NAME, "with no name the app is named the default");
ok(parsed.features.bot_user.display_name === SLACK_DEFAULT_APP_NAME, "…and so is the bot user");
const renamed = JSON.parse(slackAppManifestTemplate({ appName: "  Acme Agent  " })) as SlackManifestShape;
ok(renamed.display_information.name === "Acme Agent", "a chosen name names the app, trimmed");
ok(renamed.features.bot_user.display_name === "Acme Agent", "…and the bot user");
ok(JSON.stringify(renamed.oauth_config) === JSON.stringify(parsed.oauth_config), "…and changes nothing else in the scopes");
ok(
  JSON.parse(slackAppManifestTemplate({ appName: "   " })).display_information.name === SLACK_DEFAULT_APP_NAME,
  "a blank name falls back to the default (negative control: a blank never reaches Slack)",
);

const MESSAGE_EVENT_BY_CHANNEL_TYPE: Record<string, string> = {
  channel: "message.channels",
  group: "message.groups",
  im: "message.im",
  mpim: "message.mpim",
};
const frontSource = readFileSync(join(REPO_ROOT, "packages/providers/slack/agent/channels/slack-front.ts"), "utf8");
const frontLiterals = [...frontSource.matchAll(/eventType [!=]== "([a-z_]+)"/g)].map((m) => m[1] as string);
ok(frontLiterals.length >= 4, `scan sanity: the front route compares eventType to at least 4 literals (found ${frontLiterals.length})`);
const candidateTypes = new Set<string>([...SLACK_PROVIDER_EVENTS.events.map((e) => e.event), ...frontLiterals]);
const manifestEventName = (type: string, channelType?: string): string =>
  type === "message" && channelType !== undefined ? (MESSAGE_EVENT_BY_CHANNEL_TYPE[channelType] ?? `message.${channelType}`) : type;
const probe = (type: string, channelType?: string): string =>
  classifyEnvelope(
    JSON.stringify({ type: "event_callback", event: { type, ...(channelType === undefined ? {} : { channel_type: channelType }) } }),
    "application/json",
  ).kind;
const handledEvents = new Set<string>();
for (const type of candidateTypes) {
  if (type === "message") {
    for (const channelType of Object.keys(MESSAGE_EVENT_BY_CHANNEL_TYPE)) {
      if (probe(type, channelType) !== "forward") handledEvents.add(manifestEventName(type, channelType));
    }
  } else if (probe(type) !== "forward") {
    handledEvents.add(type);
  }
}
ok(handledEvents.size >= 8, `derivation sanity: the front route acts on at least 8 Slack events (found ${[...handledEvents].sort().join(", ")})`);
ok(probe("channel_created") === "forward", "negative control: `channel_created` is not acted on, so it is not required");
const subscribed = parsed.settings.event_subscriptions.bot_events;
for (const event of handledEvents) {
  ok(
    subscribed.includes(event),
    `the manifest subscribes \`${event}\` — the front route (slack-front.ts classifyEnvelope) acts on it, and an ` +
      `unsubscribed event never arrives, so the feature that reads it is silently off`,
  );
}
for (const event of subscribed) {
  const [type, suffix] = event.split(".") as [string, string | undefined];
  const channelType = suffix === undefined ? undefined : Object.keys(MESSAGE_EVENT_BY_CHANNEL_TYPE).find((k) => MESSAGE_EVENT_BY_CHANNEL_TYPE[k] === event);
  ok(
    type !== "message" || channelType !== undefined,
    `\`${event}\` is a Slack message event this test can map to a channel_type`,
  );
  ok(probe(type, channelType) !== "forward", `the manifest's \`${event}\` subscription is one the front route acts on`);
}
ok(new Set(subscribed).size === subscribed.length, "the manifest subscribes no event twice");

const EVENT_SCOPES: Record<string, readonly string[]> = {
  app_mention: ["app_mentions:read"],
  "message.im": ["im:history"],
  "message.channels": ["channels:history"],
  "message.groups": ["groups:history"],
  "message.mpim": ["mpim:history"],
  member_joined_channel: ["channels:read", "groups:read", "mpim:read"],
  reaction_added: ["reactions:read"],
  reaction_removed: ["reactions:read"],
};
for (const event of subscribed) {
  const scopes = EVENT_SCOPES[event];
  ok(scopes !== undefined, `\`${event}\` has a cited scope requirement in EVENT_SCOPES — add it from Slack's event reference`);
  for (const scope of scopes ?? []) {
    ok(parsed.oauth_config.scopes.bot.includes(scope), `the manifest requests \`${scope}\`, which Slack requires for \`${event}\``);
  }
}

const commandParser = readFileSync(join(REPO_ROOT, "packages/core/agent/commands/core.ts"), "utf8");
const parserBody = /export function parseOeCommandTokens\([\s\S]*?\n\}/.exec(commandParser)?.[0] ?? "";
const subcommands = [...parserBody.matchAll(/sub === "([a-z]+)"/g)].map((m) => m[1] as string);
ok(subcommands.length >= 5, `scan sanity: parseOeCommandTokens branches on at least 5 subcommands (found ${subcommands.join(", ")})`);
const hintNames = (hint: string, sub: string): boolean => new RegExp(String.raw`\b${sub}\b`).test(hint);
ok(hintNames("stop | status", "budget") === false, "negative control: a hint without `budget` fails the check");
const usageHint = parsed.features.slash_commands[0]?.usage_hint ?? "";
for (const sub of subcommands) {
  ok(hintNames(usageHint, sub), `the /oe usage hint names \`${sub}\` — the parser accepts it (hint: "${usageHint}")`);
}

const runbookText = readFileSync(join(REPO_ROOT, "docs/deploy/surfaces/slack.md"), "utf8");
ok(runbookText.includes(`**Usage Hint**: \`${usageHint}\``), "the runbook's /oe Usage Hint is the manifest's, verbatim");
ok(
  runbookText.includes(`**Short Description**: \`${parsed.features.slash_commands[0]?.description ?? "<none>"}\``),
  "the runbook's /oe Short Description is the manifest's, verbatim",
);

ok(surfaceAppManifest("slack") === undefined, "before registerSlackOps() no slack manifest is registered — the registry fails closed");
registerSlackOps();
ok(surfaceAppManifestSurfaces().includes("slack"), "registerSlackOps() registers the slack app manifest");

const host = normalizeDeployHost("https://oe.example.com/");
ok(host === "oe.example.com", "a deploy origin normalises to a host");

const served = surfaceAppManifest("slack", host === undefined ? {} : { host });
ok(served !== undefined, "the registry serves the slack manifest");
ok(served?.format === "json", "…declaring the format Slack's console expects");
ok(served?.consoleUrl === "https://api.slack.com/apps", "…and the console page the operator opens");

const resolved = JSON.parse(String(served?.manifest)) as SlackManifestShape;
ok(served?.placeholdersRemaining === 0, "no placeholder survives the substitution");
ok(resolved.settings.event_subscriptions.request_url === "https://oe.example.com/eve/v1/slack", "the events request URL points at the deployment");
ok(
  resolved.settings.interactivity.request_url === "https://oe.example.com/eve/v1/slack",
  "the interactivity request URL points at the deployment — the shortcut and card-button path",
);
ok(
  resolved.features.slash_commands[0]?.url === "https://oe.example.com/eve/v1/slack/commands",
  "the /oe slash command points at the deployment's SEPARATE command endpoint",
);
ok(
  resolved.oauth_config.scopes.bot.join(",") === parsed.oauth_config.scopes.bot.join(","),
  "substitution leaves the scopes identical",
);
ok(resolved.features.shortcuts.length === parsed.features.shortcuts.length, "…and both shortcuts survive");

ok(surfaceAppNameProblem("slack", "Acme Agent") === undefined, "the slack registration accepts an app name");
ok(
  surfaceAppNameProblem("slack", "x".repeat(SLACK_APP_NAME_MAX + 1)) !== undefined,
  `…and refuses one over Slack's ${SLACK_APP_NAME_MAX}-character limit`,
);
const servedNamed = surfaceAppManifest("slack", { appName: "Acme Agent" });
ok(
  (JSON.parse(String(servedNamed?.manifest)) as SlackManifestShape).display_information.name === "Acme Agent",
  "the registry serves the slack manifest under the chosen name",
);

const bare = surfaceAppManifest("slack");
ok(bare?.placeholdersRemaining === 4, "with no host all four placeholders remain, and are counted");
ok(bare?.manifest === template, "…and the document is the template, byte for byte");
ok(bare?.host === undefined, "…and no host is claimed");

interface NamedManifestShape {
  display_information: { name: string };
  features: { bot_user: { display_name: string }; slash_commands: { command: string; description: string }[]; shortcuts: { name: string }[] };
}
overrideSettingsForTest({ identity: { name: "Aria", commandName: "aria" } });
try {
  const fromSettings = JSON.parse(String(surfaceAppManifest("slack")?.manifest)) as NamedManifestShape;
  ok(fromSettings.display_information.name === "Aria", "🔴 the served manifest names the app with the configured identity.name");
  ok(fromSettings.features.bot_user.display_name === "Aria", "🔴 …and the bot user");
  ok(fromSettings.features.slash_commands[0]?.command === "/aria", "🔴 the slash command is the configured identity.commandName");
  ok(fromSettings.features.slash_commands[0]?.description.startsWith("Aria ") === true, "…and its description names the agent");
  const shortcutNames = fromSettings.features.shortcuts.map((sc) => sc.name);
  ok(shortcutNames.includes("Send to Aria") && shortcutNames.includes("Ask Aria"), `…and both shortcuts name the agent (${shortcutNames.join(", ")})`);
  ok(!JSON.stringify(fromSettings).includes("Open Everywhere"), "🔴 a named deployment's manifest carries no brand at all");
  const explicit = JSON.parse(String(surfaceAppManifest("slack", { appName: "Acme Agent" })?.manifest)) as NamedManifestShape;
  ok(explicit.display_information.name === "Acme Agent", "an explicit appName still OVERRIDES the configured name");
  ok(explicit.features.slash_commands[0]?.command === "/aria", "…and leaves the configured command alone");

  overrideSettingsForTest({ identity: { name: "The Extremely Long Engineering Teammate Name" } });
  const long = JSON.parse(String(surfaceAppManifest("slack")?.manifest)) as NamedManifestShape;
  ok(long.display_information.name.length <= SLACK_APP_NAME_MAX, `a long configured name is cut to Slack's ${SLACK_APP_NAME_MAX}-character limit`);
  ok(long.features.shortcuts.every((sc) => sc.name.length <= SLACK_SHORTCUT_NAME_MAX), `…and every shortcut name stays within ${SLACK_SHORTCUT_NAME_MAX}`);
} finally {
  resetSettingsForTest();
}
const unnamed = JSON.parse(String(surfaceAppManifest("slack")?.manifest)) as NamedManifestShape;
ok(unnamed.display_information.name === SLACK_DEFAULT_APP_NAME && unnamed.features.slash_commands[0]?.command === "/oe", "NEGATIVE CONTROL: with no name configured the manifest carries the defaults");

const collect = (served?.collect ?? []).join(" ");
ok(collect.includes("SLACK_BOT_TOKEN"), "the hand-over names the bot token env key");
ok(collect.includes("SLACK_SIGNING_SECRET"), "…and the signing secret env key");
ok((served?.steps ?? []).length >= 4, "…and the ordered clicks the operator makes in Slack's console");

const setupSlackStep = readFileSync(join(REPO_ROOT, "packages/create/src/steps/slack.ts"), "utf8");
ok(
  setupSlackStep.includes("@open-everywhere/provider-slack/agent/app-manifest.js"),
  "the setup CLI imports the manifest from this bundle rather than holding a copy",
);
ok(setupSlackStep.includes("slackAppManifestTemplate("), "…and calls it to build its guide");
ok(!/oauth_config/.test(setupSlackStep), "…and no longer declares a manifest of its own");

const opsEntry = readFileSync(join(REPO_ROOT, "scripts/ops-mcp.ts"), "utf8");
ok(opsEntry.includes("registerSlackOps()"), "the shipped ops MCP entry (scripts/ops-mcp.ts) calls registerSlackOps() before serving");
ok(
  opsEntry.includes('"agent/settings/settings.ts"') && opsEntry.indexOf("registerSettings(") >= 0 && opsEntry.indexOf("registerSettings(") < opsEntry.indexOf("registerSlackOps()"),
  "the shipped ops MCP entry registers the app's settings before it registers the manifests",
);
const templateOpsEntry = readFileSync(join(REPO_ROOT, "packages/create/template/scripts/ops-mcp.ts"), "utf8");
ok(
  templateOpsEntry.includes('"agent/settings/settings.ts"') && templateOpsEntry.indexOf("registerSettings(") >= 0 && templateOpsEntry.indexOf("registerSettings(") < templateOpsEntry.indexOf("registerSlackOps()"),
  "…and so does the quickstart template's ops MCP entry",
);

console.log(`✓ slack-app-manifest: ${n} assertions passed (template shape, real registerSlackOps wiring, host substitution, one definition)`);
