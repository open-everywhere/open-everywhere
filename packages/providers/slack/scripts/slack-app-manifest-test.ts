import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY_HOST_PLACEHOLDER, normalizeDeployHost, surfaceAppManifest, surfaceAppManifestSurfaces } from "@open-everywhere/core/agent/adapter-api.js";
import { registerSlackOps } from "../agent/ops.js";
import { SLACK_DEPLOY_HOST_PLACEHOLDER, slackAppManifestTemplate } from "../agent/app-manifest.js";

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
  features: { slash_commands: { url: string }[]; shortcuts: unknown[] };
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
ok(wizard.includes("slackAppManifestTemplate()"), "…and calls it to build its guide");
ok(!/oauth_config/.test(wizard), "…and no longer declares a manifest of its own");

const opsEntry = readFileSync(join(REPO_ROOT, "scripts/ops-mcp.ts"), "utf8");
ok(opsEntry.includes("registerSlackOps()"), "the shipped ops MCP entry (scripts/ops-mcp.ts) calls registerSlackOps() before serving");

console.log(`✓ slack-app-manifest: ${n} assertions passed (template shape, real registerSlackOps wiring, host substitution, one definition)`);
