import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildOpsServer } from "@open-everywhere/core/agent/ops/server.js";
import { registerSlackOps } from "@open-everywhere/provider-slack/agent/ops.js";
import { registerTeamsOps } from "@open-everywhere/provider-teams/agent/ops.js";
import { registerDiscordOps } from "@open-everywhere/provider-discord/agent/ops.js";
import { registerGithubOps } from "@open-everywhere/provider-github/agent/ops.js";
import { registerSurfaceTrustPreflight } from "@open-everywhere/core/agent/identity/trust-preflight.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";
import { registerSettings, type AgentSettingsOverrides } from "@open-everywhere/core/agent/settings/settings.js";

const APP_ROOT = resolveAppRoot();
await importAppModule("agent/identity/surfaces.ts", APP_ROOT);
try {
  const { SETTINGS_OVERRIDES } = await importAppModule<{ SETTINGS_OVERRIDES: AgentSettingsOverrides }>("agent/settings/settings.ts", APP_ROOT);
  registerSettings(SETTINGS_OVERRIDES);
} catch (err) {
  process.stderr.write(
    `open-everywhere-ops: agent/settings/settings.ts did not load (${err instanceof Error ? err.message : String(err)}) — ` +
      "surface_manifest renders the shipped default names until it does\n",
  );
}
try {
  await importAppModule("agent/access/mcp-servers.ts", APP_ROOT);
} catch (err) {
  process.stderr.write(
    `open-everywhere-ops: agent/access/mcp-servers.ts did not load (${err instanceof Error ? err.message : String(err)}) — ` +
      "surface_manifest renders the Slack manifest without the personal-sign-in scopes until it does\n",
  );
}

registerSlackOps();
registerTeamsOps();
registerDiscordOps();
registerGithubOps();
registerSurfaceTrustPreflight();

const server = buildOpsServer();
await server.connect(new StdioServerTransport());
process.stderr.write(
  "open-everywhere-ops MCP server ready on stdio (preflight · surface_manifest · surface_app_package · surface_app_create · scaffold_env · scaffold_credential_key · secret_set/list/rm)\n",
);
