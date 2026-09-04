import type { GrantBorrowCall, GrantBorrowTransport } from "../access/credential-grant-broker.js";
import {
  foreignGrantBorrowRegistrant,
  GrantBorrowTransportAlreadyRegisteredError,
  registerCoreGrantBorrowTransport,
} from "../access/grant-borrow-transport-registry.internal.js";
import type { GrantOwnerSubject } from "../access/credential-grant-owner.js";
import { CREDENTIAL_GRANT_ROLES } from "../access/credential-grant.js";
import { asGrantUndispatched, GrantUndispatchedError, type CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { mintBorrowToken, resolveBorrowConnection, withBorrowClient, type BorrowConnection, type GrantBorrowDeps } from "./grant-mcp-borrow.js";

export type GrantMcpTransportDeps = GrantBorrowDeps;

export function grantMcpTransport(deps: GrantMcpTransportDeps = {}): GrantBorrowTransport {
  return async (call: GrantBorrowCall, grant: CredentialGrantRow, owner: GrantOwnerSubject): Promise<unknown> => {
    const lentTool = grant.mcpTool;
    if (lentTool === undefined) {
      throw new GrantUndispatchedError("granted call: this grant row names no vendor tool, so there is nothing to borrow (connections/grant-mcp-transport.ts).");
    }
    if (lentTool !== call.mcpTool) {
      throw new GrantUndispatchedError(
        "granted call: the call names a different vendor tool than the grant row lends — refusing rather than dialling either (connections/grant-mcp-transport.ts).",
      );
    }

    let conn: BorrowConnection;
    let token: string;
    try {
      conn = resolveBorrowConnection(grant.connector, deps);
      token = await mintBorrowToken(conn, owner.vaultSubject, deps);
    } catch (err) {
      throw asGrantUndispatched(err);
    }
    return await withBorrowClient(conn, { frozenArgs: grant.frozenArgs, mcpTool: lentTool }, token, deps, async (client) =>
      await client.callTool({ arguments: { ...call.input }, name: lentTool }),
    );
  };
}

export function installGrantBorrowTransports(deps: GrantMcpTransportDeps = {}): void {
  for (const role of CREDENTIAL_GRANT_ROLES) {
    const foreign = foreignGrantBorrowRegistrant(role.connector);
    if (foreign !== undefined) throw new GrantBorrowTransportAlreadyRegisteredError(role.connector, foreign);
  }
  const transport = grantMcpTransport(deps);
  for (const role of CREDENTIAL_GRANT_ROLES) registerCoreGrantBorrowTransport(role.connector, transport);
}
