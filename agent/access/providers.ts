import {
  assertProvidersValid,
  defineProvider,
  type Provider,
} from "@open-everywhere/core/agent/access/providers.js";
import { applyOverridesToProviders } from "@open-everywhere/core/agent/access/credential-bindings-codemod.js";
import { loadCredentialBindingsOverlay } from "./credential-bindings.js";

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
      { id: "e2e-key", type: "api-key", secretRef: "OE_E2E_INTAKE_KEY", broker: "env" },
      { id: "e2e-oauth", type: "service-oauth", vercelConnector: "example.com/e2e-intake" },
    ],
  }),
];

assertProvidersValid(providers);

const merged: readonly Provider[] = applyOverridesToProviders(providers, loadCredentialBindingsOverlay().overrides);
assertProvidersValid(merged);

export function loadProviders(): readonly Provider[] {
  return merged;
}

export function loadBaseProviders(): readonly Provider[] {
  return providers;
}
