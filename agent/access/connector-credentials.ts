import {
  assertConnectorCredentialsValid,
  defineConnectorCredentials,
  vercelConnectorHome,
  type ConnectorCredentials,
} from "@open-everywhere/core/agent/access/connector-credentials.js";
import { applyOverridesToConnectorCredentials } from "@open-everywhere/core/agent/access/credential-bindings-codemod.js";
import { loadCredentialBindingsOverlay } from "./credential-bindings.js";

const catalogues: ConnectorCredentials[] = [
  defineConnectorCredentials({
    description: "Notion workspace (host-side MCP) — read/write the team knowledge base.",
    connector: "notion",
    allows: ["api-key", "user-oauth"],
    credentials: [
      { id: "team-key", type: "api-key", secretRef: "db:notion:team-key", broker: "db", endpoints: { hosts: ["api.notion.com"], pathPrefixes: ["/v1/"], methods: ["GET", "POST"] } },
      {
        id: "channel-key",
        type: "api-key",
        secretRef: "db:notion:channel-key",
        broker: "db",
        intake: false,
        endpoints: { hosts: ["api.notion.com"], pathPrefixes: ["/v1/"], methods: ["GET", "POST"] },
      },
      {
        id: "memory",
        type: "api-key",
        secretRef: "db:notion:memory",
        broker: "db",
        intake: false,
        endpoints: { hosts: ["api.notion.com"], pathPrefixes: ["/v1/blocks/"], methods: ["GET"] },
      },
      { id: "user-oauth", type: "user-oauth", home: vercelConnectorHome("mcp.notion.com/notion-mcp") },
    ],
  }),

  defineConnectorCredentials({
    description: "Linear workspace — the WORK surface a granted domain files and mutates issues through.",
    connector: "linear",
    allows: ["api-key"],
    credentials: [
      { id: "workspace", type: "api-key", secretRef: "LINEAR_ACCESS_TOKEN", broker: "env", intake: false },
      { id: "1a000000-0000-4000-8000-000000000001", type: "api-key", secretRef: "LINEAR_ACCESS_TOKEN", broker: "env", intake: false },
      {
        id: "1a000000-0000-4000-8000-000000000002",
        type: "api-key",
        secretRef: "LINEAR_APP_SOAK_CLIENT_SECRET",
        broker: "env",
        intake: false,
      },
    ],
  }),

  defineConnectorCredentials({
    description: "Slack workspace — the WORK surface a granted domain's delegated workers read conversations on.",
    connector: "slack",
    allows: ["api-key"],
    credentials: [
      { id: "work-token", type: "api-key", secretRef: "SLACK_BOT_TOKEN", broker: "env", intake: false },
      { id: "chat-token", type: "api-key", secretRef: "SLACK_BOT_TOKEN", broker: "env", intake: false },
    ],
  }),
  defineConnectorCredentials({
    description: "Discord guild — the WORK surface a granted domain's delegated workers read conversations on.",
    connector: "discord",
    allows: ["api-key"],
    credentials: [
      { id: "work-token", type: "api-key", secretRef: "DISCORD_BOT_TOKEN", broker: "env", intake: false },
      { id: "chat-token", type: "api-key", secretRef: "DISCORD_BOT_TOKEN", broker: "env", intake: false },
    ],
  }),
  defineConnectorCredentials({
    description: "Microsoft Teams — the WORK surface a granted domain's delegated workers read conversations on.",
    connector: "teams",
    allows: ["api-key"],
    credentials: [
      { id: "work-token", type: "api-key", secretRef: "TEAMS_APP_PASSWORD", broker: "env", intake: false },
      { id: "chat-token", type: "api-key", secretRef: "TEAMS_APP_PASSWORD", broker: "env", intake: false },
    ],
  }),

  defineConnectorCredentials({
    description: "E2E-only: isolated credentials the connector intake / org-click legs forge against (inert — never granted).",
    connector: "e2e-intake",
    allows: ["api-key", "service-oauth"],
    credentials: [
      { id: "e2e-key", type: "api-key", secretRef: "OE_E2E_INTAKE_KEY", broker: "env" },
      { id: "e2e-oauth", type: "service-oauth", home: vercelConnectorHome("example.com/e2e-intake") },
    ],
  }),
];

assertConnectorCredentialsValid(catalogues);

const merged: readonly ConnectorCredentials[] = applyOverridesToConnectorCredentials(
  catalogues,
  loadCredentialBindingsOverlay().overrides,
);
assertConnectorCredentialsValid(merged);

export function loadConnectorCredentials(): readonly ConnectorCredentials[] {
  return merged;
}

export function loadBaseConnectorCredentials(): readonly ConnectorCredentials[] {
  return catalogues;
}
