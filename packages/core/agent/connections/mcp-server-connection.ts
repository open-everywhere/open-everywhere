import { defineMcpClientConnection } from "eve/connections";
import { connectorApprovalPolicy } from "./connector-auth.js";
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

export function buildMcpConnection(spec: McpConnectionSpec): ReturnType<typeof defineMcpClientConnection> {
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
  return defineMcpClientConnection({
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
    approval: connectorApprovalPolicy(),
  });
}

export function declaredMcpServerConnection(
  servers: readonly McpServerDeclaration[],
  name: string,
): ReturnType<typeof defineMcpClientConnection> {
  const server = servers.find((s) => s.name === name);
  if (server === undefined) {
    throw new Error(
      `agent/connections/${name}.ts mounts the MCP server "${name}", but agent/access/mcp-servers.ts declares no such ` +
        "server. The generated tree is stale: run `npx oe build`.",
    );
  }
  return buildMcpConnection({
    name: server.name,
    url: server.url,
    description: server.description,
    signIn: { homeRef: mcpServerHomeRef(server.name), declaration: mcpServerConnectionSignIn(server) },
    ...(server.personalSurface !== undefined ? { dmOnlyOn: server.personalSurface.platform } : {}),
  });
}
