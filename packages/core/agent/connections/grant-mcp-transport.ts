import { registerGrantBorrowTransport, type GrantBorrowCall, type GrantBorrowTransport } from "../access/credential-grant-broker.js";
import type { GrantOwnerSubject } from "../access/credential-grant-owner.js";
import { CREDENTIAL_GRANT_ROLES } from "../access/credential-grant.js";
import type { CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { mintBorrowToken, resolveBorrowConnection, withBorrowClient, type GrantBorrowDeps } from "./grant-mcp-borrow.js";

export type GrantMcpTransportDeps = GrantBorrowDeps;

export function grantMcpTransport(deps: GrantMcpTransportDeps = {}): GrantBorrowTransport {
  return async (call: GrantBorrowCall, grant: CredentialGrantRow, owner: GrantOwnerSubject): Promise<unknown> => {
    const conn = resolveBorrowConnection(grant.connector, deps);

    const lentTool = grant.mcpTool;
    if (lentTool === undefined) {
      throw new Error("granted call: this grant row names no vendor tool, so there is nothing to borrow (connections/grant-mcp-transport.ts).");
    }
    if (lentTool !== call.mcpTool) {
      throw new Error("granted call: the call names a different vendor tool than the grant row lends — refusing rather than dialling either (connections/grant-mcp-transport.ts).");
    }

    const token = await mintBorrowToken(conn, owner.vaultSubject, deps);
    return await withBorrowClient(conn, { frozenArgs: grant.frozenArgs, mcpTool: lentTool }, token, deps, async (client) =>
      await client.callTool({ arguments: { ...call.input }, name: lentTool }),
    );
  };
}

export function installGrantBorrowTransports(deps: GrantMcpTransportDeps = {}): void {
  const transport = grantMcpTransport(deps);
  for (const role of CREDENTIAL_GRANT_ROLES) registerGrantBorrowTransport(role.connector, transport);
}
