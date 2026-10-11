import assert from "node:assert/strict";
import { defineMcpServers, OE_OAUTH_CALLBACK_PATH } from "@open-everywhere/core/agent/adapter-api.js";
import { SLACK_PERSONAL_SIGN_IN_CALLBACK_PATH, slackAppManifestTemplate } from "../agent/app-manifest.js";
import { slackManifestOptionsFromSettings } from "../agent/ops.js";
import {
  SLACK_AS_YOU_NAME,
  SLACK_AS_YOU_SCOPES,
  SLACK_AS_YOU_SECRET_REF,
  SLACK_MCP_BOT_SCOPE,
  SLACK_MCP_URL,
  slackAsYou,
  slackAsYouUserScopes,
} from "../agent/slack-as-you.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
  console.log(`  ✓ ${label}`);
};

interface Manifest {
  readonly oauth_config: { readonly redirect_urls: readonly string[]; readonly scopes: { readonly bot: readonly string[]; readonly user?: readonly string[] } };
}

console.log("§1 the preset");
{
  const entry = slackAsYou({ clientId: "1111.2222" });
  ok(defineMcpServers([entry]).length === 1, "§1 the preset is a valid app declaration");
  ok(entry.name === SLACK_AS_YOU_NAME && entry.url === SLACK_MCP_URL && SLACK_MCP_URL === "https://mcp.slack.com/mcp", "§1 it dials Slack's own MCP endpoint");
  ok(entry.personalSurface?.platform === "slack", "§1 🔴 it is a personal surface on Slack: a Slack 1:1 DM only");
  ok(entry.description.startsWith("Search Slack as you"), "§1 it is labelled as the person's own ('search Slack as you')");
  const signIn = entry.signIn;
  ok(signIn?.mode === "static-confidential", "§1 it signs in through the app's static confidential client — Slack offers no dynamic registration");
  if (signIn?.mode === "static-confidential") {
    ok(signIn.authorizationEndpoint === "https://slack.com/oauth/v2_user/authorize", "§1 the person consents at Slack's user-only authorize endpoint");
    ok(signIn.tokenEndpoint === "https://slack.com/api/oauth.v2.user.access", "§1 …and the code is exchanged at oauth.v2.user.access");
    ok(signIn.clientId === "1111.2222", "§1 it reuses the org's own Slack app (its public Client ID)");
    ok(signIn.clientSecretRef === SLACK_AS_YOU_SECRET_REF && !("clientSecret" in signIn), "§1 🔴 the Client Secret is named by its credential-store REF, never by value");
    ok(
      signIn.scopes?.length === 1 && signIn.scopes[0] === slackAsYouUserScopes().join(","),
      "§1 the user scopes ride as ONE comma-separated element, because Slack reads `scope` comma-separated",
    );
  }
  const all = slackAsYouUserScopes();
  for (const group of ["search", "read", "write"] as const) {
    ok(SLACK_AS_YOU_SCOPES[group].every((s) => all.includes(s)), `§1 the default consent covers the ${group} tool group`);
  }
  ok(all.includes("chat:write") && all.includes("search:read.public") && all.includes("canvases:read"), "§1 …including the verified per-group scopes");
  ok(new Set(all).size === all.length, "§1 no scope is requested twice");
  const readOnly = slackAsYou({ clientId: "1111.2222", tools: ["search", "read"] });
  const readOnlyScopes = readOnly.signIn?.mode === "static-confidential" ? (readOnly.signIn.scopes ?? []).join() : "";
  ok(!readOnlyScopes.includes("chat:write") && !readOnly.description.includes("post"), "§1 a read-only entry asks for no write scope and promises no post");
  ok(slackAsYou({ clientId: "x", people: { groups: ["sales"] } }).people?.groups.join() === "sales", "§1 `people` narrows it as in any declared server");
  ok(new URL(entry.url).hostname === "mcp.slack.com", "§1 🔴 the person's token goes to mcp.slack.com alone — never to the bot's Web API host");
}

console.log("§2 the manifest");
{
  const plain = JSON.parse(slackAppManifestTemplate()) as Manifest;
  ok(!plain.oauth_config.scopes.bot.includes(SLACK_MCP_BOT_SCOPE), "§2 with no Slack-as-you entry, the manifest asks for no mcp:connect");
  ok(plain.oauth_config.scopes.user === undefined, "§2 …and for no user scope at all");
  ok(plain.oauth_config.redirect_urls.every((u) => !u.endsWith(SLACK_PERSONAL_SIGN_IN_CALLBACK_PATH)), "§2 …and declares no personal sign-in redirect");
  const personal = JSON.parse(slackAppManifestTemplate({ personalMcp: true })) as Manifest;
  ok(personal.oauth_config.scopes.bot.includes(SLACK_MCP_BOT_SCOPE), "§2 with the entry, the manifest carries the mcp:connect bot scope");
  ok(JSON.stringify(personal.oauth_config.scopes.user) === JSON.stringify(slackAsYouUserScopes()), "§2 …every user scope the preset requests, and no other");
  ok(
    personal.oauth_config.redirect_urls.includes(`https://YOUR-DEPLOY-URL${OE_OAUTH_CALLBACK_PATH}`),
    "§2 …and the redirect to core's OAuth callback, where the person's sign-in returns",
  );
  ok(SLACK_PERSONAL_SIGN_IN_CALLBACK_PATH === OE_OAUTH_CALLBACK_PATH, "§2 🔴 the leaf's callback path is core's — the two spellings cannot drift");
  ok(
    personal.oauth_config.scopes.bot.filter((s) => s !== SLACK_MCP_BOT_SCOPE).join() === plain.oauth_config.scopes.bot.join(),
    "§2 the bot scopes are otherwise unchanged",
  );
}

console.log("§3 the ops plane");
{
  defineMcpServers([]);
  ok(slackManifestOptionsFromSettings().personalMcp === undefined, "§3 an app that declares no Slack-as-you entry gets the plain manifest");
  defineMcpServers([slackAsYou({ clientId: "1111.2222" })]);
  ok(slackManifestOptionsFromSettings().personalMcp === true, "§3 🔴 an app that declares the entry gets the personal scopes and redirect");
  defineMcpServers([]);
}

console.log(`\n✓ slack-as-you: ${n} assertions passed`);
