import {
  assertProvidersValid,
  defineProvider,
  type Provider,
} from "@open-everywhere/core/agent/access/providers.js";

const providers: Provider[] = [
  defineProvider({
    name: "notion",
    description: "Notion workspace (host-side MCP) — read/write the team knowledge base.",
    connection: "notion",
    allows: ["api-key", "user-oauth"],
    credentials: [
      { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY", broker: "env" },
      { id: "user-oauth", type: "user-oauth", vercelConnector: "mcp.notion.com/notion-mcp" },
    ],
  }),

  defineProvider({
    name: "e2e-intake",
    description: "E2E-only: isolated credentials the connector intake / org-click legs forge against (inert — never granted).",
    connection: "notion",
    allows: ["api-key", "service-oauth"],
    credentials: [
      { id: "e2e-key", type: "api-key", secretRef: "OE_E2E_INTAKE_KEY", broker: "db" },
      { id: "e2e-oauth", type: "service-oauth", vercelConnector: "example.com/e2e-intake" },
    ],
  }),
];

assertProvidersValid(providers);

export function loadProviders(): readonly Provider[] {
  return providers;
}
