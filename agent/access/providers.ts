import {
  assertProvidersValid,
  defineProvider,
  type Provider,
} from "@open-everywhere/core/agent/access/providers.js";

const providers: Provider[] = [
  defineProvider({
    name: "notion",
    description: "Notion workspace — MCP (curated tools) + REST (full long-tail), one credential.",
    transports: [
      { kind: "mcp", connection: "notion", allows: ["service-oauth", "user-oauth"] },
      { kind: "rest", connection: "notion-rest", allows: ["api-key", "service-oauth"] },
    ],
    credentials: [
      { id: "team-key", type: "api-key", secretRef: "NOTION_API_KEY" },
      { id: "team-oauth", type: "service-oauth", vercelConnector: "oauth/notion-app" },
    ],
    defaultTransport: "rest",
  }),
];

assertProvidersValid(providers);

export function loadProviders(): readonly Provider[] {
  return providers;
}
