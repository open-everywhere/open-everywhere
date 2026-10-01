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
import { SLACK_APP_NAME_MAX, SLACK_DEFAULT_APP_NAME, SLACK_DEPLOY_HOST_PLACEHOLDER, slackAppManifestTemplate } from "../agent/app-manifest.js";

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
    slash_commands: { url: string }[];
    shortcuts: unknown[];
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: { event_subscriptions: { request_url: string }; interactivity: { is_enabled: boolean; request_url: string } };
}
const parsed = JSON.parse(template) as SlackManifestShape;
ok(parsed.oauth_config.scopes.bot.length >= 10, `the template declares its bot scopes (${parsed.oauth_config.scopes.bot.length})`);
ok(parsed.features.slash_commands[0]?.url.includes(DEPLOY_HOST_PLACEHOLDER), "the slash-command URL carries the placeholder");
ok(parsed.settings.event_subscriptions.request_url.includes(DEPLOY_HOST_PLACEHOLDER), "the events request URL carries the placeholder");
ok(parsed.settings.interactivity.is_enabled === true, "interactivity is enabled — the shortcuts and every card button need it");
ok(parsed.settings.interactivity.request_url.includes(DEPLOY_HOST_PLACEHOLDER), "the interactivity request URL carries the placeholder");
const templatePlaceholders = template.split(DEPLOY_HOST_PLACEHOLDER).length - 1;
ok(templatePlaceholders === 3, `the template carries three placeholders — one per request URL (found ${templatePlaceholders})`);

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
ok(bare?.placeholdersRemaining === 3, "with no host all three placeholders remain, and are counted");
ok(bare?.manifest === template, "…and the document is the template, byte for byte");
ok(bare?.host === undefined, "…and no host is claimed");

const collect = (served?.collect ?? []).join(" ");
ok(collect.includes("SLACK_BOT_TOKEN"), "the hand-over names the bot token env key");
ok(collect.includes("SLACK_SIGNING_SECRET"), "…and the signing secret env key");
ok((served?.steps ?? []).length >= 4, "…and the ordered clicks the operator makes in Slack's console");

const wizard = readFileSync(join(REPO_ROOT, "packages/create/src/steps/slack.ts"), "utf8");
ok(
  wizard.includes("@open-everywhere/provider-slack/agent/app-manifest.js"),
  "the install wizard imports the manifest from this bundle rather than holding a copy",
);
ok(wizard.includes("slackAppManifestTemplate("), "…and calls it to build its guide");
ok(!/oauth_config/.test(wizard), "…and no longer declares a manifest of its own");

const opsEntry = readFileSync(join(REPO_ROOT, "scripts/ops-mcp.ts"), "utf8");
ok(opsEntry.includes("registerSlackOps()"), "the shipped ops MCP entry (scripts/ops-mcp.ts) calls registerSlackOps() before serving");

console.log(`✓ slack-app-manifest: ${n} assertions passed (template shape, real registerSlackOps wiring, host substitution, one definition)`);
