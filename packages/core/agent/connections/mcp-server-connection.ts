import type { SessionContext } from "eve/context";
import { connectorApprovalPolicy } from "./connector-auth.js";
import { defineConnectorMount, type ConnectorMountSpec } from "./connector-mount.js";
import { declareConnectionSignIn, type ConnectionSignIn } from "./connection-sign-in.js";
import { selectConnectorTransport } from "./connector-transport.js";
import { mcpServerConnectionSignIn, mcpServerHomeRef, type McpServerDeclaration } from "./mcp-servers.js";
import { declarePersonalSurfaceConnection, personalSurfaceRefusal } from "./personal-surface-fence.js";

export interface McpConnectionSpec {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly signIn?: { readonly homeRef: string; readonly declaration: ConnectionSignIn };
  readonly fallback?: { readonly secretRef: string; readonly broker: string };
  readonly dmOnlyOn?: string;
}

/**
 * One MCP connection, mounted as an OE connector mount (`connector-mount.ts`): a `defineDynamic`
 * tool file whose ops are OE's deferred connector tools, with the connector-result fence in their
 * `toModelOutput`. It is NOT an eve `defineMcpClientConnection`: eve's MCP connection runtime has
 * no per-result transform, so its results reach the model unfenced. The generated tool slot
 * passes the mount through `seatCut`.
 *
 * `description` is the connection's own description. A connector mount offers each op with the
 * server's own op description, and shows this text on the `<connection>__sign_in` tool only.
 */
export function mcpConnectionMountSpec(spec: McpConnectionSpec): ConnectorMountSpec {
  if (spec.signIn !== undefined) declareConnectionSignIn(spec.signIn.homeRef, spec.signIn.declaration);
  const transport = selectConnectorTransport({
    connector: spec.name,
    provider: spec.name,
    directUrl: spec.url,
    ...(spec.fallback !== undefined ? { fallbackSecretRef: spec.fallback.secretRef, fallbackBroker: spec.fallback.broker } : {}),
  });
  const dmOnlyOn = spec.dmOnlyOn;
  if (dmOnlyOn !== undefined) declarePersonalSurfaceConnection(spec.name, dmOnlyOn);
  const connector = spec.name;
  return {
    connection: connector,
    url: transport.url,
    description: spec.description,
    auth:
      dmOnlyOn === undefined
        ? transport.auth
        : async (ctx) => {
            const refusal = await personalSurfaceRefusal(connector, dmOnlyOn, ctx.session.auth);
            if (refusal !== undefined) throw new Error(refusal);
            return transport.auth(ctx);
          },
    ...(dmOnlyOn === undefined
      ? {}
      : { listingRefusal: async (ctx: SessionContext) => await personalSurfaceRefusal(connector, dmOnlyOn, ctx.session.auth, { audit: async () => undefined }) }),
    approval: connectorApprovalPolicy(),
  };
}

export function declaredMcpServerConnection(
  servers: readonly McpServerDeclaration[],
  name: string,
): ReturnType<typeof defineConnectorMount> {
  return defineConnectorMount(declaredMcpServerMountSpec(servers, name));
}

export function declaredMcpServerMountSpec(servers: readonly McpServerDeclaration[], name: string): ConnectorMountSpec {
  const server = servers.find((s) => s.name === name);
  if (server === undefined) {
    throw new Error(
      `agent/tools/${name}.ts mounts the MCP server "${name}", but agent/access/mcp-servers.ts declares no such ` +
        "server. The generated tree is stale: run `npx oe build`.",
    );
  }
  return mcpConnectionMountSpec({
    name: server.name,
    url: server.url,
    description: server.description,
    signIn: { homeRef: mcpServerHomeRef(server.name), declaration: mcpServerConnectionSignIn(server) },
    ...(server.personalSurface !== undefined ? { dmOnlyOn: server.personalSurface.platform } : {}),
  });
}
