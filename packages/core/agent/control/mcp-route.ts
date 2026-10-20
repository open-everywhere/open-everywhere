import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildControlServer } from "./server.js";
import { authorizeControlMcp, CONTROL_MCP_PATH } from "./oauth-resource.js";
import { storedSigningSecret, type SigningSecretSource } from "./oauth-tokens.js";
import { CONTROL_OAUTH_ISSUER } from "./oauth-clients.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export { CONTROL_MCP_PATH };

export async function handleControlMcpRequest(
  req: Request,
  signingSecret: SigningSecretSource = storedSigningSecret,
  declaredIssuer: string = CONTROL_OAUTH_ISSUER,
): Promise<Response> {
  const principal = await authorizeControlMcp(req, signingSecret, declaredIssuer);
  if (principal instanceof Response) return principal;

  const rpc = await readRpcSummary(req);
  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: principal.subject,
    action: "control.service_call",
    detail: {
      service: principal.subject,
      client: principal.clientId,
      scope: principal.scopes.join(" "),
      readOnly: principal.readOnly,
      ...(rpc.method ? { method: rpc.method } : {}),
      ...(rpc.tool ? { tool: rpc.tool } : {}),
    },
  });

  const server = buildControlServer({
    includeWrites: true,
    actor: principal.subject,
    roles: principal.roles,
    readOnly: principal.readOnly,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function readRpcSummary(req: Request): Promise<{ method?: string; tool?: string }> {
  if (req.method !== "POST") return {};
  try {
    const body = (await req.clone().json()) as { method?: unknown; params?: { name?: unknown } };
    return {
      ...(typeof body.method === "string" ? { method: body.method } : {}),
      ...(typeof body.params?.name === "string" ? { tool: body.params.name } : {}),
    };
  } catch {
    return {};
  }
}
