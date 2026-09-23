import { connectorGrantCredential, connectorGrantName, type Binding, type Bundle } from "../../agent/access/bundle.js";
import { vercelConnectorOf, type ConnectorCredentials } from "../../agent/access/connector-credentials.js";
import { domainForChannel, type Domain } from "../../agent/memory/domain.js";
import { loadDomains } from "../../../../agent/memory/config/domains.js";
import { loadBundles, loadBindings } from "../../../../agent/access/bundles.js";
import { loadConnectorCredentials } from "../../../../agent/access/connector-credentials.js";

export const NOTION_MCP_HOST = "mcp.notion.com";

export type RoutineConnectorFixture =
  | {
      readonly ok: true;
      readonly domain: string;
      readonly bundle: string;
      readonly credential: string;
      readonly oauthHome?: string;
    }
  | { readonly ok: false; readonly reason: string };

function bindingCovers(binding: Binding, input: { readonly surfaceKey: string; readonly domain: string | undefined }): boolean {
  const scope = binding.scope;
  if (scope.level === "org") return true;
  if (scope.level === "tenant") return scope.tenant !== undefined && input.surfaceKey.startsWith(`${scope.tenant}/`);
  if (scope.level === "domain") return scope.domain !== undefined && scope.domain === input.domain;
  if (scope.level === "surface") return scope.surface === input.surfaceKey;
  return false;
}

export function routineConnectorFixture(input: {
  readonly surfaceKey: string;
  readonly connector: string;
  readonly op: string;
  readonly mcpHost: string;
  readonly domains: readonly Domain[];
  readonly bundles: readonly Bundle[];
  readonly bindings: readonly Binding[];
  readonly credentials: readonly ConnectorCredentials[];
}): RoutineConnectorFixture {
  const domain = domainForChannel(input.surfaceKey, input.domains)?.name;
  const byName = new Map(input.bundles.map((b) => [b.name, b] as const));
  const catalogue = input.credentials.find((c) => c.connector === input.connector);

  const blocked: string[] = [];
  for (const binding of input.bindings) {
    if (!bindingCovers(binding, { surfaceKey: input.surfaceKey, domain })) continue;
    const bundle = byName.get(binding.bundle);
    const grant = bundle?.connectors?.find((g) => connectorGrantName(g) === input.connector);
    if (bundle === undefined || grant === undefined) continue;
    const credentialId = connectorGrantCredential(grant);
    if (credentialId === undefined) {
      blocked.push(`bundle "${bundle.name}" grants "${input.connector}" in the bare-slug form, which names no credential and resolves to nothing`);
      continue;
    }
    const credential = catalogue?.credentials.find((c) => c.id === credentialId);
    if (credential === undefined) {
      blocked.push(`bundle "${bundle.name}" grants "${input.connector}" as credential "${credentialId}", which the connector's catalogue does not configure`);
      continue;
    }
    const hosts = credential.endpoints?.hosts;
    if (hosts !== undefined && !hosts.includes(input.mcpHost)) {
      blocked.push(
        `bundle "${bundle.name}" grants "${input.connector}" as credential "${credentialId}", whose endpoint rules admit only ${hosts.join(", ")} — ` +
          `the connector's MCP host is ${input.mcpHost}, so connections/connector-auth.ts refuses before the host is dialed and no tool is ever injected`,
      );
      continue;
    }
    const oauthHome = credential.type === "service-oauth" ? vercelConnectorOf(credential) : undefined;
    return { ok: true, domain: domain ?? "(no explicit domain)", bundle: bundle.name, credential: credentialId, ...(oauthHome ? { oauthHome } : {}) };
  }

  const where = domain === undefined ? `surface ${input.surfaceKey} (in no explicit domain)` : `domain "${domain}" (surface ${input.surfaceKey})`;
  if (blocked.length === 0) {
    return {
      ok: false,
      reason:
        `RED-until-fixture: no bundle bound to ${where} grants the "${input.connector}" connector at all, so ${input.op} is never mounted and an ` +
        "unattended fire has no tool to call. Add a `connectors: [{ name: \"" +
        `${input.connector}\", credential: <id>, contentOrigin: … }]` +
        '` grant to a bundle in agent/access/bundles.ts and bind it to that domain. A `principal`-scoped binding does not count: personal bindings resolve only in the DM universe.',
    };
  }
  return {
    ok: false,
    reason: `RED-until-fixture: every "${input.connector}" grant reaching ${where} is blocked — ${blocked.join("; ")}. An OAuth-armed credential for this connector is what would arm it.`,
  };
}

export function deployedRoutineConnectorFixture(input: { readonly surfaceKey: string; readonly connector: string; readonly op: string; readonly mcpHost: string }): RoutineConnectorFixture {
  return routineConnectorFixture({
    ...input,
    domains: loadDomains(),
    bundles: loadBundles(),
    bindings: loadBindings(),
    credentials: loadConnectorCredentials(),
  });
}
