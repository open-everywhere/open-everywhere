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
    description: "Notion workspace (host-side MCP) — read and write the team knowledge base.",
    connector: "notion",
    allows: ["api-key", "service-oauth", "user-oauth"],
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
      { id: "user-oauth", type: "user-oauth", home: vercelConnectorHome("mcp.notion.com/notion-mcp"), endpoints: { hosts: ["mcp.notion.com"] } },
      { id: "workspace-oauth", type: "service-oauth", home: vercelConnectorHome("mcp.notion.com/notion-mcp"), endpoints: { hosts: ["mcp.notion.com"] } },
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
