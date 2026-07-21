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
    allows: ["api-key", "service-oauth", "user-oauth"],
    credentials: [
      { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY" },
      {
        id: "team-oauth",
        type: "service-oauth",
        vercelConnector: "notion.so/open-everywhere",
        dashboardUrl: "https://vercel.com/<your-team>/~/connect/scl_example4",
      },
      { id: "user-oauth", type: "user-oauth", vercelConnector: "mcp.notion.com/notion-mcp" },
    ],
  }),
];

assertProvidersValid(providers);

export function loadProviders(): readonly Provider[] {
  return providers;
}
