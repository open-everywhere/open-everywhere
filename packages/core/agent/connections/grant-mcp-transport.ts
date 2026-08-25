import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { findConnectorCredential, vercelConnectorOf } from "../access/connector-credentials.js";
import { assertCredentialEndpointHostAllowed } from "../access/credential-endpoints.js";
import { registerGrantBorrowTransport, type GrantBorrowCall, type GrantBorrowTransport } from "../access/credential-grant-broker.js";
import type { GrantOwnerSubject } from "../access/credential-grant-owner.js";
import { CREDENTIAL_GRANT_ROLES } from "../access/credential-grant.js";
import { fenceMcpBorrowFetch } from "../access/mcp-call-fence.js";
import type { CredentialGrantRow, GrantJsonObject } from "../operational/credential-grant-rows.js";
import { connectorTransportSpec, type ConnectorTransportSpec } from "./connector-transport.js";
import { requireUserAuthFlow } from "./user-auth-flow.js";

const BORROW_CLIENT_INFO = { name: "open-everywhere-grant-borrow", version: "1.0.0" } as const;

export interface GrantMcpTransportDeps {
  readonly connectorSpec?: (connector: string) => ConnectorTransportSpec | undefined;
  readonly mintOwnerToken?: (provider: string, providerRef: string, vaultSubject: string) => Promise<string>;
  readonly fetch?: FetchLike;
}

function grantRoleCredential(connector: string): string | undefined {
  return CREDENTIAL_GRANT_ROLES.find((r) => r.connector === connector)?.role;
}

export function grantBorrowFetch(row: { readonly mcpTool?: string; readonly frozenArgs?: GrantJsonObject }, directUrl: string, base: FetchLike): FetchLike {
  const url = new URL(directUrl);
  return fenceMcpBorrowFetch({ frozenArgs: row.frozenArgs ?? {}, host: url.host, tool: row.mcpTool ?? "" }, base);
}

export function mergeBorrowArguments(input: Readonly<Record<string, unknown>>, frozenArgs: GrantJsonObject | undefined): Record<string, unknown> {
  return { ...input, ...(frozenArgs ?? {}) };
}

export function grantMcpTransport(deps: GrantMcpTransportDeps = {}): GrantBorrowTransport {
  return async (call: GrantBorrowCall, grant: CredentialGrantRow, owner: GrantOwnerSubject): Promise<unknown> => {
    const spec = (deps.connectorSpec ?? connectorTransportSpec)(grant.connector);
    if (spec === undefined) {
      throw new Error(
        `granted call: this deployment carries no "${grant.connector}" connection, so there is no MCP server to borrow the ` +
          "tool from (connections/grant-mcp-transport.ts).",
      );
    }
    let url: URL;
    try {
      url = new URL(spec.directUrl);
    } catch {
      throw new Error(`granted call: the "${grant.connector}" connection's URL does not parse, so the borrow cannot be dialled (connections/grant-mcp-transport.ts).`);
    }
    const provider = spec.provider ?? grant.connector;
    const credentialId = grantRoleCredential(grant.connector);
    if (credentialId === undefined) {
      throw new Error(
        `granted call: "${grant.connector}" is not in CREDENTIAL_GRANT_ROLES, so no personal credential is admitted for it ` +
          "(access/credential-grant.ts).",
      );
    }
    const cred = findConnectorCredential(provider, credentialId);
    if (cred === undefined) {
      throw new Error(
        `granted call: this deployment configures no "${credentialId}" ${provider} credential, so there is no per-user ` +
          "credential to spend. Declare one in agent/access/connector-credentials.ts (connections/grant-mcp-transport.ts).",
      );
    }
    const providerRef = vercelConnectorOf(cred);
    if (providerRef === undefined) {
      throw new Error(
        `granted call: the "${credentialId}" ${provider} credential declares no OAuth home, so no per-user token can be ` +
          "minted from it (connections/grant-mcp-transport.ts).",
      );
    }
    assertCredentialEndpointHostAllowed(cred.endpoints, spec.directUrl, `granted ${provider} credential "${credentialId}"`);

    const mint =
      deps.mintOwnerToken ??
      (async (label: string, ref: string, subject: string): Promise<string> =>
        (await requireUserAuthFlow(label).mintUserToken(ref, { subject: { id: subject, type: "user" } })).token);
    const token = await mint(provider, providerRef, owner.vaultSubject);

    const lentTool = grant.mcpTool;
    if (lentTool === undefined) {
      throw new Error("granted call: this grant row names no vendor tool, so there is nothing to borrow (connections/grant-mcp-transport.ts).");
    }
    if (lentTool !== call.mcpTool) {
      throw new Error("granted call: the call names a different vendor tool than the grant row lends — refusing rather than dialling either (connections/grant-mcp-transport.ts).");
    }

    const base = deps.fetch ?? (globalThis.fetch as FetchLike);
    const fenced = grantBorrowFetch(grant, spec.directUrl, base);
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: fenced,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client(BORROW_CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport);
      return await client.callTool({ arguments: mergeBorrowArguments(call.input, grant.frozenArgs), name: lentTool });
    } finally {
      try {
        await transport.terminateSession();
      } catch {
      }
      try {
        await client.close();
      } catch {
      }
    }
  };
}

export function installGrantBorrowTransports(deps: GrantMcpTransportDeps = {}): void {
  const transport = grantMcpTransport(deps);
  for (const role of CREDENTIAL_GRANT_ROLES) registerGrantBorrowTransport(role.connector, transport);
}
